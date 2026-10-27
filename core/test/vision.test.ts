// Photo understanding with SAM 3.1: the text parser, the shell's container
// service behind `findObjects`, the permission gate, and percentage offsets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateSpec } from "../src/builder/validate.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import { ViewNode, layoutRoot, parseBox, type LayoutContext } from "../src/layout.ts";
import { installVision, parseSamBoxes } from "../src/vision.ts";
import type { AppSpec } from "../src/spec.ts";
import { boot, byText, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function ctx(): LayoutContext {
  return {
    stats: { measured: 0, cacheHits: 0, skipped: 0 },
    measureLeaf: () => ({ width: 0, height: 0 }),
    onFrame: (n) => {
      n.sentFrame = n.frame;
    },
  };
}

function node(type: string, style: Record<string, unknown> = {}, children: ViewNode[] = []) {
  const n = new ViewNode(type);
  n.box = parseBox(style);
  n.children = children;
  for (const c of children) c.parent = n;
  return n;
}

test("the SAM text parser reads boxes, and finds none when there are none", () => {
  const text = `here <|box;x1=264;y1=177;x2=459;y2=590;w=1024;h=682|><|mask;x=0;y=0;data=abc|> and <0f>1<|box;x1=0;y1=0;x2=512;y2=341;w=1024;h=682|>`;
  const boxes = parseSamBoxes(text);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x: 264 / 1024, y: 177 / 682, width: (459 - 264) / 1024, height: (590 - 177) / 682 });
  assert.deepEqual(boxes[1], { x: 0, y: 0, width: 0.5, height: 0.5 });
  assert.deepEqual(parseSamBoxes("No objects found."), []);
  assert.deepEqual(parseSamBoxes(""), []);
});

test("the SAM text parser skips malformed entries", () => {
  const text = `<|box;x1=abc;y1=0;x2=10;y2=10;w=100;h=100|><|box;x1=0;y1=0;x2=10;w=100;h=100|><|box;x1=0;y1=0;x2=10;y2=10;w=0;h=100|><|box;x1=20;y1=10;x2=10;y2=0;w=100;h=100|><|box;x1=0;y1=0;x2=10;y2=10;w=100;h=100|>`;
  assert.deepEqual(parseSamBoxes(text), [{ x: 0, y: 0, width: 0.1, height: 0.1 }]);
});

function shellFor(inner: AppSpec, key = "k"): ReturnType<typeof boot> {
  const outer: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { app: inner, apiKey: key, baseUrl: "https://api.meta.ai/v1" },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  } as unknown as AppSpec;
  const booted = boot(outer, undefined, undefined, { trusted: true });
  installVision(booted.rt);
  return booted;
}

function samBody(text: string): string {
  return JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
}

test("findObjects from an embedded app reaches the shell service and answers sorted objects and counts", async () => {
  const inner = {
    id: "counter",
    name: "Counter",
    capabilities: ["vision"],
    state: { photo: null, done: null },
    screens: {
      main: {
        body: {
          type: "button",
          label: "Go",
          onTap: { findObjects: { photo: "photo", prompts: "['can', 'jar']" }, then: { set: "done", to: "value" } },
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = shellFor(inner);
  const seen: { url: string; prompt: string; key: string }[] = [];
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void) => {
    if (service !== "http") return orig(service, args, done);
    const body = JSON.parse(String(args.body)) as { input: { content: { type: string; text?: string }[] }[] };
    const prompt = body.input[0].content.find((c) => c.type === "input_text")?.text ?? "";
    seen.push({ url: String(args.url), prompt, key: String((args.headers as Record<string, string>).Authorization) });
    const text =
      prompt === "can"
        ? `<|box;x1=512;y1=400;x2=712;y2=500;w=1000;h=1000|>`
        : `<|box;x1=100;y1=100;x2=200;y2=200;w=1000;h=1000|><|box;x1=300;y1=50;x2=400;y2=150;w=1000;h=1000|>`;
    done({ status: 200, body: samBody(text) });
  }) as typeof host.call;
  frame(host);
  const [child] = rt.children;
  host.files.set("counter", new Map([["f1", { id: "f1", name: "shelf.jpg", type: "image/jpeg", size: 3, data: Buffer.from("img") }]]));
  child.set("photo", { id: "f1", name: "shelf.jpg", type: "image/jpeg", size: 3 });
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  frame(host);
  assert.equal(seen.length, 2, "one SAM request per prompt");
  assert.deepEqual(seen.map((s) => s.prompt).sort(), ["can", "jar"]);
  for (const s of seen) {
    assert.equal(s.url, "https://api.meta.ai/v1/responses");
    assert.equal(s.key, "Bearer k");
  }
  const read = host.calls.find((c) => c.service === "files.read");
  assert.deepEqual(read?.args, { app: "counter", id: "f1", as: "base64" });
  const done = child.get("done") as { counts: Record<string, number>; objects: { label: string; x: number; y: number; width: number; height: number }[] };
  assert.deepEqual(done.counts, { can: 1, jar: 2 });
  assert.deepEqual(
    done.objects.map((o) => o.label),
    ["jar", "jar", "can"],
    "reading order: top to bottom, then left to right",
  );
  assert.deepEqual([done.objects[0].x, done.objects[0].y, done.objects[0].width, done.objects[0].height], [0.3, 0.05, 0.1, 0.1]);
  assert.ok(!seen.some((s) => s.prompt === "http"), "the app never reaches http itself");
});

test("findObjects also takes a single prompt string", async () => {
  const inner = {
    id: "single",
    name: "Single",
    capabilities: ["vision"],
    state: { photo: null, done: null },
    screens: {
      main: {
        body: { type: "button", label: "Go", onTap: { findObjects: { photo: "photo", prompts: "'jar'" }, then: { set: "done", to: "value" } } },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = shellFor(inner);
  let calls = 0;
  const orig = host.call!.bind(host);
  host.call = ((service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void) => {
    if (service !== "http") return orig(service, args, done);
    calls++;
    done({ status: 200, body: samBody(`<|box;x1=0;y1=0;x2=10;y2=10;w=100;h=100|>`) });
  }) as typeof host.call;
  frame(host);
  const [child] = rt.children;
  host.files.set("single", new Map([["f1", { id: "f1", name: "s.jpg", type: "image/jpeg", size: 3, data: Buffer.from("img") }]]));
  child.set("photo", { id: "f1", name: "s.jpg", type: "image/jpeg", size: 3 });
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  frame(host);
  assert.equal(calls, 1);
  assert.deepEqual((child.get("done") as { counts: Record<string, number> }).counts, { jar: 1 });
});

test("findObjects without an API key answers the settings error", async () => {
  const inner = {
    id: "nokey",
    name: "NoKey",
    capabilities: ["vision"],
    state: { photo: null, done: null, err: "" },
    screens: {
      main: {
        body: {
          type: "button",
          label: "Go",
          onTap: { findObjects: { photo: "photo", prompts: "'jar'" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } },
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = shellFor(inner, "");
  host.call = (() => assert.fail("no host service without a key")) as typeof host.call;
  frame(host);
  const [child] = rt.children;
  child.set("photo", { id: "f1", name: "s.jpg", type: "image/jpeg", size: 3 });
  rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  await tick();
  frame(host);
  assert.equal(child.get("err"), "Add a Meta Model API key in Settings to find things in photos.");
});

test("the gate asks for vision; a denial never reaches the host", async () => {
  const inner = {
    id: "gated",
    name: "Gated",
    capabilities: ["vision"],
    state: { photo: null, done: null, err: "" },
    screens: {
      main: {
        body: {
          type: "button",
          label: "Go",
          onTap: { findObjects: { photo: "photo", prompts: "'jar'" }, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } },
        },
      },
    },
  } as unknown as AppSpec;
  const outer: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { app: inner, apiKey: "k", baseUrl: "https://api.meta.ai/v1" },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  } as unknown as AppSpec;
  const asked: string[] = [];
  const booted = boot(outer, undefined, undefined, {
    trusted: true,
    gate: (_app, cap) => {
      asked.push(cap);
      return false;
    },
  });
  installVision(booted.rt);
  booted.host.call = (() => assert.fail("a denied call never reaches the host")) as typeof booted.host.call;
  frame(booted.host);
  const [child] = booted.rt.children;
  child.set("photo", { id: "f1", name: "s.jpg", type: "image/jpeg", size: 3 });
  booted.rt.dispatch([...child.nodes.values()].find((n) => n.props.label === "Go")!.id, "tap");
  await tick();
  frame(booted.host);
  assert.deepEqual(asked, ["vision"]);
  assert.equal(child.get("err"), "Not allowed");
});

test("absolute offsets accept percentages of the parent", () => {
  const box = node("spacer", { position: "absolute", left: "25%", top: "10%", width: "50%", height: "50%" });
  const root = node("column", {}, [box]);
  layoutRoot(root, 200, 100, ctx());
  assert.deepEqual(box.frame, [50, 10, 100, 50]);

  const fromEdges = node("spacer", { position: "absolute", right: "10%", bottom: "20%", width: 40, height: 30 });
  const root2 = node("column", {}, [fromEdges]);
  layoutRoot(root2, 200, 100, ctx());
  assert.deepEqual(fromEdges.frame, [140, 50, 40, 30]);
});

test("the pantry demo validates and publishes its inventory", () => {
  const spec = JSON.parse(readFileSync(new URL("../../specs/pantry.json", import.meta.url), "utf8")) as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
  assert.deepEqual(spec.capabilities?.slice().sort(), ["camera", "photos", "vision"]);
  assert.equal(spec.publish?.pantry.from, "items");
  assert.deepEqual(spec.publish?.pantry.fields, ["name", "count", "day"]);
});

test("the prompt documents findObjects and the overlay pattern", () => {
  const prompt = systemPrompt();
  assert.ok(prompt.includes("findObjects"), "the action");
  assert.ok(prompt.includes("counts"), "its result");
  assert.ok(prompt.includes('"position": "absolute"'), "the overlay pattern");
  assert.ok(prompt.includes("pct(o.x)"), "percentage offsets");
});
