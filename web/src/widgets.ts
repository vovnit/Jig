// The web has no home-screen widgets, so the playground previews them beside the
// phone: every `widgets.set` is stored here and drawn from its static tree.
import { WIDGET_SIZES, type WidgetNode, type WidgetUpdate } from "@jig/core";

const store = new Map<string, { appName: string; widgets: WidgetUpdate[] }>();
let scheme: "light" | "dark" = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let sizeFilter: "all" | keyof typeof WIDGET_SIZES = "all";

/** Stores a `widgets.set` payload (`widgets: []` clears the app) and redraws. */
export function setWidgets(app: string, appName: string, widgets: WidgetUpdate[]): void {
  if (!widgets.length) store.delete(app);
  else store.set(app, { appName, widgets });
  render();
}

function controls(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#widget-controls");
}

function list(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#widgets");
}

function render(): void {
  const root = list();
  if (!root) return;
  ensureControls();
  root.replaceChildren();
  const names = [...store.values()].flatMap((a) => a.widgets.map((w) => ({ appName: a.appName, w })));
  const shown = names.filter(({ w }) => sizeFilter === "all" || w.size === sizeFilter);
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = store.size
      ? "No widgets in this size. Pick another size above."
      : "No widgets yet. Add a widgets section to an app spec.";
    root.appendChild(empty);
    return;
  }
  for (const { appName, w } of shown) {
    const dims = WIDGET_SIZES[w.size];
    const entry = pickEntry(w.entries);
    const tree = scheme === "light" ? entry.light : entry.dark;
    const card = document.createElement("div");
    card.className = "jig-widget";
    const head = document.createElement("div");
    head.className = "jig-widget-head";
    head.textContent = `${appName}: ${w.title} · ${w.size} · as of ${time(entry.date)}`;
    const preview = document.createElement("div");
    preview.className = "jig-widget-preview";
    preview.style.width = `${dims.width}px`;
    preview.style.height = `${dims.height}px`;
    preview.dataset.scheme = scheme;
    draw(tree, preview, { x: 0, y: 0, width: dims.width, height: dims.height });
    card.append(head, preview);
    root.appendChild(card);
  }
}

function pickEntry(entries: WidgetUpdate["entries"]): WidgetUpdate["entries"][number] {
  const now = Date.now();
  let best = entries[0];
  for (const e of entries) if (e.date <= now) best = e;
  return best;
}

function time(date: number): string {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ensureControls(): void {
  const root = controls();
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  const mk = (label: string, active: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.classList.toggle("active", active);
    b.onclick = () => {
      onClick();
      for (const x of root.querySelectorAll("button")) x.classList.remove("active");
      b.classList.add("active");
      render();
    };
    root.appendChild(b);
    return b;
  };
  mk("Light", scheme === "light", () => void (scheme = "light"));
  mk("Dark", scheme === "dark", () => void (scheme = "dark"));
  const sep = document.createElement("span");
  sep.className = "jig-widget-sep";
  root.appendChild(sep);
  const sizes = ["all", "small", "medium", "large"] as const;
  for (const s of sizes) mk(s[0].toUpperCase() + s.slice(1), sizeFilter === s, () => void (sizeFilter = s));
  // Re-render previews as time moves through a timeline (once a minute is enough).
  window.setInterval(render, 60000);
}

function draw(node: WidgetNode, into: HTMLElement, parent: { x: number; y: number; width: number; height: number }): void {
  const f = node.frame;
  if (node.kind === "text") {
    const el = document.createElement("div");
    el.className = "jig-wtext";
    el.textContent = node.text;
    el.style.left = `${f.x - parent.x}px`;
    el.style.top = `${f.y - parent.y}px`;
    el.style.width = `${f.width}px`;
    el.style.height = `${f.height}px`;
    el.style.fontSize = `${node.fontSize}px`;
    el.style.fontWeight = String(node.fontWeight);
    el.style.lineHeight = `${node.lineHeight}px`;
    el.style.color = node.color;
    el.style.textAlign = node.align as CanvasTextAlign;
    if (node.fontFamily === "mono") el.style.fontFamily = 'ui-monospace, Menlo, monospace';
    into.appendChild(el);
    return;
  }
  if (node.kind === "shape") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", node.viewBox);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", node.path);
    path.setAttribute("fill", node.fill ?? "none");
    path.setAttribute("stroke", node.stroke ?? "none");
    if (node.strokeWidth !== undefined) path.setAttribute("stroke-width", String(node.strokeWidth));
    const start = node.trimStart ?? 0;
    const end = node.trimEnd ?? 1;
    if (start !== 0 || end !== 1) {
      path.setAttribute("pathLength", "1");
      path.style.strokeDasharray = `${Math.max(0, end - start)} 2`;
      path.style.strokeDashoffset = String(-start);
      if (end - start <= 0.0001) path.style.strokeOpacity = "0";
    }
    svg.appendChild(path);
    const el = svg as unknown as HTMLElement;
    // An SVG element's className is read-only.
    svg.setAttribute("class", "jig-wshape");
    el.style.left = `${f.x - parent.x}px`;
    el.style.top = `${f.y - parent.y}px`;
    el.style.width = `${f.width}px`;
    el.style.height = `${f.height}px`;
    into.appendChild(el);
    return;
  }
  if (node.kind === "image") {
    const img = document.createElement("img");
    img.className = "jig-wimage";
    img.src = node.src;
    img.style.left = `${f.x - parent.x}px`;
    img.style.top = `${f.y - parent.y}px`;
    img.style.width = `${f.width}px`;
    img.style.height = `${f.height}px`;
    into.appendChild(img);
    return;
  }
  const el = document.createElement("div");
  el.className = "jig-wbox";
  el.style.left = `${f.x - parent.x}px`;
  el.style.top = `${f.y - parent.y}px`;
  el.style.width = `${f.width}px`;
  el.style.height = `${f.height}px`;
  if (node.background) el.style.background = node.background;
  if (node.radius !== undefined) el.style.borderRadius = `${node.radius}px`;
  if (node.borderWidth !== undefined) {
    el.style.border = `${node.borderWidth}px solid ${node.borderColor ?? "transparent"}`;
  }
  if (node.opacity !== undefined) el.style.opacity = String(node.opacity);
  into.appendChild(el);
  for (const c of node.children) draw(c, el, f);
}
