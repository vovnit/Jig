import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewNode, layoutRoot, parseBox, type LayoutContext } from "../src/layout.ts";

function node(type: string, style: Record<string, unknown> = {}, children: ViewNode[] = [], size?: [number, number]) {
  const n = new ViewNode(type);
  n.box = parseBox(style);
  n.children = children;
  for (const c of children) c.parent = n;
  if (size) n.intrinsic = { width: size[0], height: size[1] };
  return n;
}

function ctx(): LayoutContext & { frames: ViewNode[] } {
  const frames: ViewNode[] = [];
  return {
    frames,
    stats: { measured: 0, cacheHits: 0, skipped: 0 },
    // Leaves report `intrinsic`, wrapping like text when narrower than their width.
    measureLeaf(n, maxW) {
      const i = n.intrinsic ?? { width: 0, height: 0 };
      if (i.width <= maxW) return i;
      return { width: maxW, height: i.height * Math.ceil(i.width / maxW) };
    },
    onFrame(n) {
      n.sentFrame = n.frame;
      frames.push(n);
    },
  };
}

test("column stacks children with padding and gap, stretching cross axis", () => {
  const a = node("text", {}, [], [100, 20]);
  const b = node("text", {}, [], [50, 20]);
  const root = node("column", { padding: 10, gap: 5 }, [a, b]);
  layoutRoot(root, 300, 400, ctx());
  assert.deepEqual(a.frame, [10, 10, 280, 20]);
  assert.deepEqual(b.frame, [10, 35, 280, 20]);
});

test("row distributes free space to grow and aligns center", () => {
  const a = node("text", {}, [], [40, 20]);
  const s = node("spacer");
  const b = node("text", {}, [], [60, 30]);
  const row = node("row", { align: "center" }, [a, s, b]);
  const root = node("column", {}, [row]);
  layoutRoot(root, 200, 400, ctx());
  assert.deepEqual(row.frame, [0, 0, 200, 30]);
  assert.deepEqual(a.frame, [0, 5, 40, 20]);
  assert.deepEqual(s.frame, [40, 15, 100, 0]);
  assert.deepEqual(b.frame, [140, 0, 60, 30]);
});

test("text in a row shrinks and wraps to a taller line box", () => {
  const icon = node("shape", { width: 24, height: 24 });
  const label = node("text", {}, [], [300, 20]);
  const row = node("row", { gap: 8, align: "start" }, [icon, label]);
  const root = node("column", {}, [row]);
  layoutRoot(root, 200, 400, ctx());
  assert.deepEqual(label.frame, [32, 0, 168, 40]);
  assert.equal(row.frame[3], 40);
});

test("justify between, percentages and absolute positioning", () => {
  const a = node("spacer", { width: "25%", height: 10, grow: 0 });
  const b = node("spacer", { width: 20, height: 10, grow: 0 });
  const badge = node("spacer", { position: "absolute", right: 0, top: 0, width: 8, height: 8 });
  const row = node("row", { justify: "between" }, [a, b, badge]);
  const root = node("column", {}, [row]);
  layoutRoot(root, 200, 100, ctx());
  assert.deepEqual(a.frame, [0, 0, 50, 10]);
  assert.deepEqual(b.frame, [180, 0, 20, 10]);
  assert.deepEqual(badge.frame, [192, 0, 8, 8]);
});

test("overlay centers children; scroll lets content exceed the viewport", () => {
  const big = node("spacer", { height: 1000 });
  const sc = node("scroll", { grow: 1 }, [big]);
  const label = node("text", {}, [], [30, 10]);
  const ov = node("overlay", { width: 100, height: 100 }, [label]);
  const root = node("column", {}, [ov, sc]);
  layoutRoot(root, 300, 600, ctx());
  assert.deepEqual(label.frame, [35, 45, 30, 10]);
  assert.deepEqual(sc.frame, [0, 100, 300, 500]);
  assert.equal(sc.contentSize?.height, 1000);
});

test("incremental: a clean relayout touches nothing; a dirty leaf relayouts only its branch", () => {
  const a = node("text", {}, [], [100, 20]);
  const b1 = node("text", {}, [], [50, 20]);
  const b = node("column", { width: 100 }, [b1]);
  const root = node("column", {}, [a, b]);
  layoutRoot(root, 300, 400, ctx());

  const c1 = ctx();
  layoutRoot(root, 300, 400, c1);
  assert.equal(c1.frames.length, 0);
  assert.equal(c1.stats.measured, 0);

  a.intrinsic = { width: 100, height: 40 };
  a.markDirty();
  const c2 = ctx();
  layoutRoot(root, 300, 400, c2);
  assert.equal(c2.stats.measured, 2, "only `a` is re-measured (basis + final)");
  assert.deepEqual(c2.frames.map((n) => n.frame), [[0, 0, 300, 40], [0, 40, 100, 20]]);
  assert.ok(c2.stats.skipped >= 1, "b's subtree was skipped");
});

test("a tall scroll view shrinks to fit; its siblings in a column keep their size", () => {
  const title = node("text", {}, [], [100, 36]);
  const body = node("spacer", { height: 2000 });
  const sc = node("scroll", { grow: 1 }, [body]);
  const footer = node("text", {}, [], [100, 20]);
  const root = node("column", {}, [title, sc, footer]);
  layoutRoot(root, 300, 600, ctx());
  assert.deepEqual(title.frame, [0, 0, 300, 36]);
  assert.deepEqual(sc.frame, [0, 36, 300, 544]);
  assert.deepEqual(footer.frame, [0, 580, 300, 20]);
});
