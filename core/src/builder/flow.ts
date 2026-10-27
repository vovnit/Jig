// The whiteboard: an app's screens as cards, one column per navigation step from the start
// screen, with arrows for every `navigate` between them. A pure function of the spec, so
// the shell spec binds it directly: `flow(app.spec)`.
import type { AppSpec } from "../spec.ts";

export const CARD = { width: 156, height: 338, label: 24, gapX: 96, gapY: 56, pad: 40 };

export interface FlowCard {
  screen: string;
  title: string;
  x: number;
  y: number;
}

export interface Flow {
  cards: FlowCard[];
  /** SVG path data of all arrows, in whiteboard coordinates. */
  arrows: string;
  width: number;
  height: number;
}

/** Every screen each screen can navigate to. */
export function screenLinks(spec: AppSpec): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const visit = (v: unknown, from: string): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, from));
    const o = v as Record<string, unknown>;
    if (typeof o.navigate === "string" && spec.screens[o.navigate] && o.navigate !== from) links.get(from)!.add(o.navigate);
    for (const x of Object.values(o)) visit(x, from);
  };
  for (const [name, screen] of Object.entries(spec.screens ?? {})) {
    links.set(name, new Set());
    visit(screen, name);
  }
  return links;
}

export function flow(spec: unknown): Flow {
  const s = spec as AppSpec;
  if (!s?.screens) return { cards: [], arrows: "", width: 0, height: 0 };
  const names = Object.keys(s.screens);
  const links = screenLinks(s);
  const start = s.start && s.screens[s.start] ? s.start : names[0];
  // Breadth-first from the start; screens nothing leads to go in a last column.
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const from = queue.shift()!;
    for (const to of links.get(from) ?? []) {
      if (!depth.has(to)) {
        depth.set(to, depth.get(from)! + 1);
        queue.push(to);
      }
    }
  }
  const last = Math.max(0, ...depth.values()) + 1;
  for (const n of names) if (!depth.has(n)) depth.set(n, last);

  const rows = new Map<number, number>();
  const { width: W, height: H, label: L, gapX, gapY, pad } = CARD;
  const cards: FlowCard[] = names.map((screen) => {
    const col = depth.get(screen)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const title = s.screens[screen].title;
    return { screen, title: title && !title.includes("{{") ? title : screen, x: pad + col * (W + gapX), y: pad + row * (L + H + gapY) };
  });
  const at = new Map(cards.map((c) => [c.screen, c]));
  const r = (v: number) => Math.round(v);

  const paths: string[] = [];
  for (const [from, tos] of links) {
    const a = at.get(from)!;
    for (const to of tos) {
      const b = at.get(to)!;
      if (b.x > a.x) {
        // Forward: from the right edge of one card to the left edge of the next.
        const x1 = a.x + W;
        const y1 = a.y + L + H / 2;
        const x2 = b.x;
        const y2 = b.y + L + H / 2;
        const dx = (x2 - x1) / 2;
        paths.push(`M${r(x1)} ${r(y1)}C${r(x1 + dx)} ${r(y1)} ${r(x2 - dx)} ${r(y2)} ${r(x2)} ${r(y2)}`);
        paths.push(`M${r(x2 - 9)} ${r(y2 - 6)}L${r(x2)} ${r(y2)}L${r(x2 - 9)} ${r(y2 + 6)}`);
      } else {
        // Back (or within a column): under the cards, from one bottom edge to the other.
        const x1 = a.x + W / 2;
        const y1 = a.y + L + H;
        const x2 = b.x + W / 2 + (b === a ? 0 : 12);
        const y2 = b.y + L + H;
        const drop = gapY * 0.8;
        paths.push(`M${r(x1)} ${r(y1)}C${r(x1)} ${r(y1 + drop)} ${r(x2)} ${r(y2 + drop)} ${r(x2)} ${r(y2)}`);
        paths.push(`M${r(x2 - 6)} ${r(y2 + 9)}L${r(x2)} ${r(y2)}L${r(x2 + 6)} ${r(y2 + 9)}`);
      }
    }
  }
  const width = Math.max(...cards.map((c) => c.x + W)) + pad;
  const height = Math.max(...cards.map((c) => c.y + L + H)) + pad + gapY;
  return { cards, arrows: paths.join(""), width, height };
}
