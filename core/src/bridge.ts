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
  /** Imperative command for media and focus: play, pause, focus, scrollTo... */
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

export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface Host {
  /** Apply one batch of ops. Called at most once per frame. */
  apply(ops: Op[]): void;
  /** Synchronous text measurement with the bundled font. Results are cached by the runtime. */
  measureText(text: string, style: TextMeasureStyle, maxWidth: number): Size;
  /** Schedule `cb` before the next paint (rAF, CADisplayLink, Choreographer). */
  requestFrame(cb: () => void): void;
  storage?: Storage;
  now?(): number;
  log?(level: "info" | "warn" | "error", message: string): void;
}

/** Events the host sends back: `tap`, `change` {value}, `submit`, `load` {width, height}. */
export interface HostEvent {
  id: number;
  name: string;
  payload?: Record<string, unknown>;
}
