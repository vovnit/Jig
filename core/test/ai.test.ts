// `ask`: the shell's container service behind the `ai` capability. Against a fake
// `http`: the request shape, streaming `into`, schema answers, and every failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installAi, strictSchema } from "../src/ai.ts";
import { installBuilder } from "../src/builder/index.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import type { AppSpec } from "../src/spec.ts";
import { boot, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function shellFor(inner: AppSpec, key = "secret-key-123"): ReturnType<typeof boot> {
  const outer: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { app: inner, apiKey: key, baseUrl: "https://api.meta.ai/v1" },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  } as unknown as AppSpec;
  const booted = boot(outer, undefined, undefined, { trusted: true });
  installAi(booted.rt);
  return booted;
}

interface Captured {
  url: string;
  key: string;
  body: Record<string, unknown>;
}

/** Fake `http`: captures the request, streams `deltas` as SSE lines, then answers. */
function fakeHttp(host: ReturnType<typeof boot>["host"], cap: Captured[], opts: { deltas?: string[]; status?: number; body?: string } = {}) {
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return orig(service, args, done, progress);
    cap.push({ url: String(args.url), key: String((args.headers as Record<string, string>).Authorization), body: JSON.parse(String(args.body)) });
    for (const d of opts.deltas ?? ["Hello"]) {
      // A reasoning event rides along: it must not reach the app.
      progress?.({ line: `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "hmm" })}` });
      progress?.({ line: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: d })}` });
    }
    done({ status: opts.status ?? 200, body: opts.body ?? "" });
  }) as typeof host.call;
}

const asker = (extra: Record<string, unknown> = {}) => ({
  type: "button",
  label: "Go",
  onTap: { ask: { prompt: "input", ...extra }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } },
});

function innerApp(over: Record<string, unknown> = {}): AppSpec {
  return {
    id: "asker",
    name: "Asker",
    capabilities: ["ai"],
    state: { input: "hi", done: null, err: "", ...over },
    screens: { main: { body: asker() } },
  } as unknown as AppSpec;
}

async function tapGo(rt: ReturnType<typeof boot>["rt"], host: ReturnType<typeof boot>["host"]) {
  frame(host);
  const [child] = rt.children;
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  await tick();
  frame(host);
  return child;
}

test("the request carries instructions, history roles, images, schema and limits", async () => {
  const inner = innerApp({ photo: null, schema: null });
  (inner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", system: "'tutor'", history: "[{role: 'user', text: 'hola'}, {role: 'model', text: 'hola!'}, {role: 'x', text: 'skip'}, {n: 1}]", images: "photo", schema: "schema", effort: "'high'", maxTokens: "20000" },
    then: { set: "done", to: "value" },
  };
  const { host, rt } = shellFor(inner);
  const cap: Captured[] = [];
  fakeHttp(host, cap, { deltas: ["ok"] });
  frame(host);
  const [child] = rt.children;
  host.files.set("asker", new Map([["f1", { id: "f1", name: "p.jpg", type: "image/png", size: 3, data: Buffer.from("img") }]]));
  child.set("photo", { id: "f1", name: "p.jpg", type: "image/png", size: 3 });
  child.set("schema", { type: "object" });
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  await tick();
  frame(host);
  assert.equal(cap.length, 1);
  const body = cap[0].body as { model: string; instructions: string; input: { role: string; content: unknown }[]; reasoning: { effort: string }; max_output_tokens: number; text: { format: Record<string, unknown> } };
  assert.equal(cap[0].url, "https://api.meta.ai/v1/responses");
  assert.equal(cap[0].key, "Bearer secret-key-123");
  assert.equal(body.model, "muse-spark-1.3");
  assert.equal(body.instructions, "tutor\nAnswer only with JSON that matches the schema.");
  assert.deepEqual(body.input.slice(0, 2), [{ role: "user", content: "hola" }, { role: "assistant", content: "hola!" }]);
  const last = body.input.at(-1)!;
  const parts = last.content as { type: string; text?: string; image_url?: string }[];
  assert.equal(last.role, "user");
  assert.deepEqual(parts[0], { type: "input_text", text: "hi" });
  assert.ok(parts[1].image_url?.startsWith("data:image/png;base64,"), "images go as data URLs with the handle's MIME type");
  assert.deepEqual(body.text.format, { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true });
  assert.equal(body.reasoning.effort, "high");
  assert.equal(body.max_output_tokens, 16000, "maxTokens clamps to 16000");
  const read = host.calls.find((c) => c.service === "files.read");
  assert.deepEqual(read?.args, { app: "asker", id: "f1", as: "base64" });
});

test("the answer streams into the app's state, and reasoning never does", async () => {
  const inner = innerApp({ draft: "" });
  (inner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", into: "'draft'" },
    then: { set: "done", to: "value" },
    else: { set: "err", to: "error" },
  };
  const { host, rt } = shellFor(inner);
  const cap: Captured[] = [];
  fakeHttp(host, cap, { deltas: ["Hel", "lo"] });
  const child = await tapGo(rt, host);
  assert.equal(child.get("draft"), "Hello");
  assert.equal(child.get("done"), "Hello");
  assert.equal(child.get("err"), "");
});

test("a host that can't stream answers with the whole body", async () => {
  const inner = innerApp({ draft: "" });
  (inner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", into: "'draft'" },
    then: { set: "done", to: "value" },
  };
  const { host, rt } = shellFor(inner);
  const cap: Captured[] = [];
  const lines = ["Hel", "lo"].map((d) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: d })}`).join("\n");
  fakeHttp(host, cap, { deltas: [], body: lines });
  const child = await tapGo(rt, host);
  assert.equal(child.get("done"), "Hello");
  assert.equal(child.get("draft"), "Hello");
});

test("schema answers parse, fences strip, and bad JSON goes to else", async () => {
  const withSchema = (deltas: string[]) => {
    const inner = innerApp({ schema: null });
    (inner.screens.main.body as Record<string, unknown>).onTap = {
      ask: { prompt: "input", schema: "schema" },
      then: { set: "done", to: "value" },
      else: { set: "err", to: "error" },
    };
    return { inner, deltas };
  };
  for (const [deltas, want] of [[['{"a":1}'], { a: 1 }], [['```json\n{"a":1}\n```'], { a: 1 }]] as [string[], unknown][]) {
    const { inner } = withSchema(deltas);
    const { host, rt } = shellFor(inner);
    const cap: Captured[] = [];
    fakeHttp(host, cap, { deltas });
    frame(host);
    const [child] = rt.children;
    child.set("schema", { type: "object" });
    rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
    await tick();
    await tick();
    await tick();
    frame(host);
    assert.deepEqual(child.get("done"), want);
    assert.equal(child.get("err"), "");
  }
  const badSchema = withSchema(["nope"]);
  const badBoot = shellFor(badSchema.inner);
  fakeHttp(badBoot.host, [], { deltas: ["nope"] });
  frame(badBoot.host);
  const [badChild] = badBoot.rt.children;
  badChild.set("schema", { type: "object" });
  badBoot.rt.dispatch([...badChild.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  await tick();
  frame(badBoot.host);
  assert.equal(badChild.get("err"), "The model's answer wasn't valid JSON");
});

test("without a key the call fails before it starts", async () => {
  const { host, rt } = shellFor(innerApp(), "");
  host.call = (() => assert.fail("no host service without a key")) as typeof host.call;
  const child = await tapGo(rt, host);
  assert.equal(child.get("err"), "Add a Meta Model API key in Settings to use AI in apps.");
});

test("a refused key and other HTTP errors report their status", async () => {
  const refused = shellFor(innerApp());
  fakeHttp(refused.host, [], { status: 401, body: "nope" });
  assert.equal((await tapGo(refused.rt, refused.host)).get("err"), "The API key was refused");

  const withMessage = shellFor(innerApp());
  fakeHttp(withMessage.host, [], { status: 500, body: JSON.stringify({ error: { message: "boom" } }) });
  assert.equal((await tapGo(withMessage.rt, withMessage.host)).get("err"), "The model answered 500: boom");

  const bare = shellFor(innerApp());
  fakeHttp(bare.host, [], { status: 500, body: "bad gateway" });
  assert.equal((await tapGo(bare.rt, bare.host)).get("err"), "The model answered 500");
});

test("empty prompts, bad into, too many images and too long requests fail", async () => {
  const empty = shellFor(innerApp({ input: "" }));
  const cap: Captured[] = [];
  fakeHttp(empty.host, cap);
  assert.equal((await tapGo(empty.rt, empty.host)).get("err"), "The prompt must not be empty");
  assert.equal(cap.length, 0);

  const intoInner = innerApp();
  (intoInner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", into: "'nope'" },
    then: { set: "done", to: "value" },
    else: { set: "err", to: "error" },
  };
  const bad = shellFor(intoInner);
  fakeHttp(bad.host, []);
  assert.equal((await tapGo(bad.rt, bad.host)).get("err"), "`into` must be one of the app's state keys");

  // An inherited name is not a state key either.
  (intoInner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", into: "'toString'" },
    then: { set: "done", to: "value" },
    else: { set: "err", to: "error" },
  };
  const inherited = shellFor(intoInner);
  fakeHttp(inherited.host, []);
  assert.equal((await tapGo(inherited.rt, inherited.host)).get("err"), "`into` must be one of the app's state keys");

  // Five images through the action's `images` list.
  const five = shellFor({
    ...innerApp(),
    state: { input: "hi", done: null, err: "", imgs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] },
    screens: { main: { body: { type: "button", label: "Go", onTap: { ask: { prompt: "input", images: "imgs" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } } } },
  } as unknown as AppSpec);
  fakeHttp(five.host, []);
  assert.equal((await tapGo(five.rt, five.host)).get("err"), "Too many images (at most 4)");

  const long = shellFor(innerApp({ input: "x".repeat(100001) }));
  fakeHttp(long.host, []);
  assert.equal((await tapGo(long.rt, long.host)).get("err"), "The request is too long");
});

test("at most 20 calls per app per minute", async () => {
  const { host, rt } = shellFor(innerApp());
  const cap: Captured[] = [];
  fakeHttp(host, cap, { deltas: ["ok"] });
  const ask = rt.containerServices.get("ask")!;
  for (let i = 0; i < 20; i++) await ask({ prompt: "hi" }, { app: "rl", runtime: rt });
  await assert.rejects(async () => {
    await ask({ prompt: "hi" }, { app: "rl", runtime: rt });
  }, /Too many AI requests; wait a moment/);
  // Another app still has its own budget.
  await ask({ prompt: "hi" }, { app: "other", runtime: rt });
  assert.equal(cap.length, 21);
});

test("the key never shows up in the app's state or errors", async () => {
  const { host, rt } = shellFor(innerApp(), "secret-key-123");
  const cap: Captured[] = [];
  fakeHttp(host, cap, { deltas: ["answer"] });
  const child = await tapGo(rt, host);
  assert.ok(!JSON.stringify(child.snapshot()).includes("secret-key-123"));
  assert.ok(!String(child.get("done")).includes("secret-key-123"));

  const bad = shellFor(innerApp(), "secret-key-123");
  fakeHttp(bad.host, [], { status: 500, body: "down" });
  const errChild = await tapGo(bad.rt, bad.host);
  assert.ok(!String(errChild.get("err")).includes("secret-key-123"));
});

test("the gate asks once per app", async () => {
  const shellSpec: AppSpec = {
    id: "shell",
    name: "Shell",
    capabilities: ["ai"],
    data: { grants: { type: "object", default: {} }, apiKey: { type: "string", default: "k" } },
    state: { asking: null, done: "", err: "" },
    screens: {
      main: {
        body: { type: "button", label: "Use", onTap: { ask: { prompt: "'hi'" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } },
      },
    },
  };
  const { host, rt } = boot(shellSpec, undefined, undefined, { trusted: true });
  installBuilder(rt);
  const cap: Captured[] = [];
  fakeHttp(host, cap, { deltas: ["hi there"] });
  frame(host);
  const scope = { lookup: () => undefined, has: () => false };

  rt.dispatch([...rt.nodes.values()].find((n) => n.props.label === "Use")!.id, "tap");
  await tick();
  assert.deepEqual(rt.get("asking"), { app: "shell", appName: "Shell", capability: "ai", text: "Shell wants to ask Meta's model, using your API key." });
  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  await tick();
  await tick();
  frame(host);
  assert.equal(rt.get("asking"), null);
  assert.equal(rt.get("done"), "hi there");

  // The next use doesn't ask.
  rt.set("done", "");
  rt.dispatch([...rt.nodes.values()].find((n) => n.props.label === "Use")!.id, "tap");
  await tick();
  await tick();
  frame(host);
  assert.equal(rt.get("asking"), null);
  assert.equal(rt.get("done"), "hi there");
});

test("the chat demo validates", () => {
  const spec = JSON.parse(readFileSync(new URL("../../specs/chat.json", import.meta.url), "utf8")) as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
  assert.deepEqual(spec.capabilities?.slice().sort(), ["ai", "photos"]);
});

test("the prompt documents ask and the chat pattern", () => {
  const prompt = systemPrompt();
  assert.ok(prompt.includes("ask"), "the action");
  assert.ok(prompt.includes("slice(messages, -20)"), "the chat pattern");
  assert.ok(prompt.includes("Prefer ask"), "the provider guidance");
});

test("strictSchema makes every object with properties strict, recursively", () => {
  const out = strictSchema({
    type: "object",
    properties: {
      color: { type: "string" },
      shade: { type: "object", properties: { name: { type: "string" }, hex: { type: "string" } } },
      tags: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
      pick: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] },
      either: { oneOf: [{ type: "object", properties: { b: { type: "number" } } }] },
    },
  }) as Record<string, unknown>;
  assert.equal(out.additionalProperties, false);
  assert.deepEqual(out.required, ["color", "shade", "tags", "pick", "either"]);
  const props = out.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.shade.additionalProperties, false);
  assert.deepEqual(props.shade.required, ["name", "hex"]);
  assert.equal((props.tags.items as Record<string, unknown>).additionalProperties, false);
  assert.deepEqual((props.tags.items as Record<string, unknown>).required, ["label"]);
  assert.equal(((props.pick.anyOf as unknown[])?.[0] as Record<string, unknown>).additionalProperties, false);
  assert.equal(((props.either.oneOf as unknown[])?.[0] as Record<string, unknown>).additionalProperties, false);
  // No properties, no strictness added.
  assert.deepEqual(strictSchema({ type: "string" }), { type: "string" });
});

test("a schema 400 retries once without text, with the schema in the instructions", async () => {
  const inner = innerApp({ schema: null });
  (inner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", schema: "schema" },
    then: { set: "done", to: "value" },
    else: { set: "err", to: "error" },
  };
  const { host, rt } = shellFor(inner);
  const cap: Captured[] = [];
  const orig = host.call!.bind(host);
  let calls = 0;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return orig(service, args, done, progress);
    calls++;
    cap.push({ url: String(args.url), key: String((args.headers as Record<string, string>).Authorization), body: JSON.parse(String(args.body)) });
    if (calls === 1) {
      done({ status: 400, body: JSON.stringify({ error: { message: "'additionalProperties' is required to be supplied and to be false.", param: "text.format.schema" } }) });
      return;
    }
    progress?.({ line: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"color":"red"}' })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  frame(host);
  const [child] = rt.children;
  child.set("schema", { type: "object", properties: { color: { type: "string" } } });
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  await tick();
  frame(host);
  assert.equal(calls, 2);
  const first = cap[0].body as { text: { format: Record<string, unknown> } };
  assert.equal((first.text.format as Record<string, unknown>).strict, true);
  assert.equal((first.text.format as Record<string, unknown>).additionalProperties, undefined);
  const second = cap[1].body as { text?: unknown; instructions: string };
  assert.equal(second.text, undefined);
  assert.ok(second.instructions.includes("Answer only with JSON that matches this JSON Schema, no other text:"));
  assert.ok(second.instructions.includes('"color"'));
  assert.deepEqual(child.get("done"), { color: "red" });
});

test("failed, error and incomplete streams fail with the API's message; empty answers fail", async () => {
  const failing = async (lines: string[]) => {
    const { host, rt } = shellFor(innerApp());
    const orig = host.call!.bind(host);
    host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
      if (service !== "http") return orig(service, args, done, progress);
      for (const line of lines) progress?.({ line });
      done({ status: 200, body: "" });
    }) as typeof host.call;
    return tapGo(rt, host);
  };
  assert.equal(
    (await failing([`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "overloaded" } } })}`])).get("err"),
    "overloaded",
  );
  assert.equal(
    (await failing([`data: ${JSON.stringify({ type: "error", message: "bad gateway" })}`])).get("err"),
    "bad gateway",
  );
  assert.equal(
    (await failing([`data: ${JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })}`])).get("err"),
    "The model stopped: max_output_tokens",
  );
  assert.equal((await failing([])).get("err"), "The model gave no answer");
});

test("every ask error redacts the key, including forwarded host failures", async () => {
  const key = "secret-key-123";
  const { host, rt } = shellFor(innerApp(), key);
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void) => {
    if (service !== "http") return orig(service, args, done);
    done(null, `oops ${key} leaked`);
  }) as typeof host.call;
  const child = await tapGo(rt, host);
  assert.ok(!String(child.get("err")).includes(key));
  assert.ok(String(child.get("err")).includes("…"));

  const streamed = shellFor(innerApp(), key);
  const base = streamed.host.call!.bind(streamed.host);
  streamed.host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return base(service, args, done, progress);
    progress?.({ line: `data: ${JSON.stringify({ type: "response.failed", response: { error: { message: `bad ${key}` } } })}` });
    done({ status: 200, body: "" });
  }) as typeof streamed.host.call;
  const child2 = await tapGo(streamed.rt, streamed.host);
  assert.ok(!String(child2.get("err")).includes(key));
  assert.ok(String(child2.get("err")).includes("…"));
});

test("short keys are redacted too", async () => {
  const key = "k";
  const { host, rt } = shellFor(innerApp(), key);
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void) => {
    if (service !== "http") return orig(service, args, done);
    done(null, `oops ${key} leaked`);
  }) as typeof host.call;
  const child = await tapGo(rt, host);
  assert.ok(!String(child.get("err")).includes("oops k leaked"));
  assert.ok(String(child.get("err")).includes("…"));
});

test("a finished ask ignores late progress, so an old request never overwrites into", async () => {
  const inner = innerApp({ draft: "" });
  (inner.screens.main.body as Record<string, unknown>).onTap = {
    ask: { prompt: "input", into: "'draft'" },
    then: { set: "done", to: "value" },
    else: { set: "err", to: "error" },
  };
  const { host, rt } = shellFor(inner);
  let late: ((update: Record<string, unknown>) => void) | undefined;
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service !== "http") return orig(service, args, done, progress);
    late = progress;
    progress?.({ line: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}` });
    done({ status: 200, body: "" });
  }) as typeof host.call;
  const child = await tapGo(rt, host);
  assert.equal(child.get("draft"), "Hello");
  assert.equal(child.get("done"), "Hello");
  late?.({ line: `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Late" })}` });
  await tick();
  frame(host);
  assert.equal(child.get("draft"), "Hello", "progress after the call settled is ignored");
  assert.equal(child.get("done"), "Hello");
});

test("the 120 s limit covers reading the photos too", async () => {
  const { host, rt } = shellFor({
    ...innerApp(),
    state: { input: "hi", done: null, err: "", photo: { id: "p" } },
    screens: { main: { body: { type: "button", label: "Go", onTap: { ask: { prompt: "input", images: "photo" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } } } },
  } as unknown as AppSpec);
  const orig = host.call!.bind(host);
  let posted = false;
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void) => {
    if (service === "files.read") return; // never answers
    if (service === "http") posted = true;
    return orig(service, args, done, progress);
  }) as typeof host.call;
  const pending = tapGo(rt, host);
  await tick();
  for (const t of host.timers.splice(0)) t.cb();
  const child = await pending;
  assert.equal(child.get("err"), "The model took too long");
  assert.equal(posted, false);
});
