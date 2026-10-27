import { test } from "node:test";
import assert from "node:assert/strict";
import type { Op } from "../src/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import type { AppSpec, NodeSpec } from "../src/spec.ts";
import { frame, makeHost, measure, type TestHost } from "./fake-host.ts";

const BUTTON_STYLE = { fontSize: 17, fontWeight: 600, lineHeight: 22 };

function labelWidth(label: string): number {
  return Math.ceil(measure(label, BUTTON_STYLE, 100000).width);
}

function bootBody(body: NodeSpec, viewportW: number): { host: TestHost; rt: Runtime; ops: Op[]; calls: { text: string; maxWidth: number; height: number }[] } {
  const host = makeHost();
  const calls: { text: string; maxWidth: number; height: number }[] = [];
  const orig = host.measureText;
  host.measureText = (text, style, maxWidth) => {
    const s = orig(text, style, maxWidth);
    calls.push({ text, maxWidth, height: s.height });
    return s;
  };
  const rt = new Runtime(host);
  rt.setViewport(viewportW, 844);
  const spec: AppSpec = { id: "t", name: "T", screens: { main: { body: body } } };
  rt.load(spec);
  const ops = frame(host);
  return { host, rt, ops, calls };
}

const buttonsOf = (rt: Runtime) => [...rt.nodes.values()].filter((n) => n.type === "button" && n.alive);

function paddingUpdatesFor(ops: Op[], id: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const o of ops) {
    if (o[0] === "update" && o[1] === id) {
      const style = (o[2] as { style?: { padding?: unknown } }).style;
      if (style && Array.isArray(style.padding)) out.push(style.padding as [number, number, number, number]);
    }
  }
  return out;
}

test("five buttons in a 358-wide row keep label + 8 with reduced padding", () => {
  const labels = ["Run", "Ride", "Swim", "Lift", "Walk"];
  // Viewport 398 minus the screen scroll's 20pt side padding leaves a 358-wide row.
  const { rt, ops, calls } = bootBody(
    { type: "row", style: { gap: 10 }, children: labels.map((label) => ({ type: "button", label })) } as NodeSpec,
    398,
  );
  const row = [...rt.nodes.values()].find((n) => n.type === "row" && n.alive);
  assert.ok(row, "row exists");
  assert.equal(row!.frame[2], 358);

  const buttons = buttonsOf(rt);
  assert.equal(buttons.length, 5);
  for (const b of buttons) {
    const label = String(b.props.label);
    const w = b.frame[2];
    assert.ok(w >= labelWidth(label) + 8 - 1e-6, `${label} keeps label + 8 (width ${w})`);
  }
  // Labels are measured single-line: never constrained, never two lines high.
  for (const c of calls.filter((c) => labels.includes(c.text))) {
    assert.ok(c.maxWidth >= 100000 - 1e-6, `button '${c.text}' measured single-line (maxWidth ${c.maxWidth})`);
    assert.equal(c.height, 22);
  }
  // Shrunk below natural width: padding sent is reduced, but stays >= 4 a side.
  for (const b of buttons) {
    const pads = paddingUpdatesFor(ops, b.id);
    assert.ok(pads.length > 0, `button '${b.props.label}' sends reduced padding`);
    const [, right, , left] = pads.at(-1)!;
    assert.ok(left < 16 && right < 16, `padding reduced (${left}, ${right})`);
    assert.ok(left >= 4 && right >= 4, `padding stays >= 4 (${left}, ${right})`);
  }
});

test("a button next to text fields keeps label + 8 while the fields shrink", () => {
  const { rt, calls } = bootBody(
    {
      type: "row",
      style: { width: 300, gap: 8 },
      children: [{ type: "textfield" }, { type: "textfield", style: { width: 70 } }, { type: "button", label: "Add" }],
    } as NodeSpec,
    390,
  );
  const button = buttonsOf(rt)[0];
  assert.ok(button, "button exists");
  const need = labelWidth("Add") + 8;
  assert.ok(button.frame[2] >= need - 1e-6, `button keeps label + 8 (${button.frame[2]} >= ${need})`);
  const fields = [...rt.nodes.values()].filter((n) => n.type === "textfield" && n.alive);
  assert.equal(fields.length, 2);
  // The growing field (natural 160 + 24 padding) absorbs the deficit instead of the button.
  assert.ok(fields[0].frame[2] < 184 - 1, `growing field shrinks (${fields[0].frame[2]})`);
  for (const c of calls.filter((c) => c.text === "Add")) assert.equal(c.height, 22);
});

test("a button with room keeps its full padding", () => {
  const { rt, ops } = bootBody(
    { type: "row", style: { width: 358 }, children: [{ type: "button", label: "Add" }] } as NodeSpec,
    390,
  );
  const button = buttonsOf(rt)[0];
  assert.ok(button, "button exists");
  assert.deepEqual(paddingUpdatesFor(ops, button.id), [], "no padding update when nothing shrank");
});

test("a shrunk button gets its full padding back when the row grows", () => {
  const labels = ["Run", "Ride", "Swim", "Lift", "Walk"];
  const { host, rt, ops: firstOps } = bootBody(
    { type: "row", style: { gap: 10 }, children: labels.map((label) => ({ type: "button", label })) } as NodeSpec,
    398,
  );
  const first = buttonsOf(rt)[0];
  assert.ok(paddingUpdatesFor(firstOps, first.id).length > 0, "shrunk button sent reduced padding");
  rt.setViewport(600, 844);
  const ops = frame(host);
  const pads = paddingUpdatesFor(ops, first.id);
  assert.ok(pads.length > 0, "growing back sends padding again");
  assert.deepEqual(pads.at(-1), [11, 16, 11, 16]);
});

test("a shrunk button's padding leaves room for its label inside a border and with uneven padding", () => {
  for (const style of [{ borderWidth: 2 }, { paddingLeft: 4, paddingRight: 20 }]) {
    const { rt, ops } = bootBody(
      { type: "row", children: [
        { type: "text", value: "A long label that takes the room", style: { grow: 1 } },
        { type: "button", label: "Add", style },
      ] } as NodeSpec,
      140,
    );
    const button = buttonsOf(rt)[0];
    const pads = paddingUpdatesFor(ops, button.id);
    assert.ok(pads.length > 0, "the shrunk button gets a padding update");
    const pad = pads.at(-1)!;
    const border = (style as { borderWidth?: number }).borderWidth ?? 0;
    assert.ok(button.frame[2] - pad[1] - pad[3] - 2 * border >= labelWidth("Add") - 0.5, JSON.stringify({ w: button.frame[2], pad }));
    assert.ok(pad[1] >= 4 && pad[3] >= 4);
  }
});
