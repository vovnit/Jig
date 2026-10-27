// Phase E: files in the format, the picker and share actions, and the file store's lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBackground } from "../src/builder/background.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { systemPrompt } from "../src/builder/prompt.ts";
import type { AppSpec } from "../src/spec.ts";
import { boot, byText, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function photoSpec(): AppSpec {
  return {
    id: "pics",
    name: "Pics",
    capabilities: ["photos"],
    data: { photos: { type: "list", fields: { id: "string", file: "file" }, default: [] } },
    state: { err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            {
              type: "button",
              label: "Add",
              onTap: {
                pickPhoto: {},
                then: { push: "photos", value: { id: "uid()", file: "value" } },
                else: { set: "err", to: "error" },
              },
            },
            { type: "list", items: "photos", as: "photo", row: { type: "image", src: "{{photo.file}}" } },
          ],
        },
      },
    },
  } as unknown as AppSpec;
}

test("a picked photo lands in a list and shows in an image with a jig-file src", async () => {
  const { host, rt } = boot(photoSpec());
  host.nextPick = { name: "a.jpg", type: "image/jpeg", text: "bytes" };
  frame(host);
  rt.dispatch(byText(rt, "Add")!.id, "tap");
  await tick();
  frame(host);
  const photos = rt.get("photos") as { id: string; file: { id: string; name: string; type: string; size: number } }[];
  assert.equal(photos.length, 1);
  assert.equal(photos[0].file.name, "a.jpg");
  assert.equal(photos[0].file.type, "image/jpeg");
  const img = [...rt.nodes.values()].find((n) => n.type === "image")!;
  assert.equal(img.props.src, `jig-file:pics/${photos[0].file.id}`);
  assert.deepEqual(rt.errors, []);
});

test("a cancelled pick runs else", async () => {
  const { host, rt } = boot(photoSpec());
  host.nextPick = "Cancelled";
  frame(host);
  rt.dispatch(byText(rt, "Add")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(rt.get("photos"), []);
  assert.equal(rt.get("err"), "Cancelled");
});

test("readFile returns the picked text", async () => {
  const spec = {
    id: "reader",
    name: "Reader",
    capabilities: ["photos", "files"],
    state: { file: null, text: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Pick", onTap: { pickPhoto: {}, then: { set: "file", to: "value" }, else: { set: "err", to: "error" } } },
            { type: "button", label: "Read", onTap: { readFile: { file: "file", as: "'text'" }, then: { set: "text", to: "value" }, else: { set: "err", to: "error" } } },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  host.nextPick = { name: "note.txt", type: "text/plain", text: "Hello\nfiles" };
  frame(host);
  rt.dispatch(byText(rt, "Pick")!.id, "tap");
  await tick();
  frame(host);
  assert.ok((rt.get("file") as { id: string }).id);
  rt.dispatch(byText(rt, "Read")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("text"), "Hello\nfiles");
  assert.deepEqual(rt.errors, []);
});

test("pickFile sends accept and the app to the host", async () => {
  const spec = {
    id: "docs",
    name: "Docs",
    capabilities: ["files"],
    state: { done: null },
    screens: { main: { body: { type: "button", label: "Go", onTap: { pickFile: { accept: ["epub", "pdf"], multiple: false }, then: { set: "done", to: "value" } } } } },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  host.nextPick = { name: "book.epub", type: "application/epub+zip", text: "book" };
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  const call = host.calls.find((c) => c.service === "pickFile")!;
  assert.deepEqual(call.args.accept, ["epub", "pdf"]);
  assert.equal(call.args.app, "docs");
  assert.equal((rt.get("done") as { name: string }).name, "book.epub");
});

test("validation requires each file capability", () => {
  const body = (onTap: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: { type: "button", label: "Go", onTap } } }, ...extra }) as unknown as AppSpec;
  assert.match(validateSpec(body({ pickFile: {} })).join("\n"), /uses 'files'; add "files" to capabilities/);
  assert.match(validateSpec(body({ pickPhoto: {} })).join("\n"), /uses 'photos'; add "photos" to capabilities/);
  assert.match(validateSpec(body({ takePhoto: {} })).join("\n"), /uses 'camera'; add "camera" to capabilities/);
  assert.match(validateSpec(body({ share: { text: "'hi'" } })).join("\n"), /uses 'share'; add "share" to capabilities/);
  assert.match(validateSpec(body({ readFile: { file: "f", as: "'text'" } }, { state: { f: null } })).join("\n"), /uses 'files'/);
  assert.match(validateSpec(body({ deleteFile: { file: "f" } }, { state: { f: null } })).join("\n"), /uses 'files'/);
  // A file field and a handle as image src pass.
  assert.deepEqual(
    validateSpec({
      id: "t",
      name: "T",
      capabilities: ["photos"],
      data: { photos: { type: "list", fields: { id: "string", file: "file" } } },
      screens: { main: { body: { type: "list", items: "photos", as: "photo", row: { type: "image", src: "{{photo.file}}" } } } },
    } as unknown as AppSpec),
    [],
  );
});

test("takePhoto asks through the gate; a denial never reaches the host", async () => {
  const spec = {
    id: "cam",
    name: "Cam",
    capabilities: ["camera"],
    state: { done: null, err: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: { takePhoto: {}, then: { set: "done", to: "value" }, else: { set: "err", to: "error" } } } } },
  } as unknown as AppSpec;
  const denied = boot(spec, undefined, undefined, { gate: () => false });
  denied.host.nextPick = { name: "photo.jpg", type: "image/jpeg", text: "pic" };
  frame(denied.host);
  denied.rt.dispatch(byText(denied.rt, "Go")!.id, "tap");
  await tick();
  frame(denied.host);
  assert.equal(denied.rt.get("err"), "Not allowed");
  assert.ok(!denied.host.calls.some((c) => c.service === "takePhoto"));

  let gates = 0;
  const allowed = boot(spec, undefined, undefined, {
    gate: () => {
      gates++;
      return true;
    },
  });
  allowed.host.nextPick = { name: "photo.jpg", type: "image/jpeg", text: "pic" };
  frame(allowed.host);
  allowed.rt.dispatch(byText(allowed.rt, "Go")!.id, "tap");
  await tick();
  frame(allowed.host);
  assert.equal(gates, 1);
  assert.ok((allowed.rt.get("done") as { name: string }).name, "photo.jpg");
  assert.deepEqual(allowed.host.calls.find((c) => c.service === "takePhoto")?.args, { app: "cam" });
});

test("share sends text with the app and never asks", async () => {
  const spec = {
    id: "s",
    name: "S",
    capabilities: ["share"],
    state: { done: false },
    screens: { main: { body: { type: "button", label: "Go", onTap: { share: { text: "'Hello'" }, then: { set: "done", to: "true" } } } } },
  } as unknown as AppSpec;
  let gates = 0;
  const { host, rt } = boot(spec, undefined, undefined, {
    gate: () => {
      gates++;
      return true;
    },
  });
  frame(host);
  rt.dispatch(byText(rt, "Go")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("done"), true);
  assert.equal(gates, 0);
  assert.deepEqual(host.calls.find((c) => c.service === "share")?.args, { app: "s", text: "Hello" });
});

test("deleteFile removes the file; reading it then fails to else", async () => {
  const spec = {
    id: "d",
    name: "D",
    capabilities: ["photos", "files"],
    state: { file: null, text: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Pick", onTap: { pickPhoto: {}, then: { set: "file", to: "value" } } },
            { type: "button", label: "Delete", onTap: { deleteFile: { file: "file" } } },
            { type: "button", label: "Read", onTap: { readFile: { file: "file", as: "'text'" }, then: { set: "text", to: "value" }, else: { set: "err", to: "error" } } },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(spec);
  host.nextPick = { name: "a.jpg", type: "image/jpeg", text: "pic" };
  frame(host);
  rt.dispatch(byText(rt, "Pick")!.id, "tap");
  await tick();
  frame(host);
  const id = (rt.get("file") as { id: string }).id;
  rt.dispatch(byText(rt, "Delete")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(host.calls.find((c) => c.service === "files.delete")?.args, { app: "d", id });
  rt.dispatch(byText(rt, "Read")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("err"), "No such file");
});

test("the fake store reads ranges: offset and length are bytes", async () => {
  const { host } = boot({ id: "r", name: "R", screens: { main: { body: { type: "text", value: "hi" } } } });
  const written = await new Promise<Record<string, unknown>>((resolve, reject) =>
    host.call!("files.write", { app: "r", name: "n.txt", type: "text/plain", data: Buffer.from("Hello world", "utf8").toString("base64") }, (result, error) =>
      error ? reject(new Error(error)) : resolve(result as Record<string, unknown>),
    ),
  );
  const read = (args: Record<string, unknown>) =>
    new Promise<string>((resolve, reject) =>
      host.call!("files.read", args, (result, error) => (error ? reject(new Error(error)) : resolve((result as { data: string }).data)),
      ),
    );
  assert.equal(await read({ app: "r", id: written.id, as: "text", offset: 6, length: 5 }), "world");
  assert.equal(await read({ app: "r", id: written.id, as: "text" }), "Hello world");
});

test("deleting an app clears its files and keeps the other's", async () => {
  const app = (id: string): AppSpec => ({ id, name: id, screens: { main: { body: { type: "text", value: "hi" } } } }) as AppSpec;
  const shell: AppSpec = {
    id: "shell",
    name: "Shell",
    state: { apps: [{ id: "a", spec: app("a") }, { id: "b", spec: app("b") }] },
    screens: { main: { body: { type: "text", value: "{{len(apps)}} apps" } } },
  } as unknown as AppSpec;
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  installBackground(rt);
  const first = rt.nextFrame();
  frame(host);
  await first;
  host.files.set("a", new Map([["f1", { id: "f1", name: "a.txt", type: "text/plain", size: 1, data: Buffer.from("a") }]]));
  host.files.set("b", new Map([["f2", { id: "f2", name: "b.txt", type: "text/plain", size: 1, data: Buffer.from("b") }]]));
  rt.set("apps", [{ id: "b", spec: app("b") }]);
  frame(host);
  await tick();
  frame(host);
  assert.ok(host.calls.some((c) => c.service === "files.clear" && (c.args as { app: string }).app === "a"));
  assert.ok(!host.files.has("a"), "the deleted app's files are gone");
  assert.ok(host.files.has("b"), "the other app's files stay");
});

test("the prompt names the file type, the actions and the photo example", () => {
  const prompt = systemPrompt();
  assert.ok(prompt.includes("object|file"), "the file type");
  for (const name of ["pickFile", "pickPhoto", "takePhoto", "share", "readFile", "deleteFile"]) assert.ok(prompt.includes(name), name);
  assert.ok(prompt.includes('{"pickPhoto": {}, "then": {"push": "photos", "value": {"id": "uid()", "file": "value"}}}'));
});

test("image, video and audio src accept a literal file handle", async () => {
  const handle = { id: "f1", name: "a.jpg", type: "image/jpeg", size: 3 };
  const spec = {
    id: "m",
    name: "M",
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "image", src: handle },
            { type: "video", src: handle },
            { type: "audio", src: handle },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  assert.deepEqual(validateSpec(spec), []);
  const { host, rt } = boot(spec);
  frame(host);
  const srcs = [...rt.nodes.values()].filter((n) => ["image", "video", "audio"].includes(n.type)).map((n) => n.props.src);
  assert.deepEqual(srcs, ["jig-file:m/f1", "jig-file:m/f1", "jig-file:m/f1"]);
});

test("files.write with invalid base64 answers Bad file data", async () => {
  const { host } = boot({ id: "r", name: "R", screens: { main: { body: { type: "text", value: "hi" } } } });
  const write = (data: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) =>
      host.call!("files.write", { app: "r", name: "n.bin", type: "application/octet-stream", data }, (result, error) =>
        error ? reject(new Error(error)) : resolve(result as Record<string, unknown>),
      ),
    );
  await assert.rejects(() => write("!!! not base64 !!!"), /Bad file data/);
  assert.ok(!host.files.get("r")?.size, "nothing is stored");
  const handle = await write(Buffer.from("ok", "utf8").toString("base64"));
  assert.equal(handle.name, "n.bin");
});
