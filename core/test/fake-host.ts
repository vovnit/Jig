// A deterministic host for Node tests: fixed-width glyphs, greedy word wrap.
import type { Host, Op, TextMeasureStyle } from "../src/bridge.ts";
import { Runtime } from "../src/runtime.ts";
import type { AppSpec } from "../src/spec.ts";

export const CHAR = 0.5; // glyph width as a fraction of font size

export function measure(text: string, style: TextMeasureStyle, maxWidth: number) {
  const cw = style.fontSize * CHAR;
  const lines: number[] = [];
  for (const para of text.split("\n")) {
    let line = 0;
    for (const word of para.split(" ")) {
      const w = word.length * cw;
      const withSpace = line === 0 ? w : line + cw + w;
      if (line > 0 && withSpace > maxWidth) {
        lines.push(line);
        line = w;
      } else line = withSpace;
    }
    lines.push(line);
  }
  return { width: Math.min(maxWidth, Math.max(...lines)), height: lines.length * style.lineHeight };
}

export interface TestHost extends Host {
  batches: Op[][];
  store: Map<string, string>;
  pending: (() => void)[];
  measureCalls: number;
}

export function makeHost(store = new Map<string, string>()): TestHost {
  const host: TestHost = {
    batches: [],
    store,
    pending: [],
    measureCalls: 0,
    apply(ops) {
      host.batches.push(ops);
    },
    measureText(text, style, maxWidth) {
      host.measureCalls++;
      return measure(text, style, maxWidth);
    },
    requestFrame(cb) {
      host.pending.push(cb);
    },
    storage: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) },
  };
  return host;
}

/** Runs pending frames and returns the ops they produced. */
export function frame(host: TestHost): Op[] {
  const before = host.batches.length;
  while (host.pending.length) host.pending.shift()!();
  return host.batches.slice(before).flat();
}

export function boot(spec: AppSpec, store?: Map<string, string>) {
  const host = makeHost(store);
  const rt = new Runtime(host);
  rt.setViewport(390, 844);
  rt.load(spec);
  const ops = frame(host);
  return { host, rt, ops };
}

/** Finds the first node whose prop matches. */
export function findNode(rt: Runtime, pred: (props: Record<string, unknown>, type: string) => boolean) {
  for (const n of rt.nodes.values()) if (n.alive && pred(n.props, n.type)) return n;
  return undefined;
}

export const byText = (rt: Runtime, value: string) => findNode(rt, (p) => p.value === value || p.label === value);
