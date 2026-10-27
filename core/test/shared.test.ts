// The shared personal data store: named collections published from one app's
// lists and read as `shared.<name>` by others, with the user's permission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { installBuilder } from "../src/builder/index.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { runEdit } from "../src/builder/agent.ts";
import { deviceCollections, formatCollections, projectPublisher } from "../src/shared.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import { DataStore } from "../src/store.ts";
import { Runtime } from "../src/runtime.ts";
import { boot, frame, makeDb, makeHost } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const load = (n: string): AppSpec => JSON.parse(readFileSync(new URL(`../../specs/${n}.json`, import.meta.url), "utf8"));

const pub = (id: string, name: string, log: unknown[] = [], extra: Partial<AppSpec> = {}): AppSpec => ({
  id,
  name,
  data: { log: { type: "list", fields: { id: "string", day: "date", kind: "string", minutes: "number", calories: "number" }, default: log } },
  publish: { workouts: { from: "log", doc: "Workouts I logged", fields: ["day", "kind", "minutes", "calories"] } },
  screens: { main: { body: { type: "text", value: "pub" } } },
  ...extra,
}) as AppSpec;

const reader = (id = "meals", name = "Meal planner", extra: Partial<AppSpec> = {}): AppSpec => ({
  id,
  name,
  data: { meals: { type: "list", fields: { id: "string", day: "date", name: "string", calories: "number" }, default: [] } },
  read: ["workouts"],
  screens: { main: { body: { type: "text", value: "count {{len(shared.workouts)}}" } } },
  ...extra,
}) as AppSpec;

/** A shell that embeds `runningIds` but lists every app, so closed apps read from storage. */
function bootShell(all: AppSpec[], runningIds: string[], db = makeDb()) {
  const host = makeHost(db);
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    data: { grants: { type: "object", default: {} } },
    state: { apps: all.map((spec) => ({ id: spec.id, spec })), asking: null },
    screens: {
      main: {
        body: {
          type: "column",
          children: runningIds.map((id) => ({ type: "app", spec: `{{find(apps, a => a.id == '${id}').spec}}` })),
        },
      },
    },
  } as unknown as AppSpec;
  const rt = new Runtime(host, { trusted: true });
  rt.setViewport(390, 844);
  installBuilder(rt);
  rt.load(shellSpec);
  frame(host);
  return { host, rt };
}

const child = (rt: Runtime, id: string): Runtime => {
  const c = rt.children.find((r) => r.spec?.id === id);
  assert.ok(c, `running ${id}`);
  return c;
};
const peekShared = (rt: Runtime, name: string): unknown[] =>
  (rt as unknown as { sharedSignals: Map<string, { peek(): unknown[] }> }).sharedSignals.get(name)?.peek() ?? [];
const answer = (rt: Runtime, allow: boolean) =>
  rt.run({ call: "builder.answer", args: { allow } }, { lookup: () => undefined, has: () => false });

test("a reader sees a running publisher's items, only published fields, and live updates", async () => {
  const item = { id: "w1", day: "2026-10-26", kind: "run", minutes: 30, calories: 300, extra: "hidden" };
  const { host, rt } = bootShell([pub("workouts", "Workout log", [item]), reader()], ["workouts", "meals"]);
  await tick();
  assert.match(String((rt.get("asking") as { text?: string })?.text ?? ""), /Meal planner wants to read your workouts from Workout log\./);
  answer(rt, true);
  await tick();
  frame(host);
  await tick();
  frame(host);
  const meals = child(rt, "meals");
  assert.deepEqual(meals.errors, []);
  const seen = peekShared(meals, "workouts") as Record<string, unknown>[];
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["app", "appName", "calories", "day", "kind", "minutes"]);
  assert.equal(seen[0].app, "workouts");
  assert.equal(seen[0].appName, "Workout log");

  // New items show at once through the running app's live data.
  const run = child(rt, "workouts");
  run.set("log", [...(run.get("log") as unknown[]), { id: "w2", day: "2026-10-26", kind: "walk", minutes: 20, calories: 80 }]);
  frame(host);
  await tick();
  frame(host);
  assert.equal((peekShared(meals, "workouts") as unknown[]).length, 2);
});

test("a closed publisher's stored items are read too", async () => {
  const db = makeDb();
  new DataStore(db, "workouts").write(
    new Map([["log", [{ id: "w1", day: "2026-10-26", kind: "ride", minutes: 40, calories: 320 }]]]),
  );
  const { host, rt } = bootShell([pub("workouts", "Workout log"), reader()], ["meals"], db);
  await tick();
  answer(rt, true);
  await tick();
  frame(host);
  await tick();
  frame(host);
  const seen = peekShared(child(rt, "meals"), "workouts") as Record<string, unknown>[];
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "ride");
  assert.equal(seen[0].appName, "Workout log");
});

test("two publishers of one collection are merged by publisher name", async () => {
  const a = pub("b-id", "Zebra log", [{ id: "w1", day: "2026-10-26", kind: "run", minutes: 10, calories: 100 }]);
  const b = pub("a-id", "Alpha log", [{ id: "w2", day: "2026-10-26", kind: "swim", minutes: 20, calories: 220 }]);
  const { host, rt } = bootShell([a, b, reader()], ["b-id", "a-id", "meals"]);
  await tick();
  answer(rt, true);
  await tick();
  frame(host);
  await tick();
  frame(host);
  const seen = peekShared(child(rt, "meals"), "workouts") as Record<string, unknown>[];
  assert.deepEqual(seen.map((w) => w.appName), ["Alpha log", "Zebra log"]);
});

test("the gate asks once per reader and collection; denial empties with one error; own needs no ask", async () => {
  const twoReads = reader("meals", "Meal planner", {
    screens: { main: { body: { type: "column", children: [{ type: "text", value: "{{len(shared.workouts)}}" }, { type: "text", value: "{{len(shared.workouts)}}" }] } } },
  });
  const other = reader("other", "Other app");
  const { host, rt } = bootShell([pub("workouts", "Workout log", [{ id: "w1", day: "2026-10-26", kind: "run", minutes: 10, calories: 100 }]), twoReads, other], ["workouts", "meals", "other"]);
  await tick();
  // Two bindings to one collection share one question.
  assert.equal((rt.get("asking") as { app?: string })?.app, "meals");
  answer(rt, false);
  await tick();
  frame(host);
  await tick();
  frame(host);
  const denied = child(rt, "meals");
  assert.deepEqual(peekShared(denied, "workouts"), []);
  assert.equal(denied.errors.filter((e) => e.message === "Reading workouts isn't allowed").length, 1);
  assert.deepEqual((rt.get("grants") as Record<string, Record<string, boolean>>).meals, { "shared.workouts": false });

  // Another reader is asked separately.
  await tick();
  assert.equal((rt.get("asking") as { app?: string })?.app, "other");
  answer(rt, true);
  await tick();
  frame(host);
  await tick();
  frame(host);
  assert.equal((peekShared(child(rt, "other"), "workouts") as unknown[]).length, 1);

  // An app reading its own collection is allowed without asking.
  const own = pub("workouts", "Workout log", [{ id: "w1", day: "2026-10-26", kind: "run", minutes: 10, calories: 100 }], {
    read: ["workouts"],
    screens: { main: { body: { type: "text", value: "{{len(shared.workouts)}}" } } },
  });
  const solo = bootShell([own], ["workouts"]);
  await tick();
  frame(solo.host);
  assert.equal(solo.rt.get("asking"), null);
  assert.equal((peekShared(child(solo.rt, "workouts"), "workouts") as unknown[]).length, 1);
});

test("validation: undeclared reads, writes under shared, bad from and fields, secret from", () => {
  const body = (node: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: node } }, ...extra }) as AppSpec;
  const goodPub = pub("p", "P");
  assert.deepEqual(validateSpec(goodPub).filter((e) => e.includes("publish")), []);
  assert.deepEqual(validateSpec(reader()).filter((e) => e.includes("shared") || e.includes("read")), []);

  assert.match(
    validateSpec(body({ type: "text", value: "{{len(shared.workouts)}}" })).join("\n"),
    /uses 'shared\.workouts'; add "workouts" to read/,
  );
  assert.match(
    validateSpec(body({ type: "button", label: "Go", onTap: { set: "shared.workouts", to: "[]" } }, { read: ["workouts"] })).join("\n"),
    /'shared' is read-only/,
  );
  assert.match(
    validateSpec(body({ type: "button", label: "Go", onTap: { push: "shared.workouts", value: {} } }, { read: ["workouts"] })).join("\n"),
    /'shared' is read-only/,
  );
  assert.match(
    validateSpec(body({ type: "button", label: "Go", onTap: { remove: "shared.workouts", where: "true" } }, { read: ["workouts"] })).join("\n"),
    /'shared' is read-only/,
  );
  assert.match(
    validateSpec(pub("p", "P", [], { publish: { workouts: { from: "missing", doc: "W" } } })).join("\n"),
    /publish\.workouts\.from: no data key 'missing'/,
  );
  assert.match(
    validateSpec(pub("p", "P", [], { data: { log: { type: "string" } }, publish: { workouts: { from: "log" } } }) as AppSpec).join("\n"),
    /must be a list data key/,
  );
  assert.match(
    validateSpec(pub("p", "P", [], { publish: { workouts: { from: "log", fields: ["nope"] } } })).join("\n"),
    /publish\.workouts\.fields: no field 'nope'/,
  );
  assert.match(
    validateSpec(pub("p", "P", [], { data: { log: { type: "list", secret: true, fields: { id: "string" } } }, publish: { workouts: { from: "log" } } }) as AppSpec).join("\n"),
    /is secret and can't be published/,
  );
  assert.match(validateSpec(body({ type: "text", value: "{{shared.Workouts}}" }, { read: ["Workouts"] })).join("\n"), /lowercase words/);
});

test("the model's context lists the device's collections", async () => {
  const apps = [pub("workouts", "Workout log"), reader()];
  const all = deviceCollections(apps.map((spec) => ({ id: spec.id, spec })));
  assert.deepEqual(all.map((c) => c.name), ["workouts"]);
  assert.equal(all[0].doc, "Workouts I logged");
  assert.deepEqual(all[0].fields, ["day", "kind", "minutes", "calories"]);
  assert.deepEqual(all[0].apps, [{ id: "workouts", name: "Workout log" }]);
  const text = formatCollections(apps.map((spec) => ({ id: spec.id, spec })));
  assert.match(text, /workouts/);
  assert.match(text, /Workouts I logged/);
  assert.match(text, /Workout log/);

  // The agent's context carries the same listing to the model.
  const inputs: unknown[][] = [];
  await runEdit(
    {
      settings: { apiKey: "k", model: "m", baseUrl: "https://x" },
      http: async (req, onLine) => {
        inputs.push(JSON.parse(String(req.body)).input as unknown[]);
        const response = { output: [{ type: "function_call", call_id: "c1", name: "finish", arguments: JSON.stringify({ message: "Done" }) }] };
        onLine?.(`data: ${JSON.stringify({ type: "response.completed", response })}`);
        return { status: 200, body: "" };
      },
      getSpec: () => reader(),
      commit: () => {},
      view: () => ({ screen: "main", screens: ["main"] }),
      collections: () => text,
      log: () => "l1",
    },
    { text: "plan meals from my workouts" },
  );
  assert.match(JSON.stringify(inputs[0]), /Shared collections on this device/);
  assert.match(JSON.stringify(inputs[0]), /workouts/);
  assert.match(systemPrompt(), /Shared data/);
});

test("removing a publisher removes its items", async () => {
  const { host, rt } = bootShell([pub("workouts", "Workout log", [{ id: "w1", day: "2026-10-26", kind: "run", minutes: 10, calories: 100 }]), reader()], ["workouts", "meals"]);
  await tick();
  answer(rt, true);
  await tick();
  frame(host);
  await tick();
  frame(host);
  assert.equal((peekShared(child(rt, "meals"), "workouts") as unknown[]).length, 1);
  rt.set("apps", (rt.get("apps") as { id: string }[]).filter((a) => a.id !== "workouts"));
  rt.setViewport(390, 844);
  frame(host);
  await tick();
  frame(host);
  assert.deepEqual(peekShared(child(rt, "meals"), "workouts"), []);
});

test("the demo specs publish, read and render", () => {
  for (const n of ["workouts", "meals"]) assert.deepEqual(validateSpec(load(n)), [], n);
  for (const n of ["workouts", "meals"]) {
    const { rt, host } = boot(load(n));
    frame(host);
    assert.deepEqual(rt.errors, [], n);
  }
});

test("a secret field is never published, even when listed, and a schedule time's shared reads need read", () => {
  const spec = {
    id: "w", name: "W",
    data: { log: { type: "list", fields: { id: "string", kind: "string", notes: { type: "string", secret: true } }, default: [{ id: "1", kind: "run", notes: "private" }] } },
    publish: { workouts: { from: "log", fields: ["kind", "notes"] } },
    screens: { main: { body: { type: "text", value: "x" } } },
  };
  assert.match(validateSpec(spec as never).join("\n"), /publish\.workouts\.fields: 'notes' is secret/);
  const items = projectPublisher(spec as never, { log: spec.data.log.default }, "workouts");
  assert.deepEqual(items.map((i) => Object.keys(i).sort()), [["app", "appName", "kind"]]);
  const sched = {
    id: "m", name: "M", capabilities: ["notifications"],
    schedule: { s: { at: "{{len(shared.workouts) > 0 ? '08:00' : '09:00'}}", title: "Hi", open: "main" } },
    screens: { main: { body: { type: "text", value: "x" } } },
  };
  assert.match(validateSpec(sched as never).join("\n"), /schedule\.s\.at: .*workouts/);
});
