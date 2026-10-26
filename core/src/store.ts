// Persisted app `data` in SQLite. One database per device holds every app, so the
// container can later share records between apps. Hosts only run SQL; the schema
// and the diffing live here, once for every platform.
//
// A scalar or object key is one row in `jig_values`. A list is a `jig_values` row of
// kind 'list' plus one `jig_items` row per item, keyed by the item's `id` (or its
// position when it has none), so adding or editing one item writes one row.
// Values are JSON text, readable from SQL with `json_extract`.
import type { Database, Statement } from "./bridge.ts";

const SCHEMA: Statement[] = [
  [
    `CREATE TABLE IF NOT EXISTS jig_values (
      app TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT,
      PRIMARY KEY (app, key)) WITHOUT ROWID`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS jig_items (
      app TEXT NOT NULL, list TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (app, list, id)) WITHOUT ROWID`,
  ],
];

const PUT_VALUE = "INSERT OR REPLACE INTO jig_values (app, key, kind, value) VALUES (?, ?, ?, ?)";
const PUT_ITEM = "INSERT OR REPLACE INTO jig_items (app, list, id, pos, value) VALUES (?, ?, ?, ?, ?)";
const DELETE_ITEM = "DELETE FROM jig_items WHERE app = ? AND list = ? AND id = ?";
const DELETE_ITEMS = "DELETE FROM jig_items WHERE app = ? AND list = ?";

/** What was last written for a key. Updates are immutable, so unchanged values keep their reference. */
type Saved =
  | { kind: "value"; ref: unknown }
  | { kind: "list"; ref: unknown; rows: Map<string, { ref: unknown; pos: number }> };

export class DataStore {
  readonly app: string;
  private db: Database;
  private saved = new Map<string, Saved>();

  constructor(db: Database, app: string) {
    this.db = db;
    this.app = app;
    db.exec(SCHEMA);
  }

  /** Every stored key of this app. */
  read(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.query("SELECT key, kind, value FROM jig_values WHERE app = ?", [this.app])) {
      out[r.key as string] = r.kind === "list" ? [] : parse(r.value);
    }
    const rows = new Map<string, Map<string, { ref: unknown; pos: number }>>();
    for (const r of this.db.query("SELECT list, id, pos, value FROM jig_items WHERE app = ? ORDER BY list, pos", [this.app])) {
      const list = out[r.list as string];
      if (!Array.isArray(list)) continue;
      const item = parse(r.value);
      list.push(item);
      if (!rows.has(r.list as string)) rows.set(r.list as string, new Map());
      rows.get(r.list as string)!.set(r.id as string, { ref: item, pos: list.length - 1 });
    }
    for (const [key, value] of Object.entries(out)) {
      if (this.saved.has(key)) continue;
      this.saved.set(key, Array.isArray(value) ? { kind: "list", ref: value, rows: rows.get(key) ?? new Map() } : { kind: "value", ref: value });
    }
    return out;
  }

  /** Writes what changed since the last save, in one transaction. */
  write(values: Map<string, unknown>): void {
    const statements: Statement[] = [];
    const next = new Map<string, Saved>();
    for (const [key, value] of values) {
      const prev = this.saved.get(key);
      if (prev && prev.ref === value) continue;
      if (Array.isArray(value)) {
        const prevRows = prev?.kind === "list" ? prev.rows : new Map();
        if (prev?.kind !== "list") statements.push([PUT_VALUE, [this.app, key, "list", null]]);
        const rows = new Map<string, { ref: unknown; pos: number }>();
        value.forEach((item, pos) => {
          let id = itemId(item);
          if (id === undefined || rows.has(id)) id = `#${pos}`;
          rows.set(id, { ref: item, pos });
          const old = prevRows.get(id);
          if (!old || old.ref !== item || old.pos !== pos) statements.push([PUT_ITEM, [this.app, key, id, pos, JSON.stringify(item) ?? "null"]]);
        });
        for (const id of prevRows.keys()) if (!rows.has(id)) statements.push([DELETE_ITEM, [this.app, key, id]]);
        next.set(key, { kind: "list", ref: value, rows });
      } else {
        if (prev?.kind === "list") statements.push([DELETE_ITEMS, [this.app, key]]);
        statements.push([PUT_VALUE, [this.app, key, "value", JSON.stringify(value) ?? "null"]]);
        next.set(key, { kind: "value", ref: value });
      }
    }
    if (statements.length) this.db.exec(statements);
    for (const [key, s] of next) this.saved.set(key, s);
  }

  /** Deletes every stored key of this app. */
  clear(): void {
    this.db.exec([
      ["DELETE FROM jig_items WHERE app = ?", [this.app]],
      ["DELETE FROM jig_values WHERE app = ?", [this.app]],
    ]);
    this.saved.clear();
  }
}

function itemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function parse(json: unknown): unknown {
  if (typeof json !== "string") return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
