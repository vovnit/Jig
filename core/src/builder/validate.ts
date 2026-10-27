// Checks a spec before it replaces a working one: its structure, then a headless render
// of every screen with a stub host, collecting the runtime's errors. A spec that passes
// renders on every platform; the errors go back to the model to repair.
import type { Host, Op } from "../bridge.ts";
import { BUILTIN_COMPONENTS, TYPE_ALIASES } from "../builtins.ts";
import { compileTemplate } from "../expr.ts";
import { PRIMITIVE_TYPES, Runtime } from "../runtime.ts";
import type { Action, AppSpec, NodeSpec } from "../spec.ts";

const ACTIONS = ["set", "toggle", "push", "remove", "navigate", "back", "if", "call"];
const FIELD_TYPES = new Set(["string", "number", "boolean", "date", "datetime", "list", "object"]);

/** Problems with the spec, each with where it is; empty when it renders cleanly. */
export function validateSpec(spec: unknown): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["The spec must be a JSON object"];
  const s = spec as AppSpec;
  if (typeof s.id !== "string" || !s.id) errors.push("id: a non-empty string is required");
  if (typeof s.name !== "string" || !s.name) errors.push("name: a non-empty string is required");
  if (!s.screens || typeof s.screens !== "object" || !Object.keys(s.screens).length) {
    errors.push("screens: at least one screen is required");
    return errors;
  }
  if (s.start !== undefined && !s.screens[s.start]) errors.push(`start: no screen named '${s.start}'`);
  for (const [k, f] of Object.entries(s.data ?? {})) {
    if (!f || typeof f !== "object" || !FIELD_TYPES.has((f as { type: string }).type)) {
      errors.push(`data.${k}: needs a type, one of ${[...FIELD_TYPES].join(", ")}`);
    }
  }

  const known = new Set([...PRIMITIVE_TYPES, ...Object.keys(TYPE_ALIASES), ...Object.keys(BUILTIN_COMPONENTS), ...Object.keys(s.components ?? {})]);
  const screens = new Set(Object.keys(s.screens));
  const checkActions = (actions: unknown, where: string): void => {
    for (const [i, a] of (Array.isArray(actions) ? actions : [actions]).entries()) {
      const w = Array.isArray(actions) ? `${where}[${i}]` : where;
      if (!a || typeof a !== "object") {
        errors.push(`${w}: an action must be an object`);
        continue;
      }
      const kind = ACTIONS.find((k) => k in a);
      if (!kind) errors.push(`${w}: unknown action ${JSON.stringify(a)}; use one of ${ACTIONS.join(", ")}`);
      else if (kind === "navigate" && !screens.has((a as { navigate: string }).navigate)) errors.push(`${w}: no screen named '${(a as { navigate: string }).navigate}'`);
      else if (kind === "call") errors.push(`${w}: apps can't call container services`);
      else if (kind === "if") {
        const c = a as Extract<Action, { if: string }>;
        if (c.then) checkActions(c.then, `${w}.then`);
        if (c.else) checkActions(c.else, `${w}.else`);
      }
    }
  };
  const checkNode = (node: unknown, where: string): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push(`${where}: a node must be an object with a 'type'`);
      return;
    }
    const n = node as NodeSpec;
    if (typeof n.type !== "string") errors.push(`${where}: missing 'type'`);
    else if (!known.has(n.type)) errors.push(`${where}: unknown type '${n.type}'`);
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith("on") && v) checkActions(v, `${where}.${k}`);
      else if (typeof v === "string" && v.includes("{{")) {
        try {
          compileTemplate(v);
        } catch (e) {
          errors.push(`${where}.${k}: ${(e as Error).message}`);
        }
      }
    }
    if (Array.isArray(n.children)) n.children.forEach((c, i) => checkNode(c, `${where}.children[${i}]`));
    if (n.child) checkNode(n.child, `${where}.child`);
    if (n.type === "list") {
      if (typeof n.items !== "string") errors.push(`${where}.items: an expression for the items is required`);
      if (n.row) checkNode(n.row, `${where}.row`);
      else errors.push(`${where}.row: a node for each row is required`);
      if (n.empty && typeof n.empty === "object") checkNode(n.empty, `${where}.empty`);
      for (const [i, a] of ((n.swipe as { do?: unknown }[] | undefined) ?? []).entries()) checkActions(a?.do, `${where}.swipe[${i}].do`);
    }
  };
  for (const [name, screen] of Object.entries(s.screens)) {
    if (!screen || typeof screen !== "object" || !screen.body) {
      errors.push(`screens.${name}: a body node is required`);
      continue;
    }
    checkNode(screen.body, `screens.${name}.body`);
    if (screen.footer) checkNode(screen.footer, `screens.${name}.footer`);
  }
  for (const [name, c] of Object.entries(s.components ?? {})) checkNode(c, `components.${name}`);
  if (errors.length) return errors;

  // Render every screen, as a whiteboard card would.
  for (const name of screens) {
    for (const e of render(s, name)) {
      const line = `${e.where}: ${e.message}`;
      if (!errors.includes(line)) errors.push(line);
    }
  }
  return errors;
}

/** A layout-only host: text is measured roughly, nothing is drawn. */
function stubHost(): Host & { frames: (() => void)[] } {
  const host = {
    frames: [] as (() => void)[],
    apply(_ops: Op[]) {},
    measureText: (text: string, style: { fontSize: number; lineHeight: number }, maxWidth: number) => {
      const width = text.length * style.fontSize * 0.5;
      const lines = Math.max(1, Math.ceil(width / Math.max(1, maxWidth)));
      return { width: Math.min(width, maxWidth), height: lines * style.lineHeight };
    },
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
