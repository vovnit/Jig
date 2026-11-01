import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../src/spec.ts";
import type { Host } from "../src/bridge.ts";
import { installDemo, memorySecrets, recordHttp, replayHttp, runDemo, tapeKey } from "../src/demo.ts";
import type { Tape } from "../src/demo.ts";
import { boot, frame, runTimers } from "./fake-host.ts";

/** Drives frames and timers while a demo promise runs. */
async function drive<T>(host: { pending: (() => void)[]; timers: { due: number; cb: () => void }[]; batches: unknown[] }, promise: Promise<T>): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  void promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
  const start = Date.now();
  const h = host as unknown as { pending: (() => void)[]; timers: { due: number; cb: () => void }[]; batches: unknown[] };
  while (!settled) {
    while (h.pending.length) h.pending.shift()!();
    const due = h.timers.filter((t) => t.due <= Date.now());
    for (const t of due) h.timers.splice(h.timers.indexOf(t), 1);
    for (const t of due) t.cb();
    await new Promise((r) => setTimeout(r, 5));
    if (Date.now() - start > 10000) throw new Error("drive timeout");
  }
  while (h.pending.length) h.pending.shift()!();
  if (error) throw error;
  return value as T;
}

test("replayHttp streams lines then the body, scaled by speed", () => {
  const delays: number[] = [];
  const cbs: (() => void)[] = [];
  const seen: { line?: string; result?: unknown }[] = [];
  const logs: string[] = [];
  const host = {
    after: (ms: number, cb: () => void) => { delays.push(ms); cbs.push(cb); },
    log: (_l: string, m: string) => void logs.push(m),
    call: undefined as Host["call"],
  } as unknown as Host;
  const tape: Tape = { entries: [{ key: "POST /v1/responses", status: 200, body: "done", lines: [[100, "a"], [300, "b"]], ms: 400 }] };
  replayHttp(host, tape, 2);
  let result: unknown;
  host.call!("http", { url: "https://api.meta.ai/v1/responses", method: "POST" }, (r) => { result = r; }, (u) => seen.push({ line: String(u.line) }));
  assert.deepEqual(delays, [50, 150, 200]);
  for (const cb of cbs) cb();
  assert.deepEqual(seen.map((s) => s.line), ["a", "b"]);
  assert.deepEqual(result, { status: 200, body: "done" });
});

test("replayHttp consumes FIFO per key, falls back for images, misses 599 and swallows schedule", () => {
  const host = {
    after: (_ms: number, cb: () => void) => cb(),
    log: () => {},
    call: ((_s: string, _a: unknown, done: (r: unknown) => void) => done({ forwarded: true })) as Host["call"],
  } as unknown as Host & { calls: number };
  let forwarded = 0;
  host.call = ((_s: string, _a: unknown, done: (r: unknown) => void) => { forwarded++; done({}); }) as Host["call"];
  const tape: Tape = {
    entries: [
      { key: "POST /v1/responses", status: 200, body: "first", ms: 0 },
      { key: "POST /v1/responses", status: 200, body: "second", ms: 0 },
      { key: "POST /v1/images/generations a cat", status: 200, body: "cat-pic", ms: 0 },
    ],
  };
  replayHttp(host, tape, 1);
  const get = (args: Record<string, unknown>) => new Promise<unknown>((resolve) => host.call!("http", args, (r) => resolve(r)));
  return (async () => {
    assert.deepEqual(await get({ url: "https://api.meta.ai/v1/responses", method: "POST" }), { status: 200, body: "first" });
    assert.deepEqual(await get({ url: "https://api.meta.ai/v1/responses", method: "POST" }), { status: 200, body: "second" });
    // No exact prompt match: falls back to the path's remaining picture.
    assert.deepEqual(
      await get({ url: "https://api.meta.ai/v1/images/generations", method: "POST", body: JSON.stringify({ prompt: "a dog" }) }),
      { status: 200, body: "cat-pic" },
    );
    const warns: string[] = [];
    (host as unknown as { log: Host["log"] }).log = (_l, m) => void warns.push(m);
    assert.deepEqual(await get({ url: "https://api.meta.ai/v1/unknown", method: "GET" }), {
      status: 599,
      body: '{"error":{"message":"not in the demo tape"}}',
    });
    assert.ok(warns.length === 1 && !warns[0].includes("JIGDEMO"));
    forwarded = 0;
    await new Promise<void>((resolve) => host.call!("schedule.set", { app: "x", items: [] }, () => resolve()));
    assert.equal(forwarded, 0, "schedule.set never reaches the host");
  })();
});

test("recordHttp stores lines, status, body and timing but no secrets", async () => {
  const tape: Tape = { entries: [] };
  const host = {
    now: () => 1000,
    call: ((service: string, _args: Record<string, unknown>, done: (r: unknown) => void, progress?: (u: Record<string, unknown>) => void) => {
      progress?.({ line: "data: one" });
      progress?.({ line: "data: two" });
      done({ status: 200, body: "ok" });
    }) as Host["call"],
  } as unknown as Host;
  recordHttp(host, tape);
  await new Promise<void>((resolve) => host.call!("http", {
    url: "https://api.meta.ai/v1/responses",
    method: "POST",
    headers: { Authorization: "Bearer secret-key" },
    body: JSON.stringify({ prompt: "screenshot-bytes" }),
    stream: true,
  }, () => resolve(), () => {}));
  assert.equal(tape.entries.length, 1);
  const entry = tape.entries[0];
  assert.equal(entry.key, "POST /v1/responses");
  assert.equal(entry.status, 200);
  assert.equal(entry.body, "ok");
  assert.deepEqual(entry.lines?.map(([, l]) => l), ["data: one", "data: two"]);
  assert.ok(!JSON.stringify(entry).includes("secret-key"), "no headers");
  assert.ok(!JSON.stringify(entry).includes("screenshot-bytes"), "no request body");
});

test("memorySecrets keeps secrets off the device store", () => {
  const vault = new Map([["app/k", "on-device"]]);
  const host = {
    secrets: {
      get: (app: string, key: string) => vault.get(`${app}/${key}`) ?? null,
      set: (app: string, key: string, value: string | null) => void (value == null ? vault.delete(`${app}/${key}`) : vault.set(`${app}/${key}`, value)),
      clear: (app: string) => { for (const k of [...vault.keys()]) if (k.startsWith(`${app}/`)) vault.delete(k); },
    },
  } as unknown as Host;
  memorySecrets(host);
  assert.equal(host.secrets!.get("app", "k"), null);
  host.secrets!.set("app", "k", "demo");
  assert.equal(host.secrets!.get("app", "k"), "demo");
  assert.equal(vault.get("app/k"), "on-device", "the device store is untouched");
});

test("installDemo replays with speed and isolates secrets", () => {
  const host = { after: (_ms: number, cb: () => void) => cb(), log: () => {}, call: undefined as Host["call"] } as unknown as Host;
  installDemo(host, { script: { name: "d", speed: 2, steps: [] }, tape: { entries: [{ key: "GET /x", status: 200, body: "hi", ms: 10 }] } });
  assert.equal(host.secrets!.get("a", "k"), null);
  host.secrets!.set("a", "k", "v");
  assert.equal(host.secrets!.get("a", "k"), "v");
});

test("tapeKey names image prompts but nothing else", () => {
  assert.equal(tapeKey({ url: "https://api.meta.ai/v1/responses?x=1", method: "POST" }), "POST /v1/responses");
  assert.equal(
    tapeKey({ url: "https://api.meta.ai/v1/images/generations", method: "POST", body: JSON.stringify({ prompt: "a cat" }) }),
    "POST /v1/images/generations a cat",
  );
  assert.equal(tapeKey({ url: "https://api.meta.ai/v1/images/generations", method: "POST", body: "nope" }), "POST /v1/images/generations");
});

const demoShell = (): AppSpec => ({
  id: "shell",
  name: "Shell",
  data: { apiKey: { type: "string", default: "" } },
  state: { draft: "", busy: false },
  screens: {
    home: {
      body: {
        type: "column",
        children: [
          { type: "button", label: "Go", onTap: { navigate: "second" } },
          { type: "textfield", placeholder: "Name", bind: "draft" },
        ],
      },
    },
    second: { title: "Second", body: { type: "text", value: "Hello {{draft}}" } },
  },
});

test("runDemo taps, types, waits and marks", async () => {
  const { host, rt } = boot(demoShell(), undefined, undefined, { trusted: true });
  const logs: string[] = [];
  (host as unknown as { log: Host["log"] }).log = (_level, message) => void logs.push(message);
  const script = {
    name: "d",
    pause: 5,
    steps: [
      { type: "hi", into: "Name", cps: 1000 },
      { tap: "Go" },
      { waitFor: "Hello hi", timeout: 2000 },
      { mark: "arrived" },
      { back: true },
    ],
  } as unknown as { name: string; pause: number; steps: import("../src/demo.ts").DemoStep[] };
  const marks = await drive(host, runDemo(rt, script, { retryMs: 500 }));
  frame(host);
  assert.equal(rt.get("apiKey"), "demo");
  assert.equal(rt.get("draft"), "hi");
  assert.ok(host.batches.flat().some((o) => o[0] === "update" && ((o[2] as Record<string, unknown>).value === "hi" || (o[2] as Record<string, unknown>).value === "h")), "the host saw typed values");
  assert.ok(logs.some((l) => l.startsWith("JIGDEMO ") && JSON.parse(l.slice(8)).mark === "arrived"), "a mark logs JIGDEMO");
  assert.deepEqual(marks.map((m) => m.name), ["arrived"]);
  assert.ok(logs.some((l) => JSON.parse(l.slice(8)).done === true));
  assert.equal(rt.nav.peek().length, 1, "back returned home");
});

test("runDemo waits for busy and fails a missing node with JIGDEMO", async () => {
  const { host, rt } = boot(demoShell(), undefined, undefined, { trusted: true });
  const logs: string[] = [];
  (host as unknown as { log: Host["log"] }).log = (_level, message) => void logs.push(message);
  rt.set("busy", true);
  setTimeout(() => rt.set("busy", false), 20);
  const marks = await drive(host, runDemo(rt, { name: "d", pause: 5, steps: [{ waitIdle: true, timeout: 2000 }] }, { retryMs: 200 }));
  assert.deepEqual(marks, []);
  assert.ok(logs.some((l) => JSON.parse(l.slice(8)).done === true));

  const logs2: string[] = [];
  (host as unknown as { log: Host["log"] }).log = (_level, message) => void logs2.push(message);
  const missed = await drive(host, runDemo(rt, { name: "d", pause: 5, steps: [{ tap: "Nowhere" }] }, { retryMs: 200 }));
  assert.deepEqual(missed, []);
  const err = logs2.map((l) => JSON.parse(l.slice(8))).find((o) => o.error);
  assert.ok(err && err.step === 0, "a missing node fails with {error, step}");
});

test("replay never falls back to live traffic on a miss", async () => {
  let forwarded = 0;
  const host = {
    after: (_ms: number, cb: () => void) => cb(),
    log: () => {},
    call: ((_s: string, _a: unknown, done: (r: unknown) => void) => { forwarded++; done({}); }) as Host["call"],
  } as unknown as Host;
  replayHttp(host, { entries: [{ key: "GET /a", status: 200, body: "a", ms: 0 }] }, 1);
  const result = await new Promise<unknown>((resolve) => host.call!("http", { url: "https://x/a", method: "GET" }, (r) => resolve(r)));
  assert.deepEqual(result, { status: 200, body: "a" });
  assert.equal(forwarded, 0);
  const miss = await new Promise<unknown>((resolve) => host.call!("http", { url: "https://x/missing", method: "GET" }, (r) => resolve(r)));
  assert.deepEqual(miss, { status: 599, body: '{"error":{"message":"not in the demo tape"}}' });
  assert.equal(forwarded, 0, "a miss answers 599 without touching live traffic");
});

test("installDemo with a tape and a record target replays hits and records misses on top", async () => {
  let liveCalls = 0;
  const host = {
    after: (_ms: number, cb: () => void) => cb(),
    log: () => {},
    call: ((service: string, args: Record<string, unknown>, done: (r: unknown) => void) => {
      if (service === "schedule.set") {
        liveCalls++;
        done({});
        return;
      }
      liveCalls++;
      done({ status: 200, body: `live ${String((args as { url?: unknown }).url)}` });
    }) as Host["call"],
  } as unknown as Host;
  const tape: Tape = { entries: [{ key: "GET /a", status: 200, body: "tape-a", ms: 0 }] };
  const record: Tape = { entries: [] };
  installDemo(host, { script: { name: "d", steps: [] }, tape }, record);
  assert.equal(record.entries.length, 1, "the record starts as a copy of the existing entries");
  assert.equal(record.entries[0].key, "GET /a");
  assert.notEqual(record.entries[0], tape.entries[0]);
  const get = (url: string) => new Promise<unknown>((resolve) => host.call!("http", { url, method: "GET" }, (r) => resolve(r)));
  liveCalls = 0;
  assert.deepEqual(await get("https://x/a"), { status: 200, body: "tape-a" });
  assert.equal(liveCalls, 0, "a hit replays without going live");
  assert.equal(record.entries.length, 1, "a hit records nothing new");
  assert.deepEqual(await get("https://x/b"), { status: 200, body: "live https://x/b" });
  assert.equal(liveCalls, 1, "a miss goes live");
  assert.equal(record.entries.length, 2);
  assert.deepEqual(record.entries.map((e) => e.key), ["GET /a", "GET /b"]);
  assert.equal(record.entries[1].body, "live https://x/b");
  liveCalls = 0;
  await new Promise<void>((resolve) => host.call!("schedule.set", { app: "x", items: [] }, () => resolve()));
  assert.equal(liveCalls, 0, "schedule.set stays swallowed in extend mode");
});

test("recordHttp swallows schedule.set instead of recording it", async () => {
  const tape: Tape = { entries: [] };
  let forwarded = 0;
  const host = {
    call: ((service: string, _args: Record<string, unknown>, done: (r: unknown) => void) => {
      forwarded++;
      done({ status: 200, body: "ok" });
    }) as Host["call"],
  } as unknown as Host;
  recordHttp(host, tape);
  await new Promise<void>((resolve) => host.call!("schedule.set", {}, () => resolve()));
  assert.equal(forwarded, 0);
  assert.equal(tape.entries.length, 0);
});

test("type and submit find only textfields by placeholder", async () => {
  const spec: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { draft: "", tapped: false, submitted: false },
    screens: {
      home: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Name", onTap: { set: "tapped", to: "true" } },
            { type: "text", value: "Name" },
            { type: "textfield", placeholder: "Name", bind: "draft" },
            { type: "button", label: "Send", onTap: { set: "tapped", to: "true" } },
            { type: "textfield", placeholder: "Send", bind: "draft", onSubmit: { set: "submitted", to: "true" } },
            { type: "textfield", placeholder: "Enter name", bind: "draft" },
          ],
        },
      },
    },
  };
  const { host, rt } = boot(spec, undefined, undefined, { trusted: true });
  // A button and a text share the text: typing still lands in the field.
  await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ type: "hi", into: "Name", cps: 0 }] }, { retryMs: 300 }));
  frame(host);
  assert.equal(rt.get("draft"), "hi");
  assert.equal(rt.get("tapped"), false);
  rt.set("draft", "");
  // Submit finds the field, not the button with the same text.
  await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ submit: "Send" }] }, { retryMs: 300 }));
  frame(host);
  assert.equal(rt.get("submitted"), true);
  assert.equal(rt.get("tapped"), false);
  // `contains` matches a placeholder substring.
  rt.set("draft", "");
  await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ type: "yo", into: "name", contains: true, cps: 0 }] }, { retryMs: 300 }));
  frame(host);
  assert.equal(rt.get("draft"), "yo");
  // A value with no such placeholder fails, even when a label matches.
  const { host: host2, rt: rt2 } = boot({
    id: "shell",
    name: "Shell",
    state: { draft: "" },
    screens: { home: { body: { type: "column", children: [{ type: "button", label: "Only" }] } } },
  } as unknown as AppSpec, undefined, undefined, { trusted: true });
  const logs: string[] = [];
  (host2 as unknown as { log: Host["log"] }).log = (_l, m) => void logs.push(m);
  await drive(host2, runDemo(rt2, { name: "d", pause: 1, steps: [{ type: "x", into: "Only", cps: 0 }] }, { retryMs: 200 }));
  assert.ok(logs.some((l) => JSON.parse(l.slice(8)).error === "no node 'Only'"));
});

test("matches run in combined tree order, descending into embeds in place", async () => {
  const inner: AppSpec = {
    id: "inner",
    name: "Inner",
    state: { hit: false },
    screens: { main: { body: { type: "button", label: "Same", onTap: { set: "hit", to: "true" } } } },
  };
  const spec: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { a: false, b: false, app: inner },
    screens: {
      home: {
        scroll: false,
        body: {
          type: "column",
          children: [
            { type: "button", label: "Same", onTap: { set: "a", to: "true" } },
            { type: "app", spec: "{{app}}" },
            { type: "button", label: "Same", onTap: { set: "b", to: "true" } },
          ],
        },
      },
    },
  };
  const { host, rt } = boot(spec, undefined, undefined, { trusted: true });
  frame(host);
  assert.equal(rt.children.length, 1, "the embed is on screen");
  await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ tap: "Same", nth: 1 }] }, { retryMs: 500 }));
  frame(host);
  const [child] = rt.children;
  assert.equal(rt.get("a"), false);
  assert.equal(rt.get("b"), false);
  assert.equal(child.get("hit"), true, "nth 1 is the embed between the two shell buttons");
});

test("marks use epoch milliseconds, not host.now", async () => {
  const { host, rt } = boot(demoShell(), undefined, undefined, { trusted: true });
  (host as unknown as { now: () => number }).now = () => 42;
  const before = Date.now();
  const marks = await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ mark: "m" }] }, { retryMs: 300 }));
  assert.equal(marks.length, 1);
  assert.ok(marks[0].t >= before && marks[0].t <= Date.now(), `mark t ${marks[0].t} is epoch ms`);
  assert.notEqual(marks[0].t, 42);
});

test("a failing step ends with done:true and the record stop carries the error", async () => {
  const { host, rt } = boot(demoShell(), undefined, undefined, { trusted: true });
  const logs: string[] = [];
  (host as unknown as { log: Host["log"] }).log = (_l, m) => void logs.push(m);
  const stops: Record<string, unknown>[] = [];
  const prev = host.call!;
  host.call = ((service: string, args: Record<string, unknown>, done: (r: unknown) => void, progress?: (u: Record<string, unknown>) => void) => {
    if (service === "demo.record") {
      stops.push(args);
      done({});
      return;
    }
    return prev.call(host, service, args, done, progress);
  }) as Host["call"];
  const marks = await drive(host, runDemo(rt, { name: "d", pause: 1, steps: [{ mark: "ok" }, { tap: "Nowhere" }] }, { retryMs: 200 }));
  assert.deepEqual(marks.map((m) => m.name), ["ok"]);
  const last = JSON.parse(logs.at(-1)!.slice(8));
  assert.equal(last.done, true);
  assert.deepEqual(last.marks.map((m: { name: string }) => m.name), ["ok"]);
  assert.equal(last.error, "no node 'Nowhere'");
  assert.equal(last.step, 1);
  assert.equal(stops.length, 1);
  assert.deepEqual(stops[0], { action: "stop", name: "d", marks, error: "no node 'Nowhere'" });
});

test("scrollIntoView emits a scrollTo command for a node in a scroll view", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    screens: {
      main: {
        scroll: false,
        body: {
          type: "column",
          children: [{
            type: "scroll",
            style: { height: 200 },
            children: [{
              type: "column",
              children: [
                { type: "text", value: "Top" },
                { type: "text", value: "Pad", style: { height: 800 } },
                { type: "text", value: "Bottom" },
              ],
            }],
          }],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  const target = [...rt.nodes.values()].find((n) => n.props.value === "Bottom")!;
  const scroll = (() => { let n = target.parent; while (n && n.type !== "scroll") n = n.parent; return n!; })();
  rt.scrollIntoView(target.id);
  const ops = frame(host);
  const cmd = ops.find((o) => o[0] === "command" && o[1] === scroll.id && o[2] === "scrollTo");
  assert.ok(cmd, "a scrollTo command");
  const [y, animated] = (cmd as ["command", number, string, [number, boolean]])[3];
  assert.ok(y > 0 && animated === true);
  assert.equal(rt.scrollOffsets.get(scroll.id), y);
  assert.equal(rt.scrollIntoView(target.id, 24, true), false, "already in view: no scroll");
  const top = [...rt.nodes.values()].find((n) => n.props.value === "Top")!;
  assert.equal(rt.scrollIntoView(top.id, 24, true), true, "scrolled out of view: back up");
  runTimers(host);
});
