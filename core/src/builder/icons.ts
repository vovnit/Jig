// App icons drawn by Muse Image: a flat icon on the app's accent color, stored on the
// app's entry as a data URL. New apps get one when the model's run ends, `builder.icon`
// draws one on demand, and bundled apps without one get one lazily from the home list.
// One request flies at a time, so the demo list doesn't fire them all at once.
import type { Runtime } from "../runtime.ts";
import { DEFAULT_THEME } from "../spec.ts";
import type { AppSpec } from "../spec.ts";
import { findApp } from "./registry.ts";
import type { AppEntry } from "./registry.ts";

/** The prompt for an app's icon, from its name, description and accent color. */
export function iconPrompt(spec: AppSpec): string {
  const accent = spec.theme?.accent ?? DEFAULT_THEME.accent;
  return `A simple, flat app icon for '${spec.name}': ${spec.description ?? ""}. One bold symbol centered on a rounded square in the app's accent color ${accent}, no text, no letters, soft shadow.`;
}

/** The "Draw app icons" setting; on unless the user turned it off. */
export function iconsEnabled(shell: Runtime): boolean {
  return shell.get("icons") !== false;
}

interface IconJob {
  id: string;
  force: boolean;
  resolve: () => void;
}

/** One request in flight per shell, with the rest waiting in order. */
const flying = new Set<Runtime>();
const queues = new Map<Runtime, IconJob[]>();
let logSeq = 1;

function settings(shell: Runtime): { apiKey: string; baseUrl: string } {
  return {
    apiKey: String(shell.get("apiKey") ?? ""),
    baseUrl: String(shell.get("baseUrl") || "https://api.meta.ai/v1").replace(/\/$/, ""),
  };
}

/**
 * Draws an icon for an app and stores it on its entry. Skips apps that already have
 * one (unless forced), and never requests without a key or with the toggle off.
 * Resolves when this app's icon is stored (at once, or after the ones ahead of it).
 */
export function requestIcon(shell: Runtime, id: string, opts?: { force?: boolean }): Promise<void> {
  const entry = findApp(shell, id);
  if (!entry || (!opts?.force && entry.icon)) return Promise.resolve();
  if (!iconsEnabled(shell) || !settings(shell).apiKey) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const queue = queues.get(shell) ?? [];
    queue.push({ id, force: opts?.force ?? false, resolve });
    queues.set(shell, queue);
    pump(shell);
  });
}

function pump(shell: Runtime): void {
  if (flying.has(shell)) return;
  const queue = queues.get(shell);
  const job = queue?.shift();
  if (queue && !queue.length) queues.delete(shell);
  if (!job) return;
  const entry = findApp(shell, job.id);
  if (!entry || (!job.force && entry.icon) || !iconsEnabled(shell) || !settings(shell).apiKey) {
    job.resolve();
    pump(shell);
    return;
  }
  flying.add(shell);
  void draw(shell, job.id).finally(() => {
    flying.delete(shell);
    job.resolve();
    pump(shell);
  });
}

async function draw(shell: Runtime, id: string): Promise<void> {
  const entry = findApp(shell, id);
  if (!entry) return;
  const { apiKey, baseUrl } = settings(shell);
  try {
    const res = await shell.hostCall<{ status?: number; body?: string }>("http", {
      url: `${baseUrl}/images/generations`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "muse-image-1.0", prompt: iconPrompt(entry.spec), n: 1 }),
    });
    if ((res.status ?? 200) >= 400) throw new Error(`the image service answered ${res.status}`);
    let b64: unknown;
    try {
      b64 = (JSON.parse(String(res.body ?? "")) as { data?: { b64_json?: unknown }[] }).data?.[0]?.b64_json;
    } catch {
      throw new Error("the image service answered with bad JSON");
    }
    if (typeof b64 !== "string" || !b64) throw new Error("the image service answered without an image");
    const icon = `data:image/webp;base64,${b64}`;
    const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
    shell.set("apps", apps.map((a) => (a.id === id ? { ...a, icon } : a)));
  } catch (e) {
    // An icon is decoration: note it once in the builder log and keep the letter tile.
    const log = (shell.get("log") as { id: string; role: string; text: string }[] | undefined) ?? [];
    shell.set("log", [...log, { id: `icon-${logSeq++}`, role: "error", text: `Couldn't draw an icon for ${entry.spec.name}: ${(e as Error).message}` }]);
  }
}

/** `builder.icon` plus the lazy pass over the home list. Wired from `installBuilder`. */
export function installIcons(shell: Runtime): void {
  shell.services.set("builder.icon", (args) => {
    const id = String(args.id ?? "");
    if (id) void requestIcon(shell, id, { force: true });
  });
  const prev = shell.onFrame;
  shell.onFrame = () => {
    prev?.();
    lazyTick(shell);
  };
}

/** The first app on the home list still on its letter tile gets an icon, when allowed. */
function lazyTick(shell: Runtime): void {
  if (flying.has(shell) || (queues.get(shell)?.length ?? 0) > 0) return;
  // Not while the builder works: the new app is still being written (and named).
  if (!iconsEnabled(shell) || !settings(shell).apiKey || shell.get("busy")) return;
  if (shell.nav.peek().at(-1)?.screen !== "home") return;
  const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
  const next = apps.find((a) => !a.icon && a.spec.name && a.spec.name !== "New app");
  if (next) void requestIcon(shell, next.id);
}
