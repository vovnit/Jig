// Host services for the shell on the web (see `Host.call`): HTTP for the model, audio for
// spoken requests, and screenshots for the model to check its changes.

type Done = (result: unknown, error?: string) => void;

/** In dev, model calls go through the Vite proxy (vite.config.ts), so the browser needs no CORS headers from the API. */
function proxied(url: string): string {
  return import.meta.env.DEV ? url.replace(/^https:\/\/api\.meta\.ai\//, "/meta-api/") : url;
}

export function callService(service: string, args: Record<string, unknown>, done: Done): void {
  switch (service) {
    case "http": {
      const { url, method = "GET", headers = {}, body } = args as { url: string; method?: string; headers?: Record<string, string>; body?: string };
      fetch(proxied(url), { method, headers, body })
        .then(async (res) => done({ status: res.status, body: await res.text() }))
        .catch((e: Error) => done(null, e.message));
      return;
    }
    case "audio.start":
      recorder.start().then(() => done({}), (e: Error) => done(null, e.message));
      return;
    case "audio.stop":
      done({ data: recorder.stop() });
      return;
    case "screenshot":
      screenshot(Number(args.id)).then((data) => done({ data }), (e: Error) => done(null, e.message));
      return;
    default:
      done(null, `No '${service}' service on the web`);
  }
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
