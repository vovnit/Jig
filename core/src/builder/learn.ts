// Learning: while an app learns, the shell records how it is used; when the
// session ends, the model looks at the record and may make one small change.
// Commits go through `commitEdit`, so the builder's Undo works too. The log goes
// nowhere visible; progress shows on the shell's `learning` state instead.
import type { Runtime, Interaction } from "../runtime.ts";
import type { AppSpec } from "../spec.ts";
import type { AppEntry, Lesson } from "./registry.ts";
import { commitEdit, findApp, undoEdit } from "./registry.ts";
import { callResponses, modelSpec, tryPatch } from "./agent.ts";
import type { AgentDeps, ModelSettings } from "./agent.ts";
import { sha256Hex } from "../sha256.ts";
import { specProblems } from "./validate.ts";
import { DataStore } from "../store.ts";

const LEARN_SYSTEM = `You improve a small app by watching how one person uses it. You get the app's spec, a summary of its data (no values), your notes from earlier sessions, the changes you made before (and which ones the person undid), and what they did since then.

Change something only when the record shows a clear pattern or friction:
- something done the same way 3 or more times that could be one tap (a default, a preset, a shortcut, the last value prefilled);
- a frequent action that is hard to reach (far down, behind a screen);
- going back and forth between screens to do one thing;
- repeated errors or corrections.

Make at most one small change per session, through apply_patch: reorder, set a default, add a shortcut button, rename a confusing label, prefill a field, or move a frequent item up. Never remove a feature or a screen, never delete or rename data, never add capabilities, code or network, and never undo the person's own edits. Never repeat a change they undid. If nothing is clear yet, change nothing. Most sessions should change nothing.

Always end with finish: your notes (what this person does and how, what you've tried, what they undid, at most 2000 characters; keep what still matters from the old notes) and one plain sentence for the person about what you changed and why ("Running is now first, since you log it most"), or "" if you changed nothing.`;

/** Model calls per learning run. */
const MAX_STEPS = 6;

function learnTools() {
  return [
    {
      type: "function",
      name: "apply_patch",
      description: "Change the app with JSON Patch ops on the whole spec. Rejected with errors if the result doesn't render.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "remove", "replace", "move", "copy"] },
                path: { type: "string", description: "JSON Pointer into the spec, such as /screens/main/body/children/0" },
                value: { description: "The JSON value for add and replace" },
                from: { type: "string" },
              },
              required: ["op", "path"],
              additionalProperties: false,
            },
          },
        },
        required: ["patch"],
      },
    },
    {
      type: "function",
      name: "finish",
      description: "End with your updated notes and one sentence for the person about what changed, or \"\" for no change.",
      parameters: {
        type: "object",
        properties: {
          notes: { type: "string", description: "What this person does and how, at most 2000 characters" },
          change: { type: "string", description: "One plain sentence about what changed and why, or \"\" for no change" },
        },
        required: ["notes", "change"],
      },
    },
  ];
}

/** One compact line per event, like `+12s main tap button "Add" [screens.main.body.children[3]]`. */
export function formatEvents(events: Interaction[]): string {
  const lines: string[] = [];
  let prev = "";
  let prevKey = "";
  let count = 0;
  const flush = () => {
    if (prev) lines.push(count > 1 ? `${prev} ×${count}` : prev);
  };
  for (const e of events) {
    let line = `+${Math.round(e.t / 1000)}s ${e.screen} ${e.kind}`;
    if (e.type) line += ` ${e.type}`;
    if (e.label) line += ` "${e.label}"`;
    if (e.value !== undefined) line += ` ${JSON.stringify(e.value)}`;
    if (e.detail) line += ` ${e.detail}`;
    if (e.path) line += ` [${e.path}]`;
    // Consecutive identical kind/path/value entries merge into one with ×n.
    const key = `${e.kind}|${e.path}|${JSON.stringify(e.value ?? null)}`;
    if (key === prevKey) {
      count++;
      continue;
    }
    flush();
    prev = line;
    prevKey = key;
    count = 1;
  }
  flush();
  return lines.join("\n");
}

/** For each data key its kind, and for lists the length and field names, never values. */
export function summarizeData(spec: AppSpec, data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, field] of Object.entries(spec.data ?? {})) {
    const def = field as { type?: string; fields?: Record<string, unknown> };
    const kind = typeof field === "string" ? field : (def.type ?? "string");
    if (kind !== "list") {
      lines.push(`- ${key}: ${kind}`);
      continue;
    }
    const items = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
    let fields: string[];
    if (def && typeof def === "object" && def.fields && typeof def.fields === "object") {
      fields = Object.keys(def.fields);
    } else {
      const seen = new Set<string>();
      for (const item of items) {
        if (item && typeof item === "object" && !Array.isArray(item)) for (const k of Object.keys(item)) seen.add(k);
      }
      fields = [...seen];
    }
    lines.push(`- ${key}: list (${items.length} items${fields.length ? `; fields: ${fields.join(", ")}` : ""})`);
  }
  return lines.join("\n");
}

export function learnInput(spec: AppSpec, dataSummary: string, notes: string, lessons: Lesson[], events: Interaction[]): string {
  const lessonLines = lessons.length
    ? lessons.map((l) => `- ${new Date(l.at).toISOString().slice(0, 10)}: ${l.text}${l.undone ? " (undone)" : ""}`).join("\n")
    : "(none yet)";
  return [
    `The app's spec:\n\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``,
    `Data (kinds and sizes, never values):\n${dataSummary || "(no data)"}`,
    `Your notes from earlier sessions:\n${notes || "(none)"}`,
    `Changes you made before:\n${lessonLines}`,
    `What they did since then:\n${formatEvents(events)}`,
  ].join("\n\n");
}

/**
 * Refuses a learning commit that would add capabilities, scripts, libraries,
 * `network`, publish or shared; remove a data key or change a data key's kind;
 * or remove a screen. Returns the reason, or null when the change may land.
 */
export function learnGuard(before: AppSpec, next: AppSpec): string | null {
  const hadCaps = new Set(before.capabilities ?? []);
  for (const c of next.capabilities ?? []) if (!hadCaps.has(c)) return `learning can't add capabilities ('${c}')`;
  if (JSON.stringify(next.scripts ?? {}) !== JSON.stringify(before.scripts ?? {})) return "learning can't add code";
  if (JSON.stringify(next.publish ?? {}) !== JSON.stringify(before.publish ?? {})) return "learning can't change sharing";
  if (JSON.stringify(next.read ?? []) !== JSON.stringify(before.read ?? [])) return "learning can't change sharing";
  for (const k of Object.keys(before.data ?? {})) {
    if (!(k in (next.data ?? {}))) return `learning can't remove data ('${k}')`;
    const was = (before.data?.[k] as { type?: string })?.type;
    const is = (next.data?.[k] as { type?: string })?.type;
    if (was !== is) return `learning can't change data ('${k}')`;
  }
  for (const s of Object.keys(before.screens ?? {})) {
    if (!(s in (next.screens ?? {}))) return `learning can't remove screens ('${s}')`;
  }
  return null;
}

export interface LearnOutcome {
  notes: string;
  change: string;
  committed: boolean;
  /** The app changed while the run worked: nothing was committed. */
  conflict?: boolean;
}

/** A committed spec's signature: a hash of its JSON, kept on the lesson. */
export function specSignature(spec: AppSpec): string {
  return sha256Hex(JSON.stringify(spec));
}

/** One learning run: at most 6 model calls, reasoning effort medium. Patches apply
 * to a working copy of the spec the run started with, so the whole run is one
 * history entry; it commits once, at `finish`, and only when the app's current
 * spec is still the one it started from. */
export async function runLearn(opts: {
  spec: AppSpec;
  notes: string;
  lessons: Lesson[];
  events: Interaction[];
  dataSummary: string;
  settings: ModelSettings;
  http: AgentDeps["http"];
  commit: (spec: AppSpec) => void;
  getSpec?: () => AppSpec;
}): Promise<LearnOutcome> {
  const beforeJson = JSON.stringify(opts.spec);
  const before = JSON.parse(beforeJson) as AppSpec;
  let working = JSON.parse(beforeJson) as AppSpec;
  let dirty = false;
  const conversation: unknown[] = [{
    role: "user",
    content: [{ type: "input_text", text: learnInput(modelSpec(before), opts.dataSummary, opts.notes, opts.lessons, opts.events) }],
  }];
  const tools = learnTools();
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await callResponses(opts.http, opts.settings, { instructions: LEARN_SYSTEM, tools, input: conversation, effort: "medium" });
    conversation.push(
      ...response.output
        .filter((o) => o.type !== "reasoning")
        .map((o) => (o.type === "function_call" && !parses(o.arguments ?? "{}") ? { ...o, arguments: "{}" } : o)),
    );
    const calls = response.output.filter((o): o is { type: string; call_id: string; name: string; arguments?: string } & Record<string, unknown> => o.type === "function_call");
    if (!calls.length) {
      conversation.push({ role: "user", content: [{ type: "input_text", text: "Call apply_patch to make the change, then finish with your notes and what changed." }] });
      continue;
    }
    let done: { notes: string; change: string; call_id: string } | null = null;
    for (const call of calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        conversation.push({ type: "function_call_output", call_id: call.call_id, output: "The arguments weren't valid JSON. Send them again as JSON." });
        continue;
      }
      if (call.name === "apply_patch") {
        const r = tryPatch(working, args.patch);
        if ("error" in r) {
          conversation.push({ type: "function_call_output", call_id: call.call_id, output: r.error });
          continue;
        }
        const guard = learnGuard(before, r.next);
        if (guard) {
          conversation.push({ type: "function_call_output", call_id: call.call_id, output: `Not applied: ${guard}.` });
          continue;
        }
        working = r.next;
        dirty = dirty || JSON.stringify(working) !== beforeJson;
        conversation.push({ type: "function_call_output", call_id: call.call_id, output: "Applied. It lands when you finish." });
      } else if (call.name === "finish") {
        done = { notes: String(args.notes ?? ""), change: String(args.change ?? ""), call_id: call.call_id };
        break;
      } else {
        conversation.push({ type: "function_call_output", call_id: call.call_id, output: `Unknown tool '${call.name}'.` });
      }
    }
    if (done) {
      // The app may have changed while the run worked: then it learned from an old copy, so
      // nothing lands and the events wait for the next run.
      let changed: boolean;
      try {
        changed = Boolean(opts.getSpec) && JSON.stringify(opts.getSpec!()) !== beforeJson;
      } catch {
        changed = true;
      }
      if (changed) {
        conversation.push({ type: "function_call_output", call_id: done.call_id, output: "ok" });
        return { notes: done.notes, change: "", committed: false, conflict: true };
      }
      if (!done.change || !dirty || JSON.stringify(working) === beforeJson) {
        conversation.push({ type: "function_call_output", call_id: done.call_id, output: "ok" });
        return { notes: done.notes, change: "", committed: false };
      }
      // The working copy must finish the way the builder's finish does: a broken
      // navigation (or any other invalid spec) goes back as errors, not a commit.
      const { errors, unfinished } = specProblems(working);
      const problems = [...errors, ...unfinished];
      if (problems.length) {
        conversation.push({ type: "function_call_output", call_id: done.call_id, output: `Not finished, the spec has errors:\n${problems.slice(0, 12).join("\n")}\nFix these, then finish.` });
        done = null;
        continue;
      }
      conversation.push({ type: "function_call_output", call_id: done.call_id, output: "ok" });
      opts.commit(working);
      return { notes: done.notes, change: done.change, committed: true };
    }
  }
  return { notes: opts.notes, change: "", committed: false };
}

const parses = (json: string) => {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
};

/** The shell's `learning` state: the run in progress, or its outcome for the home card. */
export interface LearningState {
  id: string;
  appName: string;
  status: "working" | "changed" | "unchanged" | "error";
  text: string;
  /** The lesson `changed` undid, so the home card's Undo names it. */
  at?: number;
}

/** Sessions, the trigger and the learning services. Wired from `installBuilder`. */
export function installLearn(shell: Runtime): void {
  let session: { id: string; start: number; events: Interaction[] } | null = null;
  let running = false;
  /** Bumped by `forgetLearning` and `setLearning`, per app: a run that finishes after one commits nothing. */
  const generations = new Map<string, number>();

  shell.onInteraction = (app, e) => {
    if (!session || app !== session.id) return;
    const top = shell.nav.peek().at(-1);
    if (top?.screen !== "run" || String((top.params as Record<string, unknown> | undefined)?.id ?? "") !== app) return;
    if (!findApp(shell, app)?.learning) return;
    session.events.push({ ...e, t: Date.now() - session.start });
  };

  const prev = shell.onFrame;
  shell.onFrame = () => {
    prev?.();
    check();
  };

  // A session starts when `run` shows a learning app, and ends when the stack no
  // longer shows it there (Done, the back gesture, or Change), like background.ts.
  const check = () => {
    const top = shell.nav.peek().at(-1);
    const id = top?.screen === "run" ? String((top.params as Record<string, unknown> | undefined)?.id ?? "") : "";
    if (id && findApp(shell, id)?.learning) {
      if (!session || session.id !== id) {
        if (session) endSession(session);
        session = { id, start: Date.now(), events: [] };
      }
      return;
    }
    if (session) {
      const done = session;
      session = null;
      endSession(done);
    }
  };

  const endSession = (s: { id: string; events: Interaction[] }) => {
    if (!s.events.length || !findApp(shell, s.id)) return;
    const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
    shell.set("apps", apps.map((a) => (a.id === s.id ? { ...a, learnEvents: [...(a.learnEvents ?? []), ...s.events].slice(-400) } : a)));
    void maybeLearn(s.id);
  };

  const maybeLearn = async (id: string) => {
    if (running) return;
    const entry = findApp(shell, id);
    if (!entry?.learning) return;
    if (!String(shell.get("apiKey") ?? "")) return;
    const events = entry.learnEvents ?? [];
    if (events.filter((e) => e.kind !== "navigate" && e.kind !== "back").length < 8) return;
    if (shell.get("busy")) return;
    running = true;
    // Events this run was given: sessions that end while it works append more,
    // which wait for the next run instead.
    const given = [...events];
    const givenSet = new Set(given);
    const startGen = generations.get(id) ?? 0;
    const appName = entry.spec.name;
    shell.set("learning", { id, appName, status: "working", text: "" } satisfies LearningState);
    try {
      const out = await runLearn({
        spec: entry.spec,
        notes: entry.learnNotes ?? "",
        lessons: entry.lessons ?? [],
        events: given,
        dataSummary: summarizeData(entry.spec, storedData(shell, entry.spec)),
        settings: {
          apiKey: String(shell.get("apiKey") ?? ""),
          model: String(shell.get("model") || "muse-spark-1.3"),
          baseUrl: String(shell.get("baseUrl") || "https://api.meta.ai/v1"),
        },
        http: (req, onLine) =>
          shell.hostCall("http", req as unknown as Record<string, unknown>, onLine && ((u) => typeof u.line === "string" && onLine(u.line))),
        commit: (spec) => {
          // A forget or toggle while the run worked: commit nothing.
          if ((generations.get(id) ?? 0) !== startGen) return;
          if (!findApp(shell, id)?.learning) return;
          commitEdit(shell, id, { ...spec, id });
        },
        getSpec: () => findApp(shell, id)?.spec as AppSpec,
      });
      const latest = findApp(shell, id);
      const current = (latest?.learnEvents ?? []);
      // A forget (or learning turned off) while the run worked: commit nothing,
      // save no notes or lessons. Its events are forgotten with it.
      if ((generations.get(id) ?? 0) !== startGen || !latest?.learning) {
        const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
        const rest = current.filter((e) => !givenSet.has(e));
        if (latest) shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnEvents: rest } : a)));
        const learning = shell.get("learning") as LearningState | null;
        if (learning?.id === id) shell.set("learning", null);
        return;
      }
      const notes = out.notes.slice(0, 2000);
      const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
      if (out.conflict) {
        // The app changed while learning worked: commit nothing, keep the events.
        const latestName = findApp(shell, id)?.spec.name ?? appName;
        shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnNotes: notes } : a)));
        shell.set("learning", { id, appName: latestName, status: "unchanged", text: `${latestName} changed while learning; it will look again next time.` } satisfies LearningState);
      } else if (out.change && out.committed) {
        const rest = current.filter((e) => !givenSet.has(e));
        const committed = findApp(shell, id)?.spec as AppSpec;
        const lesson: Lesson = { at: Date.now(), text: out.change, specHash: specSignature(committed) };
        shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnNotes: notes, lessons: [...(a.lessons ?? []), lesson].slice(-20), learnEvents: rest } : a)));
        shell.set("learning", { id, appName, status: "changed", text: out.change, at: lesson.at } satisfies LearningState);
      } else {
        const rest = current.filter((e) => !givenSet.has(e));
        shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnNotes: notes, learnEvents: rest } : a)));
        shell.set("learning", { id, appName, status: "unchanged", text: "" } satisfies LearningState);
      }
    } catch (e) {
      // A cancelled run clears its card instead of showing an error: a forget
      // (or learning turned off) while it worked. Turning learning off also
      // drops its events, just as on success.
      const latest = findApp(shell, id);
      if ((generations.get(id) ?? 0) !== startGen || !latest?.learning) {
        const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
        const rest = (latest?.learnEvents ?? []).filter((e) => !givenSet.has(e));
        if (latest) shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnEvents: rest } : a)));
        const learning = shell.get("learning") as LearningState | null;
        if (learning?.id === id) shell.set("learning", null);
        return;
      }
      shell.set("learning", { id, appName, status: "error", text: (e as Error).message } satisfies LearningState);
    } finally {
      running = false;
    }
  };

  shell.services.set("builder.setLearning", (args) => {
    const id = String(args.id ?? "");
    if (!id) return;
    generations.set(id, (generations.get(id) ?? 0) + 1);
    const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
    shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learning: Boolean(args.on) } : a)));
  });

  shell.services.set("builder.forgetLearning", (args) => {
    const id = String(args.id ?? "");
    if (!id) return;
    generations.set(id, (generations.get(id) ?? 0) + 1);
    const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
    shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnNotes: "", lessons: [], learnEvents: [] } : a)));
  });

  shell.services.set("builder.learnUndo", (args) => undoLearn(shell, String(args.id ?? ""), Number(args.at)));
}

export function undoLearn(shell: Runtime, id: string, at: number): void {
  if (!id) return;
  const entry = findApp(shell, id);
  if (!entry) return;
  const lessons = entry.lessons ?? [];
  // Only the newest lesson that isn't undone gets an Undo.
  let target = -1;
  for (let i = lessons.length - 1; i >= 0; i--) {
    if (!lessons[i].undone) {
      target = i;
      break;
    }
  }
  if (target < 0) return;
  const lesson = lessons[target];
  const changedSince = `${entry.spec.name} has changed since; undo it in the builder.`;
  if (at !== lesson.at) {
    shell.set("learning", { id, appName: entry.spec.name, status: "error", text: changedSince } satisfies LearningState);
    return;
  }
  if (!lesson.specHash || specSignature(entry.spec) !== lesson.specHash) {
    shell.set("learning", { id, appName: entry.spec.name, status: "error", text: changedSince } satisfies LearningState);
    return;
  }
  undoEdit(shell, id);
  const cur = findApp(shell, id);
  if (!cur) return;
  // The undo line is always kept: old notes give way from the start instead.
  const line = `The person undid: ${lesson.text}`;
  const combined = cur.learnNotes ? `${cur.learnNotes}\n${line}` : line;
  const notes = combined.length > 2000 ? combined.slice(-2000) : combined;
  const apps = (shell.get("apps") as AppEntry[] | undefined) ?? [];
  shell.set("apps", apps.map((a) => (a.id === id ? { ...a, learnNotes: notes, lessons: (a.lessons ?? []).map((l, i) => (i === target ? { ...l, undone: true } : l)) } : a)));
  const learning = shell.get("learning") as LearningState | null;
  if (learning?.id === id) shell.set("learning", null);
}

function storedData(shell: Runtime, spec: AppSpec): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec.data ?? {})) {
    const def = field as { default?: unknown; type?: string };
    values[key] = def.default ?? (def.type === "list" ? [] : def.type === "number" ? 0 : def.type === "boolean" ? false : def.type === "object" ? {} : "");
  }
  if (shell.host.db) {
    try {
      Object.assign(values, new DataStore(shell.host.db, spec.id).read());
    } catch {
      // Stored data never breaks learning.
    }
  }
  return values;
}
