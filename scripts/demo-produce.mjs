// Produces the finished demo video: both phones framed on a 16:9 stage, a chapter title
// per scenario, crossfades between scenarios, title cards, and an ElevenLabs voice-over.
//
// Usage: ELEVENLABS_API_KEY=... node scripts/demo-produce.mjs
//
// Reads demo/out/side-by-side.mp4 and its timeline (scripts/demo-compose.mjs),
// demo/narration.json and demo/captions.json, and writes demo/out/jig-demo.mp4.
// Narration lines are cued at a scenario's mark (or "intro" / "outro"); a line still
// talking delays the next one. Voiced lines are cached in demo/out/voice by text and
// settings, so a rerun only voices what changed. An optional demo/out/music.mp3 plays
// under the voice, ducking while it talks.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo/out");
const assets = join(outDir, "stage");
const voiceDir = join(outDir, "voice");

const INTRO = 4;
const OUTRO = 5;
const FADE = 0.6;
const GAP_SEC = 0.35;
// The stage: phones on the right, captions on the left.
const PHONE_H = 940;
const PHONE_Y = 70;
const RADIUS = 44;
const CAPTION = { x: 120, y: 250, width: 660, height: 640 };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(" ")}… failed`);
}

function probe(path, entries) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  return r.stdout.trim().split("\n").map(Number);
}

async function voice(text, n, key) {
  const id = createHash("sha256").update(JSON.stringify([n.voice, n.model, n.settings ?? null, text])).digest("hex").slice(0, 16);
  const file = join(voiceDir, `${id}.mp3`);
  if (existsSync(file)) return file;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${n.voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: n.model, ...(n.settings ? { voice_settings: n.settings } : {}) }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("Set ELEVENLABS_API_KEY.");
const narration = JSON.parse(readFileSync(join(root, "demo/narration.json"), "utf8"));
const look = JSON.parse(readFileSync(join(root, "demo/captions.json"), "utf8"));
const timeline = JSON.parse(readFileSync(join(outDir, "side-by-side-timeline.json"), "utf8"));
const source = join(outDir, "side-by-side.mp4");
mkdirSync(assets, { recursive: true });
mkdirSync(voiceDir, { recursive: true });

// The side-by-side video is the iPhone take, a 40 px gap and the Android take, all 1920 px tall.
const [srcW, srcH] = probe(source, "stream=width,height");
const [iw, ih] = probe(join(outDir, `${timeline[0].name}-ios.mp4`), "stream=width,height");
const iosSrcW = 2 * Math.round((iw * srcH) / ih / 2);
const andSrcX = iosSrcW + 40;
const andSrcW = srcW - andSrcX;
const even = (n) => 2 * Math.round(n / 2);
const iosW = even((iosSrcW * PHONE_H) / srcH);
const andW = even((andSrcW * PHONE_H) / srcH);
const andX = 1920 - 120 - andW;
const iosX = andX - 64 - iosW;

// The final timeline: intro card, the scenarios crossfading into each other, the end card.
// Scenario j starts at stageAt + its offset, less one crossfade per scenario before it.
const stageLen = timeline.reduce((t, s) => t + s.duration, 0);
const stageAt = INTRO - FADE;
const startOf = (j) => stageAt + timeline[j].offset - j * FADE;
const outroAt = startOf(timeline.length - 1) + timeline.at(-1).duration - FADE;

const chapters = timeline.map((s) => {
  const c = look.chapters.find((x) => x.scenario === s.name);
  if (!c) throw new Error(`No chapter for ${s.name}`);
  return c;
});

const jobs = [
  { kind: "background", out: join(assets, "background.png") },
  { kind: "card", out: join(assets, "intro.png"), ...look.intro },
  { kind: "card", out: join(assets, "outro.png"), ...look.outro },
  { kind: "frame", out: join(assets, "frame.png"), phones: [
    { x: iosX, y: PHONE_Y, width: iosW, height: PHONE_H, radius: RADIUS },
    { x: andX, y: PHONE_Y, width: andW, height: PHONE_H, radius: RADIUS },
  ] },
  { kind: "mask", out: join(assets, "mask-ios.png"), width: iosW, height: PHONE_H, radius: RADIUS },
  { kind: "mask", out: join(assets, "mask-android.png"), width: andW, height: PHONE_H, radius: RADIUS },
  { kind: "label", out: join(assets, "labels.png"), labels: [
    { text: look.labels[0], x: iosX, y: PHONE_Y + PHONE_H + 26, width: iosW },
    { text: look.labels[1], x: andX, y: PHONE_Y + PHONE_H + 26, width: andW },
  ] },
  ...chapters.map((c, j) => ({ kind: "chapter", out: join(assets, `chapter-${j}.png`), step: c.step, title: c.title, subtitle: c.subtitle, width: CAPTION.width, height: CAPTION.height })),
];
writeFileSync(join(assets, "jobs.json"), JSON.stringify(jobs));
run("swift", [join(root, "scripts/demo-cards.swift"), join(assets, "jobs.json")]);

// Narration, placed without overlaps.
let free = 0;
const placed = [];
for (const line of narration.lines) {
  let cue;
  if (line.at === "intro") cue = 0.6;
  else if (line.at === "outro") cue = outroAt + 0.5;
  else {
    const j = timeline.findIndex((x) => x.name === line.scenario);
    if (j < 0 || timeline[j].marks[line.at] === undefined) throw new Error(`No mark '${line.at}' in ${line.scenario}`);
    cue = startOf(j) + timeline[j].marks[line.at];
  }
  cue += line.delay ?? 0;
  const file = await voice(line.text, narration, key);
  const [length] = probe(file, "format=duration");
  const start = Math.max(cue, free);
  free = start + length + GAP_SEC;
  placed.push({ file, start, length });
  const late = start - cue > 0.05 ? `  (${(start - cue).toFixed(1)} s late)` : "";
  console.log(`${start.toFixed(1).padStart(6)} s  ${length.toFixed(1)} s  ${line.scenario ?? ""}/${line.at}${late}`);
}
const length = Math.max(outroAt + OUTRO, free - GAP_SEC + 1.5);

const still = (path, seconds) => ["-loop", "1", "-framerate", "30", "-t", seconds.toFixed(3), "-i", path];
const encode = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30"];

// Pass 1, the stage in stage time: phones with rounded corners and their frame on the
// background, and one chapter title per scenario, held for the whole scenario.
const stage = join(assets, "stage.mp4");
{
  const inputs = [
    "-i", source,
    ...still(join(assets, "background.png"), stageLen),
    ...still(join(assets, "frame.png"), stageLen),
    ...still(join(assets, "mask-ios.png"), stageLen),
    ...still(join(assets, "mask-android.png"), stageLen),
    ...still(join(assets, "labels.png"), stageLen),
  ];
  timeline.forEach((s, j) => inputs.push(...still(join(assets, `chapter-${j}.png`), s.duration)));
  const f = [];
  f.push(`[0:v]fps=30,split=2[s1][s2]`);
  f.push(`[s1]crop=${iosSrcW}:${srcH}:0:0,scale=${iosW}:${PHONE_H},format=rgba[pi]`);
  f.push(`[3:v]format=gray,scale=${iosW}:${PHONE_H}[mi]`);
  f.push(`[pi][mi]alphamerge[ai]`);
  f.push(`[s2]crop=${andSrcW}:${srcH}:${andSrcX}:0,scale=${andW}:${PHONE_H},format=rgba[pa]`);
  f.push(`[4:v]format=gray,scale=${andW}:${PHONE_H}[ma]`);
  f.push(`[pa][ma]alphamerge[aa]`);
  f.push(`[1:v]format=rgba[bg]`);
  f.push(`[bg][2:v]overlay=0:0[b1]`);
  f.push(`[b1][ai]overlay=${iosX}:${PHONE_Y}[b2]`);
  f.push(`[b2][aa]overlay=${andX}:${PHONE_Y}[b3]`);
  f.push(`[b3][5:v]overlay=0:0[st0]`);
  let last = "st0";
  timeline.forEach((s, j) => {
    // In after a beat, out at the scenario's end.
    f.push(`[${6 + j}:v]format=rgba,fade=t=in:st=0.3:d=0.8:alpha=1,fade=t=out:st=${(s.duration - 0.7).toFixed(3)}:d=0.5:alpha=1,setpts=PTS-STARTPTS+${s.offset.toFixed(3)}/TB[c${j}]`);
    f.push(`[${last}][c${j}]overlay=${CAPTION.x}:${CAPTION.y}:eof_action=pass[st${j + 1}]`);
    last = `st${j + 1}`;
  });
  f.push(`[${last}]format=yuv420p,setsar=1[vout]`);
  console.log("Rendering the stage…");
  run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f.join(";"), "-map", "[vout]", ...encode, "-crf", "16", "-g", "30", "-t", stageLen.toFixed(3), stage]);
}

// Pass 2: the intro card, each scenario seeked out of the stage, the end card, crossfaded;
// the voice lines, and the music ducked under them. (Splitting one long stream into
// trimmed parts for xfade stalls ffmpeg's filter graph, so each part is its own input.)
const music = join(outDir, "music.mp3");
const inputs = [...still(join(assets, "intro.png"), INTRO)];
timeline.forEach((s) => inputs.push("-ss", s.offset.toFixed(3), "-t", s.duration.toFixed(3), "-i", stage));
inputs.push(...still(join(assets, "outro.png"), length - outroAt));
const voiceBase = timeline.length + 2;
placed.forEach((p) => inputs.push("-i", p.file));
const musicIn = existsSync(music) ? voiceBase + placed.length : -1;
if (musicIn >= 0) inputs.push("-stream_loop", "-1", "-i", music);

const f = [];
const chain = ["0:v", ...timeline.map((_, j) => `${j + 1}:v`), `${timeline.length + 1}:v`].map((input, k) => {
  f.push(`[${input}]setpts=PTS-STARTPTS,fps=30,format=yuv420p,setsar=1,settb=AVTB[p${k}]`);
  return `p${k}`;
});
let acc = chain[0];
let accLen = INTRO;
for (let k = 1; k < chain.length; k++) {
  const label = k === chain.length - 1 ? "vx" : `x${k}`;
  f.push(`[${acc}][${chain[k]}]xfade=transition=fade:duration=${FADE}:offset=${(accLen - FADE).toFixed(3)}[${label}]`);
  accLen += (k === chain.length - 1 ? length - outroAt : timeline[k - 1].duration) - FADE;
  acc = label;
}
f.push(`[vx]fade=t=in:st=0:d=0.6,fade=t=out:st=${(length - 0.8).toFixed(3)}:d=0.8[vout]`);
placed.forEach((p, i) => f.push(`[${voiceBase + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.start * 1000)}:all=1[n${i}]`));
f.push(`${placed.map((_, i) => `[n${i}]`).join("")}amix=inputs=${placed.length}:normalize=0,apad=whole_dur=${length.toFixed(3)},volume=1.6[voice]`);
if (musicIn >= 0) {
  f.push(`[voice]asplit=2[voice1][key]`);
  f.push(`[${musicIn}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${length.toFixed(3)},volume=0.12,afade=t=in:st=0:d=1.5,afade=t=out:st=${(length - 3).toFixed(3)}:d=3[bed]`);
  f.push(`[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[ducked]`);
  f.push(`[voice1][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[aout]`);
} else {
  f.push(`[voice]alimiter=limit=0.95[aout]`);
}

const out = join(outDir, "jig-demo.mp4");
console.log("Rendering the video…");
run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f.join(";"), "-map", "[vout]", "-map", "[aout]",
  ...encode, "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-t", length.toFixed(3), "-movflags", "+faststart", out]);
console.log(`${out} (${length.toFixed(1)} s, ${timeline.length} chapters, ${placed.length} lines${musicIn >= 0 ? ", music" : ""})`);
