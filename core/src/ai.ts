// Asking Meta's model from an app: the shell's container service behind the `ask`
// async action. Like `findObjects`, the key stays in the shell: it builds the
// request, streams the answer (into the app's state while it writes), and answers
// text or parsed JSON. Failures go to the action's `else`.
import type { Runtime } from "./runtime.ts";

const NO_KEY = "Add a Meta Model API key in Settings to use AI in apps.";
const TOO_LONG = "The request is too long";
const TOO_MANY_IMAGES = "Too many images (at most 4)";
const TOO_MANY_CALLS = "Too many AI requests; wait a moment";
const BAD_INTO = "`into` must be one of the app's state keys";
const BAD_JSON = "The model's answer wasn't valid JSON";
const REFUSED = "The API key was refused";
const TOO_SLOW = "The model took too long";
const NO_ANSWER = "The model gave no answer";

const MAX_CHARS = 100000;
const MAX_IMAGES = 4;
const MAX_CALLS = 20;
const WINDOW_MS = 60000;
const TIMEOUT_MS = 120000;
const INTO_MS = 100;

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function textArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Earlier turns, oldest first: [{role: "user" | "model", text}]; anything else is ignored. */
function historyTurns(history: unknown): HistoryTurn[] {
  if (!Array.isArray(history)) return [];
  const out: HistoryTurn[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec.role !== "user" && rec.role !== "model") continue;
    if (typeof rec.text !== "string") continue;
    out.push({ role: rec.role === "model" ? "assistant" : "user", content: rec.text });
  }
  return out;
}

interface ImageRef {
  id: string;
  type: string;
}

function imageRefs(images: unknown): ImageRef[] {
  const list = images == null ? [] : Array.isArray(images) ? images : [images];
  const out: ImageRef[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item) out.push({ id: item, type: "" });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.id === "string" && rec.id) out.push({ id: rec.id, type: typeof rec.type === "string" ? rec.type : "" });
    }
  }
  return out;
}

/** The app runtime with this id, among the shell's embedded runtimes at any depth. */
function findRuntime(shell: Runtime, id: string): Runtime | undefined {
  const queue = [...shell.children];
  while (queue.length) {
    const rt = queue.shift()!;
    if ((rt.spec as { id?: string } | undefined)?.id === id) return rt;
    queue.push(...rt.children);
  }
  return undefined;
}

/** The message text of a Responses API body, or "" when it has none. */
function responseText(body: string): string {
  try {
    const json = JSON.parse(body) as { output?: { type?: string; content?: { text?: string }[] }[] };
    return (json.output ?? [])
      .filter((o) => o?.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c?.text ?? "")
      .join("");
  } catch {
    return "";
  }
}

function modelError(body: string, status: number): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (message) return `The model answered ${status}: ${message}`;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `The model answered ${status}`;
}

/** Parsed JSON after stripping a surrounding ```json fence. */
export function parseJsonAnswer(text: string): unknown {
  return JSON.parse(stripFence(text));
}

/**
 * Makes a JSON Schema strict for the Responses API: every object with
 * `properties` gets `additionalProperties: false` and `required` listing all
 * of its properties, recursively (properties, array `items`, `anyOf`/`oneOf`
 * members). The API requires this for strict mode.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
    const props = s.properties as Record<string, unknown>;
    const strictProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) strictProps[k] = strictSchema(v);
    out.properties = strictProps;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (s.items !== undefined) out.items = Array.isArray(s.items) ? (s.items as unknown[]).map(strictSchema) : strictSchema(s.items);
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(s[key])) out[key] = (s[key] as unknown[]).map(strictSchema);
  }
  return out;
}

/** Whether a 400 body blames the schema (its error message or `param` names it). */
function schemaError(body: string): boolean {
  try {
    const json = JSON.parse(body) as { error?: { message?: string; param?: string }; param?: string; message?: string };
    const message = String(json.error?.message ?? json.message ?? body);
    const param = String(json.error?.param ?? json.param ?? "");
    return message.toLowerCase().includes("schema") || param.toLowerCase().includes("schema");
  } catch {
    return body.toLowerCase().includes("schema");
  }
}

function stripFence(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```") || !t.endsWith("```")) return t;
  let inner = t.slice(3, t.length - 3).trim();
  if (/^json(\s|$)/i.test(inner)) inner = inner.replace(/^json/i, "").trim();
  return inner;
}

/** Registers the shell's `ask` container service (see `installBuilder`). */
export function installAi(shell: Runtime): void {
  /** Calls per app in the last minute: guards the user's bill against a runaway loop. */
  const calls = new Map<string, number[]>();
  shell.containerServices.set("ask", async (args, ctx) => {
    const apiKey = String(shell.get("apiKey") ?? "");
    if (!apiKey) throw new Error(NO_KEY);
    // The key never reaches the app: every error below has it replaced first.
    const redact = (message: string): string => (apiKey ? message.split(apiKey).join("…") : message);
    // Set once the call settles: late progress never overwrites `into`.
    let settled = false;
    try {
      // One 120 s limit for the whole call: reading the photos, the request and a schema retry.
      return await withTimeout(shell, (async () => {
        const baseUrl = String(shell.get("baseUrl") || "https://api.meta.ai/v1").replace(/\/$/, "");
        const model = String(shell.get("model") || "muse-spark-1.3");
        const app = ctx.app || "";
        const nowMs = Date.now();
        const recent = (calls.get(app) ?? []).filter((t) => nowMs - t < WINDOW_MS);
        if (recent.length >= MAX_CALLS) throw new Error(TOO_MANY_CALLS);
        recent.push(nowMs);
        calls.set(app, recent);

        const prompt = textArg(args.prompt);
        if (!prompt) throw new Error("The prompt must not be empty");
        const system = textArg(args.system);
        const history = historyTurns(args.history);
        const total = prompt.length + system.length + history.reduce((n, t) => n + t.content.length, 0);
        if (total > MAX_CHARS) throw new Error(TOO_LONG);
        const images = imageRefs(args.images);
        if (images.length > MAX_IMAGES) throw new Error(TOO_MANY_IMAGES);
        const into = typeof args.into === "string" && args.into ? args.into : "";
        const target = into ? findRuntime(shell, app) : undefined;
        if (into && (!target?.spec || !Object.hasOwn(target.spec.state ?? {}, into))) throw new Error(BAD_INTO);
        const effort = typeof args.effort === "string" && EFFORTS.has(args.effort) ? (args.effort as string) : "low";
        let maxTokens = Math.floor(Number(args.maxTokens ?? 4000));
        if (!Number.isFinite(maxTokens)) maxTokens = 4000;
        maxTokens = Math.min(16000, Math.max(1, maxTokens));
        const schema = (args as Record<string, unknown>).schema;
        const useSchema = schema !== undefined && schema !== null;

        let instructions = system;
        if (useSchema) instructions += `${instructions ? "\n" : ""}Answer only with JSON that matches the schema.`;
        const content: unknown[] = [{ type: "input_text", text: prompt }];
        for (const img of images) {
          const file = await shell.hostCall<{ data?: string }>("files.read", { app: app || shell.spec?.id || "", id: img.id, as: "base64" });
          const base64 = typeof file?.data === "string" ? file.data : "";
          if (!base64) throw new Error("No photo");
          content.push({ type: "input_image", image_url: `data:${img.type || "image/jpeg"};base64,${base64}` });
        }
        let text = "";
        let failure: string | null = null;
        let lastPush = 0;
        const push = (force: boolean) => {
          if (settled) return;
          if (!into || !target) return;
          const at = Date.now();
          if (force || at - lastPush >= INTO_MS) {
            lastPush = at;
            target.set(into, text);
          }
        };
        const onLine = (line: string) => {
          if (settled) return;
          if (!line.startsWith("data:")) return;
          let e: Record<string, unknown>;
          try {
            e = JSON.parse(line.slice(5)) as Record<string, unknown>;
          } catch {
            return;
          }
          // Reasoning events are ignored: only the answer streams into the app.
          if (e?.type === "response.output_text.delta") {
            text += String((e as { delta?: unknown }).delta ?? "");
            push(false);
          } else if (e?.type === "response.failed") {
            const response = e.response as { error?: { message?: string } } | undefined;
            const message = response?.error?.message ?? (e as { message?: string }).message;
            failure = message ? String(message) : "The model failed";
          } else if (e?.type === "error") {
            failure = String((e as { message?: string }).message ?? "The model service failed");
          } else if (e?.type === "response.incomplete") {
            const response = e.response as { incomplete_details?: { reason?: string }; error?: { message?: string } } | undefined;
            const reason = response?.incomplete_details?.reason ?? response?.error?.message ?? "stopped";
            failure = `The model stopped: ${reason}`;
          }
        };
        const post = async (withFormat: boolean, how: string) =>
          shell.hostCall<{ status?: number; body?: string }>(
              "http",
              {
                url: `${baseUrl}/responses`,
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model,
                  instructions: how,
                  input: [...history, { role: "user", content }],
                  stream: true,
                  reasoning: { effort },
                  max_output_tokens: maxTokens,
                  ...(withFormat && useSchema ? { text: { format: { type: "json_schema", name: "answer", schema: strictSchema(schema), strict: true } } } : {}),
                }),
                stream: true,
              },
              (u) => {
                if (settled) return;
                if (u && typeof (u as { line?: unknown }).line === "string") onLine((u as { line: string }).line);
              },
            );

        let res = await post(true, instructions);
        // A host that can't stream answers with the whole body; read it the same way.
        let status = Number(res?.status ?? 0);
        let body = String(res?.body ?? "");
        if (body) for (const line of body.split("\n")) onLine(line.replace(/\r$/, ""));
        if (useSchema && status === 400 && schemaError(body)) {
          // Strict schemas sometimes disagree with the API: once, ask again without
          // `text`, with the schema in the instructions instead.
          text = "";
          failure = null;
          lastPush = 0;
          const fallback = `${instructions}${instructions ? "\n" : ""}Answer only with JSON that matches this JSON Schema, no other text:\n${JSON.stringify(schema)}`;
          res = await post(false, fallback);
          status = Number(res?.status ?? 0);
          body = String(res?.body ?? "");
          if (body) for (const line of body.split("\n")) onLine(line.replace(/\r$/, ""));
        }
        if (failure) throw new Error(failure);
        if (status === 401) throw new Error(REFUSED);
        if (status >= 400) throw new Error(modelError(body, status));
        if (!text) text = responseText(body);
        push(true);
        settled = true;
        if (!text) throw new Error(NO_ANSWER);
        if (useSchema) {
          try {
            return parseJsonAnswer(text);
          } catch {
            throw new Error(BAD_JSON);
          }
        }
        return text;
      })());
    } catch (e) {
      settled = true;
      throw new Error(redact((e as Error).message ?? String(e)));
    }
  });

  /** The 120 s timeout, through the host's clock (core keeps no timers of its own). */
  function withTimeout<T>(rt: Runtime, p: Promise<T>): Promise<T> {
    const after = rt.host.after;
    if (!after) return p;
    let settled = false;
    return new Promise<T>((resolve, reject) => {
      p.then(
        (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        },
        (e) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        },
      );
      try {
        after.call(rt.host, TIMEOUT_MS, () => {
          if (!settled) {
            settled = true;
            reject(new Error(TOO_SLOW));
          }
        });
      } catch {
        // Without the host's clock the call simply runs without a timeout.
      }
    });
  }
}
