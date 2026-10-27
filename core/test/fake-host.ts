// A deterministic host for Node tests: fixed-width glyphs, greedy word wrap.
import { DatabaseSync } from "node:sqlite";
import type { Database, Host, Op, SqlValue, TextMeasureStyle } from "../src/bridge.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import type { AppSpec } from "../src/spec.ts";

export const CHAR = 0.5; // glyph width as a fraction of font size

export function measure(text: string, style: TextMeasureStyle, maxWidth: number) {
  // Bold runs measure wider, like on the hosts, so spans change layout.
  const bold = new Set<number>();
  for (const s of style.spans ?? []) {
    if (!s.bold) continue;
    for (let i = Math.max(0, s.start); i < Math.min(text.length, s.end); i++) bold.add(i);
  }
  const cw = style.fontSize * CHAR;
  const widthOf = (i: number) => (bold.has(i) ? cw * 1.2 : cw);
  const lines: number[] = [];
  let at = 0; // UTF-16 offset of the paragraph in the whole text
  for (const para of text.split("\n")) {
    let line = 0;
    let wordAt = at;
    for (const word of para.split(" ")) {
      let w = 0;
      for (let i = 0; i < word.length; i++) w += widthOf(wordAt + i);
      const withSpace = line === 0 ? w : line + cw + w;
      if (line > 0 && withSpace > maxWidth) {
        lines.push(line);
        line = w;
      } else line = withSpace;
      wordAt += word.length + 1;
    }
    lines.push(line);
    at += para.length + 1;
  }
  return { width: Math.min(maxWidth, Math.max(...lines)), height: lines.length * style.lineHeight };
}

/** In-memory SQLite (Node's built-in driver) behind the host `Database` contract. */
export function makeDb(sqlite = new DatabaseSync(":memory:")): Database & { sqlite: DatabaseSync } {
  return {
    sqlite,
    // Rows come back with a null prototype; copy them into plain objects.
    query: (sql, params = []) => sqlite.prepare(sql).all(...params).map((r) => ({ ...r }) as Record<string, SqlValue>),
    exec(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const [sql, params = []] of statements) sqlite.prepare(sql).run(...params);
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export interface TestFile {
  id: string;
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

/** What the next picker returns: a file spec, a list of them for `multiple`, or `"Cancelled"`. */
export type NextPick =
  | "Cancelled"
  | { name?: string; type?: string; data?: string; text?: string; size?: number }
  | { name?: string; type?: string; data?: string; text?: string; size?: number }[];

export interface TestHost extends Host {
  batches: Op[][];
  db: ReturnType<typeof makeDb>;
  /** Secure storage contents, keyed `app/key`. */
  vault: Map<string, string>;
  pending: (() => void)[];
  measureCalls: number;
  /** Timers scheduled with `after`, with their due epoch milliseconds. */
  timers: { due: number; cb: () => void }[];
  /** Host services called, by name (async actions and live stops). */
  calls: { service: string; args: Record<string, unknown> }[];
  /** Per-app file store: `files.get(app).get(id)` is the stored file. */
  files: Map<string, Map<string, TestFile>>;
  /** What the next `pickFile`/`pickPhoto`/`takePhoto` answers. */
  nextPick: NextPick | undefined;
  /** Live watches waiting for updates, with the callbacks the runtime gave. */
  locationWatch: { progress?: (update: Record<string, unknown>) => void; done: (result: unknown, error?: string) => void } | null;
  headingWatch: { progress?: (update: Record<string, unknown>) => void; done: (result: unknown, error?: string) => void } | null;
  /** Pushes a streamed update through a live watch. */
  pushLocation(update: Record<string, unknown>): void;
  pushHeading(update: Record<string, unknown>): void;
  /** Ends a live watch with an error (the value stays as it was). */
  failLocation(error: string): void;
  failHeading(error: string): void;
}

export function makeHost(db = makeDb(), vault = new Map<string, string>()): TestHost {
  const host: TestHost = {
    batches: [],
    db,
    vault,
    secrets: {
      get: (app, key) => vault.get(`${app}/${key}`) ?? null,
      set: (app, key, value) => void (value == null ? vault.delete(`${app}/${key}`) : vault.set(`${app}/${key}`, value)),
      clear: (app) => {
        for (const k of [...vault.keys()]) if (k.startsWith(`${app}/`)) vault.delete(k);
      },
    },
    pending: [],
    measureCalls: 0,
    timers: [],
    calls: [],
    files: new Map(),
    nextPick: undefined,
    locationWatch: null,
    headingWatch: null,
    pushLocation(update) {
      host.locationWatch?.progress?.(update);
    },
    pushHeading(update) {
      host.headingWatch?.progress?.(update);
    },
    failLocation(error) {
      const w = host.locationWatch;
      host.locationWatch = null;
      w?.done(null, error);
    },
    failHeading(error) {
      const w = host.headingWatch;
      host.headingWatch = null;
      w?.done(null, error);
    },
    apply(ops) {
      host.batches.push(ops);
    },
    measureText(text, style, maxWidth) {
      host.measureCalls++;
      return measure(text, style, maxWidth);
    },
    measureControl(type) {
      if (type === "toggle") return { width: 51, height: 31 };
      if (type === "slider") return { width: 160, height: 28 };
      if (type === "timePicker") return { width: 96, height: 34 };
      return { width: 0, height: 0 };
    },
    call(service, args, done, progress) {
      host.calls.push({ service, args });
      if (service === "location.watch") {
        host.locationWatch = { progress, done };
        return;
      }
      if (service === "location.stop") {
        const w = host.locationWatch;
        host.locationWatch = null;
        w?.done({});
        done({});
        return;
      }
      if (service === "heading.watch") {
        host.headingWatch = { progress, done };
        return;
      }
      if (service === "heading.stop") {
        const w = host.headingWatch;
        host.headingWatch = null;
        w?.done({});
        done({});
        return;
      }
      if (["schedule.set", "widgets.set", "haptic", "keepAwake", "brightness", "speak", "stopSpeaking", "share"].includes(service)) { done({}); return; }
      if (service === "files.write") {
        try {
          return void done(writeFile(host, args));
        } catch (e) {
          return void done(null, (e as Error).message);
        }
      }
      if (service === "files.read") {
        const { data, error } = readFile(host, args);
        return void (error ? done(null, error) : done({ data }));
      }
      if (service === "files.delete") {
        deleteFile(host, args);
        return void done({});
      }
      if (service === "files.clear") {
        host.files.delete(String((args as { app?: unknown }).app ?? ""));
        return void done({});
      }
      if (service === "pickFile" || service === "pickPhoto" || service === "takePhoto") {
        const multiple = (args as { multiple?: unknown }).multiple === true;
        const taken = host.nextPick;
        host.nextPick = undefined;
        if (taken === undefined || taken === "Cancelled") return void done(null, "Cancelled");
        const specs = Array.isArray(taken) ? taken : [taken];
        const app = String((args as { app?: unknown }).app ?? "");
        const handles = specs.map((s) => handleOf(storePick(host, app, s, service)));
        return void done(multiple ? handles : handles[0]);
      }
      if (service === "script.run") return void runSandbox(host, args, done, false);
      if (service === "script.render") return void runSandbox(host, args, done, true);
      if (service === "script.close") return void done({});
      done(null, `No '${service}' service`);
    },
    requestFrame(cb) {
      host.pending.push(cb);
    },
    after(ms, cb) {
      host.timers.push({ due: Date.now() + ms, cb });
    },
  };
  return host;
}

/** In-memory file store behind `files.*` and the pickers. */
let fileSeq = 1;

/**
 * The fake sandbox: runs `code` in a fresh `node:vm` context per call (tests only;
 * core itself uses no Node APIs). `script.run` calls `exports[fn](args)`; render
 * calls `exports[element](props)`. Answers `{value}` / `{tree}`, or the error message.
 */
async function runSandbox(
  host: TestHost,
  args: Record<string, unknown>,
  done: (result: unknown, error?: string) => void,
  render: boolean,
): Promise<void> {
  const a = args as { code?: unknown; fn?: unknown; element?: unknown; args?: unknown; props?: unknown };
  const code = typeof a.code === "string" ? a.code : "";
  const name = render ? String(a.element ?? "") : String(a.fn ?? "");
  const input = render ? a.props : a.args;
  try {
    const vm = await import("node:vm");
    const exports: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = { exports, console: { log: () => {} } };
    vm.createContext(sandbox);
    const script = new vm.Script(`${code}\n;exports;`);
    script.runInContext(sandbox);
    const fn = (sandbox.exports as Record<string, unknown>)[name];
    if (typeof fn !== "function") throw new Error(render ? `No element '${name}'` : `No export '${name}'`);
    const out = await (fn as (input: unknown) => unknown)(input);
    const json = JSON.stringify(out ?? null);
    if (json.length > 2 * 1024 * 1024) throw new Error("Result too large");
    done(render ? { tree: out } : { value: out });
  } catch (e) {
    done(null, (e as Error).message);
  }
}

function appFiles(host: TestHost, app: string): Map<string, TestFile> {
  let m = host.files.get(app);
  if (!m) host.files.set(app, (m = new Map()));
  return m;
}

function toBytes(spec: { data?: unknown; text?: unknown }): Buffer {
  if (typeof spec.text === "string") return Buffer.from(spec.text, "utf8");
  if (typeof spec.data === "string") return Buffer.from(spec.data, "base64");
  return Buffer.alloc(0);
}

function storeFile(host: TestHost, app: string, name: string, type: string, data: Buffer): TestFile {
  const id = `f${fileSeq++}`;
  const file: TestFile = { id, name, type, size: data.length, data };
  appFiles(host, app).set(id, file);
  return file;
}

function handleOf(file: TestFile): Record<string, unknown> {
  return { id: file.id, name: file.name, type: file.type, size: file.size };
}

function writeFile(host: TestHost, args: Record<string, unknown>): Record<string, unknown> {
  const app = String(args.app ?? "");
  const name = String(args.name ?? "file");
  const type = String(args.type ?? "application/octet-stream");
  // Strict like the hosts: invalid base64 answers "Bad file data" instead of storing bytes.
  if (typeof args.data === "string" && !isValidBase64(args.data)) throw new Error("Bad file data");
  const data = typeof args.data === "string" ? Buffer.from(args.data.replace(/\s/g, ""), "base64") : Buffer.alloc(0);
  return handleOf(storeFile(host, app, name, type, data));
}

/** Whether `s` decodes as strict base64 (empty means an empty file). */
function isValidBase64(s: string): boolean {
  if (s === "") return true;
  const t = s.replace(/\s/g, "");
  if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return false;
  const pad = t.endsWith("==") ? 2 : t.endsWith("=") ? 1 : 0;
  return pad === 0 || !t.slice(0, -pad).includes("=");
}

function storePick(host: TestHost, app: string, spec: unknown, service: string): TestFile {
  const s = (spec ?? {}) as { name?: unknown; type?: unknown; data?: unknown; text?: unknown };
  const data = toBytes(s);
  const photo = service !== "pickFile";
  return storeFile(
    host,
    app,
    typeof s.name === "string" && s.name ? s.name : photo ? "photo.jpg" : "file",
    typeof s.type === "string" && s.type ? s.type : photo ? "image/jpeg" : "application/octet-stream",
    data,
  );
}

function readFile(host: TestHost, args: Record<string, unknown>): { data?: string; error?: string } {
  const file = host.files.get(String(args.app ?? ""))?.get(String(args.id ?? ""));
  if (!file) return { error: "No such file" };
  const offset = Math.max(0, Number(args.offset ?? 0) || 0);
  const length = args.length == null ? file.data.length : Math.max(0, Number(args.length) || 0);
  const slice = file.data.subarray(offset, offset + length);
  return { data: args.as === "base64" ? slice.toString("base64") : slice.toString("utf8") };
}

function deleteFile(host: TestHost, args: Record<string, unknown>): void {
  host.files.get(String(args.app ?? ""))?.delete(String(args.id ?? ""));
}

/** Runs pending frames and returns the ops they produced. */
export function frame(host: TestHost): Op[] {
  const before = host.batches.length;
  while (host.pending.length) host.pending.shift()!();
  return host.batches.slice(before).flat();
}

/** Fires timers whose time came (move `Date.now` in the test first); repeats while new ones come due. */
export function runTimers(host: TestHost): void {
  for (;;) {
    const due = host.timers.filter((t) => t.due <= Date.now());
    if (!due.length) return;
    for (const t of due) host.timers.splice(host.timers.indexOf(t), 1);
    for (const t of due) t.cb();
  }
}

export function boot(spec: AppSpec, db?: TestHost["db"], vault?: TestHost["vault"], options?: RuntimeOptions) {
  const host = makeHost(db, vault);
  const rt = new Runtime(host, options);
  rt.setViewport(390, 844);
  rt.load(spec);
  const ops = frame(host);
  return { host, rt, ops };
}

/** Finds the first node whose prop matches. */
export function findNode(rt: Runtime, pred: (props: Record<string, unknown>, type: string) => boolean) {
  for (const n of rt.nodes.values()) if (n.alive && pred(n.props, n.type)) return n;
  return undefined;
}

export const byText = (rt: Runtime, value: string) => findNode(rt, (p) => p.value === value || p.label === value);
