// Copies the core bundle, the shared native host glue, demo specs and the bundled sounds into the native apps, which load them
// from their bundles. Run after `npm run build -w core` (see `npm run build:native`).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [join(root, "ios/Jig/Jig/Runtime"), join(root, "android/Jig/app/src/main/assets/runtime")];
const specs = readdirSync(join(root, "specs")).filter((f) => f.endsWith(".json"));
const sounds = readdirSync(join(root, "assets/sounds")).filter((f) => f.endsWith(".wav"));
// Demo scenarios and model reply tapes, copied flat next to the specs (skipped by the
// hosts' seed lists); a tape is optional per scenario.
const scenariosDir = join(root, "demo/scenarios");
const tapesDir = join(root, "demo/tapes");
const scenarios = existsSync(scenariosDir) ? readdirSync(scenariosDir).filter((f) => f.endsWith(".json")) : [];
const tapes = existsSync(tapesDir) ? readdirSync(tapesDir).filter((f) => f.endsWith(".json")) : [];

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  // Stale demo bundles from renamed scenarios, before copying the current ones.
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("demo-") || f.startsWith("tape-")) rmSync(join(dir, f));
    }
  }
  cpSync(join(root, "core/dist/jig-core.js"), join(dir, "jig-core.js"));
  cpSync(join(root, "core/native/host.js"), join(dir, "jig-host.js"));
  for (const f of specs) cpSync(join(root, "specs", f), join(dir, f));
  for (const f of scenarios) cpSync(join(scenariosDir, f), join(dir, `demo-${f}`));
  for (const f of tapes) cpSync(join(tapesDir, f), join(dir, `tape-${f}`));
  // `@chime` and the other named sounds an app can play without a file.
  for (const f of sounds) cpSync(join(root, "assets/sounds", f), join(dir, "sounds", f), { recursive: true });
  console.log(`runtime → ${dir.slice(root.length + 1)} (jig-core.js, jig-host.js, ${specs.length} specs, ${scenarios.length} demos, ${tapes.length} tapes, ${sounds.length} sounds)`);
}
