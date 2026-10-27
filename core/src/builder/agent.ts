// The edit loop: Muse Spark (Chat Completions with tools, OpenAI-compatible) changes an
// app's spec in small validated steps. Each change is checked by rendering every screen;
// a rejected one returns its errors, which is the repair loop. The model can look at the
// result (screenshots) before it finishes.
import type { AppSpec } from "../spec.ts";
import { applyPatch, type PatchOp } from "./patch.ts";
import { systemPrompt } from "./prompt.ts";
import { validateSpec } from "./validate.ts";

export interface ModelSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** What the user is looking at in the builder, so "this" and "here" resolve. */
export interface BuilderView {
  screen: string;
  screens: string[];
  selected?: { path: string; type: string; text?: string } | null;
}

export interface LogEntry {
  id: string;
  role: "user" | "model" | "step" | "error";
  text: string;
  /** A screenshot the model took, as a data URL. */
  image?: string;
}

export interface AgentDeps {
  settings: ModelSettings;
  http: (req: { url: string; method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; body: string }>;
  getSpec: () => AppSpec;
  /** Saves a validated spec (with undo history); the preview hot-reloads. */
  commit: (spec: AppSpec) => void;
  view: () => BuilderView;
  /** A PNG of a screen as it renders now, base64; absent where the host can't take one. */
  screenshot?: (screen?: string) => Promise<string | null>;
  log: (entry: Omit<LogEntry, "id">) => void;
}

export interface EditRequest {
  text?: string;
  /** A spoken request: base64 WAV. */
  audio?: string;
}

const MAX_STEPS = 8;

type Message =
  | { role: "system" | "user"; content: string | unknown[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function tools(withScreenshots: boolean) {
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  });
  return [
    fn("apply_patch", "Change the app with JSON Patch ops on the whole spec. Rejected with errors if the result doesn't render.", {
      patch: {
        type: "array",
        items: {
          type: "object",
          properties: { op: { type: "string", enum: ["add", "remove", "replace", "move", "copy"] }, path: { type: "string" }, value: {}, from: { type: "string" } },
          required: ["op", "path"],
        },
      },
    }, ["patch"]),
    fn("set_spec", "Replace the whole spec: for a new app or a rewrite.", { spec: { type: "object" } }, ["spec"]),
    ...(withScreenshots ? [fn("screenshot", "See a screen of the app as it renders now.", { screen: { type: "string", description: "Screen name; default: the one the user is looking at" } }, [])] : []),
    fn("finish", "End the turn with a short message to the user.", {
      message: { type: "string" },
    }, ["message"]),
  ];
}

function viewText(view: BuilderView): string {
  const lines = [`The user is looking at screen "${view.screen}" (screens: ${view.screens.join(", ")}).`];
  if (view.selected) {
    lines.push(`They selected the ${view.selected.type} at ${view.selected.path}${view.selected.text ? ` ("${view.selected.text}")` : ""}.`);
  }
  return lines.join(" ");
}

/** Runs one request to its end; progress and the outcome go to `log`. */
export async function runEdit(deps: AgentDeps, request: EditRequest): Promise<void> {
  const { settings } = deps;
  if (!settings.apiKey) {
    deps.log({ role: "error", text: "Add a Meta Model API key in Settings to change apps." });
    return;
  }
  let text = request.text;
  if (request.audio) {
    // Chat Completions takes no audio; the Responses API reads it as a file. Transcribe it
    // first, so the user sees what was heard, then edit as for a typed request.
    try {
      text = await transcribe(deps, request.audio);
    } catch (e) {
      deps.log({ role: "error", text: (e as Error).message });
      return;
    }
    if (!text) {
      deps.log({ role: "error", text: "Nothing was heard. Try again a little closer to the mic." });
      return;
    }
    deps.log({ role: "user", text: `“${text}”` });
  }
  const context = `Current spec:\n\`\`\`json\n${JSON.stringify(deps.getSpec())}\n\`\`\`\n${viewText(deps.view())}`;
  const content: unknown[] = [{ type: "text", text: `${context}\n\nRequest: ${text ?? ""}` }];
  const messages: Message[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content },
  ];
  const toolList = tools(!!deps.screenshot);

  for (let step = 0; step < MAX_STEPS; step++) {
    let reply: { content: string | null; tool_calls?: ToolCall[] };
    try {
      reply = await complete(deps, messages, toolList);
    } catch (e) {
      deps.log({ role: "error", text: (e as Error).message });
      return;
    }
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
    if (!reply.tool_calls?.length) {
      deps.log({ role: "model", text: reply.content?.trim() || "Done." });
      return;
    }
    const images: string[] = [];
    let finished = false;
    for (const call of reply.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "The arguments weren't valid JSON." });
        continue;
      }
      const result = await runTool(deps, call.function.name, args, images);
      if (result === FINISHED) {
        finished = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
      } else messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (finished) return;
    // Tool results are text; screenshots go back as an image in a user message.
    if (images.length) messages.push({ role: "user", content: images.map((url) => ({ type: "image_url", image_url: { url } })) });
  }
  deps.log({ role: "error", text: "Stopped after too many steps. The last good version is applied." });
}

const FINISHED = Symbol("finished");

/** Models often send an object argument as JSON text instead; take either. */
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function runTool(deps: AgentDeps, name: string, args: Record<string, unknown>, images: string[]): Promise<string | typeof FINISHED> {
  switch (name) {
    case "apply_patch":
    case "set_spec": {
      let next: AppSpec;
      try {
        next = name === "set_spec" ? (decoded(args.spec) as AppSpec) : applyPatch(deps.getSpec(), (decoded(args.patch) as PatchOp[]) ?? []);
      } catch (e) {
        deps.log({ role: "step", text: `Fixing a change that didn't apply` });
        return `Not applied: ${(e as Error).message}`;
      }
      const errors = validateSpec(next);
      if (errors.length) {
        deps.log({ role: "step", text: `Fixing ${errors.length === 1 ? "a problem" : `${errors.length} problems`}: ${errors[0]}` });
        return `Not applied, the spec has errors:\n${errors.slice(0, 12).join("\n")}`;
      }
      deps.commit(next);
      deps.log({ role: "step", text: name === "set_spec" ? "Wrote the app" : "Changed the app" });
      return "Applied. The user sees the change now.";
    }
    case "screenshot": {
      const png = await deps.screenshot?.(typeof args.screen === "string" ? args.screen : undefined).catch(() => null);
      if (!png) return "No screenshot available here.";
      const url = `data:image/png;base64,${png}`;
      images.push(url);
      deps.log({ role: "step", text: "Looked at the result", image: url });
      return "The screenshot follows as an image.";
    }
    case "finish": {
      deps.log({ role: "model", text: String(args.message ?? "Done.") });
      return FINISHED;
    }
    default:
      return `Unknown tool '${name}'.`;
  }
}

/** What was said in a WAV, word for word (empty when nothing was). */
async function transcribe(deps: AgentDeps, wav: string): Promise<string> {
  const { settings } = deps;
  const res = await deps.http({
    url: `${settings.baseUrl.replace(/\/$/, "")}/responses`,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      reasoning: { effort: "minimal" },
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "This recording is someone asking for a change to an app they are building: its screens, text, layout, colors or data. Write down exactly what they say, in their language, and nothing else. If nothing is said, answer with nothing." },
          { type: "input_file", filename: "request.wav", file_data: `data:audio/wav;base64,${wav}` },
        ],
      }],
    }),
  });
  let json: { output?: { type: string; content?: { text?: string }[] }[]; error?: { message?: string } };
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`The model service answered ${res.status}: ${res.body.slice(0, 200)}`);
  }
  if (res.status >= 400) throw new Error(`The model service answered ${res.status}: ${json.error?.message ?? res.body.slice(0, 200)}`);
  const message = json.output?.find((o) => o.type === "message");
  return (message?.content ?? []).map((c) => c.text ?? "").join("").trim();
}

async function complete(deps: AgentDeps, messages: Message[], toolList: unknown[]) {
  const { settings } = deps;
  const res = await deps.http({
    url: `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, messages, tools: toolList, tool_choice: "auto" }),
  });
  let json: { choices?: { message: { content: string | null; tool_calls?: ToolCall[] } }[]; error?: { message?: string } };
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`The model service answered ${res.status}: ${res.body.slice(0, 200)}`);
  }
  if (res.status >= 400 || !json.choices?.length) throw new Error(`The model service answered ${res.status}: ${json.error?.message ?? res.body.slice(0, 200)}`);
  return json.choices[0].message;
}
