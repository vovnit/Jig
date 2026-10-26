// Minimal fine-grained reactivity (SolidJS-style). Each binding is an effect that
// subscribes only to the signals it reads, so a state change re-runs exactly the
// bindings that depend on it. Effects are owned: disposing an owner disposes every
// effect created under it (used when `if`/`each` tear down a subtree).

type Cleanup = () => void;

export class Owner {
  children: Owner[] = [];
  cleanups: Cleanup[] = [];
  disposed = false;
  parent: Owner | null;

  constructor(parent: Owner | null) {
    this.parent = parent;
    parent?.children.push(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposeChildren();
    this.disposed = true;
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
  }

  protected disposeChildren(): void {
    const children = this.children;
    this.children = [];
    for (const c of children) {
      c.parent = null;
      c.dispose();
    }
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const fn of cleanups) fn();
  }
}

class Computation extends Owner {
  fn: () => void;
  sources = new Set<Signal<unknown>>();

  constructor(fn: () => void, parent: Owner | null) {
    super(parent);
    this.fn = fn;
  }

  run(): void {
    if (this.disposed) return;
    this.disposeChildren();
    this.unsubscribe();
    const prevObserver = observer;
    const prevOwner = owner;
    observer = this;
    owner = this;
    try {
      this.fn();
    } finally {
      observer = prevObserver;
      owner = prevOwner;
    }
  }

  unsubscribe(): void {
    for (const s of this.sources) s.observers.delete(this);
    this.sources.clear();
  }

  override dispose(): void {
    this.unsubscribe();
    super.dispose();
  }
}

let observer: Computation | null = null;
let owner: Owner | null = null;
let batchDepth = 0;
const pending = new Set<Computation>();

export class Signal<T> {
  value: T;
  observers = new Set<Computation>();

  constructor(value: T) {
    this.value = value;
  }

  get(): T {
    if (observer && !observer.disposed) {
      this.observers.add(observer);
      observer.sources.add(this as Signal<unknown>);
    }
    return this.value;
  }

  peek(): T {
    return this.value;
  }

  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const o of this.observers) pending.add(o);
    if (batchDepth === 0) flushPending();
  }
}

function flushPending(): void {
  // Guard against effects that keep re-triggering each other.
  let rounds = 0;
  while (pending.size > 0) {
    if (++rounds > 1000) throw new Error("Reactive loop: effects keep re-triggering");
    const batch = [...pending];
    pending.clear();
    for (const c of batch) c.run();
  }
}

export function signal<T>(value: T): Signal<T> {
  return new Signal(value);
}

export function effect(fn: () => void): Owner {
  const c = new Computation(fn, owner);
  c.run();
  return c;
}

/** Runs fn under a fresh owner that the caller disposes explicitly. */
export function root<T>(fn: (dispose: () => void) => T, parent: Owner | null = owner): T {
  const o = new Owner(parent);
  const prevOwner = owner;
  const prevObserver = observer;
  owner = o;
  observer = null;
  try {
    return fn(() => o.dispose());
  } finally {
    owner = prevOwner;
    observer = prevObserver;
  }
}

export function getOwner(): Owner | null {
  return owner;
}

export function onCleanup(fn: Cleanup): void {
  owner?.cleanups.push(fn);
}

export function untrack<T>(fn: () => T): T {
  const prev = observer;
  observer = null;
  try {
    return fn();
  } finally {
    observer = prev;
  }
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) flushPending();
  }
}
