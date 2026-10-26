// The app spec: what Muse Spark generates. Plain JSON, no code.
// Strings in props and styles may contain `{{expr}}` bindings.

export type Action =
  | { set: string; to: string }
  | { toggle: string }
  | { push: string; value: string | Record<string, unknown> }
  | { remove: string; at?: string; where?: string }
  | { navigate: string; params?: Record<string, string> }
  | { back: true }
  | { if: string; then: Action | Action[]; else?: Action | Action[] };

export type Actions = Action | Action[];

export interface NodeSpec {
  type: string;
  style?: Record<string, unknown>;
  children?: NodeSpec[];
  /** Render only while the expression is truthy. */
  if?: string;
  /** Repeat this node for each item of a list (or `n` times for a number). */
  each?: string;
  as?: string;
  indexAs?: string;
  key?: string;
  /** Two-way binding of a control's value to a state/data path. */
  bind?: string;
  onTap?: Actions;
  onChange?: Actions;
  onSubmit?: Actions;
  [prop: string]: unknown;
}

export interface FieldSpec {
  type: "string" | "number" | "boolean" | "date" | "datetime" | "list" | "object";
  default?: unknown;
  /** For lists: shape of each item. */
  fields?: Record<string, FieldSpec | FieldSpec["type"]>;
  description?: string;
}

export interface ScreenSpec {
  title?: string;
  /** Wrap the body in a vertical scroll view (default true). */
  scroll?: boolean;
  body: NodeSpec;
  /** A floating action at the bottom of the screen. */
  footer?: NodeSpec;
}

export interface AppSpec {
  id: string;
  name: string;
  description?: string;
  theme?: Record<string, string>;
  /** Persisted, typed data. Visible to the container's data layer. */
  data?: Record<string, FieldSpec>;
  /** Transient UI state: name → default value. */
  state?: Record<string, unknown>;
  /** Reusable templates: `{"type": "Card", "props": {...}}` reads them as `props.*`. */
  components?: Record<string, NodeSpec>;
  screens: Record<string, ScreenSpec>;
  start?: string;
}

// ---------- Design tokens (shared by every host for identical output) ----------

export const DEFAULT_THEME: Record<string, string> = {
  accent: "#3b6ef6",
  onAccent: "#ffffff",
  text: "#14161a",
  muted: "#6b7280",
  background: "#ffffff",
  surface: "#f2f3f5",
  border: "#e3e5e8",
  danger: "#e5484d",
  success: "#2f9e6a",
  warning: "#f5a524",
};

export interface TextStyle {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
}

export const TYPOGRAPHY: Record<string, TextStyle & { color?: string }> = {
  largeTitle: { fontSize: 30, fontWeight: 700, lineHeight: 36 },
  title: { fontSize: 22, fontWeight: 700, lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: 600, lineHeight: 22 },
  body: { fontSize: 17, fontWeight: 400, lineHeight: 22 },
  callout: { fontSize: 15, fontWeight: 400, lineHeight: 20 },
  caption: { fontSize: 13, fontWeight: 400, lineHeight: 17, color: "muted" },
  button: { fontSize: 17, fontWeight: 600, lineHeight: 22 },
};

/** The one font bundled with every host, so measurements match across platforms. */
export const FONT_FAMILY = "Inter";
