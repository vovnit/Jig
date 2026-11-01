// Scripted demo flows with replayed model traffic: the same steps run on each
// device, and `http` answers from a tape recorded once, so both phones build
// the identical app with no network or API key.

import type { Host } from "./bridge.ts";
import type { ViewNode } from "./layout.ts";
import type { Runtime } from "./runtime.ts";

export interface TapeEntry { key: string; status: number; body: string; lines?: [number, string][]; ms: number }
export interface Tape { entries: TapeEntry[] }
export type DemoStep =
  | { record: "start" | "stop" }
  | { wait: number }
  | { mark: string }
  | { tap: string; nth?: number; contains?: boolean }
  | { select: string; nth?: number; contains?: boolean }
  | { type: string; into: string; cps?: number; nth?: number; contains?: boolean }
  | { submit: string; nth?: number; contains?: boolean }
  | { scrollTo: string; nth?: number; contains?: boolean }
  | { waitFor: string; contains?: boolean; timeout?: number }
  | { waitIdle: true; timeout?: number }
  | { back: true }
  | { setItem: { app: string; list: string; where: Record<string, unknown>; set: Record<string, unknown> } };
export interface DemoScript { name: string; speed?: number; pause?: number; steps: DemoStep[] }

/** `${method} ${pathname}` of a request; image prompts join the key so each prompt replays its own picture. */
export function tapeKey(args: Record<string, unknown>): string {
  const method = String((args as { method?: unknown }).method ?? "GET");
  const url = String((args as { url?: unknown }).url ?? "");
  const path = pathnameOf(url);
  if (path.endsWith("/images/generations")) {
    try {
      const body = JSON.parse(String((args as { body?: unknown }).body ?? ""));
      const prompt = (body as { prompt?: unknown } | null)?.prompt;
      if (typeof prompt === "string" && prompt) return `${method} ${path} ${prompt}`;
    } catch {
      // A body that isn't JSON carries no prompt.
    }
  }
  return `${method} ${path}`;
}

function pathnameOf(url: string): string {
  const s = String(url ?? "");
  const hash = s.indexOf("#");
  const query = s.indexOf("?");
  let end = s.length;
  if (query >= 0) end = Math.min(end, query);
  if (hash >= 0) end = Math.min(end, hash);
  const head = s.slice(0, end);
  const scheme = head.indexOf("://");
  if (scheme >= 0) {
    const slash = head.indexOf("/", scheme + 3);
    return slash >= 0 ? head.slice(slash) || "/" : "/";
  }
  const slash = head.indexOf("/");
  if (slash === 0) return head || "/";
  if (slash > 0) return head.slice(slash) || "/";
  return head ? `/${head}` : "/";
}

/** Waits `ms` on the host timer (a real pause, never scaled by tape speed). */
function sleep(host: Host, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (host.after) host.after(Math.max(0, ms), resolve);
    else {
      const set = (globalThis as { setTimeout?: (cb: () => void, ms: number) => void }).setTimeout;
      if (set) set(resolve, Math.max(0, ms));
      else resolve();
    }
  });
}

/** Records live `http` traffic into the tape, without storing secrets. */
export function recordHttp(host: Host, tape: Tape): void {
  const orig = host.call;
  if (!orig) return;
  host.call = function (service, args, done, progress) {
    // A demo never schedules real notifications (or asks for permission).
    if (service === "schedule.set") {
      done({});
      return;
    }
    if (service !== "http") return orig.call(host, service, args, done, progress);
    const key = tapeKey(args);
    const start = host.now?.() ?? Date.now();
    const lines: [number, string][] = [];
    const at = () => (host.now?.() ?? Date.now()) - start;
    orig.call(host, service, args, (result, error) => {
      if (!error) {
        const r = (result ?? {}) as { status?: unknown; body?: unknown };
        tape.entries.push({
          key,
          status: Number(r.status ?? 0),
          body: String(r.body ?? ""),
          ...(lines.length ? { lines: [...lines] } : {}),
          ms: at(),
        });
      }
      done(result, error);
    }, (update) => {
      if (update && typeof (update as { line?: unknown }).line === "string") {
        lines.push([at(), (update as { line: string }).line]);
      }
      try {
        progress?.(update);
      } catch {
        // Forwarding never fails the recording.
      }
    });
  };
}

/** Answers `http` from the tape, streaming lines at tape pace divided by `speed`. Misses 599 unless `onMiss` answers them (extend mode: live, then recorded). */
export function replayHttp(host: Host, tape: Tape, speed = 1, onMiss?: (args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => void): void {
  const orig = host.call;
  const remaining = [...(tape?.entries ?? [])];
  const s = speed && speed > 0 ? speed : 1;
  const after = (ms: number, cb: () => void) => {
    if (host.after) host.after(ms / s, cb);
    else {
      const set = (globalThis as { setTimeout?: (cb: () => void, ms: number) => void }).setTimeout;
      if (set) set(cb, ms / s);
      else cb();
    }
  };
  host.call = function (service, args, done, progress) {
    // A demo never schedules real notifications (or asks for permission).
    if (service === "schedule.set") {
      done({});
      return;
    }
    if (service !== "http") {
      if (orig) return orig.call(host, service, args, done, progress);
      return done(null, `No '${service}' service`);
    }
    const key = tapeKey(args);
    let idx = remaining.findIndex((e) => e.key === key);
    if (idx < 0 && pathnameOf(String(args.url ?? "")).endsWith("/images/generations")) {
      const pathKey = `${String(args.method ?? "GET")} ${pathnameOf(String(args.url ?? ""))}`;
      idx = remaining.findIndex((e) => e.key === pathKey || e.key.startsWith(`${pathKey} `));
    }
    if (idx < 0) {
      if (onMiss) {
        onMiss(args, done, progress);
        return;
      }
      host.log?.("warn", `demo tape miss: ${key}`);
      done({ status: 599, body: '{"error":{"message":"not in the demo tape"}}' });
      return;
    }
    const [entry] = remaining.splice(idx, 1);
    for (const [ms, line] of entry.lines ?? []) after(ms, () => {
      try {
        progress?.({ line });
      } catch {
        // A listener never fails the replay.
      }
    });
    after(entry.ms, () => done({ status: entry.status, body: entry.body }));
  };
}

/** Secrets live in memory for a demo, never in the device keychain. */
export function memorySecrets(host: Host): void {
  const mem = new Map<string, string>();
  const store = (host.secrets ??= { get: () => null, set: () => {}, clear: () => {} });
  store.get = (app, key) => mem.get(`${app}/${key}`) ?? null;
  store.set = (app, key, value) => {
    const k = `${app}/${key}`;
    if (value == null) mem.delete(k);
    else mem.set(k, value);
  };
  store.clear = (app) => {
    for (const k of [...mem.keys()]) if (k.startsWith(`${app}/`)) mem.delete(k);
  };
}

/** Demo mode on a host: memory secrets, then replay (or record, live on the web). With both a tape and a record target, hits replay from the tape and misses go live and are recorded after the existing entries. */
export function installDemo(host: Host, demo: { script: DemoScript; tape: Tape | null }, record?: Tape): void {
  memorySecrets(host);
  if (demo?.tape && record) {
    for (const e of demo.tape.entries) {
      record.entries.push({ key: e.key, status: e.status, body: e.body, ...(e.lines ? { lines: e.lines.map(([ms, line]) => [ms, line] as [number, string]) } : {}), ms: e.ms });
    }
    const live = host.call;
    replayHttp(host, demo.tape, demo.script?.speed ?? 1, (args, done, progress) => {
      if (!live) {
        done(null, "No 'http' service");
        return;
      }
      const key = tapeKey(args);
      const start = host.now?.() ?? Date.now();
      const lines: [number, string][] = [];
      const at = () => (host.now?.() ?? Date.now()) - start;
      live.call(host, "http", args, (result, error) => {
        if (!error) {
          const r = (result ?? {}) as { status?: unknown; body?: unknown };
          record.entries.push({
            key,
            status: Number(r.status ?? 0),
            body: String(r.body ?? ""),
            ...(lines.length ? { lines: [...lines] } : {}),
            ms: at(),
          });
        }
        done(result, error);
      }, (update) => {
        if (update && typeof (update as { line?: unknown }).line === "string") {
          lines.push([at(), (update as { line: string }).line]);
        }
        try {
          progress?.(update);
        } catch {
          // Forwarding never fails the recording.
        }
      });
    });
    return;
  }
  if (demo?.tape) replayHttp(host, demo.tape, demo.script?.speed ?? 1);
  else if (record) recordHttp(host, record);
}

export interface RunDemoOptions {
  onDone?: (marks: { name: string; t: number }[]) => void;
  /** Retry window for finding a node (default 5000); shortened in tests. */
  retryMs?: number;
}

/** Runs the script's steps in order against the top-level shell runtime. */
export function runDemo(shell: Runtime, script: DemoScript, opts?: RunDemoOptions): Promise<{ name: string; t: number }[]> {
  return (async () => {
    const marks: { name: string; t: number }[] = [];
    // Marks are epoch milliseconds for the video edit; host.now() is performance.now() on the web.
    const now = () => Date.now();
    const log = (obj: unknown) => {
      try {
        shell.host.log?.("info", "JIGDEMO " + JSON.stringify(obj));
      } catch {
        // Logging never fails the run.
      }
    };
    const wait = (ms: number) => sleep(shell.host, ms);
    const pauseMs = script.pause ?? 700;
    const retryMs = opts?.retryMs ?? 5000;

    // The builder refuses without a key; with memory secrets this never reaches the keychain.
    try {
      if (!shell.get("apiKey")) shell.set("apiKey", "demo");
    } catch {
      // A shell without that key runs as it is.
    }
    await shell.nextFrame();

    const allNodes = () => {
      const out: ViewNode[] = [];
      // Combined tree order: depth-first through the shell, descending into an
      // on-screen embedded runtime where its `app` node sits.
      const walk = (rt: Runtime) => {
        const embeds = new Map<ViewNode, Runtime>();
        for (const ev of rt.embeddedViews()) embeds.set(ev.node, ev.rt);
        const visit = (n: ViewNode) => {
          if (n.mounted && n.alive) out.push(n);
          const child = embeds.get(n);
          if (child) walk(child);
          for (const c of n.children) visit(c);
        };
        visit(rt.root);
      };
      walk(shell);
      return out;
    };
    const matched = (s: string, contains?: boolean) => allNodes().filter((n) => {
      const check = (v: unknown) => typeof v === "string" && (contains ? v.includes(s) : v === s);
      return check(n.props.value) || check(n.props.label) || check(n.props.placeholder);
    });
    // `type` and `submit` address a text field by its placeholder only.
    const fieldMatched = (s: string, contains?: boolean) => allNodes().filter((n) => {
      if (n.type !== "textfield") return false;
      const v = n.props.placeholder;
      return typeof v === "string" && (contains ? v.includes(s) : v === s);
    });
    const find = async (s: string, nth = 0, contains?: boolean, timeout = retryMs) => {
      const start = now();
      for (;;) {
        const hits = matched(s, contains);
        if (hits.length > nth) return hits[nth];
        if (now() - start >= timeout) throw new Error(`no node '${s}'`);
        await wait(100);
      }
    };
    const findField = async (s: string, nth = 0, contains?: boolean, timeout = retryMs) => {
      const start = now();
      for (;;) {
        const hits = fieldMatched(s, contains);
        if (hits.length > nth) return hits[nth];
        if (now() - start >= timeout) throw new Error(`no node '${s}'`);
        await wait(100);
      }
    };
    // What a finger on the text would hit: the text or an ancestor that takes taps, else (a
    // row's label beside its check) the first control in the nearest container holding one.
    const canTap = (n: ViewNode) => n.type === "button" || n.props.tappable === true;
    const firstTappable = (n: ViewNode): ViewNode | null => {
      if (canTap(n)) return n;
      for (const c of n.children) {
        const hit = firstTappable(c);
        if (hit) return hit;
      }
      return null;
    };
    const tappable = (n: ViewNode) => {
      for (let cur: ViewNode | null = n; cur; cur = cur.parent) if (canTap(cur)) return cur;
      let cur: ViewNode | null = n.parent;
      for (let depth = 0; cur && depth < 3; depth++, cur = cur.parent) {
        const hit = firstTappable(cur);
        if (hit) return hit;
      }
      return n;
    };
    const findApp = (rt: Runtime, app: string): Runtime | null => {
      try {
        if (rt.spec?.name === app || rt.spec?.id === app) return rt;
      } catch {
        // A runtime without a spec yet never matches.
      }
      for (const c of rt.children) {
        const hit = findApp(c, app);
        if (hit) return hit;
      }
      return null;
    };

    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i] as DemoStep;
      try {
        if ("record" in step) {
          try {
            if (step.record === "start") await shell.hostCall("demo.record", { action: "start" });
            else await shell.hostCall("demo.record", { action: "stop", name: script.name, marks });
          } catch {
            // A host without demo.record carries on.
          }
        } else if ("wait" in step && typeof (step as { wait: unknown }).wait === "number") {
          await wait((step as { wait: number }).wait);
        } else if ("mark" in step) {
          const t = now();
          marks.push({ name: (step as { mark: string }).mark, t });
          log({ mark: (step as { mark: string }).mark, t });
        } else if ("tap" in step) {
          const s = step as { tap: string; nth?: number; contains?: boolean };
          shell.dispatch(tappable(await find(s.tap, s.nth ?? 0, s.contains)).id, "tap", {});
          await wait(pauseMs);
        } else if ("select" in step) {
          const s = step as { select: string; nth?: number; contains?: boolean };
          shell.dispatch((await find(s.select, s.nth ?? 0, s.contains)).id, "select", {});
          await wait(pauseMs);
        } else if ("type" in step) {
          const s = step as { type: string; into: string; cps?: number; nth?: number; contains?: boolean };
          const node = await findField(s.into, s.nth ?? 0, s.contains);
          const cps = s.cps ?? 30;
          const gap = cps > 0 ? 1000 / cps : 0;
          for (let k = 1; k <= s.type.length; k++) {
            shell.typeInto(node.id, s.type.slice(0, k));
            if (gap > 0) await wait(gap);
          }
          if (!s.type.length) shell.typeInto(node.id, "");
          await wait(pauseMs);
        } else if ("submit" in step) {
          const s = step as { submit: string; nth?: number; contains?: boolean };
          shell.dispatch((await findField(s.submit, s.nth ?? 0, s.contains)).id, "submit", {});
          await wait(pauseMs);
        } else if ("scrollTo" in step) {
          const s = step as { scrollTo: string; nth?: number; contains?: boolean };
          shell.scrollIntoView((await find(s.scrollTo, s.nth ?? 0, s.contains)).id);
          await wait(600);
        } else if ("waitFor" in step) {
          const s = step as { waitFor: string; contains?: boolean; timeout?: number };
          await find(s.waitFor, 0, s.contains, s.timeout ?? 180000);
        } else if ("waitIdle" in step) {
          const timeout = (step as { timeout?: number }).timeout ?? 300000;
          const start = now();
          // Up to 5 s for busy to turn on; when it never does the shell was already idle.
          for (let k = 0; k < 50; k++) {
            if (Boolean(shell.get("busy"))) break;
            if (now() - start >= 5000) break;
            await wait(100);
          }
          for (;;) {
            if (!Boolean(shell.get("busy"))) break;
            if (now() - start >= timeout) throw new Error("still busy");
            await wait(100);
          }
        } else if ("back" in step) {
          shell.back();
          await wait(pauseMs);
        } else if ("setItem" in step) {
          const s = (step as { setItem: { app: string; list: string; where: Record<string, unknown>; set: Record<string, unknown> } }).setItem;
          const rt = findApp(shell, s.app);
          if (!rt) throw new Error(`no app '${s.app}'`);
          const list = rt.get(s.list);
          if (!Array.isArray(list)) throw new Error(`no list '${s.list}'`);
          rt.set(s.list, (list as unknown[]).map((item) => (matchesWhere(item, s.where) ? { ...(item as Record<string, unknown>), ...s.set } : item)));
          await wait(pauseMs);
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log({ done: true, marks, error, step: i });
        try {
          await shell.hostCall("demo.record", { action: "stop", name: script.name, marks, error });
        } catch {
          // Stopping never fails the run.
        }
        opts?.onDone?.(marks);
        return marks;
      }
    }
    log({ done: true, marks });
    opts?.onDone?.(marks);
    return marks;
  })();
}

function matchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  if (!item || typeof item !== "object") return false;
  for (const [k, v] of Object.entries(where)) {
    const iv = (item as Record<string, unknown>)[k];
    if (iv !== v && JSON.stringify(iv) !== JSON.stringify(v)) return false;
  }
  return true;
}
