// Custom code (reserved): scripts are stored, never run; `run` answers through
// `script.run` (no host offers it yet) and `custom` shows a placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../src/spec.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import { boot, byText, findNode, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function scriptsApp(extra: Partial<AppSpec> = {}): AppSpec {
  return {
    id: "c",
    name: "C",
    scripts: {
      convert: { doc: "CSV and JSON conversions", code: "export function csvToJson(text) { }", exports: ["csvToJson"], elements: [] },
      charts: { code: "export const x = 1", exports: [], elements: ["barChart"] },
    },
    state: { done: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Go", onTap: { run: "convert.csvToJson", args: { text: "'a,b'" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } },
            { type: "custom", element: "charts.barChart", props: { title: "Sales" }, onEvent: { set: "done", to: "value" } },
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
  ((spec.screens.main.body as unknown as { children: { element: string }[] }).children[1].element = "charts.barChrt");
  const errors = validateSpec(spec).join("\n");
  assert.match(errors, /no script element 'charts\.barChrt'/);
  assert.match(errors, /did you mean 'charts\.barChart'\?/);
});

test("run ends in else while custom code isn't available", async () => {
  const { host, rt } = boot(scriptsApp());
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("err"), "Custom code isn't available yet");
  assert.equal(rt.get("done"), "");
  assert.deepEqual(rt.errors, []);
});

test("run answers then when the host implements script.run", async () => {
  const { host, rt } = boot(scriptsApp());
  const seen: { service: string; args: Record<string, unknown> }[] = [];
  host.call = (service, args, done) => {
    seen.push({ service, args });
    if (service === "script.run") done({ csv: "yes" });
    else done(null, `No '${service}' service`);
  };
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(rt.get("done"), { csv: "yes" });
  assert.equal(rt.get("err"), "");
  assert.equal(seen[0].service, "script.run");
  assert.deepEqual(seen[0].args, { app: "c", script: "convert", fn: "csvToJson", args: { text: "a,b" } });
});

test("custom renders a placeholder with the element's name", () => {
  const { host, rt } = boot(scriptsApp());
  frame(host);
  assert.ok(byText(rt, "charts.barChart"), "the element's name");
  assert.ok(byText(rt, "Custom element (not available yet)"));
  const title = byText(rt, "charts.barChart")!;
  const box = title.parent!;
  const style = box.props.style as Record<string, unknown>;
  assert.equal(style.borderWidth, 1);
  assert.equal(style.radius, 12);
  assert.ok(style.background, "a surface background");
  assert.ok(style.borderColor, "a border color");
  assert.deepEqual(box.box.padding, [12, 12, 12, 12]);
  assert.ok(findNode(rt, (p, t) => t === "custom") === undefined, "no host node, only the placeholder");
});

test("the prompt withholds custom and run until they work", () => {
  const prompt = systemPrompt();
  assert.ok(!prompt.includes("custom"), "no custom node");
  assert.ok(!prompt.includes('"run"'), "no run action");
});

test("a custom placeholder shows a bound element name and still takes onTap", () => {
  const spec = {
    id: "c", name: "C",
    state: { which: "charts.barChart", tapped: false },
    scripts: { charts: { code: "", exports: [], elements: ["barChart"] } },
    screens: { main: { body: { type: "custom", element: "{{which}}", onTap: { set: "tapped", to: "true" } } } },
  };
  const { host, rt } = boot(spec as never);
  assert.ok(byText(rt, "charts.barChart"), "the bound element name is shown");
  const box = findNode(rt, (props, type) => type === "column" && props.tappable === true);
  assert.ok(box, "the placeholder box takes taps");
  rt.dispatch(box!.id, "tap");
  frame(host);
  assert.equal(rt.get("tapped"), true);
});
