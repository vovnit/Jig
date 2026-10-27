// Builder tools for custom code: set_script (code as a ```js block), add_library
// (pinned downloads) and test_script (the host sandbox), with library sources
// hidden from the model and kept across its edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { sha256Hex } from "../src/sha256.ts";
import { runEdit, type AgentDeps } from "../src/builder/agent.ts";
import { installBuilder } from "../src/builder/index.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { boot, byText, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(host: { pending: (() => void)[] }, rounds = 5): Promise<void> {
  const h = host as unknown as Parameters<typeof frame>[0];
  for (let i = 0; i < rounds; i++) {
    frame(h);
    await tick();
  }
  frame(h);
}

interface Reply {
  thought?: string;
  output: unknown[];
}

const toolCall = (name: string, args: unknown, thought?: string): Reply => ({
  thought,
  output: [{ type: "function_call", call_id: `call_${name}_${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) }],
});

const saidWith = (text: string, calls: { name: string; args: unknown }[]): Reply => ({
  output: [
    { type: "message", content: [{ type: "output_text", text }] },
    ...calls.map((c, i) => ({ type: "function_call", call_id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
  ],
});

const finish = (message: string): Reply => toolCall("finish", { message });

/** Runs the agent against scripted model replies, a download mock and a vm sandbox. */
function setup(spec: AppSpec, replies: Reply[], downloads: Record<string, { status?: number; body: string; headers?: Record<string, string> }> = {}) {
  let current = JSON.parse(JSON.stringify(spec)) as AppSpec;
  const commits: AppSpec[] = [];
  const requests: unknown[] = [];
  let n = 0;
  const runVm = async (code: string, name: string, input: unknown): Promise<unknown> => {
    const vm = await import("node:vm");
    const exports: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = { exports, console: { log: () => {} } };
    vm.createContext(sandbox);
    new vm.Script(`${code}\n;exports;`).runInContext(sandbox);
    const fn = (sandbox.exports as Record<string, unknown>)[name];
    if (typeof fn !== "function") throw new Error(`No '${name}'`);
    return (fn as (input: unknown) => unknown)(input);
  };
  const deps: AgentDeps = {
    settings: { apiKey: "k", model: "m", baseUrl: "https://api.meta.ai/v1" },
    http: async (req, onLine) => {
      if (String(req.url).endsWith("/responses")) {
        requests.push(JSON.parse(String(req.body)));
        const reply = replies.shift() as Reply;
        if (!req.stream) return { status: 200, body: JSON.stringify(reply) };
        const response = { id: `resp_${++n}`, output: reply.output };
        if (onLine) onLine(`data: ${JSON.stringify({ type: "response.completed", response })}`);
        return { status: 200, body: "" };
      }
      const hit = downloads[String(req.url)];
      if (!hit) return { status: 404, body: "no" };
      return { status: hit.status ?? 200, body: hit.body, headers: hit.headers };
    },
    getSpec: () => current,
    commit: (next) => {
      commits.push(next);
      current = next;
    },
    view: () => ({ screen: "main", screens: ["main"], selected: null }),
    log: () => "l1",
    scripts: {
      run: async (args) => ({ value: await runVm(String(args.code), String(args.fn), args.args) }),
      render: async (args) => ({ tree: await runVm(String(args.code), String(args.element), args.props) }),
    },
  };
  const idle = async () => {
    for (let i = 0; i < 100; i++) {
      await tick();
      if (replies.length === 0) break;
    }
    await tick();
    await tick();
  };
  return { deps, commits, get: () => current, idle, requests };
}

async function edit(setupHarness: ReturnType<typeof setup>, text: string): Promise<unknown[]> {
  const { deps } = setupHarness;
  const outcome = await runEdit(deps, { text });
  return outcome.conversation;
}

const base: AppSpec = {
  id: "a",
  name: "A",
  state: { x: "" },
  screens: { main: { body: { type: "text", value: "Hi" } } },
};

test("set_script takes the code from the last js block and commits", async () => {
  const h = setup(base, [
    saidWith("Adding conversion.\n\n```js\nexports.csvToJson = (args) => args.text;\n```\n\n```js\nexports.csvToJson = (args) => args.text.toUpperCase();\n```", [
      { name: "set_script", args: { name: "convert", exports: ["csvToJson"], elements: [], doc: "CSV" } },
    ]),
    finish("Added."),
  ]);
  const conversation = await edit(h, "add conversion");
  assert.equal(h.get().scripts!.convert.code, "exports.csvToJson = (args) => args.text.toUpperCase();");
  assert.deepEqual(h.get().scripts!.convert.exports, ["csvToJson"]);
  assert.equal(h.commits.length, 1);
  const out = conversation.filter((i) => (i as { type?: string }).type === "function_call_output").map((i) => String((i as { output?: unknown }).output));
  assert.match(out[0], /Applied/);
});

test("set_script without a js block says where the code goes", async () => {
  const h = setup(base, [toolCall("set_script", { name: "convert", exports: ["f"], elements: [] }), finish("Done.")]);
  const conversation = await edit(h, "add code");
  const out = conversation.filter((i) => (i as { type?: string }).type === "function_call_output").map((i) => String((i as { output?: unknown }).output));
  assert.match(out[0], /```js block/);
  assert.equal(h.commits.length, 0);
});

test("add_library pins the download with its hash", async () => {
  const withScript: AppSpec = { ...base, scripts: { convert: { code: "exports.f = () => 1;", exports: ["f"], elements: [] } } };
  const body = "exports.yaml = 1;";
  const h = setup(withScript, [toolCall("add_library", { script: "convert", name: "yaml", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js" }), finish("Added.")], {
    "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js": { body, headers: { "content-type": "application/javascript" } },
  });
  await edit(h, "add yaml");
  const libs = h.get().scripts!.convert.libraries!;
  assert.equal(libs.length, 1);
  assert.equal(libs[0].name, "yaml");
  assert.equal(libs[0].sha256, sha256Hex(body));
  assert.equal(libs[0].code, body);
});

test("add_library refuses bad URLs, big files and non-JS types", async () => {
  const withScript: AppSpec = { ...base, scripts: { convert: { code: "exports.f = () => 1;", exports: ["f"], elements: [] } } };
  const big = `https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/big.min.js`;
  const h = setup(withScript, [
    toolCall("add_library", { script: "convert", name: "x", url: "http://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js" }),
    toolCall("add_library", { script: "convert", name: "x", url: "https://cdn.jsdelivr.net/npm/js-yaml/dist/js-yaml.min.js" }),
    toolCall("add_library", { script: "convert", name: "x", url: big }),
    toolCall("add_library", { script: "convert", name: "x", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js" }),
    finish("Done."),
  ], {
    [big]: { body: "x".repeat(512 * 1024 + 1) },
    "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js": { body: "<html>", headers: { "content-type": "text/html" } },
  });
  const conversation = await edit(h, "add libs");
  const out = conversation.filter((i) => (i as { type?: string }).type === "function_call_output").map((i) => String((i as { output?: unknown }).output));
  assert.match(out[0], /must be https/);
  assert.match(out[1], /exact-version/);
  assert.match(out[2], /larger than 512 KB/);
  assert.match(out[3], /isn't JavaScript/);
  assert.equal(h.commits.length, 0);
});

test("test_script returns the value, the tree with validity, or the error", async () => {
  const withScript: AppSpec = {
    ...base,
    scripts: {
      convert: {
        code: "exports.up = (args) => args.text.toUpperCase();\nexports.bad = () => { throw new Error('nope'); };\nexports.bars = (props) => ({type: 'text', value: 'n' + props.values.length});",
        exports: ["up", "bad"],
        elements: ["bars"],
      },
    },
  };
  const h = setup(withScript, [
    toolCall("test_script", { script: "convert", fn: "up", args: { text: "hi" } }),
    toolCall("test_script", { script: "convert", fn: "bad", args: {} }),
    toolCall("test_script", { script: "convert", element: "bars", props: { values: [1, 2] } }),
    finish("Checked."),
  ]);
  const conversation = await edit(h, "check the code");
  const out = conversation.filter((i) => (i as { type?: string }).type === "function_call_output").map((i) => String((i as { output?: unknown }).output));
  assert.match(out[0], /value: "HI"/);
  assert.match(out[1], /error: nope/);
  assert.match(out[2], /"value":"n2"/);
  assert.match(out[2], /validates: yes/);
});

test("a set_spec that drops library code keeps the stored source", async () => {  const stored: AppSpec = {
    ...base,
    scripts: {
      convert: {
        code: "exports.f = () => 1;",
        exports: ["f"],
        elements: [],
        libraries: [{ name: "yaml", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js", sha256: sha256Hex("real"), code: "real" }],
      },
    },
  };
  // As the model writes it: libraries as {name, url, size}, no source.
  const written = JSON.parse(JSON.stringify(stored)) as AppSpec;
  (written.scripts!.convert.libraries as unknown[]) = [{ name: "yaml", url: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js", size: 4 }];
  const h = setup(stored, [
    saidWith(`Updating.\n\n\`\`\`json\n${JSON.stringify(written)}\n\`\`\``, [{ name: "set_spec", args: {} }]),
    finish("Updated."),
  ]);
  await edit(h, "update it");
  const libs = h.get().scripts!.convert.libraries!;
  assert.equal(libs[0].code, "real", "the stored source survives the model's edit");
});

test("the converter demo validates and converts a sample in the sandbox", async () => {  const spec = JSON.parse(readFileSync(new URL("../../specs/converter.json", import.meta.url), "utf8")) as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
  // The real pinned libraries ride along, and the code uses their globals.
  const libs = spec.scripts!.convert.libraries as { name: string; code?: string }[];
  assert.equal(libs.length, 2);
  assert.ok(libs.every((l) => typeof l.code === "string" && l.code.length > 1000), "both libraries are vendored");
  assert.match(String(spec.scripts!.convert.code), /Papa\.parse/);
  assert.match(String(spec.scripts!.convert.code), /Papa\.unparse/);
  assert.match(String(spec.scripts!.convert.code), /jsyaml\.load/);
  assert.match(String(spec.scripts!.convert.code), /jsyaml\.dump/);
  const { host, rt } = boot(spec);
  await settle(host);

  // CSV → JSON through Papa in the fake host's vm.
  rt.dispatch(byText(rt, "Convert")!.id, "tap");
  await settle(host);
  const json = String(rt.get("output"));
  assert.match(json, /"name": "Ada"/);
  assert.match(json, /"age": "36"/);

  // JSON → YAML through js-yaml, then YAML → CSV back through both.
  rt.set("input", json);
  rt.set("from", "JSON");
  rt.set("to", "YAML");
  rt.dispatch(byText(rt, "Convert")!.id, "tap");
  await settle(host);
  const yaml = String(rt.get("output"));
  assert.match(yaml, /Ada/);
  assert.match(yaml, /Grace/);

  rt.set("input", yaml);
  rt.set("from", "YAML");
  rt.set("to", "CSV");
  rt.dispatch(byText(rt, "Convert")!.id, "tap");
  await settle(host);
  const roundTrip = String(rt.get("output"));
  assert.match(roundTrip, /name,age/);
  assert.match(roundTrip, /Ada,36/);
  assert.match(roundTrip, /Grace,85/);

  rt.set("input", "name,age\nAda,36\nGrace,85");
  rt.set("from", "CSV");
  rt.set("to", "MD");
  rt.dispatch(byText(rt, "Convert")!.id, "tap");
  await settle(host);
  assert.match(String(rt.get("output")), /\| name +\| age +\||/);

  // A picked file becomes the input.
  host.nextPick = { name: "a.csv", text: "x,y\n1,2" };
  rt.dispatch(byText(rt, "Pick a text file")!.id, "tap");
  await settle(host);
  assert.equal(rt.get("input"), "x,y\n1,2");
});

test("the network question names the app and its hosts", async () => {
  const shell: AppSpec = {
    id: "shell",
    name: "Shell",
    data: { grants: { type: "object", default: {} } },
    state: { asking: null },
    screens: { main: { body: { type: "text", value: "shell" } } },
  };
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  installBuilder(rt);
  frame(host);
  const scope = { lookup: () => undefined, has: () => false };
  const asked = rt.gate!({ id: "a", name: "Converter" } as AppSpec, "network:api.example.com,cdn.example.com");
  await tick();
  assert.deepEqual(rt.get("asking"), {
    app: "a",
    appName: "Converter",
    capability: "network:api.example.com,cdn.example.com",
    text: "Converter wants to connect to api.example.com,cdn.example.com.",
  });
  rt.run({ call: "builder.answer", args: { allow: true } }, scope);
  assert.equal(await asked, true);
  assert.deepEqual(rt.get("grants"), { a: { "network:api.example.com,cdn.example.com": true } });
});
