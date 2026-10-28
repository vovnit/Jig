// App icons drawn by Muse Image: creation stores one, `builder.icon` redraws one,
// the request carries the model and a prompt from name, description and accent, and
// without a key or with the toggle off nothing is requested. Lazy icons draw one at
// a time; a failure keeps the letter tile and logs once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppSpec } from "../src/spec.ts";
import { installBuilder } from "../src/builder/index.ts";
import { findApp, seedApps } from "../src/builder/registry.ts";
import { boot, frame } from "./fake-host.ts";

interface ImageCall {
  url: string;
  headers: Record<string, string>;
  body: { model?: unknown; prompt?: unknown; n?: unknown };
}

type ImageReply = string | { status: number; body: string };

function setup(opts: { images?: ImageReply[]; manualImages?: boolean; replies?: unknown[] } = {}) {
  const spec: AppSpec = {
    id: "shell",
    name: "Shell",
    data: {
      apps: { type: "list", default: [] },
      apiKey: { type: "string", default: "test-key" },
      baseUrl: { type: "string", default: "https://api.test/v1" },
      icons: { type: "boolean", default: true },
    },
    state: { log: [], busy: false, newPrompt: "", newId: "" },
    screens: { home: { body: { type: "text", value: "Home" } } },
  };
  const { host, rt } = boot(spec, undefined, undefined, { trusted: true });
  const imageCalls: ImageCall[] = [];
  const pendingImages: ((result: unknown, error?: string) => void)[] = [];
  const images = [...(opts.images ?? [])];
  const replies = [...(opts.replies ?? [])];
  let n = 0;
  host.call = (service, args, done, progress) => {
    if (service !== "http") return done(null, `No '${service}' service`);
    const body = args as { url?: unknown; headers?: Record<string, string>; body?: unknown; stream?: unknown };
    const url = String(body.url ?? "");
    if (url.endsWith("/images/generations")) {
      imageCalls.push({ url, headers: { ...(body.headers ?? {}) }, body: JSON.parse(String(body.body ?? "{}")) });
      if (opts.manualImages) {
        pendingImages.push(done);
        return;
      }
      const next: ImageReply = images.length ? images.shift()! : "WEBP";
      const res = typeof next === "string" ? { status: 200, body: JSON.stringify({ data: [{ b64_json: next }] }) } : next;
      queueMicrotask(() => done(res));
      return;
    }
    const reply = replies.shift() as { output?: unknown[] } | undefined;
    assert.ok(reply, "unexpected model request");
    if (!body.stream) return queueMicrotask(() => done({ status: 200, body: JSON.stringify(reply) }));
    const response = { id: `resp_${++n}`, output: (reply as { output: unknown[] }).output };
    queueMicrotask(() => {
      progress!({ line: `data: ${JSON.stringify({ type: "response.completed", response })}` });
      done({ status: 200, body: "" });
    });
  };
  installBuilder(rt);
  frame(host);
  return { host, rt, imageCalls, pendingImages };
}

const scope = { lookup: () => undefined, has: () => false };
const tick = () => new Promise((r) => setTimeout(r, 1));

/** Frames until `cond` holds (a builder run, then the icon request after it). */
async function settle(host: Parameters<typeof frame>[0], cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) {
    frame(host);
    await tick();
  }
}

/** A model step that calls one tool. */
const toolCall = (name: string, args: unknown) => ({ output: [{ type: "function_call", call_id: `call_${name}`, name, arguments: JSON.stringify(args) }] });

/** A model step that writes a spec in its message, then calls set_spec without arguments. */
const writeSpec = (json: string) => ({ output: [
  { type: "message", content: [{ type: "output_text", text: `Here it is.\n\n\`\`\`json\n${json}\n\`\`\`` }] },
  { type: "function_call", call_id: "call_set", name: "set_spec", arguments: "{}" },
] });

const demo = (id: string, name: string, accent?: string): AppSpec => ({
  id,
  name,
  description: `${name} does things`,
  ...(accent ? { theme: { accent } } : {}),
  screens: { main: { title: name, body: { type: "text", value: "Hi" } } },
});

test("creating an app stores an icon drawn from its name, description and accent", async () => {
  const made = JSON.stringify({
    id: "x",
    name: "Packing",
    description: "A packing list for trips",
    theme: { accent: "#ff8800" },
    screens: { main: { title: "Packing", body: { type: "text", value: "Hi" } } },
  });
  const { host, rt, imageCalls } = setup({ images: ["WEBP1"], replies: [writeSpec(made), toolCall("finish", { message: "Made it." })] });
  rt.run({ call: "builder.create", args: { prompt: "'A packing list for trips'" } }, scope);
  const id = String(rt.get("newId"));
  await settle(host, () => !!findApp(rt, id)?.icon);
  const entry = findApp(rt, id)!;
  assert.equal(entry.icon, "data:image/webp;base64,WEBP1");
  assert.equal(imageCalls.length, 1);
  const call = imageCalls[0];
  assert.equal(call.url, "https://api.test/v1/images/generations");
  assert.equal(call.headers.Authorization, "Bearer test-key");
  assert.equal(call.body.model, "muse-image-1.0");
  assert.equal(call.body.n, 1);
  assert.match(String(call.body.prompt), /Packing/);
  assert.match(String(call.body.prompt), /A packing list for trips/);
  assert.match(String(call.body.prompt), /#ff8800/);
});

test("builder.icon replaces the icon", async () => {
  const { host, rt, imageCalls } = setup({ images: ["OLD", "NEW"] });
  seedApps(rt, [demo("chores", "Chores", "#112233")]);
  rt.run({ call: "builder.icon", args: { id: "'chores'" } }, scope);
  await settle(host, () => !!findApp(rt, "chores")?.icon);
  assert.equal(findApp(rt, "chores")!.icon, "data:image/webp;base64,OLD");
  rt.run({ call: "builder.icon", args: { id: "'chores'" } }, scope);
  await settle(host, () => findApp(rt, "chores")?.icon === "data:image/webp;base64,NEW");
  assert.equal(imageCalls.length, 2);
  assert.match(String(imageCalls[0].body.prompt), /#112233/);
});

test("without a key, or with the toggle off, nothing is requested", async () => {
  const { host, rt, imageCalls } = setup();
  seedApps(rt, [demo("chores", "Chores")]);
  rt.set("apiKey", "");
  rt.run({ call: "builder.icon", args: { id: "'chores'" } }, scope);
  for (let i = 0; i < 10; i++) {
    frame(host);
    await tick();
  }
  assert.equal(imageCalls.length, 0, "no key: no request");
  assert.equal(findApp(rt, "chores")!.icon, undefined);
  rt.set("apiKey", "test-key");
  rt.set("icons", false);
  rt.run({ call: "builder.icon", args: { id: "'chores'" } }, scope);
  for (let i = 0; i < 10; i++) {
    frame(host);
    await tick();
  }
  assert.equal(imageCalls.length, 0, "toggle off: no request, and no lazy icon either");
  assert.equal(findApp(rt, "chores")!.icon, undefined);
});

test("the home list draws missing icons one at a time, in order", async () => {
  const { host, rt, imageCalls, pendingImages } = setup({ manualImages: true });
  seedApps(rt, [demo("a", "Alpha"), demo("b", "Bee"), demo("c", "Cee")]);
  frame(host);
  await tick();
  assert.equal(imageCalls.length, 1, "one request in flight");
  frame(host);
  await tick();
  frame(host);
  await tick();
  assert.equal(imageCalls.length, 1, "the rest wait while it flies");
  assert.match(String(imageCalls[0].body.prompt), /Alpha/);
  assert.match(String(imageCalls[0].body.prompt), /#3b6ef6/, "no accent of its own: the default");
  pendingImages.shift()!({ status: 200, body: JSON.stringify({ data: [{ b64_json: "A" }] }) });
  await settle(host, () => !!findApp(rt, "a")?.icon);
  frame(host);
  await tick();
  assert.equal(imageCalls.length, 2, "the next starts after the first lands");
  assert.match(String(imageCalls[1].body.prompt), /Bee/);
  pendingImages.shift()!({ status: 200, body: JSON.stringify({ data: [{ b64_json: "B" }] }) });
  await settle(host, () => !!findApp(rt, "b")?.icon);
  frame(host);
  await tick();
  assert.equal(imageCalls.length, 3);
  pendingImages.shift()!({ status: 200, body: JSON.stringify({ data: [{ b64_json: "C" }] }) });
  await settle(host, () => !!findApp(rt, "c")?.icon);
  assert.deepEqual([findApp(rt, "a")!.icon, findApp(rt, "b")!.icon, findApp(rt, "c")!.icon], [
    "data:image/webp;base64,A",
    "data:image/webp;base64,B",
    "data:image/webp;base64,C",
  ]);
});

test("a failed draw keeps the letter tile and logs once", async () => {
  const { host, rt } = setup({ images: [{ status: 500, body: "nope" }] });
  seedApps(rt, [demo("chores", "Chores")]);
  const logged = (rt.get("log") as { text: string }[]).length;
  rt.run({ call: "builder.icon", args: { id: "'chores'" } }, scope);
  await settle(host, () => (rt.get("log") as { text: string }[]).length > logged);
  assert.equal(findApp(rt, "chores")!.icon, undefined, "no icon: the row keeps its letter tile");
  const fresh = (rt.get("log") as { role: string; text: string }[]).slice(logged);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].text, /icon/i);
});

test("the shell shows the icon when there is one, and offers a new one", () => {
  const shell = JSON.parse(readFileSync(new URL("../../specs/shell.json", import.meta.url), "utf8")) as AppSpec;
  assert.equal((shell.data?.icons as { default?: unknown })?.default, true);
  const home = (shell.screens.home.body as { children?: { items?: string }[] }).children ?? [];
  const row = JSON.stringify(home.find((c) => c.items === "apps"));
  assert.match(row, /"if":"app\.icon"/, "the image shows only with an icon");
  assert.match(row, /"if":"!app\.icon"/, "the letter tile stays otherwise");
  assert.match(JSON.stringify(shell.screens.home.body), /builder\.icon/);
});
