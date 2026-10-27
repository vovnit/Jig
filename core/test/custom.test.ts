// Custom code: scripts run in the host sandbox (`run`) and draw native UI
// (`custom`), with pinned libraries, a network gate and builder tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../src/spec.ts";
import { sha256Hex } from "../src/sha256.ts";
import { modelSpec } from "../src/builder/agent.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import { boot, byText, findNode, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Frames, microtasks and the sandbox's answers, until a custom render settles. */
async function settle(host: { pending: (() => void)[] }, rounds = 5): Promise<void> {
  const h = host as unknown as Parameters<typeof frame>[0];
  for (let i = 0; i < rounds; i++) {
    frame(h);
    await tick();
  }
  frame(h);
}

function scriptsApp(extra: Partial<AppSpec> = {}): AppSpec {
  return {
    id: "c",
    name: "C",
    scripts: {
      convert: { doc: "CSV and JSON conversions", code: "exports.csvToJson = (args) => args;", exports: ["csvToJson"], elements: [] },
      charts: { code: "exports.bars = (props) => ({type: 'text', value: 'bars ' + props.values.length});", exports: [], elements: ["bars"] },
    },
    state: { done: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Go", onTap: { run: "convert.csvToJson", args: { text: "'a,b'" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } },
            { type: "custom", element: "charts.bars", props: { values: "[1, 2, 3]" }, onEvent: { set: "done", to: "value" } },
          ],
        },
      },
    },
    ...extra,
  } as AppSpec;
}

test("schema accepts scripts, run and custom", () => {
  assert.deepEqual(validateSpec(scriptsApp()), []);
});

test("validation names an unknown export, with what was meant", () => {
  const spec = scriptsApp();
  ((spec.screens.main.body as unknown as { children: { onTap: { run: string } }[] }).children[0].onTap.run = "convert.csvToJsn");
  const errors = validateSpec(spec).join("\n");
  assert.match(errors, /no script export 'convert\.csvToJsn'/);
  assert.match(errors, /did you mean 'convert\.csvToJson'\?/);
});

test("validation names an unknown element, with what was meant", () => {
  const spec = scriptsApp();
  ((spec.screens.main.body as unknown as { children: { element: string }[] }).children[1].element = "charts.barz");
  const errors = validateSpec(spec).join("\n");
  assert.match(errors, /no script element 'charts\.barz'/);
  assert.match(errors, /did you mean 'charts\.bars'\?/);
});

test("validation pins libraries and hostnames", () => {
  const spec = scriptsApp();
  spec.scripts!.convert.libraries = [
    { name: " Papa ", url: "http://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", sha256: "x" },
    { name: "yaml", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  ];
  spec.scripts!.convert.network = ["https://api.example.com"];
  const errors = validateSpec(spec).join("\n");
  assert.match(errors, /libraries\[0\]\.url: must be an https URL/);
  assert.match(errors, /libraries\[0\]\.sha256: must be a hex SHA-256/);
  assert.match(errors, /network\[0\]: must be a plain hostname/);
  const good = scriptsApp();
  good.scripts!.convert.libraries = [
    { name: "yaml", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", code: "" },
  ];
  good.scripts!.convert.network = ["api.example.com"];
  assert.deepEqual(validateSpec(good), []);
});

test("run reaches the host with code, hash and network, and answers then", async () => {
  const { host, rt } = boot(scriptsApp());
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(rt.get("done"), { text: "a,b" });
  assert.equal(rt.get("err"), "");
  const call = host.calls.find((c) => c.service === "script.run")!;
  assert.ok(call, "script.run reached the host");
  const args = call.args as Record<string, unknown>;
  assert.equal(args.app, "c");
  assert.equal(args.script, "convert");
  assert.equal(args.fn, "csvToJson");
  assert.deepEqual(args.args, { text: "a,b" });
  assert.match(String(args.code), /csvToJson/);
  assert.match(String(args.hash), /^[0-9a-f]{8}$/);
  assert.deepEqual(args.network, { allow: [] });
  assert.equal(args.timeoutMs, 5000);
  // The hash is stable: the custom render of the same boot used the same source shape.
  const again = host.calls.filter((c) => c.service === "script.run");
  assert.ok(again.every((c) => (c.args as Record<string, unknown>).hash === args.hash));
});

test("run answers else on an error, and on a time-out", async () => {
  const spec = scriptsApp();
  spec.scripts!.convert.code = "exports.csvToJson = (args) => { throw new Error('bad input'); };";
  const { host, rt } = boot(spec);
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.equal(rt.get("err"), "bad input");

  // A host time-out answers else too.
  const slow = boot(scriptsApp());
  const orig = slow.host.call!.bind(slow.host);
  slow.host.call = ((service: string, args: Record<string, unknown>, done: (r: unknown, e?: string) => void, progress?: (u: Record<string, unknown>) => void) =>
    service === "script.run" ? done(null, "Timed out") : orig(service, args, done, progress)) as typeof slow.host.call;
  await settle(slow.host);
  slow.rt.dispatch(byText(slow.rt, "Go")!.id, "tap");
  await settle(slow.host);
  assert.equal(slow.rt.get("err"), "Timed out");
});

test("network asks once per app and host list", async () => {
  const spec = scriptsApp();
  spec.scripts!.convert.network = ["api.example.com"];
  const gates: string[] = [];
  const { host, rt } = boot(spec, undefined, undefined, { gate: (_app, cap) => (gates.push(cap), true) });
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(gates, ["network:api.example.com"]);
  const call = host.calls.find((c) => c.service === "script.run")!;
  assert.deepEqual((call.args as Record<string, unknown>).network, { allow: ["api.example.com"] });
  assert.deepEqual(rt.get("done"), { text: "a,b" });
});

test("a denied network runs else with Not allowed", async () => {
  const spec = scriptsApp();
  spec.scripts!.convert.network = ["api.example.com"];
  const { host, rt } = boot(spec, undefined, undefined, { gate: () => false });
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.equal(rt.get("err"), "Not allowed");
  assert.ok(!host.calls.some((c) => c.service === "script.run"), "denied code never reaches the host");
});

test("a rendered tree is drawn, and re-rendered when the props change", async () => {
  const spec = scriptsApp();
  spec.state = { done: "", err: "", n: 3 };
  ((spec.screens.main.body as unknown as { children: { props: Record<string, unknown> }[] }).children[1].props = { values: "range(n)" });
  const { host, rt } = boot(spec);
  await settle(host);
  assert.ok(byText(rt, "bars 3"), "the element's tree draws");
  assert.ok(!byText(rt, "Loading…"), "the placeholder is gone");
  rt.set("n", 5);
  await settle(host);
  assert.ok(byText(rt, "bars 5"), "new props re-render");
});

test("an invalid tree shows the error box", async () => {
  const spec = scriptsApp();
  spec.scripts!.charts.code = "exports.bars = (props) => ({type: 'nope'});";
  const { host, rt } = boot(spec);
  await settle(host);
  assert.ok(findNode(rt, (p) => typeof p.value === "string" && p.value.includes("unknown type 'nope'")), "a muted caption with the message");
  assert.ok(!byText(rt, "Loading…"));
  assert.deepEqual(rt.errors, [], "the failure shows in the box, not the log");
});

test("renders coalesce to one call per frame, and older answers are dropped", async () => {
  const spec = scriptsApp();
  spec.state = { done: "", err: "", n: 3 };
  ((spec.screens.main.body as unknown as { children: { props: Record<string, unknown> }[] }).children[1].props = { values: "range(n)" });
  const { host, rt } = boot(spec);
  await settle(host);
  assert.ok(byText(rt, "bars 3"));
  const renders = () => host.calls.filter((c) => c.service === "script.render").length;
  assert.equal(renders(), 1, "the initial render");

  // Two changes before the frame goes out: one host call, with the latest props.
  rt.set("n", 4);
  rt.set("n", 5);
  frame(host);
  await tick();
  await tick();
  assert.equal(renders(), 2, "at most one render per frame");
  const last = host.calls.filter((c) => c.service === "script.render").at(-1)!;
  assert.deepEqual((last.args as Record<string, unknown>).props, { values: [0, 1, 2, 3, 4] });
  await settle(host);
  assert.ok(byText(rt, "bars 5"));

  // An answer older than the latest request is dropped.
  const orig = host.call!.bind(host);
  const captured: { done: (r: unknown, e?: string) => void }[] = [];
  host.call = ((service: string, args: Record<string, unknown>, done: (r: unknown, e?: string) => void, progress?: (u: Record<string, unknown>) => void) => {
    if (service === "script.render") captured.push({ done });
    else orig(service, args, done, progress);
  }) as typeof host.call;
  rt.set("n", 6);
  frame(host);
  await tick();
  rt.set("n", 7);
  frame(host);
  await tick();
  assert.equal(captured.length, 2);
  captured[1].done({ tree: { type: "text", value: "new" } });
  await settle(host);
  assert.ok(byText(rt, "new"));
  captured[0].done({ tree: { type: "text", value: "stale" } });
  await settle(host);
  assert.ok(byText(rt, "new"), "the stale answer didn't draw");
  assert.ok(!byText(rt, "stale"));
});

test("emit runs the element's onEvent with value", async () => {
  const spec: AppSpec = {
    id: "c",
    name: "C",
    scripts: {
      charts: {
        code: "exports.bars = (props) => ({type: 'button', label: 'bar', onTap: {emit: 'props.i'}});",
        exports: [],
        elements: ["bars"],
      },
    },
    state: { picked: "" },
    screens: {
      main: { body: { type: "custom", element: "charts.bars", props: { i: "7" }, onEvent: { set: "picked", to: "value" } } },
    },
  };
  const { host, rt } = boot(spec);
  await settle(host);
  const bar = byText(rt, "bar")!;
  rt.dispatch(bar.id, "tap");
  frame(host);
  assert.equal(rt.get("picked"), 7, "the tapped bar's value reaches onEvent");
});

test("a library whose source doesn't match is refused", async () => {
  const spec = scriptsApp();
  spec.scripts!.convert.libraries = [{
    name: "csv",
    url: "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    code: "exports.csvToJson = () => ({});",
  }];
  const { host, rt } = boot(spec);
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.equal(rt.get("err"), "A library was changed: csv");
  assert.ok(!host.calls.some((c) => c.service === "script.run"), "changed code never reaches the host");
});

test("script.close goes out when the app is disposed", async () => {
  const { host, rt } = boot(scriptsApp());
  await settle(host);
  rt.dispose();
  assert.ok(host.calls.some((c) => c.service === "script.close" && (c.args as Record<string, unknown>).app === "c"));
});

test("SHA-256 matches the known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("the prompt documents custom code", () => {
  const prompt = systemPrompt();
  assert.ok(prompt.includes("custom"), "the custom node");
  assert.ok(prompt.includes('"run"'), "the run action");
  assert.ok(prompt.includes("set_script"), "set_script");
  assert.ok(prompt.includes("add_library"), "add_library");
  assert.ok(prompt.includes("test_script"), "test_script");
  assert.ok(prompt.includes("emit"), "emit");
});

test("the model's context hides library code, keeping its size", () => {
  const spec = scriptsApp();
  spec.scripts!.convert.libraries = [{
    name: "csv",
    url: "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    code: "var secret = 1;",
  }];
  const shown = modelSpec(spec).scripts!.convert.libraries as unknown as { name: string; url: string; size: number; code?: string }[];
  assert.deepEqual(shown, [{ name: "csv", url: "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", size: 15 }]);
  assert.ok(!JSON.stringify(shown).includes("secret"), "no source in the model's context");
});

test("a custom placeholder shows a bound element name and still takes onTap", async () => {
  const spec = {
    id: "c", name: "C",
    state: { which: "charts.barChart", tapped: false },
    scripts: { charts: { code: "", exports: [], elements: ["barChart"] } },
    screens: { main: { body: { type: "custom", element: "{{which}}", onTap: { set: "tapped", to: "true" } } } },
  };
  const { host, rt } = boot(spec as never);
  await settle(host);
  // No element function: the error box names the problem, and taps still work.
  const box = findNode(rt, (props, type) => type === "column" && props.tappable === true);
  assert.ok(box, "the custom box takes taps");
  rt.dispatch(box!.id, "tap");
  frame(host);
  assert.equal(rt.get("tapped"), true);
});

test("the placeholder keeps the element name above a Loading caption", async () => {
  const spec = scriptsApp();
  spec.scripts!.charts.code = "exports.bars = (props) => ({type: 'text', value: 'bars'});";
  const { host, rt } = boot(spec);
  // Before the sandbox answers: the element name above a muted Loading caption.
  assert.ok(byText(rt, "charts.bars"), "the element name stays above the placeholder");
  assert.ok(byText(rt, "Loading…"), "the placeholder says Loading");
  await settle(host);
  assert.ok(byText(rt, "bars"), "the rendered tree replaces the placeholder");
  assert.ok(!byText(rt, "Loading…"), "the placeholder is gone");
});

test("a rendered tree sees props but not the app's state", async () => {
  const spec: AppSpec = {
    id: "c",
    name: "C",
    scripts: {
      charts: {
        code: "exports.bars = (props) => ({type: 'text', value: 'x'});",
        exports: [],
        elements: ["bars"],
      },
    },
    state: { secret: "shh" },
    screens: {
      main: { body: { type: "custom", element: "charts.bars", props: { i: "7" } } },
    },
  };
  // The tree binds {{secret}} (app state) and {{props.i}} (its props).
  spec.scripts!.charts.code = "exports.bars = (props) => ({type: 'text', value: '{{secret}}|{{props.i}}'});";
  const { host, rt } = boot(spec);
  await settle(host);
  const node = findNode(rt, (p) => typeof p.value === "string" && p.value.includes("|"));
  assert.ok(node, "the rendered tree draws");
  assert.equal(node!.props.value, "|7", "app state is not visible, props are");
});

test("emit with an object evaluates it like an action value", async () => {
  const spec: AppSpec = {
    id: "c",
    name: "C",
    scripts: {
      charts: {
        code: "exports.bars = (props) => ({type: 'button', label: 'bar', onTap: {emit: {i: 'props.i'}}});",
        exports: [],
        elements: ["bars"],
      },
    },
    state: { picked: 0 },
    screens: {
      main: { body: { type: "custom", element: "charts.bars", props: { i: "7" }, onEvent: { set: "picked", to: "value.i" } } },
    },
  };
  const { host, rt } = boot(spec);
  await settle(host);
  rt.dispatch(byText(rt, "bar")!.id, "tap");
  frame(host);
  assert.equal(rt.get("picked"), 7, "the object form passes evaluated values");
});

test("a library without code is refused", async () => {
  for (const libraries of [
    [{ name: "csv", url: "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
    [{ name: "csv", url: "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", code: "" }],
  ]) {
    const spec = scriptsApp();
    spec.scripts!.convert.libraries = libraries as never;
    const { host, rt } = boot(spec);
    await settle(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    await settle(host);
    assert.equal(rt.get("err"), "A library was changed: csv");
    assert.ok(!host.calls.some((c) => c.service === "script.run"), "missing code never reaches the host");
  }
});

test("network grants are per app: another app with the same hosts asks again", async () => {
  const appA = scriptsApp();
  appA.id = "a";
  appA.scripts!.convert.network = ["api.example.com"];
  const appB = scriptsApp();
  appB.id = "b";
  appB.scripts!.convert.network = ["api.example.com"];
  const gates: string[] = [];
  const { host, rt } = boot(appA, undefined, undefined, { gate: (app, cap) => (gates.push(`${app.id} ${cap}`), true) });
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(gates, ["a network:api.example.com"]);
  // The same app doesn't ask twice.
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(gates, ["a network:api.example.com"]);
  // Loading a different app clears the grant: it asks again for the same hosts.
  rt.load(appB);
  frame(host);
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(gates, ["a network:api.example.com", "b network:api.example.com"]);
  // Disposing clears too: the next app asks again.
  rt.dispose();
  rt.load(appA, { fresh: true });
  frame(host);
  await settle(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await settle(host);
  assert.deepEqual(gates, ["a network:api.example.com", "b network:api.example.com", "a network:api.example.com"]);
});
