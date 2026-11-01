// Composes the side-by-side demo video from the iOS and Android takes.
//
// Usage: node scripts/demo-compose.mjs [scenario ...]
//
// Each scenario reads demo/out/<name>-{ios,android}.{mp4,json} and writes
// demo/out/<name>-side-by-side.mp4; then every scenario is concatenated in order
// into demo/out/side-by-side.mp4. Scenarios default to every
// demo/scenarios/*.json in name order (or, when that folder is missing, every take
// in demo/out). The two takes stay in step at every shared mark: each segment is
// padded on the shorter side by holding its last frame.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo/out");
const HEIGHT = 1920;
const GAP = 40;
const TAIL_SEC = 3;
const FRAME = 1 / 30;

/** Marks both takes have, in the order they appear in the iOS file. */
export function commonMarks(iosMarks, androidMarks) {
  const have = new Set(androidMarks.map((m) => m.name));
  return iosMarks.filter((m) => have.has(m.name));
}

/**
 * Splits a scenario into segments both takes play in step: a lead-in ending at
 * each side's own first mark (both sides keep the shorter lead-in length, so the
 * first marks line up), one segment per mark pair, and a tail of [TAIL_SEC] s
 * past the last mark. Each entry is `{start, ios: [start, end], and: [start, end]}`
 * in video seconds (`(t - startedAt)/1000`), `start` naming the mark it begins at
 * (null for the lead-in). A `speed` set on an entry plays it faster.
 */
export function planSegments(iosMeta, androidMeta, tailSec = TAIL_SEC) {
  const iosByName = new Map((iosMeta.marks ?? []).map((m) => [m.name, m.t]));
  const andByName = new Map((androidMeta.marks ?? []).map((m) => [m.name, m.t]));
  const common = commonMarks(iosMeta.marks ?? [], androidMeta.marks ?? []);
  if (common.length === 0) return [];
  const at = (byName, startedAt, name) => Math.max(0, (byName.get(name) - startedAt) / 1000);
  const segments = [];
  // Each side's lead-in ends at its own first mark; both keep the shorter length.
  const firstIos = at(iosByName, iosMeta.startedAt, common[0].name);
  const firstAnd = at(andByName, androidMeta.startedAt, common[0].name);
  const leadLen = Math.min(firstIos, firstAnd);
  segments.push({ start: null, ios: [firstIos - leadLen, firstIos], and: [firstAnd - leadLen, firstAnd] });
  for (let k = 1; k < common.length; k++) {
    segments.push({
      start: common[k - 1].name,
      ios: [at(iosByName, iosMeta.startedAt, common[k - 1].name), at(iosByName, iosMeta.startedAt, common[k].name)],
      and: [at(andByName, androidMeta.startedAt, common[k - 1].name), at(andByName, androidMeta.startedAt, common[k].name)],
    });
  }
  const last = common[common.length - 1].name;
  segments.push({
    start: last,
    ios: [at(iosByName, iosMeta.startedAt, last), at(iosByName, iosMeta.startedAt, last) + tailSec],
    and: [at(andByName, androidMeta.startedAt, last), at(andByName, androidMeta.startedAt, last) + tailSec],
  });
  return segments;
}

const sec = (n) => String(Math.round(n * 1000) / 1000);

/** A take's real duration in seconds from `ffprobe`, or null when unknown. */
export function probeDuration(path) {
  // The video stream's end, not the container's: a recorder that only writes frames on
  // change (ReplayKit) can end its frames seconds before the file does.
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const n = Number.parseFloat((r.stdout ?? "").toString().trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * One `-filter_complex` for a scenario: per segment per side trim/setpts, hold the
 * shorter side's last frame, scale each side to [HEIGHT] px at 30 fps, concat each
 * side's segments, then stack iPhone left and Android right with a gap on `#111111`.
 * `durations` (`{ios, android}` in seconds, from `probeDuration`) clamps each trim
 * to the video's real end and holds the last frame for the missing time, so a take
 * that ends early still plays the full segment length in step with the other side.
 */
export function filterComplex(segments, durations = {}) {
  const iosDur = Number.isFinite(durations?.ios) ? durations.ios : Infinity;
  const andDur = Number.isFinite(durations?.android) ? durations.android : Infinity;
  const parts = [];
  const inputs = [];
  const ios = [];
  const and = [];
  segments.forEach((s, i) => {
    const speed = s.speed > 0 ? s.speed : 1;
    const dIos = s.ios[1] - s.ios[0];
    const dAnd = s.and[1] - s.and[0];
    const longest = Math.max(dIos, dAnd) / speed;
    for (const [labels, side, span] of [
      [ios, "ios", s.ios],
      [and, "android", s.and],
    ]) {
      const end = side === "ios" ? iosDur : andDur;
      // Clamp to what the recording holds; the rest is a held last frame. Only a segment
      // that starts at the recording's end holds that last frame throughout: two marks a
      // moment apart make a segment of almost nothing, which still plays one frame from
      // where it is (not the take's final frame, which would flash the end of the flow).
      let start = Math.min(span[0], end);
      let stop = Math.min(span[1], end);
      if (Number.isFinite(end) && start >= end - FRAME) start = Math.max(0, end - 0.1), stop = end;
      else if (stop - start < FRAME) stop = start + FRAME;
      const shown = (stop - start) / speed;
      const index = inputs.length;
      inputs.push({ side, start, duration: stop - start });
      const label = `s${i}${side === "ios" ? "ios" : "and"}`;
      const fast = speed !== 1 ? `,setpts=PTS/${speed}` : "";
      const hold = longest - shown > 0.0005 ? `,tpad=stop_mode=clone:stop_duration=${sec(longest - shown)}` : "";
      parts.push(`[${index}:v]setpts=PTS-STARTPTS${fast}${hold},fps=30[${label}]`);
      labels.push(`[${label}]`);
    }
  });
  parts.push(`${ios.join("")}concat=n=${ios.length}:v=1:a=0[vios]`);
  parts.push(`${and.join("")}concat=n=${and.length}:v=1:a=0[vand]`);
  parts.push(`[vios]pad=iw+${GAP}:ih:0:0:color=#111111[padded]`);
  parts.push(`[padded][vand]hstack=inputs=2[vout]`);
  return { filter: parts.join(";"), inputs };
}

/**
 * A take at a constant 30 fps and [HEIGHT] px tall, with a keyframe every second, so
 * every segment can seek straight to its start. (The recorders write frames only when
 * the screen changes; a segment starting on a still screen must still start there.)
 */
function constantRate(path) {
  const out = path.replace(/\.mp4$/, ".cfr.mp4");
  ffmpeg(["-v", "error", "-y", "-i", path, "-vf", `fps=30,scale=-2:${HEIGHT}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-g", "30", "-pix_fmt", "yuv420p", "-an", out]);
  return out;
}

/** When each mark plays in the composed video, and its length, in seconds. */
export function timeline(segments) {
  const marks = {};
  let t = 0;
  for (const s of segments) {
    if (s.start !== null && !(s.start in marks)) marks[s.start] = t;
    t += Math.max(s.ios[1] - s.ios[0], s.and[1] - s.and[0]) / (s.speed > 0 ? s.speed : 1);
  }
  return { duration: t, marks };
}

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", args, { stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const scenariosDir = join(root, "demo/scenarios");
  // `--speed generating=1.5,editing=2` plays the segments starting at those marks faster.
  const args = process.argv.slice(2);
  const speeds = {};
  const speedAt = args.indexOf("--speed");
  if (speedAt >= 0) {
    for (const pair of (args[speedAt + 1] ?? "").split(",")) {
      const [mark, factor] = pair.split("=");
      if (mark && Number(factor) > 0) speeds[mark] = Number(factor);
    }
    args.splice(speedAt, 2);
  }
  let scenarios = args.map((a) => a.replace(/\.json$/, ""));
  if (scenarios.length === 0) {
    scenarios = existsSync(scenariosDir)
      ? readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort()
      : readdirSync(outDir).filter((f) => f.endsWith("-ios.json")).map((f) => f.slice(0, -"-ios.json".length)).sort();
  }
  mkdirSync(outDir, { recursive: true });
  const parts = [];
  const timelines = [];
  for (const name of scenarios) {
    const iosMp4 = join(outDir, `${name}-ios.mp4`);
    const andMp4 = join(outDir, `${name}-android.mp4`);
    const missing = [iosMp4, andMp4, join(outDir, `${name}-ios.json`), join(outDir, `${name}-android.json`)].filter((f) => !existsSync(f));
    if (missing.length > 0) throw new Error(`${name}: missing ${missing.join(", ")}; run scripts/demo-record.mjs first.`);
    const iosMeta = JSON.parse(readFileSync(join(outDir, `${name}-ios.json`), "utf8"));
    const andMeta = JSON.parse(readFileSync(join(outDir, `${name}-android.json`), "utf8"));
    const segments = planSegments(iosMeta, andMeta);
    if (segments.length === 0) throw new Error(`${name}: no shared marks in the two metadata files.`);
    for (const seg of segments) if (seg.start !== null && speeds[seg.start]) seg.speed = speeds[seg.start];
    // The takes may end before the tail does; hold the last frame for the rest.
    const durations = {};
    const iosDur = probeDuration(iosMp4);
    const andDur = probeDuration(andMp4);
    if (iosDur != null) durations.ios = iosDur;
    if (andDur != null) durations.android = andDur;
    const out = join(outDir, `${name}-side-by-side.mp4`);
    const cfr = { ios: constantRate(iosMp4), android: constantRate(andMp4) };
    const { filter, inputs } = filterComplex(segments, durations);
    const args = inputs.flatMap((x) => ["-ss", sec(x.start), "-t", sec(Math.max(x.duration, 0.034)), "-i", cfr[x.side]]);
    ffmpeg(["-v", "error", "-y", ...args, "-filter_complex", filter, "-map", "[vout]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", out]);
    console.log(`${out}`);
    segments.forEach((s, i) => {
      const dIos = s.ios[1] - s.ios[0];
      const dAnd = s.and[1] - s.and[0];
      console.log(`  segment ${i}${s.start ? ` (${s.start})` : ""}: ios ${sec(dIos)}s, android ${sec(dAnd)}s${s.speed ? ` at ${s.speed}x` : ""}`);
    });
    parts.push(out);
    timelines.push({ name, ...timeline(segments) });
  }
  // Where each scenario and its marks fall in the joined video (for narration).
  let offset = 0;
  for (const tl of timelines) {
    tl.offset = offset;
    offset += tl.duration;
  }
  writeFileSync(join(outDir, "side-by-side-timeline.json"), JSON.stringify(timelines, null, 2) + "\n");
  const list = join(outDir, "side-by-side.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const joined = join(outDir, "side-by-side.mp4");
  ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  console.log(joined);
}
