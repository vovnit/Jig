// Home-screen widgets: the app renders each widget headlessly at the widget's
// size, and hands the hosts a static tree to draw (widgets can't run JS).
// Built by running a Runtime on a recording host (like validate's stub host,
// but keeping the ops) and folding the ops into positioned draw items.

import type { Host, Op, Size, TextMeasureStyle } from "./bridge.ts";
import { withClock, str, freeIdentifiers } from "./expr.ts";
import { Runtime } from "./runtime.ts";
import type { AppSpec, NodeSpec, WidgetSizeName } from "./spec.ts";
import { WIDGET_SIZES, TYPOGRAPHY, COMMON_PROPS, NODE_TYPES, ASYNC_ACTIONS } from "./spec.ts";
import { TYPE_ALIASES } from "./builtins.ts";

export type { WidgetSizeName };
export { WIDGET_SIZES };

export interface WidgetFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetBox {
  kind: "box";
  frame: WidgetFrame;
  background?: string;
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
  opacity?: number;
  children: WidgetNode[];
}

export interface WidgetText {
  kind: "text";
  frame: WidgetFrame;
  text: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  align: string;
  fontFamily?: "mono";
}

export interface WidgetShape {
  kind: "shape";
  frame: WidgetFrame;
  path: string;
  viewBox: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  trimStart?: number;
  trimEnd?: number;
}

export interface WidgetImage {
  kind: "image";
  frame: WidgetFrame;
  src: string;
}

export type WidgetNode = WidgetBox | WidgetText | WidgetShape | WidgetImage;

export interface WidgetEntry {
  date: number;
  light: WidgetNode;
  dark: WidgetNode;
}

export interface WidgetUpdate {
  name: string;
  title: string;
  size: WidgetSizeName;
  open: string;
  entries: WidgetEntry[];
}

export type MeasureFn = (text: string, style: TextMeasureStyle, maxWidth: number) => Size;

/** The screen a tap on the widget opens (default the start screen). */
export function widgetOpen(spec: AppSpec, name: string): string {
  const w = spec.widgets?.[name];
  if (w?.open && spec.screens[w.open]) return w.open;
  return spec.start && spec.screens[spec.start] ? spec.start : Object.keys(spec.screens)[0] ?? "main";
}

export function widgetTitle(spec: AppSpec, name: string): string {
  return spec.widgets?.[name]?.title ?? name;
}

/** Whether the widget reads the time (`clock` or `now()`): then it gets a timeline. */
export function isWidgetTimeDependent(spec: AppSpec, name: string): boolean {
  const w = spec.widgets?.[name];
  if (!w) return false;
  // The same walk the validator uses for capability checks, so both agree on what
  // counts as reading the clock: style, props, rowStyle, swipe labels, spans, every
  // binding or bare expression, list rows and empty states, and component templates
  // with their usage's scope. `now()` counts in bindings, not in action values.
  const baseScope = new Set([...Object.keys(spec.data ?? {}), ...Object.keys(spec.state ?? {})]);
  const widgetScope = new Set([...baseScope, "widget"]);
  const components = spec.components && typeof spec.components === "object" ? spec.components : {};
  const hasTime = (ids: Iterable<string>, scope: Set<string>, allowNow: boolean): boolean => {
    for (const id of ids) {
      if (id === "now") {
        if (allowNow) return true;
        continue;
      }
      if (id === "clock" && !scope.has(id)) return true;
    }
    return false;
  };
  const bindingHasTime = (v: string, scope: Set<string>, allowNow = true): boolean => {
    try {
      return hasTime(freeIdentifiers(v), scope, allowNow);
    } catch {
      // Broken expressions are reported at render time.
      return false;
    }
  };
  const valueHasTime = (v: unknown, scope: Set<string>): boolean => {
    if (typeof v === "string") return bindingHasTime(v, scope, false);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const x of Object.values(v)) if (valueHasTime(x, scope)) return true;
    }
    return false;
  };
  const actionsHaveTime = (actions: unknown, scope: Set<string>): boolean => {
    for (const a of (Array.isArray(actions) ? actions : [actions]) as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const first = Object.keys(rec)[0];
      if (first && Object.hasOwn(ASYNC_ACTIONS, first)) {
        if (valueHasTime(rec[first], scope)) return true;
        const branch = rec as { then?: unknown; else?: unknown };
        if (branch.then && actionsHaveTime(branch.then, scope)) return true;
        if (branch.else && actionsHaveTime(branch.else, scope)) return true;
      } else if ("if" in rec) {
        const c = rec as { if?: unknown; then?: unknown; else?: unknown };
        if (typeof c.if === "string" && bindingHasTime(c.if, scope, false)) return true;
        if (c.then && actionsHaveTime(c.then, scope)) return true;
        if (c.else && actionsHaveTime(c.else, scope)) return true;
      }
      if ("set" in rec && typeof (rec as { to?: unknown }).to !== "undefined") {
        if (valueHasTime((rec as { to: unknown }).to, scope)) return true;
      }
      if ("push" in rec && typeof (rec as { value?: unknown }).value !== "undefined") {
        if (valueHasTime((rec as { value: unknown }).value, scope)) return true;
      }
      if ("remove" in rec) {
        const r = rec as { at?: unknown; where?: unknown };
        if (typeof r.at === "string" && bindingHasTime(r.at, scope, false)) return true;
        if (typeof r.where === "string" && bindingHasTime(r.where, scope, false)) return true;
      }
      if ("navigate" in rec && (rec as { params?: unknown }).params) {
        const params = (rec as { params: Record<string, unknown> }).params;
        if (params && typeof params === "object") {
          for (const v of Object.values(params)) if (valueHasTime(v, scope)) return true;
        }
      }
    }
    return false;
  };
  const checkNode = (n: NodeSpec, scope: Set<string>, chain: string[] = []): boolean => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return false;
    let inner = scope;
    if (typeof (n as { each?: unknown }).each === "string") {
      inner = new Set(scope);
      inner.add(typeof n.as === "string" && n.as ? n.as : "item");
      inner.add(typeof n.indexAs === "string" && n.indexAs ? n.indexAs : "index");
    }
    let rowScope: Set<string> | null = null;
    if (n.type === "list") {
      rowScope = new Set(scope);
      rowScope.add(typeof (n as { as?: unknown }).as === "string" && (n as { as?: string }).as ? (n as { as?: string }).as as string : "item");
      rowScope.add(typeof (n as { indexAs?: unknown }).indexAs === "string" && (n as { indexAs?: string }).indexAs ? (n as { indexAs?: string }).indexAs as string : "index");
      rowScope.add("$last");
    }
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("on") && v) {
        if (actionsHaveTime(v, rowScope ?? inner)) return true;
      } else if (k === "style" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const sv of Object.values(v)) {
          if (typeof sv === "string" && sv.includes("{{") && bindingHasTime(sv, inner)) return true;
        }
      } else if (k === "props" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const pv of Object.values(v)) {
          if (typeof pv === "string" && pv.includes("{{") && bindingHasTime(pv, inner)) return true;
        }
      } else if (k === "rowStyle" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const sv of Object.values(v)) {
          if (typeof sv === "string" && sv.includes("{{") && bindingHasTime(sv, rowScope ?? inner)) return true;
        }
      } else if (k === "swipe" && Array.isArray(v)) {
        for (const a of v as { label?: unknown }[]) {
          if (typeof a?.label === "string" && (a.label as string).includes("{{") && bindingHasTime(a.label as string, rowScope ?? inner)) return true;
        }
      } else if (k === "spans" && Array.isArray(v)) {
        for (const span of v as unknown[]) {
          if (!span || typeof span !== "object" || Array.isArray(span)) continue;
          for (const sk of ["text", "color", "link"]) {
            const sv = (span as Record<string, unknown>)[sk];
            if (typeof sv === "string" && sv.includes("{{") && bindingHasTime(sv, inner)) return true;
          }
        }
      } else if (typeof v === "string" && (v.includes("{{") || isBareExpr(n.type, k))) {
        if (k === "each") {
          if (bindingHasTime(v, scope)) return true;
        } else if (n.type === "list" && k === "items") {
          if (bindingHasTime(v, scope)) return true;
        } else if (n.type === "list" && (k === "as" || k === "indexAs")) continue;
        else if (n.type === "list" && k === "key") {
          if (bindingHasTime(v, rowScope ?? inner)) return true;
        } else if (bindingHasTime(v, inner)) return true;
      }
    }
    if (Array.isArray(n.children)) {
      for (let i = 0; i < n.children.length; i++) if (checkNode(n.children[i], inner, chain)) return true;
    }
    const resolved = TYPE_ALIASES[n.type] ?? n.type;
    const tmpl = (components as Record<string, NodeSpec>)[resolved];
    if (tmpl && !chain.includes(resolved)) {
      if (checkNode(tmpl, new Set([...inner, "props"]), [...chain, resolved])) return true;
    }
    if (n.type === "list") {
      if (checkNode(n.row as NodeSpec, rowScope ?? inner, chain)) return true;
      // A string `empty` is already checked above with the item scope; an object one has none.
      if (n.empty && typeof n.empty === "object" && checkNode(n.empty as NodeSpec, scope, chain)) return true;
      if (Array.isArray(n.swipe)) {
        for (const a of n.swipe as { do?: unknown }[]) if (a?.do && actionsHaveTime(a.do, rowScope ?? inner)) return true;
      }
    }
    return false;
  };
  return checkNode(w.body as NodeSpec, widgetScope);
}

/** A node prop written as a bare expression (no {{ }}): `if`, `each`, `key`, `items`. */
function isBareExpr(type: string, key: string): boolean {
  if ((COMMON_PROPS[key] as string) === "expr") return true;
  return ((NODE_TYPES[TYPE_ALIASES[type] ?? type]?.props[key] as string) ?? "") === "expr";
}

/**
 * Renders one widget at one size and time, in one color scheme. `onTap` inside
 * is ignored: the tree carries no handlers, a tap opens the app at `open`.
 */
export function renderWidget(
  spec: AppSpec,
  data: Record<string, unknown>,
  name: string,
  size: WidgetSizeName,
  now: number,
  measure: MeasureFn,
  scheme: "light" | "dark",
): WidgetNode {
  const { node } = renderOne(spec, data, name, size, now, measure, scheme);
  return node;
}

/** Both color schemes for one widget at one time. */
export function renderWidgetBoth(
  spec: AppSpec,
  data: Record<string, unknown>,
  name: string,
  size: WidgetSizeName,
  now: number,
  measure: MeasureFn,
): { light: WidgetNode; dark: WidgetNode } {
  return {
    light: renderWidget(spec, data, name, size, now, measure, "light"),
    dark: renderWidget(spec, data, name, size, now, measure, "dark"),
  };
}

/**
 * Timeline entries: one now, then one per minute for the next 30 minutes when
 * the widget reads the clock, else a single entry. Each entry is
 * `{date, light, dark}`.
 */
export function renderWidgetEntries(
  spec: AppSpec,
  data: Record<string, unknown>,
  name: string,
  size: WidgetSizeName,
  now: number,
  measure: MeasureFn,
): WidgetEntry[] {
  if (!isWidgetTimeDependent(spec, name)) {
    const both = renderWidgetBoth(spec, data, name, size, now, measure);
    return [{ date: now, ...both }];
  }
  const out: WidgetEntry[] = [];
  for (let i = 0; i <= 30; i++) {
    const date = now + i * 60000;
    const both = renderWidgetBoth(spec, data, name, size, date, measure);
    out.push({ date, ...both });
  }
  return out;
}

/** Every widget of the app at every listed size, for `widgets.set`. */
export function renderAppWidgets(
  spec: AppSpec,
  data: Record<string, unknown>,
  now: number,
  measure: MeasureFn,
): WidgetUpdate[] {
  const out: WidgetUpdate[] = [];
  for (const [name, w] of Object.entries(spec.widgets ?? {})) {
    if (!w || typeof w !== "object" || !Array.isArray(w.sizes) || !w.body) continue;
    for (const size of w.sizes) {
      if (!Object.hasOwn(WIDGET_SIZES, size)) continue;
      out.push({
        name,
        title: typeof w.title === "string" && w.title ? w.title : name,
        size: size as WidgetSizeName,
        open: widgetOpen(spec, name),
        entries: renderWidgetEntries(spec, data, name, size as WidgetSizeName, now, measure),
      });
    }
  }
  return out;
}

/** Error lines from rendering a widget body at one size (for validation). */
export function widgetErrors(
  spec: AppSpec,
  name: string,
  size: WidgetSizeName,
  measure: MeasureFn,
  now: number,
): string[] {
  const w = spec.widgets?.[name];
  if (!w) return [`widgets.${name}: unknown widget`];
  const out: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    const { errors } = renderOne(spec, {}, name, size, now, measure, scheme);
    for (const e of errors) {
      const line = `widgets.${name}.${size}: ${e.where}: ${e.message}`;
      if (!out.includes(line)) out.push(line);
    }
  }
  return out;
}

function renderOne(
  spec: AppSpec,
  data: Record<string, unknown>,
  name: string,
  size: WidgetSizeName,
  now: number,
  measure: MeasureFn,
  scheme: "light" | "dark",
): { node: WidgetNode; errors: { where: string; message: string }[] } {
  const w = spec.widgets?.[name];
  if (!w) throw new Error(`Unknown widget '${name}'`);
  const dims = WIDGET_SIZES[size];
  if (!dims) throw new Error(`Unknown widget size '${size}'`);
  return withClock(now, () => {
    const ops: Op[] = [];
    const frames: (() => void)[] = [];
    const host: Host = {
      apply: (batch) => void ops.push(...batch),
      measureText: (text, style, maxWidth) => measure(text, style, maxWidth),
      requestFrame: (cb) => void frames.push(cb),
    };
    const rt = new Runtime(host);
    rt.colorScheme = scheme;
    const copy: AppSpec = {
      ...spec,
      screens: { __widget: { body: w.body as NodeSpec, scroll: false, header: false } },
      start: "__widget",
      state: { ...(spec.state ?? {}), widget: { size, width: dims.width, height: dims.height } },
    };
    rt.setViewport(dims.width, dims.height);
    rt.load(copy, { fresh: true });
    for (const [k, v] of Object.entries(data)) {
      try {
        if (rt.signals.has(k)) rt.set(k, v);
      } catch {
        // A bad snapshot value never breaks the render.
      }
    }
    for (let i = 0; i < 10 && frames.length; i++) frames.splice(0).forEach((cb) => cb());
    const errors = [...rt.errors];
    let node: WidgetNode;
    try {
      node = foldOps(ops, dims.width, dims.height);
    } catch (e) {
      errors.push({ where: `widgets.${name}`, message: (e as Error).message });
      node = emptyBox(dims.width, dims.height);
    }
    rt.dispose();
    return { node, errors };
  });
}

interface Rec {
  type: string;
  props: Record<string, unknown>;
  style: Record<string, unknown>;
  children: number[];
  frame: [number, number, number, number] | null;
}

function foldOps(ops: Op[], width: number, height: number): WidgetNode {
  const recs = new Map<number, Rec>();
  const parentOf = new Map<number, number>();
  const drop = (id: number): void => {
    const r = recs.get(id);
    if (!r) return;
    for (const c of r.children) {
      parentOf.delete(c);
      drop(c);
    }
    recs.delete(id);
  };
  for (const op of ops) {
    if (op[0] === "create") {
      const [, id, type, props] = op;
      const { style, ...rest } = (props ?? {}) as Record<string, unknown>;
      recs.set(id, {
        type,
        props: { ...rest },
        style: style && typeof style === "object" ? { ...(style as Record<string, unknown>) } : {},
        children: [],
        frame: null,
      });
    } else if (op[0] === "update") {
      const [, id, props] = op;
      const r = recs.get(id);
      if (!r) continue;
      for (const [k, v] of Object.entries((props ?? {}) as Record<string, unknown>)) {
        if (k === "style" && v && typeof v === "object") {
          for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
            if (sv == null) delete r.style[sk];
            else r.style[sk] = sv;
          }
        } else r.props[k] = v;
      }
    } else if (op[0] === "insert") {
      const [, parent, child, index] = op;
      const p = recs.get(parent);
      if (!p || !recs.has(child)) continue;
      const at = parentOf.get(child);
      if (at !== undefined) {
        const old = recs.get(at);
        if (old) old.children = old.children.filter((c) => c !== child);
      }
      p.children = p.children.filter((c) => c !== child);
      p.children.splice(Math.max(0, Math.min(index, p.children.length)), 0, child);
      parentOf.set(child, parent);
    } else if (op[0] === "remove") {
      const [, parent, child] = op;
      const p = recs.get(parent);
      if (p) p.children = p.children.filter((c) => c !== child);
      parentOf.delete(child);
      drop(child);
    } else if (op[0] === "frame") {
      const [, id, x, y, fw, fh] = op;
      const r = recs.get(id);
      if (r) r.frame = [x, y, fw, fh];
    }
  }
  let rootId = [...recs.entries()].find(([, r]) => r.type === "root")?.[0];
  if (rootId === undefined) {
    const childed = new Set(parentOf.keys());
    rootId = [...recs.keys()].find((id) => !childed.has(id));
  }
  if (rootId === undefined) return emptyBox(width, height);
  const zero: WidgetFrame = { x: 0, y: 0, width: 0, height: 0 };
  return draw(recs, rootId, zero) ?? emptyBox(width, height);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function emptyBox(width: number, height: number): WidgetBox {
  return { kind: "box", frame: { x: 0, y: 0, width, height }, children: [] };
}

function draw(recs: Map<number, Rec>, id: number, parent: WidgetFrame): WidgetNode | null {
  const r = recs.get(id);
  if (!r) return null;
  const f = r.frame;
  const abs: WidgetFrame = f
    ? { x: round2(parent.x + f[0]), y: round2(parent.y + f[1]), width: round2(f[2]), height: round2(f[3]) }
    : { ...parent };
  if (r.type === "text") return drawText(r, abs);
  if (r.type === "shape") return drawShape(r, abs);
  if (r.type === "image") return { kind: "image", frame: abs, src: String(r.props.src ?? "") };
  if (r.type === "button") return drawButton(r, recs, abs);
  if (r.type === "textfield") return drawField(r, abs);
  const box = drawBox(r, abs);
  for (const c of r.children) {
    const child = draw(recs, c, abs);
    if (child) box.children.push(child);
  }
  return box;
}

function drawBox(r: Rec, abs: WidgetFrame): WidgetBox {
  const box: WidgetBox = { kind: "box", frame: abs, children: [] };
  const s = r.style;
  if (typeof s.background === "string" && s.background) box.background = s.background;
  if (Number.isFinite(Number(s.radius))) box.radius = Number(s.radius);
  if (Number.isFinite(Number(s.borderWidth))) box.borderWidth = Number(s.borderWidth);
  if (typeof s.borderColor === "string" && s.borderColor) box.borderColor = s.borderColor;
  if (Number.isFinite(Number(s.opacity))) box.opacity = Number(s.opacity);
  return box;
}

function drawText(r: Rec, abs: WidgetFrame): WidgetText {
  const s = r.style;
  const base = TYPOGRAPHY[String(r.props.variant ?? "body")] ?? TYPOGRAPHY.body;
  const fontSize = Number(s.fontSize ?? base.fontSize) || base.fontSize;
  const out: WidgetText = {
    kind: "text",
    frame: abs,
    text: str(r.props.value ?? ""),
    fontSize,
    fontWeight: Number(s.fontWeight ?? base.fontWeight) || base.fontWeight,
    lineHeight: Number(s.lineHeight ?? base.lineHeight) || base.lineHeight,
    color: typeof s.color === "string" && s.color ? s.color : "#14161a",
    align: typeof s.textAlign === "string" && s.textAlign ? s.textAlign : "left",
  };
  if (s.fontFamily === "mono") out.fontFamily = "mono";
  return out;
}

function drawShape(r: Rec, abs: WidgetFrame): WidgetShape {
  const out: WidgetShape = {
    kind: "shape",
    frame: abs,
    path: String(r.props.path ?? ""),
    viewBox: String(r.props.viewBox ?? "0 0 24 24"),
  };
  if (typeof r.props.fill === "string" && r.props.fill) out.fill = r.props.fill;
  if (typeof r.props.stroke === "string" && r.props.stroke) out.stroke = r.props.stroke;
  if (Number.isFinite(Number(r.props.strokeWidth))) out.strokeWidth = Number(r.props.strokeWidth);
  if (Number.isFinite(Number(r.props.trimStart))) out.trimStart = Number(r.props.trimStart);
  if (Number.isFinite(Number(r.props.trimEnd))) out.trimEnd = Number(r.props.trimEnd);
  return out;
}

function drawButton(r: Rec, recs: Map<number, Rec>, abs: WidgetFrame): WidgetBox {
  const box = drawBox(r, abs);
  const s = r.style;
  const base = TYPOGRAPHY.button;
  const fontSize = Number(s.fontSize ?? base.fontSize) || base.fontSize;
  box.children.push({
    kind: "text",
    frame: abs,
    text: str((r.props.label as unknown) ?? ""),
    fontSize,
    fontWeight: Number(s.fontWeight ?? base.fontWeight) || base.fontWeight,
    lineHeight: Number(s.lineHeight ?? base.lineHeight) || base.lineHeight,
    color: typeof s.color === "string" && s.color ? s.color : "#ffffff",
    align: "center",
  });
  for (const c of r.children) {
    const child = draw(recs, c, abs);
    if (child && child.kind !== "text") box.children.push(child);
  }
  return box;
}

function drawField(r: Rec, abs: WidgetFrame): WidgetBox {
  const box = drawBox(r, abs);
  const s = r.style;
  const base = TYPOGRAPHY.body;
  const value = r.props.value ?? r.props.placeholder ?? "";
  box.children.push({
    kind: "text",
    frame: abs,
    text: str(value),
    fontSize: Number(s.fontSize ?? base.fontSize) || base.fontSize,
    fontWeight: Number(s.fontWeight ?? base.fontWeight) || base.fontWeight,
    lineHeight: Number(s.lineHeight ?? base.lineHeight) || base.lineHeight,
    color: typeof s.color === "string" && s.color ? s.color : "#14161a",
    align: "left",
  });
  return box;
}
