import "./style.css";
import { type AppSpec, type FrameStats, type Op, Runtime } from "@jig/core";
import { openDatabase } from "./db.ts";
import { DomHost } from "./host.ts";
import water from "../../specs/water.json";
import chores from "../../specs/chores.json";
import meds from "../../specs/meds.json";
import showcase from "../../specs/showcase.json";

const APPS = [water, chores, meds, showcase] as unknown as AppSpec[];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const surface = $<HTMLDivElement>("#surface");
const specInput = $<HTMLTextAreaElement>("#spec");
const specStatus = $<HTMLDivElement>("#spec-status");


const host = new DomHost(surface);
host.db = await openDatabase();
const runtime = new Runtime(host);
host.runtime = runtime;

let current: AppSpec = APPS[0];

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

// ---------- App switching ----------
const list = $<HTMLElement>("#app-list");
function renderList(): void {
  list.replaceChildren(
    ...APPS.map((app) => {
      const b = document.createElement("button");
      b.className = app.id === current.id ? "active" : "";
      b.innerHTML = `${app.name}<small>${app.description ?? ""}</small>`;
      b.onclick = () => open(app);
      return b;
    }),
  );
}

function open(app: AppSpec): void {
  current = app;
  runtime.load(app, { fresh: true });
  applyThemeVars();
  specInput.value = JSON.stringify(app, null, 2);
  setStatus();
  renderList();
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
    const i = APPS.findIndex((a) => a.id === current.id);
    current = spec;
    if (i >= 0) APPS[i] = spec;
    runtime.load(spec);
    applyThemeVars();
    setStatus();
  }, 250);
});

function setStatus(msg?: string, error = false): void {
  const errs = runtime.errors;
  if (msg) specStatus.textContent = msg;
  else if (errs.length) {
    specStatus.textContent = errs.slice(0, 3).map((e) => `${e.where}: ${e.message}`).join("\n");
    error = true;
  } else specStatus.textContent = "Spec applied. Edit to see changes live.";
  specStatus.classList.toggle("error", error);
}

$<HTMLButtonElement>("#reset").onclick = () => runtime.resetData();

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
  const data: Record<string, unknown> = {};
  for (const k of runtime.dataKeys) data[k] = runtime.get(k);
  dataView.textContent = JSON.stringify(data, null, 2);
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
  if (runtime.errors.length) setStatus();
};

open(current);
