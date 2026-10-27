import "./style.css";
import { type AppSpec, type FrameStats, type Op, Runtime, installBuilder, runningApp, seedApps, updateApp } from "@jig/core";
import { openDatabase } from "./db.ts";
import { DomHost } from "./host.ts";
import shell from "../../specs/shell.json";
import water from "../../specs/water.json";
import chores from "../../specs/chores.json";
import meds from "../../specs/meds.json";
import showcase from "../../specs/showcase.json";

const SEEDS = [chores, meds, showcase, water] as unknown as AppSpec[];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const surface = $<HTMLDivElement>("#surface");
const specInput = $<HTMLTextAreaElement>("#spec");
const specStatus = $<HTMLDivElement>("#spec-status");

const host = new DomHost(surface);
host.db = await openDatabase();
// The phone runs the shell, as on iOS and Android; the panels follow the app running in it.
const runtime = new Runtime(host, { trusted: true });
host.runtime = runtime;
// For poking at the playground from the console.
if (import.meta.env.DEV) Object.assign(window, { jig: { runtime, host } });

// ---------- Viewport ----------
new ResizeObserver(() => runtime.setViewport(surface.clientWidth, surface.clientHeight, [12, 0, 0, 0])).observe(surface);
runtime.setViewport(surface.clientWidth, surface.clientHeight, [12, 0, 0, 0]);

// ---------- Appearance: follow the system, as the native hosts do ----------
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
runtime.setColorScheme(darkQuery.matches ? "dark" : "light");
darkQuery.addEventListener("change", (e) => {
  runtime.setColorScheme(e.matches ? "dark" : "light");
  applyThemeVars();
});

/** Native-styled controls (toggle, focus ring) and the surface read these. */
function applyThemeVars(): void {
  surface.style.setProperty("--jig-accent", runtime.theme.accent);
  surface.style.setProperty("--jig-off", runtime.theme.border);
  surface.style.background = runtime.theme.background;
}

installBuilder(runtime);
runtime.load(shell as unknown as AppSpec, { fresh: true });
seedApps(runtime, SEEDS);
applyThemeVars();

/** The app the panels show: the one running in the shell, or the shell itself. */
const target = () => runningApp(runtime) ?? runtime;
let shownSpec: AppSpec | null = null;

/** Shows the target's spec, unless it is already shown or being edited. */
function showSpec(): void {
  const spec = target().spec;
  if (spec === shownSpec || document.activeElement === specInput) return;
  shownSpec = spec;
  specInput.value = JSON.stringify(spec, null, 2);
  setStatus();
}

// ---------- Live editing: the spec is data, so edits apply instantly ----------
let editTimer = 0;
specInput.addEventListener("input", () => {
  clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    let spec: AppSpec;
    try {
      spec = JSON.parse(specInput.value);
    } catch (e) {
      setStatus((e as Error).message, true);
      return;
    }
    const app = runningApp(runtime);
    // An app in the shell is changed in the shell's list, so the edit is saved with it.
    if (app) updateApp(runtime, app.spec.id, spec);
    else runtime.load(spec);
    shownSpec = spec;
    applyThemeVars();
    setStatus();
  }, 250);
});
specInput.addEventListener("blur", showSpec);

function setStatus(msg?: string, error = false): void {
  const errs = target().errors;
  if (msg) specStatus.textContent = msg;
  else if (errs.length) {
    specStatus.textContent = errs.slice(0, 3).map((e) => `${e.where}: ${e.message}`).join("\n");
    error = true;
  } else specStatus.textContent = "Spec applied. Edit to see changes live.";
  specStatus.classList.toggle("error", error);
}

$<HTMLButtonElement>("#reset").onclick = () => target().resetData();

// ---------- Inspector ----------
const tabs = $<HTMLDivElement>("#tabs");
tabs.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).dataset.tab;
  if (!tab) return;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.classList.toggle("hidden", t.dataset.tab !== tab);
});

const opsView = $<HTMLPreElement>("#ops");
const statsView = $<HTMLPreElement>("#stats");
const dataView = $<HTMLPreElement>("#data");

host.onApply = (ops: Op[]) => {
  const lines = ops.slice(0, 200).map((o) => JSON.stringify(o));
  if (ops.length > 200) lines.push(`… ${ops.length - 200} more`);
  opsView.textContent = `Last batch: ${ops.length} ops\n\n${lines.join("\n")}`;
  const rt = target();
  const data: Record<string, unknown> = {};
  for (const k of rt.dataKeys) data[k] = rt.secretKeys.has(k) && rt.get(k) ? "•••• (secret)" : rt.get(k);
  dataView.textContent = JSON.stringify(data, null, 2);
  showSpec();
};

runtime.onStats = (s: FrameStats) => {
  if (s.ops === 0) return;
  const ms = (v: number) => `${v.toFixed(2)} ms`;
  statsView.textContent = [
    `bindings        ${ms(s.bindingsMs)}`,
    `layout          ${ms(s.layoutMs)}`,
    `measure         ${ms(s.measureMs)}  (${s.measureCalls} calls, ${s.measureCacheHits} cached)`,
    `apply (DOM)     ${ms(s.applyMs)}`,
    `ops             ${s.ops}`,
    `layout cache    ${s.layoutCacheHits} hits, ${s.skippedSubtrees} subtrees skipped`,
  ].join("\n");
  if (target().errors.length) setStatus();
};

showSpec();
