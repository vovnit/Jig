// Records scripted demo takes on a physical iPhone and Android phone at the same time.
//
// Usage: node scripts/demo-record.mjs [--ios <udid>] [--android <serial>] [--no-build] [scenario ...]
//
// Scenarios default to every demo/scenarios/*.json in name order. Devices default to
// the first connected physical iPhone and the first `adb` device; either platform may
// be absent, then it is skipped with a message. Both phones must be unlocked and
// connected: the iPhone trusted and in Developer Mode, Android USB debugging on. The
// iPhone shows ReplayKit's "Allow screen recording" prompt at the start of each
// scenario; accept it so the take records.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "demo/out");
const scenariosDir = join(root, "demo/scenarios");
const IOS_BUNDLE = "dev.nitochkin.Jig";
const ANDROID_ACTIVITY = "dev.nitochkin.jig/.MainActivity";
// screenrecord stops by itself at 180 s, so the run waits a little past that.
const DONE_TIMEOUT = 200_000;
const WARN_AFTER = 175_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${(r.stderr ?? "").toString().trim()}`);
  return (r.stdout ?? "").toString();
}

function runInherit(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

const adb = (serial, ...args) => run("adb", ["-s", serial, ...args]);

/** The connected physical iPhone's udid, or null. */
function firstIPhone() {
  const tmp = mkdtempSync(join(tmpdir(), "jig-devices-"));
  try {
    const out = join(tmp, "devices.json");
    if (spawnSync("xcrun", ["devicectl", "list", "devices", "--json-output", out], { encoding: "utf8" }).status !== 0) return null;
    const json = JSON.parse(readFileSync(out, "utf8"));
    const devices = json?.result?.devices ?? json?.devices ?? [];
    const phone = devices.find((d) => {
      const hw = d?.hardwareProperties ?? {};
      const conn = d?.connectionProperties ?? {};
      return hw.reality === "physical" && hw.deviceType === "iPhone" && conn.tunnelState === "connected";
    });
    return phone?.hardwareProperties?.udid ?? null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The first `adb` serial in state `device`, or null. */
function firstAndroid() {
  let out;
  try {
    out = run("adb", ["devices"]);
  } catch {
    return null;
  }
  for (const line of out.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === "device") return serial;
  }
  return null;
}

const argv = process.argv.slice(2);
let ios = null;
let android = null;
let noBuild = false;
const scenarios = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--ios") ios = argv[++i] ?? null;
  else if (a === "--android") android = argv[++i] ?? null;
  else if (a === "--no-build") noBuild = true;
  else if (a.startsWith("-")) {
    console.error(`Unknown flag ${a}`);
    process.exit(1);
  } else scenarios.push(a.replace(/\.json$/, ""));
}
if (scenarios.length === 0) {
  scenarios.push(...readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort());
}
if (ios === null) ios = firstIPhone();
if (android === null) android = firstAndroid();
if (ios === null) console.log("No iPhone found; skipping iOS.");
if (android === null) console.log("No Android device found; skipping Android.");
if (ios === null && android === null) {
  console.error("Nothing to record: no devices.");
  process.exit(1);
}

if (!noBuild) {
  runInherit("npm", ["run", "build:native"], { cwd: root });
  if (ios !== null) {
    runInherit(
      "xcodebuild",
      ["-project", "ios/Jig/Jig.xcodeproj", "-scheme", "Jig", "-configuration", "Debug", "-destination", `id=${ios}`, "-derivedDataPath", "build/ios", "-allowProvisioningUpdates", "build"],
      { cwd: root },
    );
    runInherit("xcrun", ["devicectl", "device", "install", "app", "--device", ios, "build/ios/Build/Products/Debug-iphoneos/Jig.app"], { cwd: root });
  }
  if (android !== null) {
    // Gradle needs a JDK; without JAVA_HOME, use Homebrew's openjdk@21 when it's there.
    const brewJdk = "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
    const javaHome = process.env.JAVA_HOME ?? (existsSync(brewJdk) ? brewJdk : undefined);
    runInherit("./gradlew", ["installDebug"], { cwd: join(root, "android/Jig"), env: { ...process.env, ANDROID_SERIAL: android, ...(javaHome ? { JAVA_HOME: javaHome } : {}) } });
  }
}

/** One `devicectl device copy from` out of the app container; the flags live here so there is one place to fix. */
function copyFrom(udid, source, destination) {
  return spawnSync(
    "xcrun",
    ["devicectl", "device", "copy", "from", "--device", udid, "--domain-type", "appDataContainer", "--domain-identifier", IOS_BUNDLE, "--source", source, "--destination", destination],
    { encoding: "utf8" },
  );
}

async function recordIos(name, udid) {
  const video = join(outDir, `${name}-ios.mp4`);
  const meta = join(outDir, `${name}-ios.json`);
  rmSync(video, { force: true });
  rmSync(meta, { force: true });
  const launchedAt = Date.now();
  runInherit("xcrun", ["devicectl", "device", "process", "launch", "--device", udid, "--terminate-existing", "--", IOS_BUNDLE, "-jigDemo", name]);
  // The take ends when the script writes its metadata next to the video; poll for it. The app
  // deletes the previous take's files at launch, but a copy may race that, so only metadata
  // started after this launch counts (the phone's clock may be a little off the Mac's).
  const deadline = Date.now() + 400_000;
  for (;;) {
    if (copyFrom(udid, `Documents/demo/${name}.json`, meta).status === 0 && freshTake(meta, launchedAt - 30_000)) break;
    if (Date.now() > deadline) throw new Error(`iOS take ${name}: timed out waiting for Documents/demo/${name}.json`);
    await sleep(5000);
  }
  const pulled = copyFrom(udid, `Documents/demo/${name}.mp4`, video);
  if (pulled.status !== 0) throw new Error(`iOS take ${name}: couldn't pull the video\n${(pulled.stderr ?? "").toString().trim()}`);
  console.log(`iOS take → ${video}\n   meta → ${meta}`);
  try {
    const iosMeta = JSON.parse(readFileSync(meta, "utf8"));
    if (typeof iosMeta.error === "string" && iosMeta.error) console.error(`iOS JIGDEMO error: ${iosMeta.error}`);
  } catch {
    // The take's metadata is already on disk; a missing error changes nothing.
  }
}

/** Whether pulled metadata is from a take started after `since` (epoch ms). */
function freshTake(path, since) {
  try {
    return Number(JSON.parse(readFileSync(path, "utf8")).startedAt) >= since;
  } catch {
    return false;
  }
}

/** The JIGDEMO payload of a logcat line, or null. */
function jigDemoOf(line) {
  const i = line.indexOf("JIGDEMO ");
  if (i < 0) return null;
  try {
    return JSON.parse(line.slice(i + "JIGDEMO ".length));
  } catch {
    return null;
  }
}

async function recordAndroid(name, serial) {
  const video = join(outDir, `${name}-android.mp4`);
  const meta = join(outDir, `${name}-android.json`);
  rmSync(video, { force: true });
  rmSync(meta, { force: true });
  // The device clock stamps the video, the host clock the launch: measure the offset
  // between them (the device time around the midpoint of the host's).
  const before = Date.now();
  const deviceMs = Number.parseInt(adb(serial, "shell", "date", "+%s%3N").trim(), 10);
  const after = Date.now();
  const offset = deviceMs - (before + after) / 2;
  adb(serial, "logcat", "-c");
  let buf = "";
  const logcat = spawn("adb", ["-s", serial, "logcat", "-s", "Jig:*"], { stdio: ["ignore", "pipe", "pipe"] });
  logcat.stdout.on("data", (d) => void (buf += d.toString()));
  logcat.stderr.on("data", () => {});
  logcat.on("error", () => {});
  // Note the host time the recorder starts; the metadata converts it to the device clock.
  const spawnedAt = Date.now();
  const rec = spawn("adb", ["-s", serial, "shell", "screenrecord", "--bit-rate", "12000000", "--time-limit", "180", `/sdcard/jig-${name}.mp4`], { stdio: "ignore" });
  rec.on("error", () => {});
  adb(serial, "shell", "am", "start", "-S", "-W", "-n", ANDROID_ACTIVITY, "--es", "jigDemo", name);
  const started = Date.now();
  const errors = [];
  const strayMarks = [];
  let tail = "";
  let done = null;
  let warned = false;
  while (Date.now() - started < DONE_TIMEOUT) {
    tail += buf;
    buf = "";
    const parts = tail.split("\n");
    tail = parts.pop() ?? "";
    for (const line of parts) {
      const msg = jigDemoOf(line);
      if (msg === null || typeof msg !== "object") continue;
      if (typeof msg.error === "string") {
        done = { error: msg.error };
        errors.push(msg.error);
      } else if (msg.done === true) {
        done = { marks: Array.isArray(msg.marks) ? msg.marks : strayMarks };
      } else if (msg.mark !== null && typeof msg.mark === "object" && typeof msg.mark.name === "string") {
        strayMarks.push(msg.mark);
      } else if (typeof msg.name === "string" && typeof msg.t === "number") {
        strayMarks.push(msg);
      }
    }
    if (done !== null) break;
    if (!warned && Date.now() - started > WARN_AFTER) {
      warned = true;
      console.warn(`Android take ${name} ran past 175 s; screenrecord stops itself at 180 s.`);
    }
    await sleep(500);
  }
  logcat.kill();
  try {
    adb(serial, "shell", "pkill", "-INT", "screenrecord");
  } catch {
    // Already stopped (it ends by itself at the time limit).
  }
  await sleep(2000);
  try {
    adb(serial, "pull", `/sdcard/jig-${name}.mp4`, video);
  } catch {
    console.error(`Android take ${name}: couldn't pull /sdcard/jig-${name}.mp4.`);
    return;
  }
  writeFileSync(meta, JSON.stringify({ startedAt: spawnedAt + offset, marks: done?.marks ?? strayMarks }));
  console.log(`Android take → ${video}\n       meta → ${meta}`);
  for (const e of errors) console.error(`Android JIGDEMO error: ${e}`);
  if (done === null) console.error(`Android take ${name}: timed out waiting for the done line.`);
}

mkdirSync(outDir, { recursive: true });
for (const name of scenarios) {
  console.log(`\n=== ${name} ===`);
  await Promise.all([ios !== null ? recordIos(name, ios) : null, android !== null ? recordAndroid(name, android) : null]);
}
