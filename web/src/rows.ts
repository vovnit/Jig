// List row gestures on the web: swipe a row left to reveal its actions, long-press it
// to drag and reorder. The runtime owns the order: a dragged row reports each
// neighbour it passes ("move"), the runtime reorders the items and sends new frames,
// and the row stays under the pointer meanwhile while its siblings animate.

type SwipeAction = { label: string; color: string };
type Frame = [x: number, y: number, w: number, h: number];

export interface RowHost {
  dispatch(id: number, name: string, payload?: Record<string, unknown>): void;
  frameOf(id: number): Frame | undefined;
}

const LONG_PRESS_MS = 450;
const SLOP = 8;
const EASE = "cubic-bezier(.2,.8,.2,1)";

interface Press {
  id: number;
  el: HTMLElement;
  pointerId: number;
  x0: number;
  y0: number;
  y: number;
  timer: number;
}

interface Swipe {
  id: number;
  el: HTMLElement;
  panel: HTMLElement;
  pointerId: number;
  x0: number;
  base: number;
  tx: number;
}

interface Drag {
  id: number;
  el: HTMLElement;
  pointerId: number;
  y0: number;
  y: number;
  home0: number;
  scroller: HTMLElement | null;
  scroll0: number;
  transition: string;
  /** A move was reported; wait for the runtime's new frame before reporting the next. */
  pending: number;
  raf: number;
}

export class RowGestures {
  private actions = new Map<number, SwipeAction[]>();
  private reorderable = new Set<number>();
  private attached = new WeakSet<HTMLElement>();
  private press: Press | null = null;
  private swipe: Swipe | null = null;
  private drag: Drag | null = null;
  private open: { id: number; el: HTMLElement; panel: HTMLElement; width: number } | null = null;
  private suppressClick = false;

  private host: RowHost;

  constructor(host: RowHost, surface: HTMLElement) {
    this.host = host;
    // A swipe or a drag ends with a click on the row; it isn't a tap.
    surface.addEventListener(
      "click",
      (e) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    // Touching anything else closes an open row.
    surface.addEventListener(
      "pointerdown",
      (e) => {
        const open = this.open;
        if (open && !open.el.contains(e.target as Node) && !open.panel.contains(e.target as Node)) this.close();
      },
      true,
    );
    surface.addEventListener("scroll", () => this.close(), true);
    window.addEventListener("pointermove", (e) => this.move(e));
    window.addEventListener("pointerup", (e) => this.up(e));
    window.addEventListener("pointercancel", (e) => this.up(e, true));
  }

  setActions(id: number, el: HTMLElement, actions: SwipeAction[] | null): void {
    if (actions?.length) this.actions.set(id, actions);
    else this.actions.delete(id);
    this.attach(id, el);
  }

  setReorder(id: number, el: HTMLElement, on: boolean): void {
    if (on) this.reorderable.add(id);
    else this.reorderable.delete(id);
    this.attach(id, el);
  }

  isDragging(id: number): boolean {
    return this.drag?.id === id;
  }

  /** The runtime moved a row: keep a dragged row under the pointer, and an open row's actions beside it. */
  framed(id: number): void {
    if (this.drag?.id === id) {
      this.drag.pending = 0;
      this.positionDrag();
    }
    if (this.open?.id === id) this.placePanel(this.open.panel, id);
  }

  forget(id: number): void {
    this.actions.delete(id);
    this.reorderable.delete(id);
    if (this.open?.id === id) {
      this.open.panel.remove();
      this.open = null;
    }
    if (this.drag?.id === id) {
      cancelAnimationFrame(this.drag.raf);
      this.drag = null;
    }
    if (this.press?.id === id) this.cancelPress();
  }

  private attach(id: number, el: HTMLElement): void {
    if (this.attached.has(el)) return;
    this.attached.add(el);
    // Vertical panning stays the browser's; horizontal moves and drags are ours.
    el.style.touchAction = "pan-y";
    el.addEventListener("pointerdown", (e) => this.down(e, id, el));
    el.addEventListener("touchmove", (e) => this.drag?.id === id && e.preventDefault(), { passive: false });
    el.addEventListener("contextmenu", (e) => this.reorderable.has(id) && e.preventDefault());
  }

  // ---------- Pointer ----------

  private down(e: PointerEvent, id: number, el: HTMLElement): void {
    if (e.button !== 0 || this.press || this.drag || this.swipe) return;
    if ((e.target as HTMLElement).closest("input, .jig-toggle")) return;
    // The innermost row wins (a list inside a row).
    e.stopPropagation();
    const press: Press = { id, el, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, timer: 0 };
    if (this.reorderable.has(id)) press.timer = window.setTimeout(() => this.beginDrag(), LONG_PRESS_MS);
    this.press = press;
  }

  private move(e: PointerEvent): void {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      this.drag.y = e.clientY;
      this.positionDrag();
      return;
    }
    if (this.swipe && e.pointerId === this.swipe.pointerId) {
      this.moveSwipe(e.clientX);
      return;
    }
    const p = this.press;
    if (!p || e.pointerId !== p.pointerId) return;
    p.y = e.clientY;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) && this.actions.has(p.id)) this.beginSwipe(e);
    else if (Math.hypot(dx, dy) > SLOP) this.cancelPress();
  }

  private up(e: PointerEvent, cancelled = false): void {
    if (this.drag && e.pointerId === this.drag.pointerId) this.endDrag();
    else if (this.swipe && e.pointerId === this.swipe.pointerId) this.endSwipe(cancelled);
    else if (this.press && e.pointerId === this.press.pointerId) this.cancelPress();
  }

  private cancelPress(): void {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  // ---------- Swipe ----------

  private beginSwipe(e: PointerEvent): void {
    const p = this.press!;
    this.cancelPress();
    const open = this.open?.id === p.id ? this.open : null;
    if (this.open && !open) this.close();
    const panel = open?.panel ?? this.makePanel(p.id, p.el);
    this.open = null;
    capture(p.el, e.pointerId);
    const base = open ? -open.width : 0;
    this.swipe = { id: p.id, el: p.el, panel, pointerId: e.pointerId, x0: p.x0, base, tx: base };
    this.moveSwipe(e.clientX);
  }

  private moveSwipe(x: number): void {
    const s = this.swipe!;
    const width = s.el.offsetWidth;
    let tx = s.base + x - s.x0;
    // Rubber band past the edges.
    if (tx > 0) tx = tx / 4;
    if (tx < -width) tx = -width - (-width - tx) / 4;
    s.tx = tx;
    s.el.style.transform = `translateX(${tx}px)`;
  }

  private endSwipe(cancelled: boolean): void {
    const s = this.swipe!;
    this.swipe = null;
    this.suppressClick = true;
    const width = s.el.offsetWidth;
    const panelWidth = [...s.panel.children].reduce((w, b) => w + (b as HTMLElement).offsetWidth, 0);
    if (!cancelled && s.tx < -width * 0.6) {
      // A full swipe runs the first action.
      this.slide(s.el, s.tx, -width).then(() => {
        s.panel.remove();
        this.host.dispatch(s.id, "swipe", { index: 0 });
        s.el.style.transform = "";
      });
    } else if (!cancelled && s.tx < -panelWidth / 2) {
      this.open = { id: s.id, el: s.el, panel: s.panel, width: panelWidth };
      this.slide(s.el, s.tx, -panelWidth);
    } else {
      this.slide(s.el, s.tx, 0).then(() => s.panel.remove());
    }
  }

  private close(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    this.slide(open.el, -open.width, 0).then(() => open.panel.remove());
  }

  private slide(el: HTMLElement, from: number, to: number): Promise<void> {
    el.style.transform = to ? `translateX(${to}px)` : "";
    return el
      .animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration: 220, easing: EASE })
      .finished.then(() => undefined, () => undefined);
  }

  /** The actions sit behind the row, right-aligned, and show as the row slides away. */
  private makePanel(id: number, el: HTMLElement): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "jig-swipe-actions";
    (this.actions.get(id) ?? []).forEach((a, index) => {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.style.background = a.color;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.host.dispatch(id, "swipe", { index });
        this.close();
      });
      panel.appendChild(b);
    });
    el.before(panel);
    this.placePanel(panel, id);
    return panel;
  }

  private placePanel(panel: HTMLElement, id: number): void {
    const f = this.host.frameOf(id);
    if (!f) return;
    panel.style.translate = `${f[0]}px ${f[1]}px`;
    panel.style.width = `${f[2]}px`;
    panel.style.height = `${f[3]}px`;
  }

  // ---------- Drag ----------

  private beginDrag(): void {
    const p = this.press;
    const f = p && this.host.frameOf(p.id);
    if (!p || !f) return;
    this.press = null;
    this.close();
    const scroller = p.el.closest<HTMLElement>(".jig-scroll");
    const drag: Drag = {
      id: p.id, el: p.el, pointerId: p.pointerId,
      y0: p.y, y: p.y, home0: f[1],
      scroller, scroll0: scroller?.scrollTop ?? 0,
      transition: p.el.style.transition,
      pending: 0, raf: 0,
    };
    this.drag = drag;
    this.suppressClick = true;
    capture(p.el, p.pointerId);
    // The row follows the pointer exactly: no transition on its own frame while dragged.
    p.el.style.transition = "none";
    p.el.classList.add("jig-dragging");
    navigator.vibrate?.(10);
    this.positionDrag();
    const tick = () => {
      if (this.drag !== drag) return;
      this.autoscroll();
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  }

  private positionDrag(): void {
    const d = this.drag;
    const f = d && this.host.frameOf(d.id);
    if (!d || !f) return;
    const parentHeight = d.el.parentElement?.offsetHeight ?? Infinity;
    const scrolled = (d.scroller?.scrollTop ?? 0) - d.scroll0;
    // Half a row of travel past either end, so the row can pass the middle of the last one.
    const y = Math.max(-f[3] / 2, Math.min(parentHeight - f[3] / 2, d.home0 + d.y - d.y0 + scrolled));
    d.el.style.transform = `translateY(${y - f[1]}px) scale(1.02)`;
    if (d.pending && performance.now() - d.pending < 500) return;
    // Report passing the middle of the neighbour above or below.
    const center = y + f[3] / 2;
    let above: Frame | undefined;
    let below: Frame | undefined;
    for (const c of d.el.parentElement?.children ?? []) {
      const id = Number((c as HTMLElement).dataset.id);
      if (!id || id === d.id || c.classList.contains("jig-leaving")) continue;
      const g = this.host.frameOf(id);
      if (!g) continue;
      if (g[1] < f[1] && (!above || g[1] > above[1])) above = g;
      if (g[1] > f[1] && (!below || g[1] < below[1])) below = g;
    }
    if (below && center > below[1] + below[3] / 2) this.reportMove(d, 1);
    else if (above && center < above[1] + above[3] / 2) this.reportMove(d, -1);
  }

  private reportMove(d: Drag, by: number): void {
    d.pending = performance.now();
    this.host.dispatch(d.id, "move", { by });
  }

  /** Near the top or bottom edge of the scroll view, scroll it so the row can travel further. */
  private autoscroll(): void {
    const d = this.drag;
    if (!d?.scroller) return;
    const r = d.scroller.getBoundingClientRect();
    const edge = 60;
    const speed = d.y < r.top + edge ? -(r.top + edge - d.y) / 4 : d.y > r.bottom - edge ? (d.y - (r.bottom - edge)) / 4 : 0;
    if (!speed) return;
    d.scroller.scrollTop += speed;
    this.positionDrag();
  }

  private endDrag(): void {
    const d = this.drag!;
    this.drag = null;
    cancelAnimationFrame(d.raf);
    const from = d.el.style.transform;
    d.el.style.transform = "";
    const done = () => {
      d.el.classList.remove("jig-dragging");
      d.el.style.transition = d.transition;
    };
    d.el.animate([{ transform: from }, { transform: "none" }], { duration: 200, easing: EASE }).finished.then(done, done);
  }
}

/** Keeps the pointer's events on the row; the pointer may already be gone. */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Moves still arrive through the window listeners.
  }
}
