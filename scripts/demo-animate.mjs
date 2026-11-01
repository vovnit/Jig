// Renders the how-it-works animations in demo/animations/scenes.html to video, frame by
// frame in headless Chromium, so every frame lands exactly on time.
//
// Usage: node scripts/demo-animate.mjs <scene> <seconds> <out.mp4> [section.json]
//        node scripts/demo-animate.mjs --stills <scene> <out-dir> <t1,t2,…> [section.json]
// Scenes are the keys of SCENES in scenes.html. A section JSON (icon, kicker, title,
// points) draws the left column. Chromium comes from Playwright's cache, or CHROMIUM.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(join(root, "demo/animations/scenes.html")).href;
const FPS = 30;

/** Playwright's cached headless shell, newest first. */
function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const d of dirs) {
    const bin = join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("No Chromium found: install one with `npx playwright install chromium-headless-shell` or set CHROMIUM.");
}

async function open() {
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await tab.goto(page);
  await tab.waitForFunction(() => typeof window.renderFrame === "function");
  return { browser, tab };
}

/** Renders `scene` for `seconds` into an H.264 file at `out`; `timeScale` < 1 plays it slower. */
export async function animate(scene, seconds, out, section = null, timeScale = 1) {
  const { browser, tab } = await open();
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS), out], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round(seconds * FPS);
  for (let i = 0; i < frames; i++) {
    await tab.evaluate(([id, t, d, s]) => window.renderFrame(id, t, d, s), [scene, (i / FPS) * timeScale, seconds * timeScale, section]);
    const jpg = await tab.screenshot({ type: "jpeg", quality: 92 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((resolve, reject) => ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
  await browser.close();
}

/** Still frames of `scene` at the given times, for checking a scene by eye. */
export async function stills(scene, dir, times, section = null) {
  mkdirSync(dir, { recursive: true });
  const { browser, tab } = await open();
  for (const t of times) {
    await tab.evaluate(([id, tt, s]) => window.renderFrame(id, tt, 12, s), [scene, t, section]);
    writeFileSync(join(dir, `${scene}-${t}.jpg`), await tab.screenshot({ type: "jpeg", quality: 85 }));
  }
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--stills") {
    const [, scene, dir, times, sectionFile] = args;
    await stills(scene, dir, times.split(",").map(Number), sectionFile ? JSON.parse(readFileSync(sectionFile, "utf8")) : null);
  } else {
    const [scene, seconds, out, sectionFile] = args;
    await animate(scene, Number(seconds), out, sectionFile ? JSON.parse(readFileSync(sectionFile, "utf8")) : null);
  }
}
