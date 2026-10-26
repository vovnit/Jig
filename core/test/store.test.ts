import assert from "node:assert/strict";
import test from "node:test";
import type { Statement } from "../src/bridge.ts";
import { DataStore } from "../src/store.ts";
import { makeDb } from "./fake-host.ts";

/** A database that records each transaction it runs. */
function recordingDb() {
  const db = makeDb();
  const writes: Statement[][] = [];
  const exec = db.exec;
  db.exec = (statements) => {
    writes.push(statements);
    exec(statements);
  };
  return { db, writes, last: () => writes.at(-1)!.map(([sql]) => sql.split(" ")[0]) };
}

test("round-trips values and lists", () => {
  const { db } = recordingDb();
  const store = new DataStore(db, "a");
  store.write(new Map<string, unknown>([["goal", 8], ["profile", { name: "Ann" }], ["log", [{ day: "2026-10-26", glasses: 3 }]], ["empty", []]]));
  assert.deepEqual(new DataStore(db, "a").read(), { goal: 8, profile: { name: "Ann" }, log: [{ day: "2026-10-26", glasses: 3 }], empty: [] });
  assert.deepEqual(new DataStore(db, "b").read(), {});
});

test("writes only the rows that changed", () => {
  const { db, writes, last } = recordingDb();
  const store = new DataStore(db, "a");
  const a = { id: "a", done: false };
  const b = { id: "b", done: false };
  store.write(new Map<string, unknown>([["chores", [a, b]], ["stars", 0]]));

  // Unchanged references write nothing.
  const count = writes.length;
  store.write(new Map<string, unknown>([["chores", [a, b]], ["stars", 0]]));
  store.write(new Map<string, unknown>([["stars", 0]]));
  assert.equal(writes.length, count);

  // Editing one item rewrites that row only.
  const b2 = { ...b, done: true };
  store.write(new Map<string, unknown>([["chores", [a, b2]], ["stars", 0]]));
  assert.deepEqual(writes.at(-1), [["INSERT OR REPLACE INTO jig_items (app, list, id, pos, value) VALUES (?, ?, ?, ?, ?)", ["a", "chores", "b", 1, '{"id":"b","done":true}']]]);

  // Removing the first item deletes its row and moves the other.
  store.write(new Map<string, unknown>([["chores", [b2]]]));
  assert.deepEqual(last(), ["INSERT", "DELETE"]);
  assert.deepEqual(new DataStore(db, "a").read().chores, [b2]);
});

test("items without ids are keyed by position", () => {
  const { db } = recordingDb();
  const store = new DataStore(db, "a");
  const x = { glasses: 1 };
  const y = { glasses: 2 };
  store.write(new Map([["log", [x, y]]]));
  store.write(new Map([["log", [y]]]));
  assert.deepEqual(new DataStore(db, "a").read().log, [y]);
});

test("a key can change between value and list", () => {
  const { db } = recordingDb();
  const store = new DataStore(db, "a");
  store.write(new Map<string, unknown>([["k", [{ id: 1 }]]]));
  store.write(new Map<string, unknown>([["k", 5]]));
  assert.deepEqual(new DataStore(db, "a").read(), { k: 5 });
  assert.deepEqual(db.query("SELECT * FROM jig_items"), []);
  store.write(new Map<string, unknown>([["k", [{ id: 2 }]]]));
  assert.deepEqual(new DataStore(db, "a").read(), { k: [{ id: 2 }] });
});

test("clear deletes only this app", () => {
  const { db } = recordingDb();
  new DataStore(db, "b").write(new Map([["n", 1]]));
  const store = new DataStore(db, "a");
  store.write(new Map<string, unknown>([["n", 2], ["l", [1, 2]]]));
  store.clear();
  assert.deepEqual(new DataStore(db, "a").read(), {});
  assert.deepEqual(new DataStore(db, "b").read(), { n: 1 });
  // After a clear, the next write starts over.
  store.write(new Map<string, unknown>([["l", [1, 2]]]));
  assert.deepEqual(new DataStore(db, "a").read(), { l: [1, 2] });
});
