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
    data: { apps: { type: "list", default: [] }, apiKey: { type: "string", default: "test-key" }, icons: { type: "boolean", default: false } },
    state: { log: [], busy: false, prompt: "", selected: null, mode: "board", focus: "", recording: false, status: "" },
    screens: { home: { body: { type: "text", value: "Home" } } },
  };
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  const requests: { url: string; input: { type?: string; output?: string; content?: unknown }[]; tools: { name: string; parameters: { properties: Record<string, { $ref?: string }>; $defs?: Record<string, unknown> } }[]; previous_response_id?: string }[] = [];
  let n = 0;
  host.call = (service, args, done, progress) => {
    if (service === "screenshot") return queueMicrotask(() => done({ data: "PNG" }));
    if (service === "audio.start") return queueMicrotask(() => done({}));
    if (service === "audio.stop") return queueMicrotask(() => done({ data: "WAV" }));
    assert.equal(service, "http");
    requests.push({ url: String(args.url), ...JSON.parse(String(args.body)) });
    const reply = replies.shift() as { output?: unknown; thought?: string };
    // A transcription is answered whole; an edit step streams its events, as the API does.
    if (!args.stream) return queueMicrotask(() => done({ status: 200, body: JSON.stringify(reply) }));
    const response = { id: `resp_${++n}`, output: (reply as { output: unknown[] }).output };
    const events = [
      ...(reply.thought ? [
        { type: "response.reasoning_summary_part.added", item_id: "rs", summary_index: 0 },
        { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: reply.thought.slice(0, 5) },
        { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: reply.thought.slice(5) },
      ] : []),
      { type: "response.completed", response },
    ];
    queueMicrotask(() => {
      for (const e of events) progress!({ line: `data: ${JSON.stringify(e)}` });
      done({ status: 200, body: "" });
    });
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

/** What the agent told the model its last tool call did. */
const lastOutput = (req: { input: { type?: string; output?: string }[] }) => String(req.input.filter((i) => i.type === "function_call_output").at(-1)?.output);

/** A model step that calls one tool, optionally with a reasoning summary first. */
const toolCall = (name: string, args: unknown, thought?: string) => ({ thought, output: [{ type: "function_call", call_id: `call_${name}`, name, arguments: JSON.stringify(args) }] });

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
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "{{len(chores) +}}" }] }, "Renaming the main screen."),
    // An object argument sent as JSON text is taken too.
    toolCall("apply_patch", { patch: JSON.stringify([{ op: "replace", path: "/screens/main/title", value: "Today's chores" }]) }),
    toolCall("finish", { message: "Renamed the screen." }),
  ]);
  edit("rename the screen");
  await idle();
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Today's chores");
  assert.equal(findApp(rt, "chores")!.history!.length, 1, "one change saved, the rejected one wasn't");
  // The model saw the spec, the view and the request, and the errors of the bad patch.
  assert.match(JSON.stringify(requests[0].input[0]), /Current spec/);
  assert.match(JSON.stringify(requests[0].input[0]), /looking at screen \\"main\\"/);
  // Each step sends the conversation so far: the request, the model's calls, their results.
  assert.match(JSON.stringify(requests[1].input[0]), /Current spec/);
  assert.equal(requests[1].input[1].type, "function_call");
  assert.match(lastOutput(requests[1]), /Not applied, the spec has errors/);
  assert.deepEqual(requests[0].tools.map((t) => t.name), ["apply_patch", "set_spec", "screenshot", "set_script", "add_library", "test_script", "finish"]);
  // The tools that write specs carry the spec's JSON Schema.
  const params = (name: string) => requests[0].tools.find((t) => t.name === name)!.parameters;
  assert.equal(params("set_spec").properties.spec.$ref, "#/$defs/app");
  assert.ok(params("set_spec").$defs?.node, "set_spec carries the schema");
  assert.equal(params("apply_patch").$defs, undefined, "apply_patch points at it instead of sending it twice");
  const log = (rt.get("log") as { role: string; text: string }[]).map((e) => `${e.role}: ${e.text}`);
  assert.deepEqual(log.filter((l) => !l.startsWith("step")), ["user: rename the screen", "thought: Renaming the main screen.", "model: Renamed the screen."]);
  assert.ok(log.some((l) => l.startsWith("step: Fixing")));
  assert.equal(rt.get("busy"), false);

  // Undo and redo walk the history.
  rt.run({ call: "builder.undo", args: { id: "'chores'" } }, { lookup: () => undefined, has: () => false });
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Chores");
  rt.run({ call: "builder.redo", args: { id: "'chores'" } }, { lookup: () => undefined, has: () => false });
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Today's chores");
});

test("a spoken request is transcribed, shown, then edited like a typed one", async () => {
  const { rt, requests, idle } = setup([
    { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Rename the screen to Today's chores" }] }] },
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "Today's chores" }] }),
    toolCall("finish", { message: "Renamed the screen." }),
  ]);
  const scope = { lookup: () => undefined, has: () => false };
  rt.run({ call: "builder.voiceStart" }, scope);
  await idle();
  assert.equal(rt.get("recording"), true);
  rt.run({ call: "builder.voiceStop", args: { id: "'chores'" } }, scope);
  await new Promise((r) => setTimeout(r, 1));
  await idle();
  assert.match(requests[0].url, /\/responses$/);
  assert.match(JSON.stringify(requests[0].input), /data:audio\/wav;base64,WAV/);
  assert.match(requests[1].url, /\/responses$/);
  assert.match(JSON.stringify(requests[1].input[0]), /Request: Rename the screen to Today's chores/);
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Today's chores");
  const log = (rt.get("log") as { role: string; text: string }[]).filter((e) => e.role !== "step").map((e) => `${e.role}: ${e.text}`);
  assert.deepEqual(log, ["user: “Rename the screen to Today's chores”", "model: Renamed the screen."]);
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
  assert.match(lastOutput(requests[1]), /No screenshot available/);
});

test("an app is built in steps: a link to a screen not written yet applies, but the model can't finish with it", async () => {
  const button = { type: "button", label: "Help", onTap: { navigate: "help" } };
  const { rt, requests, idle, edit } = setup([
    toolCall("apply_patch", { patch: [{ op: "add", path: "/screens/main/body/children/-", value: button }] }),
    toolCall("finish", { message: "Added help." }),
    toolCall("apply_patch", { patch: [{ op: "add", path: "/screens/help", value: { title: "Help", body: { type: "text", value: "Tap a chore." } } }] }),
    toolCall("finish", { message: "Added help." }),
  ]);
  edit("add a help screen");
  await idle();
  assert.match(lastOutput(requests[1]), /Applied.*Still to do before you finish:\n.*no screen named 'help' yet/s);
  assert.match(lastOutput(requests[2]), /Not finished: the app isn't complete yet/);
  assert.ok(findApp(rt, "chores")!.spec.screens.help);
  assert.equal((rt.get("log") as { text: string }[]).at(-1)!.text, "Added help.");
});

/** A model step that writes a spec in its message, then calls set_spec without arguments. */
const writeSpec = (json: string) => ({ output: [
  { type: "message", content: [{ type: "output_text", text: `Rewriting it.\n\n\`\`\`json\n${json}\n\`\`\`` }] },
  { type: "function_call", call_id: "call_set", name: "set_spec", arguments: "{}" },
] });

test("a whole spec is written as a json block in the message, and broken JSON gets an error that says where", async () => {
  const good = { id: "chores", name: "Chores", screens: { main: { title: "Rewritten", body: { type: "text", value: "Hi" } } } };
  const { rt, requests, idle, edit } = setup([
    writeSpec('{"id": "chores", "name": "Chores", "screens": {"main": {"body": {"type": "text"}}}}}'),
    writeSpec(JSON.stringify(good)),
    toolCall("finish", { message: "Rewrote it." }),
  ]);
  edit("rewrite it");
  await idle();
  const result = lastOutput(requests[1]);
  assert.match(result, /The spec isn't valid JSON/);
  assert.match(result, /⟨here⟩\}/);
  assert.equal(findApp(rt, "chores")!.spec.screens.main.title, "Rewritten");
  // The log shows what the model said, not the spec it wrote.
  const log = (rt.get("log") as { role: string; text: string }[]).map((e) => e.text);
  assert.ok(!log.some((t) => t.includes("```")));
});

test("a request that runs out of steps says so, and the next one carries on from there", async () => {
  const { rt, requests, idle, edit } = setup([...Array.from({ length: 16 }, () => toolCall("screenshot", {})), toolCall("finish", { message: "Done now." })]);
  edit("build it all");
  await idle();
  assert.equal(requests.length, 16);
  assert.match((rt.get("log") as { text: string }[]).at(-1)!.text, /ran out of steps.*ask me to continue/);
  assert.equal(rt.get("status"), "", "the status line clears");
  edit("continue");
  await idle();
  // The next request carries the whole conversation on, with the new request at the end.
  assert.ok(requests[16].input.length > 30);
  assert.match(JSON.stringify(requests[16].input.at(-1)), /You ran out of steps last time/);
  assert.equal((rt.get("log") as { text: string }[]).at(-1)!.text, "Done now.");
});

test("a call with broken JSON arguments is answered, and goes back to the model without them", async () => {
  const { requests, idle, edit } = setup([
    { output: [{ type: "function_call", call_id: "call_bad", name: "apply_patch", arguments: '{"patch": [{"op": "add"' }] },
    toolCall("finish", { message: "Done." }),
  ]);
  edit("anything");
  await idle();
  const call = requests[1].input.find((i) => i.type === "function_call") as { arguments?: string };
  assert.equal(call.arguments, "{}");
  assert.match(lastOutput(requests[1]), /The arguments weren't valid JSON/);
});
