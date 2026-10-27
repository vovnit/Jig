// The app spec: what Muse Spark generates. Plain JSON, no code.
// Strings in props and styles may contain `{{expr}}` bindings.

export type Action =
  | { set: string; to: string }
  | { toggle: string }
  | { push: string; value: string | Record<string, unknown> }
  | { remove: string; at?: string; where?: string }
  | { navigate: string; params?: Record<string, string>; transition?: ScreenTransition }
  | { back: true }
  | { if: string; then: Action | Action[]; else?: Action | Action[] }
  /** A service of the container (the builder). Only the shell may call them. */
  | { call: string; args?: Record<string, unknown> };

export type Actions = Action | Action[];

/** How a screen enters on `navigate` (and leaves again on `back`). Default "slide". */
export type ScreenTransition = "slide" | "fade" | "none";

/**
 * Animating between values: `style.transition` makes the host animate a node's
 * frame, opacity, colors and shape trim when they change, and fade it in when it
 * appears in a list. A number is a duration in ms; `true` means 250ms.
 */
export type ValueTransition = number | boolean | { duration?: number; easing?: "ease" | "linear" | "easeIn" | "easeOut" | "spring" };

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

/**
 * A native-looking list: `{"type": "list", "items": "chores", "as": "chore", "row": {...}}`.
 * Rows are virtualized (only those near the visible part exist), so lists can be long.
 */
export interface ListSpec extends NodeSpec {
  type: "list";
  /** The items: an expression. Reordering needs a plain data path, such as `chores`. */
  items: string;
  /** Row content, built for each item with `as` (default `item`) and `indexAs` in scope. */
  row: NodeSpec;
  /** `inset` (default): grouped rows on a rounded card. `plain`: full-width rows. */
  variant?: "inset" | "plain";
  header?: string;
  footer?: string;
  /** Shown instead of the rows when there are no items: text or a node. */
  empty?: string | NodeSpec;
  /** Row tap. */
  onTap?: Actions;
  /** Swipe actions, revealed by swiping a row to the left; a full swipe runs the first. */
  swipe?: { label: string; color?: string; do: Actions }[];
  /** Long-press a row and drag it to reorder the items. */
  reorder?: boolean;
  /** Hairlines between rows (default true). */
  separators?: boolean;
  /** Overrides the row's box (padding, minHeight): `{"paddingY": 0, "minHeight": 0}` for dense rows. */
  rowStyle?: Record<string, unknown>;
}

export interface FieldSpec {
  type: "string" | "number" | "boolean" | "date" | "datetime" | "list" | "object";
  default?: unknown;
  /** For lists: shape of each item. */
  fields?: Record<string, FieldSpec | FieldSpec["type"]>;
  description?: string;
  /**
   * Kept in the platform's secure storage (Keychain, Android Keystore) instead of the
   * database, so it never reaches the shared data store. An empty value deletes it.
   */
  secret?: boolean;
}

export interface ScreenSpec {
  title?: string;
  /** Wrap the body in a vertical scroll view (default true). */
  scroll?: boolean;
  /** Show the title and Back button (default true). The shell's run screen hides them. */
  header?: boolean;
  body: NodeSpec;
  /** A floating action at the bottom of the screen. */
  footer?: NodeSpec;
}

export interface AppSpec {
  id: string;
  name: string;
  description?: string;
  /** Light-mode tokens. In dark mode only `accent` and custom tokens carry over. */
  theme?: Record<string, string>;
  /** Dark-mode overrides. */
  darkTheme?: Record<string, string>;
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

export const DARK_THEME: Record<string, string> = {
  accent: "#3b6ef6",
  onAccent: "#ffffff",
  text: "#eef0f3",
  muted: "#9aa1ab",
  background: "#111316",
  surface: "#1e2126",
  border: "#30343b",
  danger: "#ff6369",
  success: "#3cc489",
  warning: "#f5b544",
};

export type ColorScheme = "light" | "dark";

/** Resolves the spec's theme for a color scheme. */
export function resolveTheme(spec: Pick<AppSpec, "theme" | "darkTheme">, scheme: ColorScheme): Record<string, string> {
  if (scheme === "light") return { ...DEFAULT_THEME, ...(spec.theme ?? {}) };
  // Light values like `background: #fff` must not leak into dark mode; brand and custom tokens do.
  const carried = Object.entries(spec.theme ?? {}).filter(([k]) => k === "accent" || !(k in DEFAULT_THEME));
  return { ...DARK_THEME, ...Object.fromEntries(carried), ...(spec.darkTheme ?? {}) };
}

export interface TextStyle {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  fontFamily?: "mono";
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

/**
 * Hosts render with the platform's own system font (SF, Roboto, the browser's
 * system-ui). Each host measures with the font it draws with, so layout is exact
 * per platform; line breaks may differ slightly between platforms.
 */
export const FONT_FAMILY = "system-ui";

// ---------- The format as data ----------
// What each node type takes and which style keys exist. The JSON Schema (`schema.ts`), the
// validator and the model's prompt are built from these tables, and the runtime's set of
// primitives is their keys, so none of them can drift from what renders.

/**
 * The kind of value a prop or style key takes. Every kind except `expr` and `path` also
 * takes a `{{binding}}` string. An array is a set of allowed words.
 */
export type ValueKind =
  | "text" // shown as text: a string, number or boolean
  | "string"
  | "number"
  | "boolean"
  | "color" // a theme token or #hex
  | "dim" // a number, "50%" or "fill"
  | "edges" // a number or [y, x] / [top, right, bottom, left]
  | "expr" // a bare expression, without {{ }}
  | "path" // a state or data path, such as "draft" or "chore.done"
  | "actions"
  | "node"
  | "nodeOrText"
  | "swipe"
  | "style"
  | "transition"
  | "fontWeight"
  | "align"
  | "justify"
  | "any"
  | readonly string[];

export interface NodeTypeInfo {
  /** One line for the model. */
  doc: string;
  props: Record<string, ValueKind>;
  /** Takes `children`. */
  children?: boolean;
}

const CONTAINER = { children: true, props: {} };

/** Primitive node types, besides the screen roots the runtime makes itself. */
export const NODE_TYPES: Record<string, NodeTypeInfo> = {
  column: { ...CONTAINER, doc: "children top to bottom" },
  row: { ...CONTAINER, doc: "children left to right" },
  overlay: { ...CONTAINER, doc: "children stacked on top of each other" },
  scroll: { ...CONTAINER, doc: "a vertical scroll view" },
  hscroll: { children: true, doc: "a horizontal scroll view; paging snaps to whole pages", props: { paging: "boolean", page: "number", onPage: "actions" } },
  canvas: { ...CONTAINER, doc: "a surface to pan in both directions and pinch to zoom" },
  spacer: { doc: "empty space that grows", props: {} },
  divider: { doc: "a hairline", props: {} },
  text: { doc: "text", props: { value: "text", variant: Object.keys(TYPOGRAPHY) } },
  button: { doc: "a button", props: { label: "text", variant: ["primary", "secondary", "plain", "danger"] } },
  textfield: {
    doc: "a text input; bind keeps its text",
    props: { placeholder: "text", bind: "path", value: "text", keyboard: ["default", "number"], secure: "boolean", onChange: "actions", onSubmit: "actions" },
  },
  toggle: { doc: "a switch; onChange gets the new value as `value`", props: { value: "boolean", bind: "path", onChange: "actions" } },
  shape: {
    doc: "an SVG path or a named shape (@star); trimStart/trimEnd 0..1 draw part of a stroke",
    props: { path: "string", fill: "color", stroke: "color", strokeWidth: "number", lineCap: ["butt", "round", "square"], viewBox: "string", trimStart: "number", trimEnd: "number" },
  },
  image: { doc: "an image from an https or data URL", props: { src: "string" } },
  list: {
    doc: "native rows, the way to show items",
    props: {
      items: "expr",
      row: "node",
      variant: ["inset", "plain"],
      header: "text",
      footer: "text",
      empty: "nodeOrText",
      swipe: "swipe",
      reorder: "boolean",
      separators: "boolean",
      rowStyle: "style",
    },
  },
  app: {
    doc: "another app embedded (the shell's)",
    props: { spec: "any", screen: "string", scale: "number", interactive: "boolean", selecting: "boolean", onSelect: "actions" },
  },
};

/** Keys every node takes. */
export const COMMON_PROPS: Record<string, ValueKind> = {
  type: "string",
  style: "style",
  if: "expr",
  each: "expr",
  as: "string",
  indexAs: "string",
  key: "expr",
  onTap: "actions",
};

export const STYLE_KEYS: Record<string, ValueKind> = {
  width: "dim", height: "dim",
  minWidth: "number", maxWidth: "number", minHeight: "number", maxHeight: "number",
  padding: "edges", paddingX: "number", paddingY: "number", paddingTop: "number", paddingRight: "number", paddingBottom: "number", paddingLeft: "number",
  margin: "edges", marginX: "number", marginY: "number", marginTop: "number", marginRight: "number", marginBottom: "number", marginLeft: "number",
  gap: "number",
  align: "align", alignItems: "align", justify: "justify", justifyContent: "justify", alignSelf: "align",
  grow: "number", flexGrow: "number", flex: "number", shrink: "number", flexShrink: "number",
  position: ["absolute", "relative"], top: "number", left: "number", right: "number", bottom: "number",
  aspectRatio: "number",
  background: "color", color: "color",
  radius: "number", borderWidth: "number", borderColor: "color",
  opacity: "number", clip: "boolean", shadow: "boolean",
  textAlign: ["left", "center", "right", "start", "end"],
  fontSize: "number", fontWeight: "fontWeight", fontFamily: ["mono"], lineHeight: "number",
  transition: "transition",
};

export const ACTION_KINDS = ["set", "toggle", "push", "remove", "navigate", "back", "if", "call"] as const;
export const FIELD_TYPES: FieldSpec["type"][] = ["string", "number", "boolean", "date", "datetime", "list", "object"];
