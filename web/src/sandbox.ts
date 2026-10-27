// Custom-code sandbox for the web: one dedicated Web Worker per app, from a blob
// URL. Each script's source loads once per hash; calls time out after 5 s (the
// worker is terminated and recreated), results over 2 MB are refused, and the
// worker's `fetch` only reaches the call's allowed hosts over https.

type Done = (result: unknown, error?: string) => void;

const TIMEOUT_MS = 5000;
const MAX_RESULT = 2 * 1024 * 1024;

interface Pending {
  done: Done;
  timer: number;
  render: boolean;
}

interface AppBox {
  app: string;
  worker: Worker;
  seq: number;
  pending: Map<number, Pending>;
}

const boxes = new Map<string, AppBox>();

const WORKER_SRC = `
var scripts = {};
var currentAllow = [];
var queue = [];
var busy = false;
function namespacedConsole(app) {
  return { log: function() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      try { parts.push(typeof arguments[i] === "string" ? arguments[i] : JSON.stringify(arguments[i])); }
      catch (e) { parts.push("[unserializable]"); }
    }
    postMessage({ log: parts.join(" ") });
  } };
}
function restrictedFetch(url, init) {
  var raw = typeof url === "string" ? url : (url && url.url) || "";
  var host = "";
  var proto = "";
  try {
    var u = new URL(raw, "https://x.invalid");
    host = u.host.toLowerCase().replace(/:\\d+$/, "");
    proto = u.protocol;
  } catch (e) { host = ""; }
  var bare = host.split(":")[0];
  if (proto !== "https:" || currentAllow.indexOf(bare) < 0) {
    return Promise.reject(new Error("Network access to " + (bare || raw) + " isn't allowed"));
  }
  return fetch(url, init);
}
function loadScript(script, hash, code, allow) {
  var hit = scripts[script];
  if (hit && hit.hash === hash) { hit.allow = allow; return; }
  var exports = {};
  var run = new Function("exports", "fetch", "console", code + "\\n;return exports;");
  var out = run(exports, restrictedFetch, namespacedConsole());
  scripts[script] = { hash: hash, exports: out || exports, allow: allow };
}
function pump() {
  if (busy) return;
  var job = queue.shift();
  if (!job) return;
  busy = true;
  var finish = function(ok, result) {
    busy = false;
    if (ok) {
      var json = "";
      try { json = JSON.stringify(result === undefined ? null : result); }
      catch (e) { postMessage({ id: job.id, ok: false, error: "Result too large" }); pump(); return; }
      if (json.length > ${MAX_RESULT}) postMessage({ id: job.id, ok: false, error: "Result too large" });
      else postMessage({ id: job.id, ok: true, result: result === undefined ? null : result });
    } else {
      postMessage({ id: job.id, ok: false, error: result });
    }
    pump();
  };
  try {
    loadScript(job.script, job.hash, job.code, job.allow);
  } catch (e) {
    finish(false, (e && e.message) || String(e));
    return;
  }
  var entry = scripts[job.script];
  var fn = entry && entry.exports && entry.exports[job.name];
  if (typeof fn !== "function") {
    finish(false, job.render ? ("No element '" + job.name + "'") : ("No export '" + job.name + "'"));
    return;
  }
  currentAllow = entry.allow || [];
  var out;
  try {
    out = fn(job.input);
  } catch (e) {
    currentAllow = [];
    finish(false, (e && e.message) || String(e));
    return;
  }
  Promise.resolve(out).then(function(v) {
    currentAllow = [];
    finish(true, v);
  }, function(e) {
    currentAllow = [];
    finish(false, (e && e.message) || String(e));
  });
}
onmessage = function(e) {
  var m = e.data || {};
  queue.push(m);
  pump();
};
`;

function boxFor(app: string): AppBox {
  let box = boxes.get(app);
  if (!box) {
    box = { app, worker: spawn(app, undefined), seq: 0, pending: new Map() };
    boxes.set(app, box);
  }
  return box;
}

function spawn(app: string, old: AppBox | undefined): Worker {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
  const worker = new Worker(url);
  worker.onmessage = (e) => onWorkerMessage(app, e.data);
  if (old) {
    // A timed-out worker is replaced: pending calls already failed, loaded scripts reload on demand.
    try {
      old.worker.terminate();
    } catch {
      // Replacing never fails.
    }
    old.worker = worker;
  }
  return worker;
}

function onWorkerMessage(app: string, msg: { id?: number; ok?: boolean; result?: unknown; error?: string; log?: string }): void {
  const box = boxes.get(app);
  if (msg && typeof msg.log === "string") {
    console.log("[" + app + "]", msg.log);
    return;
  }
  if (!box || msg.id == null) return;
  const p = box.pending.get(msg.id);
  if (!p) return;
  box.pending.delete(msg.id);
  window.clearTimeout(p.timer);
  if (msg.ok) p.done(p.render ? { tree: msg.result } : { value: msg.result });
  else p.done(null, msg.error || "Failed");
}

function call(op: "run" | "render", args: Record<string, unknown>, done: Done): void {
  const app = String(args.app ?? "");
  const script = String(args.script ?? "");
  const hash = String(args.hash ?? "");
  const code = typeof args.code === "string" ? args.code : "";
  const name = op === "run" ? String(args.fn ?? "") : String(args.element ?? "");
  const input = (op === "run" ? args.args : args.props) ?? {};
  const allow = (((args.network as { allow?: unknown } | undefined)?.allow as unknown[]) ?? []).filter((h): h is string => typeof h === "string");
  if (!app) {
    done(null, "No app");
    return;
  }
  const box = boxFor(app);
  const id = ++box.seq;
  const timer = window.setTimeout(() => {
    // The 5 s limit: terminate and recreate the worker; the call times out.
    if (!box.pending.has(id)) return;
    box.pending.delete(id);
    // The worker is gone, so every other pending call on it fails at once.
    for (const [otherId, other] of [...box.pending]) {
      box.pending.delete(otherId);
      window.clearTimeout(other.timer);
      other.done(null, "Sandbox restarted");
    }
    box.worker = spawn(app, box);
    done(null, "Timed out");
  }, TIMEOUT_MS);
  box.pending.set(id, { done, timer, render: op === "render" });
  try {
    box.worker.postMessage({ id, script, hash, code, name, input, allow, render: op === "render" });
  } catch (e) {
    box.pending.delete(id);
    window.clearTimeout(timer);
    done(null, (e as Error).message);
  }
}

/** Answers `script.run` / `script.render` / `script.close` from services.ts. */
export function sandboxCall(service: string, args: Record<string, unknown>, done: Done): boolean {
  if (service === "script.run") {
    call("run", args, done);
    return true;
  }
  if (service === "script.render") {
    call("render", args, done);
    return true;
  }
  if (service === "script.close") {
    const app = String(args.app ?? "");
    const box = boxes.get(app);
    if (box) {
      boxes.delete(app);
      try {
        box.worker.terminate();
      } catch {
        // Closing never fails.
      }
    }
    done({});
    return true;
  }
  return false;
}
