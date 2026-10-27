import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { installBuilder } from "../src/builder/index.ts";
import { seedApps, findApp } from "../src/builder/registry.ts";
import { applyPatch } from "../src/builder/patch.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { boot, frame } from "./fake-host.ts";

const load = (n: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${n}.json`, import.meta.url), "utf8"));

/** The shell with the builder, and a model that answers with the scripted replies in order. */
function setup(replies: unknown[]) {
  const shell: AppSpec = {
    id: "shell",
    name: "Shell",
    data: { apps: { type: "list", default: [] }, apiKey: { type: "string", default: "test-key" } },
    state: { log: [], busy: false, prompt: "", selected: null, mode: "board", focus: "" },
    screens: { home: { body: { type: "text", value: "Home" } } },
  };
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  const requests: { messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[] = [];
  host.call = (service, args, done) => {
    if (service === "screenshot") return queueMicrotask(() => done({ data: "PNG" }));
    assert.equal(service, "http");
    requests.push(JSON.parse(String(args.body)));
    const reply = replies.shift();
    queueMicrotask(() => done({ status: 200, body: JSON.stringify({ choices: [{ message: reply }] }) }));
  };
  installBuilder(rt);
  seedApps(rt, [load("chores")]);
  frame(host);
  // Runs frames while the agent works: it waits for frames before taking a screenshot.
  const idle = async () => {
    for (let i = 0; i < 50 && rt.get("busy"); i++) {
      frame(host);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  const edit = (prompt: string) => rt.run({ call: "builder.edit", args: { id: "'chores'", prompt: `'${prompt}'` } }, { lookup: () => undefined, has: () => false });
  return { rt, host, requests, idle, edit };
}

const toolCall = (name: string, args: unknown, id = name) => ({ content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("JSON Patch edits a copy and names the op that failed", () => {
  const doc = { a: [1, 2], b: { c: 1 } };
  assert.deepEqual(applyPatch(doc, [{ op: "add", path: "/a/-", value: 3 }, { op: "replace", path: "/b/c", value: 2 }, { op: "move", from: "/a/0", path: "/d" }]), { a: [2, 3], b: { c: 2 }, d: 1 });
  assert.deepEqual(doc, { a: [1, 2], b: { c: 1 } }, "the original is untouched");
  assert.throws(() => applyPatch(doc, [{ op: "remove", path: "/x/y" }]), /Patch op 0 \(remove \/x\/y\)/);
});

test("validation catches unknown types, bad actions and expressions that don't render", () => {
  const spec = load("chores");
  assert.deepEqual(validateSpec(spec), []);
  const bad = applyPatch(spec, [
    { op: "add", path: "/screens/main/body/children/-", value: { type: "sparkle-button" } },
    { op: "add", path: "/screens/main/body/children/-", value: { type: "button", label: "Go", onTap: { navigate: "nowhere" } } },
    { op: "add", path: "/screens/main/body/children/-", value: { type: "text", value: "{{len(chores) +}}" } },
  ]);
  const errors = validateSpec(bad).join("\n");
  assert.match(errors, /unknown type 'sparkle-button'/);
  assert.match(errors, /no screen named 'nowhere'/);
  assert.match(errors, /value:/);
});

test("an edit applies a patch, repairs a rejected one, and finishes", async () => {
  const { rt, requests, idle, edit } = setup([
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "{{len(chores) +}}" }] }),
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "Today's chores" }] }),
    toolCall("finish", { message: "Renamed the screen." }),
  ]);
  edit("rename the screen");
  await idle();
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Today's chores");
  assert.equal(findApp(rt, "chores")!.history!.length, 1, "one change saved, the rejected one wasn't");
  // The model saw the spec, the view and the request, and the errors of the bad patch.
  assert.match(JSON.stringify(requests[0].messages[1]), /Current spec/);
  assert.match(JSON.stringify(requests[0].messages[1]), /looking at screen \\"main\\"/);
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /Not applied, the spec has errors/);
  assert.deepEqual(requests[0].tools.map((t) => t.function.name), ["apply_patch", "set_spec", "screenshot", "finish"]);
  const log = (rt.get("log") as { role: string; text: string }[]).map((e) => `${e.role}: ${e.text}`);
  assert.deepEqual(log.filter((l) => !l.startsWith("step")), ["user: rename the screen", "model: Renamed the screen."]);
  assert.ok(log.some((l) => l.startsWith("step: Fixing")));
  assert.equal(rt.get("busy"), false);

  // Undo and redo walk the history.
  rt.run({ call: "builder.undo", args: { id: "'chores'" } }, { lookup: () => undefined, has: () => false });
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Chores");
  rt.run({ call: "builder.redo", args: { id: "'chores'" } }, { lookup: () => undefined, has: () => false });
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Today's chores");
});

test("without an API key the builder says what to do", async () => {
  const { rt, idle, edit, requests } = setup([]);
  rt.set("apiKey", "");
  edit("anything");
  await idle();
  assert.equal(requests.length, 0);
  assert.match((rt.get("log") as { text: string }[]).at(-1)!.text, /API key in Settings/);
});

test("services are only for the shell", () => {
  const { rt, host } = boot({ id: "x", name: "X", screens: { a: { body: { type: "button", label: "Go", onTap: { call: "builder.edit", args: {} } } } } });
  rt.run({ call: "builder.edit", args: {} }, { lookup: () => undefined, has: () => false });
  frame(host);
  assert.ok(rt.errors.some((e) => /Only the shell/.test(e.message)));
});

test("the whiteboard lays out screens by navigation depth, with arrows between them", async () => {
  const { flow } = await import("../src/builder/flow.ts");
  const f = flow(load("meds"));
  const at = Object.fromEntries(f.cards.map((c) => [c.screen, c]));
  assert.equal(at.today.x, 40);
  assert.ok(at.med.x > at.today.x && at.med.x === at.add.x, "med and add are one step from today");
  assert.ok(at.add.y > at.med.y);
  assert.equal(at.today.title, "Today");
  assert.equal(at.med.title, "med", "a title with a binding shows the screen's name");
  assert.equal((f.arrows.match(/C/g) ?? []).length, 2, "an arrow per navigate");
  assert.ok(f.width > at.med.x + 156 && f.height > 0);
});

test("the code view marks lines that changed since the previous version", async () => {
  const { jsonLines } = await import("../src/builder/code.ts");
  const lines = jsonLines({ a: 1, b: 2 }, { a: 1, b: 3 });
  assert.deepEqual(lines.map((l) => `${l.kind} ${l.text.trim()}`), ["same {", "same \"a\": 1,", "del \"b\": 3", "add \"b\": 2", "same }"]);
  assert.ok(jsonLines({ a: 1 }).every((l) => l.kind === "same"));
});

test("selecting a node in an app reports its spec path, and builtin internals select their usage", () => {
  const spec = load("chores");
  const { host, rt } = boot(spec);
  let picked: { pointer: string; type: string; text?: string } | null = null;
  rt.onSelect = (info) => (picked = info);
  const text = [...rt.nodes.values()].find((n) => n.props.value === "Make the bed")!;
  rt.dispatch(text.id, "select");
  frame(host);
  assert.equal(picked!.pointer, "/screens/main/body/children/1/row/children/1");
  assert.equal(picked!.text, "Make the bed");
  assert.equal(text.props.selected, true);
  // The check is a builtin component: its circle selects the check itself.
  const circle = [...rt.nodes.values()].find((n) => n.type === "shape" && n.props.path && n.parent?.parent?.path?.endsWith("row"))!;
  rt.dispatch(circle.id, "select");
  frame(host);
  assert.equal(picked!.pointer, "/screens/main/body/children/1/row/children/0");
  assert.equal(text.props.selected, false, "one selection at a time");
});

test("a screenshot of a screen that isn't on display tells the model so, and shows that screen", async () => {
  const { rt, requests, idle, edit } = setup([toolCall("screenshot", { screen: "main" }), toolCall("finish", { message: "Looked." })]);
  edit("check it");
  await idle();
  assert.equal(rt.get("mode"), "screen", "the builder shows the user the screen the model looks at");
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /No screenshot available/);
});
