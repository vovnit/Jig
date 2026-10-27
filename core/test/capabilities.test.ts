// Phase A capabilities: the clock live value, async actions with permissions, the shell's gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Action, AppSpec } from "../src/spec.ts";
import { CAPABILITIES, registerAsyncAction, unregisterAsyncAction } from "../src/spec.ts";
import { installBuilder } from "../src/builder/index.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { BUILTINS } from "../src/expr.ts";
import { Runtime } from "../src/runtime.ts";
import { boot, byText, frame, makeHost, runTimers } from "./fake-host.ts";

const realNow = Date.now;
let nowMs = 1_700_000_000_000;

/** The clock reads Date.now; the fake host's `after` fires off it, so tests move it by hand. */
function mockTime(t: { after: (fn: () => void) => void }): void {
  t.after(() => {
    Date.now = realNow;
  });
  Date.now = () => nowMs;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A test-only async action: the table itself stays empty, as the phase requires. */
function echoAction(t: { after: (fn: () => void) => void }, capability = "clock"): void {
  registerAsyncAction("test.echo", { capability, doc: "echoes text back", args: { text: "text" }, result: "the text" });
  t.after(() => unregisterAsyncAction("test.echo"));
}

const echoTap = (text: string, then: Action, els?: Action): Action =>
  ({ "test.echo": { text }, then, ...(els ? { else: els } : {}) });

test("clock updates bound text once a second with the fake host's after", (t) => {
  mockTime(t);
  nowMs = 1_700_000_000_000;
  const spec: AppSpec = {
    id: "clock",
    name: "Clock",
    capabilities: ["clock"],
    screens: { main: { body: { type: "text", value: "Time {{clock}}" } } },
  };
  const { host, rt } = boot(spec);
  frame(host);
  assert.ok(byText(rt, `Time ${nowMs}`));
  assert.equal(host.timers.length, 1, "one tick scheduled at the next whole second");

  nowMs += 1200;
  runTimers(host);
  const ops = frame(host);
  assert.ok(byText(rt, `Time ${nowMs}`), "the binding re-ran on the tick");
  assert.ok(ops.some((o) => o[0] === "update" && (o[2] as { value?: string }).value === `Time ${nowMs}`));
  assert.equal(host.timers.length, 1, "the next tick is scheduled");

  rt.dispose();
  const shown = `Time ${nowMs}`;
  nowMs += 2000;
  runTimers(host);
  const after = frame(host);
  assert.equal(host.timers.length, 0, "no tick rescheduled after dispose");
  assert.ok(byText(rt, shown), "the text is frozen");
  assert.ok(!after.some((o) => o[0] === "update"));
});

test("only bindings that read clock re-run on a tick", (t) => {
  mockTime(t);
  nowMs = 1_700_000_000_000;
  const spec: AppSpec = {
    id: "clock",
    name: "Clock",
    capabilities: ["clock"],
    screens: {
      main: {
        body: {
          type: "column",
          children: [{ type: "text", value: "Static" }, { type: "text", value: "Tick {{clock}}" }],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  frame(host);
  const staticNode = byText(rt, "Static")!;
  const tickNode = byText(rt, `Tick ${nowMs}`)!;

  nowMs += 1500;
  runTimers(host);
  const ops = frame(host);
  const updates = ops.filter((o) => o[0] === "update");
  assert.equal(updates.length, 1, "the static text doesn't re-run");
  assert.equal(updates[0][1], tickNode.id);
  assert.ok(!ops.some((o) => o[0] === "update" && o[1] === staticNode.id));
});

test("validation: reading clock without declaring it names the fix", (t) => {
  echoAction(t);
  const body = (node: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: node } }, ...extra }) as AppSpec;
  const fix = /uses 'clock'; add "clock" to capabilities/;

  assert.match(validateSpec(body({ type: "text", value: "{{clock}}" })).join("\n"), fix);
  assert.match(validateSpec(body({ type: "text", value: "shown", if: "clock > 0" })).join("\n"), fix);
  assert.match(validateSpec(body({ type: "text", value: "{{formatDate(now(), 'HH:mm')}}" })).join("\n"), fix, "now() reads the clock too");
  assert.match(
    validateSpec(body({ type: "button", label: "Go", onTap: { set: "x", to: "clock" } }, { state: { x: 0 } })).join("\n"),
    fix,
    "action values count as use",
  );
  assert.match(
    validateSpec(body({ type: "button", label: "Go", onTap: echoTap("'hi'", { set: "x", to: "value" }) }, { state: { x: "" } })).join("\n"),
    /onTap: uses 'clock'; add "clock" to capabilities/,
    "an async action needs its capability",
  );

  // Declared, everything passes, including the async shape and an unknown arg failing.
  const declared = body(
    {
      type: "column",
      children: [
        { type: "text", value: "{{clock}}" },
        { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "x", to: "value" }) },
      ],
    },
    { capabilities: ["clock"], state: { x: "" } },
  );
  assert.deepEqual(validateSpec(declared), []);
  const badArg = body({ type: "button", label: "Go", onTap: echoTap("'hi'", { set: "x", to: "value" }) }, { capabilities: ["clock"] });
  (badArg.screens.main.body as unknown as { onTap: { "test.echo": Record<string, unknown> } }).onTap["test.echo"] = { bogus: 1 };
  assert.match(validateSpec(badArg).join("\n"), /has no 'bogus'/);

  // An app's own `clock` key shadows the live value.
  assert.deepEqual(validateSpec(body({ type: "text", value: "{{clock}}" }, { state: { clock: 0 } })), []);
});

test("an async action runs then with value, else with error on a host error", async (t) => {
  echoAction(t);
  const spec: AppSpec = {
    id: "a",
    name: "A",
    capabilities: ["clock"],
    state: { done: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }, { set: "err", to: "error" }) },
            { type: "button", label: "Bad", onTap: echoTap("'boom'", { set: "done", to: "value" }, { set: "err", to: "error" }) },
          ],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  const calls: string[] = [];
  host.call = (service, args, done) => {
    calls.push(service);
    if ((args as { text: string }).text === "boom") done(null, "boom");
    else done({ echo: (args as { text: string }).text });
  };
  frame(host);

  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(rt.get("done"), { echo: "hi" });

  rt.dispatch(byText(rt, "Bad")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("err"), "boom");
  assert.deepEqual(calls, ["test.echo", "test.echo"]);
  assert.deepEqual(rt.errors, []);
});

test("a denied capability runs else with Not allowed; an undeclared one errors", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  echoAction(t, "test.loc");
  const body = (extra: Partial<AppSpec> = {}): AppSpec =>
    ({
      id: "a",
      name: "A",
      state: { done: "", err: "" },
      screens: {
        main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }, { set: "err", to: "error" }) } },
      },
      ...extra,
    }) as AppSpec;

  const denied = boot(body({ capabilities: ["test.loc"] }), undefined, undefined, { gate: () => false });
  denied.host.call = () => assert.fail("a denied action never reaches the host");
  frame(denied.host);
  denied.rt.dispatch(byText(denied.rt, "Go")!.id, "tap");
  await tick();
  frame(denied.host);
  assert.equal(denied.rt.get("err"), "Not allowed");
  assert.deepEqual(denied.rt.errors, []);

  const undeclared = boot(body());
  undeclared.host.call = () => assert.fail("an undeclared action never reaches the host");
  frame(undeclared.host);
  undeclared.rt.dispatch(byText(undeclared.rt, "Go")!.id, "tap");
  await tick();
  frame(undeclared.host);
  assert.match(String(undeclared.rt.get("err")), /add "test.loc" to capabilities/);
  assert.ok(undeclared.rt.errors.some((e) => /uses 'test.loc'/.test(e.message)));
});

test("an embedded app calls its async action through the parent, and can't reach other services", async (t) => {
  echoAction(t);
  const inner: AppSpec = {
    id: "inner",
    name: "Inner",
    capabilities: ["clock"],
    state: { done: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }) } } },
  };
  const outer: AppSpec = {
    id: "outer",
    name: "Outer",
    state: { app: inner },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  };
  const { host, rt } = boot(outer);
  const seen: string[] = [];
  host.call = (service, args, done) => {
    seen.push(service);
    done({ ok: (args as { text: string }).text });
  };
  frame(host);
  const [child] = rt.children;
  assert.ok(child, "a child runtime");
  assert.equal(child.gate, rt.gate, "the child inherits the gate");

  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(child.get("done"), { ok: "hi" });
  assert.deepEqual(seen, ["test.echo"]);

  // The shell's builder services and http stay shell-only.
  for (const service of ["http", "builder.edit"]) {
    const error = await new Promise<string | undefined>((resolve) => child.host.call!(service, {}, (_r, e) => resolve(e)));
    assert.equal(error, "Not allowed", service);
  }
  assert.deepEqual(seen, ["test.echo"]);
});

test("the shell's gate asks once, stores the grant, then allows", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  registerAsyncAction("test.ask", { capability: "test.loc", doc: "asks for a position", args: {}, result: "the position" });
  t.after(() => unregisterAsyncAction("test.ask"));
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    capabilities: ["test.loc"],
    data: { grants: { type: "object", default: {} } },
    state: { asking: null, done: "" },
    screens: {
      main: {
        body: {
          type: "button",
          label: "Use",
          onTap: { "test.ask": {}, then: { set: "done", to: "value" } },
        },
      },
    },
  };
  const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
  installBuilder(rt);
  host.call = (service, _args, done) => {
    assert.equal(service, "test.ask");
    done({ at: "here" });
  };
  frame(host);
  const scope = { lookup: () => undefined, has: () => false };

  rt.dispatch(byText(rt, "Use")!.id, "tap");
  await tick();
  assert.deepEqual(rt.get("asking"), {
    app: "shell",
    appName: "Shell",
    capability: "test.loc",
    text: "Shell wants to a test position.",
  });

  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  await tick();
  frame(host);
  assert.equal(rt.get("asking"), null);
  assert.deepEqual(rt.get("grants"), { shell: { "test.loc": true } });
  assert.deepEqual(rt.get("done"), { at: "here" });

  // The next use doesn't ask.
  rt.set("done", "");
  rt.dispatch(byText(rt, "Use")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("asking"), null);
  assert.deepEqual(rt.get("done"), { at: "here" });
});

test("two permissioned actions share one question; different ones queue", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  CAPABILITIES["test.cam"] = { doc: "the test camera", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
    delete CAPABILITIES["test.cam"];
  });
  registerAsyncAction("test.askLoc", { capability: "test.loc", doc: "asks loc", args: {}, result: "loc" });
  registerAsyncAction("test.askCam", { capability: "test.cam", doc: "asks cam", args: {}, result: "cam" });
  t.after(() => {
    unregisterAsyncAction("test.askLoc");
    unregisterAsyncAction("test.askCam");
  });
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    capabilities: ["test.loc", "test.cam"],
    data: { grants: { type: "object", default: {} } },
    state: { asking: null, a: "", b: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "A", onTap: { "test.askLoc": {}, then: { set: "a", to: "value" } } },
            { type: "button", label: "B", onTap: { "test.askLoc": {}, then: { set: "b", to: "value" } } },
            { type: "button", label: "C", onTap: { "test.askCam": {}, then: { set: "b", to: "value" } } },
          ],
        },
      },
    },
  };
  const scope = { lookup: () => undefined, has: () => false };

  // Same app and capability: one question answers both.
  {
    const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
    installBuilder(rt);
    host.call = (_s, _a, done) => done({ at: "here" });
    frame(host);
    rt.dispatch(byText(rt, "A")!.id, "tap");
    rt.dispatch(byText(rt, "B")!.id, "tap");
    await tick();
    assert.deepEqual((rt.get("asking") as { capability: string }).capability, "test.loc");
    rt.run({ call: "builder.answer", args: { allow: true } }, scope);
    await tick();
    frame(host);
    assert.equal(rt.get("asking"), null);
    assert.deepEqual(rt.get("a"), { at: "here" });
    assert.deepEqual(rt.get("b"), { at: "here" }, "the second waiter shared the answer");
  }

  // Different capabilities: the second waits until the first is answered.
  {
    const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
    installBuilder(rt);
    host.call = (_s, _a, done) => done({ at: "here" });
    frame(host);
    rt.dispatch(byText(rt, "A")!.id, "tap");
    rt.dispatch(byText(rt, "C")!.id, "tap");
    await tick();
    assert.deepEqual((rt.get("asking") as { capability: string }).capability, "test.loc", "the first question stays up");
    rt.run({ call: "builder.answer", args: { allow: true } }, scope);
    await tick();
    frame(host);
    assert.deepEqual(rt.get("a"), { at: "here" });
    assert.equal(rt.get("b"), "", "the queued one hasn't run yet");
    assert.deepEqual((rt.get("asking") as { capability: string }).capability, "test.cam", "the next question appears");
    rt.run({ call: "builder.answer", args: { allow: true } }, scope);
    await tick();
    frame(host);
    assert.equal(rt.get("asking"), null);
    assert.deepEqual(rt.get("b"), { at: "here" });
  }
});

test("a forgotten grant asks again", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  registerAsyncAction("test.ask", { capability: "test.loc", doc: "asks for a position", args: {}, result: "the position" });
  t.after(() => unregisterAsyncAction("test.ask"));
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    capabilities: ["test.loc"],
    data: { grants: { type: "object", default: {} } },
    state: { asking: null, done: "" },
    screens: { main: { body: { type: "button", label: "Use", onTap: { "test.ask": {}, then: { set: "done", to: "value" } } } } },
  };
  const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
  installBuilder(rt);
  host.call = (_s, _a, done) => done({ at: "here" });
  frame(host);
  const scope = { lookup: () => undefined, has: () => false };
  rt.dispatch(byText(rt, "Use")!.id, "tap");
  await tick();
  assert.ok(rt.get("asking"), "asks the first time");
  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  await tick();
  frame(host);
  assert.deepEqual(rt.get("done"), { at: "here" });

  rt.run({ call: "builder.forgetGrant", args: { app: "'shell'", capability: "'test.loc'" } }, scope);
  assert.deepEqual(rt.get("grants"), {});
  rt.set("done", "");
  rt.dispatch(byText(rt, "Use")!.id, "tap");
  await tick();
  assert.ok(rt.get("asking"), "asks again after the grant was forgotten");
  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  await tick();
  frame(host);
  assert.deepEqual(rt.get("done"), { at: "here" });
});

test("an asks:false capability never calls the gate", async (t) => {
  echoAction(t);
  const spec: AppSpec = {
    id: "a",
    name: "A",
    capabilities: ["clock"],
    state: { done: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }) } } },
  };
  let gates = 0;
  const { host, rt } = boot(spec, undefined, undefined, {
    gate: () => {
      gates++;
      return true;
    },
  });
  host.call = (_s, args, done) => done({ echo: (args as { text: string }).text });
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(rt.get("done"), { echo: "hi" });
  assert.equal(gates, 0, "clock asks nothing, so the gate stays out");
});

test("the clock source starts only when first read, and restarts after a fresh load", (t) => {
  mockTime(t);
  nowMs = 1_700_000_000_000;
  const plain: AppSpec = { id: "s", name: "S", screens: { main: { body: { type: "text", value: "Static" } } } };
  const withClock: AppSpec = {
    id: "s",
    name: "S",
    capabilities: ["clock"],
    screens: { main: { body: { type: "text", value: "Time {{clock}}" } } },
  };
  const still = boot(plain);
  frame(still.host);
  assert.equal(still.host.timers.length, 0, "nothing ticks without a live read");

  const { host, rt } = boot(withClock);
  frame(host);
  assert.equal(host.timers.length, 1, "the first read starts the source");
  nowMs += 1200;
  runTimers(host);
  frame(host);
  assert.ok(byText(rt, `Time ${nowMs}`));

  rt.load(withClock, { fresh: true });
  frame(host);
  assert.ok(host.timers.length >= 1, "a fresh load restarts the source");
  nowMs += 1200;
  runTimers(host);
  frame(host);
  assert.ok(byText(rt, `Time ${nowMs}`), "it ticks again");
});

test("the clock ticks through requestFrame when the host has no after", (t) => {
  mockTime(t);
  nowMs = 1_700_000_000_000;
  const spec: AppSpec = {
    id: "clock",
    name: "Clock",
    capabilities: ["clock"],
    screens: { main: { body: { type: "text", value: "Time {{clock}}" } } },
  };
  const host = makeHost();
  delete (host as { after?: unknown }).after;
  const rt = new Runtime(host);
  rt.setViewport(390, 844);
  rt.load(spec);
  // A poll reschedules itself, so drain only the current batch at a time.
  const step = () => host.pending.splice(0).forEach((cb) => cb());
  step();
  assert.ok(byText(rt, `Time ${nowMs}`));
  assert.equal(host.timers.length, 0, "no timers without after");
  nowMs += 2100;
  step();
  step();
  assert.ok(byText(rt, `Time ${nowMs}`), "the poll saw the new second");
});

test("only bindings that read clock re-run, counting evaluations", (t) => {
  mockTime(t);
  nowMs = 1_700_000_000_000;
  let staticCalls = 0;
  let tickCalls = 0;
  BUILTINS["testStaticCount"] = () => {
    staticCalls++;
    return "static";
  };
  BUILTINS["testTickCount"] = (c: unknown) => {
    tickCalls++;
    return `tick ${String(c)}`;
  };
  t.after(() => {
    delete BUILTINS["testStaticCount"];
    delete BUILTINS["testTickCount"];
  });
  const spec: AppSpec = {
    id: "clock",
    name: "Clock",
    capabilities: ["clock"],
    screens: {
      main: {
        body: {
          type: "column",
          children: [{ type: "text", value: "{{testStaticCount()}}" }, { type: "text", value: "{{testTickCount(clock)}}" }],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  frame(host);
  assert.equal(staticCalls, 1);
  assert.equal(tickCalls, 1);
  nowMs += 1500;
  runTimers(host);
  frame(host);
  assert.ok(byText(rt, "static"));
  assert.ok(byText(rt, `tick ${nowMs}`));
  assert.equal(staticCalls, 1, "the static binding didn't re-evaluate");
  assert.equal(tickCalls, 2, "the clock binding did");
});

test("validation: component props, loop shadowing and now() in actions", (t) => {
  echoAction(t);
  const body = (node: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: node } }, ...extra }) as AppSpec;
  const fix = /uses 'clock'; add "clock" to capabilities/;
  const components = { ClockText: { type: "text", value: "{{props.time}}" } };

  assert.match(validateSpec(body({ type: "ClockText", props: { time: "{{clock}}" } }, { components })).join("\n"), fix, "a component's props dict counts");
  assert.match(validateSpec(body({ type: "ClockText", time: "{{clock}}" }, { components })).join("\n"), fix, "a usage's direct prop counts");
  assert.deepEqual(validateSpec(body({ type: "ClockText", props: { time: "{{clock}}" } }, { components, capabilities: ["clock"] })), []);

  // A loop variable shadowing a live value isn't one.
  assert.deepEqual(validateSpec(body({ type: "text", each: "range(2)", as: "clock", value: "{{clock}}" })), []);
  assert.deepEqual(validateSpec(body({ type: "text", each: "range(2)", indexAs: "clock", value: "{{clock}}" })), []);
  assert.deepEqual(validateSpec(body({ type: "list", items: "range(2)", as: "clock", row: { type: "text", value: "{{clock}}" } })), []);
  assert.match(validateSpec(body({ type: "text", each: "range(2)", as: "item", value: "{{clock}}" })).join("\n"), fix, "other names don't shadow");

  // `now()` as a timestamp needs no capability; in a binding it does.
  assert.deepEqual(
    validateSpec(
      body(
        { type: "button", label: "Go", onTap: { push: "items", value: { at: "now()" } } },
        { state: { items: [] as unknown[] } },
      ),
    ),
    [],
  );
  assert.match(validateSpec(body({ type: "text", value: "{{now()}}" })).join("\n"), fix);
});

test("validation: screen titles need capabilities too", () => {
  const screen = (title: string, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { title, body: { type: "text", value: "hi" } } }, ...extra }) as AppSpec;
  const fix = /uses 'clock'; add "clock" to capabilities/;

  assert.match(validateSpec(screen("{{clock}}")).join("\n"), fix);
  assert.deepEqual(validateSpec(screen("{{clock}}", { capabilities: ["clock"] })), []);
  assert.deepEqual(validateSpec(screen("Clock")), []);
});

test("validation: a component template uses its usage's loop scope", () => {
  const body = (node: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: node } }, ...extra }) as AppSpec;
  const fix = /uses 'clock'; add "clock" to capabilities/;
  const components = { C: { type: "text", value: "{{clock}}" } };

  assert.deepEqual(validateSpec(body({ type: "C", each: "range(2)", as: "clock" }, { components })), []);
  assert.deepEqual(validateSpec(body({ type: "C", each: "range(2)", indexAs: "clock" }, { components })), []);
  assert.match(validateSpec(body({ type: "C" }, { components })).join("\n"), fix, "without the loop name it needs the capability");
  assert.match(
    validateSpec(body({ type: "text", value: "hi" }, { components })).join("\n"),
    fix,
    "an unused template is still checked on its own",
  );
});

test("the gate is skipped when the generation changes before it runs", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  echoAction(t, "test.loc");
  const gated: AppSpec = {
    id: "a",
    name: "A",
    capabilities: ["test.loc"],
    state: { done: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }) } } },
  };
  const other: AppSpec = { ...gated, id: "b", name: "B" };

  // Another app loads before the gate microtask runs: the gate never runs.
  {
    let gates = 0;
    let hosts = 0;
    const { host, rt } = boot(gated, undefined, undefined, {
      gate: () => {
        gates++;
        return true;
      },
    });
    host.call = (_s, _a, done) => {
      hosts++;
      done({ echo: "hi" });
    };
    frame(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    rt.load(other);
    frame(host);
    await tick();
    frame(host);
    assert.equal(gates, 0, "the gate didn't run for the replaced app");
    assert.equal(hosts, 0);
    assert.deepEqual(rt.errors, []);
  }

  // Disposing before the gate microtask runs skips it too.
  {
    let gates = 0;
    const { host, rt } = boot(gated, undefined, undefined, {
      gate: () => {
        gates++;
        return true;
      },
    });
    host.call = () => assert.fail("a disposed action never reaches the host");
    frame(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    rt.dispose();
    await tick();
    frame(host);
    assert.equal(gates, 0, "the gate didn't run after dispose");
  }
});

test("a pending permission question after dispose is dropped", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  echoAction(t, "test.loc");
  const gated: AppSpec = {
    id: "a",
    name: "A",
    capabilities: ["test.loc"],
    state: { done: "", err: "" },
    screens: {
      main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }, { set: "err", to: "error" }) } },
    },
  };
  let release: unknown = null;
  let hosts = 0;
  const { host, rt } = boot(gated, undefined, undefined, {
    gate: () => new Promise<boolean>((resolve) => (release = resolve)),
  });
  host.call = (_s, _a, done) => {
    hosts++;
    done({ echo: "hi" });
  };
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  assert.equal(typeof release, "function", "permission is pending");
  rt.dispose();
  (release as (allow: boolean) => void)(true);
  await tick();
  frame(host);
  assert.equal(hosts, 0, "the grant after dispose never reached the host");
  assert.equal(rt.get("done"), "");
  assert.equal(rt.get("err"), "");
});

test("permission requests from two different apps are asked one after another", async (t) => {
  CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
  t.after(() => {
    delete CAPABILITIES["test.loc"];
  });
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    capabilities: ["test.loc"],
    data: { grants: { type: "object", default: {} } },
    state: { asking: null },
    screens: { main: { body: { type: "text", value: "shell" } } },
  };
  const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
  installBuilder(rt);
  frame(host);
  const scope = { lookup: () => undefined, has: () => false };

  const appA = { id: "a", name: "A" } as AppSpec;
  const appB = { id: "b", name: "B" } as AppSpec;
  const pA = Promise.resolve(rt.gate!(appA, "test.loc"));
  const pB = Promise.resolve(rt.gate!(appB, "test.loc"));
  let bDone = false;
  void pB.then(() => (bDone = true));
  assert.deepEqual((rt.get("asking") as { app: string }).app, "a", "the first app's question is on screen");
  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  assert.equal(await pA, true);
  await tick();
  assert.equal(bDone, false, "the second app waits its turn");
  assert.deepEqual((rt.get("asking") as { app: string }).app, "b", "the second app's question is next");
  rt.run({ call: "builder.answer", args: { allow: false } }, scope);
  assert.equal(await pB, false);
  assert.equal(rt.get("asking"), null);
});

test("async answers after a reload or dispose are dropped", async (t) => {
  echoAction(t);
  const spec: AppSpec = {
    id: "a",
    name: "A",
    capabilities: ["clock"],
    state: { done: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }) } } },
  };

  // The host answers after a reload: dropped.
  {
    const { host, rt } = boot(spec);
    let answer: unknown = null;
    host.call = (_s, _a, done) => {
      answer = done;
    };
    frame(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    await tick();
    assert.equal(typeof answer, "function", "the host was called");
    rt.load(spec);
    frame(host);
    (answer as (result: unknown, error?: string) => void)({ echo: "hi" });
    await tick();
    frame(host);
    assert.equal(rt.get("done"), "", "the stale answer didn't run");
    assert.deepEqual(rt.errors, []);
  }

  // The host answers after a dispose: dropped.
  {
    const { host, rt } = boot(spec);
    let answer: unknown = null;
    host.call = (_s, _a, done) => {
      answer = done;
    };
    frame(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    await tick();
    rt.dispose();
    (answer as (result: unknown, error?: string) => void)({ echo: "hi" });
    await tick();
    frame(host);
    assert.equal(rt.get("done"), "", "the answer after dispose didn't run");
  }

  // The permission answer arrives after a reload: dropped.
  {
    CAPABILITIES["test.loc"] = { doc: "a test position", asks: true };
    t.after(() => {
      delete CAPABILITIES["test.loc"];
    });
    echoAction(t, "test.loc");
    const gated: AppSpec = {
      id: "a",
      name: "A",
      capabilities: ["test.loc"],
      state: { done: "", err: "" },
      screens: {
        main: { body: { type: "button", label: "Go", onTap: echoTap("'hi'", { set: "done", to: "value" }, { set: "err", to: "error" }) } },
      },
    };
    let release: unknown = null;
    const { host, rt } = boot(gated, undefined, undefined, {
      gate: () => new Promise<boolean>((resolve) => (release = resolve)),
    });
    host.call = (_s, _a, done) => done({ echo: "hi" });
    frame(host);
    rt.dispatch(byText(rt, "Go")!.id, "tap");
    await tick();
    assert.equal(typeof release, "function", "permission is pending");
    rt.load(gated);
    frame(host);
    (release as (allow: boolean) => void)(true);
    await tick();
    frame(host);
    assert.equal(rt.get("done"), "", "the stale grant didn't run");
    assert.equal(rt.get("err"), "");
  }
});
