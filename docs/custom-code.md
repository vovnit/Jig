# Custom code

Apps stay JSON specs. Custom code is for what the spec's expressions can't do: converting file formats, parsing, math with a library, calling a web API. An app's code lives in its `scripts`, runs in a sandbox of its own, and reaches nothing the user hasn't allowed. The UI is still the spec: code computes values (`run`) and builds node trees for `custom` elements, which the runtime validates and draws natively.

## In the spec

```json
"scripts": {
  "convert": {
    "doc": "CSV, JSON and YAML conversions",
    "code": "exports.csvToJson = (text) => JSON.stringify(Papa.parse(text, {header: true}).data, null, 2);",
    "exports": ["csvToJson"],
    "elements": [],
    "libraries": [{"name": "papaparse", "url": "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", "sha256": "…"}],
    "network": []
  },
  "charts": {
    "code": "exports.bars = (props) => ({type: 'row', style: {gap: 4, align: 'end', height: 120}, children: props.values.map(v => ({type: 'column', style: {width: 18, height: v * 1.2, background: 'accent', radius: 4}}))});",
    "exports": [],
    "elements": ["bars"]
  }
}
```

- `code`: plain JavaScript, a script, not a module. It defines its exports on a global `exports` object (`exports.name = ...`). Functions may return a value or a Promise.
- `libraries`: browser builds (UMD or IIFE) loaded before `code`, in order. Each one is pinned when the app is built: an exact-version URL on `cdn.jsdelivr.net/npm/` or `unpkg.com`, its SHA-256, and its source, stored in the app (see Libraries). At run time nothing is fetched.
- `network`: hostnames the code may `fetch` from (exact names, https only). Empty by default: no network.

Calls:
- `{"run": "convert.csvToJson", "args": {"text": "..."}, "then": [...], "else": [...]}`: `args` is evaluated, then passed as the function's single argument (an object). Its result (JSON-serializable) is `value` in `then`; an exception or time-out is `error` in `else`.
- `{"type": "custom", "element": "charts.bars", "props": {"values": "{{...}}"}, "onEvent": [...]}`: the element's function gets the evaluated `props` and returns a node tree, in the spec's own format. The runtime validates it like any spec node (the same schema), then draws it. When the props change, the function runs again (at most once per frame; a slower answer than the next change is dropped). Until the first answer the placeholder shows; an invalid tree or an error shows a small error box.
  - Inside a rendered tree, `{"emit": expr}` is an extra action: it runs the element's `onEvent` with `value` = the evaluated expression. The tree's other actions work as usual, in the element's scope (the app's data and state are not visible to the element's code, but its tree's bindings see `props`).

## The sandbox

One sandbox per app, created on first use, kept while the app is open, and dropped when it closes (or after 2 minutes unused).

| | Web | iOS | Android |
| --- | --- | --- | --- |
| Where | a dedicated Web Worker (blob URL) | a hidden `WKWebView` (its own WebContent process) | a hidden `android.webkit.WebView` (its own renderer process on API 26+) |
| Load | `importScripts` of blob URLs | `loadHTMLString` of a blank page, then `evaluateJavaScript` | `loadDataWithBaseURL`, then `evaluateJavascript` |
| Messages | `postMessage` | `callAsyncJavaScript` (returns the Promise's value) / `WKScriptMessageHandler` | `evaluateJavascript` + a `WebMessagePort` (`createWebMessageChannel`) |
| Network | blocked unless allowed: the worker's `fetch` is replaced by one that only reaches the allowed hosts | a Content-Security-Policy `connect-src` with exactly the allowed hosts (else `'none'`), `default-src 'none'`; a `WKContentRuleList` blocking every other load | the same CSP in the page; `shouldInterceptRequest` denies anything else |
| Time limit | 5 s per call: the worker is terminated and recreated | 5 s: the web view is torn down and recreated | 5 s: the web view is destroyed and recreated |

- Inside, the code sees a small, fixed global surface besides the language and the libraries: `exports`, `fetch` (restricted as above), `TextEncoder` / `TextDecoder`, `atob` / `btoa`, `crypto.subtle` and `crypto.getRandomValues`, `setTimeout`, `console` (to the builder log). No DOM use is guaranteed (web views have one, the worker doesn't), so code and libraries must not rely on it.
- Data crosses the boundary as JSON only. Results over 2 MB are refused.
- Files: code gets no file system. An app passes file contents in `args` (e.g. after `readFile`), and gets text or base64 back to store with `files.write` actions (Phase E).

## Host contract

The runtime calls the host service:
- `script.run {app, script, fn, args, code, hash, network, timeoutMs}` → `{value}` or error. `code` is the sandbox's full source for that script: the libraries' sources, then the script's `code`, as one string; `hash` identifies it, so the host keeps an already-loaded script (`{app, script, hash}`) instead of loading it again. `network` is `{allow: ["host", ...]}`, already granted by the user (empty: no network). Errors the host answers: the exception's message, "Timed out", "Result too large".
- `script.render {app, script, element, props, code, hash, network, timeoutMs}` → `{tree}` (the node tree, unvalidated: the runtime validates).
- `script.close {app}`: drop the app's sandbox.

## Permissions

- `network` is a capability that asks, per app and host list: "<App> wants to connect to <hosts>." Declaring `network` in a script and nothing else is enough; the runtime asks before the first `run` or render that loads that script.
- Running code without network needs no permission: it can't reach anything.

## Libraries

- The builder pins libraries: a model tool `add_library {script, name, url}` (url: an exact version on jsdelivr or unpkg, e.g. `https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js`). The shell downloads it with its `http` service, refuses anything over 512 KB or not JavaScript, computes the SHA-256 (in core JS), and stores `{name, url, sha256, code}` in the script. A stored library whose source doesn't match its hash is refused at load.
- The model never sees library sources: the spec it's shown lists them as `{name, url, size}`.

## The builder

- A tool `set_script {name, exports, elements, doc}`, with the code written in the message as one ```js block (like `set_spec`'s ```json block), so code isn't escaped inside JSON.
- A tool `test_script {script, fn, args}` / `{script, element, props}` that runs it in the app's sandbox and returns the result or error, so the model can check its code before finishing.
- The prompt documents `scripts`, `run`, `custom`, `emit`, `network`, `add_library`, and the rule: use expressions and the built-in actions when they're enough; use code only for what they can't do.
