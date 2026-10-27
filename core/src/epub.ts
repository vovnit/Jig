// An EPUB reader over the host's `zip.read` service (EPUBs are zips). Stateless:
// every call re-reads the small descriptor files, so chapters stay in spine order
// with titles from the EPUB 3 nav document or the EPUB 2 NCX, and images resolve
// against their own chapter. No DOM, no Node APIs: parsing is `xml.ts`.

import { child, descendants, parseXml, textOf, type XmlElement, type XmlNode } from "./xml.ts";

/** One entry of a zip archive, read through the host. */
export interface ZipSource {
  readText(path: string): Promise<string>;
  readBase64(path: string): Promise<string>;
}

export interface EpubChapter {
  title: string;
  /** The chapter file's path in the archive, for `readChapter`. */
  href: string;
}

export interface EpubBook {
  title: string;
  author: string;
  chapters: EpubChapter[];
}

export interface EpubSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

export type EpubBlockKind = "h1" | "h2" | "h3" | "p" | "quote" | "li" | "hr" | "image";

export interface EpubBlock {
  kind: EpubBlockKind;
  spans: EpubSpan[];
  /** An `image` block: the image's path in the archive, for `bookImage`. */
  src?: string;
}

/** `openBook`: title, author, and the spine in reading order, titled from the TOC. */
export async function openEpub(zip: ZipSource): Promise<EpubBook> {
  const container = await zip.readText("META-INF/container.xml").catch((e) => {
    throw new Error(`Not an EPUB: cannot read its container (${message(e)})`);
  });
  const rootfile = descendants(parseXml(container), "rootfile")[0]?.attrs["full-path"];
  if (!rootfile) throw new Error("Not an EPUB: META-INF/container.xml names no book");
  const opf = await zip.readText(rootfile).catch((e) => {
    throw new Error(`Not an EPUB: cannot read ${rootfile} (${message(e)})`);
  });
  const pkg = descendants(parseXml(opf), "package")[0];
  if (!pkg) throw new Error(`Not an EPUB: ${rootfile} has no package`);
  const base = dirOf(rootfile);
  const meta = child(pkg, "metadata");
  const title = firstText(meta, "dc:title") || "Untitled";
  const author = allTexts(meta, "dc:creator").join(", ");
  const manifest = child(pkg, "manifest");
  const items = new Map<string, { href: string; type: string; props: string }>();
  for (const item of elementsOf(manifest, "item")) {
    const id = item.attrs["id"];
    if (id) items.set(id, { href: item.attrs["href"] ?? "", type: item.attrs["media-type"] ?? "", props: item.attrs["properties"] ?? "" });
  }
  const spine = child(pkg, "spine");
  const paths: string[] = [];
  for (const ref of elementsOf(spine, "itemref")) {
    if ((ref.attrs["linear"] ?? "yes") === "no") continue;
    const href = items.get(ref.attrs["idref"] ?? "")?.href;
    if (href) paths.push(resolveHref(base, href));
  }
  if (!paths.length) throw new Error("This book has no readable chapters");
  const titles = await tableOfContents(zip, base, items);
  return {
    title,
    author,
    chapters: paths.map((href, i) => ({ title: titles.get(href) ?? `Chapter ${i + 1}`, href })),
  };
}

/** `readChapter`: one XHTML file as blocks for a virtualized `list` of paragraphs. */
export async function readEpubChapter(zip: ZipSource, href: string): Promise<EpubBlock[]> {
  if (!href) throw new Error("Unknown chapter");
  const xhtml = await zip.readText(href);
  const doc = parseXml(xhtml);
  const body = descendants(doc, "body")[0];
  const blocks: EpubBlock[] = [];
  const acc = new Accumulator(blocks);
  if (body) {
    for (const c of body.children) acc.walk(c, FORMAT, dirOf(href));
  } else {
    for (const c of doc) acc.walk(c, FORMAT, dirOf(href));
  }
  acc.flush();
  return blocks;
}

/** `bookImage`: an image entry as a `data:` URL, so an `image` node can show it. */
export async function readEpubImage(zip: ZipSource, src: string): Promise<string> {
  if (!src) throw new Error("Unknown image");
  const data = await zip.readBase64(src);
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) throw new Error(`Cannot read image ${src}`);
  return `data:${mimeOf(src)};base64,${data.replace(/\s/g, "")}`;
}

// ---------- The table of contents ----------

/** Archive path → title, from the EPUB 3 nav document else the EPUB 2 NCX. */
async function tableOfContents(
  zip: ZipSource,
  base: string,
  items: Map<string, { href: string; type: string; props: string }>,
): Promise<Map<string, string>> {
  const nav = [...items.values()].find((it) => it.props.split(/\s+/).includes("nav"));
  if (nav?.href) {
    const path = resolveHref(base, nav.href);
    const titles = fromNav(await readQuiet(zip, path), dirOf(path));
    if (titles.size) return titles;
  }
  const ncx = [...items.values()].find((it) => it.type === "application/x-dtbncx+xml");
  if (ncx?.href) {
    const path = resolveHref(base, ncx.href);
    return fromNcx(await readQuiet(zip, path), dirOf(path));
  }
  return new Map();
}

async function readQuiet(zip: ZipSource, path: string): Promise<string> {
  try {
    return await zip.readText(path);
  } catch {
    return "";
  }
}

/** The EPUB 3 nav: the `toc` nav's links in document order. */
function fromNav(src: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!src) return out;
  const nav = descendants(parseXml(src), "nav").find((el) => (el.attrs["epub:type"] ?? "").split(/\s+/).includes("toc"));
  if (!nav) return out;
  for (const a of descendants([nav], "a")) {
    const href = resolveHref(base, a.attrs["href"] ?? "");
    const title = collapse(textOf(a));
    if (href && title && !out.has(href)) out.set(href, title);
  }
  return out;
}

/** The EPUB 2 NCX: `navLabel/text` with its `content` source, nested points in order. */
function fromNcx(src: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!src) return out;
  const map = descendants(parseXml(src), "navmap")[0];
  if (!map) return out;
  const walk = (el: XmlElement): void => {
    for (const point of elementsOf(el, "navpoint")) {
      const navLabel = child(point, "navlabel");
      const label = collapse(textOf(navLabel ? child(navLabel, "text") ?? EMPTY : EMPTY));
      const href = resolveHref(base, child(point, "content")?.attrs["src"] ?? "");
      if (href && label && !out.has(href)) out.set(href, label);
      walk(point);
    }
  };
  walk(map);
  return out;
}

// ---------- Chapters to blocks ----------

interface Format {
  bold: boolean;
  italic: boolean;
  link?: string;
}

const FORMAT: Format = { bold: false, italic: false };

const BLOCK_KINDS: Record<string, EpubBlockKind> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
  p: "p",
  div: "p",
  section: "p",
  article: "p",
  header: "p",
  footer: "p",
  main: "p",
  aside: "p",
  figure: "p",
  figcaption: "p",
  pre: "p",
  blockquote: "quote",
  li: "li",
};

/** Elements whose content never renders. */
const SKIP = new Set(["head", "script", "style", "title", "meta", "link"]);

interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  link?: string;
  /** A `<br>`: never collapses with its neighbours. */
  br?: boolean;
}

/** Gathers a block's inline segments, then collapses whitespace HTML-style on flush. */
class Accumulator {
  private segments: Segment[] = [];
  private kind: EpubBlockKind = "p";
  private blocks: EpubBlock[];

  constructor(blocks: EpubBlock[]) {
    this.blocks = blocks;
  }

  walk(node: XmlNode, fmt: Format, base: string): void {
    if (node.kind === "text") {
      if (node.text) this.segments.push({ text: node.text, bold: fmt.bold, italic: fmt.italic, link: fmt.link });
      return;
    }
    const tag = node.name;
    if (SKIP.has(tag)) return;
    if (tag === "br") {
      this.segments.push({ text: "\n", bold: false, italic: false, br: true });
      return;
    }
    if (tag === "hr") {
      this.flush();
      this.blocks.push({ kind: "hr", spans: [] });
      return;
    }
    if (tag === "img") {
      this.flush();
      const src = resolveHref(base, node.attrs["src"] ?? "");
      if (src) this.blocks.push({ kind: "image", spans: [], src });
      return;
    }
    if (tag === "a") {
      const href = node.attrs["href"];
      const link = href === undefined ? fmt.link : resolveHref(base, href) || undefined;
      for (const c of node.children) this.walk(c, { ...fmt, link }, base);
      return;
    }
    if (tag === "b" || tag === "strong") {
      for (const c of node.children) this.walk(c, { ...fmt, bold: true }, base);
      return;
    }
    if (tag === "i" || tag === "em") {
      for (const c of node.children) this.walk(c, { ...fmt, italic: true }, base);
      return;
    }
    const kind = BLOCK_KINDS[tag];
    if (kind) {
      this.flush();
      // A plain wrapper (`blockquote > p`, `li > p`) keeps its outer kind.
      const prev = this.kind;
      if (kind !== "p" || prev === "p") this.kind = kind;
      for (const c of node.children) this.walk(c, fmt, base);
      this.flush();
      this.kind = prev;
      return;
    }
    for (const c of node.children) this.walk(c, fmt, base);
  }

  flush(): void {
    const spans = collapseSegments(this.segments);
    this.segments = [];
    if (spans.length) this.blocks.push({ kind: this.kind, spans });
  }
}

/** Whitespace runs (including NBSP) become one space; runs touching a `<br>` vanish. */
function collapseSegments(segments: Segment[]): EpubSpan[] {
  interface Char {
    ch: string;
    seg: number;
  }
  const chars: Char[] = [];
  segments.forEach((s, i) => {
    for (const ch of s.text) chars.push({ ch, seg: i });
  });
  const out: { text: string; seg: number }[] = [];
  let i = 0;
  const write = (text: string, seg: number): void => {
    const last = out[out.length - 1];
    const s = segments[seg];
    if (last && last.seg === seg && sameFormat(segments[last.seg], s)) last.text += text;
    else out.push({ text, seg });
  };
  while (i < chars.length) {
    const { ch, seg } = chars[i];
    if (segments[seg].br) {
      out.push({ text: "\n", seg });
      i++;
      continue;
    }
    if (isBlank(ch)) {
      let j = i;
      while (j < chars.length && !segments[chars[j].seg].br && isBlank(chars[j].ch)) j++;
      const touchesBr = (j < chars.length && segments[chars[j].seg].br) || (i > 0 && segments[chars[i - 1].seg].br);
      const atEdge = out.length === 0 || j === chars.length;
      if (!touchesBr && !atEdge) write(" ", chars[j - 1].seg);
      i = j;
      continue;
    }
    write(ch, seg);
    i++;
  }
  const spans: EpubSpan[] = [];
  for (const part of out) {
    const s = segments[part.seg];
    const last = spans[spans.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic && last.link === s.link) last.text += part.text;
    else {
      const span: EpubSpan = { text: part.text };
      if (s.bold) span.bold = true;
      if (s.italic) span.italic = true;
      if (s.link) span.link = s.link;
      spans.push(span);
    }
  }
  return spans.filter((s) => s.text !== "");
}

const sameFormat = (a: Segment, b: Segment): boolean => a.bold === b.bold && a.italic === b.italic && a.link === b.link;

const isBlank = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === NBSP;

/** A title or label: flattened text, whitespace collapsed (`\s` covers NBSP). */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------- Paths ----------

const NBSP = String.fromCharCode(160);

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Resolves an OPF/chapter-relative href to an archive path; absolute URLs stay as they are. */
export function resolveHref(base: string, href: string): string {
  const hash = href.indexOf("#");
  const bare = (hash < 0 ? href : href.slice(0, hash)).trim();
  if (!bare) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(bare)) return bare;
  const parts: string[] = [];
  for (const part of `${base ? `${base}/` : ""}${bare}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function mimeOf(src: string): string {
  const ext = src.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "svg":
    case "svgz":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

// ---------- Small XML helpers ----------

const EMPTY: XmlElement = { kind: "element", name: "", attrs: {}, children: [] };

function elementsOf(el: XmlElement | undefined, name: string): XmlElement[] {
  if (!el) return [];
  return el.children.filter((c): c is XmlElement => c.kind === "element" && c.name === name);
}

function firstText(meta: XmlElement | undefined, name: string): string {
  if (!meta) return "";
  return collapse(textOf(elementsOf(meta, name)[0] ?? EMPTY));
}

function allTexts(meta: XmlElement | undefined, name: string): string[] {
  return elementsOf(meta, name).map((el) => collapse(textOf(el))).filter((t) => t !== "");
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
