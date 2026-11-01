// The web host: a "dumb" DOM renderer for the shared runtime. Every view is an
// absolutely positioned element; the JS layout engine owns all geometry.

import { type Database, type Host, type Op, type Props, type Runtime, type Size, type TextMeasureStyle } from "@jig/core";
import { fileUrl } from "./files.ts";
import { RowGestures } from "./rows.ts";
import { callService } from "./services.ts";

type Style = Record<string, unknown>;

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const EASING: Record<string, string> = {
  ease: "cubic-bezier(.4,0,.2,1)",
  linear: "linear",
  easeIn: "cubic-bezier(.4,0,1,1)",
  easeOut: "cubic-bezier(0,0,.2,1)",
  spring: "cubic-bezier(.34,1.56,.64,1)",
};

export class DomHost implements Host {
  runtime!: Runtime;
  private els = new Map<number, HTMLElement>();
  private types = new Map<number, string>();
  private probe: HTMLDivElement;
  private surface: HTMLElement;
  /** Last frame of each node, for list row gestures. */
  private frames = new Map<number, [number, number, number, number]>();
  private rows: RowGestures;
  onApply?: (ops: Op[]) => void;

  constructor(surface: HTMLElement) {
    this.surface = surface;
    this.rows = new RowGestures({ dispatch: (id, name, payload) => this.runtime.dispatch(id, name, payload), frameOf: (id) => this.frames.get(id) }, surface);
    this.probe = document.createElement("div");
    this.probe.className = "jig-probe";
    document.body.appendChild(this.probe);
  }

  db?: Database;

  /**
   * Browsers have no synchronous secure storage, so the playground keeps secrets in
   * sessionStorage: they survive a reload but not closing the tab. Not encrypted.
   */
  secrets = {
    get(app: string, key: string): string | null {
      try {
        return sessionStorage.getItem(`jig-secret:${app}/${key}`);
      } catch {
        return null;
      }
    },
    set(app: string, key: string, value: string | null): void {
      if (value == null) sessionStorage.removeItem(`jig-secret:${app}/${key}`);
      else sessionStorage.setItem(`jig-secret:${app}/${key}`, value);
    },
    clear(app: string): void {
      for (const k of Object.keys(sessionStorage)) if (k.startsWith(`jig-secret:${app}/`)) sessionStorage.removeItem(k);
    },
  };

  call(service: string, args: Record<string, unknown>, done: (result: unknown, error?: string) => void, progress?: (update: Record<string, unknown>) => void): void {
    callService(service, args, done, progress);
  }

  requestFrame(cb: () => void): void {
    requestAnimationFrame(cb);
  }

  after(ms: number, cb: () => void): void {
    setTimeout(cb, ms);
  }

  now(): number {
    return performance.now();
  }

  log(level: "info" | "warn" | "error", message: string): void {
    console[level](`[jig] ${message}`);
  }

  measureText(text: string, style: TextMeasureStyle, maxWidth: number): Size {
    const p = this.probe;
    p.style.fontFamily = style.fontFamily === "mono" ? MONO : "";
    p.style.fontSize = `${style.fontSize}px`;
    p.style.fontWeight = String(style.fontWeight);
    p.style.lineHeight = `${style.lineHeight}px`;
    p.style.maxWidth = `${maxWidth}px`;
    p.textContent = "";
    if (style.spans?.length) {
      // The same attributed string the node draws: segments split at run
      // boundaries, each with its own weight and slant (colors don't measure).
      const bounds = new Set<number>([0, text.length]);
      for (const r of style.spans) {
        bounds.add(clampOffset(r.start, text.length));
        bounds.add(clampOffset(r.end, text.length));
      }
      const pts = [...bounds].sort((a, b) => a - b);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        if (b <= a) continue;
        const seg = text.slice(a, b);
        const bold = style.spans.some((r) => r.bold && r.start <= a && a < r.end);
        const italic = style.spans.some((r) => r.italic && r.start <= a && a < r.end);
        if (!bold && !italic) {
          p.appendChild(document.createTextNode(seg));
          continue;
        }
        const s = document.createElement("span");
        s.textContent = seg;
        if (bold) s.style.fontWeight = "700";
        if (italic) s.style.fontStyle = "italic";
        p.appendChild(s);
      }
    } else {
      p.textContent = text;
    }
    const r = p.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  /**
   * Intrinsic sizes of native controls. The toggle keeps the core's 51×31
   * default; slider and time picker heights come from real elements.
   */
  measureControl(type: string): Size {
    if (type === "toggle") return { width: 51, height: 31 };
    const hit = this.controlSizes.get(type);
    if (hit) return hit;
    const size = probeControl(type);
    this.controlSizes.set(type, size);
    return size;
  }

  private readonly controlSizes = new Map<string, Size>();

  apply(ops: Op[]): void {
    // A screen transition: keep a picture of the old screen to animate away from.
    const transition = ops.find((op) => op[0] === "command" && op[2] === "transition") as
      | ["command", number, string, [kind: "push" | "pop", style: string, duration: number]]
      | undefined;
    // The command names the root of the runtime that navigated: the shell, or an app inside it.
    const rootEl = transition ? this.els.get(transition[1]) : undefined;
    const snapshot = transition && rootEl ? (rootEl.cloneNode(true) as HTMLElement) : null;
    this.createdNow.clear();
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
            // Indexes count live children only: elements still fading out (and a row's swipe actions) are skipped.
            if (c === child || c.classList.contains("jig-leaving") || !(c as HTMLElement).dataset.id) continue;
            if (i++ === op[3]) {
              ref = c;
              break;
            }
          }
          if (child.parentElement !== parent || child.nextElementSibling !== ref) parent.insertBefore(child, ref);
          // An embedded app's root, drawn at the `app` node's scale.
          const scale = this.scales.get(op[1]);
          if (scale !== undefined) this.applyScale(child, scale);
          // A node with a value transition fades in when it appears in an existing list.
          const transitionMs = (this.transitions.get(op[2]) ?? 0);
          // A list row scrolling into its window (`quiet`) just appears.
          if (transitionMs && this.createdNow.has(op[2]) && !this.createdNow.has(op[1]) && !snapshot && !op[4]) {
            child.animate([{ opacity: 0 }, { opacity: getComputedStyle(child).opacity }], { duration: transitionMs, easing: EASING.ease });
          }
          break;
        }
        case "remove": {
          const child = this.els.get(op[2]);
          if (!child) break;
          const ms = this.transitions.get(op[2]) ?? 0;
          this.forget(child);
          // A node with a value transition fades out in place, above the siblings moving into its spot.
          if (ms && !snapshot && child.isConnected && !op[3]) {
            child.classList.add("jig-leaving");
            child.parentElement?.appendChild(child);
            child.animate([{ opacity: getComputedStyle(child).opacity }, { opacity: 0 }], { duration: ms, easing: EASING.ease, fill: "forwards" })
              .finished.then(() => child.remove());
          } else {
            child.remove();
          }
          break;
        }
        case "frame": {
          const el = this.els.get(op[1]);
          if (!el) break;
          const [, id, x, y, w, h] = op;
          this.frames.set(id, [x, y, w, h]);
          el.style.translate = `${x}px ${y}px`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          this.rows.framed(id);
          break;
        }
        case "command": {
          const el = this.els.get(op[1]);
          if (op[2] === "focus") (el as HTMLElement | undefined)?.focus();
          else if (op[2] === "scrollTo") {
            const [y, animated] = op[3] as [number, boolean];
            el?.scrollTo({ top: Math.max(0, y), behavior: animated ? "smooth" : "auto" });
          }
          break;
        }
      }
    }
    if (transition && snapshot && rootEl) this.animateScreens(transition[3], rootEl, snapshot);
    this.onApply?.(ops);
  }

  private readonly createdNow = new Set<number>();
  /** The page a paging hscroll should show, by node. */
  private readonly pages = new Map<number, number>();

  /** Scrolls a paging hscroll to its page. */
  private showPage(id: number, el: HTMLElement, smooth: boolean): void {
    const page = this.pages.get(id) ?? 0;
    requestAnimationFrame(() => {
      const left = page * el.clientWidth;
      if (Math.abs(el.scrollLeft - left) > 1) el.scrollTo({ left, behavior: smooth ? "smooth" : "instant" });
    });
  }

  /** Pages snap when a swipe ends (CSS scroll snapping ignores translated children), and report which one shows. */
  private pageable(id: number, el: HTMLElement): void {
    if (el.dataset.paging) return;
    el.dataset.paging = "1";
    let timer = 0;
    el.addEventListener("scroll", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const page = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
        el.scrollTo({ left: page * el.clientWidth, behavior: "smooth" });
        if (page !== this.pages.get(id)) {
          this.pages.set(id, page);
          this.runtime.dispatch(id, "page", { index: page });
        }
      }, 120);
    }, { passive: true });
  }

  /** A whiteboard zooms with a pinch or ctrl+wheel; CSS `zoom` scales its content and its scroll size together. */
  private zoomable(el: HTMLElement, content: HTMLElement): void {
    let zoom = 1;
    const set = (z: number, cx: number, cy: number) => {
      const next = Math.min(2.5, Math.max(0.3, z));
      const r = el.getBoundingClientRect();
      const px = (el.scrollLeft + cx - r.left) / zoom;
      const py = (el.scrollTop + cy - r.top) / zoom;
      zoom = next;
      content.style.zoom = String(zoom);
      el.scrollLeft = px * zoom - (cx - r.left);
      el.scrollTop = py * zoom - (cy - r.top);
    };
    el.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      set(zoom * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
    }, { passive: false });
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; zoom: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        set(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    });
    const end = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
  /** `contentScale` of `app` nodes: a whiteboard card draws its app smaller. */
  private readonly scales = new Map<number, number>();

  private applyScale(el: HTMLElement, scale: number): void {
    el.style.transformOrigin = "0 0";
    el.style.scale = scale === 1 ? "" : String(scale);
  }
  /** Value transition durations by node, for fading in new list items. */
  private readonly transitions = new Map<number, number>();

  private animateScreens([kind, style, duration]: [string, string, number], rootEl: HTMLElement, snapshot: HTMLElement): void {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const w = rootEl.offsetWidth;
    // The root is transparent outside its screen (the inset bands); while it moves, make it
    // opaque so the old screen doesn't show through.
    rootEl.style.backgroundColor = getComputedStyle(this.surface).backgroundColor;
    const done = () => {
      snapshot.remove();
      rootEl.style.backgroundColor = "";
    };
    snapshot.classList.add("jig-snapshot");
    snapshot.removeAttribute("data-id");
    for (const c of snapshot.querySelectorAll("[data-id]")) c.removeAttribute("data-id");
    const opts: KeyframeAnimationOptions = { duration, easing: "cubic-bezier(.2,.8,.2,1)" };
    if (style === "fade" || reduce) {
      rootEl.after(snapshot);
      snapshot.animate([{ opacity: 1 }, { opacity: 0 }], opts).finished.then(done);
    } else if (kind === "push") {
      // The new screen slides in from the right over the old one, which drifts left and dims.
      rootEl.before(snapshot);
      rootEl.animate([{ transform: `translateX(${w}px)` }, { transform: "none" }], opts);
      snapshot
        .animate([{ transform: "none", filter: "brightness(1)" }, { transform: `translateX(${-w * 0.3}px)`, filter: "brightness(.85)" }], opts)
        .finished.then(done);
    } else {
      rootEl.after(snapshot);
      rootEl.animate([{ transform: `translateX(${-w * 0.3}px)`, filter: "brightness(.85)" }, { transform: "none", filter: "brightness(1)" }], opts);
      snapshot.animate([{ transform: "none" }, { transform: `translateX(${w}px)` }], opts).finished.then(done);
    }
  }

  private forget(el: HTMLElement): void {
    for (const e of [el, ...el.querySelectorAll<HTMLElement>("[data-id]")]) {
      const id = Number(e.dataset.id);
      const type = this.types.get(id);
      // A removed player stops: an audio node must not keep playing off screen.
      if ((type === "video" || type === "audio") && e instanceof HTMLMediaElement) {
        e.pause();
        e.removeAttribute("src");
        e.load();
      }
      this.els.delete(id);
      this.types.delete(id);
      this.transitions.delete(id);
      this.trims.delete(id);
      this.frames.delete(id);
      this.scales.delete(id);
      this.rows.forget(id);
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
        // A multiline field wraps and grows to its frame (the runtime sizes it);
        // Return still submits. `secure` stays a single-line input.
        const area = props.multiline === true && props.secure !== true;
        const input: HTMLInputElement | HTMLTextAreaElement = area ? document.createElement("textarea") : document.createElement("input");
        if (area) {
          input.style.resize = "none";
          input.style.overflowY = "auto";
        }
        input.addEventListener("input", () => this.runtime.dispatch(id, "change", { value: input.value }));
        input.addEventListener("keydown", (e) => {
          const k = e as KeyboardEvent;
          if (k.key !== "Enter") return;
          // One paragraph: Return submits instead of inserting a newline.
          if (area && k.isComposing) return;
          if (area) e.preventDefault();
          this.runtime.dispatch(id, "submit");
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
      case "slider": {
        const input = document.createElement("input");
        input.type = "range";
        input.addEventListener("pointerdown", () => { input.dataset.dragging = "1"; });
        const release = () => { delete input.dataset.dragging; };
        input.addEventListener("pointerup", release);
        input.addEventListener("pointercancel", release);
        // `change` fires when the drag ends (and on a tap or key that moves the thumb).
        input.addEventListener("change", () => {
          release();
          this.runtime.dispatch(id, "change", { value: snapRange(input) });
        });
        el = input;
        break;
      }
      case "timePicker": {
        const input = document.createElement("input");
        input.type = "time";
        input.addEventListener("change", () => {
          // Clearing the input leaves an empty value: not a time, so stay quiet.
          if (input.value !== "") this.runtime.dispatch(id, "change", { value: input.value });
        });
        el = input;
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
      case "video": {
        const video = document.createElement("video");
        video.playsInline = true;
        video.preload = "metadata";
        video.addEventListener("ended", () => this.runtime.dispatch(id, "ended"));
        // `timeupdate` fires a few times a second; report about once a second.
        let last = 0;
        video.addEventListener("timeupdate", () => {
          const now = Date.now();
          if (now - last < 800) return;
          last = now;
          this.runtime.dispatch(id, "time", {
            position: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
          });
        });
        el = video;
        break;
      }
      case "audio": {
        const audio = document.createElement("audio");
        audio.preload = "auto";
        audio.addEventListener("ended", () => this.runtime.dispatch(id, "ended"));
        let last = 0;
        audio.addEventListener("timeupdate", () => {
          const now = Date.now();
          if (now - last < 800) return;
          last = now;
          this.runtime.dispatch(id, "time", {
            position: audio.currentTime,
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
          });
        });
        el = audio;
        break;
      }
      case "scroll":
      case "hscroll":
      case "canvas": {
        el = document.createElement("div");
        const content = document.createElement("div");
        content.className = "jig-content";
        el.appendChild(content);
        if (type === "canvas") this.zoomable(el, content);
        break;
      }
      default:
        el = document.createElement("div");
    }
    this.createdNow.add(id);
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
    if (type === "slider") {
      // Bounds first: `value` snaps against the new ones whatever order the props arrive in.
      // Always set all three (defaults 0, 1, "any") before the value: a slider created
      // with only a value must not keep the element's 0..100 defaults.
      const input = el as HTMLInputElement;
      if (props.min != null) input.min = String(props.min);
      else if ("min" in props || input.min === "") input.min = "0";
      if (props.max != null) input.max = String(props.max);
      else if ("max" in props || input.max === "") input.max = "1";
      if (props.step != null) input.step = String(props.step);
      else if ("step" in props || input.getAttribute("step") == null) input.step = "any";
    }
    for (const [k, v] of Object.entries(props)) {
      switch (k) {
        case "style":
          this.applyStyle(el, type, v as Style);
          break;
        case "value":
          if (type === "text") {
            // Spans win over the value; the spans case below renders them.
            if ("spans" in props) break;
            el.dataset.value = String(v ?? "");
            if (!el.dataset.spans) this.renderText(id, el);
          } else if (type === "textfield") {
            const input = el as HTMLInputElement | HTMLTextAreaElement;
            if (input.value !== v) input.value = String(v ?? "");
          } else if (type === "toggle") el.setAttribute("aria-checked", String(Boolean(v)));
          else if (type === "slider") {
            const input = el as HTMLInputElement;
            // A JS update waits while the user drags; the release reports the final value.
            if (input.dataset.dragging !== "1") {
              input.value = String(v ?? "");
              input.value = String(snapRange(input));
            }
          } else if (type === "timePicker") {
            const input = el as HTMLInputElement;
            if (input.value !== String(v ?? "")) input.value = String(v ?? "");
          }
          break;
        case "spans":
          if (type === "text") {
            // Kept on the element: a later `value` without spans still renders these.
            el.dataset.spans = Array.isArray(v) && v.length ? JSON.stringify(v) : "";
            this.renderText(id, el);
          }
          break;
        case "label":
          if (type === "button") el.textContent = String(v ?? "");
          else el.setAttribute("aria-label", String(v ?? ""));
          break;
        case "placeholder":
          (el as HTMLInputElement | HTMLTextAreaElement).placeholder = String(v ?? "");
          break;
        case "keyboard":
          el.setAttribute("inputmode", v === "number" ? "decimal" : "text");
          break;
        case "secure":
          // A textarea is never secure (it is only created without `secure`).
          if (el instanceof HTMLInputElement) {
            el.type = v ? "password" : "text";
            el.autocomplete = v ? "current-password" : "off";
          }
          break;
        case "tint":
          // The theme accent (CSS) shows unless a tint overrides it.
          if (type === "slider" || type === "timePicker") el.style.accentColor = v ? String(v) : "";
          break;
        case "src":
          if (type === "video" || type === "audio") setMediaSrc(el as HTMLMediaElement, v);
          else setImageSrc(el as HTMLImageElement, v);
          break;
        case "playing":
          if (type === "video" || type === "audio") setMediaPlaying(el as HTMLMediaElement, v === true);
          break;
        case "loop":
          if (type === "video" || type === "audio") (el as HTMLMediaElement).loop = v === true;
          break;
        case "muted":
          if (type === "video") (el as HTMLMediaElement).muted = v === true;
          break;
        case "volume":
          if (type === "audio") {
            const n = Number(v);
            (el as HTMLMediaElement).volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
          }
          break;
        case "controls":
          if (type === "video") (el as HTMLMediaElement).controls = v === true;
          break;
        case "fit":
          if (type === "video") el.style.objectFit = v === "cover" ? "cover" : "contain";
          break;
        case "contentSize": {
          const [w, h] = v as [number, number];
          const content = el.firstElementChild as HTMLElement;
          content.style.width = `${w}px`;
          content.style.height = `${h}px`;
          break;
        }
        case "contentScale":
          this.scales.set(id, Number(v) || 1);
          for (const c of el.children) this.applyScale(c as HTMLElement, Number(v) || 1);
          break;
        case "interactive":
          // A whiteboard card is a picture of the app: touches go to the card.
          el.style.pointerEvents = v === false ? "none" : "";
          break;
        case "selecting":
          el.dataset.selecting = v ? "1" : "";
          if (v && !el.dataset.selectHooked) {
            el.dataset.selectHooked = "1";
            // In select mode a tap picks the part of the app under it instead of using it.
            const pick = (e: Event) => {
              if (!el.dataset.selecting) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.type !== "click") return;
              const target = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
              if (target && target !== el && el.contains(target)) this.runtime.dispatch(Number(target.dataset.id), "select");
            };
            for (const type of ["click", "pointerdown", "keydown", "input"]) el.addEventListener(type, pick, true);
          }
          break;
        case "selected":
          if (v) el.dataset.selected = "1";
          else delete el.dataset.selected;
          break;
        case "paging":
          if (v && type === "hscroll") this.pageable(id, el);
          break;
        case "page":
          this.pages.set(id, Number(v) || 0);
          this.showPage(id, el, !this.createdNow.has(id));
          break;
        case "swipeActions":
          this.rows.setActions(id, el, v as { label: string; color: string }[] | null);
          break;
        case "reorder":
          this.rows.setReorder(id, el, v === true);
          break;
        case "reportScroll":
          // A long list inside needs the offset to know which rows to build.
          if (v && !el.dataset.reportsScroll) {
            el.dataset.reportsScroll = "1";
            el.addEventListener("scroll", () => this.runtime.dispatch(id, "scroll", { y: el.scrollTop }), { passive: true });
          }
          break;
        case "tappable":
          if (v && !el.dataset.tappable) {
            el.dataset.tappable = "1";
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              this.runtime.dispatch(id, "tap");
            });
          }
          break;
        case "trimStart":
        case "trimEnd":
          if (type === "shape") {
            const t = this.trims.get(id) ?? [0, 1];
            t[k === "trimStart" ? 0 : 1] = v == null ? (k === "trimStart" ? 0 : 1) : Number(v);
            this.trims.set(id, t);
            this.applyTrim(el, t);
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

  private readonly trims = new Map<number, [number, number]>();

  /**
   * A `text` node: its spans when it has any (a list of {text, bold, italic,
   * color, link}, the color already resolved by the runtime), else its value.
   * A tap on a link sends `link` {url} instead of `tap`; the runtime decides.
   */
  private renderText(id: number, el: HTMLElement): void {
    const runs = parseSpans(el.dataset.spans);
    el.textContent = "";
    if (!runs) {
      el.textContent = el.dataset.value ?? "";
      return;
    }
    for (const run of runs) {
      const s = run.link ? document.createElement("a") : document.createElement("span");
      s.textContent = run.text;
      if (run.bold) s.style.fontWeight = "700";
      if (run.italic) s.style.fontStyle = "italic";
      if (run.color) s.style.color = run.color;
      if (run.link) {
        (s as HTMLAnchorElement).href = run.link;
        s.style.textDecoration = "underline";
        s.style.cursor = "pointer";
        const url = run.link;
        s.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.runtime.dispatch(id, "link", { url });
        });
      }
      el.appendChild(s);
    }
  }

  /** Stroke trimming as in Core Animation: a dash over a path normalized to length 1. */
  private applyTrim(el: HTMLElement, [start, end]: [number, number]): void {
    const path = el.firstElementChild as SVGPathElement;
    path.setAttribute("pathLength", "1");
    const len = Math.max(0, end - start);
    path.style.strokeDasharray = `${len} 2`;
    path.style.strokeDashoffset = String(-start);
    // A zero-length dash with round caps would still draw a dot.
    path.style.strokeOpacity = len > 0.0001 ? "" : "0";
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
        // An inset outline instead of a CSS border: borders shrink the content box, which the
        // JS layout doesn't know about (native hosts draw borders inside the frame too).
        case "borderWidth": st.outlineWidth = val === "" ? "" : `${val}px`; st.outlineStyle = val === "" ? "" : "solid"; st.outlineOffset = val === "" ? "" : `-${val}px`; break;
        case "borderColor": st.outlineColor = String(val); break;
        case "opacity": st.opacity = String(val); break;
        case "clip": st.overflow = val ? "hidden" : ""; break;
        case "textAlign": st.textAlign = String(val); break;
        case "fontSize": st.fontSize = val === "" ? "" : `${val}px`; break;
        case "fontWeight": st.fontWeight = String(val); break;
        case "fontFamily": st.fontFamily = val === "mono" ? MONO : ""; break;
        case "lineHeight": st.lineHeight = val === "" ? "" : `${val}px`; break;
        case "padding": st.padding = Array.isArray(val) ? val.map((p) => `${p}px`).join(" ") : ""; break;
        case "transition": {
          const t = val === "" ? null : (val as { duration: number; easing: string });
          const id = Number(el.dataset.id);
          if (t) this.transitions.set(id, t.duration);
          else this.transitions.delete(id);
          const timing = t ? ` ${t.duration}ms ${EASING[t.easing] ?? EASING.ease}` : "";
          st.transition = t
            ? ["translate", "width", "height", "background-color", "opacity", "color", "border-radius", "outline-color"].map((p) => p + timing).join(", ")
            : "";
          if (type === "shape") {
            (el.firstElementChild as SVGPathElement).style.transition = t
              ? ["stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "fill", "stroke"].map((p) => p + timing).join(", ")
              : "";
          }
          break;
        }
        case "shadow": st.boxShadow = val === "" || val === false ? "" : "0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08)"; break;
      }
    }
  }
}

/** A `text` node's spans from the element: null without any (the value shows). */
function parseSpans(raw: string | undefined): { text: string; bold?: boolean; italic?: boolean; color?: string; link?: string }[] | null {
  if (!raw) return null;
  try {
    const runs = JSON.parse(raw) as unknown;
    if (!Array.isArray(runs) || !runs.length) return null;
    return runs.flatMap((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return [];
      const run = r as { text?: unknown; bold?: unknown; italic?: unknown; color?: unknown; link?: unknown };
      const text = typeof run.text === "string" ? run.text : String(run.text ?? "");
      if (!text) return [];
      const out: { text: string; bold?: boolean; italic?: boolean; color?: string; link?: string } = { text };
      if (run.bold === true) out.bold = true;
      if (run.italic === true) out.italic = true;
      if (typeof run.color === "string" && run.color) out.color = run.color;
      if (typeof run.link === "string" && run.link) out.link = run.link;
      return [out];
    });
  } catch {
    return null;
  }
}

/** A span offset clamped into the text, so a malformed range measures nothing. */
function clampOffset(n: unknown, length: number): number {
  const v = typeof n === "number" ? n : 0;
  return Number.isFinite(v) ? Math.min(length, Math.max(0, Math.floor(v))) : 0;
}

/** A range input's value clamped into [min, max] and snapped onto its step. */
function snapRange(input: HTMLInputElement): number {
  const min = input.min === "" ? 0 : Number(input.min);
  const max = input.max === "" ? 1 : Number(input.max);
  const raw = input.valueAsNumber;
  const v = Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min));
  const step = input.step === "" || input.step === "any" ? NaN : Number(input.step);
  if (!Number.isFinite(step) || step <= 0) return v;
  const snapped = min + Math.round((v - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/** Measures a real control off screen for `measureControl`. Unknown types measure nothing. */
function probeControl(type: string): Size {
  const input = document.createElement("input");
  if (type === "slider") input.type = "range";
  else if (type === "timePicker") input.type = "time";
  else return { width: 0, height: 0 };
  // The same classes the rendered control gets, so the measured size matches what is drawn.
  input.className = `jig jig-${type}`;
  input.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;";
  document.body.appendChild(input);
  const r = input.getBoundingClientRect();
  input.remove();
  return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

/** A bundled sound (`@chime`) lives at /sounds/<name>.wav (vite.config.ts serves the repo's assets folder). */
function mediaUrl(src: string): string {
  return src.startsWith("@") ? `/sounds/${src.slice(1)}.wav` : src;
}

/** An image from an https or data URL, or a `jig-file:` URL resolved from the app's store. */
function setImageSrc(img: HTMLImageElement, src: unknown): void {
  const raw = String(src ?? "");
  if (raw.startsWith("jig-file:")) {
    img.dataset.jigSrc = raw;
    void fileUrl(raw).then(
      (url) => {
        if (img.dataset.jigSrc !== raw) return;
        img.src = url;
      },
      () => {
        if (img.dataset.jigSrc === raw) img.removeAttribute("src");
      },
    );
    return;
  }
  delete img.dataset.jigSrc;
  img.src = raw;
}

function setMediaSrc(media: HTMLMediaElement, src: unknown): void {
  const raw = String(src ?? "");
  if (raw.startsWith("jig-file:")) {
    // Like images: resolve the store file to an object URL, ignoring a source
    // that changed while it loaded.
    media.dataset.jigSrc = raw;
    void fileUrl(raw).then(
      (url) => {
        if (media.dataset.jigSrc !== raw) return;
        delete media.dataset.jigSrc;
        setMediaUrl(media, url);
      },
      () => {
        if (media.dataset.jigSrc === raw) delete media.dataset.jigSrc;
      },
    );
    return;
  }
  delete media.dataset.jigSrc;
  setMediaUrl(media, mediaUrl(raw));
}

function setMediaUrl(media: HTMLMediaElement, url: string): void {
  const current = media.dataset.src;
  if (current === url) return;
  media.dataset.src = url;
  media.src = url;
  media.load();
  // `playing` may have arrived before `src`: start when the node wants to play.
  if (media.dataset.playing === "1") void setMediaPlaying(media, true);
}

/**
 * Browsers block playback until the user has tapped the page: when `play()` is
 * refused, try again on the next tap instead of staying silent.
 */
function setMediaPlaying(media: HTMLMediaElement, playing: boolean): void {
  media.dataset.playing = playing ? "1" : "0";
  if (!playing) {
    media.pause();
    return;
  }
  if (!media.dataset.src && media.src) media.dataset.src = media.src;
  const attempt = media.play();
  if (attempt && typeof attempt.catch === "function") {
    attempt.catch(() => {
      if (media.dataset.retry) return;
      media.dataset.retry = "1";
      const retry = () => {
        delete media.dataset.retry;
        // The tap may have come from another control; only resume a node that still wants to play.
        if (media.isConnected && media.dataset.playing !== "0") {
          const next = media.play();
          if (next && typeof next.catch === "function") next.catch(() => {});
        }
      };
      window.addEventListener("pointerdown", retry, { once: true, capture: true });
    });
  }
}
