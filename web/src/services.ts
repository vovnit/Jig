import { setSchedule } from "./schedules.ts";
import { setWidgets } from "./widgets.ts";
import type { Occurrence } from "../../core/src/schedule.ts";
import type { WidgetUpdate } from "@jig/core";
// Host services for the shell on the web (see `Host.call`): HTTP for the model, audio for
// spoken requests, and screenshots for the model to check its changes.

import { clearData, deleteData, photoToJpeg, pickFiles, pickPhotos, readData, shareContent, storeBlob, takePhotoFile, writeData } from "./files.ts";

type Done = (result: unknown, error?: string) => void;
type Progress = (update: Record<string, unknown>) => void;

/** In dev, model calls go through the Vite proxy (vite.config.ts), so the browser needs no CORS headers from the API. */
function proxied(url: string): string {
  return import.meta.env.DEV ? url.replace(/^https:\/\/api\.meta\.ai\//, "/meta-api/") : url;
}

export function callService(service: string, args: Record<string, unknown>, done: Done, progress?: Progress): void {
  switch (service) {
    case "schedule.set":
      setSchedule(String(args.app), (args.items ?? []) as Occurrence[]).then(() => done({}), e => done(null, e.message));
      return;
    case "widgets.set":
      try {
        setWidgets(String(args.app), String(args.appName ?? args.app), (args.widgets ?? []) as WidgetUpdate[]);
        done({});
      } catch (e) {
        done(null, (e as Error).message);
      }
      return;
    case "http": {
      const { url, method = "GET", headers = {}, body, stream } = args as { url: string; method?: string; headers?: Record<string, string>; body?: string; stream?: boolean };
      fetch(proxied(url), { method, headers, body })
        .then(async (res) => {
          if (!stream || !res.body || !progress) return done({ status: res.status, body: await res.text() });
          await readLines(res.body, (line) => progress({ line }));
          done({ status: res.status, body: "" });
        })
        .catch((e: Error) => done(null, e.message));
      return;
    }
    case "audio.start":
      recorder.start().then(() => done({}), (e: Error) => done(null, e.message));
      return;
    case "audio.stop":
      done({ data: recorder.stop() });
      return;
    case "location.watch":
      watchLocation(done, progress);
      return;
    case "location.stop":
      stopLocation(done);
      return;
    case "heading.watch":
      watchHeading(done, progress);
      return;
    case "heading.stop":
      stopHeading(done);
      return;
    case "haptic":
      haptic(args, done);
      return;
    case "keepAwake":
      setKeepAwake(args, done);
      return;
    case "brightness":
      // No web API for screen brightness.
      done({});
      return;
    case "speak":
      speak(args, done);
      return;
    case "stopSpeaking":
      stopSpeaking(done);
      return;
    case "screenshot":
      screenshot(Number(args.id)).then((data) => done({ data }), (e: Error) => done(null, e.message));
      return;
    case "zip.list":
      zipList(args, done);
      return;
    case "zip.read":
      zipRead(args, done);
      return;
    case "files.write": {
      const { app, name = "file", type = "application/octet-stream", data = "" } = args as { app: string; name?: string; type?: string; data?: string };
      writeData(String(app), String(name), String(type), String(data)).then((handle) => done(handle), (e: Error) => done(null, e.message));
      return;
    }
    case "files.read": {
      const { app, id, as = "text", offset, length } = args as { app: string; id: string; as?: string; offset?: number; length?: number };
      readData(String(app), String(id), String(as), offset as number | undefined, length as number | undefined).then(
        (data) => done({ data }),
        (e: Error) => done(null, e.message),
      );
      return;
    }
    case "files.delete": {
      const { app, id } = args as { app: string; id: string };
      deleteData(String(app), String(id)).then(() => done({}), (e: Error) => done(null, e.message));
      return;
    }
    case "files.clear": {
      clearData(String((args as { app: string }).app)).then(() => done({}), (e: Error) => done(null, e.message));
      return;
    }
    case "pickFile": {
      const { app, accept, multiple } = args as { app: string; accept?: unknown; multiple?: boolean };
      pickFiles(accept, multiple === true)
        .then(async (files) => storePicked(String(app), files, multiple === true))
        .then((handles) => done(handles), (e: Error) => done(null, e.message));
      return;
    }
    case "pickPhoto": {
      const { app, multiple } = args as { app: string; multiple?: boolean };
      pickPhotos(multiple === true)
        .then(async (files) => storePickedPhotos(String(app), files, multiple === true))
        .then((handles) => done(handles), (e: Error) => done(null, e.message));
      return;
    }
    case "takePhoto": {
      takePhotoFile()
        .then(async (files) => storePickedPhotos(String((args as { app: string }).app), files, false))
        .then((handles) => done((handles as unknown[])[0] ?? handles), (e: Error) => done(null, e.message));
      return;
    }
    case "share": {
      shareContent(args as { app: string; text?: unknown; url?: unknown; file?: unknown }).then(() => done({}), (e: Error) => done(null, e.message));
      return;
    }
    default:
      done(null, `No '${service}' service on the web`);
  }
}

/** Stores picked files, returning one handle or a list when `multiple`. */
async function storePicked(app: string, files: File[], multiple: boolean): Promise<unknown> {
  const handles = await Promise.all(files.map((f) => storeBlob(app, f)));
  return multiple ? handles : handles[0];
}

/** Stores picked photos as downscaled JPEGs, returning one handle or a list. */
async function storePickedPhotos(app: string, files: File[], multiple: boolean): Promise<unknown> {
  const handles = await Promise.all(
    files.map(async (f) => {
      const { blob, name } = await photoToJpeg(f);
      // A photo that couldn't be decoded keeps its original bytes and type.
      return storeBlob(app, new File([blob], name, { type: blob.type || "image/jpeg" }));
    }),
  );
  return multiple ? handles : handles[0];
}

/** Calls `onLine` for each line of a streamed body as it arrives. */
async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (rest + decoder.decode(value, { stream: true })).split("\n");
    rest = lines.pop()!;
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  }
  if (rest) onLine(rest);
}

// ---------- Audio ----------

const RATE = 16000;

/** Records the microphone as 16 kHz mono PCM, the WAV the model is sent. */
const recorder = new (class {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    this.context = new AudioContext({ sampleRate: RATE });
    const source = this.context.createMediaStreamSource(this.stream);
    // A ScriptProcessor keeps this in one file; an AudioWorklet would need a module of its own.
    const node = this.context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(this.context.destination);
  }

  stop(): string {
    this.stream?.getTracks().forEach((t) => t.stop());
    const rate = this.context?.sampleRate ?? RATE;
    void this.context?.close();
    this.stream = null;
    this.context = null;
    const samples = new Float32Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      samples.set(c, at);
      at += c.length;
    }
    return base64(wav(samples, rate));
  }
})();

function wav(samples: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Location (coarse, for sun times) ----------

/** One `location.watch` at a time; a second watch ends the first with `{}`. */
let locationWatch: { id: number; done: Done } | null = null;

function watchLocation(done: Done, progress?: Progress): void {
  if (locationWatch) {
    const old = locationWatch;
    locationWatch = null;
    navigator.geolocation.clearWatch(old.id);
    old.done({});
  }
  if (!("geolocation" in navigator)) {
    done(null, "No location available");
    return;
  }
  // The watch never answers `done` with a result: only `stop`, a replacement, or an error ends it.
  const record = { id: 0, done };
  record.id = navigator.geolocation.watchPosition(
    (pos) => progress?.({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => {
      // A late error (after `stop` replaced this watch) is ignored.
      if (locationWatch !== record) return;
      navigator.geolocation.clearWatch(record.id);
      locationWatch = null;
      done(null, err.code === err.PERMISSION_DENIED ? "Location access is off" : "No location available");
    },
  );
  locationWatch = record;
}

function stopLocation(done: Done): void {
  if (locationWatch) {
    const watch = locationWatch;
    locationWatch = null;
    navigator.geolocation.clearWatch(watch.id);
    watch.done({});
  }
  done({});
}

// ---------- Heading (a compass for aligning a sundial) ----------

/** The fields a compass fix is read from (`webkitCompassHeading` is Safari-only). */
interface CompassFix {
  absolute: boolean | null;
  alpha: number | null;
  webkitCompassHeading?: unknown;
  webkitCompassAccuracy?: unknown;
}

let headingWatch: { done: Done; cleanup: () => void } | null = null;
/** A watch waiting on Safari's permission prompt: no listeners yet, so a stop or a
 *  second watch replaces it before it starts. */
let headingPending: { done: Done; progress?: Progress } | null = null;

function watchHeading(done: Done, progress?: Progress): void {
  if (headingWatch) {
    const old = headingWatch;
    headingWatch = null;
    old.cleanup();
    old.done({});
  }
  // A second watch wins while the first still waits on permission.
  if (headingPending) {
    const replaced = headingPending;
    headingPending = null;
    replaced.done({});
  }
  if (!("DeviceOrientationEvent" in window)) {
    done(null, "This device has no compass");
    return;
  }
  const start = () => {
    let lastDeg: number | null = null;
    let lastTime = 0;
    let settled = false;
    const onOrientation = (ev: Event) => {
      const e = ev as unknown as CompassFix;
      let degrees: number | null = null;
      let accuracy = -1;
      if (typeof e.webkitCompassHeading === "number") {
        // Safari: a true-north heading with its accuracy in degrees.
        degrees = e.webkitCompassHeading;
        if (typeof e.webkitCompassAccuracy === "number") accuracy = e.webkitCompassAccuracy;
      } else if (e.absolute === true && typeof e.alpha === "number") {
        // Elsewhere `alpha` runs clockwise from north when the event is absolute.
        degrees = (360 - e.alpha) % 360;
      } else {
        return; // Not a compass fix; keep waiting for one.
      }
      settled = true;
      const now = performance.now();
      // About 10 updates a second, only when it moved by at least a degree.
      if (lastDeg === null || (turnDiff(degrees, lastDeg) >= 1 && now - lastTime >= 100)) {
        lastDeg = degrees;
        lastTime = now;
        progress?.({ degrees, accuracy });
      }
    };
    // Chrome reports `deviceorientationabsolute`; Safari only `deviceorientation`.
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    const timer = window.setTimeout(() => {
      // Most desktops never report a compass fix.
      if (!settled && headingWatch?.done === done) {
        stopHeadingWatch();
        done(null, "This device has no compass");
      }
    }, 3000);
    headingWatch = {
      done,
      cleanup: () => {
        window.removeEventListener("deviceorientationabsolute", onOrientation);
        window.removeEventListener("deviceorientation", onOrientation);
        window.clearTimeout(timer);
      },
    };
  };
  const request = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent?.requestPermission;
  if (typeof request === "function") {
    // Safari asks on first use, from the tap that called the service. A stop (or a
    // second watch) while the prompt is pending wins: the late answer installs nothing.
    const record = { done, progress };
    headingPending = record;
    request().then(
      (answer) => {
        if (headingPending !== record) return;
        headingPending = null;
        if (answer === "granted") start();
        else done(null, "Compass access is off");
      },
      () => {
        if (headingPending !== record) return;
        headingPending = null;
        done(null, "Compass access is off");
      },
    );
    return;
  }
  start();
}

function stopHeadingWatch(): void {
  const watch = headingWatch;
  headingWatch = null;
  watch?.cleanup();
}

function stopHeading(done: Done): void {
  if (headingPending) {
    const pending = headingPending;
    headingPending = null;
    pending.done({});
  }
  if (headingWatch) {
    const watch = headingWatch;
    headingWatch = null;
    watch.cleanup();
    watch.done({});
  }
  done({});
}

/** Smallest turn between two compass headings, in degrees. */
function turnDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------- Haptics, wake lock, brightness, speech (Phase C) ----------

/** A short vibration pattern per style; answers `{}` where there's no vibration. */
function haptic(args: Record<string, unknown>, done: Done): void {
  const patterns: Record<string, number | number[]> = {
    light: 10,
    medium: 25,
    heavy: 50,
    success: [15, 50, 30],
    warning: [30, 50, 30, 50, 40],
    error: [60, 60, 60],
  };
  const pattern = patterns[String(args.style)] ?? 10;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // No vibration: still a success.
  }
  done({});
}

type WakeLockSentinel = { release(): Promise<void>; addEventListener(type: string, cb: () => void): void };

let wakeLock: WakeLockSentinel | null = null;
let wantAwake = false;
let wakePending: Promise<void> | null = null;

async function acquireWakeLock(): Promise<void> {
  if (wakeLock || !wantAwake) return;
  if (wakePending) return wakePending;
  const nav = navigator as Navigator & { wakeLock?: { request(type: string): Promise<WakeLockSentinel> } };
  if (!nav.wakeLock) return;
  wakePending = nav.wakeLock.request("screen").then(async (lock) => {
    if (!wantAwake) { await lock.release(); return; }
    wakeLock = lock;
    lock.addEventListener("release", () => { if (wakeLock === lock) wakeLock = null; });
  }).finally(() => { wakePending = null; });
  return wakePending;
}

function setKeepAwake(args: Record<string, unknown>, done: Done): void {
  wantAwake = args.on === true;
  const lock = wakeLock;
  if (!wantAwake) wakeLock = null;
  const operation = wantAwake ? acquireWakeLock() : lock?.release() ?? Promise.resolve();
  operation.then(() => done({}), (e) => done(null, String(e?.message ?? e)));
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void acquireWakeLock().catch(() => {});
  });
}

/** One `speak` at a time; a new one (or `stopSpeaking`) ends the previous with `{}`. */
let speakDone: Done | null = null;

function speak(args: Record<string, unknown>, done: Done): void {
  const text = String(args.text ?? "");
  if (!text) {
    done(null, "Nothing to say");
    return;
  }
  if (!("speechSynthesis" in window)) {
    done(null, "Speech isn't available");
    return;
  }
  const pending = speakDone;
  speakDone = null;
  try {
    speechSynthesis.cancel();
  } catch {
    // Ignore: stopping previous speech is best-effort.
  }
  pending?.({});
  const rawRate = Number(args.rate ?? 1);
  const rate = Number.isFinite(rawRate) ? Math.min(2, Math.max(0.5, rawRate)) : 1;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = rate;
  utter.onend = () => {
    if (speakDone !== done) return;
    speakDone = null;
    done({});
  };
  utter.onerror = () => {
    if (speakDone !== done) return;
    speakDone = null;
    done(null, "Speech was interrupted");
  };
  speakDone = done;
  speechSynthesis.speak(utter);
}

function stopSpeaking(done: Done): void {
  const pending = speakDone;
  speakDone = null;
  try {
    speechSynthesis.cancel();
  } catch {
    // Ignore: stopping is best-effort.
  }
  pending?.({});
  done({});
}

// ---------- Zip archives (Phase F: EPUBs are zips) ----------

interface ZipEntry {
  path: string;
  method: number;
  /** Offset of the compressed data in the archive. */
  data: number;
  compSize: number;
  size: number;
}

/** An archive's bytes with its parsed central directory, cached per (app, id). */
const zipCache = new Map<string, { bytes: Uint8Array; entries: ZipEntry[] }>();
const ZIP_MAX_ARCHIVE = 64 * 1024 * 1024;
const ZIP_MAX_ENTRY = 16 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 5000;

/**
 * A stored file's bytes through the Phase E `files.read` service (the whole file
 * as base64). Until that service exists this answers its error, and so does zip.
 */
function appFileBytes(app: unknown, id: unknown): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    callService("files.read", { app, id, as: "base64" }, (result, error) => {
      if (error) return reject(new Error(error));
      const data = (result as { data?: unknown } | null)?.data;
      if (typeof data !== "string") return reject(new Error("Bad 'files.read' answer"));
      try {
        resolve(b64ToBytes(data));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

function zipDir(app: unknown, id: unknown): Promise<{ bytes: Uint8Array; entries: ZipEntry[] }> {
  const key = `${String(app)}${String(id)}`;
  const hit = zipCache.get(key);
  if (hit) return Promise.resolve(hit);
  return appFileBytes(app, id).then((bytes) => {
    if (bytes.length > ZIP_MAX_ARCHIVE) throw new Error("That file is too big to open");
    const dir = { bytes, entries: parseZip(bytes) };
    zipCache.set(key, dir);
    return dir;
  });
}

function zipList(args: Record<string, unknown>, done: Done): void {
  zipDir(args.app, args.id).then(
    ({ entries }) => done({ entries: entries.map((e) => ({ path: e.path, size: e.size })) }),
    (e: Error) => done(null, e.message),
  );
}

function zipRead(args: Record<string, unknown>, done: Done): void {
  const path = String(args.path ?? "");
  const as = args.as === "base64" ? "base64" : "text";
  zipDir(args.app, args.id).then(
    async ({ bytes, entries }) => {
      try {
        const entry = entries.find((e) => e.path === path);
        if (!entry) throw new Error(`No '${path}' in this file`);
        const raw = await inflateEntry(bytes, entry);
        done({ data: as === "base64" ? base64(raw) : new TextDecoder("utf-8").decode(raw) });
      } catch (e) {
        done(null, e instanceof Error ? e.message : String(e));
      }
    },
    (e: Error) => done(null, e.message),
  );
}

/** The central directory: every entry's path, method and data offset, bounds-checked. */
function parseZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get16 = (at: number) => view.getUint16(at, true);
  const get32 = (at: number) => view.getUint32(at, true);
  // The end-of-central-directory record sits in the last 64K + 22 bytes.
  if (bytes.length < 22) throw new Error("That file isn't a zip archive");
  let eocd = -1;
  const from = Math.max(0, bytes.length - 65557);
  for (let at = bytes.length - 22; at >= from; at--) {
    if (get32(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file isn't a zip archive");
  const count = get16(eocd + 10);
  const cdSize = get32(eocd + 12);
  const cdOff = get32(eocd + 16);
  if (count > ZIP_MAX_ENTRIES) throw new Error("That file has too many entries to open");
  if (cdOff + cdSize > bytes.length) throw new Error("That file isn't a zip archive");
  const entries: ZipEntry[] = [];
  const text = new TextDecoder("utf-8");
  let at = cdOff;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || get32(at) !== 0x02014b50) throw new Error("That file isn't a zip archive");
    const flags = get16(at + 8);
    const method = get16(at + 10);
    const compSize = get32(at + 20);
    const size = get32(at + 24);
    const nameLen = get16(at + 28);
    const extraLen = get16(at + 30);
    const commentLen = get16(at + 32);
    const localOff = get32(at + 42);
    at += 46;
    if (at + nameLen + extraLen + commentLen > bytes.length) throw new Error("That file isn't a zip archive");
    const path = text.decode(bytes.subarray(at, at + nameLen));
    at += nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue; // a directory
    if (method !== 0 && method !== 8) throw new Error(`'${path}' uses an unsupported compression`);
    if (flags & 0x01) throw new Error(`'${path}' is encrypted`);
    if (flags & 0x08) throw new Error(`'${path}' has no directory sizes`);
    if (compSize === 0xffffffff || size === 0xffffffff) throw new Error(`'${path}' needs zip64`);
    if (size > ZIP_MAX_ENTRY) throw new Error(`'${path}' is too big to open`);
    // The local header repeats the shape; the data follows its name and extra fields.
    if (localOff + 30 > bytes.length || get32(localOff) !== 0x04034b50) throw new Error("That file isn't a zip archive");
    const data = localOff + 30 + get16(localOff + 26) + get16(localOff + 28);
    if (data + compSize > bytes.length) throw new Error("That file isn't a zip archive");
    entries.push({ path, method, data, compSize, size });
  }
  return entries;
}

async function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const comp = bytes.slice(entry.data, entry.data + entry.compSize);
  if (entry.method === 0) {
    if (comp.length !== entry.size) throw new Error("That file isn't a zip archive");
    return comp;
  }
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(comp).then(() => writer.close());
  const reader = stream.readable.getReader();
  const out: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > ZIP_MAX_ENTRY) throw new Error("That entry is too big to open");
    out.push(value);
  }
  const raw = new Uint8Array(total);
  let at = 0;
  for (const chunk of out) {
    raw.set(chunk, at);
    at += chunk.length;
  }
  return raw;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Screenshots ----------

/**
 * A PNG of a node's view at its own size (an app in a whiteboard card is drawn unscaled):
 * the subtree is serialized into an SVG foreignObject with the page's styles, and drawn.
 */
async function screenshot(id: number): Promise<string> {
  const el = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!el) throw new Error(`No view ${id}`);
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.scale = "";
  clone.style.translate = "";
  clone.style.position = "relative";
  const css = [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].map((r) => r.cssText);
    } catch {
      return [];
    }
  });
  const html = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;background:${getComputedStyle(document.querySelector("#surface") ?? document.body).backgroundColor}"><style>${css.join("\n")}</style>${html}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
}
