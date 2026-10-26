import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { boot, byText, findNode, frame } from "./fake-host.ts";

const load = (name: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${name}.json`, import.meta.url), "utf8"));

const counter: AppSpec = {
  id: "counter",
  name: "Counter",
  data: { n: { type: "number", default: 0 } },
  screens: {
    main: {
      title: "Counter",
      body: {
        type: "column",
        style: { gap: 8 },
        children: [
          { type: "text", value: "Count: {{n}}" },
          { type: "text", value: "Static" },
          { type: "text", if: "n >= 2", value: "Two or more" },
          { type: "button", label: "Add", onTap: { set: "n", to: "n + 1" } },
        ],
      },
    },
  },
};

test("first frame creates the tree, inserts children and sets frames", () => {
  const { ops } = boot(counter);
  const kinds = new Set(ops.map((o) => o[0]));
  assert.ok(kinds.has("create") && kinds.has("insert") && kinds.has("frame"));
  const firstFrame = ops.findIndex((o) => o[0] === "frame");
  const lastCreate = ops.findLastIndex((o) => o[0] === "create");
  assert.ok(lastCreate < firstFrame, "frames come after structure");
});

test("a tap updates only the bound text node", () => {
  const { host, rt } = boot(counter);
  const label = byText(rt, "Count: 0")!;
  const button = byText(rt, "Add")!;
  rt.dispatch(button.id, "tap");
  const ops = frame(host);
  const updates = ops.filter((o) => o[0] === "update");
  assert.deepEqual(updates, [["update", label.id, { value: "Count: 1" }]]);
  assert.equal(ops.filter((o) => o[0] === "create").length, 0);
});

test("`if` creates and removes a subtree", () => {
  const { host, rt } = boot(counter);
  const button = byText(rt, "Add")!;
  rt.dispatch(button.id, "tap");
  rt.dispatch(button.id, "tap");
  let ops = frame(host);
  const created = ops.find((o) => o[0] === "create" && (o[3] as { value?: string }).value === "Two or more");
  assert.ok(created, "conditional text is created");
  const createdId = created![1];
  // The button moves down: its frame changes, the static text does not.
  const staticText = byText(rt, "Static")!;
  assert.ok(!ops.some((o) => o[0] === "frame" && o[1] === staticText.id));
  assert.ok(ops.some((o) => o[0] === "frame" && o[1] === button.id));

  rt.set("n", 0);
  ops = frame(host);
  assert.ok(ops.some((o) => o[0] === "remove" && o[2] === createdId));
});

test("data persists to host storage and is restored", () => {
  const { host, rt } = boot(counter);
  rt.dispatch(byText(rt, "Add")!.id, "tap");
  frame(host);
  assert.equal(JSON.parse(host.store.get("jig:counter")!).n, 1);
  const again = boot(counter, host.store);
  assert.ok(byText(again.rt, "Count: 1"));
});

test("hot reload keeps state and rebuilds the view", () => {
  const { host, rt } = boot(counter);
  rt.dispatch(byText(rt, "Add")!.id, "tap");
  frame(host);
  const edited = structuredClone(counter);
  edited.screens.main.body.children![0].value = "Total: {{n}}";
  rt.load(edited);
  frame(host);
  assert.ok(byText(rt, "Total: 1"));
  assert.ok(!byText(rt, "Count: 1"));
});

test("chores: keyed list, toggling an item, removing an item, adding from a text field", () => {
  const { host, rt } = boot(load("chores"));
  const bed = byText(rt, "Make the bed")!;
  const row = bed.parent!;
  rt.dispatch(row.id, "tap");
  let ops = frame(host);
  assert.equal(rt.get("stars"), 1);
  assert.equal((rt.get("chores") as { done: boolean }[])[0].done, true);
  assert.ok(byText(rt, "1 of 3 done today"));
  assert.equal(byText(rt, "Make the bed"), bed, "keyed rows are reused, not recreated");
  assert.ok(!ops.some((o) => o[0] === "remove"));

  // Remove "Feed the cat" via its close icon.
  const catRow = byText(rt, "Feed the cat")!.parent!;
  const close = catRow.children.at(-1)!;
  rt.dispatch(close.id, "tap");
  ops = frame(host);
  assert.ok(ops.some((o) => o[0] === "remove" && o[2] === catRow.id));
  assert.equal((rt.get("chores") as unknown[]).length, 2);

  // Type into the field: the runtime must not echo the value back.
  const field = findNode(rt, (p, t) => t === "textfield")!;
  rt.dispatch(field.id, "change", { value: "Water plants" });
  ops = frame(host);
  assert.ok(!ops.some((o) => o[0] === "update" && o[1] === field.id));
  assert.equal(rt.get("draft"), "Water plants");

  rt.dispatch(field.id, "submit");
  ops = frame(host);
  assert.ok(byText(rt, "Water plants"));
  assert.equal(rt.get("draft"), "");
  assert.ok(ops.some((o) => o[0] === "update" && o[1] === field.id && (o[2] as { value: string }).value === ""), "field is cleared");
});

test("meds: navigation with params, toggles and history", () => {
  const { host, rt } = boot(load("meds"));
  const toggle = findNode(rt, (_, t) => t === "toggle")!;
  rt.dispatch(toggle.id, "change", { value: true });
  frame(host);
  assert.equal((rt.get("taken") as unknown[]).length, 1);
  assert.ok(byText(rt, `${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · 1 of 3 taken`));

  const metformin = byText(rt, "Metformin")!;
  rt.dispatch(metformin.parent!.parent!.id, "tap");
  frame(host);
  assert.ok(byText(rt, "500 mg every day at 08:00"));
  assert.ok(byText(rt, "‹ Back"));
  assert.ok(!byText(rt, "Not taken yet."));

  rt.dispatch(byText(rt, "‹ Back")!.id, "tap");
  frame(host);
  assert.ok(byText(rt, "Today"));
  assert.deepEqual(rt.errors, []);
});

test("water: ring, chart and goal all render without errors", () => {
  const { host, rt } = boot(load("water"));
  rt.dispatch(byText(rt, "+ Glass")!.id, "tap");
  rt.dispatch(byText(rt, "+ Glass")!.id, "tap");
  frame(host);
  assert.ok(byText(rt, "2 / 8"));
  assert.deepEqual(rt.errors, []);
});

test("incremental frames: unrelated subtrees are skipped and text is measured once", () => {
  const { host, rt } = boot(load("chores"));
  const before = host.measureCalls;
  rt.dispatch(byText(rt, "Make the bed")!.parent!.id, "tap");
  let stats = { skippedSubtrees: 0, measureCalls: 0 };
  rt.onStats = (s) => (stats = s);
  frame(host);
  assert.ok(stats.skippedSubtrees > 0);
  assert.ok(host.measureCalls - before <= 3, `measured ${host.measureCalls - before} strings`);
});

test("dark mode swaps theme tokens, keeps the brand accent and the app's state", () => {
  const { host, rt } = boot({ ...counter, theme: { accent: "#ff0000", background: "#fafafa" } });
  rt.dispatch(byText(rt, "Add")!.id, "tap");
  frame(host);
  rt.setColorScheme("dark");
  frame(host);
  assert.equal(rt.theme.accent, "#ff0000");
  assert.equal(rt.theme.background, "#111316");
  assert.ok(byText(rt, "Count: 1"));
  const screen = findNode(rt, (_, t) => t === "screen")!;
  assert.equal((screen.props.style as { background: string }).background, "#111316");
});
