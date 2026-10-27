// The JS half of every native host (iOS, Android). It adapts the runtime's `Host`
// interface to a `__native` object the platform installs before this file runs,
// and exposes `__jig*` entry points the platform calls. Plain ES5: no build step.
//
// __native contract:
//   apply(opsJson)                              one batch of ops per frame
//   measure(text, size, weight, lineHeight, maxWidth, family) -> [width, height]   family: "" or "mono"
//   measureControl(type) -> [width, height]     [0, 0] means "use the default"
//   requestFrame()                              call __jigFrame() before the next paint
//   sqlQuery(sql, paramsJson) -> json            {"rows": [...]} or {"error": "..."}
//   sqlExec(statementsJson) -> json              [[sql, params?], ...] in one transaction
//   secretGet(app, key) -> string | null          Keychain / Android Keystore
//   secretSet(app, key, value) -> error | null, secretDelete(app, key) -> error | null
//   secretClear(app) -> error | null
//   now() -> milliseconds, log(level, message)
//   call(service, argsJson, callId)              async: the host answers __jigResolve(callId, json)
//                                                with {"result": ...} or {"error": "..."} on the JS thread

var __frameQueue = [];
var __calls = {};
var __nextCall = 1;

function check(error) {
  if (error) throw new Error(error);
}

function sqlResult(json) {
  var r = JSON.parse(json);
  if (r.error) throw new Error(r.error);
  return r.rows;
}

var host = {
  apply: function (ops) { __native.apply(JSON.stringify(ops)); },
  measureText: function (text, s, maxWidth) {
    var r = __native.measure(text, s.fontSize, s.fontWeight, s.lineHeight, maxWidth, s.fontFamily || "");
    return { width: r[0], height: r[1] };
  },
  measureControl: function (type) {
    var r = __native.measureControl(type);
    return r[0] > 0 ? { width: r[0], height: r[1] } : undefined;
  },
  requestFrame: function (cb) {
    __frameQueue.push(cb);
    if (__frameQueue.length === 1) __native.requestFrame();
  },
  db: {
    query: function (sql, params) { return sqlResult(__native.sqlQuery(sql, JSON.stringify(params || []))); },
    exec: function (statements) { sqlResult(__native.sqlExec(JSON.stringify(statements))); }
  },
  secrets: {
    get: function (app, key) { return __native.secretGet(app, key); },
    set: function (app, key, value) {
      check(value == null ? __native.secretDelete(app, key) : __native.secretSet(app, key, value));
    },
    clear: function (app) { check(__native.secretClear(app)); }
  },
  call: function (service, args, done) {
    var id = __nextCall++;
    __calls[id] = done;
    __native.call(service, JSON.stringify(args || {}), id);
  },
  now: function () { return __native.now(); },
  log: function (level, message) { __native.log(level, message); }
};

// The top-level runtime always runs the shell, which may use the builder's services.
var runtime = new Jig.Runtime(host, { trusted: true });

function __jigFrame() {
  var q = __frameQueue;
  __frameQueue = [];
  for (var i = 0; i < q.length; i++) q[i]();
}
/** Starts the shell, adding the bundled demo apps to its list. */
function __jigBoot(shellJson, seedsJson) {
  Jig.installBuilder(runtime);
  runtime.load(JSON.parse(shellJson), { fresh: true });
  Jig.seedApps(runtime, JSON.parse(seedsJson));
}
/** A host service finished (see call). */
function __jigResolve(id, json) {
  var done = __calls[id];
  delete __calls[id];
  if (!done) return;
  var r = JSON.parse(json);
  done(r.result, r.error);
}
function __jigSetColorScheme(scheme) { runtime.setColorScheme(scheme); }
function __jigSetViewport(width, height, top, right, bottom, left) { runtime.setViewport(width, height, [top, right, bottom, left]); }
function __jigDispatch(id, name, json) { runtime.dispatch(id, name, JSON.parse(json)); }
function __jigBack() { return runtime.back(); }
/** The resolved theme, for native chrome (window background, status bar, switch tint). */
function __jigTheme() { return JSON.stringify({ colors: runtime.theme, dark: runtime.colorScheme === "dark" }); }
