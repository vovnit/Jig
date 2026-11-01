// Learning: interaction recording, sessions, `runLearn` against a scripted fake
// model, and undo. Written like the agent and vision tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import type { Interaction } from "../src/runtime.ts";
import { installBuilder } from "../src/builder/index.ts";
import { findApp } from "../src/builder/registry.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { formatEvents, learnGuard, runLearn, specSignature, summarizeData } from "../src/builder/learn.ts";
import { boot, byText, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

const tapper: AppSpec = {
  id: "t",
  name: "T",
  state: { name: "", count: 0 },
  screens: {
    main: {
      body: {
        type: "column",
        children: [
          { type: "button", label: "Add", onTap: { set: "count", to: "count + 1" } },
          { type: "textfield", placeholder: "Name", bind: "name" },
          { type: "button", label: "Go", onTap: { navigate: "second" } },
        ],
      },
    },
    second: { title: "Second", body: { type: "text", value: "here" } },
  },
} as unknown as AppSpec;

test("dispatch records taps, changes, navigation and errors with paths", () => {
  const { host, rt } = boot(tapper);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);

  rt.dispatch(byText(rt, "Add")!.id, "tap");
  const field = [...rt.nodes.values()].find((n) => n.type === "textfield")!;
  rt.dispatch(field.id, "change", { value: "Ada Lovelace writes a very long line of text here" });
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  rt.back();
  rt.recordError("x", "boom");
  frame(host);

  const kinds = seen.map((e) => e.kind);
  assert.deepEqual(kinds, ["tap", "change", "navigate", "tap", "back", "error"]);
  assert.equal(seen[0].path, "screens.main.body.children[0]");
  assert.equal(seen[0].type, "button");
  assert.equal(seen[0].label, "Add");
  assert.equal(seen[0].screen, "main");
  assert.equal(seen[1].label, "Name");
  assert.equal(seen[1].value, "Ada Lovelace writes a very long line of text here".slice(0, 40));
  assert.equal(seen[2].detail, "second");
  assert.equal(seen[2].path, "");
  assert.equal(seen[3].path, "screens.main.body.children[2]", "the Go tap records too");
  assert.equal(seen[4].kind, "back");
  assert.equal(seen[5].detail, "boom");
});

test("secure and secret fields record no value; numbers and booleans as they are", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    data: { pin: { type: "string", secret: true } },
    state: { code: "", on: false },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "textfield", secure: true, bind: "code" },
            { type: "textfield", bind: "pin" },
            { type: "toggle", bind: "on" },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);

  const fields = [...rt.nodes.values()].filter((n) => n.type === "textfield");
  rt.dispatch(fields[0].id, "change", { value: "s3cret" });
  rt.dispatch(fields[1].id, "change", { value: "1234" });
  const toggle = [...rt.nodes.values()].find((n) => n.type === "toggle")!;
  rt.dispatch(toggle.id, "change", { value: true });
  frame(host);

  assert.equal(seen.length, 3);
  assert.ok(!("value" in seen[0]), "secure fields record no value");
  assert.ok(!("label" in seen[0]), "secure fields record no label");
  assert.ok(!("value" in seen[1]), "secret-bound fields record no value");
  assert.ok(!("label" in seen[1]), "secret-bound fields record no label");
  assert.equal(seen[2].value, true);
});

test("an embedded runtime's events reach the shell with its app id", () => {
  const inner: AppSpec = {
    id: "inner",
    name: "Inner",
    state: {},
    screens: { main: { body: { type: "button", label: "Tap", onTap: { set: "x", to: "1" } } } },
  } as unknown as AppSpec;
  (inner.state as Record<string, unknown>).x = "";
  const outer: AppSpec = {
    id: "outer",
    name: "Outer",
    state: { app: inner },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  } as unknown as AppSpec;
  const { host, rt } = boot(outer);
  const seen: { app: string; e: Interaction }[] = [];
  rt.onInteraction = (app, e) => seen.push({ app, e });
  frame(host);
  const [child] = rt.children;
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Tap")!.id, "tap");
  frame(host);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].app, "inner");
  assert.equal(seen[0].e.kind, "tap");
});

/** A shell with home and run screens for session tests. */
function learnShell(key = "") {
  const appSpec: AppSpec = {
    id: "a",
    name: "A",
    state: { x: "" },
    screens: { main: { body: { type: "button", label: "Tap", onTap: { set: "x", to: "'1'" } } } },
  };
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { apps: [], apiKey: key, busy: false, learning: null, icons: false },
    screens: {
      home: { body: { type: "text", value: "home" } },
      run: { scroll: false, header: false, body: { type: "app", spec: "{{find(apps, a => a.id == params.id).spec}}" } },
    },
  } as unknown as AppSpec;
  const booted = boot(shellSpec, undefined, undefined, { trusted: true });
  installBuilder(booted.rt);
  booted.rt.set("apps", [{ id: "a", spec: appSpec, edited: false, learning: true }]);
  frame(booted.host);
  return { ...booted, appSpec };
}

async function runSession(rt: ReturnType<typeof boot>["rt"], host: ReturnType<typeof boot>["host"], taps = 1) {
  rt.nav.set([{ screen: "home", params: {} }, { screen: "run", params: { id: "a" } }]);
  frame(host);
  frame(host);
  const child = rt.children.find((c) => (c.spec as AppSpec)?.id === "a")!;
  for (let i = 0; i < taps; i++) {
    rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Tap")!.id, "tap");
  }
  await tick();
  frame(host);
  rt.back();
  frame(host);
  await tick();
}

test("only a learning app's full-screen run records, and the session appends capped at 400", async () => {
  const { host, rt } = learnShell();
  await runSession(rt, host, 2);
  assert.equal(findApp(rt, "a")!.learnEvents!.length, 2);
  assert.ok(findApp(rt, "a")!.learnEvents!.every((e) => e.kind === "tap"));

  // An app that isn't learning records nothing.
  rt.set("apps", [{ id: "a", spec: findApp(rt, "a")!.spec, edited: false, learning: false, learnEvents: [] }]);
  frame(host);
  await runSession(rt, host, 2);
  assert.deepEqual(findApp(rt, "a")!.learnEvents ?? [], []);

  // The cap keeps the newest 400.
  const old = Array.from({ length: 400 }, (_, i) => ({ t: i, kind: "tap", screen: "main", path: "", type: "button" }) as Interaction);
  rt.set("apps", [{ id: "a", spec: findApp(rt, "a")!.spec, edited: false, learning: true, learnEvents: old }]);
  frame(host);
  await runSession(rt, host, 2);
  const events = findApp(rt, "a")!.learnEvents!;
  assert.equal(events.length, 400);
  assert.equal(events.at(-1)!.label, "Tap", "the session's events are the newest");
});

test("events wait when there are too few of them, or the builder is busy", async () => {
  const few = learnShell("k");
  await runSession(few.rt, few.host, 2);
  assert.equal(few.rt.get("learning"), null, "fewer than 8 non-navigation events: no run");
  assert.equal(findApp(few.rt, "a")!.learnEvents!.length, 2, "the events wait for a later session");

  const busy = learnShell("k");
  busy.rt.set("busy", true);
  await runSession(busy.rt, busy.host, 9);
  assert.equal(busy.rt.get("learning"), null, "no run while the builder is busy");
  assert.equal(findApp(busy.rt, "a")!.learnEvents!.length, 9, "the events wait");
});

/** A scripted model: replies go back as one completed step each. */
function scriptedHttp(replies: { output: unknown[] }[], seen: unknown[] = []) {
  return async (req: { body?: unknown }, onLine?: (line: string) => void) => {
    seen.push(req);
    const reply = replies.shift()!;
    onLine?.(`data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}`);
    return { status: 200, body: "" };
  };
}

const toolCall = (name: string, args: unknown) => ({ output: [{ type: "function_call", call_id: `call_${name}`, name, arguments: JSON.stringify(args) }] });

const learnBase: AppSpec = {
  id: "a",
  name: "A",
  data: { log: { type: "list", fields: { id: "string", day: "string" } } },
  state: {},
  screens: { main: { title: "A", body: { type: "text", value: "hi" } } },
} as unknown as AppSpec;

const taps8: Interaction[] = Array.from({ length: 8 }, (_, i) => ({ t: (i + 1) * 1000, kind: "tap", screen: "main", path: "screens.main.body", type: "button", label: "Log" }) as Interaction);

test("runLearn: a patch, then finish, saves notes and clears the events", async () => {
  let current = JSON.parse(JSON.stringify(learnBase)) as AppSpec;
  const out = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp([
      toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "B" }] }),
      toolCall("finish", { notes: "Logs daily", change: "Retitled" }),
    ]) as never,
    commit: (s) => (current = s),
  });
  assert.deepEqual(out, { notes: "Logs daily", change: "Retitled", committed: true });
  assert.equal(current.screens.main.title, "B");
});

test("runLearn: finish with no change, and running out of steps", async () => {
  const noChange = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp([toolCall("finish", { notes: "n", change: "" })]) as never,
    commit: () => assert.fail("nothing to commit"),
  });
  assert.deepEqual(noChange, { notes: "n", change: "", committed: false });

  const outOfSteps = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp(Array.from({ length: 6 }, () => toolCall("nope", {}))) as never,
    commit: () => assert.fail("nothing to commit"),
  });
  assert.deepEqual(outOfSteps, { notes: "old", change: "", committed: false });
});

test("runLearn: the guard refuses capabilities and data changes", async () => {
  const seen: { input: { type: string }[] }[] = [];
  const out = await runLearn({
    spec: learnBase,
    notes: "",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp(
      [
        toolCall("apply_patch", { patch: [{ op: "add", path: "/capabilities", value: ["camera"] }] }),
        toolCall("apply_patch", { patch: [{ op: "remove", path: "/data/log" }] }),
        toolCall("finish", { notes: "n", change: "" }),
      ],
      seen,
    ) as never,
    commit: () => assert.fail("guarded patches never commit"),
  });
  assert.equal(out.committed, false);
  const text = JSON.stringify(seen);
  assert.match(text, /learning can't add capabilities/);
  assert.match(text, /learning can't remove data/);
});

test("a full session learns, and undo marks the lesson and notes it", async () => {
  const { host, rt } = learnShell("k");
  // Script the model's two steps through the shell's http.
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: "Taps daily", change: "Renamed the button" }),
  ];
  const base = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;

  await runSession(rt, host, 9);
  for (let i = 0; i < 100 && (rt.get("learning") as { status?: string } | null)?.status === "working"; i++) {
    frame(host);
    await tick();
  }
  frame(host);
  const changed = rt.get("learning") as { id: string; appName: string; status: string; text: string; at: number };
  assert.equal(changed.id, "a");
  assert.equal(changed.appName, "A");
  assert.equal(changed.status, "changed");
  assert.equal(changed.text, "Renamed the button");
  const entry = findApp(rt, "a")!;
  assert.equal(entry.lessons!.length, 1);
  assert.equal(entry.lessons![0].text, "Renamed the button");
  assert.equal(changed.at, entry.lessons![0].at);
  assert.equal(entry.learnNotes, "Taps daily");
  assert.deepEqual(entry.learnEvents ?? [], []);

  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: entry.lessons![0].at } }, { lookup: () => undefined, has: () => false });
  const undone = findApp(rt, "a")!;
  assert.equal(undone.lessons![0].undone, true);
  assert.match(undone.learnNotes ?? "", /The person undid: Renamed the button/);
  assert.equal(rt.get("learning"), null);
});

test("learnUndo refuses when the app changed since learning committed", () => {
  const { rt } = learnShell();
  rt.set("apps", [{
    id: "a",
    spec: findApp(rt, "a")!.spec,
    edited: false,
    learning: true,
    lessons: [{ at: 1, text: "Did X" }],
  }]);
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: 1 } }, { lookup: () => undefined, has: () => false });
  assert.deepEqual(rt.get("learning"), { id: "a", appName: "A", status: "error", text: "A has changed since; undo it in the builder." });
  assert.equal(findApp(rt, "a")!.lessons![0].undone, undefined);
});

test("forgetLearning clears notes, lessons and events without touching the spec", () => {
  const { rt } = learnShell();
  const before = JSON.stringify(findApp(rt, "a")!.spec);
  rt.set("apps", [{
    id: "a",
    spec: findApp(rt, "a")!.spec,
    edited: false,
    learning: true,
    learnNotes: "n",
    lessons: [{ at: 1, text: "Did X" }],
    learnEvents: [{ t: 1, kind: "tap", screen: "main", path: "", type: "button" }],
  }]);
  rt.run({ call: "builder.forgetLearning", args: { id: "'a'" } }, { lookup: () => undefined, has: () => false });
  const entry = findApp(rt, "a")!;
  assert.equal(entry.learnNotes, "");
  assert.deepEqual(entry.lessons ?? [], []);
  assert.deepEqual(entry.learnEvents ?? [], []);
  assert.equal(JSON.stringify(entry.spec), before);
});

test("events compact and the data summary never carries values", () => {
  const events: Interaction[] = [
    { t: 12000, kind: "tap", screen: "main", path: "screens.main.body.children[3]", type: "button", label: "Add" },
    { t: 12500, kind: "tap", screen: "main", path: "screens.main.body.children[3]", type: "button", label: "Add" },
    { t: 20000, kind: "navigate", screen: "main", path: "", type: "", detail: "settings" },
  ];
  assert.equal(formatEvents(events), `+12s main tap button "Add" [screens.main.body.children[3]] ×2\n+20s main navigate settings`);
  const summary = summarizeData(
    learnBase,
    { log: [{ id: "1", day: "2026-01-01", secret: "x" }], other: 1 },
  );
  assert.ok(summary.includes("log: list (1 items; fields: id, day)"));
  assert.ok(!summary.includes("2026") && !summary.includes("secret"), "never values");
  assert.ok(!learnGuard(learnBase, learnBase), "the same spec passes the guard");
});

test("the chat demo validates", () => {
  const spec = JSON.parse(readFileSync(new URL("../../specs/chat.json", import.meta.url), "utf8")) as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
});

test("a change label is never the typed value; secure fields keep neither", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    data: { pin: { type: "string", secret: true } },
    state: { name: "", code: "", pinValue: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "textfield", label: "Name", placeholder: "Your name", bind: "name" },
            { type: "textfield", secure: true, placeholder: "Code", bind: "code" },
            { type: "textfield", placeholder: "PIN", bind: "pinValue" },
            { type: "textfield", placeholder: "Secret", bind: "pin" },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);
  const fields = [...rt.nodes.values()].filter((n) => n.type === "textfield");
  rt.dispatch(fields[0].id, "change", { value: "typed-secret-value" });
  rt.dispatch(fields[1].id, "change", { value: "typed-secret-value" });
  rt.dispatch(fields[3].id, "change", { value: "typed-secret-value" });
  frame(host);
  assert.equal(seen[0].label, "Name");
  assert.equal(seen[0].value, "typed-secret-value".slice(0, 40));
  assert.ok(!("label" in seen[1]), "secure fields record no label");
  assert.ok(!("value" in seen[1]), "secure fields record no value");
  assert.ok(!JSON.stringify(seen[1]).includes("typed-secret-value"), "nor anything derived from it");
  assert.ok(!("label" in seen[2]), "secret-bound fields record no label");
  assert.ok(!("value" in seen[2]), "secret-bound fields record no value");
  assert.ok(!JSON.stringify(seen[2]).includes("typed-secret-value"), "nor anything derived from it");
});

test("runLearn commits once, so one Undo reverses the whole run", async () => {
  const commits: AppSpec[] = [];
  const out = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp([
      toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "B" }] }),
      toolCall("apply_patch", { patch: [{ op: "replace", path: "/name", value: "C" }] }),
      toolCall("finish", { notes: "n", change: "Did two things" }),
    ]) as never,
    commit: (s) => void commits.push(s),
  });
  assert.equal(out.committed, true);
  assert.equal(commits.length, 1, "patches apply to the working copy: one history entry");
  assert.equal((commits[0].screens.main as { title: string }).title, "B");
  assert.equal(commits[0].name, "C");
});

test("a run that starts before an edit commits nothing and keeps its events", async () => {
  let current = JSON.parse(JSON.stringify(learnBase)) as AppSpec;
  const out = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp([
      toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/title", value: "B" }] }),
      toolCall("finish", { notes: "n", change: "Renamed" }),
    ]) as never,
    commit: (s) => void (current = s),
    getSpec: () => ({ ...learnBase, name: "Edited meanwhile" }) as AppSpec,
  });
  assert.equal(out.conflict, true);
  assert.equal(out.committed, false);
  assert.equal(current.screens.main.title, "A", "commits nothing");
});

test("a conflicting session keeps its events with an unchanged status", async () => {
  const { host, rt } = learnShell("k");
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: "Taps daily", change: "Renamed the button" }),
  ];
  const base = host.call!.bind(host);
  let calls = 0;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    calls++;
    // The person edits while the run works: the spec it finishes from isn't the one it started from.
    if (calls === 2) {
      const entry = findApp(rt, "a")!;
      rt.set("apps", [{ ...entry, spec: { ...entry.spec, name: "Edited" } }]);
    }
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  await runSession(rt, host, 9);
  for (let i = 0; i < 100 && (rt.get("learning") as { status?: string } | null)?.status === "working"; i++) {
    frame(host);
    await tick();
  }
  frame(host);
  assert.deepEqual(rt.get("learning"), { id: "a", appName: "Edited", status: "unchanged", text: "Edited changed while learning; it will look again next time." });
  assert.equal(findApp(rt, "a")!.lessons?.length ?? 0, 0, "no lesson without a commit");
  assert.ok((findApp(rt, "a")!.learnEvents?.length ?? 0) >= 9, "keeps the events it took");
});

test("a finished run removes only the events it was given", async () => {
  const { host, rt } = learnShell("k");
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: "n", change: "Renamed" }),
  ];
  const base = host.call!.bind(host);
  let calls = 0;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    calls++;
    if (calls === 1) {
      // Another session ends while the run works: its events append meanwhile.
      const entry = findApp(rt, "a")!;
      const late = { t: 1, kind: "tap", screen: "main", path: "", type: "button", label: "Late" } as Interaction;
      rt.set("apps", [{ ...entry, learnEvents: [...(entry.learnEvents ?? []), late] }]);
    }
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  await runSession(rt, host, 9);
  for (let i = 0; i < 100 && (rt.get("learning") as { status?: string } | null)?.status === "working"; i++) {
    frame(host);
    await tick();
  }
  frame(host);
  const rest = findApp(rt, "a")!.learnEvents ?? [];
  assert.equal(rest.length, 1);
  assert.equal(rest[0].label, "Late");
});

test("learnUndo needs the newest lesson's at, and old notes give way to the undo line", async () => {
  const { rt } = learnShell();
  rt.set("apps", [{
    id: "a",
    spec: findApp(rt, "a")!.spec,
    edited: false,
    learning: true,
    learnNotes: "n",
    lessons: [{ at: 1, text: "First" }, { at: 2, text: "Second" }],
  }]);
  // The older lesson's at is refused, with the doc's changed-since text.
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: 1 } }, { lookup: () => undefined, has: () => false });
  assert.deepEqual(rt.get("learning"), { id: "a", appName: "A", status: "error", text: "A has changed since; undo it in the builder." });
  assert.equal(findApp(rt, "a")!.lessons![1].undone, undefined);
});

test("undo keeps its line when the notes are long", async () => {
  const { host, rt } = learnShell("k");
  const long = "y".repeat(1990);
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: long, change: "Renamed the button" }),
  ];
  const base = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  await runSession(rt, host, 9);
  for (let i = 0; i < 100 && (rt.get("learning") as { status?: string } | null)?.status === "working"; i++) {
    frame(host);
    await tick();
  }
  frame(host);
  const lesson = findApp(rt, "a")!.lessons![0];
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: lesson.at } }, { lookup: () => undefined, has: () => false });
  const after = findApp(rt, "a")!;
  assert.equal(after.lessons![0].undone, true);
  assert.ok((after.learnNotes?.length ?? 0) <= 2000);
  assert.ok(after.learnNotes?.endsWith(`The person undid: ${lesson.text}`), "the undo line is always kept");
});

test("submit uses the privacy-safe label: secrets never leak, values are never labels", () => {
  const secret = "typed-secret-value-xyz";
  const plain = "normal-typed-hello";
  const unlabelled = "unlabelled-typed-value";
  const spec: AppSpec = {
    id: "s",
    name: "S",
    data: { pin: { type: "string", secret: true } },
    state: { name: "", code: "", pinValue: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "textfield", placeholder: "Name", bind: "name", onSubmit: { set: "name", to: "name" } },
            { type: "textfield", secure: true, placeholder: "Code", bind: "code", onSubmit: { set: "code", to: "code" } },
            { type: "textfield", placeholder: "Secret", bind: "pin", onSubmit: { set: "pinValue", to: "pin" } },
            { type: "textfield", bind: "pinValue", onSubmit: { set: "name", to: "pinValue" } },
            { type: "text", value: "tap-target-value", onTap: { set: "name", to: "'x'" } },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);
  const fields = [...rt.nodes.values()].filter((n) => n.type === "textfield");
  rt.dispatch(fields[0].id, "change", { value: plain });
  rt.dispatch(fields[0].id, "submit");
  rt.dispatch(fields[1].id, "change", { value: secret });
  rt.dispatch(fields[1].id, "submit");
  rt.dispatch(fields[2].id, "change", { value: secret });
  rt.dispatch(fields[2].id, "submit");
  // No label or placeholder: the typed value must never become the label.
  rt.dispatch(fields[3].id, "change", { value: unlabelled });
  rt.dispatch(fields[3].id, "submit");
  const text = [...rt.nodes.values()].find((n) => n.type === "text")!;
  rt.dispatch(text.id, "tap");
  frame(host);

  const submits = seen.filter((e) => e.kind === "submit");
  assert.equal(submits.length, 4);
  assert.equal(submits[0].label, "Name");
  assert.ok(!("label" in submits[1]), "secure submit records no label");
  assert.ok(!("value" in submits[1]), "secure submit records no value");
  assert.ok(!("label" in submits[2]), "secret-bound submit records no label");
  assert.ok(!("value" in submits[2]), "secret-bound submit records no value");
  assert.equal(submits[3].label, undefined, "a typed value is never a label");
  const tap = seen.find((e) => e.kind === "tap")!;
  assert.equal(tap.label, undefined, "a node's text value is never a label");
  assert.ok(!JSON.stringify(seen).includes(secret), "nothing derived from a secret is recorded, for any kind");
});

test("interactions are attributed to the screen where they happened", () => {
  const spec: AppSpec = {
    id: "nav",
    name: "Nav",
    state: {},
    screens: {
      main: { body: { type: "button", label: "Go", onTap: { navigate: "second" } } },
      second: { body: { type: "text", value: "here" } },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push({ ...e });
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  frame(host);
  assert.equal(rt.nav.peek().at(-1)?.screen, "second");
  const tap = seen.find((e) => e.kind === "tap")!;
  const nav = seen.find((e) => e.kind === "navigate")!;
  assert.equal(tap.screen, "main", "the tap counts where it happened, not where it led");
  assert.equal(tap.path, "screens.main.body");
  assert.equal(nav.screen, "main");
  assert.equal(nav.detail, "second");
  rt.back();
  frame(host);
  const back = seen.find((e) => e.kind === "back")!;
  assert.equal(back.screen, "second", "back counts where it happened");
});

test("runLearn finish validates the working copy, including unfinished navigation", async () => {
  const seen: { input: { type: string }[] }[] = [];
  let committed: AppSpec | null = null;
  const out = await runLearn({
    spec: learnBase,
    notes: "",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp(
      [
        toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body", value: { type: "button", label: "Lost", onTap: { navigate: "missing" } } }] }),
        toolCall("finish", { notes: "n", change: "Added a lost button" }),
        toolCall("finish", { notes: "n", change: "" }),
      ],
      seen,
    ) as never,
    commit: (s) => void (committed = s),
  });
  assert.equal(committed, null, "a broken navigation never commits");
  assert.equal(out.committed, false);
  const text = JSON.stringify(seen);
  assert.match(text, /Not finished/, "the model gets the errors as the tool result");
  assert.match(text, /no screen named 'missing' yet/);
});

test("a run that ends out of steps with an invalid copy commits nothing", async () => {
  let committed = false;
  const out = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp(
      Array.from({ length: 6 }, () => toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body", value: { type: "button", label: "Lost", onTap: { navigate: "missing" } } }] })),
    ) as never,
    commit: () => void (committed = true),
  });
  assert.equal(committed, false);
  assert.deepEqual(out, { notes: "old", change: "", committed: false });
});

async function waitForLearn(rt: ReturnType<typeof boot>["rt"], host: ReturnType<typeof boot>["host"]) {
  for (let i = 0; i < 100 && (rt.get("learning") as { status?: string } | null)?.status === "working"; i++) {
    frame(host);
    await tick();
  }
  frame(host);
}

test("a run that finishes after forgetLearning commits nothing and clears the card", async () => {
  const { host, rt } = learnShell("k");
  const before = JSON.stringify(findApp(rt, "a")!.spec);
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: "New notes", change: "Renamed the button" }),
  ];
  const base = host.call!.bind(host);
  let calls = 0;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    calls++;
    if (calls === 1) {
      rt.run({ call: "builder.forgetLearning", args: { id: "'a'" } }, { lookup: () => undefined, has: () => false });
    }
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  await runSession(rt, host, 9);
  await waitForLearn(rt, host);
  const entry = findApp(rt, "a")!;
  assert.equal(JSON.stringify(entry.spec), before, "commits nothing");
  assert.equal(entry.lessons?.length ?? 0, 0, "no lesson after a forget");
  assert.equal(entry.learnNotes ?? "", "", "no notes after a forget");
  assert.deepEqual(entry.learnEvents ?? [], [], "its events are forgotten");
  assert.equal(rt.get("learning"), null, "the card is cleared");
});

test("a run that finishes after learning was turned off commits nothing", async () => {
  const { host, rt } = learnShell("k");
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("finish", { notes: "New notes", change: "Renamed the button" }),
  ];
  const base = host.call!.bind(host);
  let calls = 0;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    calls++;
    if (calls === 1) {
      rt.run({ call: "builder.setLearning", args: { id: "'a'", on: false } }, { lookup: () => undefined, has: () => false });
    }
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  const before = JSON.stringify(findApp(rt, "a")!.spec);
  await runSession(rt, host, 9);
  await waitForLearn(rt, host);
  const entry = findApp(rt, "a")!;
  assert.equal(JSON.stringify(entry.spec), before, "commits nothing");
  assert.equal(entry.lessons?.length ?? 0, 0, "saves no lessons");
  assert.notEqual(entry.learnNotes, "New notes", "saves no notes");
  assert.deepEqual(entry.learnEvents ?? [], [], "drops its events");
  assert.equal(rt.get("learning"), null, "clears the card");
});

test("undo of the newest lesson works in turn, by each lesson's own signature", () => {
  const { rt } = learnShell();
  const s0 = findApp(rt, "a")!.spec;
  const sA = { ...s0, name: "A1" };
  const sB = { ...sA, description: "B2" };
  rt.set("apps", [{
    id: "a",
    spec: sB,
    edited: true,
    learning: true,
    learnNotes: "n",
    history: [s0, sA],
    future: [],
    lessons: [
      { at: 1, text: "First", specHash: specSignature(sA) },
      { at: 2, text: "Second", specHash: specSignature(sB) },
    ],
  }]);
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: 2 } }, { lookup: () => undefined, has: () => false });
  assert.equal((findApp(rt, "a")!.spec as AppSpec).name, "A1");
  assert.equal(findApp(rt, "a")!.lessons![1].undone, true);
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: 1 } }, { lookup: () => undefined, has: () => false });
  assert.deepEqual(findApp(rt, "a")!.spec, s0, "undoing B, then A, works in turn");
  assert.equal(findApp(rt, "a")!.lessons![0].undone, true);
});

test("one undo restores the spec from before a multi-patch run", async () => {
  const { host, rt } = learnShell("k");
  const before = JSON.stringify(findApp(rt, "a")!.spec);
  const replies = [
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
    toolCall("apply_patch", { patch: [{ op: "replace", path: "/name", value: "Renamed" }] }),
    toolCall("finish", { notes: "n", change: "Did two things" }),
  ];
  const base = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    const reply = replies.shift()!;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  await runSession(rt, host, 9);
  await waitForLearn(rt, host);
  const lesson = findApp(rt, "a")!.lessons![0];
  assert.ok(lesson.specHash, "each lesson keeps its committed signature");
  assert.equal(lesson.specHash, specSignature(findApp(rt, "a")!.spec));
  rt.run({ call: "builder.learnUndo", args: { id: "'a'", at: lesson.at } }, { lookup: () => undefined, has: () => false });
  assert.equal(JSON.stringify(findApp(rt, "a")!.spec), before, "one undo reverses the whole run");
});

test("a spec with a multiline textfield validates, and chat stays single-line", () => {
  const spec = JSON.parse(readFileSync(new URL("../../specs/chat.json", import.meta.url), "utf8")) as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
  const settings = spec.screens.settings.body as { children: Record<string, unknown>[] };
  assert.ok(settings.children.every((c) => !("multiline" in c)), "the persona field stays single-line");
  const multi = JSON.parse(JSON.stringify(spec)) as AppSpec;
  ((multi.screens.settings.body as { children: Record<string, unknown>[] }).children[1] as Record<string, unknown>).multiline = true;
  assert.deepEqual(validateSpec(multi), [], "every renderer supports the multiline prop");
});

test("sensitive nodes record only kind, screen, path and type, for every kind", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    data: {
      pin: { type: "string", secret: true },
      items: { type: "list", fields: { id: "string", name: "string" }, default: [{ id: "a", name: "Row" }] },
    },
    state: { code: "", pinValue: "", tapped: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", secure: true, label: "SecretTap", onTap: { set: "tapped", to: "'x'" } },
            { type: "button", label: "BoundTap", bind: "pin", onTap: { set: "tapped", to: "'x'" } },
            { type: "textfield", secure: true, label: "Code", placeholder: "Code", bind: "code", onSubmit: { set: "tapped", to: "'x'" } },
            { type: "textfield", label: "Secret", placeholder: "Secret", bind: "pin", onSubmit: { set: "tapped", to: "'x'" } },
            { type: "text", value: "link-target-value", secure: true, onLink: { set: "tapped", to: "value" } },
            { type: "column", secure: true, onPage: { set: "tapped", to: "value" } },
            {
              type: "list",
              items: "items",
              swipe: [{ label: "Delete", do: { set: "tapped", to: "'x'" } }],
              reorder: true,
              row: { type: "text", value: "{{item.name}}", secure: true },
            },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);

  const buttons = [...rt.nodes.values()].filter((n) => n.type === "button");
  rt.dispatch(buttons[0].id, "tap");
  rt.dispatch(buttons[1].id, "tap");
  const fields = [...rt.nodes.values()].filter((n) => n.type === "textfield");
  rt.dispatch(fields[0].id, "change", { value: "typed-secret-value" });
  rt.dispatch(fields[0].id, "submit");
  rt.dispatch(fields[1].id, "change", { value: "typed-secret-value" });
  rt.dispatch(fields[1].id, "submit");
  const link = [...rt.nodes.values()].find((n) => n.type === "text" && n.props.value === "link-target-value")!;
  rt.dispatch(link.id, "link", { url: "https://example.com/secret" });
  const pager = [...rt.nodes.values()].find((n) => n.type === "column" && rt.handlers.get(n.id)?.onPage)!;
  rt.dispatch(pager.id, "page", { index: 2 });
  const row = [...rt.nodes.values()].find((n) => (n.props.swipeActions as unknown[] | undefined)?.length)!;
  row.props.secure = true;
  rt.dispatch(row.id, "swipe", { index: 0 });
  rt.dispatch(row.id, "move", { by: 1 });
  frame(host);

  assert.equal(seen.length, 10);
  for (const e of seen) {
    assert.deepEqual(Object.keys(e).sort(), ["kind", "path", "screen", "t", "type"], `${e.kind} keeps only kind, screen, path and type`);
  }
  assert.ok(!JSON.stringify(seen).includes("typed-secret-value"), "no typed secret is recorded");
  assert.ok(!JSON.stringify(seen).includes("SecretTap") && !JSON.stringify(seen).includes("BoundTap"));
  assert.ok(!JSON.stringify(seen).includes("example.com") && !JSON.stringify(seen).includes("Delete"));
});

test("a run started before a setLearning toggle never commits, off or on", async () => {
  const toggleDuringFirstCall = async (toggle: (rt: ReturnType<typeof boot>["rt"]) => void) => {
    const { host, rt } = learnShell("k");
    const before = JSON.stringify(findApp(rt, "a")!.spec);
    const replies = [
      toolCall("apply_patch", { patch: [{ op: "replace", path: "/screens/main/body/label", value: "Tap!" }] }),
      toolCall("finish", { notes: "New notes", change: "Renamed the button" }),
    ];
    const base = host.call!.bind(host);
    let calls = 0;
    host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
      if (service !== "http") return base(service, args, done, progress);
      calls++;
      if (calls === 1) toggle(rt);
      const reply = replies.shift()!;
      progress?.({ line: `data: ${JSON.stringify({ type: "response.completed", response: { output: reply.output } })}` });
      done({ status: 200, body: "" });
    }) as typeof host.call;
    await runSession(rt, host, 9);
    await waitForLearn(rt, host);
    return { host, rt, before };
  };

  // Off then back on: the app is learning again, but the generation moved.
  {
    const { rt, before } = await toggleDuringFirstCall((rt) => {
      rt.run({ call: "builder.setLearning", args: { id: "'a'", on: false } }, { lookup: () => undefined, has: () => false });
      rt.run({ call: "builder.setLearning", args: { id: "'a'", on: true } }, { lookup: () => undefined, has: () => false });
    });
    assert.equal(JSON.stringify(findApp(rt, "a")!.spec), before, "an off-then-on toggle commits nothing");
    assert.equal(findApp(rt, "a")!.lessons?.length ?? 0, 0);
    assert.equal(rt.get("learning"), null, "the card is cleared");
  }

  // On when already on still bumps the generation.
  {
    const { rt, before } = await toggleDuringFirstCall((rt) => {
      rt.run({ call: "builder.setLearning", args: { id: "'a'", on: true } }, { lookup: () => undefined, has: () => false });
    });
    assert.equal(JSON.stringify(findApp(rt, "a")!.spec), before, "an on toggle commits nothing");
    assert.equal(rt.get("learning"), null, "the card is cleared");
  }
});

test("a failing run after a forget or toggle clears its card instead of showing an error", async () => {
  const failAfter = async (cancel: (rt: ReturnType<typeof boot>["rt"]) => void) => {
    const { host, rt } = learnShell("k");
    const base = host.call!.bind(host);
    let calls = 0;
    host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
      if (service !== "http") return base(service, args, done, progress);
      calls++;
      if (calls === 1) cancel(rt);
      done(null, "boom");
    }) as typeof host.call;
    await runSession(rt, host, 9);
    await waitForLearn(rt, host);
    return { host, rt };
  };

  {
    const { rt } = await failAfter((rt) => {
      rt.run({ call: "builder.forgetLearning", args: { id: "'a'" } }, { lookup: () => undefined, has: () => false });
    });
    assert.equal(rt.get("learning"), null, "a forget clears the card on error too");
    assert.deepEqual(findApp(rt, "a")!.learnEvents ?? [], []);
  }

  {
    const { rt } = await failAfter((rt) => {
      rt.run({ call: "builder.setLearning", args: { id: "'a'", on: false } }, { lookup: () => undefined, has: () => false });
    });
    assert.equal(rt.get("learning"), null, "turning learning off clears the card on error too");
    assert.deepEqual(findApp(rt, "a")!.learnEvents ?? [], [], "its events are dropped, just as on success");
  }
});

test("sensitivity is judged before the handler runs: turning secure off doesn't leak the value", () => {
  const spec = {
    id: "m",
    name: "M",
    state: { code: "", masked: true },
    screens: { main: { body: { type: "textfield", secure: "{{masked}}", bind: "code", onChange: { set: "masked", to: "false" } } } },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  const seen: Interaction[] = [];
  rt.onInteraction = (_app, e) => seen.push(e);
  frame(host);
  const field = [...rt.nodes.values()].find((n) => n.type === "textfield")!;
  rt.dispatch(field.id, "change", { value: "s3cret" });
  frame(host);
  assert.equal(rt.get("masked"), false);
  assert.equal(seen.length, 1);
  assert.ok(!("value" in seen[0]) && !("label" in seen[0]), JSON.stringify(seen[0]));
});

test("a no-change finish after an edit is a conflict too, so the events wait", async () => {
  const out = await runLearn({
    spec: learnBase,
    notes: "old",
    lessons: [],
    events: taps8,
    dataSummary: "",
    settings: { apiKey: "k", model: "m", baseUrl: "u" },
    http: scriptedHttp([toolCall("finish", { notes: "n", change: "" })]) as never,
    commit: () => assert.fail("commits nothing"),
    getSpec: () => ({ ...learnBase, name: "Edited meanwhile" }) as AppSpec,
  });
  assert.equal(out.conflict, true);
  assert.equal(out.committed, false);
});
