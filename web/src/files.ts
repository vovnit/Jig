// A per-app file store for the web host, behind `files.*` and the pickers.
// OPFS holds the bytes (one directory per app, one file per id, plus an index.json
// of the handles); where OPFS isn't available it falls back to IndexedDB.
// `jig-file:<app>/<id>` URLs resolve to object URLs for image/video/audio tags.

export interface FileHandle {
  id: string;
  name: string;
  type: string;
  size: number;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `f${crypto.randomUUID().slice(0, 8)}`;
  return `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function bytesFromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- Backends ----------

interface Backend {
  write(app: string, name: string, type: string, bytes: Uint8Array): Promise<FileHandle>;
  read(app: string, id: string): Promise<{ handle: FileHandle; bytes: Uint8Array }>;
  remove(app: string, id: string): Promise<void>;
  clear(app: string): Promise<void>;
}

function opfsAvailable(): boolean {
  const storage = navigator as Navigator & { storage?: { getDirectory?: () => Promise<unknown> } };
  return typeof storage.storage?.getDirectory === "function";
}

type DirHandle = FileSystemDirectoryHandle;

async function opfsBase(create: boolean): Promise<DirHandle> {
  const storage = navigator as Navigator & { storage: { getDirectory(): Promise<DirHandle> } };
  const root = await storage.storage.getDirectory();
  return root.getDirectoryHandle("jig-files", { create });
}

async function opfsApp(app: string, create: boolean): Promise<DirHandle | null> {
  try {
    const base = await opfsBase(create);
    return await base.getDirectoryHandle(app, { create });
  } catch {
    return null;
  }
}

async function opfsIndex(dir: DirHandle): Promise<FileHandle[]> {
  try {
    const file = await (await dir.getFileHandle("index.json")).getFile();
    return (await file.text().then((t) => JSON.parse(t))) as FileHandle[];
  } catch {
    return [];
  }
}

async function opfsSaveIndex(dir: DirHandle, handles: FileHandle[]): Promise<void> {
  const writable = await (await dir.getFileHandle("index.json", { create: true })).createWritable();
  await writable.write(JSON.stringify(handles));
  await writable.close();
}

const opfs: Backend = {
  async write(app, name, type, bytes) {
    const dir = (await opfsApp(app, true))!;
    const id = newId();
    const writable = await (await dir.getFileHandle(id, { create: true })).createWritable();
    await writable.write(new Blob([bytes as unknown as ArrayBuffer], { type }));
    await writable.close();
    const handle = { id, name, type, size: bytes.length };
    const index = await opfsIndex(dir);
    await opfsSaveIndex(dir, [...index.filter((h) => h.id !== id), handle]);
    return handle;
  },
  async read(app, id) {
    const dir = await opfsApp(app, false);
    if (!dir) throw new Error("No such file");
    let handle: FileHandle | undefined;
    try {
      handle = (await opfsIndex(dir)).find((h) => h.id === id);
    } catch {
      handle = undefined;
    }
    let file: File;
    try {
      file = await (await dir.getFileHandle(id)).getFile();
    } catch {
      throw new Error("No such file");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { handle: handle ?? { id, name: id, type: file.type || "application/octet-stream", size: bytes.length }, bytes };
  },
  async remove(app, id) {
    revokeUrl(`jig-file:${app}/${id}`);
    const dir = await opfsApp(app, false);
    if (!dir) return;
    try {
      await dir.removeEntry(id);
    } catch {
      // Missing file: still a success.
    }
    try {
      await opfsSaveIndex(dir, (await opfsIndex(dir)).filter((h) => h.id !== id));
    } catch {
      // A missing index is fine.
    }
  },
  async clear(app) {
    try {
      const base = await opfsBase(false);
      await base.removeEntry(app, { recursive: true });
    } catch {
      // Nothing stored: still a success.
    }
    for (const key of [...urlCache.keys()]) if (key.startsWith(`jig-file:${app}/`)) revokeUrl(key);
  },
};

interface IdbRecord {
  key: string;
  app: string;
  id: string;
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jig-files", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

function idbRequest<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", mode);
    const request = fn(tx.objectStore("files"));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
  });
}

const idb: Backend = {
  async write(app, name, type, bytes) {
    const db = await openIdb();
    try {
      const id = newId();
      const record: IdbRecord = { key: `${app}/${id}`, app, id, name, type, size: bytes.length, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
      await idbRequest(db, "readwrite", (s) => s.put(record));
      return { id, name, type, size: bytes.length };
    } finally {
      db.close();
    }
  },
  async read(app, id) {
    const db = await openIdb();
    try {
      const record = await idbRequest<IdbRecord | undefined>(db, "readonly", (s) => s.get(`${app}/${id}`));
      if (!record) throw new Error("No such file");
      return { handle: { id, name: record.name, type: record.type, size: record.size }, bytes: new Uint8Array(record.data) };
    } finally {
      db.close();
    }
  },
  async remove(app, id) {
    revokeUrl(`jig-file:${app}/${id}`);
    const db = await openIdb();
    try {
      await idbRequest(db, "readwrite", (s) => s.delete(`${app}/${id}`));
    } finally {
      db.close();
    }
  },
  async clear(app) {
    const db = await openIdb();
    try {
      const keys = await idbRequest<IDBValidKey[]>(db, "readonly", (s) => s.getAllKeys());
      await Promise.all(keys.filter((k) => String(k).startsWith(`${app}/`)).map((k) => idbRequest(db, "readwrite", (s) => s.delete(k))));
    } finally {
      db.close();
    }
    for (const key of [...urlCache.keys()]) if (key.startsWith(`jig-file:${app}/`)) revokeUrl(key);
  },
};

function backend(): Backend {
  return opfsAvailable() ? opfs : idb;
}

// ---------- Reads and writes ----------

export async function writeData(app: string, name: string, type: string, dataBase64: string): Promise<FileHandle> {
  let bytes: Uint8Array;
  try {
    bytes = bytesFromBase64(dataBase64);
  } catch {
    throw new Error("Bad file data");
  }
  return backend().write(app, name, type || "application/octet-stream", bytes);
}

export async function storeBlob(app: string, file: File): Promise<FileHandle> {
  return backend().write(app, file.name || "file", file.type || "application/octet-stream", new Uint8Array(await file.arrayBuffer()));
}

export async function readData(app: string, id: string, as: string, offset?: number, length?: number): Promise<string> {
  const { bytes } = await backend().read(app, id);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const end = length == null ? bytes.length : start + Math.max(0, Math.floor(Number(length) || 0));
  const slice = bytes.subarray(start, Math.min(bytes.length, end));
  return as === "base64" ? base64FromBytes(slice) : new TextDecoder().decode(slice);
}

export async function fileBlob(app: string, id: string): Promise<{ blob: Blob; handle: FileHandle }> {
  const { handle, bytes } = await backend().read(app, id);
  return { blob: new Blob([bytes as unknown as ArrayBuffer], { type: handle.type }), handle };
}

export async function deleteData(app: string, id: string): Promise<void> {
  await backend().remove(app, id);
}

export async function clearData(app: string): Promise<void> {
  await backend().clear(app);
}

// ---------- jig-file: URLs ----------

/** Object URLs for loaded files, by `jig-file:` URL. */
const urlCache = new Map<string, string>();

function revokeUrl(key: string): void {
  const url = urlCache.get(key);
  if (url) {
    urlCache.delete(key);
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Revoking is best-effort.
    }
  }
}

/** Loads `jig-file:<app>/<id>` from the store as an object URL for media tags. */
export async function fileUrl(src: string): Promise<string> {
  const hit = urlCache.get(src);
  if (hit) return hit;
  const match = /^jig-file:([^/]+)\/(.+)$/.exec(src);
  if (!match) throw new Error("Bad file URL");
  const { blob } = await fileBlob(match[1], match[2]);
  const url = URL.createObjectURL(blob);
  urlCache.set(src, url);
  return url;
}

// ---------- Pickers ----------

/** Extensions ("epub") and MIME patterns ("image/*") to an input accept string. */
export function acceptAttr(accept: unknown): string {
  if (!Array.isArray(accept)) return "";
  return accept
    .filter((a): a is string => typeof a === "string" && a !== "")
    .map((a) => (a.includes("/") || a.startsWith(".") ? a : `.${a}`))
    .join(",");
}

function pickWithInput(accept: string, multiple: boolean, capture?: string): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    if (capture) input.setAttribute("capture", capture);
    input.style.display = "none";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.remove();
      fn();
    };
    // Modern browsers fire `cancel` when the dialog closes without a choice.
    input.addEventListener("cancel", () => finish(() => reject(new Error("Cancelled"))));
    input.addEventListener("change", () =>
      finish(() => {
        const files = [...(input.files ?? [])];
        if (!files.length) reject(new Error("Cancelled"));
        else resolve(files);
      }),
    );
    document.body.appendChild(input);
    input.click();
  });
}

export function pickFiles(accept: unknown, multiple: boolean): Promise<File[]> {
  return pickWithInput(acceptAttr(accept), multiple);
}

export function pickPhotos(multiple: boolean): Promise<File[]> {
  return pickWithInput("image/*", multiple);
}

export function takePhotoFile(): Promise<File[]> {
  return pickWithInput("image/*", false, "environment");
}

/** A picked photo as a JPEG whose long side is at most 2048 px. */
export async function photoToJpeg(file: File): Promise<{ blob: Blob; name: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.max(bitmap.width, bitmap.height) > 2048 ? 2048 / Math.max(bitmap.width, bitmap.height) : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("encode failed");
    const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "photo";
    return { blob, name: `${base}.jpg` };
  } catch {
    // No image decoding (or no canvas): keep the original bytes.
    return { blob: file, name: file.name || "photo.jpg" };
  }
}

// ---------- Sharing ----------

type ShareNavigator = Navigator & {
  share?: (data: { title?: string; text?: string; url?: string; files?: File[] }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
};

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The Web Share API where available, else a download for files and the clipboard for text. */
export async function shareContent(args: { app: string; text?: unknown; url?: unknown; file?: unknown }): Promise<void> {
  const text = typeof args.text === "string" && args.text ? args.text : undefined;
  const url = typeof args.url === "string" && args.url ? args.url : undefined;
  let files: File[] | undefined;
  let fallbackName = "file";
  if (typeof args.file === "string" && args.file) {
    const { blob, handle } = await fileBlob(args.app, args.file);
    fallbackName = handle.name;
    files = [new File([blob], handle.name, { type: handle.type })];
  }
  const nav = navigator as ShareNavigator;
  if (typeof nav.share === "function") {
    // The sheet can't take files here: share the text/url natively and still download the file.
    if (files && nav.canShare && !nav.canShare({ files })) {
      if (text || url) {
        try {
          await nav.share({ ...(text ? { text } : {}), ...(url ? { url } : {}) });
          download(files[0], fallbackName);
          return;
        } catch (e) {
          if ((e as Error)?.name === "AbortError") {
            download(files[0], fallbackName);
            return;
          }
          // Any other failure falls through to the download and clipboard below.
        }
      }
    } else {
      const data: { text?: string; url?: string; files?: File[] } = {};
      if (text) data.text = text;
      if (url) data.url = url;
      if (files && (!nav.canShare || nav.canShare({ files }))) data.files = files;
      if (data.files || data.text || data.url) {
        try {
          await nav.share(data);
          return;
        } catch (e) {
          // Dismissing the sheet is a success; without file support fall back below.
          if ((e as Error)?.name === "AbortError") return;
          if (!files) throw e;
        }
      }
    }
  }
  if (files) download(files[0], fallbackName);
  if (text || url) {
    const combined = [text, url].filter(Boolean).join(" ");
    try {
      await navigator.clipboard.writeText(combined);
    } catch {
      // The clipboard can refuse without a gesture; the download above still delivered files.
      if (!files) throw new Error("Sharing isn't available");
    }
  }
}
