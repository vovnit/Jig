// A deterministic host for Node tests: fixed-width glyphs, greedy word wrap.
import { DatabaseSync } from "node:sqlite";
import type { Database, Host, Op, SqlValue, TextMeasureStyle } from "../src/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import type { AppSpec } from "../src/spec.ts";

export const CHAR = 0.5; // glyph width as a fraction of font size

export function measure(text: string, style: TextMeasureStyle, maxWidth: number) {
  const cw = style.fontSize * CHAR;
  const lines: number[] = [];
  for (const para of text.split("\n")) {
    let line = 0;
    for (const word of para.split(" ")) {
      const w = word.length * cw;
      const withSpace = line === 0 ? w : line + cw + w;
      if (line > 0 && withSpace > maxWidth) {
        lines.push(line);
        line = w;
      } else line = withSpace;
    }
    lines.push(line);
  }
  return { width: Math.min(maxWidth, Math.max(...lines)), height: lines.length * style.lineHeight };
}

/** In-memory SQLite (Node's built-in driver) behind the host `Database` contract. */
export function makeDb(sqlite = new DatabaseSync(":memory:")): Database & { sqlite: DatabaseSync } {
  return {
    sqlite,
    // Rows come back with a null prototype; copy them into plain objects.
    query: (sql, params = []) => sqlite.prepare(sql).all(...params).map((r) => ({ ...r }) as Record<string, SqlValue>),
    exec(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const [sql, params = []] of statements) sqlite.prepare(sql).run(...params);
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export interface TestHost extends Host {
  batches: Op[][];
  db: ReturnType<typeof makeDb>;
  pending: (() => void)[];
  measureCalls: number;
}

export function makeHost(db = makeDb()): TestHost {
  const host: TestHost = {
    batches: [],
    db,
    pending: [],
    measureCalls: 0,
    apply(ops) {
      host.batches.push(ops);
    },
    measureText(text, style, maxWidth) {
      host.measureCalls++;
      return measure(text, style, maxWidth);
    },
    requestFrame(cb) {
      host.pending.push(cb);
    },
  };
  return host;
}

/** Runs pending frames and returns the ops they produced. */
export function frame(host: TestHost): Op[] {
  const before = host.batches.length;
  while (host.pending.length) host.pending.shift()!();
  return host.batches.slice(before).flat();
}

export function boot(spec: AppSpec, db?: TestHost["db"]) {
  const host = makeHost(db);
  const rt = new Runtime(host);
  rt.setViewport(390, 844);
  rt.load(spec);
  const ops = frame(host);
  return { host, rt, ops };
}

/** Finds the first node whose prop matches. */
export function findNode(rt: Runtime, pred: (props: Record<string, unknown>, type: string) => boolean) {
  for (const n of rt.nodes.values()) if (n.alive && pred(n.props, n.type)) return n;
  return undefined;
}

export const byText = (rt: Runtime, value: string) => findNode(rt, (p) => p.value === value || p.label === value);
