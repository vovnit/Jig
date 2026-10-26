// Copies the core bundle and demo specs into the native apps, which load them
// from their bundles. Run after `npm run build -w core` (see `npm run build:native`).
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [join(root, "ios/Jig/Jig/Runtime"), join(root, "android/Jig/app/src/main/assets/runtime")];
const specs = readdirSync(join(root, "specs")).filter((f) => f.endsWith(".json"));

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "core/dist/jig-core.js"), join(dir, "jig-core.js"));
  for (const f of specs) cpSync(join(root, "specs", f), join(dir, f));
  console.log(`runtime → ${dir.slice(root.length + 1)} (jig-core.js, ${specs.length} specs)`);
}
