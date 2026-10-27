// Checks a spec before it replaces a working one: its shape against the JSON Schema
// (schema.ts), what a schema can't say (screens that exist, expressions that compile),
// then a headless render of every screen with a stub host, collecting the runtime's
// errors. A spec that passes renders on every platform; the errors go back to the model.
import type { Host, Op } from "../bridge.ts";
import { compileTemplate } from "../expr.ts";
import { Runtime } from "../runtime.ts";
import { schemaErrors, specSchema } from "../schema.ts";
import type { Action, AppSpec, NodeSpec } from "../spec.ts";

/** Problems with the spec, each with where it is; empty when it renders cleanly. */
export function validateSpec(spec: unknown): string[] {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["The spec must be a JSON object"];
  const s = spec as AppSpec;
  const components = s.components && typeof s.components === "object" ? s.components : {};
  const errors = schemaErrors(spec, specSchema(components));

  if (typeof s.start === "string" && s.screens && !s.screens[s.start]) errors.push(`start: no screen named '${s.start}'`);
  const screens = new Set(Object.keys(s.screens ?? {}));
  const checkActions = (actions: unknown, where: string): void => {
    for (const [i, a] of (Array.isArray(actions) ? actions : [actions]).entries()) {
      const w = Array.isArray(actions) ? `${where}[${i}]` : where;
      if (!a || typeof a !== "object") continue;
      if ("navigate" in a && !screens.has(a.navigate)) errors.push(`${w}: no screen named '${a.navigate}'`);
      else if ("call" in a) errors.push(`${w}: apps can't call container services`);
      else if ("if" in a) {
        const c = a as Extract<Action, { if: string }>;
        if (c.then) checkActions(c.then, `${w}.then`);
        if (c.else) checkActions(c.else, `${w}.else`);
      }
    }
  };
  // The schema checks the shapes; this walks every node for what it can't, skipping
  // whatever isn't shaped like a node (the schema has reported it).
  const checkNode = (n: NodeSpec, where: string): void => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return;
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
    if (n.type === "list") {
      checkNode(n.row as NodeSpec, `${where}.row`);
      if (n.empty && typeof n.empty === "object") checkNode(n.empty as NodeSpec, `${where}.empty`);
      if (Array.isArray(n.swipe)) for (const [i, a] of (n.swipe as { do?: Action }[]).entries()) checkActions(a?.do, `${where}.swipe[${i}].do`);
    }
  };
  for (const [name, screen] of Object.entries(s.screens ?? {})) {
    checkNode(screen?.body, `screens.${name}.body`);
    checkNode(screen?.footer as NodeSpec, `screens.${name}.footer`);
  }
  for (const [name, c] of Object.entries(components)) checkNode(c, `components.${name}`);
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
