// The contract between the shared JS runtime and a native host (web DOM, UIKit,
// Android Views). Native stays "dumb": it creates views, applies props and
// frames, measures text, and reports events back by node id.

export type Props = Record<string, unknown>;

export type Op =
  /** Create a view of `type` with initial props. Node 1 is the root surface. */
  | ["create", number, string, Props]
  /** Shallow-merge props (and `style`) into an existing view. */
  | ["update", number, Props]
  /** Insert (or move, if already a child) `child` into `parent` at `index`. */
  | ["insert", number, number, number]
  /** Detach `child` from `parent` and destroy it with its whole subtree. */
  | ["remove", number, number]
  /** Position relative to the parent: x, y, width, height in points. */
  | ["frame", number, number, number, number, number]
  /**
   * Imperative command: `focus`, or on the root `transition` [kind: "push" | "pop",
   * style: "slide" | "fade", durationMs]. A host sees the transition before applying
   * the batch, snapshots the old screen, applies the ops and animates the new screen in.
   */
  | ["command", number, string, unknown[]];

export interface TextMeasureStyle {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
}

export interface Size {
  width: number;
  height: number;
}

export type SqlValue = string | number | null;
export type Statement = [sql: string, params?: SqlValue[]];

/** A SQLite database. Calls are synchronous, on the runtime's thread. */
export interface Database {
  /** Runs one read; each row maps column name → value. */
  query(sql: string, params?: SqlValue[]): Record<string, SqlValue>[];
  /** Runs the statements in one transaction. On error it rolls back and throws. */
  exec(statements: Statement[]): void;
}

/** Secure storage for secret `data` fields, namespaced per app. Synchronous, on the runtime's thread. */
export interface SecretStore {
  get(app: string, key: string): string | null;
  /** `null` deletes the secret. */
  set(app: string, key: string, value: string | null): void;
  /** Deletes every secret of the app. */
  clear(app: string): void;
}

export interface Host {
  /** Apply one batch of ops. Called at most once per frame. */
  apply(ops: Op[]): void;
  /** Synchronous text measurement with the bundled font. Results are cached by the runtime. */
  measureText(text: string, style: TextMeasureStyle, maxWidth: number): Size;
  /** Intrinsic size of a native control (`toggle`), when it differs from the 51×31 default. */
  measureControl?(type: string): Size;
  /** Schedule `cb` before the next paint (rAF, CADisplayLink, Choreographer). */
  requestFrame(cb: () => void): void;
  /** Persists app `data` (see store.ts). Without it, data lives for the session only. */
  db?: Database;
  /** Holds `secret` data fields. Without it, secrets live for the session only. */
  secrets?: SecretStore;
  now?(): number;
  log?(level: "info" | "warn" | "error", message: string): void;
}

/** Events the host sends back: `tap`, `change` {value}, `submit`, `load` {width, height}. */
export interface HostEvent {
  id: number;
  name: string;
  payload?: Record<string, unknown>;
}
