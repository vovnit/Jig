import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec, NodeSpec } from "../src/spec.ts";
import type { Runtime } from "../src/runtime.ts";
import { boot, byText, findNode, frame } from "./fake-host.ts";

function listApp(n: number, list: Partial<NodeSpec> = {}): AppSpec {
  return {
    id: "list",
    name: "List",
    data: {
      items: { type: "list", default: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `Item ${i}` })) },
    },
    screens: {
      main: {
        body: { type: "list", items: "items", as: "it", header: "Things", row: { type: "text", value: "{{it.name}}" }, ...list },
      },
    },
  };
}

const theList = (rt: Runtime) => [...rt.lists][0];
const rows = (rt: Runtime) => theList(rt).body.children;
const names = (rt: Runtime) => (rt.get("items") as { name: string }[]).map((i) => i.name);

test("a short list builds a row per item, with a header and separators between rows", () => {
  const { rt } = boot(listApp(3));
  assert.equal(rows(rt).length, 3);
  assert.ok(byText(rt, "Things"));
  const dividers = [...rt.nodes.values()].filter((n) => n.alive && n.type === "divider");
  assert.equal(dividers.length, 2, "no separator under the last row");
  // Rows stack: 44pt each, plus a 0.5pt separator under all but the last.
  assert.deepEqual(rows(rt).map((r) => [r.frame[1], r.frame[3]]), [[0, 44.5], [44.5, 44.5], [89, 44]]);
  assert.equal(theList(rt).body.frame[3], 133);
});

test("a long list only builds rows near the visible part, and moves them as it scrolls", () => {
  const { host, rt } = boot(listApp(1000));
  const L = theList(rt);
  assert.ok(rows(rt).length < 100, `built ${rows(rt).length} rows`);
  assert.ok(L.body.frame[3] > 44000, "space for every item");
  const scroll = findNode(rt, (_, type) => type === "scroll")!;
  assert.equal(scroll.props.reportScroll, true);

  rt.dispatch(scroll.id, "scroll", { y: 20000 });
  const ops = frame(host);
  const built = rows(rt).map((r) => L.byNode.get(r)!.index.peek());
  const visible = Math.floor(20000 / 44.5);
  assert.ok(built[0] <= visible && built.at(-1)! >= visible + 15, `rows ${built[0]}–${built.at(-1)} around ${visible}`);
  assert.ok(rows(rt).length < 100);
  // Rows scrolling in and out of the window come and go without the fade of a new or deleted item.
  const inserts = ops.filter((o) => o[0] === "insert" && o[1] === L.body.id);
  const removes = ops.filter((o) => o[0] === "remove" && o[1] === L.body.id);
  assert.ok(inserts.length > 0 && inserts.every((o) => o[4] === true));
  assert.ok(removes.length > 0 && removes.every((o) => o[3] === true));
  // A row's frame is at its item's offset.
  const first = rows(rt)[0];
  assert.equal(first.frame[1], L.body.virtual!.top(built[0]));

  // Scrolling a little within the margin moves nothing.
  rt.dispatch(scroll.id, "scroll", { y: 20100 });
  assert.equal(frame(host).filter((o) => o[0] === "insert").length, 0);
});

test("adding an item past the window grows the list without building its row", () => {
  const { host, rt } = boot(listApp(500));
  const before = theList(rt).body.frame[3];
  const built = rows(rt).length;
  rt.set("items", [...(rt.get("items") as unknown[]), { id: "new", name: "New" }]);
  frame(host);
  assert.equal(rows(rt).length, built);
  assert.ok(theList(rt).body.frame[3] > before);
  assert.ok(!byText(rt, "New"));
});

test("dragging a row past its neighbour moves its item", () => {
  const { host, rt } = boot(listApp(3, { reorder: true }));
  const first = rows(rt)[0];
  assert.equal(first.props.reorder, true);
  rt.dispatch(first.id, "move", { by: 1 });
  frame(host);
  assert.deepEqual(names(rt), ["Item 1", "Item 0", "Item 2"]);
  // The same row moved down: it keeps its node, and its frame follows.
  assert.equal(rows(rt)[1], first);
  assert.equal(first.frame[1], 44.5);
  rt.dispatch(first.id, "move", { by: 1 });
  rt.dispatch(first.id, "move", { by: 1 });
  frame(host);
  assert.deepEqual(names(rt), ["Item 1", "Item 2", "Item 0"], "stops at the end");
  // The new order is saved.
  const order = host.db.query("SELECT id FROM jig_items WHERE app = 'list' ORDER BY pos").map((r) => r.id);
  assert.deepEqual(order, ["i1", "i2", "i0"]);
});

test("reordering a sorted view is an error, not a silent no-op", () => {
  const { host, rt } = boot(listApp(3, { items: "sort(items, 'name')", reorder: true }));
  rt.dispatch(rows(rt)[0].id, "move", { by: 1 });
  frame(host);
  assert.deepEqual(names(rt), ["Item 0", "Item 1", "Item 2"]);
  assert.ok(rt.errors.some((e) => e.where.endsWith(".reorder")));
});

test("swipe actions reach the host and run in the row's scope", () => {
  const { host, rt } = boot(listApp(3, { swipe: [{ label: "Delete", do: { remove: "it" } }, { label: "Rename {{it.name}}", color: "accent", do: { set: "it.name", to: "'Renamed'" } }] }));
  const second = rows(rt)[1];
  assert.deepEqual(second.props.swipeActions, [
    { label: "Delete", color: rt.theme.danger },
    { label: "Rename Item 1", color: rt.theme.accent },
  ]);
  rt.dispatch(second.id, "swipe", { index: 1 });
  frame(host);
  assert.equal(names(rt)[1], "Renamed");
  rt.dispatch(second.id, "swipe", { index: 0 });
  const ops = frame(host);
  assert.deepEqual(names(rt), ["Item 0", "Item 2"]);
  // A deleted item's row fades out: its remove isn't quiet.
  assert.ok(ops.some((o) => o[0] === "remove" && o[2] === second.id && o[3] === undefined));
});

test("an empty list shows its empty state until an item arrives", () => {
  const { host, rt } = boot(listApp(0, { empty: "Nothing here" }));
  assert.ok(byText(rt, "Nothing here"));
  rt.set("items", [{ id: "a", name: "First" }]);
  frame(host);
  assert.ok(!byText(rt, "Nothing here"));
  assert.ok(byText(rt, "First"));
  assert.equal(rows(rt).length, 1);
});

test("a row tap runs onTap with the item in scope", () => {
  const { host, rt } = boot(listApp(3, { onTap: { set: "it.name", to: "'Tapped'" } }));
  rt.dispatch(rows(rt)[2].id, "tap");
  frame(host);
  assert.equal(names(rt)[2], "Tapped");
  assert.ok(byText(rt, "Tapped"));
});
