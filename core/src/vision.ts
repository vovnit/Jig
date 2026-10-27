// Photo understanding with SAM 3.1: the shell's container service behind the
// `findObjects` async action. Apps can't use `http` themselves, so the key stays
// in the shell: it reads the photo from the host's file store, calls the model
// once per prompt, and answers normalized boxes.
import type { Runtime } from "./runtime.ts";

export interface FoundBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FoundObject extends FoundBox {
  label: string;
}

/** At most this many SAM requests in flight: one prompt each, ~2-3s per request. */
const SAM_PARALLEL = 4;

const NO_KEY = "Add a Meta Model API key in Settings to find things in photos.";

/**
 * Boxes from a SAM answer's message text: one `<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>`
 * per object found, in pixels of a `w`x`h` image. Masks are ignored. Defensive:
 * entries that don't parse are skipped, and no boxes means none found.
 */
export function parseSamBoxes(text: string): FoundBox[] {
  const out: FoundBox[] = [];
  if (!text) return out;
  const re = /<\|box;([^|]*)\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const vals: Record<string, number> = {};
    for (const part of m[1].split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const n = Number(part.slice(eq + 1));
      if (Number.isFinite(n)) vals[part.slice(0, eq).trim()] = n;
    }
    const w = vals.w;
    const h = vals.h;
    if (!(w && w > 0 && h && h > 0)) continue;
    const x1 = vals.x1;
    const y1 = vals.y1;
    const x2 = vals.x2;
    const y2 = vals.y2;
    if (![x1, y1, x2, y2].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({
      x: clamp(x1 / w),
      y: clamp(y1 / h),
      width: clamp((x2 - x1) / w),
      height: clamp((y2 - y1) / h),
    });
  }
  return out;
}

/** The message text of a Responses API body, or "" when it has none. */
export function samText(body: string): string {
  try {
    const json = JSON.parse(body) as { output?: { type?: string; content?: { text?: string }[] }[] };
    const out = (json.output ?? [])
      .filter((o) => o?.type === "message")
      .flatMap((o) => o.content ?? [])
      .map((c) => c?.text ?? "")
      .join("");
    return out;
  } catch {
    return "";
  }
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function fileIdOf(file: unknown): string | null {
  if (typeof file === "string") return file || null;
  if (file && typeof file === "object" && typeof (file as Record<string, unknown>).id === "string") {
    return ((file as Record<string, unknown>).id as string) || null;
  }
  return null;
}

function promptsOf(prompts: unknown): string[] {
  const list = typeof prompts === "string" ? [prompts] : Array.isArray(prompts) ? prompts : [];
  // Each phrase once: two items with the same prompt share one count and one set of boxes.
  return [...new Set((list as unknown[]).filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p !== ""))];
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Registers the shell's `findObjects` container service (see `installBuilder`). */
export function installVision(shell: Runtime): void {
  shell.containerServices.set("findObjects", async (args, ctx) => {
    const apiKey = String(shell.get("apiKey") ?? "");
    if (!apiKey) throw new Error(NO_KEY);
    const baseUrl = String(shell.get("baseUrl") || "https://api.meta.ai/v1").replace(/\/$/, "");
    const prompts = promptsOf(args.prompts);
    const id = fileIdOf(args.photo);
    if (!id) throw new Error("No photo");
    if (!prompts.length) return { counts: {}, objects: [] };
    const app = ctx.app || shell.spec?.id || "";
    const file = await shell.hostCall<{ data?: string }>("files.read", { app, id, as: "base64" });
    const base64 = typeof file?.data === "string" ? file.data : "";
    if (!base64) throw new Error("No photo");
    const per = await mapLimit(prompts, SAM_PARALLEL, async (prompt) => {
      const res = await shell.hostCall<{ status?: number; body?: string }>("http", {
        url: `${baseUrl}/responses`,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "sam-3.1",
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: `data:image/jpeg;base64,${base64}` },
            ],
          }],
        }),
      });
      const status = Number(res?.status ?? 0);
      const body = String(res?.body ?? "");
      if (status >= 400) throw new Error(samError(body, status));
      return { prompt, boxes: parseSamBoxes(samText(body)) };
    });
    const counts: Record<string, number> = {};
    let objects: FoundObject[] = [];
    for (const { prompt, boxes } of per) {
      counts[prompt] = boxes.length;
      for (const b of boxes) objects.push({ label: prompt, ...b });
    }
    // Reading order: top to bottom, then left to right.
    objects = objects.slice().sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
    return { counts, objects };
  });
}

function samError(body: string, status: number): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
    if (message) return message;
  } catch {
    // Not JSON: fall through to the status.
  }
  return `The model service answered ${status}`;
}
