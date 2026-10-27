// A flexbox subset in plain JS. The engine only talks to the host through
// `measureLeaf`, so it runs (and is tested) in Node with a fake measurer.
//
// Incremental: every node caches measurements by constraint, and a final layout
// pass skips a clean subtree whose constraints did not change (as in Yoga).
// Frames are relative to the parent, so a skipped subtree's frames stay valid.

import type { Size } from "./bridge.ts";

export type Dim = number | { pct: number };
export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "between" | "around" | "evenly";
type Edges = [top: number, right: number, bottom: number, left: number];

export interface Box {
  width?: Dim;
  height?: Dim;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  padding: Edges;
  margin: Edges;
  gap: number;
  align?: Align;
  justify: Justify;
  alignSelf?: Align;
  grow?: number;
  shrink?: number;
  absolute: boolean;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  aspectRatio?: number;
}

export const LAYOUT_KEYS = new Set([
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "padding", "paddingX", "paddingY", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "margin", "marginX", "marginY", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "gap", "align", "alignItems", "justify", "justifyContent", "alignSelf", "grow", "flexGrow", "shrink", "flexShrink",
  "position", "top", "left", "right", "bottom", "aspectRatio",
]);

export type Frame = [x: number, y: number, w: number, h: number];

/**
 * The rows of a `list`: only some items have a row node (the window around the
 * visible part), the rest are stacked by their last measured or estimated height.
 */
export interface VirtualRows {
  /** Number of items, with or without a row. */
  count(): number;
  /** Item index of a row node. */
  indexOf(row: ViewNode): number;
  /** Records a row's measured height at this width. */
  measured(index: number, height: number, width: number): void;
  /** Top of item `index`; `top(count())` is the total height. */
  top(index: number): number;
}

let nextId = 1;
export function resetIds(): void {
  nextId = 1;
}

export class ViewNode {
  id = nextId++;
  type: string;
  /** Visual props sent to the host. */
  props: Record<string, unknown> = {};
  box: Box = parseBox({});
  children: ViewNode[] = [];
  parent: ViewNode | null = null;
  mounted = false;
  alive = true;

  // Layout state
  dirty = true;
  measureCache = new Map<string, Size>();
  lastLayoutKey: string | null = null;
  lastSize: Size = { width: 0, height: 0 };
  frame: Frame = [0, 0, 0, 0];
  sentFrame: Frame | null = null;
  contentSize: Size | null = null;
  /** Natural size reported by the host (images). */
  intrinsic: Size | null = null;
  /** Set on a list's body: its children are a window of rows over all items. */
  virtual: VirtualRows | null = null;

  constructor(type: string) {
    this.type = type;
  }

  markDirty(): void {
    // Invariant: a dirty node's ancestors are dirty and nothing was measured since,
    // so the walk can stop at the first ancestor that is already dirty.
    this.measureCache.clear();
    this.dirty = true;
    let n = this.parent;
    while (n && !n.dirty) {
      n.measureCache.clear();
      n.dirty = true;
      n = n.parent;
    }
  }
}

// ---------- Style parsing ----------

function num(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return undefined;
}

function dim(v: unknown): Dim | undefined {
  if (typeof v === "string" && v.trim().endsWith("%")) {
    const p = Number(v.trim().slice(0, -1));
    return isNaN(p) ? undefined : { pct: p / 100 };
  }
  if (v === "fill" || v === "100%") return { pct: 1 };
  return num(v);
}

function edges(s: Record<string, unknown>, base: string): Edges {
  const e: Edges = [0, 0, 0, 0];
  const all = s[base];
  if (Array.isArray(all)) {
    const a = all.map((x) => num(x) ?? 0);
    if (a.length === 2) e.splice(0, 4, a[0], a[1], a[0], a[1]);
    else if (a.length === 4) e.splice(0, 4, a[0], a[1], a[2], a[3]);
    else if (a.length === 1) e.fill(a[0]);
  } else if (num(all) !== undefined) e.fill(num(all)!);
  const x = num(s[base + "X"]);
  const y = num(s[base + "Y"]);
  if (x !== undefined) e[1] = e[3] = x;
  if (y !== undefined) e[0] = e[2] = y;
  const sides = ["Top", "Right", "Bottom", "Left"];
  sides.forEach((side, i) => {
    const v = num(s[base + side]);
    if (v !== undefined) e[i] = v;
  });
  return e;
}

const ALIGN_ALIASES: Record<string, Align> = {
  start: "start", "flex-start": "start", leading: "start", top: "start", left: "start",
  center: "center", middle: "center",
  end: "end", "flex-end": "end", trailing: "end", bottom: "end", right: "end",
  stretch: "stretch", fill: "stretch",
};

const JUSTIFY_ALIASES: Record<string, Justify> = {
  ...(ALIGN_ALIASES as Record<string, Justify>),
  stretch: "start",
  between: "between", "space-between": "between", spaceBetween: "between",
  around: "around", "space-around": "around", spaceAround: "around",
  evenly: "evenly", "space-evenly": "evenly", spaceEvenly: "evenly",
};

export function parseBox(s: Record<string, unknown>): Box {
  const align = s.align ?? s.alignItems;
  const justify = s.justify ?? s.justifyContent;
  return {
    width: dim(s.width),
    height: dim(s.height),
    minWidth: num(s.minWidth),
    maxWidth: num(s.maxWidth),
    minHeight: num(s.minHeight),
    maxHeight: num(s.maxHeight),
    padding: edges(s, "padding"),
    margin: edges(s, "margin"),
    gap: num(s.gap) ?? 0,
    align: typeof align === "string" ? ALIGN_ALIASES[align] : undefined,
    justify: (typeof justify === "string" && JUSTIFY_ALIASES[justify]) || "start",
    alignSelf: typeof s.alignSelf === "string" ? ALIGN_ALIASES[s.alignSelf] : undefined,
    grow: num(s.grow ?? s.flexGrow ?? (s.flex === undefined ? undefined : s.flex)),
    shrink: num(s.shrink ?? s.flexShrink),
    absolute: s.position === "absolute",
    top: num(s.top),
    left: num(s.left),
    right: num(s.right),
    bottom: num(s.bottom),
    aspectRatio: num(s.aspectRatio),
  };
}

// ---------- Engine ----------

export interface LayoutContext {
  /** Content size of a leaf (text, button, toggle, image...) given the space inside its padding. */
  measureLeaf(node: ViewNode, maxWidth: number, maxHeight: number, exactWidth: boolean): Size;
  /** Called for every node whose frame changed in this pass. */
  onFrame(node: ViewNode): void;
  stats: { measured: number; cacheHits: number; skipped: number };
}

const CONTAINERS = new Set(["root", "screen", "column", "row", "overlay", "stack", "scroll", "hscroll"]);
export const isContainer = (type: string) => CONTAINERS.has(type);
const isRowType = (type: string) => type === "row" || type === "hscroll";

function resolve(d: Dim | undefined, base: number): number | undefined {
  if (d === undefined) return undefined;
  if (typeof d === "number") return d;
  return isFinite(base) ? d.pct * base : undefined;
}

function clamp(v: number, min: number | undefined, max: number | undefined): number {
  if (max !== undefined && v > max) v = max;
  if (min !== undefined && v < min) v = min;
  return Math.max(0, v);
}

function defaultGrow(child: ViewNode, parentIsRow: boolean): number {
  if (child.box.grow !== undefined) return child.box.grow;
  if (child.type === "spacer") return 1;
  if (child.type === "textfield" && parentIsRow) return 1;
  return 0;
}

export function layoutRoot(root: ViewNode, width: number, height: number, ctx: LayoutContext): void {
  layoutNode(root, width, true, height, true, true, ctx);
  setFrame(root, 0, 0, width, height, ctx);
}

function setFrame(n: ViewNode, x: number, y: number, w: number, h: number, ctx: LayoutContext): void {
  const f = n.frame;
  if (f[0] === x && f[1] === y && f[2] === w && f[3] === h && n.sentFrame) return;
  n.frame = [x, y, w, h];
  ctx.onFrame(n);
}

/**
 * Computes the node's size under the given constraints. `perform` also positions
 * children (final pass); otherwise it only measures and may hit the cache.
 * Infinity means unbounded; `exact` means the parent decided the size.
 */
export function layoutNode(
  node: ViewNode,
  w: number, wExact: boolean,
  h: number, hExact: boolean,
  perform: boolean,
  ctx: LayoutContext,
): Size {
  const key = `${w}|${wExact ? 1 : 0}|${h}|${hExact ? 1 : 0}`;
  if (perform && !node.dirty && node.lastLayoutKey === key) {
    ctx.stats.skipped++;
    return node.lastSize;
  }
  // Leaves have nothing to position, so a measurement doubles as their layout.
  const hit = !perform || !isContainer(node.type) ? node.measureCache.get(key) : undefined;
  if (hit) {
    ctx.stats.cacheHits++;
    if (perform) {
      node.lastLayoutKey = key;
      node.lastSize = hit;
      node.dirty = false;
    }
    return hit;
  }

  const size = node.virtual
    ? layoutVirtual(node, w, wExact, h, hExact, perform, ctx)
    : isContainer(node.type)
    ? node.type === "overlay" || node.type === "stack"
      ? layoutOverlay(node, w, wExact, h, hExact, perform, ctx)
      : layoutFlex(node, w, wExact, h, hExact, perform, ctx)
    : layoutLeaf(node, w, wExact, h, hExact);

  node.measureCache.set(key, size);
  if (perform) {
    node.lastLayoutKey = key;
    node.lastSize = size;
    node.dirty = false;
    if (!isContainer(node.type)) clearSubtree(node);
  }
  return size;

  function layoutLeaf(n: ViewNode, w: number, wExact: boolean, h: number, hExact: boolean): Size {
    const b = n.box;
    const padX = b.padding[1] + b.padding[3];
    const padY = b.padding[0] + b.padding[2];
    const maxW = (wExact ? w : Math.min(w, b.maxWidth ?? Infinity)) - padX;
    const maxH = (hExact ? h : h) - padY;
    ctx.stats.measured++;
    const c = ctx.measureLeaf(n, Math.max(0, maxW), Math.max(0, maxH), wExact);
    let width = wExact ? w : clamp(Math.min(c.width + padX, w), b.minWidth, b.maxWidth);
    let height = hExact ? h : clamp(c.height + padY, b.minHeight, b.maxHeight);
    if (b.aspectRatio && !hExact) height = width / b.aspectRatio;
    else if (b.aspectRatio && !wExact) width = Math.min(height * b.aspectRatio, w);
    return { width, height };
  }
}

function clearSubtree(n: ViewNode): void {
  for (const c of n.children) {
    c.dirty = false;
    clearSubtree(c);
  }
}

interface ChildPlan {
  node: ViewNode;
  main: number;
  cross: number;
  crossExact: boolean;
  crossAvail: number;
  basis: number;
  mainFixed: boolean;
}

function layoutFlex(
  node: ViewNode,
  w: number, wExact: boolean,
  h: number, hExact: boolean,
  perform: boolean,
  ctx: LayoutContext,
): Size {
  const b = node.box;
  const row = isRowType(node.type);
  const scrolls = node.type === "scroll" || node.type === "hscroll";
  const [pt, pr, pb, pl] = b.padding;

  const innerW = Math.max(0, w - pl - pr);
  const innerH = Math.max(0, h - pt - pb);
  const mainAvail = scrolls ? Infinity : row ? innerW : innerH;
  const mainExact = !scrolls && (row ? wExact : hExact);
  const crossAvail = row ? innerH : innerW;
  const crossExact = row ? hExact : wExact;
  const alignItems: Align = b.align ?? "stretch";

  const items = node.children.filter((c) => !c.box.absolute);
  const gaps = items.length > 1 ? b.gap * (items.length - 1) : 0;

  // Constraints in (main, cross) terms → (w, h)
  const measure = (c: ViewNode, main: number, mainEx: boolean, cross: number, crossEx: boolean, doPerform: boolean): Size =>
    row
      ? layoutNode(c, main, mainEx, cross, crossEx, doPerform, ctx)
      : layoutNode(c, cross, crossEx, main, mainEx, doPerform, ctx);
  const mainOf = (s: Size) => (row ? s.width : s.height);
  const crossOf = (s: Size) => (row ? s.height : s.width);

  // 1. Flex basis and cross constraints
  const plans: ChildPlan[] = items.map((c) => {
    const cb = c.box;
    const mMain = row ? cb.margin[1] + cb.margin[3] : cb.margin[0] + cb.margin[2];
    const mCross = row ? cb.margin[0] + cb.margin[2] : cb.margin[1] + cb.margin[3];
    const align = cb.alignSelf ?? alignItems;
    const fixedCross = resolve(row ? cb.height : cb.width, crossAvail);
    let cross: number;
    let cExact: boolean;
    if (fixedCross !== undefined) {
      cross = clamp(fixedCross, row ? cb.minHeight : cb.minWidth, row ? cb.maxHeight : cb.maxWidth);
      cExact = true;
    } else if (align === "stretch" && crossExact) {
      cross = Math.max(0, crossAvail - mCross);
      cExact = true;
    } else {
      cross = Math.max(0, crossAvail - mCross);
      cExact = false;
    }
    const fixedMain = resolve(row ? cb.width : cb.height, mainAvail);
    let basis: number;
    if (fixedMain !== undefined) {
      basis = clamp(fixedMain, row ? cb.minWidth : cb.minHeight, row ? cb.maxWidth : cb.maxHeight);
    } else {
      basis = mainOf(measure(c, Infinity, false, cross, cExact, false));
    }
    return { node: c, main: basis, basis, cross, crossExact: cExact, crossAvail: cross, mainFixed: fixedMain !== undefined };
  });

  // 2. Resolve flexible lengths
  const marginMain = (c: ViewNode) => (row ? c.box.margin[1] + c.box.margin[3] : c.box.margin[0] + c.box.margin[2]);
  const used = plans.reduce((a, p) => a + p.basis + marginMain(p.node), 0) + gaps;
  const innerMain = mainExact ? mainAvail : isFinite(mainAvail) ? Math.min(used, mainAvail) : used;
  const free = innerMain - used;
  if (free > 0 && mainExact) {
    const totalGrow = plans.reduce((a, p) => a + defaultGrow(p.node, row), 0);
    if (totalGrow > 0) {
      for (const p of plans) {
        const g = defaultGrow(p.node, row);
        if (g > 0) p.main = p.basis + (free * g) / totalGrow;
      }
    }
  } else if (free < 0) {
    // As CSS `min-height: auto`: in a column only scroll views shrink below their content by default,
    // so a long scroll body never squeezes a header. In a row, items shrink so text can wrap.
    const defaultShrink = (n: ViewNode) => (row || n.type === "scroll" || n.type === "hscroll" ? 1 : 0);
    const weight = (p: ChildPlan) => (p.mainFixed && p.node.box.shrink === undefined ? 0 : (p.node.box.shrink ?? defaultShrink(p.node)) * p.basis);
    const total = plans.reduce((a, p) => a + weight(p), 0);
    if (total > 0) {
      for (const p of plans) {
        const cb = p.node.box;
        p.main = clamp(p.basis + (free * weight(p)) / total, row ? cb.minWidth : cb.minHeight, undefined);
      }
    }
  }

  // 3. Cross sizes at the final main sizes
  for (const p of plans) {
    const s = measure(p.node, p.main, true, p.cross, p.crossExact, false);
    p.cross = crossOf(s);
  }
  const contentCross = plans.reduce((a, p) => {
    const cb = p.node.box;
    const mCross = row ? cb.margin[0] + cb.margin[2] : cb.margin[1] + cb.margin[3];
    return Math.max(a, p.cross + mCross);
  }, 0);
  let containerCross = crossExact ? crossAvail : Math.min(contentCross, crossAvail);
  const minCross = row ? b.minHeight : b.minWidth;
  const maxCross = row ? b.maxHeight : b.maxWidth;
  if (!crossExact) containerCross = clamp(containerCross + (row ? pt + pb : pl + pr), minCross, maxCross) - (row ? pt + pb : pl + pr);

  // Stretch children to a cross size that was only known after measuring.
  for (const p of plans) {
    const cb = p.node.box;
    const align = cb.alignSelf ?? alignItems;
    const hasFixedCross = (row ? cb.height : cb.width) !== undefined;
    if (align === "stretch" && !hasFixedCross && !p.crossExact) {
      const mCross = row ? cb.margin[0] + cb.margin[2] : cb.margin[1] + cb.margin[3];
      p.cross = Math.max(0, containerCross - mCross);
      p.crossExact = true;
    }
  }

  const sumMain = plans.reduce((a, p) => a + p.main + marginMain(p.node), 0) + gaps;
  const outerMain = row ? pl + pr : pt + pb;
  const outerCross = row ? pt + pb : pl + pr;
  let width: number;
  let height: number;
  if (row) {
    width = wExact ? w : clamp(Math.min(sumMain + outerMain, w), b.minWidth, b.maxWidth);
    height = hExact ? h : containerCross + outerCross;
  } else {
    width = wExact ? w : containerCross + outerCross;
    height = hExact ? h : clamp(Math.min(sumMain + outerMain, h), b.minHeight, b.maxHeight);
  }
  if (b.aspectRatio && !hExact && wExact) height = width / b.aspectRatio;

  if (scrolls) node.contentSize = row ? { width: sumMain + outerMain, height } : { width, height: sumMain + outerMain };

  if (perform) {
    // 4. Position
    const mainSize = (row ? width : height) - outerMain;
    const remaining = scrolls ? 0 : Math.max(0, mainSize - sumMain);
    const n = plans.length;
    let offset = 0;
    let between = b.gap;
    switch (b.justify) {
      case "center": offset = remaining / 2; break;
      case "end": offset = remaining; break;
      case "between": if (n > 1) between += remaining / (n - 1); break;
      case "around": offset = remaining / n / 2; between += remaining / n; break;
      case "evenly": offset = remaining / (n + 1); between += remaining / (n + 1); break;
    }
    const crossSize = (row ? height : width) - outerCross;
    let cursor = (row ? pl : pt) + offset;
    for (const p of plans) {
      const c = p.node;
      const cb = c.box;
      const s = measure(c, p.main, true, p.cross, p.crossExact, true);
      const [mt, mr, mb, ml] = cb.margin;
      const mStart = row ? ml : mt;
      const mEnd = row ? mr : mb;
      const cStart = row ? mt : ml;
      const cEnd = row ? mb : mr;
      const align = cb.alignSelf ?? alignItems;
      const free = crossSize - crossOf(s) - cStart - cEnd;
      const crossPos = (row ? pt : pl) + cStart + (align === "center" ? free / 2 : align === "end" ? free : 0);
      const mainPos = cursor + mStart;
      if (row) setFrame(c, round(mainPos), round(crossPos), round(s.width), round(s.height), ctx);
      else setFrame(c, round(crossPos), round(mainPos), round(s.width), round(s.height), ctx);
      cursor = mainPos + mainOf(s) + mEnd + between;
    }
    layoutAbsolute(node, width, height, ctx);
  }
  return { width, height };
}

function layoutOverlay(
  node: ViewNode,
  w: number, wExact: boolean,
  h: number, hExact: boolean,
  perform: boolean,
  ctx: LayoutContext,
): Size {
  const b = node.box;
  const [pt, pr, pb, pl] = b.padding;
  const innerW = Math.max(0, w - pl - pr);
  const innerH = Math.max(0, h - pt - pb);
  const alignItems: Align = b.align ?? "center";
  const items = node.children.filter((c) => !c.box.absolute);

  const constraint = (c: ViewNode, availW: number, availH: number, exactW: boolean, exactH: boolean) => {
    const align = c.box.alignSelf ?? alignItems;
    const fw = resolve(c.box.width, availW);
    const fh = resolve(c.box.height, availH);
    return {
      w: fw ?? availW,
      wEx: fw !== undefined || (align === "stretch" && exactW),
      h: fh ?? availH,
      hEx: fh !== undefined || (align === "stretch" && exactH),
    };
  };

  let maxW = 0;
  let maxH = 0;
  for (const c of items) {
    const k = constraint(c, innerW, innerH, wExact, hExact);
    const s = layoutNode(c, k.w, k.wEx, k.h, k.hEx, false, ctx);
    maxW = Math.max(maxW, s.width);
    maxH = Math.max(maxH, s.height);
  }
  const width = wExact ? w : clamp(Math.min(maxW + pl + pr, w), b.minWidth, b.maxWidth);
  const height = hExact ? h : clamp(Math.min(maxH + pt + pb, h), b.minHeight, b.maxHeight);

  if (perform) {
    const cw = width - pl - pr;
    const ch = height - pt - pb;
    for (const c of items) {
      const k = constraint(c, cw, ch, true, true);
      const s = layoutNode(c, k.w, k.wEx, k.h, k.hEx, true, ctx);
      const align = c.box.alignSelf ?? alignItems;
      const fx = cw - s.width;
      const fy = ch - s.height;
      const t = align === "start" ? 0 : align === "end" ? 1 : align === "stretch" ? 0 : 0.5;
      setFrame(c, round(pl + fx * t), round(pt + fy * t), round(s.width), round(s.height), ctx);
    }
    layoutAbsolute(node, width, height, ctx);
  }
  return { width, height };
}

/** A list body: rows stacked at their item's offset, full width; items without a row only take space. */
function layoutVirtual(
  node: ViewNode,
  w: number, wExact: boolean,
  h: number, hExact: boolean,
  perform: boolean,
  ctx: LayoutContext,
): Size {
  const v = node.virtual!;
  const b = node.box;
  const [pt, pr, pb, pl] = b.padding;
  const rows = node.children.filter((c) => !c.box.absolute);
  const innerW = isFinite(w)
    ? Math.max(0, w - pl - pr)
    : rows.reduce((a, c) => Math.max(a, layoutNode(c, Infinity, false, Infinity, false, false, ctx).width), 0);
  for (const c of rows) v.measured(v.indexOf(c), layoutNode(c, innerW, true, Infinity, false, false, ctx).height, innerW);
  const width = wExact || isFinite(w) ? w : innerW + pl + pr;
  const height = hExact ? h : clamp(v.top(v.count()) + pt + pb, b.minHeight, b.maxHeight);
  if (perform) {
    for (const c of rows) {
      const s = layoutNode(c, innerW, true, Infinity, false, true, ctx);
      setFrame(c, round(pl), round(pt + v.top(v.indexOf(c))), round(s.width), round(s.height), ctx);
    }
    layoutAbsolute(node, width, height, ctx);
  }
  return { width, height };
}

function layoutAbsolute(node: ViewNode, width: number, height: number, ctx: LayoutContext): void {
  for (const c of node.children) {
    const cb = c.box;
    if (!cb.absolute) continue;
    let cw = resolve(cb.width, width);
    let ch = resolve(cb.height, height);
    if (cw === undefined && cb.left !== undefined && cb.right !== undefined) cw = Math.max(0, width - cb.left - cb.right);
    if (ch === undefined && cb.top !== undefined && cb.bottom !== undefined) ch = Math.max(0, height - cb.top - cb.bottom);
    const s = layoutNode(c, cw ?? width, cw !== undefined, ch ?? height, ch !== undefined, true, ctx);
    const x = cb.left ?? (cb.right !== undefined ? width - cb.right - s.width : 0);
    const y = cb.top ?? (cb.bottom !== undefined ? height - cb.bottom - s.height : 0);
    setFrame(c, round(x), round(y), round(s.width), round(s.height), ctx);
  }
}

// Snap to quarter points: stable across platforms and avoids sub-pixel drift.
function round(v: number): number {
  return Math.round(v * 4) / 4;
}
