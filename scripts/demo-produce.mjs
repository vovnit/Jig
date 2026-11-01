// Produces the finished demo video: a title card, a section of capability tiles, a
// showcase of scenarios with both phones framed on a 16:9 stage (a chapter title each,
// crossfaded), an end card, and an ElevenLabs voice-over.
//
// Usage: ELEVENLABS_API_KEY=... node scripts/demo-produce.mjs
//
// Reads demo/out/<name>-side-by-side.mp4 and the timeline from scripts/demo-compose.mjs,
// demo/narration.json and demo/captions.json, and writes demo/out/jig-demo.mp4.
// captions.json picks the showcase scenarios and lays out the capability tiles.
// Narration lines are cued at a scenario's mark, or "intro" / "capabilities" / "outro"
// plus a delay; a line still talking delays the next one. Voiced lines are cached in
// demo/out/voice by text and settings, so a rerun only voices what changed. An optional
// demo/out/music.mp3 plays under the voice, ducking while it talks.
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
// The stage: phones on the right, the chapter title on the left.
const PHONE_H = 940;
const PHONE_Y = 70;
const RADIUS = 44;
const CAPTION = { x: 120, y: 250, width: 660, height: 640 };
// The capability grid: four tiles a row.
const TILE = { width: 380, height: 280, gap: 30, top: 300 };

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
const composed = JSON.parse(readFileSync(join(outDir, "side-by-side-timeline.json"), "utf8"));
mkdirSync(assets, { recursive: true });
mkdirSync(voiceDir, { recursive: true });

// The showcase scenarios, back to back.
const scenes = (look.showcase ?? composed.map((s) => s.name)).map((name) => {
  const s = composed.find((x) => x.name === name);
  if (!s) throw new Error(`No composed scenario '${name}'; run scripts/demo-compose.mjs ${name}`);
  const chapter = look.chapters.find((c) => c.scenario === name);
  if (!chapter) throw new Error(`No chapter for ${name}`);
  return { ...s, chapter, video: join(outDir, `${name}-side-by-side.mp4`) };
});

// Each side-by-side video is the iPhone take, a 40 px gap and the Android take, 1920 px tall.
const [srcW, srcH] = probe(scenes[0].video, "stream=width,height");
const [iw, ih] = probe(join(outDir, `${scenes[0].name}-ios.mp4`), "stream=width,height");
const iosSrcW = 2 * Math.round((iw * srcH) / ih / 2);
const andSrcX = iosSrcW + 40;
const andSrcW = srcW - andSrcX;
const even = (n) => 2 * Math.round(n / 2);
const iosW = even((iosSrcW * PHONE_H) / srcH);
const andW = even((andSrcW * PHONE_H) / srcH);
const andX = 1920 - 120 - andW;
const iosX = andX - 64 - iosW;

// The final timeline: intro, capabilities, the scenes, the end card, each crossfading
// into the next (so each part starts one fade before the previous one ends).
const caps = look.capabilities ?? null;
const capsLen = caps ? caps.duration : 0;
const parts = [INTRO, ...(caps ? [capsLen] : []), ...scenes.map((s) => s.duration)];
const startOfPart = (k) => parts.slice(0, k).reduce((t, d) => t + d - FADE, 0);
const capsAt = startOfPart(1);
const sceneAt = (j) => startOfPart((caps ? 2 : 1) + j);
const outroAt = startOfPart(parts.length);

// The stills: cards, the stage furniture, chapter titles, the section and its tiles.
const tilePos = (i) => {
  const cols = 4;
  const left = (1920 - (cols * TILE.width + (cols - 1) * TILE.gap)) / 2;
  return { x: left + (i % cols) * (TILE.width + TILE.gap), y: TILE.top + Math.floor(i / cols) * (TILE.height + TILE.gap) };
};
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
  ...scenes.map((s, j) => ({ kind: "chapter", out: join(assets, `chapter-${j}.png`), step: s.chapter.step, title: s.chapter.title, subtitle: s.chapter.subtitle, width: CAPTION.width, height: CAPTION.height })),
  ...(caps ? [
    { kind: "section", out: join(assets, "section.png"), title: caps.title, subtitle: caps.subtitle },
    ...caps.tiles.map((t, i) => ({ kind: "tile", out: join(assets, `tile-${i}.png`), icon: t.icon, title: t.title, text: t.text, width: TILE.width, height: TILE.height })),
  ] : []),
];
writeFileSync(join(assets, "jobs.json"), JSON.stringify(jobs));
run("swift", [join(root, "scripts/demo-cards.swift"), join(assets, "jobs.json")]);

// Narration, placed without overlaps.
let free = 0;
const placed = [];
for (const line of narration.lines) {
  let cue;
  if (line.at === "intro") cue = 0.6;
  else if (line.at === "capabilities") cue = capsAt;
  else if (line.at === "outro") cue = outroAt + 0.5;
  else {
    const j = scenes.findIndex((x) => x.name === line.scenario);
    if (j < 0) continue; // a scenario left out of the showcase
    if (scenes[j].marks[line.at] === undefined) throw new Error(`No mark '${line.at}' in ${line.scenario}`);
    cue = sceneAt(j) + scenes[j].marks[line.at];
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

// The capability section: tiles rise and fade in on the section backdrop at their times.
const capsClip = join(assets, "capabilities.mp4");
if (caps) {
  const inputs = [...still(join(assets, "section.png"), capsLen)];
  caps.tiles.forEach((t, i) => inputs.push(...still(join(assets, `tile-${i}.png`), capsLen - t.at)));
  const f = [`[0:v]format=rgba[t0]`];
  caps.tiles.forEach((t, i) => {
    const { x, y } = tilePos(i);
    f.push(`[${i + 1}:v]format=rgba,fade=t=in:st=0:d=0.5:alpha=1,setpts=PTS-STARTPTS+${t.at}/TB[tile${i}]`);
    f.push(`[t${i}][tile${i}]overlay=x=${x}:y='${y}+24*max(0,1-(t-${t.at})/0.5)':eof_action=pass[t${i + 1}]`);
  });
  f.push(`[t${caps.tiles.length}]format=yuv420p,setsar=1[vout]`);
  console.log("Rendering the capabilities…");
  run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f.join(";"), "-map", "[vout]", ...encode, "-crf", "16", "-t", String(capsLen), capsClip]);
}

// Each scene on the stage: phones with rounded corners and their frame on the
// background, and its chapter title, in after a beat and out at the end.
const sceneClips = scenes.map((s, j) => {
  const clip = join(assets, `scene-${j}.mp4`);
  const inputs = [
    "-i", s.video,
    ...still(join(assets, "background.png"), s.duration),
    ...still(join(assets, "frame.png"), s.duration),
    ...still(join(assets, "mask-ios.png"), s.duration),
    ...still(join(assets, "mask-android.png"), s.duration),
    ...still(join(assets, "labels.png"), s.duration),
    ...still(join(assets, `chapter-${j}.png`), s.duration),
  ];
  const f = [
    `[0:v]fps=30,split=2[s1][s2]`,
    `[s1]crop=${iosSrcW}:${srcH}:0:0,scale=${iosW}:${PHONE_H},format=rgba[pi]`,
    `[3:v]format=gray,scale=${iosW}:${PHONE_H}[mi]`,
    `[pi][mi]alphamerge[ai]`,
    `[s2]crop=${andSrcW}:${srcH}:${andSrcX}:0,scale=${andW}:${PHONE_H},format=rgba[pa]`,
    `[4:v]format=gray,scale=${andW}:${PHONE_H}[ma]`,
    `[pa][ma]alphamerge[aa]`,
    `[1:v]format=rgba[bg]`,
    `[bg][2:v]overlay=0:0[b1]`,
    `[b1][ai]overlay=${iosX}:${PHONE_Y}[b2]`,
    `[b2][aa]overlay=${andX}:${PHONE_Y}[b3]`,
    `[b3][5:v]overlay=0:0[b4]`,
    `[6:v]format=rgba,fade=t=in:st=0.3:d=0.8:alpha=1,fade=t=out:st=${(s.duration - 0.7).toFixed(3)}:d=0.5:alpha=1[ch]`,
    `[b4][ch]overlay=${CAPTION.x}:${CAPTION.y},format=yuv420p,setsar=1[vout]`,
  ];
  console.log(`Rendering ${s.name}…`);
  run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f.join(";"), "-map", "[vout]", ...encode, "-crf", "16", "-t", s.duration.toFixed(3), clip]);
  return clip;
});

// The video: every part crossfaded into the next; the voice lines, and the music
// ducked under them.
const music = join(outDir, "music.mp3");
const inputs = [...still(join(assets, "intro.png"), INTRO)];
if (caps) inputs.push("-i", capsClip);
sceneClips.forEach((c) => inputs.push("-i", c));
inputs.push(...still(join(assets, "outro.png"), length - outroAt));
const videoInputs = parts.length + 1;
const voiceBase = videoInputs;
placed.forEach((p) => inputs.push("-i", p.file));
const musicIn = existsSync(music) ? voiceBase + placed.length : -1;
if (musicIn >= 0) inputs.push("-stream_loop", "-1", "-i", music);

const f = [];
for (let k = 0; k < videoInputs; k++) f.push(`[${k}:v]setpts=PTS-STARTPTS,fps=30,format=yuv420p,setsar=1,settb=AVTB[p${k}]`);
let acc = "p0";
for (let k = 1; k < videoInputs; k++) {
  const label = k === videoInputs - 1 ? "vx" : `x${k}`;
  f.push(`[${acc}][p${k}]xfade=transition=fade:duration=${FADE}:offset=${startOfPart(k).toFixed(3)}[${label}]`);
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
console.log(`${out} (${length.toFixed(1)} s, ${caps ? `${caps.tiles.length} tiles, ` : ""}${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ${placed.length} lines${musicIn >= 0 ? ", music" : ""})`);
