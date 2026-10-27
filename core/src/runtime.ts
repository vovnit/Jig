// The shared runtime: spec → view tree with fine-grained bindings → layout →
// one batch of ops per frame. Hosts feed back events and measurements.
//
//   event → actions update state → bound effects update specific nodes
//         → dirty layout → frame: incremental layout → ops batch → host.apply

import type { Host, Op, Props, Size } from "./bridge.ts";
import { BUILTIN_COMPONENTS, COLOR_KEYS, SHAPES, TYPE_ALIASES, defaultStyle } from "./builtins.ts";
import { type Compiled, type Scope, childScope, compile, compilePath, compileTemplate, setIn, str } from "./expr.ts";
import { type Box, type Frame, LAYOUT_KEYS, ViewNode, isContainer, layoutRoot, parseBox } from "./layout.ts";
import { type Owner, Signal, effect, getOwner, onCleanup, root, untrack } from "./signals.ts";
import { DataStore } from "./store.ts";
import { type Action, type Actions, type AppSpec, type ColorScheme, DEFAULT_THEME, type FieldSpec, type ListSpec, NODE_TYPES, type ScreenTransition, type NodeSpec, type ScreenSpec, TYPOGRAPHY, type TextStyle, resolveTheme } from "./spec.ts";

const RESERVED = new Set(["type", "style", "children", "child", "if", "each", "as", "indexAs", "key", "bind", "onTap", "onChange", "onSubmit", "onPage", "onSelect", "props", "$path"]);
const MEASURED_PROPS = new Set(["value", "label", "variant", "src", "placeholder"]);
const TEXT_METRIC_KEYS = ["fontSize", "fontWeight", "lineHeight", "fontFamily"] as const;

interface NavEntry {
  screen: string;
  params: Record<string, unknown>;
  transition?: ScreenTransition;
}

const SCREEN_TRANSITION_MS = 320;

interface Handlers {
  scope: Scope;
  onTap?: Actions;
  onChange?: Actions;
  onSubmit?: Actions;
  /** A paging hscroll settled on a page (`value` is its index). */
  onPage?: Actions;
  bind?: string;
  /** List rows: a swipe action by index, and a drag past a neighbour (by -1 or 1). */
  onSwipe?: (index: number) => void;
  onMove?: (by: number) => void;
}

/** Lists up to this many items keep a row for every item; longer ones only near the visible part. */
const VIRTUALIZE_AFTER = 60;
/** A one-line row before any row was measured: 44pt plus its separator. */
const ROW_ESTIMATE = 44.5;

interface ListRow {
  key: unknown;
  item: Signal<unknown>;
  index: Signal<number>;
  node: ViewNode;
  dispose: () => void;
}

/** A `list`: all of its items, and rows for the window of them that is on (or near) screen. */
interface ListState {
  spec: ListSpec;
  scope: Scope;
  where: string;
  owner: Owner | null;
  body: ViewNode;
  rowSpec: NodeSpec;
  items: unknown[];
  keys: unknown[];
  count: Signal<number>;
  rows: Map<unknown, ListRow>;
  byNode: Map<ViewNode, ListRow>;
  start: number;
  end: number;
  /** Measured row heights by item key, valid at `heightsWidth`. */
  heights: Map<unknown, number>;
  heightsWidth: number;
  /** Top of every item (count + 1 entries); null when a height or the items changed. */
  offsets: Float64Array | null;
  scroll: ViewNode | null;
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

export interface RuntimeOptions {
  /** Renders inside another runtime's `app` node instead of on the host's surface. */
  embedded?: boolean;
  /** The shell: may call the builder's services. Set by the host, never by a spec. */
  trusted?: boolean;
}

/** An app shown inside an `app` node: its own runtime, laid out at the node's size. */
interface Embedded {
  node: ViewNode;
  rt: Runtime;
  /** Frame callbacks the child asked for; run during the parent's frame. */
  frames: (() => void)[];
  /** The child's ops, sent in the parent's batch. */
  ops: Op[];
  flushed: boolean;
  attached: boolean;
  scale: number;
  interactive: boolean;
  size: [number, number] | null;
  spec: unknown;
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
  colorScheme: ColorScheme = "light";
  components: Record<string, NodeSpec> = BUILTIN_COMPONENTS;

  signals = new Map<string, Signal<unknown>>();
  dataKeys = new Set<string>();
  /** Data keys marked `secret`: kept in the host's secure storage, never in the database. */
  secretKeys = new Set<string>();
  nav = new Signal<NavEntry[]>([]);

  root: ViewNode;
  nodes = new Map<number, ViewNode>();
  handlers = new Map<number, Handlers>();
  /** Last value reported by native for text inputs; native is the source of truth while typing. */
  nativeValues = new Map<number, unknown>();
  scrollNodes = new Set<ViewNode>();
  /** Scroll offsets the host reported, by scroll node id. */
  scrollOffsets = new Map<number, number>();
  lists = new Set<ListState>();
  textStyles = new Map<ViewNode, TextStyle>();

  viewport = { width: 390, height: 844, insets: [0, 0, 0, 0] as [number, number, number, number] };
  errors: RuntimeError[] = [];
  stats: FrameStats = emptyStats();
  onStats?: (s: FrameStats) => void;

  readonly embedded: boolean;
  readonly trusted: boolean;
  /** Container services the trusted shell calls with `{"call": name, "args": {...}}`. */
  services = new Map<string, (args: Record<string, unknown>) => void>();
  private embeds = new Set<Embedded>();
  /** Set for a whiteboard card: the app shows this screen and doesn't navigate. */
  private pinned: string | null = null;
  /** Navigation depth last reported to the host. */
  private reportedDepth = 0;

  private structural: Op[] = [];
  private updates = new Map<ViewNode, Props>();
  private frameRequested = false;
  private saveRequested = false;
  private store: DataStore | null = null;
  /** Last value written to secure storage per secret key (undefined: none stored). */
  private savedSecrets = new Map<string, unknown>();
  private appOwner: Owner | null = null;
  private textCache = new Map<string, Size>();
  private globalScope: Scope;

  constructor(host: Host, options: RuntimeOptions = {}) {
    this.host = host;
    this.embedded = options.embedded ?? false;
    this.trusted = options.trusted ?? false;
    // An embedded app's root is an ordinary container inside the parent's `app` node.
    this.root = this.createNode(this.embedded ? "column" : "root");
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
  load(spec: AppSpec, { fresh = false, screen }: { fresh?: boolean; screen?: string } = {}): void {
    this.appOwner?.dispose();
    this.pinned = screen && spec.screens[screen] ? screen : null;
    if (fresh || this.spec?.id !== spec.id) this.savedSecrets.clear();
    if (fresh) {
      this.signals.clear();
      this.nav = new Signal<NavEntry[]>([]);
    }
    this.spec = spec;
    this.theme = resolveTheme(spec, this.colorScheme);
    this.components = { ...BUILTIN_COMPONENTS, ...(spec.components ?? {}) };
    this.errors = [];

    if (this.store?.app !== spec.id) this.store = this.openStore(spec.id);
    const next = new Map<string, Signal<unknown>>();
    this.dataKeys = new Set(Object.keys(spec.data ?? {}));
    this.secretKeys = new Set(Object.entries(spec.data ?? {}).filter(([, f]) => f.secret).map(([k]) => k));
    // Keys kept from before a hot reload already hold the latest value.
    const stored = [...this.dataKeys].some((k) => !this.signals.has(k)) ? this.readStore() : {};
    for (const [k, f] of Object.entries(spec.data ?? {})) {
      const prev = this.signals.get(k);
      next.set(k, prev ?? new Signal(k in stored ? stored[k] : defaultFor(f)));
    }
    for (const [k, v] of Object.entries(spec.state ?? {})) {
      next.set(k, this.signals.get(k) ?? new Signal(v));
    }
    this.signals.clear();
    for (const [k, s] of next) this.signals.set(k, s);

    const start = this.pinned ?? (spec.start && spec.screens[spec.start] ? spec.start : Object.keys(spec.screens)[0]);
    const keepNav = this.pinned ? [] : this.nav.peek().filter((e) => spec.screens[e.screen]);
    this.nav.set(keepNav.length ? keepNav : [{ screen: start, params: {} }]);

    // A (hot) reload replaces the screen in place; only navigation animates.
    this.shownStack = null;
    root(() => {
      this.appOwner = getOwner();
      // Persist data whenever it changes.
      effect(() => {
        for (const k of this.dataKeys) this.signals.get(k)?.get();
        untrack(() => this.requestSave());
      });
      effect(() => {
        const stack = this.nav.get();
        untrack(() => this.showScreen(stack.at(-1)?.screen ?? start, this.screenTransition(stack)));
      });
    }, null);
    this.scheduleFrame();
  }

  /** Follows the system appearance. Colors are resolved at build time, so the app rebuilds (state is kept). */
  setColorScheme(scheme: ColorScheme): void {
    if (scheme === this.colorScheme) return;
    this.colorScheme = scheme;
    for (const e of this.embeds) e.rt.setColorScheme(scheme);
    if (this.spec) this.load(this.spec, { screen: this.pinned ?? undefined });
  }

  /** Tears the app down: an embedded app whose `app` node went away. */
  dispose(): void {
    this.screenOwner?.();
    this.screenOwner = null;
    this.appOwner?.dispose();
    this.appOwner = null;
    for (const e of this.embeds) e.rt.dispose();
    this.embeds.clear();
  }

  /** Whether a node belongs to this runtime or an app embedded in it. */
  owns(id: number): boolean {
    if (this.nodes.has(id)) return true;
    for (const e of this.embeds) if (e.rt.owns(id)) return true;
    return false;
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
    if (!node) {
      for (const e of this.embeds) if (e.rt.owns(id)) return e.rt.dispatch(id, name, payload);
      return;
    }
    if (name === "select") {
      this.select(node);
      return;
    }
    if (name === "scroll") {
      this.scrollOffsets.set(id, Number(payload.y) || 0);
      if (this.lists.size) this.scheduleFrame();
      return;
    }
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
      if (name === "page" && h.onPage) this.run(h.onPage, childScope(h.scope, { value: Number(payload.index) || 0 }));
      if (name === "swipe" && h.onSwipe) h.onSwipe(Number(payload.index) || 0);
      if (name === "move" && h.onMove) h.onMove(Math.sign(Number(payload.by) || 0));
    }
    this.stats.bindingsMs += now(this.host) - t0;
  }

  /**
   * Pops one screen, for the host's back gesture or button: an embedded app's own screens
   * first, then this runtime's. Returns false on the first screen.
   */
  back(): boolean {
    for (const e of [...this.embeds].reverse()) if (e.interactive && e.node.mounted && e.rt.back()) return true;
    const stack = this.nav.peek();
    if (stack.length <= 1) return false;
    this.nav.set(stack.slice(0, -1));
    return true;
  }

  /** Runs layout and sends the batch. Hosts normally reach this through requestFrame. */
  flush(): void {
    this.frameRequested = false;
    const frames = new Map<ViewNode, Frame>();
    const ctx = {
      stats: { measured: 0, cacheHits: 0, skipped: 0 },
      measureLeaf: (n: ViewNode, maxW: number, maxH: number, exactW: boolean) => this.measureLeaf(n, maxW, maxH, exactW),
      onFrame: (n: ViewNode) => {
        n.sentFrame = n.frame;
        frames.set(n, n.frame);
      },
    };
    const t0 = now(this.host);
    // Layout can move a list's window (rows scrolled near, or measured taller than estimated),
    // which adds rows to lay out: repeat a few times until the windows settle.
    for (let pass = 0; pass < 4; pass++) {
      if (this.root.dirty) {
        const { width, height, insets } = this.viewport;
        this.root.box = parseBox({ paddingTop: insets[0], paddingRight: insets[1], paddingBottom: insets[2], paddingLeft: insets[3] });
        layoutRoot(this.root, width, height, ctx);
      }
      if (!this.updateWindows()) break;
    }
    for (const e of this.embeds) this.syncEmbed(e);
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
    // Embedded apps' ops come after the parent's structure (their `app` nodes exist by then),
    // and each child's root is attached once it was created.
    for (const e of this.embeds) {
      ops.push(...e.ops);
      e.ops = [];
      if (e.flushed && !e.attached && e.node.mounted) {
        ops.push(["insert", e.node.id, e.rt.root.id, 0]);
        e.attached = true;
      }
    }
    const depth = this.nav.peek().length;
    if (depth !== this.reportedDepth) {
      // Hosts keep a screen stack per runtime root, for the back gesture.
      ops.push(["command", this.root.id, "depth", [depth]]);
      this.reportedDepth = depth;
    }
    for (const [node, props] of this.updates) if (node.alive && node.mounted) ops.push(["update", node.id, props]);
    this.updates.clear();
    for (const [n, f] of frames) if (n.alive && n.mounted) ops.push(["frame", n.id, ...f]);

    if (ops.length) {
      const t1 = now(this.host);
      this.host.apply(ops);
      this.stats.applyMs += now(this.host) - t1;
    }
    this.stats.ops += ops.length;
    if (this.saveRequested) this.save();
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const w of waiters) w();
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
  private shownStack: NavEntry[] | null = null;

  /** Push or pop, compared with the stack on screen; the pop mirrors how the popped screen came in. */
  private screenTransition(stack: NavEntry[]): { kind: "push" | "pop"; style: ScreenTransition } | null {
    const shown = this.shownStack;
    this.shownStack = stack;
    if (!shown || shown.length === stack.length) return null;
    if (stack.length > shown.length) return { kind: "push", style: stack.at(-1)?.transition ?? "slide" };
    return { kind: "pop", style: shown.at(-1)?.transition ?? "slide" };
  }

  private showScreen(name: string, transition: { kind: "push" | "pop"; style: ScreenTransition } | null = null): void {
    this.screenOwner?.();
    this.screenOwner = null;
    const screen: ScreenSpec | undefined = this.spec.screens[name];
    if (!screen) {
      this.error(`screens.${name}`, "Unknown screen");
      return;
    }
    // Hosts snapshot the old screen before applying this batch, then animate the new one in over it.
    if (transition && transition.style !== "none") {
      this.structural.push(["command", this.root.id, "transition", [transition.kind, transition.style, SCREEN_TRANSITION_MS]]);
    }
    root((dispose) => {
      this.screenOwner = dispose;
      const node = this.buildNode(this.screenSpec(screen, name), this.globalScope, `screens.${name}~`);
      this.setChildren(this.root, [node]);
    }, this.appOwner);
    this.scheduleFrame();
  }

  private screenSpec(screen: ScreenSpec, name: string): NodeSpec {
    const children: NodeSpec[] = [];
    const canGoBack = this.nav.peek().length > 1;
    if (screen.header !== false && (screen.title || canGoBack)) {
      children.push({
        type: "column",
        style: { paddingX: 20, paddingTop: 8, paddingBottom: 8, gap: 2, align: "start" },
        children: [
          ...(canGoBack ? [{ type: "button", variant: "plain", label: "‹ Back", onTap: { back: true } } as NodeSpec] : []),
          ...(screen.title ? [{ type: "text", variant: "largeTitle", value: screen.title }] : []),
        ],
      });
    }
    const body = { ...screen.body, $path: `screens.${name}.body` };
    if (screen.scroll === false) children.push({ ...body, style: { grow: 1, ...(screen.body.style ?? {}) } });
    else children.push({ type: "scroll", style: { grow: 1, paddingX: 20, paddingTop: 8, paddingBottom: 32 }, children: [body] });
    if (screen.footer) children.push({ type: "column", style: { paddingX: 20, paddingY: 12 }, children: [{ ...screen.footer, $path: `screens.${name}.footer` }] });
    return { type: "screen", style: { background: "background", height: "100%" }, children };
  }

  // ---------- Building ----------

  private createNode(type: string): ViewNode {
    const n = new ViewNode(type);
    this.nodes.set(n.id, n);
    if (type === "scroll" || type === "hscroll" || type === "canvas") this.scrollNodes.add(n);
    return n;
  }

  private buildNode(spec: NodeSpec, scope: Scope, where: string): ViewNode {
    // A node from the app's spec knows where it came from, so the builder can select it.
    if (typeof spec.$path === "string") where = spec.$path;
    const node = this.buildNodeAt(spec, scope, where);
    node.path = specPath(where);
    if (node.path && node.path === this.selectedPath) this.markSelected(node);
    return node;
  }

  private buildNodeAt(spec: NodeSpec, scope: Scope, where: string): ViewNode {
    const type = TYPE_ALIASES[spec.type] ?? spec.type;
    if (type === "list") return this.buildList(spec as ListSpec, scope, where);
    if (type === "app") return this.buildApp(spec, scope, where);
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
    // They are the app's own nodes; the template's are internal (`~` in their path).
    const slotChildren = (tmpl.children as unknown) === "$children";
    if (slotChildren) merged.children = (usage.children ?? []).map((c, i) => ({ ...c, $path: `${where}.children[${i}]` }));
    const node = this.buildPrimitive(
      type,
      merged,
      [
        { style: tmpl.style, scope },
        { style: usage.style, scope: callerScope },
      ],
      slotChildren ? callerScope : scope,
      `${where}~`,
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
    if (spec.onPage) h.onPage = spec.onPage as Actions;
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
    if (h.onTap || h.onChange || h.onSubmit || h.onPage || h.bind) {
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

  // ---------- Selection (the builder's select mode) ----------

  /** The spec path of the selected node; it stays selected across hot reloads. */
  selectedPath: string | null = null;
  private selectedNode: ViewNode | null = null;
  onSelect?: (info: { path: string; pointer: string; type: string; text?: string } | null) => void;

  /** Selects the app's node at or above a touched view: builtin internals select their usage. */
  private select(node: ViewNode): void {
    let n: ViewNode | null = node;
    while (n && !n.path) n = n.parent;
    if (!n) return;
    this.markSelected(n);
    this.selectedPath = n.path;
    const text = n.props.value ?? n.props.label ?? n.props.placeholder;
    this.onSelect?.({ path: n.path!, pointer: toPointer(n.path!), type: n.type, text: typeof text === "string" ? text : undefined });
  }

  private markSelected(node: ViewNode): void {
    if (this.selectedNode && this.selectedNode !== node && this.selectedNode.alive) this.setProp(this.selectedNode, "selected", false);
    this.selectedNode = node;
    if (node.mounted) this.setProp(node, "selected", true);
    else node.props.selected = true;
  }

  clearSelection(): void {
    if (this.selectedNode?.alive) this.setProp(this.selectedNode, "selected", false);
    this.selectedNode = null;
    this.selectedPath = null;
  }

  // ---------- Embedded apps ----------

  /**
   * `{"type": "app", "spec": "{{app.spec}}"}`: another app, running in its own runtime inside
   * this node. `screen` pins it to one screen, `scale` draws it smaller (a whiteboard card lays
   * out at phone size and shows at card size), `interactive: false` makes it a picture.
   */
  private buildApp(spec: NodeSpec, scope: Scope, where: string): ViewNode {
    const node = this.buildPrimitive("app", { type: "app" }, [{ style: spec.style, scope }], scope, where);
    const e: Embedded = { node, rt: null!, frames: [], ops: [], flushed: false, attached: false, scale: 1, interactive: true, size: null, spec: null };
    const child: Host = {
      apply: (ops) => {
        e.flushed = true;
        e.ops.push(...ops);
      },
      measureText: (text, style, maxWidth) => this.host.measureText(text, style, maxWidth),
      measureControl: this.host.measureControl && ((type) => this.host.measureControl!(type)),
      requestFrame: (cb) => {
        e.frames.push(cb);
        this.scheduleFrame();
      },
      db: this.host.db,
      secrets: this.host.secrets,
      now: this.host.now && (() => this.host.now!()),
      log: this.host.log && ((level, message) => this.host.log!(level, message)),
    };
    e.rt = new Runtime(child, { embedded: true });
    e.rt.colorScheme = this.colorScheme;
    if (spec.onSelect) e.rt.onSelect = (info) => this.run(spec.onSelect as Actions, childScope(scope, { value: info }));
    this.embeds.add(e);
    onCleanup(() => {
      this.embeds.delete(e);
      e.rt.dispose();
    });
    effect(() => {
      const value = typeof spec.spec === "string" ? this.evalTemplate(spec.spec, scope, `${where}.spec`) : spec.spec;
      const screen = typeof spec.screen === "string" ? str(this.evalTemplate(spec.screen, scope, `${where}.screen`)) : undefined;
      const scale = Number(typeof spec.scale === "string" ? this.evalTemplate(spec.scale, scope, `${where}.scale`) : (spec.scale ?? 1)) || 1;
      const interactive = (typeof spec.interactive === "string" ? this.evalTemplate(spec.interactive, scope, `${where}.interactive`) : spec.interactive) !== false;
      const selecting = Boolean(typeof spec.selecting === "string" ? this.evalTemplate(spec.selecting, scope, `${where}.selecting`) : spec.selecting);
      untrack(() => {
        e.interactive = interactive;
        this.setProp(node, "interactive", interactive);
        // Select mode: the host sends taps inside the app as `select` instead of running them.
        this.setProp(node, "selecting", selecting);
        if (!selecting && e.rt.selectedPath) e.rt.clearSelection();
        if (scale !== e.scale) {
          e.scale = scale;
          e.size = null;
          this.setProp(node, "contentScale", scale);
        }
        let app = value;
        if (typeof app === "string") {
          try {
            app = JSON.parse(app);
          } catch (err) {
            return this.error(`${where}.spec`, (err as Error).message);
          }
        }
        if (!app || typeof app !== "object" || !(app as AppSpec).screens) return;
        // The same spec again (another app in the list changed): keep the running one as it is.
        if (app === e.spec && (screen ?? null) === e.rt.pinned) return;
        const fresh = (app as AppSpec).id !== e.rt.spec?.id;
        e.spec = app;
        e.rt.load(app as AppSpec, { fresh, screen });
        // The child reports its errors too, so the builder can show and repair them.
        if (e.rt.errors.length) for (const er of e.rt.errors) this.error(`${where} ${er.where}`, er.message);
      });
    });
    return node;
  }

  /** After the parent's layout: give the child its viewport, then run its frame. */
  private syncEmbed(e: Embedded): void {
    if (!e.node.mounted) return;
    const [, , w, h] = e.node.frame;
    // Frames snap to quarter points, so a scaled card's viewport is rounded back to whole ones.
    const vw = e.scale === 1 ? w : Math.round(w / e.scale);
    const vh = e.scale === 1 ? h : Math.round(h / e.scale);
    if (!e.size || e.size[0] !== vw || e.size[1] !== vh) {
      e.size = [vw, vh];
      e.rt.setViewport(vw, vh);
    }
    const frames = e.frames;
    e.frames = [];
    for (const cb of frames) cb();
  }

  /** A host service as a promise (see `Host.call`). */
  hostCall<T = Record<string, unknown>>(service: string, args: Record<string, unknown> = {}): Promise<T> {
    const call = this.host.call;
    if (!this.trusted || !call) return Promise.reject(new Error(`The host has no '${service}' service`));
    return new Promise((resolve, reject) => call.call(this.host, service, args, (result, error) => (error ? reject(new Error(error)) : resolve(result as T))));
  }

  /** The apps embedded in this runtime, for hosts and the builder. */
  get children(): Runtime[] {
    return [...this.embeds].map((e) => e.rt);
  }

  /** Embedded apps on screen, with the screen each one is pinned to (whiteboard cards, pager pages). */
  embeddedViews(): { rt: Runtime; node: ViewNode; screen: string | null }[] {
    return [...this.embeds].filter((e) => e.node.mounted && e.attached).map((e) => ({ rt: e.rt, node: e.node, screen: e.rt.pinned }));
  }

  private frameWaiters: (() => void)[] = [];

  /** Resolves after the next frame was sent to the host (JS engines here have no timers). */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.frameWaiters.push(resolve);
      this.scheduleFrame();
    });
  }

  // ---------- Lists ----------

  private buildList(spec: ListSpec, scope: Scope, where: string): ViewNode {
    const inset = spec.variant !== "plain";
    const pad = inset ? 16 : 0;
    const outer = this.buildPrimitive("column", { type: "column" }, [{ style: { gap: 6 }, scope }, { style: spec.style, scope }], scope, where);
    const body = this.buildPrimitive("column", { type: "column" }, [{ style: inset ? { background: "surface", radius: 12 } : { clip: true }, scope }], scope, `${where}.rows`);
    const L: ListState = {
      spec, scope, where, body,
      owner: getOwner(),
      rowSpec: {
        type: "column",
        style: { background: inset ? "surface" : "background", transition: 200 },
        onTap: spec.onTap,
        children: [
          { type: "column", style: { paddingX: pad, paddingY: 11, minHeight: 44, justify: "center", ...spec.rowStyle }, children: spec.row ? [{ ...spec.row, $path: `${where}.row` }] : [] },
          ...(spec.separators === false ? [] : [{ type: "divider", if: "!$last", style: { marginLeft: pad, height: 0.5 } }]),
        ],
      },
      items: [], keys: [],
      count: new Signal(0),
      rows: new Map(), byNode: new Map(),
      start: 0, end: 0,
      heights: new Map(), heightsWidth: -1, offsets: null,
      scroll: null,
    };
    body.virtual = {
      count: () => L.items.length,
      indexOf: (row) => L.byNode.get(row)?.index.peek() ?? 0,
      measured: (i, height, width) => {
        if (width !== L.heightsWidth) {
          L.heights.clear();
          L.heightsWidth = width;
          L.offsets = null;
        }
        const k = L.keys[i];
        if (L.heights.get(k) !== height) {
          L.heights.set(k, height);
          L.offsets = null;
        }
      },
      top: (i) => this.listOffsets(L)[Math.max(0, Math.min(i, L.items.length))],
    };
    this.lists.add(L);
    onCleanup(() => this.lists.delete(L));

    const caption = (value: string, w: string) =>
      this.buildNode({ type: "text", variant: "caption", value, style: { paddingX: pad } }, scope, w);
    const header = spec.header ? caption(spec.header, `${where}~header`) : null;
    const footer = spec.footer ? caption(spec.footer, `${where}~footer`) : null;
    let empty: ViewNode | null = null;
    let disposeEmpty: (() => void) | null = null;
    const refresh = () => this.setChildren(outer, [header, body, empty, footer].filter((n): n is ViewNode => n !== null));

    effect(() => {
      let list = this.evalExpr(spec.items, scope, `${where}.items`);
      if (typeof list === "number") list = Array.from({ length: Math.max(0, Math.min(100000, Math.floor(list))) }, (_, i) => i);
      const items = Array.isArray(list) ? list : [];
      untrack(() => this.setListItems(L, items));
    });
    const owner = getOwner();
    effect(() => {
      const none = L.count.get() === 0 && spec.empty !== undefined;
      untrack(() => {
        if (none === (empty !== null)) return;
        disposeEmpty?.();
        disposeEmpty = null;
        empty = none
          ? root((d) => {
              disposeEmpty = d;
              const e = spec.empty!;
              return typeof e === "string"
                ? this.buildNode({ type: "text", variant: "callout", value: e, style: { color: "muted", paddingX: pad, paddingY: 8 } }, scope, `${where}~empty`)
                : this.buildNode({ ...e, $path: `${where}.empty` }, scope, `${where}.empty`);
            }, owner)
          : null;
        refresh();
      });
    });
    refresh();
    return outer;
  }

  private setListItems(L: ListState, items: unknown[]): void {
    const { key } = L.spec;
    const as = L.spec.as ?? "item";
    const indexAs = L.spec.indexAs ?? "index";
    const keys: unknown[] = [];
    const seen = new Set<unknown>();
    items.forEach((item, i) => {
      let k: unknown = i;
      if (key) k = this.evalExpr(key, childScope(L.scope, { [as]: item, [indexAs]: i }), `${L.where}.key`);
      else if (item && typeof item === "object" && "id" in item) k = (item as { id: unknown }).id;
      if (seen.has(k)) k = `${String(k)}#${i}`;
      seen.add(k);
      keys.push(k);
    });
    const before = new Set(L.keys);
    L.items = items;
    L.keys = keys;
    L.offsets = null;
    L.count.set(items.length);
    this.reconcileList(L, before);
  }

  /**
   * Builds rows for the window and drops the rest. `before`: the keys before a data change,
   * so rows of new items fade in and rows of deleted ones fade out; rows that only scrolled
   * into or out of the window come and go quietly.
   */
  private reconcileList(L: ListState, before: Set<unknown> | null): void {
    const [start, end] = this.listWindow(L);
    L.start = start;
    L.end = end;
    const wanted = new Map<unknown, number>();
    for (let i = start; i < end; i++) wanted.set(L.keys[i], i);
    const alive = before ? new Set(L.keys) : null;
    const quiet = new Set<ViewNode>();
    for (const [k, row] of L.rows) {
      if (wanted.has(k)) continue;
      if (!alive || alive.has(k)) quiet.add(row.node);
      row.dispose();
      L.rows.delete(k);
      L.byNode.delete(row.node);
    }
    const ordered: ViewNode[] = [];
    for (const [k, i] of wanted) {
      let row = L.rows.get(k);
      if (row) {
        row.item.set(L.items[i]);
        row.index.set(i);
      } else {
        row = this.buildRow(L, k, i);
        L.rows.set(k, row);
        L.byNode.set(row.node, row);
        if (!before || before.has(k)) quiet.add(row.node);
      }
      ordered.push(row.node);
    }
    this.setChildren(L.body, ordered, quiet);
  }

  private buildRow(L: ListState, key: unknown, i: number): ListRow {
    const { spec } = L;
    const item = new Signal<unknown>(L.items[i]);
    const index = new Signal(i);
    const vars = {};
    Object.defineProperty(vars, spec.as ?? "item", { enumerable: true, get: () => item.get() });
    Object.defineProperty(vars, spec.indexAs ?? "index", { enumerable: true, get: () => index.get() });
    Object.defineProperty(vars, "$last", { enumerable: true, get: () => index.get() === L.count.get() - 1 });
    const scope = childScope(L.scope, vars);
    return root((dispose) => {
      const node = this.buildNode(L.rowSpec, scope, `${L.where}~row`);
      const h: Handlers = this.handlers.get(node.id) ?? { scope };
      const swipe = Array.isArray(spec.swipe) ? spec.swipe : [];
      if (swipe.length) {
        h.onSwipe = (n) => {
          const a = swipe[n];
          if (a?.do) this.run(a.do, scope);
        };
        effect(() => {
          const actions = swipe.map((a, n) => {
            const c = a.color ?? (hasRemove(a.do) ? "danger" : "accent");
            return { label: str(this.evalTemplate(a.label ?? "", scope, `${L.where}.swipe[${n}].label`)), color: this.theme[c] ?? c };
          });
          untrack(() => this.setProp(node, "swipeActions", actions));
        });
      }
      if (spec.reorder) {
        node.props.reorder = true;
        h.onMove = (by) => this.moveListItem(L, index.peek(), by);
      }
      this.handlers.set(node.id, h);
      return { key, item, index, node, dispose };
    }, L.owner);
  }

  /** A dragged row passed its neighbour: move its item by one, in the data the list shows. */
  private moveListItem(L: ListState, from: number, by: number): void {
    const to = Math.max(0, Math.min(L.items.length - 1, from + by));
    if (to === from) return;
    const path = L.spec.items;
    // The order is written back, so `items` must be the list itself, not a sorted or filtered view of it.
    if (this.peekPath(path, L.scope) !== L.items) {
      this.error(`${L.where}.reorder`, `Reordering needs 'items' to be a data path such as "chores", not '${path}'`);
      return;
    }
    const next = [...L.items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    this.assign(path, L.scope, next);
  }

  private listOffsets(L: ListState): Float64Array {
    const n = L.items.length;
    if (L.offsets && L.offsets.length === n + 1) return L.offsets;
    const estimate = this.rowEstimate(L);
    const o = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) o[i + 1] = o[i] + (L.heights.get(L.keys[i]) ?? estimate);
    return (L.offsets = o);
  }

  private rowEstimate(L: ListState): number {
    if (!L.heights.size) return ROW_ESTIMATE;
    let sum = 0;
    for (const h of L.heights.values()) sum += h;
    return sum / L.heights.size;
  }

  /** Index of the item at `y` in list coordinates, clamped to the items. */
  private listIndexAt(L: ListState, y: number): number {
    const o = this.listOffsets(L);
    let lo = 0;
    let hi = L.items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (o[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** The visible part of a long list, in list coordinates: [top, bottom, viewport height]. */
  private listVisible(L: ListState): [number, number, number] | null {
    if (!L.body.mounted || L.body.lastLayoutKey === null) return null;
    if (!L.scroll) {
      let n = L.body.parent;
      while (n && n.type !== "scroll") n = n.parent;
      if (!n) return null;
      L.scroll = n;
      // Only scroll views with a long list inside report their offset.
      this.setProp(n, "reportScroll", true);
    }
    let top = 0;
    let n: ViewNode | null = L.body;
    while (n && n.parent !== L.scroll) {
      top += n.frame[1];
      n = n.parent;
    }
    if (!n) return null;
    const y = (this.scrollOffsets.get(L.scroll.id) ?? 0) - top;
    const height = L.scroll.frame[3] || this.viewport.height;
    return [y, y + height, height];
  }

  /** Rows to build: every item of a short list; for a long one, the visible part and a screen around it. */
  private listWindow(L: ListState): [number, number] {
    const n = L.items.length;
    if (n <= VIRTUALIZE_AFTER) return [0, n];
    const v = this.listVisible(L);
    if (!v) return [0, Math.min(n, Math.ceil((2 * this.viewport.height) / this.rowEstimate(L)))];
    const [from, to, height] = v;
    const start = this.listIndexAt(L, from - height);
    return [start, Math.max(start, Math.min(n, this.listIndexAt(L, to + height) + 1))];
  }

  /** After layout: moves the window of any long list whose rows no longer cover the visible part with margin. */
  private updateWindows(): boolean {
    let changed = false;
    for (const L of this.lists) {
      const n = L.items.length;
      if (!L.body.mounted || n <= VIRTUALIZE_AFTER) continue;
      const v = this.listVisible(L);
      if (!v) continue;
      const [from, to, height] = v;
      const need = [this.listIndexAt(L, from - height / 2), Math.min(n, this.listIndexAt(L, to + height / 2) + 1)];
      if (need[0] >= L.start && need[1] <= L.end) continue;
      this.reconcileList(L, null);
      changed = true;
    }
    return changed;
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
        ...(visual.fontFamily === "mono" ? { fontFamily: "mono" as const } : {}),
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
    if ("transition" in visual) {
      const t = normalizeTransition(visual.transition);
      if (t) visual.transition = t;
      else delete visual.transition;
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

  /** `quiet`: list rows entering or leaving their window, which the host shows without fading. */
  private setChildren(parent: ViewNode, next: ViewNode[], quiet?: Set<ViewNode>): void {
    const nextSet = new Set(next);
    for (const old of parent.children) {
      if (!nextSet.has(old)) {
        if (parent.mounted && old.mounted) this.structural.push(quiet?.has(old) ? ["remove", parent.id, old.id, true] : ["remove", parent.id, old.id]);
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
        this.structural.push(quiet?.has(n) ? ["insert", parent.id, n.id, i, true] : ["insert", parent.id, n.id, i]);
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
    this.scrollOffsets.delete(n.id);
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
        return this.controlSize("toggle", { width: 51, height: 31 });
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

  private controlSizes = new Map<string, Size>();

  private controlSize(type: string, fallback: Size): Size {
    let s = this.controlSizes.get(type);
    if (!s) {
      s = this.host.measureControl?.(type) ?? fallback;
      this.controlSizes.set(type, s);
    }
    return s;
  }

  private measureText(text: string, n: ViewNode, maxW: number): Size {
    if (!text) return { width: 0, height: 0 };
    const ts = this.textStyles.get(n) ?? TYPOGRAPHY.body;
    const w = isFinite(maxW) ? Math.floor(maxW) : 100000;
    const k = `${ts.fontFamily ?? ""}|${ts.fontSize}|${ts.fontWeight}|${ts.lineHeight}|${w}|${text}`;
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
        if (this.pinned) return;
        this.nav.set([...this.nav.peek(), { screen: a.navigate, params, transition: a.transition }]);
      } else if ("back" in a) {
        this.back();
      } else if ("if" in a) {
        const branch = this.evalExpr(a.if, scope, where) ? a.then : a.else;
        if (branch) this.run(branch, scope);
      } else if ("call" in a) {
        // Container services act outside the app: only the shell may use them.
        if (!this.trusted) return this.error(where, "Only the shell can call services");
        const service = this.services.get(a.call);
        if (!service) return this.error(where, `Unknown service '${a.call}'`);
        service((this.evalValue(a.args ?? {}, scope, where) ?? {}) as Record<string, unknown>);
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

  /** Deletes the app's stored data and starts it again from the spec defaults. */
  resetData(): void {
    if (!this.spec) return;
    try {
      this.store?.clear();
      this.host.secrets?.clear(this.spec.id);
      this.savedSecrets.clear();
    } catch (e) {
      this.error("storage", (e as Error).message);
    }
    for (const k of this.dataKeys) this.signals.delete(k);
    this.load(this.spec);
  }

  private openStore(app: string): DataStore | null {
    if (!this.host.db) return null;
    try {
      return new DataStore(this.host.db, app);
    } catch (e) {
      this.error("storage", (e as Error).message);
      return null;
    }
  }

  /** Stored values, with secret keys read from the host's secure storage. */
  private readStore(): Record<string, unknown> {
    let out: Record<string, unknown> = {};
    try {
      out = this.store?.read() ?? {};
    } catch (e) {
      this.error("storage", (e as Error).message);
    }
    const secrets = this.host.secrets;
    if (secrets && this.spec) {
      for (const k of this.secretKeys) {
        if (this.signals.has(k)) continue;
        try {
          const raw = secrets.get(this.spec.id, k);
          if (raw != null) out[k] = JSON.parse(raw);
          this.savedSecrets.set(k, raw == null ? undefined : out[k]);
        } catch (e) {
          this.error("secrets", `Cannot read '${k}': ${(e as Error).message}`);
        }
      }
    }
    return out;
  }

  private requestSave(): void {
    this.saveRequested = true;
    this.scheduleFrame();
  }

  private save(): void {
    this.saveRequested = false;
    if (this.store) {
      const values = new Map<string, unknown>();
      for (const k of this.dataKeys) if (!this.secretKeys.has(k)) values.set(k, this.signals.get(k)?.peek());
      try {
        // A key that became secret after it was saved in plain text: its value moves
        // to secure storage below, and the plain copy goes.
        const plain = [...this.secretKeys].filter((k) => this.store!.has(k));
        if (plain.length) this.store.remove(plain);
        this.store.write(values);
      } catch (e) {
        this.error("storage", (e as Error).message);
      }
    }
    this.saveSecrets();
  }

  private saveSecrets(): void {
    const secrets = this.host.secrets;
    if (!secrets || !this.spec) return;
    for (const k of this.secretKeys) {
      const value = this.signals.get(k)?.peek();
      if (this.savedSecrets.has(k) && this.savedSecrets.get(k) === value) continue;
      try {
        secrets.set(this.spec.id, k, value == null || value === "" ? null : JSON.stringify(value));
        this.savedSecrets.set(k, value);
      } catch (e) {
        // The message names the key only: a secret's value never goes to logs.
        this.error("secrets", `Cannot save '${k}': ${(e as Error).message}`);
      }
    }
  }
}

const PRIMITIVES = new Set(["root", "screen", ...Object.keys(NODE_TYPES)]);
const isPrimitive = (t: string) => PRIMITIVES.has(t);
export const PRIMITIVE_TYPES = [...PRIMITIVES].filter((t) => t !== "root" && t !== "screen");

function emptyStats(): FrameStats {
  return { bindingsMs: 0, layoutMs: 0, measureMs: 0, measureCalls: 0, measureCacheHits: 0, layoutCacheHits: 0, skippedSubtrees: 0, applyMs: 0, ops: 0 };
}

const EASINGS = new Set(["ease", "linear", "easeIn", "easeOut", "spring"]);

/** `style.transition` → `{duration, easing}` for hosts, or null when off. */
function normalizeTransition(t: unknown): { duration: number; easing: string } | null {
  if (t === true) return { duration: 250, easing: "ease" };
  if (typeof t === "number" || (typeof t === "string" && t.trim() !== "" && !isNaN(Number(t)))) {
    const duration = Number(t);
    return duration > 0 ? { duration, easing: "ease" } : null;
  }
  if (t && typeof t === "object") {
    const o = t as { duration?: unknown; easing?: unknown };
    const duration = o.duration === undefined ? 250 : Number(o.duration);
    const easing = typeof o.easing === "string" && EASINGS.has(o.easing) ? o.easing : "ease";
    return duration > 0 ? { duration, easing } : null;
  }
  return null;
}

/** The spec path of a node built from the app's spec, or null for the runtime's own nodes. */
function specPath(where: string): string | null {
  if (where.includes("~")) return null;
  return /^screens\.[^.]+\.(body|footer)/.test(where) || where.startsWith("components.") ? where : null;
}

/** `screens.main.body.children[1].row` → `/screens/main/body/children/1/row` (a JSON Pointer). */
function toPointer(path: string): string {
  return "/" + path.replace(/\[(\d+)\]/g, ".$1").split(".").map((k) => k.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

function hasRemove(actions: Actions | undefined): boolean {
  return (Array.isArray(actions) ? actions : actions ? [actions] : []).some((a) => "remove" in a);
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
