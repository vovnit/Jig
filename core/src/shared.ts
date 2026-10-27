// The shared personal data store: apps publish lists as named collections,
// other apps read them as `shared.<name>` with the user's permission.
// Pure helpers here (no timers, no DOM) so every host shares them; the runtime
// owns the live values and the shell recomputes them (see background.ts).
import type { AppSpec } from "./spec.ts";

export const COLLECTION_RE = /^[a-z]+$/;

export function isCollectionName(name: string): boolean {
  return COLLECTION_RE.test(name);
}

/** Names `src` reads as `shared.<name>` (dot) or `shared["<name>"]` (bracket). */
export function sharedReadsIn(src: string): string[] {
  const out: string[] = [];
  const dot = /\bshared\s*\.\s*([A-Za-z_$][\w$]*)/g;
  const bracket = /\bshared\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = dot.exec(src))) if (!out.includes(m[1])) out.push(m[1]);
  while ((m = bracket.exec(src))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Whether `path` writes under `shared` (`shared` itself, `shared.x`, `shared[..]`). */
export function isSharedPath(path: string): boolean {
  const t = path.trim();
  return t === "shared" || t.startsWith("shared.") || t.startsWith("shared[");
}

/** The item fields a publication shows: explicit `fields`, else all; never a secret one. */
function visibleFields(spec: AppSpec, from: string, explicit?: string[]): string[] | null {
  const def = spec.data?.[from];
  const itemFields = def && typeof def === "object" ? (def as { fields?: Record<string, unknown> }).fields : undefined;
  const secret = (k: string) => {
    const f = itemFields?.[k];
    return !!f && typeof f === "object" && (f as { secret?: unknown }).secret === true;
  };
  if (explicit) return explicit.filter((k) => !secret(k));
  if (itemFields && typeof itemFields === "object") return Object.keys(itemFields).filter((k) => !secret(k));
  return null;
}

/**
 * One publisher's items for `collection`, projected to the published fields plus
 * `app` (the publisher's id) and `appName`, in the publisher's order.
 */
export function projectPublisher(
  spec: AppSpec,
  data: Record<string, unknown>,
  collection: string,
): Record<string, unknown>[] {
  const entry = spec.publish?.[collection];
  if (!entry) return [];
  const list = data[entry.from];
  if (!Array.isArray(list)) return [];
  const fields = visibleFields(spec, entry.from, entry.fields);
  return list.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const src = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (fields) {
      for (const f of fields) out[f] = src[f];
    } else {
      for (const [k, v] of Object.entries(src)) out[k] = v;
    }
    out.app = spec.id;
    out.appName = spec.name;
    return [out];
  });
}

/** Merges publishers' items, sorted by publisher name then the publisher's order. */
export function mergePublishers(pubs: { spec: AppSpec; items: Record<string, unknown>[] }[]): Record<string, unknown>[] {
  return [...pubs]
    .sort((a, b) => (a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0))
    .flatMap((p) => p.items);
}

/** One collection on this device, for the model's context. */
export interface DeviceCollection {
  name: string;
  doc: string;
  fields: string[];
  apps: { id: string; name: string }[];
}

/** Every collection published by these apps, with who publishes it. */
export function deviceCollections(apps: { id: string; spec: AppSpec }[]): DeviceCollection[] {
  const byName = new Map<string, { doc: string; fields: Set<string>; apps: { id: string; name: string }[] }>();
  for (const { spec } of apps) {
    for (const [name, entry] of Object.entries(spec.publish ?? {})) {
      if (!isCollectionName(name) || !entry || typeof entry !== "object") continue;
      const from = (entry as { from?: unknown }).from;
      if (typeof from !== "string") continue;
      let slot = byName.get(name);
      if (!slot) {
        slot = { doc: typeof (entry as { doc?: unknown }).doc === "string" ? ((entry as { doc: string }).doc as string) : name, fields: new Set(), apps: [] };
        byName.set(name, slot);
      }
      const fields = visibleFields(spec, from, (entry as { fields?: string[] }).fields);
      if (fields) for (const f of fields) slot.fields.add(f);
      if (!slot.apps.some((a) => a.id === spec.id)) slot.apps.push({ id: spec.id, name: spec.name });
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, slot]) => ({ name, doc: slot.doc, fields: [...slot.fields], apps: slot.apps }));
}

/** The device's collections as lines for the model's context. */
export function formatCollections(apps: { id: string; spec: AppSpec }[]): string {
  const all = deviceCollections(apps);
  if (!all.length) return "No apps publish shared collections on this device.";
  return all
    .map((c) => `- ${c.name} ("${c.doc}", fields ${c.fields.join(", ") || "—"}) published by ${c.apps.map((a) => a.name).join(", ")}`)
    .join("\n");
}
