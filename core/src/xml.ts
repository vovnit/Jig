// A small, tolerant XML/XHTML reader for EPUBs (container files, OPF packages,
// NCX and nav documents, chapters). Elements, attributes, text, the entities XHTML
// uses, CDATA; comments and anything decorative is skipped. Tolerant the way books
// need: mixed case, stray whitespace, unquoted attributes, unclosed and mismatched
// tags all parse. No DOM, no Node APIs: plain string scans, for JavaScriptCore and QuickJS.

export interface XmlElement {
  kind: "element";
  /** Lowercased, with any namespace prefix kept (`dc:title`, `epub:type`). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  kind: "text";
  text: string;
}

export type XmlNode = XmlElement | XmlText;

/** Non-breaking space, built from its code point so no editor turns it into a plain one. */
const NBSP = String.fromCharCode(160);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: NBSP,
};

/** `&amp;`, `&#169;` and `&#xA9;`: unknown names stay literal. */
export function unescapeEntities(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 10) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const name = s.slice(amp + 1, semi);
    const known = ENTITIES[name];
    if (known !== undefined) {
      out += known;
    } else if (name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      out += codePoint(hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    } else {
      out += s.slice(amp, semi + 1);
    }
    i = semi + 1;
  }
  return out;
}

function codePoint(n: number): string {
  if (!isFinite(n) || n < 0 || n > 0x10ffff) return "�";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "�";
  }
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** The document's top-level nodes. Never throws: broken input parses as far as it goes. */
export function parseXml(src: string): XmlNode[] {
  const top: XmlNode[] = [];
  const stack: XmlElement[] = [];
  const parent = (): XmlElement | null => (stack.length ? stack[stack.length - 1] : null);
  const emit = (n: XmlNode): void => {
    const p = parent();
    if (p) p.children.push(n);
    else top.push(n);
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      const text = src.slice(i);
      if (text) emit({ kind: "text", text: unescapeEntities(text) });
      break;
    }
    if (lt > i) emit({ kind: "text", text: unescapeEntities(src.slice(i, lt)) });
    i = lt + 1;
    if (i >= src.length) {
      emit({ kind: "text", text: "<" });
      break;
    }
    const c = src[i];
    if (c === "!") {
      i = skipBang(src, i + 1, emit);
    } else if (c === "?") {
      const end = src.indexOf("?>", i + 1);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "/") {
      i = closeTag(src, i + 1, stack);
    } else if (isTagChar(c)) {
      i = openTag(src, i, stack, emit);
    } else {
      // A stray `<` in text (e.g. `a < b`): keep it literal.
      emit({ kind: "text", text: "<" });
    }
  }
  return top;
}

/** `<!-- -->`, `<![CDATA[ ]]>` and anything else `<!...>`: comments vanish, CDATA stays. */
function skipBang(src: string, i: number, emit: (n: XmlNode) => void): number {
  if (src.startsWith("--", i)) {
    const end = src.indexOf("-->", i + 2);
    return end < 0 ? src.length : end + 3;
  }
  if (src.startsWith("[CDATA[", i)) {
    const end = src.indexOf("]]>", i + 7);
    const text = src.slice(i + 7, end < 0 ? src.length : end);
    if (text) emit({ kind: "text", text });
    return end < 0 ? src.length : end + 3;
  }
  // DOCTYPE and friends: skip to the closing `>`.
  let j = i;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return j + 1;
    j++;
  }
  return src.length;
}

const isTagChar = (c: string): boolean => /[A-Za-z_:]/.test(c);

function readName(src: string, i: number): [string, number] {
  let j = i;
  while (j < src.length && /[^\s/>="'<]/.test(src[j])) j++;
  return [src.slice(i, j), j];
}

function openTag(src: string, i: number, stack: XmlElement[], emit: (n: XmlNode) => void): number {
  const [raw, afterName] = readName(src, i);
  const el: XmlElement = { kind: "element", name: raw.toLowerCase(), attrs: {}, children: [] };
  let j = afterName;
  let selfClosing = false;
  for (;;) {
    while (j < src.length && isSpace(src[j])) j++;
    if (j >= src.length) break;
    if (src[j] === ">") {
      j++;
      break;
    }
    if (src[j] === "/" && src[j + 1] === ">") {
      selfClosing = true;
      j += 2;
      break;
    }
    if (src[j] === "/") {
      j++;
      continue;
    }
    const [name, afterAttr] = readName(src, j);
    j = afterAttr;
    while (j < src.length && isSpace(src[j])) j++;
    let value = "";
    if (src[j] === "=") {
      j++;
      while (j < src.length && isSpace(src[j])) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, j + 1);
        value = unescapeEntities(src.slice(j + 1, end < 0 ? src.length : end));
        j = end < 0 ? src.length : end + 1;
      } else {
        let k = j;
        while (k < src.length && !isSpace(src[k]) && src[k] !== ">") k++;
        value = unescapeEntities(src.slice(j, k));
        j = k;
      }
    }
    if (name) el.attrs[name.toLowerCase()] = value;
  }
  emit(el);
  if (!selfClosing && !isVoid(el.name)) stack.push(el);
  return j;
}

const VOID = new Set(["br", "hr", "img", "meta", "link", "col", "input", "area", "base", "embed", "source", "track", "wbr"]);

const isVoid = (name: string): boolean => VOID.has(name);

/** A close tag ends every open element up to its match; an unmatched one is ignored. */
function closeTag(src: string, i: number, stack: XmlElement[]): number {
  const [raw, j] = readName(src, i);
  const name = raw.toLowerCase();
  let k = j;
  while (k < src.length && src[k] !== ">") k++;
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].name === name) {
      stack.length = s;
      break;
    }
  }
  return k + 1;
}

/** Every element called `name` under `nodes`, in document order. */
export function descendants(nodes: XmlNode[], name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (n: XmlNode): void => {
    if (n.kind !== "element") return;
    if (n.name === name) out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

/** The first direct child element called `name`, if any. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (c.kind === "element" && c.name === name) return c;
  return undefined;
}

/** All of an element's text, with descendant markup flattened. */
export function textOf(node: XmlNode): string {
  if (node.kind === "text") return node.text;
  let out = "";
  for (const c of node.children) out += textOf(c);
  return out;
}
