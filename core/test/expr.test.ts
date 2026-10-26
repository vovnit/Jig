import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, compileTemplate, compilePath, setIn, type Scope } from "../src/expr.ts";

const scope = (vars: Record<string, unknown>): Scope => ({ lookup: (n) => vars[n], has: (n) => n in vars });

test("arithmetic, comparison, logic", () => {
  const s = scope({ a: 2, b: 3, name: "Ann" });
  assert.equal(compile("a + b * 2")(s), 8);
  assert.equal(compile("(a + b) % 4")(s), 1);
  assert.equal(compile("a < b && !(a == b)")(s), true);
  assert.equal(compile("a > b ? 'big' : 'small'")(s), "small");
  assert.equal(compile("'Hi ' + name")(s), "Hi Ann");
  assert.equal(compile("missing ?? 'x'")(s), "x");
  assert.equal(compile("a / 0")(s), 0);
});

test("objects, lists and lambdas", () => {
  const s = scope({ chores: [{ name: "Dishes", done: true }, { name: "Bed", done: false }] });
  assert.equal(compile("len(filter(chores, c => !c.done))")(s), 1);
  assert.equal(compile("count(chores, 'done')")(s), 1);
  assert.deepEqual(compile("map(chores, c => c.name)")(s), ["Dishes", "Bed"]);
  assert.equal(compile("chores[1].name")(s), "Bed");
  assert.deepEqual(compile("{name: 'x', n: 1 + 1}")(s), { name: "x", n: 2 });
  assert.deepEqual(map(compile("sort(chores, (a, b) => 0)")(s)), ["Dishes", "Bed"]);
  assert.deepEqual(map(compile("sort(chores, 'name')")(s)), ["Bed", "Dishes"]);
  function map(v: unknown) {
    return (v as { name: string }[]).map((c) => c.name);
  }
});

test("templates keep raw values for a single binding", () => {
  const s = scope({ n: 3, list: [1, 2] });
  assert.equal(compileTemplate("{{n}}")!(s), 3);
  assert.deepEqual(compileTemplate("{{list}}")!(s), [1, 2]);
  assert.equal(compileTemplate("Drank {{n}} of {{n * 2}}")!(s), "Drank 3 of 6");
  assert.equal(compileTemplate("plain"), null);
});

test("no prototype access or arbitrary calls", () => {
  const s = scope({ o: {} });
  assert.throws(() => compile("o.constructor")(s));
  assert.throws(() => compile("o['__proto__']")(s));
  assert.throws(() => compile("alert(1)"));
  assert.throws(() => compile("o.toString()"));
  assert.equal(compile("o.toString")(s), undefined);
});

test("assignment paths and immutable set", () => {
  const p = compilePath("items[i].done");
  const s = scope({ i: 1 });
  assert.equal(p.root, "items");
  const keys = p.segs.map((f) => f(s));
  const before = [{ done: false }, { done: false }];
  const after = setIn(before, keys, true) as { done: boolean }[];
  assert.equal(after[1].done, true);
  assert.equal(before[1].done, false);
  assert.equal(after[0], before[0]);
});

test("date helpers", () => {
  const s = scope({});
  assert.equal(compile("addDays('2026-10-30', 3)")(s), "2026-11-02");
  assert.equal(compile("daysBetween('2026-10-01', '2026-10-26')")(s), 25);
  assert.equal(compile("formatDate('2026-10-26', 'EEE, MMM d')")(s), "Mon, Oct 26");
});
