import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, SqlValue } from "@jig/core";

/**
 * SQLite compiled to wasm. Its pages live in localStorage (the kvvfs), which keeps
 * calls synchronous on the main thread, as the runtime expects; OPFS would need a worker.
 */
export async function openDatabase(): Promise<Database | undefined> {
  try {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.JsStorageDb("local");
    return {
      query: (sql, params) =>
        db.exec({ sql, bind: params?.length ? params : undefined, rowMode: "object", returnValue: "resultRows" }) as Record<string, SqlValue>[],
      exec(statements) {
        db.transaction(() => {
          for (const [sql, params] of statements) db.exec({ sql, bind: params?.length ? params : undefined });
        });
      },
    };
  } catch (e) {
    // Storage can be unavailable (private mode); data then lives for the session only.
    console.warn("[jig] SQLite unavailable:", e);
    return undefined;
  }
}
