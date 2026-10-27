import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { schemaErrors, specSchema, type Schema } from "../src/schema.ts";
import { validateSpec } from "../src/builder/validate.ts";

const load = (n: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${n}.json`, import.meta.url), "utf8"));
const app = (body: unknown, extra: Partial<AppSpec> = {}): AppSpec => ({ id: "t", name: "T", screens: { main: { body } }, ...extra }) as AppSpec;

test("every bundled spec conforms to the schema, the shell included", () => {
  for (const n of ["chores", "meds", "showcase", "water"]) assert.deepEqual(validateSpec(load(n)), [], n);
  const shell = load("shell");
  assert.deepEqual(schemaErrors(shell, specSchema(shell.components)), []);
});

test("typos and invented props are caught, with what was meant", () => {
  const errors = validateSpec(app({
    type: "column",
    children: [
      { type: "text", value: "Hi", style: { colour: "red", width: "big" } },
      { type: "button", labels: "Go" },
      { type: "text", value: "x", children: [] },
      { type: "toggle", onChange: { goto: "main" } },
      { type: "button", label: "Go", onTap: { set: "x" } },
    ],
  }, { data: { n: { type: "text" } } } as unknown as Partial<AppSpec>)).join("\n");
  assert.match(errors, /children\[0\]\.style: unknown style key 'colour'; did you mean 'color'\?/);
  assert.match(errors, /children\[0\]\.style\.width: expected a number, "50%" or "fill", or a \{\{binding\}\}, not "big"/);
  assert.match(errors, /children\[1\]: button has no 'labels'; did you mean 'label'\?/);
  assert.match(errors, /children\[2\]: text has no 'children' \(it takes value, variant\)/);
  assert.match(errors, /children\[3\]\.onChange: unknown action \{"goto":"main"\}/);
  assert.match(errors, /children\[4\]\.onTap: 'to' is required/);
  assert.match(errors, /data\.n\.type: expected one of string, number/);
  assert.match(validateSpec({ ...app({ type: "spacer" }), screens: { main: { titel: "x", body: { type: "spacer" } } } }).join(), /screen has no 'titel'; did you mean 'title'\?/);
});

test("bindings, aliases and an app's own components pass; a component's unknown prop doesn't", () => {
  const components = { Badge: { type: "text", value: "{{props.title}}" } };
  const ok = app({ type: "vstack", style: { width: "{{wide ? 300 : 200}}", padding: [8, 16] }, children: [{ type: "Badge", title: "New" }, { type: "progress", value: 0.5, track: "border" }] }, { components, state: { wide: true } } as Partial<AppSpec>);
  assert.deepEqual(validateSpec(ok), []);
  const bad = app({ type: "column", children: [{ type: "Badge", titel: "New" }] }, { components } as Partial<AppSpec>);
  assert.match(validateSpec(bad).join(), /Badge has no 'titel'; did you mean 'title'\?/);
});

test("the model's tool schema resolves every reference and leaves aliases out", () => {
  const schema = specSchema();
  const refs = [...JSON.stringify(schema).matchAll(/"\$ref":"#\/\$defs\/(\w+)"/g)].map((m) => m[1]);
  for (const r of new Set(refs)) assert.ok(schema.$defs![r], `$defs.${r}`);
  const types = (schema.$defs!.node.anyOf as Schema[]).map((b) => b.properties?.type?.const);
  assert.ok(types.includes("list") && !types.includes("vstack"));
});
