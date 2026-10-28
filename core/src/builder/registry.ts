// The shell's list of apps: its `apps` data, one entry per app with the app's spec.
// Bundled demo specs seed it; an app the user changed keeps its own spec from then on.
import type { Runtime } from "../runtime.ts";
import type { Interaction } from "../runtime.ts";
import type { AppSpec } from "../spec.ts";

/** What learning changed, newest last. */
export interface Lesson {
  at: number;
  text: string;
  undone?: boolean;
  /** Hash of the committed spec's JSON: undo lands only on top of it. */
  specHash?: string;
}

export interface AppEntry {
  id: string;
  spec: AppSpec;
  /** Changed in the builder: bundled updates no longer replace it. */
  edited: boolean;
  /** Earlier specs, newest last, for undo; and undone ones for redo. */
  history?: AppSpec[];
  future?: AppSpec[];
  /** An icon drawn by Muse Image, as a data URL; the home list shows it instead of the letter tile. */
  icon?: string;
  /** Learn from how this app is used. */
  learning?: boolean;
  /** The model's notes about how this person uses the app, at most 2,000 characters. */
  learnNotes?: string;
  /** What learning changed, newest last, keeping 20. */
  lessons?: Lesson[];
  /** Recorded interactions not yet learned from, keeping the newest 400. */
  learnEvents?: Interaction[];
}

const HISTORY = 20;

const entries = (shell: Runtime) => (shell.get("apps") as AppEntry[] | undefined) ?? [];

export function findApp(shell: Runtime, id: string): AppEntry | undefined {
  return entries(shell).find((a) => a.id === id);
}

function change(shell: Runtime, id: string, fn: (a: AppEntry) => AppEntry): void {
  shell.set("apps", entries(shell).map((a) => (a.id === id ? fn(a) : a)));
}

/** Saves a builder edit, keeping the previous spec for undo. */
export function commitEdit(shell: Runtime, id: string, spec: AppSpec): void {
  change(shell, id, (a) => ({ ...a, spec, edited: true, history: [...(a.history ?? []), a.spec].slice(-HISTORY), future: [] }));
}

export function undoEdit(shell: Runtime, id: string): void {
  change(shell, id, (a) => {
    const history = [...(a.history ?? [])];
    const prev = history.pop();
    return prev ? { ...a, spec: prev, history, future: [a.spec, ...(a.future ?? [])] } : a;
  });
}

export function redoEdit(shell: Runtime, id: string): void {
  change(shell, id, (a) => {
    const [next, ...future] = a.future ?? [];
    return next ? { ...a, spec: next, history: [...(a.history ?? []), a.spec].slice(-HISTORY), future } : a;
  });
}

/** A new app at the top of the list, for the model to fill in. */
export function addApp(shell: Runtime, spec: AppSpec): void {
  shell.set("apps", [{ id: spec.id, spec, edited: true, history: [], future: [] }, ...entries(shell)]);
}

/** Adds bundled specs that aren't in the list yet, and refreshes the unedited ones. */
export function seedApps(shell: Runtime, specs: AppSpec[]): void {
  const apps = [...((shell.get("apps") as AppEntry[] | undefined) ?? [])];
  let changed = false;
  for (const spec of specs) {
    const i = apps.findIndex((a) => a.id === spec.id);
    if (i < 0) {
      apps.push({ id: spec.id, spec, edited: false });
      changed = true;
    } else if (!apps[i].edited && JSON.stringify(apps[i].spec) !== JSON.stringify(spec)) {
      apps[i] = { ...apps[i], spec };
      changed = true;
    }
  }
  if (changed) shell.set("apps", apps);
}

/** Replaces an app's spec, as an edit: the running copy hot-reloads. */
export function updateApp(shell: Runtime, id: string, spec: AppSpec): void {
  change(shell, id, (a) => ({ ...a, spec, edited: true }));
}

/** The app running in the shell's `app` node, if any. */
export function runningApp(shell: Runtime): Runtime | undefined {
  return shell.children.find((c) => c.spec);
}
