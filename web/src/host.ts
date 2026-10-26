// The web host: a "dumb" DOM renderer for the shared runtime. Every view is an
// absolutely positioned element; the JS layout engine owns all geometry.

import { FONT_FAMILY, type Host, type Op, type Props, type Runtime, type Size, type TextMeasureStyle } from "@jig/core";

type Style = Record<string, unknown>;

export class DomHost implements Host {
  runtime!: Runtime;
  private els = new Map<number, HTMLElement>();
  private types = new Map<number, string>();
  private probe: HTMLDivElement;
  private surface: HTMLElement;
  onApply?: (ops: Op[]) => void;

  constructor(surface: HTMLElement) {
    this.surface = surface;
    this.probe = document.createElement("div");
    this.probe.className = "jig-probe";
    document.body.appendChild(this.probe);
  }

  storage = {
    get(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Storage can be unavailable (private mode); data then lives for the session only.
      }
    },
  };

  requestFrame(cb: () => void): void {
    requestAnimationFrame(cb);
  }

  now(): number {
    return performance.now();
  }

  log(level: "info" | "warn" | "error", message: string): void {
    console[level](`[jig] ${message}`);
  }

  measureText(text: string, style: TextMeasureStyle, maxWidth: number): Size {
    const p = this.probe;
    p.style.fontSize = `${style.fontSize}px`;
    p.style.fontWeight = String(style.fontWeight);
    p.style.lineHeight = `${style.lineHeight}px`;
    p.style.maxWidth = `${maxWidth}px`;
    p.textContent = text;
    const r = p.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  apply(ops: Op[]): void {
    for (const op of ops) {
      switch (op[0]) {
        case "create":
          this.create(op[1], op[2], op[3]);
          break;
        case "update":
          this.update(op[1], op[2]);
          break;
        case "insert": {
          const parent = this.container(op[1]);
          const child = this.els.get(op[2]);
          if (!parent || !child) break;
          // Index is the child's position after the move, so skip the child itself when finding the anchor.
          let ref: Element | null = null;
          let i = 0;
          for (const c of parent.children) {
            if (c === child) continue;
            if (i++ === op[3]) {
              ref = c;
              break;
            }
          }
          if (child.parentElement !== parent || child.nextElementSibling !== ref) parent.insertBefore(child, ref);
          break;
        }
        case "remove": {
          const child = this.els.get(op[2]);
          child?.remove();
          if (child) this.forget(child);
          break;
        }
        case "frame": {
          const el = this.els.get(op[1]);
          if (!el) break;
          const [, , x, y, w, h] = op;
          el.style.translate = `${x}px ${y}px`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          break;
        }
        case "command": {
          const el = this.els.get(op[1]);
          if (op[2] === "focus") (el as HTMLInputElement | undefined)?.focus();
          break;
        }
      }
    }
    this.onApply?.(ops);
  }

  private forget(el: HTMLElement): void {
    const id = Number(el.dataset.id);
    this.els.delete(id);
    this.types.delete(id);
    for (const c of el.querySelectorAll<HTMLElement>("[data-id]")) {
      const cid = Number(c.dataset.id);
      this.els.delete(cid);
      this.types.delete(cid);
    }
  }

  /** Scroll views position children inside a content element sized to the content. */
  private container(id: number): HTMLElement | undefined {
    const el = this.els.get(id);
    if (!el) return undefined;
    return (el.firstElementChild as HTMLElement | null)?.classList.contains("jig-content") ? (el.firstElementChild as HTMLElement) : el;
  }

  private create(id: number, type: string, props: Props): void {
    let el: HTMLElement;
    switch (type) {
      case "button": {
        el = document.createElement("button");
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.runtime.dispatch(id, "tap");
        });
        break;
      }
      case "textfield": {
        const input = document.createElement("input");
        input.addEventListener("input", () => this.runtime.dispatch(id, "change", { value: input.value }));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.runtime.dispatch(id, "submit");
        });
        el = input;
        break;
      }
      case "toggle": {
        el = document.createElement("button");
        el.setAttribute("role", "switch");
        el.innerHTML = '<span class="jig-knob"></span>';
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          // Native is the source of truth for the control's state.
          const next = el.getAttribute("aria-checked") !== "true";
          el.setAttribute("aria-checked", String(next));
          this.runtime.dispatch(id, "change", { value: next });
        });
        break;
      }
      case "shape": {
        el = document.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as HTMLElement;
        el.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
        break;
      }
      case "image": {
        const img = document.createElement("img");
        img.addEventListener("load", () => this.runtime.dispatch(id, "load", { width: img.naturalWidth, height: img.naturalHeight }));
        el = img;
        break;
      }
      case "scroll":
      case "hscroll": {
        el = document.createElement("div");
        const content = document.createElement("div");
        content.className = "jig-content";
        el.appendChild(content);
        break;
      }
      default:
        el = document.createElement("div");
    }
    el.classList.add("jig", `jig-${type}`);
    el.dataset.id = String(id);
    this.els.set(id, el);
    this.types.set(id, type);
    if (type === "root") this.surface.replaceChildren(el);
    this.update(id, props);
  }

  private update(id: number, props: Props): void {
    const el = this.els.get(id);
    const type = this.types.get(id);
    if (!el || !type) return;
    for (const [k, v] of Object.entries(props)) {
      switch (k) {
        case "style":
          this.applyStyle(el, type, v as Style);
          break;
        case "value":
          if (type === "text") el.textContent = String(v ?? "");
          else if (type === "textfield") {
            const input = el as HTMLInputElement;
            if (input.value !== v) input.value = String(v ?? "");
          } else if (type === "toggle") el.setAttribute("aria-checked", String(Boolean(v)));
          break;
        case "label":
          if (type === "button") el.textContent = String(v ?? "");
          else el.setAttribute("aria-label", String(v ?? ""));
          break;
        case "placeholder":
          (el as HTMLInputElement).placeholder = String(v ?? "");
          break;
        case "keyboard":
          el.setAttribute("inputmode", v === "number" ? "decimal" : "text");
          break;
        case "src":
          (el as HTMLImageElement).src = String(v ?? "");
          break;
        case "contentSize": {
          const [w, h] = v as [number, number];
          const content = el.firstElementChild as HTMLElement;
          content.style.width = `${w}px`;
          content.style.height = `${h}px`;
          break;
        }
        case "tappable":
          if (v && !el.dataset.tappable) {
            el.dataset.tappable = "1";
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              this.runtime.dispatch(id, "tap");
            });
          }
          break;
        case "path":
        case "fill":
        case "stroke":
        case "strokeWidth":
        case "lineCap":
        case "viewBox":
          if (type === "shape") this.applyShape(el, k, v);
          break;
      }
    }
  }

  private applyShape(el: HTMLElement, k: string, v: unknown): void {
    const path = el.firstElementChild as SVGPathElement;
    const val = v == null ? "" : String(v);
    switch (k) {
      case "viewBox": el.setAttribute("viewBox", val); break;
      case "path": path.setAttribute("d", val); break;
      case "fill": path.setAttribute("fill", val || "currentColor"); break;
      case "stroke": path.setAttribute("stroke", val || "none"); break;
      case "strokeWidth": path.setAttribute("stroke-width", val); break;
      case "lineCap": path.setAttribute("stroke-linecap", val); break;
    }
  }

  private applyStyle(el: HTMLElement, type: string, s: Style): void {
    const st = el.style;
    for (const [k, v] of Object.entries(s)) {
      const val = v == null ? "" : v;
      switch (k) {
        case "background": st.background = String(val); break;
        case "color": st.color = String(val); break;
        case "radius": st.borderRadius = val === "" ? "" : `${val}px`; if (type !== "text" && type !== "textfield") st.overflow = val === "" ? "" : "hidden"; break;
        case "borderWidth": st.borderWidth = val === "" ? "" : `${val}px`; st.borderStyle = val === "" ? "" : "solid"; break;
        case "borderColor": st.borderColor = String(val); break;
        case "opacity": st.opacity = String(val); break;
        case "textAlign": st.textAlign = String(val); break;
        case "fontSize": st.fontSize = val === "" ? "" : `${val}px`; break;
        case "fontWeight": st.fontWeight = String(val); break;
        case "lineHeight": st.lineHeight = val === "" ? "" : `${val}px`; break;
        case "padding": st.padding = Array.isArray(val) ? val.map((p) => `${p}px`).join(" ") : ""; break;
        case "shadow": st.boxShadow = val === "" || val === false ? "" : "0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08)"; break;
      }
    }
  }
}

export const FONT = FONT_FAMILY;
