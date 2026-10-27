// Phase F: styled text spans, the tolerant XML reader, and EPUB books over `zip.read`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { child, descendants, parseXml, textOf } from "../src/xml.ts";
import { openEpub, readEpubChapter, readEpubImage, type ZipSource } from "../src/epub.ts";
import type { AppSpec } from "../src/spec.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { Runtime } from "../src/runtime.ts";
import { boot, byText, findNode, frame, makeHost } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- xml.ts ----------

test("xml reads messy markup: case, comments, CDATA, entities, stray attributes", () => {
  const src = `<HTML><HEAD><TITLE>t</TITLE></HEAD><BODY>
<!-- a comment --><P class='a' id=x>Hello &amp; <B>bold</B>&nbsp;&#169;&#x41;&bogus;<![CDATA[<raw>]]></P>
<BR><IMG SRC='i.png'><DIV><P>unclosed`;
  const doc = parseXml(src);
  const p = descendants(doc, "p")[0];
  assert.equal(p.attrs.class, "a");
  assert.equal(p.attrs.id, "x", "an unquoted attribute value");
  assert.equal(textOf(p), `Hello & bold${NBSP}©A&bogus;<raw>`);
  assert.ok(descendants(doc, "br").length === 1, "a void tag needs no close");
  assert.equal(descendants(doc, "img")[0].attrs.src, "i.png", "names are lowercased");
});

const NBSP = String.fromCharCode(160);

test("xml tolerates mismatched closes and stray angle brackets", () => {
  const doc = parseXml("<div><span>hi</div>a < b");
  assert.equal(textOf({ kind: "element", name: "x", attrs: {}, children: doc }), "hia < b");
  assert.equal(parseXml("<p>a</p>").length, 1);
  assert.equal(child(descendants(parseXml("<a><b/></a>"), "a")[0], "b")?.name, "b");
});

// ---------- epub.ts ----------

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="img/cover.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>`;

const NAV = `<html><head><title>TOC</title></head><body>
<nav epub:type="toc"><ol><li><a href="ch1.xhtml">First</a></li><li><a href="ch2.xhtml">Second</a></li></ol></nav>
</body></html>`;

const CH1 = `<html><head><title>Ch 1</title><script>skip()</script></head><body>
<h1>Chapter <b>One</b></h1>
<p>Hello   <i>world</i> &amp; <a href="ch2.xhtml">next</a>.</p>
<blockquote><p>Quoted</p></blockquote>
<ul><li>One</li><li>Two</li></ul>
<hr/>
<p><img src="img/cover.png"/></p>
</body></html>`;

const CH2 = `<html><body><h2>Two</h2><p>Last.</p></body></html>`;
const PNG = "iVBORw0KGgo=";

const epub3: Record<string, string> = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": OPF,
  "OEBPS/nav.xhtml": NAV,
  "OEBPS/ch1.xhtml": CH1,
  "OEBPS/ch2.xhtml": CH2,
  "OEBPS/img/cover.png": PNG,
};

const source = (files: Record<string, string>): ZipSource => ({
  readText: async (path) => {
    if (path in files) return files[path];
    throw new Error(`No entry ${path}`);
  },
  readBase64: async (path) => {
    if (path in files) return files[path];
    throw new Error(`No entry ${path}`);
  },
});

test("openBook reads title, author and nav chapters in spine order", async () => {
  const book = await openEpub(source(epub3));
  assert.deepEqual(book, {
    title: "Test Book",
    author: "Test Author",
    chapters: [
      { title: "First", href: "OEBPS/ch1.xhtml" },
      { title: "Second", href: "OEBPS/ch2.xhtml" },
    ],
  });
});

test("chapters fall back to the NCX, then to Chapter N", async () => {
  const ncx = `<ncx><navmap>
    <navPoint id="a"><navLabel><text>Alpha</text></navLabel><content src="ch1.xhtml#s"/></navPoint>
    <navPoint id="b"><navLabel><text>Beta</text></navLabel><content src="ch2.xhtml"/>
      <navPoint id="c"><navLabel><text>Gamma</text></navLabel><content src="ch3.xhtml"/></navPoint>
    </navPoint></navmap></ncx>`;
  const opf2 = OPF.replace(' properties="nav"', ' properties="not-nav"').replace(
    '<item id="img"',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="img"',
  );
  const files = { ...epub3, "OEBPS/content.opf": opf2, "OEBPS/toc.ncx": ncx };
  const book = await openEpub(source(files));
  assert.deepEqual(
    book.chapters.map((c) => c.title),
    ["Alpha", "Beta"],
    "nested NCX points stay in order",
  );
  const bare = Object.fromEntries(Object.entries(files).filter(([k]) => k !== "OEBPS/toc.ncx"));
  const untitled = await openEpub(source(bare));
  assert.deepEqual(
    untitled.chapters.map((c) => c.title),
    ["Chapter 1", "Chapter 2"],
  );
});

test("readChapter gives blocks with spans, images and rules", async () => {
  const blocks = await readEpubChapter(source(epub3), "OEBPS/ch1.xhtml");
  assert.deepEqual(blocks, [
    { kind: "h1", spans: [{ text: "Chapter " }, { text: "One", bold: true }] },
    {
      kind: "p",
      spans: [{ text: "Hello " }, { text: "world", italic: true }, { text: " & " }, { text: "next", link: "OEBPS/ch2.xhtml" }, { text: "." }],
    },
    { kind: "quote", spans: [{ text: "Quoted" }] },
    { kind: "li", spans: [{ text: "One" }] },
    { kind: "li", spans: [{ text: "Two" }] },
    { kind: "hr", spans: [] },
    { kind: "image", spans: [], src: "OEBPS/img/cover.png" },
  ]);
});

test("bookImage answers a data: URL; broken input gives errors", async () => {
  assert.equal(await readEpubImage(source(epub3), "OEBPS/img/cover.png"), `data:image/png;base64,${PNG}`);
  await assert.rejects(openEpub(source({})), /Not an EPUB/);
  await assert.rejects(openEpub(source({ "META-INF/container.xml": "<container/>" })), /names no book/);
  await assert.rejects(readEpubChapter(source(epub3), "OEBPS/missing.xhtml"), /No entry/);
  await assert.rejects(readEpubChapter(source(epub3), ""), /Unknown chapter/);
  await assert.rejects(readEpubImage(source(epub3), ""), /Unknown image/);
});

// ---------- runtime actions ----------

const bookSpec = (): AppSpec =>
  ({
    id: "reader",
    name: "Reader",
    capabilities: ["files"],
    state: { file: { id: "b1" }, book: null, blocks: [], url: "", err: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "button", label: "Open", onTap: { openBook: { file: "file" }, then: { set: "book", to: "value" }, else: { set: "err", to: "error" } } },
            {
              type: "button",
              label: "Read",
              onTap: { readChapter: { file: "file", href: "'OEBPS/ch1.xhtml'" }, then: { set: "blocks", to: "value" }, else: { set: "err", to: "error" } },
            },
            {
              type: "button",
              label: "Image",
              onTap: { bookImage: { file: "file", src: "'OEBPS/img/cover.png'" }, then: { set: "url", to: "value" }, else: { set: "err", to: "error" } },
            },
          ],
        },
      },
    },
  }) as AppSpec;

function zipHost(files: Record<string, string>, seen: { service: string; args: Record<string, unknown> }[]) {
  const { host, rt } = boot(bookSpec());
  host.call = (service, args, done) => {
    seen.push({ service, args });
    if (service === "zip.read") {
      const path = (args as { path: string }).path;
      if (path in files) done({ data: files[path] });
      else done(null, `No entry ${path}`);
      return;
    }
    done(null, `No '${service}' service`);
  };
  return { host, rt };
}

test("openBook, readChapter and bookImage run through then with the app injected", async () => {
  const seen: { service: string; args: Record<string, unknown> }[] = [];
  const { host, rt } = zipHost(epub3, seen);
  frame(host);

  rt.dispatch(byText(rt, "Open")!.id, "tap");
  await tick();
  frame(host);
  assert.deepEqual(rt.get("book"), {
    title: "Test Book",
    author: "Test Author",
    chapters: [
      { title: "First", href: "OEBPS/ch1.xhtml" },
      { title: "Second", href: "OEBPS/ch2.xhtml" },
    ],
  });
  assert.ok(seen.length > 0 && seen.every((c) => c.service === "zip.read"), "core reads through zip.read only");
  assert.deepEqual(
    seen[0].args,
    { app: "reader", id: "b1", path: "META-INF/container.xml", as: "text" },
    "the runtime injects the app's identity",
  );

  rt.dispatch(byText(rt, "Read")!.id, "tap");
  await tick();
  frame(host);
  const blocks = rt.get("blocks") as { kind: string }[];
  assert.equal(blocks[0].kind, "h1");
  assert.equal(blocks.at(-1)?.kind, "image");

  rt.dispatch(byText(rt, "Image")!.id, "tap");
  await tick();
  frame(host);
  assert.equal(rt.get("url"), `data:image/png;base64,${PNG}`);
  assert.deepEqual(rt.errors, []);
});

test("a caller-supplied app never reaches zip.read; failures run else", async () => {
  const seen: { service: string; args: Record<string, unknown> }[] = [];
  const { host, rt } = zipHost(epub3, seen);
  frame(host);
  rt.run({ openBook: { file: "file", app: "'evil'" }, then: { set: "book", to: "value" } }, {
    lookup: (name) => rt.get(name),
    has: () => true,
  });
  await tick();
  frame(host);
  assert.ok((rt.get("book") as { title: string }).title === "Test Book");
  assert.ok(seen.every((c) => (c.args as { app: string }).app === "reader"), "no caller-supplied app leaks through");

  const missing = zipHost({}, []);
  frame(missing.host);
  missing.rt.dispatch(byText(missing.rt, "Open")!.id, "tap");
  await tick();
  frame(missing.host);
  assert.match(String(missing.rt.get("err")), /No entry/);
});

test("book actions need the files capability", () => {
  const spec = bookSpec();
  delete spec.capabilities;
  assert.match(validateSpec(spec).join("\n"), /uses 'files'; add "files" to capabilities/);
  assert.deepEqual(validateSpec(bookSpec()), []);
});

// ---------- text spans ----------

const spansSpec = (): AppSpec =>
  ({
    id: "s",
    name: "S",
    state: { note: "", spans: [{ text: "Hello " }, { text: "bold", bold: true, color: "accent" }, { text: "link", link: "https://example.com" }] },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "text", value: "plain" },
            { type: "text", spans: "{{spans}}", onLink: { set: "note", to: "value" } },
          ],
        },
      },
    },
  }) as AppSpec;

test("spans reach the host with theme colors, and measure with their ranges", () => {
  const host = makeHost();
  const seen: { text: string; style: { spans?: { start: number; end: number; bold: boolean; italic: boolean }[] } }[] = [];
  const orig = host.measureText.bind(host);
  host.measureText = (text, style, maxWidth) => {
    seen.push({ text, style });
    return orig(text, style, maxWidth);
  };
  const rt = new Runtime(host);
  rt.setViewport(390, 844);
  rt.load(spansSpec());
  frame(host);
  const node = [...rt.nodes.values()].find((n) => n.type === "text" && Array.isArray(n.props.spans))!;
  assert.deepEqual(node.props.spans, [
    { text: "Hello " },
    { text: "bold", bold: true, color: "#3b6ef6" },
    { text: "link", link: "https://example.com" },
  ]);
  const measured = seen.find((s) => s.text === "Hello boldlink")!;
  assert.deepEqual(measured.style.spans, [{ start: 6, end: 10, bold: true, italic: false }]);
  assert.ok(!seen.some((s) => s.text === "plain" && s.style.spans), "plain text measures without spans");

  const calls = host.measureCalls;
  frame(host);
  assert.equal(host.measureCalls, calls, "nothing re-measures without changes");
  rt.set("spans", [{ text: "Hello " }, { text: "bold", bold: true, italic: true }, { text: "link" }]);
  frame(host);
  assert.ok(host.measureCalls > calls, "the same text with new spans measures again");
  assert.deepEqual(seen.at(-1)!.style.spans, [{ start: 6, end: 10, bold: true, italic: true }]);
});

test("a link tap runs onLink with the URL", () => {
  const { host, rt } = boot(spansSpec());
  frame(host);
  const node = [...rt.nodes.values()].find((n) => n.type === "text" && Array.isArray(n.props.spans))!;
  rt.dispatch(node.id, "link", { url: "https://example.com" });
  frame(host);
  assert.equal(rt.get("note"), "https://example.com");
  assert.deepEqual(rt.errors, []);
});

test("spans validate, with bindings and the link action", () => {
  assert.deepEqual(validateSpec(spansSpec()), []);
  const bad = spansSpec();
  ((bad.screens.main.body as unknown as { children: unknown[] }).children[1] as Record<string, unknown>).spans = [{ text: "x", bogus: true }];
  assert.match(validateSpec(bad).join("\n"), /has no 'bogus'/);
});

test("the books demo renders its library with no errors", async () => {
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../../specs/books.json", import.meta.url), "utf8")) as AppSpec;
  const { host, rt } = boot(spec);
  frame(host);
  assert.ok(byText(rt, "Add book"));
  assert.ok(byText(rt, "No books yet. Add an EPUB to start reading."));
  assert.deepEqual(rt.errors, []);
});

test("the books reader shows chapters and empty blocks without errors", async () => {
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../../specs/books.json", import.meta.url), "utf8")) as AppSpec;
  const { host, rt } = boot(spec);
  rt.set("books", [{
    id: "b1",
    title: "Test Book",
    author: "Test Author",
    file: { id: "b1" },
    chapters: [{ title: "First", href: "OEBPS/ch1.xhtml" }, { title: "Second", href: "OEBPS/ch2.xhtml" }],
    chapter: 0,
  }]);
  rt.set("open", "b1");
  rt.run({ navigate: "reader" }, { lookup: () => undefined, has: () => false });
  frame(host);
  assert.ok(byText(rt, "First"), "the current chapter's title");
  assert.ok(byText(rt, "Second"), "the chapter list");
  assert.ok(byText(rt, "Loading chapter…"), "blocks arrive later through readChapter");
  assert.deepEqual(rt.errors, []);

  rt.set("blocks", [
    { kind: "h1", spans: [{ text: "Chapter " }, { text: "One", bold: true }] },
    { kind: "p", spans: [{ text: "Hello " }, { text: "next", link: "OEBPS/ch2.xhtml" }] },
    { kind: "image", spans: [], src: "OEBPS/img/cover.png" },
  ]);
  frame(host);
  assert.ok(
    findNode(rt, (p) => Array.isArray(p.spans) && (p.spans as { text: string; bold?: boolean }[]).some((s) => s.text === "One" && s.bold)),
    "a heading row keeps its spans",
  );
  assert.ok(byText(rt, "Show image"), "an unloaded image offers to load");
  assert.deepEqual(rt.errors, []);
});
