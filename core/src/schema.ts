// The JSON Schema of an app spec, built from the format tables in spec.ts, and a checker
// for it. The builder validates every model change against it and sends it to the model as
// the shape of its tool arguments. The checker covers the keywords `specSchema` emits, and
// words its errors for the model: where, what was wrong, and what would be right.

import { BUILTIN_COMPONENTS, TYPE_ALIASES } from "./builtins.ts";
import { ALIGN_ALIASES, JUSTIFY_ALIASES } from "./layout.ts";
import { ACTION_KINDS, COMMON_PROPS, FIELD_TYPES, NODE_TYPES, type NodeSpec, STYLE_KEYS, type ValueKind } from "./spec.ts";

export interface Schema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  /** Like additionalProperties, but `allOf` parts' properties count as known too. */
  unevaluatedProperties?: boolean;
  allOf?: Schema[];
  not?: Schema;
  items?: Schema;
  anyOf?: Schema[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  title?: string;
  description?: string;
}

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const BINDING: Schema = { type: "string", pattern: "\\{\\{", description: "a {{binding}}" };
const bound = (s: Schema, description: string): Schema => ({ anyOf: [s, BINDING], description: `${description}, or a {{binding}}` });
const words = (list: readonly string[]): Schema => ({ enum: [...list], description: `one of ${list.join(", ")}` });

/** Kinds shared by many props, defined once in `$defs` to keep the schema small. */
const SHARED_KINDS = ["text", "number", "boolean", "color", "dim", "edges", "expr", "path", "nodeOrText", "transition", "fontWeight", "align", "justify"] as const;

function kind(k: ValueKind): Schema {
  if (Array.isArray(k)) return bound(words(k), `one of ${k.join(", ")}`);
  return (SHARED_KINDS as readonly string[]).includes(k as string) ? ref(k as string) : kindSchema(k);
}

function kindSchema(k: ValueKind): Schema {
  switch (k) {
    case "text": return { type: ["string", "number", "boolean"], description: "text" };
    case "string": return { type: "string" };
    case "number": return bound({ type: "number" }, "a number");
    case "boolean": return bound({ type: "boolean" }, "true or false");
    case "color": return { type: "string", description: "a theme token or #hex" };
    case "dim": return bound({ anyOf: [{ type: "number" }, { type: "string", pattern: "^(\\d+(\\.\\d+)?%|fill)$" }] }, `a number, "50%" or "fill"`);
    case "edges": return bound({ anyOf: [{ type: "number" }, { type: "array", items: { type: "number" }, minItems: 1, maxItems: 4 }] }, "a number or a list of 2 or 4 numbers");
    case "expr": return { type: "string", description: "an expression, without {{ }}" };
    case "path": return { type: "string", description: "a state or data path" };
    case "actions": return ref("actions");
    case "node": return ref("node");
    case "style": return ref("style");
    case "nodeOrText": return { anyOf: [{ type: "string" }, ref("node")], description: "text or a node" };
    case "swipe":
      return {
        type: "array",
        items: { type: "object", title: "swipe action", properties: { label: kind("text"), color: kind("color"), do: ref("actions") }, required: ["label", "do"], additionalProperties: false },
      };
    case "transition":
      return bound(
        { anyOf: [{ type: ["number", "boolean"] }, { type: "object", title: "transition", properties: { duration: { type: "number" }, easing: words(["ease", "linear", "easeIn", "easeOut", "spring"]) }, additionalProperties: false }] },
        "milliseconds, true, or {duration, easing}",
      );
    case "fontWeight": return bound({ anyOf: [{ type: "number" }, words(["regular", "normal", "medium", "semibold", "bold", "heavy"])] }, "a number or a weight name");
    case "align": return bound(words(Object.keys(ALIGN_ALIASES)), "start, center, end or stretch");
    case "justify": return bound(words(Object.keys(JUSTIFY_ALIASES)), "start, center, end, between, around or evenly");
    default: return {};
  }
}

const props = (table: Record<string, ValueKind>) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, kind(v)]));

function nodeBranch(type: string, info: { props: Record<string, ValueKind>; children?: boolean }, required: string[] = []): Schema {
  return {
    type: "object",
    title: type,
    allOf: [ref("common")],
    properties: {
      type: { const: type },
      ...props(info.props),
      ...(info.children ? { children: { anyOf: [{ type: "array", items: ref("node") }, { const: "$children" }] } } : {}),
    },
    required: ["type", ...required],
    unevaluatedProperties: false,
  };
}

/** A component takes the props its template reads (`props.x`), and children if it has a slot. */
function componentBranch(name: string, tmpl: NodeSpec): Schema {
  const text = JSON.stringify(tmpl);
  const open = /\bprops\b(?!\.)/.test(text.replace(/"props":/g, ""));
  const used = Object.fromEntries([...text.matchAll(/\bprops\.([A-Za-z_$][\w$]*)/g)].map((m) => [m[1], "any" as ValueKind]));
  const branch = nodeBranch(name, { props: { ...used, props: "any", bind: "path" }, children: JSON.stringify(tmpl).includes(`"$children"`) });
  if (open) delete branch.unevaluatedProperties;
  return branch;
}

/**
 * The JSON Schema of a spec. With the spec's own components it checks their usages too.
 * Without them it is the model's tool schema: any other type passes as a component of the
 * app, and type aliases (vstack, label...) are left out so the model writes the real names.
 */
export function specSchema(components?: Record<string, NodeSpec>): Schema {
  const nodes: Schema[] = [
    ...Object.entries(NODE_TYPES).map(([t, info]) => nodeBranch(t, info, t === "list" ? ["items", "row"] : [])),
    ...(components ? Object.entries(TYPE_ALIASES).map(([alias, t]) => nodeBranch(alias, NODE_TYPES[t])) : []),
    // The app's own components come first: one named like a builtin replaces it.
    ...Object.entries(components ?? {}).filter(([n]) => !NODE_TYPES[n]).map(([name, tmpl]) => componentBranch(name, tmpl)),
    ...Object.entries(BUILTIN_COMPONENTS).map(([name, tmpl]) => componentBranch(name, tmpl)),
  ];
  if (!components) {
    const known = nodes.map((b) => b.properties!.type.const as string);
    nodes.push({ type: "object", title: "component", description: "a component from the app's components", properties: { type: { type: "string", not: { enum: known } } }, required: ["type"] });
  }
  const action = (k: string, properties: Record<string, Schema>, required: string[] = []): Schema => ({
    type: "object",
    title: `${k} action`,
    properties,
    required: [k, ...required],
    additionalProperties: false,
  });
  const expr = kind("expr");
  return {
    $defs: {
      ...Object.fromEntries(SHARED_KINDS.map((k) => [k, kindSchema(k)])),
      common: { properties: props(COMMON_PROPS), description: "keys every node takes" },
      node: { anyOf: nodes, description: "a node" },
      style: { type: "object", title: "style", properties: props(STYLE_KEYS), additionalProperties: false },
      action: {
        anyOf: [
          action("set", { set: kind("path"), to: {} }, ["to"]),
          action("toggle", { toggle: kind("path") }),
          action("push", { push: kind("path"), value: {} }, ["value"]),
          action("remove", { remove: kind("path"), at: expr, where: expr }),
          action("navigate", { navigate: { type: "string" }, params: { type: "object" }, transition: words(["slide", "fade", "none"]) }),
          action("back", { back: { type: "boolean" } }),
          action("if", { if: expr, then: ref("actions"), else: ref("actions") }, ["then"]),
          action("call", { call: { type: "string" }, args: { type: "object" } }),
        ],
        description: `an action: ${ACTION_KINDS.join(", ")}`,
      },
      actions: { anyOf: [ref("action"), { type: "array", items: ref("action") }], description: "an action or a list of actions" },
      field: {
        type: "object",
        title: "data field",
        properties: {
          type: words(FIELD_TYPES),
          default: {},
          fields: { type: "object", additionalProperties: { anyOf: [words(FIELD_TYPES), ref("field")] } },
          description: { type: "string" },
          secret: { type: "boolean" },
        },
        required: ["type"],
        additionalProperties: false,
      },
      screen: {
        type: "object",
        title: "screen",
        properties: { title: kind("text"), scroll: { type: "boolean" }, header: { type: "boolean" }, body: ref("node"), footer: ref("node") },
        required: ["body"],
        additionalProperties: false,
      },
      app: {
        type: "object",
        title: "spec",
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          theme: { type: "object", additionalProperties: { type: "string" } },
          darkTheme: { type: "object", additionalProperties: { type: "string" } },
          data: { type: "object", additionalProperties: ref("field") },
          state: { type: "object" },
          components: { type: "object", additionalProperties: ref("node") },
          screens: { type: "object", additionalProperties: ref("screen"), minProperties: 1 },
          start: { type: "string" },
        },
        required: ["id", "name", "screens"],
        additionalProperties: false,
      },
    },
    ...ref("app"),
  };
}

/**
 * The schema with its cycles cut, for model APIs that take no recursive schemas: where a
 * definition would contain itself again (a node's children, an if action's then), the
 * reference becomes a description of it. Every shape is still defined once in full.
 */
export function acyclic(schema: Schema): Schema {
  const defs = schema.$defs ?? {};
  const out: Record<string, Schema> = {};
  const visit = (name: string, stack: string[]) => {
    if (out[name]) return;
    out[name] = {};
    out[name] = cut(defs[name], [...stack, name]);
  };
  const cut = (s: Schema, stack: string[]): Schema => {
    if (s.$ref) {
      const name = s.$ref.replace("#/$defs/", "");
      if (stack.includes(name)) return { description: `${describe(defs[name], defs)}, shaped like $defs.${name}` };
      visit(name, stack);
      return s;
    }
    const copy: Schema = { ...s };
    if (s.properties) copy.properties = Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, cut(p, stack)]));
    if (s.items) copy.items = cut(s.items, stack);
    if (s.anyOf) copy.anyOf = s.anyOf.map((b) => cut(b, stack));
    if (s.allOf) copy.allOf = s.allOf.map((b) => cut(b, stack));
    if (s.additionalProperties && typeof s.additionalProperties === "object") copy.additionalProperties = cut(s.additionalProperties, stack);
    delete copy.$defs;
    return copy;
  };
  const root = cut(schema, []);
  for (const name of Object.keys(defs)) visit(name, []);
  return { ...root, $defs: out };
}

// ---------- Checking ----------

/** Problems with `value` against `schema`, as "where: what" lines; empty when it conforms. */
export function schemaErrors(value: unknown, schema: Schema): string[] {
  const errors: string[] = [];
  check(value, schema, schema.$defs ?? {}, "", errors);
  return errors;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const at = (where: string, key: string) => (where ? `${where}.${key}` : key);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
};

function resolve(s: Schema, defs: Record<string, Schema>): Schema {
  while (s.$ref) s = defs[s.$ref.replace("#/$defs/", "")] ?? {};
  return s;
}

function typeMatches(v: unknown, type: string | string[]): boolean {
  const t = typeOf(v);
  return (Array.isArray(type) ? type : [type]).some((x) => x === t || (x === "number" && t === "integer"));
}

function describe(s: Schema, defs: Record<string, Schema>): string {
  s = resolve(s, defs);
  if (s.description) return s.description;
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return `one of ${s.enum.join(", ")}`;
  if (s.anyOf) return s.anyOf.map((b) => describe(b, defs)).join(" or ");
  const t = Array.isArray(s.type) ? s.type.join(" or ") : s.type;
  return t === "object" ? `an object${s.title ? ` (${s.title})` : ""}` : t === "array" ? "a list" : `a ${t ?? "value"}`;
}

/** The alternatives of an `anyOf`, with nested ones (text or a node, one action or a list) spread out. */
function flatten(branches: Schema[], defs: Record<string, Schema>): Schema[] {
  return branches.flatMap((b) => {
    const r = resolve(b, defs);
    return r.anyOf ? flatten(r.anyOf, defs) : [r];
  });
}

/** The branch a value is evidently meant to be: its `type` (nodes) or first key (actions) matches. */
function intended(v: unknown, branches: Schema[]): Schema | undefined {
  if (typeOf(v) !== "object") return branches.find((b) => b.type && typeMatches(v, b.type) && !b.pattern);
  const o = v as Record<string, unknown>;
  return branches.find((b) => {
      if (b.type && !typeMatches(v, b.type)) return false;
      const consts = Object.entries(b.properties ?? {}).filter(([, p]) => p.const !== undefined);
      if (consts.length) return consts.every(([k, p]) => o[k] === p.const);
      return !!b.required?.length && b.required[0] in o;
    });
}

function check(v: unknown, schema: Schema, defs: Record<string, Schema>, where: string, errors: string[]): void {
  const s = resolve(schema, defs);
  const here = where || "spec";
  if (s.anyOf) {
    // Only the branch the value is meant to be is checked in depth; trying every node type
    // on every node would take exponential time.
    const branches = flatten(s.anyOf, defs);
    const branch = intended(v, branches);
    if (branch) return check(v, branch, defs, where, errors);
    if (branches.some((b) => {
      const e: string[] = [];
      check(v, b, defs, where, e);
      return !e.length;
    })) return;
    const o = v as Record<string, unknown> | null;
    if (typeOf(v) === "object" && typeof o!.type === "string" && branches.some((b) => b.properties?.type?.const !== undefined)) {
      errors.push(`${here}: unknown type '${o!.type}'`);
    } else if (typeOf(v) === "object" && branches.some((b) => b.title?.endsWith(" action"))) {
      errors.push(`${here}: unknown action ${show(v)}; use one of ${ACTION_KINDS.join(", ")}`);
    } else {
      errors.push(`${here}: expected ${describe(s, defs)}, not ${show(v)}`);
    }
    return;
  }
  if (s.not) {
    const e: string[] = [];
    check(v, s.not, defs, where, e);
    if (!e.length) return void errors.push(`${here}: ${show(v)} isn't allowed here`);
  }
  if (s.const !== undefined && v !== s.const) return void errors.push(`${here}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) return void errors.push(`${here}: expected one of ${s.enum.join(", ")}, not ${show(v)}`);
  if (s.type && !typeMatches(v, s.type)) return void errors.push(`${here}: expected ${describe(s, defs)}, not ${show(v)}`);
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${here}: must not be empty`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${here}: expected ${describe(s, defs)}, not ${show(v)}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${here}: needs at least ${s.minItems} item(s)`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${here}: takes at most ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => check(item, s.items!, defs, `${where}[${i}]`, errors));
  }
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) errors.push(`${here}: '${k}' is required`);
    if (s.minProperties !== undefined && Object.keys(o).length < s.minProperties) errors.push(`${here}: needs at least ${s.minProperties} entry`);
    // allOf parts here only add properties (the keys every node takes).
    const known: Record<string, Schema> = Object.assign({}, ...(s.allOf ?? []).map((p) => resolve(p, defs).properties ?? {}), s.properties);
    const closed = s.additionalProperties === false || s.unevaluatedProperties === false;
    for (const [k, val] of Object.entries(o)) {
      const p = known[k];
      if (p) check(val, p, defs, at(where, k), errors);
      else if (closed) errors.push(unknownKey(here, k, { ...s, properties: known }));
      else if (s.additionalProperties && typeof s.additionalProperties === "object") check(val, s.additionalProperties, defs, at(where, k), errors);
    }
  }
}

function unknownKey(where: string, key: string, s: Schema): string {
  const known = Object.keys(s.properties ?? {}).filter((k) => k !== "type");
  const near = closest(key, known);
  const hint = near ? `; did you mean '${near}'?` : "";
  if (s.title === "style") return `${where}: unknown style key '${key}'${hint || "; see Style for the keys"}`;
  const own = s.title && NODE_TYPES[s.title] ? Object.keys(NODE_TYPES[s.title].props) : known;
  const takes = own.length ? ` (it takes ${own.join(", ")})` : "";
  return `${where}: ${s.title ? `${s.title} has no '${key}'` : `unknown key '${key}'`}${hint}${hint ? "" : takes}`;
}

/** The known key a typo was likely meant to be. */
function closest(key: string, known: string[]): string | undefined {
  const k = key.toLowerCase();
  let best: string | undefined;
  let score = Infinity;
  for (const c of known) {
    const d = distance(k, c.toLowerCase());
    if (d < score) [best, score] = [c, d];
  }
  return score <= Math.max(1, Math.floor(key.length / 4)) ? best : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  // A swapped pair of letters (titel) counts as one edit.
  const swapped = a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 2 && [...a].sort().join("") === [...b].sort().join("");
  return swapped ? Math.min(1, row[b.length]) : row[b.length];
}
