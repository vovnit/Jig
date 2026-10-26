// The shared runtime: spec → view tree with fine-grained bindings → layout →
// one batch of ops per frame. Hosts feed back events and measurements.
//
//   event → actions update state → bound effects update specific nodes
//         → dirty layout → frame: incremental layout → ops batch → host.apply

import type { Host, Op, Props, Size } from "./bridge.ts";
import { BUILTIN_COMPONENTS, COLOR_KEYS, SHAPES, TYPE_ALIASES, defaultStyle } from "./builtins.ts";
import { type Compiled, type Scope, childScope, compile, compilePath, compileTemplate, setIn, str } from "./expr.ts";
import { type Box, LAYOUT_KEYS, ViewNode, isContainer, layoutRoot, parseBox } from "./layout.ts";
import { type Owner, Signal, effect, getOwner, root, untrack } from "./signals.ts";
import { type Action, type Actions, type AppSpec, DEFAULT_THEME, type FieldSpec, type NodeSpec, type ScreenSpec, TYPOGRAPHY, type TextStyle } from "./spec.ts";

const RESERVED = new Set(["type", "style", "children", "child", "if", "each", "as", "indexAs", "key", "bind", "onTap", "onChange", "onSubmit", "props"]);
const MEASURED_PROPS = new Set(["value", "label", "variant", "src", "placeholder"]);
const TEXT_METRIC_KEYS = ["fontSize", "fontWeight", "lineHeight"] as const;

interface Handlers {
  scope: Scope;
  onTap?: Actions;
  onChange?: Actions;
  onSubmit?: Actions;
  bind?: string;
}

interface Slot {
  nodes: ViewNode[];
}

export interface FrameStats {
  bindingsMs: number;
  layoutMs: number;
  measureMs: number;
  measureCalls: number;
  measureCacheHits: number;
  layoutCacheHits: number;
  skippedSubtrees: number;
  applyMs: number;
  ops: number;
}

export interface RuntimeError {
  where: string;
  message: string;
}

const now = (host: Host) => host.now?.() ?? (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

function defaultFor(f: FieldSpec): unknown {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case "list": return [];
    case "number": return 0;
    case "boolean": return false;
    case "object": return {};
    default: return "";
  }
}

export class Runtime {
  host: Host;
  spec!: AppSpec;
  theme: Record<string, string> = DEFAULT_THEME;
  components: Record<string, NodeSpec> = BUILTIN_COMPONENTS;

  signals = new Map<string, Signal<unknown>>();
  dataKeys = new Set<string>();
  nav = new Signal<{ screen: string; params: Record<string, unknown> }[]>([]);

  root: ViewNode;
  nodes = new Map<number, ViewNode>();
  handlers = new Map<number, Handlers>();
  /** Last value reported by native for text inputs; native is the source of truth while typing. */
  nativeValues = new Map<number, unknown>();
  scrollNodes = new Set<ViewNode>();
  textStyles = new Map<ViewNode, TextStyle>();

  viewport = { width: 390, height: 844, insets: [0, 0, 0, 0] as [number, number, number, number] };
  errors: RuntimeError[] = [];
  stats: FrameStats = emptyStats();
  onStats?: (s: FrameStats) => void;

  private structural: Op[] = [];
  private updates = new Map<ViewNode, Props>();
  private frameRequested = false;
  private saveRequested = false;
  private appOwner: Owner | null = null;
  private textCache = new Map<string, Size>();
  private globalScope: Scope;

  constructor(host: Host) {
    this.host = host;
    this.root = this.createNode("root");
    this.mount(this.root);
    const signals = this.signals;
    this.globalScope = {
      lookup: (name) => {
        const s = signals.get(name);
        if (s) return s.get();
        if (name === "params") return this.nav.get().at(-1)?.params ?? {};
        return undefined;
      },
      has: (name) => signals.has(name) || name === "params",
    };
  }

  // ---------- Public API ----------

  /**
   * Loads (or hot-reloads) a spec. On a hot reload, state of keys that survive the
   * edit and the navigation stack are kept; `fresh` starts a different app clean.
   */
  load(spec: AppSpec, { fresh = false } = {}): void {
    this.appOwner?.dispose();
    if (fresh) {
      this.signals.clear();
      this.nav = new Signal<{ screen: string; params: Record<string, unknown> }[]>([]);
    }
    this.spec = spec;
    this.theme = { ...DEFAULT_THEME, ...(spec.theme ?? {}) };
    this.components = { ...BUILTIN_COMPONENTS, ...(spec.components ?? {}) };
    this.errors = [];

    const stored = this.readStorage(spec.id);
    const next = new Map<string, Signal<unknown>>();
    this.dataKeys = new Set(Object.keys(spec.data ?? {}));
    for (const [k, f] of Object.entries(spec.data ?? {})) {
      const prev = this.signals.get(k);
      next.set(k, prev ?? new Signal(k in stored ? stored[k] : defaultFor(f)));
    }
    for (const [k, v] of Object.entries(spec.state ?? {})) {
      next.set(k, this.signals.get(k) ?? new Signal(v));
    }
    this.signals.clear();
    for (const [k, s] of next) this.signals.set(k, s);

    const start = spec.start && spec.screens[spec.start] ? spec.start : Object.keys(spec.screens)[0];
    const keepNav = this.nav.peek().filter((e) => spec.screens[e.screen]);
    this.nav.set(keepNav.length ? keepNav : [{ screen: start, params: {} }]);

    root(() => {
      this.appOwner = getOwner();
      // Persist data whenever it changes.
      effect(() => {
        for (const k of this.dataKeys) this.signals.get(k)?.get();
        untrack(() => this.requestSave());
      });
      effect(() => {
        const top = this.nav.get().at(-1);
        untrack(() => this.showScreen(top?.screen ?? start));
      });
    }, null);
    this.scheduleFrame();
  }

  setViewport(width: number, height: number, insets: [number, number, number, number] = [0, 0, 0, 0]): void {
    this.viewport = { width, height, insets };
    this.root.markDirty();
    this.scheduleFrame();
  }

  /** Entry point for host events. */
  dispatch(id: number, name: string, payload: Record<string, unknown> = {}): void {
    const t0 = now(this.host);
    const node = this.nodes.get(id);
    if (!node) return;
    if (name === "load") {
      const width = Number(payload.width) || 0;
      const height = Number(payload.height) || 0;
      if (!node.intrinsic || node.intrinsic.width !== width || node.intrinsic.height !== height) {
        node.intrinsic = { width, height };
        node.markDirty();
        this.scheduleFrame();
      }
      return;
    }
    const h = this.handlers.get(id);
    if (!h) return;
    // Actions run sequentially without batching, so each one sees the state the previous one wrote.
    {
      if (name === "tap" && h.onTap) this.run(h.onTap, h.scope);
      if (name === "change") {
        const value = payload.value;
        this.nativeValues.set(id, value);
        node.props.value = value;
        if (h.bind) this.assign(h.bind, h.scope, coerce(value, this.peekPath(h.bind, h.scope)));
        if (h.onChange) this.run(h.onChange, childScope(h.scope, { value }));
      }
      if (name === "submit" && h.onSubmit) this.run(h.onSubmit, h.scope);
    }
    this.stats.bindingsMs += now(this.host) - t0;
  }

  /** Runs layout and sends the batch. Hosts normally reach this through requestFrame. */
  flush(): void {
    this.frameRequested = false;
    const frames: Op[] = [];
    const ctx = {
      stats: { measured: 0, cacheHits: 0, skipped: 0 },
      measureLeaf: (n: ViewNode, maxW: number, maxH: number, exactW: boolean) => this.measureLeaf(n, maxW, maxH, exactW),
      onFrame: (n: ViewNode) => {
        n.sentFrame = n.frame;
        if (n.mounted) frames.push(["frame", n.id, ...n.frame]);
      },
    };
    const t0 = now(this.host);
    if (this.root.dirty) {
      const { width, height, insets } = this.viewport;
      this.root.box = parseBox({ paddingTop: insets[0], paddingRight: insets[1], paddingBottom: insets[2], paddingLeft: insets[3] });
      layoutRoot(this.root, width, height, ctx);
    }
    this.stats.layoutMs += now(this.host) - t0 - this.stats.measureMs;
    this.stats.layoutCacheHits += ctx.stats.cacheHits;
    this.stats.skippedSubtrees += ctx.stats.skipped;

    for (const s of this.scrollNodes) {
      const c = s.contentSize;
      if (c && s.mounted) {
        const prev = s.props.contentSize as [number, number] | undefined;
        if (!prev || prev[0] !== c.width || prev[1] !== c.height) this.setProp(s, "contentSize", [c.width, c.height]);
      }
    }

    const ops: Op[] = this.structural;
    this.structural = [];
    for (const [node, props] of this.updates) if (node.alive && node.mounted) ops.push(["update", node.id, props]);
    this.updates.clear();
    ops.push(...frames);

    if (ops.length) {
      const t1 = now(this.host);
      this.host.apply(ops);
      this.stats.applyMs += now(this.host) - t1;
    }
    this.stats.ops += ops.length;
    if (this.saveRequested) this.save();
    const done = this.stats;
    this.stats = emptyStats();
    this.onStats?.(done);
  }

  /** Current value of a state or data key (for hosts, tests and the container). */
  get(key: string): unknown {
    return this.signals.get(key)?.peek();
  }

  set(key: string, value: unknown): void {
    this.signals.get(key)?.set(value);
  }

  // ---------- Screens ----------

  private screenOwner: (() => void) | null = null;

  private showScreen(name: string): void {
    this.screenOwner?.();
    this.screenOwner = null;
    const screen: ScreenSpec | undefined = this.spec.screens[name];
    if (!screen) {
      this.error(`screens.${name}`, "Unknown screen");
      return;
    }
    root((dispose) => {
      this.screenOwner = dispose;
      const node = this.buildNode(this.screenSpec(screen), this.globalScope, `screens.${name}`);
      this.setChildren(this.root, [node]);
    }, this.appOwner);
    this.scheduleFrame();
  }

  private screenSpec(screen: ScreenSpec): NodeSpec {
    const children: NodeSpec[] = [];
    const canGoBack = this.nav.peek().length > 1;
    if (screen.title || canGoBack) {
      children.push({
        type: "column",
        style: { paddingX: 20, paddingTop: 8, paddingBottom: 8, gap: 2, align: "start" },
        children: [
          ...(canGoBack ? [{ type: "button", variant: "plain", label: "‹ Back", onTap: { back: true } } as NodeSpec] : []),
          ...(screen.title ? [{ type: "text", variant: "largeTitle", value: screen.title }] : []),
        ],
      });
    }
    if (screen.scroll === false) children.push({ ...screen.body, style: { grow: 1, ...(screen.body.style ?? {}) } });
    else children.push({ type: "scroll", style: { grow: 1, paddingX: 20, paddingTop: 8, paddingBottom: 32 }, children: [screen.body] });
    if (screen.footer) children.push({ type: "column", style: { paddingX: 20, paddingY: 12 }, children: [screen.footer] });
    return { type: "screen", style: { background: "background", height: "100%" }, children };
  }

  // ---------- Building ----------

  private createNode(type: string): ViewNode {
    const n = new ViewNode(type);
    this.nodes.set(n.id, n);
    if (type === "scroll" || type === "hscroll") this.scrollNodes.add(n);
    return n;
  }

  private buildNode(spec: NodeSpec, scope: Scope, where: string): ViewNode {
    const type = TYPE_ALIASES[spec.type] ?? spec.type;
    const component = this.components[type];
    if (component && !isPrimitive(type)) return this.buildComponent(spec, component, scope, where);
    return this.buildPrimitive(type, spec, [{ style: spec.style, scope }], scope, where);
  }

  private buildComponent(usage: NodeSpec, tmpl: NodeSpec, callerScope: Scope, where: string): ViewNode {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(usage)) {
      if (RESERVED.has(k) || k.startsWith("on")) continue;
      Object.defineProperty(props, k, {
        enumerable: true,
        get: () => (typeof v === "string" ? this.evalTemplate(v, callerScope, `${where}.${k}`) : v),
      });
    }
    if (usage.props && typeof usage.props === "object") {
      for (const [k, v] of Object.entries(usage.props as Record<string, unknown>)) {
        Object.defineProperty(props, k, {
          enumerable: true,
          get: () => (typeof v === "string" ? this.evalTemplate(v, callerScope, `${where}.props.${k}`) : v),
        });
      }
    }
    const scope = childScope(callerScope, { props });
    const type = TYPE_ALIASES[tmpl.type] ?? tmpl.type;
    const merged: NodeSpec = { ...tmpl, onTap: usage.onTap ?? tmpl.onTap, bind: usage.bind ?? tmpl.bind };
    // Usage children fill a template's "$children" slot, evaluated in the caller's scope.
    const slotChildren = (tmpl.children as unknown) === "$children";
    if (slotChildren) merged.children = usage.children ?? [];
    const node = this.buildPrimitive(
      type,
      merged,
      [
        { style: tmpl.style, scope },
        { style: usage.style, scope: callerScope },
      ],
      slotChildren ? callerScope : scope,
      where,
      scope,
      usage.onTap ? callerScope : scope,
    );
    return node;
  }

  private buildPrimitive(
    type: string,
    spec: NodeSpec,
    styles: { style?: Record<string, unknown>; scope: Scope }[],
    childScopeForChildren: Scope,
    where: string,
    propScope: Scope = childScopeForChildren,
    handlerScope: Scope = propScope,
  ): ViewNode {
    if (this.components[type] && !isPrimitive(type)) {
      // A component whose template root is another component.
      return this.buildComponent({ ...spec, type }, this.components[type], propScope, where);
    }
    const node = this.createNode(type);

    // Props
    for (const [k, v] of Object.entries(spec)) {
      if (RESERVED.has(k)) continue;
      this.bindProp(node, k, v, propScope, `${where}.${k}`);
    }
    if (type === "shape" && node.props.viewBox === undefined) node.props.viewBox = "0 0 24 24";

    // Style: layout keys feed the JS engine, the rest goes to the host.
    effect(() => {
      const variant = typeof spec.variant === "string" ? this.evalTemplate(spec.variant, propScope, `${where}.variant`) : spec.variant;
      const resolved: Record<string, unknown> = { ...defaultStyle(type, variant) };
      for (const { style, scope } of styles) {
        if (!style) continue;
        for (const [k, v] of Object.entries(style)) {
          resolved[k] = typeof v === "string" ? this.evalTemplate(v, scope, `${where}.style.${k}`) : v;
        }
      }
      untrack(() => this.applyStyle(node, resolved));
    });

    // Events
    const h: Handlers = { scope: handlerScope };
    if (spec.onTap) h.onTap = spec.onTap;
    if (spec.onChange) h.onChange = spec.onChange;
    if (spec.onSubmit) h.onSubmit = spec.onSubmit;
    if (spec.bind) {
      h.bind = spec.bind;
      const target = spec.bind;
      effect(() => {
        const v = this.readPath(target, propScope);
        untrack(() => {
          // Don't echo back what the user is typing: the cursor would jump.
          if (this.nativeValues.has(node.id) && looseSame(this.nativeValues.get(node.id), v)) return;
          this.setProp(node, "value", type === "toggle" ? Boolean(v) : str(v));
        });
      });
    }
    if (h.onTap || h.onChange || h.onSubmit || h.bind) {
      this.handlers.set(node.id, h);
      if (h.onTap && type !== "button") node.props.tappable = true;
    }

    // Children
    const childSpecs = spec.children ?? (spec.child ? [spec.child as NodeSpec] : []);
    if (Array.isArray(childSpecs) && childSpecs.length) {
      if (!isContainer(type)) this.error(where, `'${type}' cannot have children`);
      else this.buildChildren(node, childSpecs, childScopeForChildren, where);
    }
    return node;
  }

  private buildChildren(parent: ViewNode, specs: NodeSpec[], scope: Scope, where: string): void {
    let ready = false;
    const slots: Slot[] = [];
    const refresh = () => {
      if (ready) this.setChildren(parent, slots.flatMap((s) => s.nodes));
    };
    specs.forEach((spec, i) => {
      const w = `${where}.children[${i}]`;
      if (!spec || typeof spec !== "object" || typeof spec.type !== "string") {
        this.error(w, "Child must be an object with a 'type'");
        return;
      }
      slots.push(spec.each ? this.eachSlot(spec, scope, refresh, w) : spec.if ? this.ifSlot(spec, scope, refresh, w) : { nodes: [this.buildNode(spec, scope, w)] });
    });
    ready = true;
    refresh();
  }

  private ifSlot(spec: NodeSpec, scope: Scope, onChange: () => void, where: string): Slot {
    const slot: Slot = { nodes: [] };
    const owner = getOwner();
    const { if: cond, ...rest } = spec;
    let prev: boolean | undefined;
    let dispose: (() => void) | null = null;
    effect(() => {
      const v = Boolean(this.evalExpr(cond!, scope, `${where}.if`));
      if (v === prev) return;
      prev = v;
      untrack(() => {
        dispose?.();
        dispose = null;
        slot.nodes = v ? [root((d) => ((dispose = d), this.buildNode(rest as NodeSpec, scope, where)), owner)] : [];
        onChange();
      });
    });
    return slot;
  }

  private eachSlot(spec: NodeSpec, scope: Scope, onChange: () => void, where: string): Slot {
    const slot: Slot = { nodes: [] };
    const owner = getOwner();
    const { each, as = "item", indexAs = "index", key, ...rest } = spec;
    type Entry = { item: Signal<unknown>; index: Signal<number>; slot: Slot; dispose: () => void };
    let entries = new Map<unknown, Entry>();
    effect(() => {
      let list = this.evalExpr(each!, scope, `${where}.each`);
      if (typeof list === "number") list = Array.from({ length: Math.max(0, Math.min(10000, Math.floor(list))) }, (_, i) => i);
      const items = Array.isArray(list) ? list : [];
      untrack(() => {
        const next = new Map<unknown, Entry>();
        const ordered: Entry[] = [];
        items.forEach((item, i) => {
          let k: unknown = i;
          if (key) {
            const s = childScope(scope, { [as]: item, [indexAs]: i });
            k = this.evalExpr(key, s, `${where}.key`);
          } else if (item && typeof item === "object" && "id" in item) k = (item as { id: unknown }).id;
          if (next.has(k)) k = `${String(k)}#${i}`;
          let e = entries.get(k);
          if (e) {
            e.item.set(item);
            e.index.set(i);
          } else {
            const itemSig = new Signal<unknown>(item);
            const indexSig = new Signal(i);
            const vars = {};
            Object.defineProperty(vars, as, { enumerable: true, get: () => itemSig.get() });
            Object.defineProperty(vars, indexAs, { enumerable: true, get: () => indexSig.get() });
            const itemScope = childScope(scope, vars);
            e = root((dispose) => {
              const s = rest.if ? this.ifSlot(rest as NodeSpec, itemScope, onChange, where) : { nodes: [this.buildNode(rest as NodeSpec, itemScope, where)] };
              return { item: itemSig, index: indexSig, slot: s, dispose };
            }, owner);
          }
          next.set(k, e);
          ordered.push(e);
        });
        for (const [k, e] of entries) if (!next.has(k)) e.dispose();
        entries = next;
        // Each entry's `if` slot may change later; read nodes lazily through a getter.
        Object.defineProperty(slot, "nodes", { configurable: true, get: () => ordered.flatMap((e) => e.slot.nodes) });
        onChange();
      });
    });
    return slot;
  }

  // ---------- Props, style, tree ops ----------

  private bindProp(node: ViewNode, key: string, value: unknown, scope: Scope, where: string): void {
    if (typeof value === "string" && value.includes("{{")) {
      effect(() => {
        const v = this.evalTemplate(value, scope, where);
        untrack(() => this.setProp(node, key, this.resolveProp(node, key, v)));
      });
    } else {
      node.props[key] = this.resolveProp(node, key, value);
    }
  }

  private resolveProp(node: ViewNode, key: string, v: unknown): unknown {
    if (COLOR_KEYS.has(key) && typeof v === "string") return this.theme[v] ?? v;
    if (key === "path" && typeof v === "string" && v.startsWith("@")) return SHAPES[v.slice(1)] ?? "";
    if ((key === "value" || key === "label") && node.type !== "toggle" && typeof v !== "string") return str(v);
    return v;
  }

  private setProp(node: ViewNode, key: string, value: unknown): void {
    if (looseSame(node.props[key], value)) return;
    node.props[key] = value;
    if (MEASURED_PROPS.has(key) && !isContainer(node.type) && node.type !== "textfield") node.markDirty();
    if (key === "src") node.intrinsic = null;
    if (node.mounted) {
      let u = this.updates.get(node);
      if (!u) this.updates.set(node, (u = {}));
      u[key] = value;
    }
    this.scheduleFrame();
  }

  private applyStyle(node: ViewNode, resolved: Record<string, unknown>): void {
    const layout: Record<string, unknown> = {};
    const visual: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved)) {
      if (LAYOUT_KEYS.has(k) || k === "flex") layout[k] = v;
      else visual[k] = COLOR_KEYS.has(k) && typeof v === "string" ? (this.theme[v] ?? v) : v;
    }
    // Text metrics are resolved here so every host renders with the same numbers.
    if (node.type === "text" || node.type === "button" || node.type === "textfield") {
      const variant = String(node.props.variant ?? (node.type === "button" ? "button" : "body"));
      const base = TYPOGRAPHY[variant] ?? TYPOGRAPHY.body;
      const fontSize = Number(visual.fontSize ?? base.fontSize);
      const ts: TextStyle = {
        fontSize,
        fontWeight: Number(fontWeightOf(visual.fontWeight) ?? base.fontWeight),
        lineHeight: Number(visual.lineHeight ?? (visual.fontSize !== undefined ? Math.round(fontSize * 1.3) : base.lineHeight)),
      };
      Object.assign(visual, ts);
      if (visual.color === undefined) visual.color = this.theme[base.color ?? "text"];
      const prev = this.textStyles.get(node);
      if (!prev || TEXT_METRIC_KEYS.some((k) => prev[k] !== ts[k])) {
        this.textStyles.set(node, ts);
        node.markDirty();
      }
    }
    const box = parseBox(layout);
    // Leaves draw their own content inset (button label, text chip, input text), so the host needs padding.
    if (!isContainer(node.type) && box.padding.some((v) => v !== 0)) visual.padding = box.padding;
    if (!sameBox(node.box, box)) {
      node.box = box;
      node.markDirty();
      this.scheduleFrame();
    }
    const prev = (node.props.style ?? {}) as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    let any = false;
    for (const k of new Set([...Object.keys(prev), ...Object.keys(visual)])) {
      if (!looseSame(prev[k], visual[k])) {
        changed[k] = visual[k] ?? null;
        any = true;
      }
    }
    if (!any) return;
    node.props.style = visual;
    if (node.mounted) {
      let u = this.updates.get(node);
      if (!u) this.updates.set(node, (u = {}));
      u.style = { ...((u.style as object) ?? {}), ...changed };
      this.scheduleFrame();
    }
  }

  private setChildren(parent: ViewNode, next: ViewNode[]): void {
    const nextSet = new Set(next);
    for (const old of parent.children) {
      if (!nextSet.has(old)) {
        if (parent.mounted && old.mounted) this.structural.push(["remove", parent.id, old.id]);
        this.destroy(old);
      }
    }
    const working = parent.children.filter((c) => nextSet.has(c));
    next.forEach((n, i) => {
      if (working[i] === n) return;
      const at = working.indexOf(n);
      if (at >= 0) working.splice(at, 1);
      working.splice(i, 0, n);
      n.parent = parent;
      if (parent.mounted) {
        if (!n.mounted) this.mount(n);
        this.structural.push(["insert", parent.id, n.id, i]);
      }
    });
    parent.children = next;
    for (const n of next) n.parent = parent;
    parent.markDirty();
    this.scheduleFrame();
  }

  private mount(n: ViewNode): void {
    this.structural.push(["create", n.id, n.type, { ...n.props }]);
    n.mounted = true;
    this.updates.delete(n);
    n.children.forEach((c, i) => {
      c.parent = n;
      this.mount(c);
      this.structural.push(["insert", n.id, c.id, i]);
    });
  }

  private destroy(n: ViewNode): void {
    n.alive = false;
    n.mounted = false;
    n.parent = null;
    this.nodes.delete(n.id);
    this.handlers.delete(n.id);
    this.nativeValues.delete(n.id);
    this.scrollNodes.delete(n);
    this.textStyles.delete(n);
    this.updates.delete(n);
    for (const c of n.children) this.destroy(c);
  }

  private scheduleFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    this.host.requestFrame(() => this.flush());
  }

  // ---------- Measurement ----------

  private measureLeaf(n: ViewNode, maxW: number, _maxH: number, exactW: boolean): Size {
    switch (n.type) {
      case "text":
        return this.measureText(str(n.props.value), n, maxW);
      case "button":
        return this.measureText(str(n.props.label), n, maxW);
      case "textfield": {
        const ts = this.textStyles.get(n) ?? TYPOGRAPHY.body;
        return { width: Math.min(maxW, 160), height: ts.lineHeight };
      }
      case "toggle":
        return { width: 51, height: 31 };
      case "shape": {
        const vb = String(n.props.viewBox ?? "0 0 24 24").split(/[\s,]+/).map(Number);
        const vw = vb[2] || 24;
        const vh = vb[3] || 24;
        if (exactW) return { width: maxW, height: (maxW * vh) / vw };
        return { width: Math.min(24, maxW), height: (Math.min(24, maxW) * vh) / vw };
      }
      case "image": {
        const i = n.intrinsic;
        if (!i || !i.width) return { width: exactW ? maxW : 0, height: 0 };
        const width = exactW ? maxW : Math.min(i.width, maxW);
        return { width, height: (width * i.height) / i.width };
      }
      case "divider":
        return n.parent?.type === "row" ? { width: 1, height: 0 } : { width: 0, height: 1 };
      default:
        return { width: 0, height: 0 };
    }
  }

  private measureText(text: string, n: ViewNode, maxW: number): Size {
    if (!text) return { width: 0, height: 0 };
    const ts = this.textStyles.get(n) ?? TYPOGRAPHY.body;
    const w = isFinite(maxW) ? Math.floor(maxW) : 100000;
    const k = `${ts.fontSize}|${ts.fontWeight}|${ts.lineHeight}|${w}|${text}`;
    const hit = this.textCache.get(k);
    if (hit) {
      this.stats.measureCacheHits++;
      return hit;
    }
    const t0 = now(this.host);
    const s = this.host.measureText(text, ts, w);
    this.stats.measureMs += now(this.host) - t0;
    this.stats.measureCalls++;
    if (this.textCache.size > 5000) this.textCache.clear();
    const size = { width: Math.ceil(s.width), height: Math.ceil(s.height) };
    this.textCache.set(k, size);
    return size;
  }

  // ---------- Expressions and actions ----------

  private evalExpr(src: string, scope: Scope, where: string): unknown {
    let fn: Compiled;
    try {
      fn = compile(src);
    } catch (e) {
      this.error(where, (e as Error).message);
      return undefined;
    }
    try {
      return fn(scope);
    } catch (e) {
      this.error(where, (e as Error).message);
      return undefined;
    }
  }

  private evalTemplate(src: string, scope: Scope, where: string): unknown {
    let fn: Compiled | null;
    try {
      fn = compileTemplate(src);
    } catch (e) {
      this.error(where, (e as Error).message);
      return src;
    }
    if (!fn) return src;
    try {
      return fn(scope);
    } catch (e) {
      this.error(where, (e as Error).message);
      return undefined;
    }
  }

  private error(where: string, message: string): void {
    if (this.errors.length < 100 && !this.errors.some((e) => e.where === where && e.message === message)) {
      this.errors.push({ where, message });
      this.host.log?.("warn", `${where}: ${message}`);
    }
  }

  run(actions: Actions, scope: Scope): void {
    for (const a of Array.isArray(actions) ? actions : [actions]) this.runOne(a, scope);
  }

  private runOne(a: Action, scope: Scope): void {
    const where = `action ${JSON.stringify(a)}`;
    try {
      if ("set" in a) this.assign(a.set, scope, this.evalValue(a.to, scope, where));
      else if ("toggle" in a) this.assign(a.toggle, scope, !this.readPath(a.toggle, scope));
      else if ("push" in a) {
        const list = this.readPath(a.push, scope);
        this.assign(a.push, scope, [...(Array.isArray(list) ? list : []), this.evalValue(a.value, scope, where)]);
      } else if ("remove" in a) {
        if (a.at !== undefined || a.where !== undefined) {
          const list = this.readPath(a.remove, scope);
          if (!Array.isArray(list)) return;
          let next: unknown[];
          if (a.at !== undefined) {
            const at = Number(this.evalExpr(a.at, scope, where));
            next = list.filter((_, i) => i !== at);
          } else {
            next = list.filter((item, index) => !this.evalExpr(a.where!, childScope(scope, { item, index }), where));
          }
          this.assign(a.remove, scope, next);
        } else {
          // `{"remove": "item"}` inside `each`: remove that element from its list.
          const loc = this.locateItem(scope.lookup(a.remove));
          if (loc) loc.signal.set((loc.signal.peek() as unknown[]).filter((_, i) => i !== loc.index));
        }
      } else if ("navigate" in a) {
        const params: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(a.params ?? {})) params[k] = this.evalValue(v, scope, where);
        if (!this.spec.screens[a.navigate]) return this.error(where, `Unknown screen '${a.navigate}'`);
        this.nav.set([...this.nav.peek(), { screen: a.navigate, params }]);
      } else if ("back" in a) {
        const stack = this.nav.peek();
        if (stack.length > 1) this.nav.set(stack.slice(0, -1));
      } else if ("if" in a) {
        const branch = this.evalExpr(a.if, scope, where) ? a.then : a.else;
        if (branch) this.run(branch, scope);
      } else this.error(where, "Unknown action");
    } catch (e) {
      this.error(where, (e as Error).message);
    }
  }

  /** An action value is an expression string, or an object whose values are expressions. */
  private evalValue(v: unknown, scope: Scope, where: string): unknown {
    if (typeof v === "string") return this.evalExpr(v, scope, where);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.evalValue(x, scope, where);
      return out;
    }
    return v;
  }

  private readPath(path: string, scope: Scope): unknown {
    return this.evalExpr(path, scope, `bind ${path}`);
  }

  private peekPath(path: string, scope: Scope): unknown {
    return untrack(() => this.readPath(path, scope));
  }

  /** Writes `value` at `path`: a state/data key, or a field of a loop variable. */
  private assign(path: string, scope: Scope, value: unknown): void {
    const { root: name, segs } = compilePath(path);
    const keys = segs.map((s) => s(scope));
    const sig = this.signals.get(name);
    const local = untrack(() => scope.lookup(name));
    if (sig && Object.is(local, sig.peek())) {
      sig.set(setIn(sig.peek(), keys, value));
      return;
    }
    const loc = this.locateItem(local);
    if (loc) {
      loc.signal.set(setIn(loc.signal.peek(), [loc.index, ...keys], value));
      return;
    }
    this.error(`assign ${path}`, `Cannot assign to '${name}'`);
  }

  /** Finds which top-level list holds this exact object (loop items are shared references). */
  private locateItem(obj: unknown): { signal: Signal<unknown>; index: number } | null {
    if (!obj || typeof obj !== "object") return null;
    for (const s of this.signals.values()) {
      const v = s.peek();
      if (Array.isArray(v)) {
        const index = v.indexOf(obj);
        if (index >= 0) return { signal: s, index };
      }
    }
    return null;
  }

  // ---------- Storage ----------

  private readStorage(id: string): Record<string, unknown> {
    try {
      const raw = this.host.storage?.get(`jig:${id}`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private requestSave(): void {
    this.saveRequested = true;
    this.scheduleFrame();
  }

  private save(): void {
    this.saveRequested = false;
    if (!this.host.storage || !this.spec) return;
    const out: Record<string, unknown> = {};
    for (const k of this.dataKeys) out[k] = this.signals.get(k)?.peek();
    this.host.storage.set(`jig:${this.spec.id}`, JSON.stringify(out));
  }
}

const PRIMITIVES = new Set(["root", "screen", "column", "row", "overlay", "scroll", "hscroll", "text", "button", "textfield", "toggle", "shape", "image", "spacer", "divider"]);
const isPrimitive = (t: string) => PRIMITIVES.has(t);
export const PRIMITIVE_TYPES = [...PRIMITIVES].filter((t) => t !== "root" && t !== "screen");

function emptyStats(): FrameStats {
  return { bindingsMs: 0, layoutMs: 0, measureMs: 0, measureCalls: 0, measureCacheHits: 0, layoutCacheHits: 0, skippedSubtrees: 0, applyMs: 0, ops: 0 };
}

function fontWeightOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const named: Record<string, number> = { regular: 400, normal: 400, medium: 500, semibold: 600, bold: 700, heavy: 800 };
  return named[String(v)] ?? (Number(v) || undefined);
}

function coerce(value: unknown, current: unknown): unknown {
  if (typeof current === "number" && typeof value === "string") {
    const n = Number(value);
    return value.trim() === "" || isNaN(n) ? value : n;
  }
  return value;
}

function looseSame(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function sameBox(a: Box, b: Box): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
