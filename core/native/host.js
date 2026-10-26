// The JS half of every native host (iOS, Android). It adapts the runtime's `Host`
// interface to a `__native` object the platform installs before this file runs,
// and exposes `__jig*` entry points the platform calls. Plain ES5: no build step.
//
// __native contract:
//   apply(opsJson, navDepth)                    one batch of ops per frame
//   measure(text, size, weight, lineHeight, maxWidth) -> [width, height]
//   measureControl(type) -> [width, height]     [0, 0] means "use the default"
//   requestFrame()                              call __jigFrame() before the next paint
//   storageGet(key) -> string | null, storageSet(key, value)
//   now() -> milliseconds, log(level, message)

var __frameQueue = [];

var host = {
  apply: function (ops) { __native.apply(JSON.stringify(ops), runtime.nav.peek().length); },
  measureText: function (text, s, maxWidth) {
    var r = __native.measure(text, s.fontSize, s.fontWeight, s.lineHeight, maxWidth);
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
  storage: {
    get: function (k) { return __native.storageGet(k); },
    set: function (k, v) { __native.storageSet(k, v); }
  },
  now: function () { return __native.now(); },
  log: function (level, message) { __native.log(level, message); }
};

var runtime = new Jig.Runtime(host);

function __jigFrame() {
  var q = __frameQueue;
  __frameQueue = [];
  for (var i = 0; i < q.length; i++) q[i]();
}
function __jigLoad(json) { runtime.load(JSON.parse(json), { fresh: true }); }
function __jigSetColorScheme(scheme) { runtime.setColorScheme(scheme); }
function __jigSetViewport(width, height, top, right, bottom, left) { runtime.setViewport(width, height, [top, right, bottom, left]); }
function __jigDispatch(id, name, json) { runtime.dispatch(id, name, JSON.parse(json)); }
function __jigBack() { return runtime.back(); }
/** The resolved theme, for native chrome (window background, status bar, switch tint). */
function __jigTheme() { return JSON.stringify({ colors: runtime.theme, dark: runtime.colorScheme === "dark" }); }
