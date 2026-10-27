import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../src/spec.ts";
import type { Op } from "../src/bridge.ts";
import { boot, byText, findNode, frame } from "./fake-host.ts";

const inner: AppSpec = {
  id: "inner",
  name: "Inner",
  data: { n: { type: "number", default: 0 } },
  screens: {
    main: {
      title: "Inner",
      body: {
        type: "column",
        children: [
          { type: "text", value: "Count {{n}}" },
          { type: "button", label: "Add", onTap: { set: "n", to: "n + 1" } },
          { type: "button", label: "Next", onTap: { navigate: "second" } },
        ],
      },
    },
    second: { title: "Second", body: { type: "text", value: "Second screen" } },
  },
};

const shell = (app: Record<string, unknown> = {}): AppSpec => ({
  id: "shell",
  name: "Shell",
  state: { app: inner },
  screens: {
    home: { title: "Home", body: { type: "button", label: "Open", onTap: { navigate: "run" } } },
    run: { scroll: false, body: { type: "app", spec: "{{app}}", style: { grow: 1 }, ...app } },
  },
});

const appNode = (rt: ReturnType<typeof boot>["rt"]) => findNode(rt, (_, t) => t === "app")!;

test("an embedded app renders inside its node, in the parent's batch", () => {
  const { host, rt } = boot(shell());
  rt.dispatch(byText(rt, "Open")!.id, "tap");
  const ops = frame(host);
  const node = appNode(rt);
  const [child] = rt.children;
  assert.ok(child, "a child runtime");
  // The child's root is created before it is attached to the app node.
  const created = ops.findIndex((o) => o[0] === "create" && o[1] === child.root.id);
  const attached = ops.findIndex((o) => o[0] === "insert" && o[1] === node.id && o[2] === child.root.id);
  assert.ok(created >= 0 && attached > created);
  assert.notEqual(ops.find((o) => o[0] === "create" && o[1] === child.root.id)![2], "root", "an embedded root isn't the surface");
  // The child lays out at the node's size.
  assert.deepEqual([child.viewport.width, child.viewport.height], [node.frame[2], node.frame[3]]);
  assert.ok(child.nodes.size > 3);
  assert.ok(ops.some((o) => o[0] === "create" && (o[3] as { value?: string }).value === "Count 0"));
});

test("events reach the embedded app, and back pops its screens before the parent's", () => {
  const { host, rt } = boot(shell());
  rt.dispatch(byText(rt, "Open")!.id, "tap");
  frame(host);
  const [child] = rt.children;
  const add = [...child.nodes.values()].find((n) => n.props.label === "Add")!;
  rt.dispatch(add.id, "tap");
  let ops = frame(host);
  assert.equal(child.get("n"), 1);
  assert.ok(ops.some((o) => o[0] === "update" && (o[2] as { value?: string }).value === "Count 1"));

  const next = [...child.nodes.values()].find((n) => n.props.label === "Next")!;
  rt.dispatch(next.id, "tap");
  ops = frame(host);
  // The child's screen transition and depth name the child's root.
  assert.ok(ops.some((o) => o[0] === "command" && o[1] === child.root.id && o[2] === "transition"));
  assert.ok(ops.some((o) => o[0] === "command" && o[1] === child.root.id && o[2] === "depth" && (o[3] as number[])[0] === 2));

  assert.equal(rt.back(), true);
  frame(host);
  assert.equal(child.nav.peek().length, 1, "the child popped first");
  assert.equal(rt.nav.peek().length, 2);
  assert.equal(rt.back(), true);
  ops = frame(host);
  assert.equal(rt.nav.peek().length, 1, "then the parent");
  assert.equal(rt.children.length, 0, "leaving the screen disposes the child");
  assert.ok(ops.some((o: Op) => o[0] === "command" && o[1] === rt.root.id && o[2] === "depth" && (o[3] as number[])[0] === 1));
});

test("a pinned, scaled card shows one screen at phone size and doesn't navigate", () => {
  const { host, rt } = boot(shell({ screen: "main", scale: 0.25, interactive: false, style: { width: 97.5, height: 211, grow: 0 } }));
  rt.dispatch(byText(rt, "Open")!.id, "tap");
  frame(host);
  const node = appNode(rt);
  const [child] = rt.children;
  assert.equal(node.props.contentScale, 0.25);
  assert.equal(node.props.interactive, false);
  assert.deepEqual([child.viewport.width, child.viewport.height], [390, 844]);
  const next = [...child.nodes.values()].find((n) => n.props.label === "Next")!;
  child.dispatch(next.id, "tap");
  frame(host);
  assert.equal(child.nav.peek().length, 1);
  assert.equal(rt.back(), true, "a picture doesn't take the back gesture");
  frame(host);
  assert.equal(rt.nav.peek().length, 1);
});

test("an edited spec hot-reloads the embedded app and keeps its data", () => {
  const { host, rt } = boot(shell());
  rt.dispatch(byText(rt, "Open")!.id, "tap");
  frame(host);
  const [child] = rt.children;
  child.set("n", 5);
  const edited = structuredClone(inner);
  edited.screens.main.body.children![0].value = "Total {{n}}";
  rt.set("app", edited);
  frame(host);
  assert.equal(rt.children[0], child, "the same runtime");
  assert.ok([...child.nodes.values()].some((n) => n.props.value === "Total 5"));
});

test("the shell lists the seeded apps, runs one, and goes back home", async () => {
  const { readFileSync } = await import("node:fs");
  const load = (n: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${n}.json`, import.meta.url), "utf8"));
  const { seedApps } = await import("../src/builder/registry.ts");
  const { host, rt } = boot(load("shell"));
  seedApps(rt, ["water", "chores", "meds", "showcase"].map(load));
  frame(host);
  assert.ok(byText(rt, "Chore chart"));
  assert.ok(byText(rt, "C"), "an initial for the icon");

  const row = (() => {
    let n = byText(rt, "Chore chart");
    while (n?.parent && !n.parent.virtual) n = n.parent;
    return n!;
  })();
  rt.dispatch(row.id, "tap");
  frame(host);
  const [child] = rt.children;
  assert.equal(child?.spec.id, "chores");
  assert.ok([...child.nodes.values()].some((n) => n.props.value === "Make the bed"));
  assert.ok(!byText(rt, "‹ Back"), "the run screen has no header");
  assert.deepEqual(rt.errors, []);

  // Seeding again keeps the list as it is.
  seedApps(rt, [load("chores")]);
  assert.equal((rt.get("apps") as unknown[]).length, 4);

  rt.dispatch(byText(rt, "Done")!.id, "tap");
  frame(host);
  assert.equal(rt.children.length, 0);
  assert.ok(byText(rt, "Apps"));
});

test("the shell's edit, new and settings screens render without errors", async () => {
  const { readFileSync } = await import("node:fs");
  const load = (n: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${n}.json`, import.meta.url), "utf8"));
  const { seedApps } = await import("../src/builder/registry.ts");
  const { installBuilder } = await import("../src/builder/index.ts");
  const { host, rt } = boot(load("shell"), undefined, undefined, { trusted: true });
  installBuilder(rt);
  seedApps(rt, [load("chores")]);
  frame(host);
  rt.run({ navigate: "edit", params: { id: "'chores'" } }, { lookup: () => undefined, has: () => false });
  frame(host);
  const [preview] = rt.children;
  assert.equal(preview?.spec.id, "chores");
  // A whiteboard card lays its screen out at phone size.
  assert.equal(preview.viewport.width, 390);
  assert.ok(Math.abs(preview.viewport.height - 844) <= 1);
  for (const mode of ["screen", "code"]) {
    rt.set("mode", mode);
    frame(host);
  }
  assert.ok([...rt.nodes.values()].some((n) => n.props.value === '  "title": "Chores",'), "the code view shows the screen's spec");
  assert.ok(byText(rt, "Describe a change") === undefined, "the placeholder is a prop, not a text");
  assert.ok(findNode(rt, (p) => p.placeholder === "Describe a change"));
  for (const screen of ["new", "settings"]) {
    rt.run({ navigate: screen }, { lookup: () => undefined, has: () => false });
    frame(host);
  }
  assert.deepEqual(rt.errors, []);
});
