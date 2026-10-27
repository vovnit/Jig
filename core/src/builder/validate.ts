// Checks a spec before it replaces a working one: its shape against the JSON Schema
// (schema.ts), what a schema can't say (screens that exist, expressions that compile),
// then a headless render of every screen with a stub host, collecting the runtime's
// errors. A spec that passes renders on every platform; the errors go back to the model.
import type { Host, Op } from "../bridge.ts";
import { TYPE_ALIASES } from "../builtins.ts";
import { compile, compileTemplate, freeIdentifiers } from "../expr.ts";
import { Runtime } from "../runtime.ts";
import { schemaErrors, specSchema } from "../schema.ts";
import { WIDGET_SIZES } from "../spec.ts";
import { widgetErrors } from "../widgets.ts";
import { ASYNC_ACTIONS, CAPABILITIES, COMMON_PROPS, NODE_TYPES, type Action, type AppSpec, type NodeSpec } from "../spec.ts";

/** Problems with the spec, each with where it is; empty when it renders cleanly. */
export function validateSpec(spec: unknown): string[] {
  const { errors, unfinished } = specProblems(spec);
  return [...errors, ...unfinished];
}

/**
 * The spec's errors (it can't be applied), and what is unfinished: a button that navigates
 * to a screen not written yet. An app is built in steps, so an unfinished one may be applied
 * and previewed, but the model can't finish with it.
 */
export function specProblems(spec: unknown): { errors: string[]; unfinished: string[] } {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { errors: ["The spec must be a JSON object"], unfinished: [] };
  const s = spec as AppSpec;
  const components = s.components && typeof s.components === "object" ? s.components : {};
  const errors = schemaErrors(spec, specSchema(components));
  const unfinished: string[] = [];

  if (typeof s.start === "string" && s.screens && !s.screens[s.start]) errors.push(`start: no screen named '${s.start}'`);
  const screens = new Set(Object.keys(s.screens ?? {}));
  if (s.schedule && typeof s.schedule === "object") {
    if (!s.capabilities?.includes("notifications")) errors.push('schedule: add "notifications" to capabilities');
    for (const [key, entry] of Object.entries(s.schedule)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.open && !screens.has(entry.open)) errors.push(`schedule.${key}.open: no screen named '${entry.open}'`);
      for (const field of ["at", "title", "body"] as const) {
        if (typeof entry[field] === "string") try { compileTemplate(entry[field] as string); } catch (e) { errors.push(`schedule.${key}.${field}: ${(e as Error).message}`); }
      }
      if (entry.if) try { compile(entry.if); } catch (e) { errors.push(`schedule.${key}.if: ${(e as Error).message}`); }
    }
  }
  // Declared capabilities; using a live value or an async action without its own is rejected.
  const granted = new Set(Array.isArray(s.capabilities) ? s.capabilities : []);
  // Names in scope shadow a live value of the same name (the scope reads it first):
  // data and state keys everywhere, loop variables and component `props` where they apply.
  const baseScope = new Set([...Object.keys(s.data ?? {}), ...Object.keys(s.state ?? {})]);
  const needCap = (where: string, cap: string) => {
    const line = `${where}: uses '${cap}'; add "${cap}" to capabilities`;
    if (!granted.has(cap) && !errors.includes(line)) errors.push(line);
  };
  /** Requires the capabilities of the live values these names use. `now()` reads the clock, but only in a binding. */
  const needLive = (where: string, ids: Iterable<string>, scope: Set<string>, allowNow = true) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (id === "now" && !allowNow) continue;
      const cap = id === "now" ? "clock" : id;
      if (id !== "now" && scope.has(id)) continue;
      if (!Object.hasOwn(CAPABILITIES, cap) || seen.has(cap)) continue;
      seen.add(cap);
      needCap(where, cap);
    }
  };
  /** An action value is an expression string, or an object whose values are expressions. `now()` here is a timestamp. */
  const checkValue = (v: unknown, where: string, scope: Set<string>): void => {
    if (typeof v === "string") needLive(where, freeIdentifiers(v), scope, false);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) checkValue(x, `${where}.${k}`, scope);
    }
  };
  const checkActions = (actions: unknown, where: string, scope: Set<string>): void => {
    for (const [i, a] of (Array.isArray(actions) ? actions : [actions]).entries()) {
      const w = Array.isArray(actions) ? `${where}[${i}]` : where;
      if (!a || typeof a !== "object") continue;
      const first = Object.keys(a)[0];
      if (first && Object.hasOwn(ASYNC_ACTIONS, first)) {
        const cap = ASYNC_ACTIONS[first].capability;
        needCap(w, cap);
        checkValue((a as Record<string, unknown>)[first], `${w}.${first}`, scope);
        const branch = a as { then?: unknown; else?: unknown };
        if (branch.then) checkActions(branch.then, `${w}.then`, scope);
        if (branch.else) checkActions(branch.else, `${w}.else`, scope);
      } else if ("navigate" in a && !screens.has(a.navigate)) unfinished.push(`${w}: no screen named '${a.navigate}' yet`);
      else if ("call" in a) errors.push(`${w}: apps can't call container services`);
      else if ("if" in a) {
        const c = a as Extract<Action, { if: string }>;
        if (typeof c.if === "string") needLive(w, freeIdentifiers(c.if), scope, false);
        if (c.then) checkActions(c.then, `${w}.then`, scope);
        if (c.else) checkActions(c.else, `${w}.else`, scope);
      }
      if ("set" in a && typeof (a as { to?: unknown }).to !== "undefined") checkValue((a as { to: unknown }).to, `${w}.to`, scope);
      if ("push" in a && typeof (a as { value?: unknown }).value !== "undefined") checkValue((a as { value: unknown }).value, `${w}.value`, scope);
      if ("remove" in a) {
        const r = a as { at?: unknown; where?: unknown };
        if (typeof r.at === "string") needLive(`${w}.at`, freeIdentifiers(r.at), scope, false);
        if (typeof r.where === "string") needLive(`${w}.where`, freeIdentifiers(r.where), scope, false);
      }
      if ("navigate" in a && (a as { params?: unknown }).params) {
        const params = (a as { params: Record<string, unknown> }).params;
        if (params && typeof params === "object") for (const [k, v] of Object.entries(params)) checkValue(v, `${w}.params.${k}`, scope);
      }
    }
  };
  /** Checks a template string as a binding (props, style, if, each, items, key). */
  const checkBinding = (v: string, where: string, scope: Set<string>): void => {
    if (v.includes("{{")) {
      try {
        compileTemplate(v);
      } catch (e) {
        errors.push(`${where}: ${(e as Error).message}`);
      }
    }
    needLive(where, freeIdentifiers(v), scope, true);
  };
  // The schema checks the shapes; this walks every node for what it can't, skipping
  // whatever isn't shaped like a node (the schema has reported it).
  // Templates used by a screen are checked with their usage's scope (its loop names and
  // `props`), as the runtime evaluates them; templates nothing uses are checked alone.
  const used = new Set<string>();
  const checkNode = (n: NodeSpec, where: string, scope: Set<string>, chain: string[] = []): void => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return;
    // A repeated node's item scope: `each`/`as`/`indexAs` shadow for everything but `each` itself.
    let inner = scope;
    if (typeof (n as { each?: unknown }).each === "string") {
      inner = new Set(scope);
      const as = typeof n.as === "string" && n.as ? n.as : "item";
      const indexAs = typeof n.indexAs === "string" && n.indexAs ? n.indexAs : "index";
      inner.add(as);
      inner.add(indexAs);
    }
    // A list row's scope, for its row and row actions.
    let rowScope: Set<string> | null = null;
    if (n.type === "list") {
      rowScope = new Set(scope);
      const as = typeof (n as { as?: unknown }).as === "string" && (n as { as?: string }).as ? (n as { as?: string }).as as string : "item";
      const indexAs = typeof (n as { indexAs?: unknown }).indexAs === "string" && (n as { indexAs?: string }).indexAs ? (n as { indexAs?: string }).indexAs as string : "index";
      rowScope.add(as);
      rowScope.add(indexAs);
      rowScope.add("$last");
    }
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("on") && v) checkActions(v, `${where}.${k}`, rowScope ?? inner);
      else if (k === "style" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (typeof sv === "string" && sv.includes("{{")) needLive(`${where}.style.${sk}`, freeIdentifiers(sv), inner, true);
        }
      } else if (k === "props" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [pk, pv] of Object.entries(v)) {
          if (typeof pv === "string" && pv.includes("{{")) checkBinding(pv, `${where}.props.${pk}`, inner);
        }
      } else if (k === "rowStyle" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (typeof sv === "string" && sv.includes("{{")) needLive(`${where}.rowStyle.${sk}`, freeIdentifiers(sv), rowScope ?? inner, true);
        }
      } else if (k === "swipe" && Array.isArray(v)) {
        for (const [i, a] of (v as { label?: unknown }[]).entries()) {
          if (typeof a?.label === "string" && (a.label as string).includes("{{"))
            needLive(`${where}.swipe[${i}].label`, freeIdentifiers(a.label as string), rowScope ?? inner, true);
        }
      } else if (k === "spans" && Array.isArray(v)) {
        // Styled runs: each span's text, color and link may bind.
        for (const [i, span] of (v as unknown[]).entries()) {
          if (!span || typeof span !== "object" || Array.isArray(span)) continue;
          for (const sk of ["text", "color", "link"]) {
            const sv = (span as Record<string, unknown>)[sk];
            if (typeof sv === "string" && sv.includes("{{")) checkBinding(sv, `${where}.spans[${i}].${sk}`, inner);
          }
        }
      } else if (typeof v === "string" && (v.includes("{{") || isBareExpr(n.type, k))) {
        // `each` and a list's `items` run outside the item scope; `key` runs inside it.
        if (k === "each") checkBinding(v, `${where}.${k}`, scope);
        else if (n.type === "list" && k === "items") checkBinding(v, `${where}.${k}`, scope);
        else if (n.type === "list" && (k === "as" || k === "indexAs")) continue;
        else if (n.type === "list" && k === "key") checkBinding(v, `${where}.${k}`, rowScope ?? inner);
        else checkBinding(v, `${where}.${k}`, inner);
      }
    }
    if (Array.isArray(n.children)) n.children.forEach((c, i) => checkNode(c, `${where}.children[${i}]`, inner, chain));
    // A component usage checks its template with the usage's scope.
    const resolved = TYPE_ALIASES[n.type] ?? n.type;
    const tmpl = (components as Record<string, NodeSpec>)[resolved];
    if (tmpl && !chain.includes(resolved)) {
      used.add(resolved);
      checkNode(tmpl, `components.${resolved}`, new Set([...inner, "props"]), [...chain, resolved]);
    }
    if (n.type === "list") {
      checkNode(n.row as NodeSpec, `${where}.row`, rowScope ?? inner, chain);
      if (n.empty && typeof n.empty === "object") checkNode(n.empty as NodeSpec, `${where}.empty`, scope, chain);
      if (Array.isArray(n.swipe)) for (const [i, a] of (n.swipe as { do?: Action }[]).entries()) checkActions(a?.do, `${where}.swipe[${i}].do`, rowScope ?? inner);
    }
  };
  for (const [name, screen] of Object.entries(s.screens ?? {})) {
    const sc = screen as { title?: unknown; body?: NodeSpec; footer?: NodeSpec };
    if (typeof sc?.title === "string" && sc.title.includes("{{")) checkBinding(sc.title, `screens.${name}.title`, baseScope);
    checkNode(screen?.body, `screens.${name}.body`, baseScope);
    checkNode(screen?.footer as NodeSpec, `screens.${name}.footer`, baseScope);
  }
  for (const [name, c] of Object.entries(components).filter(([k]) => !used.has(k))) {
    checkNode(c, `components.${name}`, new Set([...baseScope, "props"]));
  }
  if (s.widgets && typeof s.widgets === "object") {
    const widgetScope = new Set([...baseScope, "widget"]);
    for (const [name, w] of Object.entries(s.widgets)) {
      if (!w || typeof w !== "object") continue;
      if (w.open && !screens.has(w.open)) errors.push(`widgets.${name}.open: no screen named '${w.open}'`);
      if (w.body && typeof w.body === "object") checkNode(w.body as NodeSpec, `widgets.${name}.body`, widgetScope);
    }
  }
  if (errors.length) return { errors, unfinished };

  // Render every screen, as a whiteboard card would.
  for (const name of screens) {
    for (const e of render(s, name)) {
      const line = `${e.where}: ${e.message}`;
      if (!errors.includes(line)) errors.push(line);
    }
  }
  // Render every widget at every size: a widget that fails here fails on the home screen.
  if (s.widgets && typeof s.widgets === "object") {
    const now = Date.now();
    for (const [name, w] of Object.entries(s.widgets)) {
      if (!w || typeof w !== "object" || !Array.isArray(w.sizes)) continue;
      for (const size of w.sizes) {
        if (!Object.hasOwn(WIDGET_SIZES, size)) continue;
        for (const line of widgetErrors(s, name, size, measureStub, now)) {
          if (!errors.includes(line)) errors.push(line);
        }
      }
    }
  }
  return { errors, unfinished };
}

/** A node prop written as a bare expression (no {{ }}): `if`, `each`, `key`, `items`. */
function isBareExpr(type: string, key: string): boolean {
  if ((COMMON_PROPS[key] as string) === "expr") return true;
  return ((NODE_TYPES[TYPE_ALIASES[type] ?? type]?.props[key] as string) ?? "") === "expr";
}

/** A layout-only host: text is measured roughly, nothing is drawn. */
function measureStub(text: string, style: { fontSize: number; lineHeight: number }, maxWidth: number) {
  const width = text.length * style.fontSize * 0.5;
  const lines = Math.max(1, Math.ceil(width / Math.max(1, maxWidth)));
  return { width: Math.min(width, maxWidth), height: lines * style.lineHeight };
}
function stubHost(): Host & { frames: (() => void)[] } {
  const host = {
    frames: [] as (() => void)[],
    apply(_ops: Op[]) {},
    measureText: measureStub,
    requestFrame: (cb: () => void) => void host.frames.push(cb),
  };
  return host;
}

function render(spec: AppSpec, screen: string) {
  const host = stubHost();
  const rt = new Runtime(host);
  try {
    rt.load(JSON.parse(JSON.stringify(spec)), { fresh: true, screen });
    for (let i = 0; i < 5 && host.frames.length; i++) host.frames.splice(0).forEach((cb) => cb());
  } catch (e) {
    return [{ where: `screens.${screen}`, message: (e as Error).message }];
  }
  return rt.errors;
}
