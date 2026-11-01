// Produces the finished demo video: a title card, animated how-it-works sections, a
// showcase of scenarios with both phones framed on a 16:9 stage (a chapter title each),
// an end card, all crossfaded, with closed captions (and, with --voice, a voice-over).
//
// Usage: node scripts/demo-produce.mjs [--voice]
//
// Reads demo/captions.json (cards, sections, showcase), demo/narration.json (the
// script), demo/out/<name>-side-by-side.mp4 and the timeline from demo-compose.mjs, and
// writes demo/out/jig-demo.mp4 (captions burned in and as a subtitle track) and
// demo/out/jig-demo.srt. Sections animate demo/animations/scenes.html (demo-animate.mjs)
// and last as long as their lines need. Without --voice nothing calls a voice service:
// each line lasts its reading time. With --voice, lines are voiced by the provider in
// narration.json (Fish Audio with FISH_API_KEY, or ElevenLabs with ELEVENLABS_API_KEY)
// and cached in demo/out/voice. An optional demo/out/music.mp3 plays underneath.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { animate } from "./demo-animate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo/out");
const assets = join(outDir, "stage");
const voiceDir = join(outDir, "voice");

const INTRO = 4;
const OUTRO = 5;
const FADE = 0.6;
const GAP_SEC = 0.5;
const READING_WPS = 2.6; // words per second a caption stays up for, without a voice
// The stage: phones on the right, the chapter title on the left.
const PHONE_H = 940;
const PHONE_Y = 70;
const RADIUS = 44;
const CAPTION = { x: 120, y: 250, width: 660, height: 640 };
// Where closed captions sit: centered under a slide, or under the chapter title on the stage.
const SUB_CENTER = { x: 260, y: 1030, width: 1400, size: 36, align: "center" };
const SUB_STAGE = { x: 120, y: 1010, width: 660, size: 32, align: "left" };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(" ")}… failed`);
}

function probe(path, entries) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  return r.stdout.trim().split("\n").map(Number);
}

const voiced = process.argv.includes("--voice");

/** A caption's text: the line without its performance tags ("[excited]"). */
const caption = (s) => s.replace(/\[[^\]]*\]\s*/g, "").trim();

// The voice-over providers. Both take "[tag]" performance cues in the text.
const PROVIDERS = {
  // Fish Audio: POST /v1/tts with the model in a header; the voice is a model id.
  fish: {
    key: "FISH_API_KEY",
    request: (n, text, key) => fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", model: n.model },
      body: JSON.stringify({ text, reference_id: n.voice, format: "mp3", mp3_bitrate: 192, normalize: true, latency: "normal", ...(n.settings ?? {}) }),
    }),
  },
  elevenlabs: {
    key: "ELEVENLABS_API_KEY",
    request: (n, text, key) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${n.voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: n.model, ...(n.settings ? { voice_settings: n.settings } : {}) }),
    }),
  },
};

async function voice(text, n) {
  const provider = PROVIDERS[n.provider ?? "elevenlabs"];
  if (!provider) throw new Error(`Unknown voice provider '${n.provider}'`);
  const id = createHash("sha256").update(JSON.stringify([n.provider, n.voice, n.model, n.settings ?? null, text])).digest("hex").slice(0, 16);
  const file = join(voiceDir, `${id}.mp3`);
  if (existsSync(file)) return file;
  const key = process.env[provider.key];
  if (!key) throw new Error(`--voice with ${n.provider} needs ${provider.key}.`);
  const res = await provider.request(n, text, key);
  if (!res.ok) throw new Error(`${n.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const narration = JSON.parse(readFileSync(join(root, "demo/narration.json"), "utf8"));
const look = JSON.parse(readFileSync(join(root, "demo/captions.json"), "utf8"));
const composed = JSON.parse(readFileSync(join(outDir, "side-by-side-timeline.json"), "utf8"));
mkdirSync(assets, { recursive: true });
mkdirSync(voiceDir, { recursive: true });

// Every line's length: its voice, or its reading time.
const lines = [];
for (const line of narration.lines) {
  const text = caption(line.text);
  const file = voiced ? await voice(line.text, narration) : null;
  const length = file ? probe(file, "format=duration")[0] : Math.max(1.8, text.split(/\s+/).length / READING_WPS + 0.6);
  lines.push({ ...line, caption: text, file, length });
}

// The sections, each as long as its lines (one after another, with a beat at each end).
const sections = (look.sections ?? []).map((s, i) => {
  let t = 1.0;
  for (const l of lines.filter((x) => x.section === i)) {
    l.local = t;
    t += l.length + GAP_SEC;
  }
  return { ...s, duration: Math.max(8, t + 1.0) };
});

// The showcase scenarios.
const scenes = (look.showcase ?? composed.map((s) => s.name)).map((name) => {
  const s = composed.find((x) => x.name === name);
  if (!s) throw new Error(`No composed scenario '${name}'; run scripts/demo-compose.mjs ${name}`);
  const chapter = look.chapters.find((c) => c.scenario === name);
  if (!chapter) throw new Error(`No chapter for ${name}`);
  return { ...s, chapter, video: join(outDir, `${name}-side-by-side.mp4`) };
});

// The final timeline: intro, sections, scenes, end card, each crossfading into the next.
const parts = [INTRO, ...sections.map((s) => s.duration), ...scenes.map((s) => s.duration)];
const startOfPart = (k) => parts.slice(0, k).reduce((t, d) => t + d - FADE, 0);
const sectionAt = (i) => startOfPart(1 + i);
const sceneAt = (j) => startOfPart(1 + sections.length + j);
const outroAt = startOfPart(parts.length);

// Place every line: sections on their own schedule, the rest at their cue unless the
// line before is still up.
let free = 0;
const placed = [];
for (const l of lines) {
  let cue;
  if (l.section !== undefined) cue = sectionAt(l.section) + l.local;
  else if (l.at === "intro") cue = 0.6;
  else if (l.at === "outro") cue = outroAt + 0.5;
  else {
    const j = scenes.findIndex((x) => x.name === l.scenario);
    if (j < 0) continue; // a scenario left out of the showcase
    if (scenes[j].marks[l.at] === undefined) throw new Error(`No mark '${l.at}' in ${l.scenario}`);
    cue = sceneAt(j) + scenes[j].marks[l.at];
  }
  cue += l.delay ?? 0;
  const start = Math.max(cue, free);
  free = start + l.length + GAP_SEC;
  placed.push({ ...l, start, onStage: l.scenario !== undefined });
  const late = start - cue > 0.05 ? `  (${(start - cue).toFixed(1)} s late)` : "";
  console.log(`${start.toFixed(1).padStart(6)} s  ${l.length.toFixed(1)} s  ${l.caption.slice(0, 60)}${late}`);
}
const length = Math.max(outroAt + OUTRO, free - GAP_SEC + 1.5);

// Stills: cards, the stage furniture, chapter titles and the captions.
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
  ...placed.map((p, i) => ({ kind: "subtitle", out: join(assets, `sub-${i}.png`), text: p.caption, ...(p.onStage ? SUB_STAGE : SUB_CENTER) })),
];
writeFileSync(join(assets, "jobs.json"), JSON.stringify(jobs));
run("swift", [join(root, "scripts/demo-cards.swift"), join(assets, "jobs.json")]);

const still = (path, seconds) => ["-loop", "1", "-framerate", "30", "-t", seconds.toFixed(3), "-i", path];
const encode = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30"];

// The sections, animated. Long sections play their animation a little slower.
const sectionClips = [];
for (const [i, s] of sections.entries()) {
  const clip = join(assets, `section-${i}.mp4`);
  console.log(`Animating ${s.scene}…`);
  await animate(s.scene, s.duration, clip, { icon: s.icon, kicker: s.kicker, title: s.title, points: s.points }, Math.min(1, Math.max(0.65, 11 / s.duration)));
  sectionClips.push(clip);
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

// Closed captions as SubRip, for the subtitle track and alongside the video.
const stamp = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = join(outDir, "jig-demo.srt");
writeFileSync(srt, placed.map((p, i) => `${i + 1}\n${stamp(p.start)} --> ${stamp(p.start + p.length)}\n${p.caption}\n`).join("\n"));

// The video: every part crossfaded into the next, captions on top; the voice (if any)
// and the music under it.
const music = join(outDir, "music.mp3");
const inputs = [...still(join(assets, "intro.png"), INTRO)];
sectionClips.forEach((c) => inputs.push("-i", c));
sceneClips.forEach((c) => inputs.push("-i", c));
inputs.push(...still(join(assets, "outro.png"), length - outroAt));
const videoInputs = parts.length + 1;
const subBase = videoInputs;
placed.forEach((p, i) => inputs.push(...still(join(assets, `sub-${i}.png`), p.length)));
const voiceBase = subBase + placed.length;
const voices = placed.filter((p) => p.file);
voices.forEach((p) => inputs.push("-i", p.file));
const musicIn = existsSync(music) ? voiceBase + voices.length : -1;
if (musicIn >= 0) inputs.push("-stream_loop", "-1", "-i", music);
const srtIn = inputs.filter((x) => x === "-i").length;
inputs.push("-i", srt);

const f = [];
for (let k = 0; k < videoInputs; k++) f.push(`[${k}:v]setpts=PTS-STARTPTS,fps=30,format=yuv420p,setsar=1,settb=AVTB[p${k}]`);
let acc = "p0";
for (let k = 1; k < videoInputs; k++) {
  f.push(`[${acc}][p${k}]xfade=transition=fade:duration=${FADE}:offset=${startOfPart(k).toFixed(3)}[x${k}]`);
  acc = `x${k}`;
}
placed.forEach((p, i) => {
  f.push(`[${subBase + i}:v]format=rgba,fade=t=in:st=0:d=0.2:alpha=1,fade=t=out:st=${Math.max(0, p.length - 0.2).toFixed(3)}:d=0.2:alpha=1,setpts=PTS-STARTPTS+${p.start.toFixed(3)}/TB[sub${i}]`);
  f.push(`[${acc}][sub${i}]overlay=0:0:eof_action=pass[c${i}]`);
  acc = `c${i}`;
});
f.push(`[${acc}]fade=t=in:st=0:d=0.6,fade=t=out:st=${(length - 0.8).toFixed(3)}:d=0.8,format=yuv420p[vout]`);
const audio = [];
if (voices.length) {
  voices.forEach((p, i) => f.push(`[${voiceBase + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.start * 1000)}:all=1[n${i}]`));
  f.push(`${voices.map((_, i) => `[n${i}]`).join("")}amix=inputs=${voices.length}:normalize=0,apad=whole_dur=${length.toFixed(3)},volume=1.6[voice]`);
}
if (musicIn >= 0) {
  f.push(`[${musicIn}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${length.toFixed(3)},volume=${voices.length ? 0.12 : 0.2},afade=t=in:st=0:d=1.5,afade=t=out:st=${(length - 3).toFixed(3)}:d=3[bed]`);
  if (voices.length) {
    f.push(`[voice]asplit=2[voice1][key]`);
    f.push(`[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[ducked]`);
    f.push(`[voice1][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[aout]`);
  } else f.push(`[bed]alimiter=limit=0.95[aout]`);
  audio.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
} else if (voices.length) {
  f.push(`[voice]alimiter=limit=0.95[aout]`);
  audio.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
}

const out = join(outDir, "jig-demo.mp4");
console.log("Rendering the video…");
run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", f.join(";"), "-map", "[vout]", ...audio,
  "-map", `${srtIn}:s`, "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
  ...encode, "-crf", "19", "-t", length.toFixed(3), "-movflags", "+faststart", out]);
console.log(`${out} (${length.toFixed(1)} s, ${sections.length} sections, ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ${placed.length} captions${voices.length ? ", voiced" : ""}${musicIn >= 0 ? ", music" : ""})\n${srt}`);
