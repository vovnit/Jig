// A small, safe expression language for bindings and actions. JS-like syntax
// (the model writes it fluently) but no assignment, no `new`, no method calls and
// no prototype access: an app spec stays data, never code.
//
//   glasses + 1            done ? 'success' : 'muted'
//   len(filter(chores, c => !c.done))
//   item.name + ' · ' + formatDate(item.at, 'HH:mm')

export interface Scope {
  /** Returns undefined for unknown names; throws are reserved for real errors. */
  lookup(name: string): unknown;
  has(name: string): boolean;
}

export type Compiled = (scope: Scope) => unknown;

export class ExprError extends Error {}

// ---------- Tokenizer ----------

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

const OPS = [
  "===", "!==", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.",
  "+", "-", "*", "/", "%", "<", ">", "!", "?", ":", ".", ",", "(", ")", "[", "]", "{", "}",
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (src[j] === "e" || src[j] === "E") {
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      out.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const n = src[++j];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError(`Unterminated string in: ${src}`);
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected '${c}' in: ${src}`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "eof" });
  return out;
}

// ---------- Parser → closures ----------

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function safeGet(obj: unknown, key: unknown): unknown {
  if (obj == null) return undefined;
  if (typeof key === "string" && FORBIDDEN.has(key)) throw new ExprError(`Forbidden property '${key}'`);
  if (Array.isArray(obj) || typeof obj === "string") {
    if (key === "length") return obj.length;
    if (typeof key === "number") return (obj as ArrayLike<unknown>)[key];
    return undefined;
  }
  if (typeof obj === "object" && Object.hasOwn(obj as object, key as PropertyKey)) {
    return (obj as Record<PropertyKey, unknown>)[key as PropertyKey];
  }
  return undefined;
}

class LocalScope implements Scope {
  parent: Scope;
  vars: Record<string, unknown>;
  constructor(parent: Scope, vars: Record<string, unknown>) {
    this.parent = parent;
    this.vars = vars;
  }
  lookup(name: string): unknown {
    return Object.hasOwn(this.vars, name) ? this.vars[name] : this.parent.lookup(name);
  }
  has(name: string): boolean {
    return Object.hasOwn(this.vars, name) || this.parent.has(name);
  }
}

export function childScope(parent: Scope, vars: Record<string, unknown>): Scope {
  return new LocalScope(parent, vars);
}

type Lambda = { __lambda: true; call: (...args: unknown[]) => unknown };

function isLambda(v: unknown): v is Lambda {
  return typeof v === "object" && v !== null && (v as Lambda).__lambda === true;
}

class Parser {
  toks: Tok[];
  pos = 0;
  src: string;

  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }

  peek(offset = 0): Tok {
    return this.toks[this.pos + offset];
  }
  next(): Tok {
    return this.toks[this.pos++];
  }
  isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.t === "op" && t.v === v;
  }
  eat(v: string): boolean {
    if (this.isOp(v)) {
      this.pos++;
      return true;
    }
    return false;
  }
  expect(v: string): void {
    if (!this.eat(v)) throw new ExprError(`Expected '${v}' in: ${this.src}`);
  }

  parse(): Compiled {
    const e = this.expr();
    if (this.peek().t !== "eof") throw new ExprError(`Unexpected token in: ${this.src}`);
    return e;
  }

  expr(): Compiled {
    // Single-param arrow: `c => c.done`
    const t = this.peek();
    if (t.t === "id" && this.isOp("=>", 1)) {
      this.pos += 2;
      const name = t.v;
      const body = this.expr();
      return (s) => ({ __lambda: true, call: (arg: unknown) => body(childScope(s, { [name]: arg })) }) satisfies Lambda;
    }
    // Two-param arrow: `(a, b) => a.n - b.n`
    if (this.isOp("(") && this.peek(1).t === "id" && this.isOp(",", 2) && this.peek(3).t === "id" && this.isOp(")", 4) && this.isOp("=>", 5)) {
      const a = (this.peek(1) as { v: string }).v;
      const b = (this.peek(3) as { v: string }).v;
      this.pos += 6;
      const body = this.expr();
      return (s) => ({ __lambda: true, call: (x: unknown, y: unknown) => body(childScope(s, { [a]: x, [b]: y })) }) satisfies Lambda;
    }
    return this.ternary();
  }

  ternary(): Compiled {
    const cond = this.nullish();
    if (!this.eat("?")) return cond;
    const a = this.expr();
    this.expect(":");
    const b = this.expr();
    return (s) => (cond(s) ? a(s) : b(s));
  }

  nullish(): Compiled {
    let l = this.or();
    while (this.eat("??")) {
      const left = l;
      const r = this.or();
      l = (s) => left(s) ?? r(s);
    }
    return l;
  }

  or(): Compiled {
    let l = this.and();
    while (this.eat("||")) {
      const left = l;
      const r = this.and();
      l = (s) => left(s) || r(s);
    }
    return l;
  }

  and(): Compiled {
    let l = this.equality();
    while (this.eat("&&")) {
      const left = l;
      const r = this.equality();
      l = (s) => left(s) && r(s);
    }
    return l;
  }

  equality(): Compiled {
    let l = this.comparison();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || !["==", "===", "!=", "!=="].includes(t.v)) return l;
      this.pos++;
      const left = l;
      const r = this.comparison();
      const neg = t.v.startsWith("!");
      l = (s) => looseEq(left(s), r(s)) !== neg;
    }
  }

  comparison(): Compiled {
    let l = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || !["<", ">", "<=", ">="].includes(t.v)) return l;
      this.pos++;
      const left = l;
      const r = this.additive();
      const op = t.v;
      l = (s) => {
        const a = left(s) as number;
        const b = r(s) as number;
        return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
      };
    }
  }

  additive(): Compiled {
    let l = this.mult();
    for (;;) {
      if (this.eat("+")) {
        const left = l;
        const r = this.mult();
        l = (s) => {
          const a = left(s);
          const b = r(s);
          if (typeof a === "string" || typeof b === "string") return str(a) + str(b);
          return (a as number) + (b as number);
        };
      } else if (this.eat("-")) {
        const left = l;
        const r = this.mult();
        l = (s) => (left(s) as number) - (r(s) as number);
      } else return l;
    }
  }

  mult(): Compiled {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || !["*", "/", "%"].includes(t.v)) return l;
      this.pos++;
      const left = l;
      const r = this.unary();
      const op = t.v;
      l = (s) => {
        const a = left(s) as number;
        const b = r(s) as number;
        return op === "*" ? a * b : op === "/" ? (b === 0 ? 0 : a / b) : b === 0 ? 0 : a % b;
      };
    }
  }

  unary(): Compiled {
    if (this.eat("!")) {
      const e = this.unary();
      return (s) => !e(s);
    }
    if (this.eat("-")) {
      const e = this.unary();
      return (s) => -(e(s) as number);
    }
    return this.postfix();
  }

  postfix(): Compiled {
    let e = this.primary();
    for (;;) {
      if (this.eat(".") || this.eat("?.")) {
        const t = this.next();
        if (t.t !== "id") throw new ExprError(`Expected property name in: ${this.src}`);
        const obj = e;
        const key = t.v;
        e = (s) => safeGet(obj(s), key);
      } else if (this.eat("[")) {
        const obj = e;
        const key = this.expr();
        this.expect("]");
        e = (s) => safeGet(obj(s), key(s));
      } else if (this.isOp("(")) {
        throw new ExprError(`Only built-in functions can be called: ${this.src}`);
      } else return e;
    }
  }

  args(): Compiled[] {
    const args: Compiled[] = [];
    this.expect("(");
    if (!this.eat(")")) {
      do args.push(this.expr());
      while (this.eat(","));
      this.expect(")");
    }
    return args;
  }

  primary(): Compiled {
    const t = this.next();
    switch (t.t) {
      case "num":
      case "str": {
        const v = t.v;
        return () => v;
      }
      case "id": {
        const name = t.v;
        if (name === "true") return () => true;
        if (name === "false") return () => false;
        if (name === "null") return () => null;
        if (name === "undefined") return () => undefined;
        if (this.isOp("(")) {
          const fn = BUILTINS[name];
          if (!fn) throw new ExprError(`Unknown function '${name}'`);
          const args = this.args();
          return (s) => fn(...args.map((a) => a(s)));
        }
        if (FORBIDDEN.has(name)) throw new ExprError(`Forbidden name '${name}'`);
        return (s) => s.lookup(name);
      }
      case "op": {
        if (t.v === "(") {
          const e = this.expr();
          this.expect(")");
          return e;
        }
        if (t.v === "[") {
          const items: Compiled[] = [];
          if (!this.eat("]")) {
            do items.push(this.expr());
            while (this.eat(","));
            this.expect("]");
          }
          return (s) => items.map((i) => i(s));
        }
        if (t.v === "{") {
          const entries: [string, Compiled][] = [];
          if (!this.eat("}")) {
            do {
              const k = this.next();
              if (k.t !== "id" && k.t !== "str") throw new ExprError(`Bad object key in: ${this.src}`);
              if (FORBIDDEN.has(k.v)) throw new ExprError(`Forbidden key '${k.v}'`);
              if (this.eat(":")) entries.push([k.v, this.expr()]);
              else {
                const name = k.v;
                entries.push([name, (s) => s.lookup(name)]);
              }
            } while (this.eat(","));
            this.expect("}");
          }
          return (s) => {
            const o: Record<string, unknown> = {};
            for (const [k, v] of entries) o[k] = v(s);
            return o;
          };
        }
      }
    }
    throw new ExprError(`Unexpected token in: ${this.src}`);
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == b;
  return a === b;
}

export function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------- Built-ins ----------

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const fnOrField = (f: unknown) => (isLambda(f) ? (x: unknown) => f.call(x) : typeof f === "string" ? (x: unknown) => safeGet(x, f) : (x: unknown) => x);

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toDate(v: unknown): Date {
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    // 'YYYY-MM-DD' is a local calendar day, not UTC midnight.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(v);
  }
  return new Date();
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDate(v: unknown, fmt: unknown = "MMM d"): string {
  const d = toDate(v);
  if (isNaN(d.getTime())) return "";
  return String(fmt).replace(/yyyy|MMM|MM|dd|d|EEE|HH|H|hh|h|mm|a/g, (tok) => {
    switch (tok) {
      case "yyyy": return String(d.getFullYear());
      case "MMM": return MONTHS[d.getMonth()];
      case "MM": return pad2(d.getMonth() + 1);
      case "dd": return pad2(d.getDate());
      case "d": return String(d.getDate());
      case "EEE": return WEEKDAYS[d.getDay()];
      case "HH": return pad2(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad2(d.getHours() % 12 || 12);
      case "h": return String(d.getHours() % 12 || 12);
      case "mm": return pad2(d.getMinutes());
      case "a": return d.getHours() < 12 ? "AM" : "PM";
    }
    return tok;
  });
}

let uidCounter = 0;

export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  len: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : 0),
  filter: (l, f) => asList(l).filter((x) => Boolean(fnOrField(f)(x))),
  map: (l, f) => asList(l).map(fnOrField(f)),
  find: (l, f) => asList(l).find((x) => Boolean(fnOrField(f)(x))),
  count: (l, f) => (f === undefined ? asList(l).length : asList(l).filter((x) => Boolean(fnOrField(f)(x))).length),
  some: (l, f) => asList(l).some((x) => Boolean(fnOrField(f)(x))),
  every: (l, f) => asList(l).every((x) => Boolean(fnOrField(f)(x))),
  sum: (l, f) => asList(l).reduce<number>((a, x) => a + (Number(fnOrField(f)(x)) || 0), 0),
  sort: (l, f, dir) => {
    const key = fnOrField(f);
    const sign = dir === "desc" ? -1 : 1;
    return [...asList(l)].sort((a, b) => {
      const ka = key(a) as number | string;
      const kb = key(b) as number | string;
      return ka < kb ? -sign : ka > kb ? sign : 0;
    });
  },
  reverse: (l) => [...asList(l)].reverse(),
  first: (l) => asList(l)[0],
  last: (l) => asList(l).at(-1),
  slice: (l, a, b) => (typeof l === "string" ? l.slice(a as number, b as number) : asList(l).slice(a as number, b as number)),
  range: (a, b) => {
    const [start, end] = b === undefined ? [0, Number(a)] : [Number(a), Number(b)];
    const out: number[] = [];
    for (let i = start; i < end && out.length < 10000; i++) out.push(i);
    return out;
  },
  join: (l, sep) => asList(l).map(str).join(sep === undefined ? ", " : String(sep)),
  contains: (h, n) => (Array.isArray(h) ? h.includes(n) : typeof h === "string" ? h.includes(str(n)) : false),
  keys: (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []),
  min: (...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(Number)),
  max: (...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(Number)),
  clamp: (v, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(v))),
  round: (v, digits) => {
    const p = 10 ** (Number(digits) || 0);
    return Math.round(Number(v) * p) / p;
  },
  floor: (v) => Math.floor(Number(v)),
  ceil: (v) => Math.ceil(Number(v)),
  abs: (v) => Math.abs(Number(v)),
  num: (v) => {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  },
  str: (v) => str(v),
  upper: (v) => str(v).toUpperCase(),
  lower: (v) => str(v).toLowerCase(),
  trim: (v) => str(v).trim(),
  fixed: (v, d) => Number(v).toFixed(Number(d) || 0),
  pct: (v) => `${Math.max(0, Math.min(100, Number(v) * 100))}%`,
  plural: (n, one, many) => `${str(n)} ${Number(n) === 1 ? str(one) : str(many ?? `${str(one)}s`)}`,
  now: () => Date.now(),
  today: () => isoDay(new Date()),
  day: (v) => isoDay(toDate(v)),
  addDays: (v, n) => {
    const d = toDate(v);
    d.setDate(d.getDate() + Number(n));
    return isoDay(d);
  },
  daysBetween: (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000),
  formatDate: (v, f) => formatDate(v, f),
  uid: () => `${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
  // SVG arc path for rings and pies: arc(cx, cy, r, startDeg, endDeg). 0° is 12 o'clock.
  arc: (cx, cy, r, a0, a1) => {
    const [x, y, rad] = [Number(cx), Number(cy), Number(r)];
    let start = Number(a0);
    let end = Number(a1);
    if (!(end > start)) return "";
    if (end - start >= 360) end = start + 359.99;
    const pt = (deg: number) => {
      const t = ((deg - 90) * Math.PI) / 180;
      return `${round4(x + rad * Math.cos(t))} ${round4(y + rad * Math.sin(t))}`;
    };
    const large = end - start > 180 ? 1 : 0;
    return `M ${pt(start)} A ${rad} ${rad} 0 ${large} 1 ${pt(end)}`;
  },
};

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------- Public API ----------

const cache = new Map<string, Compiled>();

export function compile(src: string): Compiled {
  let fn = cache.get(src);
  if (!fn) {
    fn = new Parser(src).parse();
    cache.set(src, fn);
  }
  return fn;
}

/**
 * Templates: "Drank {{glasses}} of {{goal}}". A string that is exactly one
 * `{{expr}}` yields the raw value (number, list, bool) instead of a string.
 * Returns null if the string has no bindings.
 */
export function compileTemplate(src: string): Compiled | null {
  if (!src.includes("{{")) return null;
  const whole = /^\{\{([\s\S]*?)\}\}$/.exec(src);
  if (whole && !whole[1].includes("}}")) return compile(whole[1].trim());
  const parts: (string | Compiled)[] = [];
  let last = 0;
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    parts.push(compile(m[1].trim()));
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return (s) => parts.map((p) => (typeof p === "string" ? p : str(p(s)))).join("");
}

export function evaluate(src: string, scope: Scope): unknown {
  return compile(src)(scope);
}

// ---------- Assignment targets ----------

export type PathSeg = string | number;

/** Parses an assignment target like `form.name` or `items[index].done`. */
export function compilePath(src: string): { root: string; segs: ((s: Scope) => PathSeg)[] } {
  const p = new Parser(src);
  const first = p.next();
  if (first.t !== "id") throw new ExprError(`Bad target: ${src}`);
  const segs: ((s: Scope) => PathSeg)[] = [];
  for (;;) {
    if (p.eat(".")) {
      const t = p.next();
      if (t.t !== "id" || FORBIDDEN.has(t.v)) throw new ExprError(`Bad target: ${src}`);
      const k = t.v;
      segs.push(() => k);
    } else if (p.eat("[")) {
      const e = p.expr();
      p.expect("]");
      segs.push((s) => {
        const k = e(s);
        if (typeof k === "string" && FORBIDDEN.has(k)) throw new ExprError(`Bad target: ${src}`);
        return k as PathSeg;
      });
    } else break;
  }
  if (p.peek().t !== "eof") throw new ExprError(`Bad target: ${src}`);
  return { root: first.v, segs };
}

/** Immutable set: returns a copy of `obj` with `value` at `path`. */
export function setIn(obj: unknown, path: PathSeg[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(obj)) {
    const copy = obj.slice();
    copy[head as number] = setIn(copy[head as number], rest, value);
    return copy;
  }
  const base = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  return { ...base, [head]: setIn(base[head as string], rest, value) };
}

export function getIn(obj: unknown, path: PathSeg[]): unknown {
  let cur = obj;
  for (const k of path) cur = safeGet(cur, k);
  return cur;
}
