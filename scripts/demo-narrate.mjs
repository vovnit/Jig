// Voices demo/narration.json with ElevenLabs and mixes it into the side-by-side video.
//
// Usage: ELEVENLABS_API_KEY=... node scripts/demo-narrate.mjs
//
// Reads demo/out/side-by-side.mp4 and the mark timeline demo-compose.mjs writes next to
// it, and writes demo/out/jig-demo.mp4. Each line starts at its mark (or right after the
// line before it, if that one is still talking); voiced lines are cached in
// demo/out/voice by text, so rerunning only voices what changed. When the last line runs
// past the video's end, the last frame is held until it finishes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo/out");
const voiceDir = join(outDir, "voice");
const GAP_SEC = 0.3;
const END_PAD_SEC = 1;

function probe(path) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  return Number.parseFloat(r.stdout);
}

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-v", "error", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

async function voice(text, { voice, model }, key) {
  const file = join(voiceDir, `${createHash("sha256").update(`${voice}\n${model}\n${text}`).digest("hex").slice(0, 16)}.mp3`);
  if (existsSync(file)) return file;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("Set ELEVENLABS_API_KEY.");
const narration = JSON.parse(readFileSync(join(root, "demo/narration.json"), "utf8"));
const timeline = JSON.parse(readFileSync(join(outDir, "side-by-side-timeline.json"), "utf8"));
const video = join(outDir, "side-by-side.mp4");
mkdirSync(voiceDir, { recursive: true });

let free = 0;
const placed = [];
for (const line of narration.lines) {
  const scenario = timeline.find((s) => s.name === line.scenario);
  const mark = scenario?.marks[line.at];
  if (mark === undefined) throw new Error(`No mark '${line.at}' in ${line.scenario}`);
  const file = await voice(line.text, narration, key);
  const length = probe(file);
  const cue = scenario.offset + mark + (line.delay ?? 0);
  const start = Math.max(cue, free);
  free = start + length + GAP_SEC;
  placed.push({ file, start, length });
  const late = start - cue > 0.05 ? ` (${(start - cue).toFixed(1)} s late)` : "";
  const end = scenario.offset + scenario.duration;
  const over = start + length > end ? ` runs ${(start + length - end).toFixed(1)} s into the next part` : "";
  console.log(`${start.toFixed(1).padStart(6)} s  ${length.toFixed(1)} s  ${line.scenario}/${line.at}${late}${over}`);
}

const videoLength = probe(video);
const total = Math.max(videoLength, free - GAP_SEC + END_PAD_SEC);
const hold = total - videoLength;
const inputs = ["-i", video];
for (const p of placed) inputs.push("-i", p.file);
const delays = placed.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.start * 1000)}:all=1[a${i}]`);
const mix = `${placed.map((_, i) => `[a${i}]`).join("")}amix=inputs=${placed.length}:normalize=0,apad=whole_dur=${total.toFixed(3)}[aout]`;
const pad = hold > 0.01 ? `[0:v]tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}[vout]` : "[0:v]null[vout]";
const out = join(outDir, "jig-demo.mp4");
ffmpeg(["-y", ...inputs, "-filter_complex", [...delays, mix, pad].join(";"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", total.toFixed(3), "-movflags", "+faststart", out]);
console.log(`${out} (${total.toFixed(1)} s)`);
