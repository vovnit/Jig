// Copies the core bundle, the shared native host glue, demo specs and the bundled sounds into the native apps, which load them
// from their bundles. Run after `npm run build -w core` (see `npm run build:native`).
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [join(root, "ios/Jig/Jig/Runtime"), join(root, "android/Jig/app/src/main/assets/runtime")];
const specs = readdirSync(join(root, "specs")).filter((f) => f.endsWith(".json"));
const sounds = readdirSync(join(root, "assets/sounds")).filter((f) => f.endsWith(".wav"));

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "core/dist/jig-core.js"), join(dir, "jig-core.js"));
  cpSync(join(root, "core/native/host.js"), join(dir, "jig-host.js"));
  for (const f of specs) cpSync(join(root, "specs", f), join(dir, f));
  // `@chime` and the other named sounds an app can play without a file.
  for (const f of sounds) cpSync(join(root, "assets/sounds", f), join(dir, "sounds", f), { recursive: true });
  console.log(`runtime → ${dir.slice(root.length + 1)} (jig-core.js, jig-host.js, ${specs.length} specs, ${sounds.length} sounds)`);
}
