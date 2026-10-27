// The edit loop: Muse Spark (the Responses API with function tools) changes an app's spec
// in validated steps. Each change is checked against the spec's schema and by rendering
// every screen; a rejected one returns its errors, which is the repair loop. The model can
// look at the result (screenshots) before it finishes. Responses are streamed, so the
// model's reasoning summaries and what it is writing show while it works.
//
// A whole spec is written as a ```json block in the model's message, not as a tool
// argument: inside an argument it is JSON escaped inside JSON, and at 10k characters the
// model loses a bracket or a quote. The conversation is kept here and sent whole each step
// (the API's stored responses expire within a minute or two).
import { acyclic, type Schema, specSchema } from "../schema.ts";
import type { AppSpec } from "../spec.ts";
import { applyPatch, type PatchOp } from "./patch.ts";
import { systemPrompt } from "./prompt.ts";
import { specProblems } from "./validate.ts";

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
  /** `thought`: a summary of the model's reasoning, shown while it thinks. */
  role: "user" | "model" | "thought" | "step" | "error";
  text: string;
  /** A screenshot the model took, as a data URL. */
  image?: string;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Deliver the body line by line to `onLine` as it arrives (server-sent events). */
  stream?: boolean;
}

export interface AgentDeps {
  settings: ModelSettings;
  /** With `onLine`, a streamed body's lines go there and `body` may be empty. */
  http: (req: HttpRequest, onLine?: (line: string) => void) => Promise<{ status: number; body: string }>;
  getSpec: () => AppSpec;
  /** Saves a validated spec (with undo history); the preview hot-reloads. */
  commit: (spec: AppSpec) => void;
  view: () => BuilderView;
  /** The collections published on this device, for the model's context. */
  collections?: () => string;
  /** A PNG of a screen as it renders now, base64; absent where the host can't take one. */
  screenshot?: (screen?: string) => Promise<string | null>;
  /** Adds an entry to the log and returns its id. */
  log: (entry: Omit<LogEntry, "id">) => string;
  /** Changes an entry while it is being written (a thought as it streams). */
  update?: (id: string, entry: Partial<Omit<LogEntry, "id">>) => void;
  /** What the model is doing right now, in a few words; "" when done. */
  status?: (text: string) => void;
}

export interface EditRequest {
  text?: string;
  /** A spoken request: base64 WAV. */
  audio?: string;
  /** The conversation to carry on: the previous run on this app ran out of steps. */
  continueFrom?: unknown[];
}

export interface EditOutcome {
  /** The conversation so far, to carry on with. */
  conversation: unknown[];
  /** False when the run stopped before the model finished (out of steps). */
  finished: boolean;
}

/** Model calls per request. Later steps are quick (a patch, a look), the first can take a minute. */
const MAX_STEPS = 16;

interface FunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseItem {
  type: string;
  summary?: { text: string }[];
  content?: { type: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ModelResponse {
  output: ResponseItem[];
  error?: { message?: string } | null;
}

/**
 * The spec's JSON Schema definitions, sent once with set_spec (each copy costs ~5k prompt
 * tokens); the API takes no recursive schemas. apply_patch's values point at them.
 */
const { $defs } = acyclic(specSchema());
const def = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

function tools(withScreenshots: boolean) {
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[], defs?: Record<string, Schema>) => ({
    type: "function",
    name,
    description,
    parameters: { type: "object", properties, required, ...(defs ? { $defs: defs } : {}) },
  });
  return [
    fn("apply_patch", "Change the app with JSON Patch ops on the whole spec. Rejected with errors if the result doesn't render.", {
      patch: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "remove", "replace", "move", "copy"] },
            path: { type: "string", description: "JSON Pointer into the spec, such as /screens/main/body/children/0" },
            value: {
              description: "The JSON value for add and replace. A node, style, action, data field or screen takes the shape set_spec's schema defines for it ($defs.node, $defs.style, $defs.actions, $defs.field, $defs.screen); otherwise a plain value, such as a title",
            },
            from: { type: "string" },
          },
          required: ["op", "path"],
          additionalProperties: false,
        },
      },
    }, ["patch"]),
    fn(
      "set_spec",
      "Replace the whole spec: for a new app or a rewrite. Write the complete spec in your message as one ```json block (shaped like $defs.app), then call set_spec with no arguments.",
      { spec: { ...def("app"), description: "Leave this out: the spec is the ```json block in your message" } },
      [],
      $defs,
    ),
    ...(withScreenshots ? [fn("screenshot", "See a screen of the app as it renders now.", { screen: { type: "string", description: "Screen name; default: the one the user is looking at" } }, [])] : []),
    fn("finish", "End the turn with a short message to the user.", {
      message: { type: "string" },
    }, ["message"]),
  ];
}

const WORKING: Record<string, string> = {
  set_spec: "Writing the app",
  apply_patch: "Changing the app",
  screenshot: "Looking at the screen",
  finish: "Finishing",
};

function viewText(view: BuilderView): string {
  const lines = [`The user is looking at screen "${view.screen}" (screens: ${view.screens.join(", ")}).`];
  if (view.selected) {
    lines.push(`They selected the ${view.selected.type} at ${view.selected.path}${view.selected.text ? ` ("${view.selected.text}")` : ""}.`);
  }
  return lines.join(" ");
}

/** Runs one request to its end; progress and the outcome go to `log`. */
export async function runEdit(deps: AgentDeps, request: EditRequest): Promise<EditOutcome> {
  const { settings } = deps;
  const status = (text: string) => deps.status?.(text);
  if (!settings.apiKey) {
    deps.log({ role: "error", text: "Add a Meta Model API key in Settings to change apps." });
    return { conversation: [], finished: true };
  }
  let text = request.text;
  if (request.audio) {
    // The recording is transcribed first, so the user sees what was heard, then edited as
    // a typed request.
    status("Listening to the recording");
    try {
      text = await transcribe(deps, request.audio);
    } catch (e) {
      deps.log({ role: "error", text: (e as Error).message });
      return { conversation: [], finished: true };
    } finally {
      status("");
    }
    if (!text) {
      deps.log({ role: "error", text: "Nothing was heard. Try again a little closer to the mic." });
      return { conversation: [], finished: true };
    }
    deps.log({ role: "user", text: `“${text}”` });
  }
  const shared = deps.collections?.() ?? "";
  const context = `Current spec:\n\`\`\`json\n${JSON.stringify(deps.getSpec())}\n\`\`\`\n${viewText(deps.view())}${shared ? `\nShared collections on this device:\n${shared}` : ""}`;
  const lead = request.continueFrom ? "You ran out of steps last time; carry on from where you stopped. " : "";
  const conversation: unknown[] = [
    ...(request.continueFrom ?? []),
    { role: "user", content: [{ type: "input_text", text: `${context}\n\n${lead}Request: ${text ?? ""}` }] },
  ];
  const toolList = tools(!!deps.screenshot);

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let response: ModelResponse;
      try {
        response = await respond(deps, { tools: toolList, input: conversation });
      } catch (e) {
        deps.log({ role: "error", text: (e as Error).message });
        return { conversation, finished: true };
      }
      // The model's own items go back next time, except its reasoning (only summaries here).
      // A call whose arguments are broken JSON goes back without them: the API refuses it.
      conversation.push(
        ...response.output
          .filter((o) => o.type !== "reasoning")
          .map((o) => (o.type === "function_call" && !parses(o.arguments ?? "{}") ? { ...o, arguments: "{}" } : o)),
      );
      const calls = response.output.filter((o): o is FunctionCall & ResponseItem => o.type === "function_call");
      const said = messageText(response);
      if (!calls.length) {
        const spec = jsonBlock(said);
        if (spec === undefined) {
          deps.log({ role: "model", text: prose(said) || "Done." });
          return { conversation, finished: true };
        }
        // It wrote a spec and stopped without calling set_spec: apply it as if it had.
        status(WORKING.set_spec);
        const result = await runTool(deps, "set_spec", { spec }, []);
        conversation.push({ role: "user", content: [{ type: "input_text", text: `You wrote a spec without calling set_spec, so it was taken as one. ${String(result)}${String(result).startsWith("Applied") ? " Call finish when the app is done." : ""}` }] });
        continue;
      }
      const images: string[] = [];
      let finished = false;
      for (const call of calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch (e) {
          const hint = call.name === "set_spec" ? " Put a whole spec in your message as one ```json block instead, and call set_spec with no arguments." : " Send them again as JSON.";
          deps.log({ role: "step", text: "Fixing a change that didn't apply" });
          conversation.push({ type: "function_call_output", call_id: call.call_id, output: `The arguments weren't valid JSON (${(e as Error).message}).${hint}` });
          continue;
        }
        if (call.name === "set_spec" && args.spec === undefined) args.spec = jsonBlock(said);
        status(WORKING[call.name] ?? "Working");
        const result = await runTool(deps, call.name, args, images, prose(said));
        if (result === FINISHED) finished = true;
        conversation.push({ type: "function_call_output", call_id: call.call_id, output: result === FINISHED ? "ok" : result });
      }
      if (finished) return { conversation, finished: true };
      // Tool results are text; screenshots go back as images in a user message.
      if (images.length) conversation.push({ role: "user", content: images.map((url) => ({ type: "input_image", image_url: url })) });
    }
  } finally {
    status("");
  }
  deps.log({ role: "error", text: "I ran out of steps for this request. Everything up to the last good change is applied; ask me to continue." });
  return { conversation, finished: false };
}

const parses = (json: string) => {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
};

const FENCE = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/g;

/** The last ```json block of a message, as text (parsed by set_spec, which reports its errors). */
function jsonBlock(text: string): string | undefined {
  const blocks = [...text.matchAll(FENCE)];
  if (blocks.length) return blocks.at(-1)![1];
  const open = text.lastIndexOf("```");
  // An unclosed block: the message was cut off, or the model forgot the closing fence.
  return open >= 0 ? text.slice(open).replace(/^```(?:json)?[ \t]*\n?/, "") : undefined;
}

/** What the model said, without the spec it wrote. */
function prose(text: string): string {
  const open = text.indexOf("```");
  return (open >= 0 ? text.slice(0, open) : text).trim();
}

const FINISHED = Symbol("finished");

/**
 * An object argument, which models sometimes send as JSON text instead: that is taken too,
 * and when the text doesn't parse the error says where, so the model can fix it.
 */
function decoded(value: unknown, name: string): unknown {
  if (value === undefined && name === "spec") {
    throw new Error("No spec in this message: write the complete spec in your message as one ```json block, then call set_spec. If your last spec was applied, call finish instead.");
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    const message = (e as Error).message;
    const at = Number(message.match(/position (\d+)/)?.[1] ?? NaN);
    const near = isNaN(at) ? "" : ` Near: …${value.slice(Math.max(0, at - 60), at)}⟨here⟩${value.slice(at, at + 30)}…`;
    throw new Error(`The ${name} isn't valid JSON: ${message}.${near} Write it again, whole, with that fixed.`);
  }
}

/** Runs a tool call; `spoken` is what the model already said in this step (shown in the log). */
async function runTool(deps: AgentDeps, name: string, args: Record<string, unknown>, images: string[], spoken = ""): Promise<string | typeof FINISHED> {
  switch (name) {
    case "apply_patch":
    case "set_spec": {
      let next: AppSpec;
      try {
        next = name === "set_spec" ? (decoded(args.spec, "spec") as AppSpec) : applyPatch(deps.getSpec(), (decoded(args.patch, "patch") as PatchOp[]) ?? []);
      } catch (e) {
        deps.log({ role: "step", text: `Fixing a change that didn't apply` });
        return `Not applied: ${(e as Error).message}`;
      }
      const { errors, unfinished } = specProblems(next);
      if (errors.length) {
        deps.log({ role: "step", text: `Fixing ${errors.length === 1 ? "a problem" : `${errors.length} problems`}: ${errors[0]}` });
        return `Not applied, the spec has errors:\n${errors.slice(0, 12).join("\n")}`;
      }
      deps.commit(next);
      deps.log({ role: "step", text: name === "set_spec" ? "Wrote the app" : "Changed the app" });
      if (unfinished.length) return `Applied. The user sees the change now. Still to do before you finish:\n${unfinished.slice(0, 12).join("\n")}`;
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
      // The app may be built over several steps, but not left with buttons that lead nowhere.
      const { unfinished } = specProblems(deps.getSpec());
      if (unfinished.length) return `Not finished: the app isn't complete yet.\n${unfinished.slice(0, 12).join("\n")}\nFix these, then finish.`;
      const message = String(args.message ?? "Done.");
      if (message.trim() !== spoken) deps.log({ role: "model", text: message });
      return FINISHED;
    }
    default:
      return `Unknown tool '${name}'.`;
  }
}

function messageText(response: ModelResponse): string {
  return response.output
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim();
}

/** POSTs to the Responses API and reads its stream, showing the model's progress as it comes. */
async function respond(deps: AgentDeps, body: { tools: unknown[]; input: unknown[] }): Promise<ModelResponse> {
  const { settings } = deps;
  const status = (text: string) => deps.status?.(text);
  status("Thinking");
  // Each reasoning summary part is a log entry, written as it streams.
  const thoughts = new Map<string, { id: string; text: string }>();
  let said: string | null = null;
  let saying = "";
  let writing = "";
  let written = 0;
  let final: ModelResponse | null = null;
  let failure: string | null = null;
  const lines: string[] = [];

  const onEvent = (e: Record<string, unknown>) => {
    switch (e.type) {
      case "response.reasoning_summary_part.added":
        status("Thinking");
        thoughts.set(`${e.item_id}:${e.summary_index}`, { id: deps.log({ role: "thought", text: "…" }), text: "" });
        break;
      case "response.reasoning_summary_text.delta": {
        const key = `${e.item_id}:${e.summary_index}`;
        const t = thoughts.get(key) ?? { id: deps.log({ role: "thought", text: "" }), text: "" };
        t.text += String(e.delta ?? "");
        thoughts.set(key, t);
        deps.update?.(t.id, { text: t.text });
        break;
      }
      case "response.output_text.delta": {
        // What the model says before it acts ("Building your sundial app…"); a spec it
        // writes in a ```json block shows as progress instead.
        saying += String(e.delta ?? "");
        const open = saying.indexOf("```");
        const words = prose(saying);
        if (words) {
          if (said) deps.update?.(said, { text: words });
          else said = deps.log({ role: "model", text: words });
        }
        if (open >= 0) {
          const length = saying.length - open;
          if (Math.floor(length / 1000) !== Math.floor((length - String(e.delta ?? "").length) / 1000)) status(`Writing the app · ${Math.floor(length / 1000)}k characters`);
          else if (length < 1000) status("Writing the app");
        }
        break;
      }
      case "response.output_item.added": {
        const item = e.item as ResponseItem | undefined;
        if (item?.type === "function_call") {
          writing = WORKING[item.name ?? ""] ?? "Working";
          written = 0;
          status(writing);
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        // A whole spec takes a while to write: show how far it got.
        const before = written;
        written += String(e.delta ?? "").length;
        if (written > 2000 && Math.floor(written / 1000) !== Math.floor(before / 1000)) status(`${writing} · ${Math.floor(written / 1000)}k characters`);
        break;
      }
      case "response.completed":
        final = e.response as ModelResponse;
        break;
      case "response.failed":
      case "response.incomplete":
        failure = (e.response as ModelResponse | undefined)?.error?.message ?? String(e.type).replace("response.", "The response ");
        break;
      case "error":
        failure = String((e as { message?: string }).message ?? "The model service failed");
        break;
    }
  };
  const onLine = (line: string) => {
    lines.push(line);
    if (!line.startsWith("data:")) return;
    try {
      onEvent(JSON.parse(line.slice(5)));
    } catch {
      // A line that isn't JSON (a keep-alive) carries nothing.
    }
  };

  const res = await deps.http(
    {
      url: `${settings.baseUrl.replace(/\/$/, "")}/responses`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        instructions: systemPrompt(),
        tools: body.tools,
        input: body.input,
        reasoning: { summary: "auto" },
        stream: true,
        store: false,
      }),
      stream: true,
    },
    onLine,
  );
  // A host that can't stream returns the whole body at once: read it the same way.
  if (res.body) for (const line of res.body.split("\n")) onLine(line.replace(/\r$/, ""));
  const text = lines.join("\n");
  if (res.status >= 400) {
    let message = text.slice(0, 200);
    try {
      message = JSON.parse(text).error?.message ?? message;
    } catch {
      // Not JSON: the text itself says what went wrong.
    }
    throw new Error(`The model service answered ${res.status}: ${message}`);
  }
  if (failure) throw new Error(failure);
  if (!final) throw new Error(`The model service's answer ended early: ${text.slice(-200)}`);
  return final;
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
