import { installBackground } from "./background.ts";
// The builder's services, which the trusted shell spec calls: `{"call": "builder.edit",
// "args": {"id": "app.id"}}`. They run the agent and report through the shell's state:
// `log` (the conversation), `busy`, and the app list itself (each edit is saved there).
import type { Runtime } from "../runtime.ts";
import type { AppSpec } from "../spec.ts";
import { formatCollections } from "../shared.ts";
import { CAPABILITIES } from "../spec.ts";
import { installVision } from "../vision.ts";
import { installAi } from "../ai.ts";
import { type AgentDeps, type BuilderView, type EditRequest, type LogEntry, runEdit } from "./agent.ts";
import { addApp, commitEdit, findApp, redoEdit, undoEdit } from "./registry.ts";
import { installIcons, requestIcon } from "./icons.ts";
import { installLearn } from "./learn.ts";

export function installBuilder(shell: Runtime): void {
  let nextLog = 1;
  const log = (entry: Omit<LogEntry, "id">): string => {
    const id = `l${nextLog++}`;
    shell.set("log", [...((shell.get("log") as LogEntry[]) ?? []), { ...entry, id }]);
    return id;
  };
  const update = (id: string, entry: Partial<Omit<LogEntry, "id">>) =>
    shell.set("log", ((shell.get("log") as LogEntry[]) ?? []).map((e) => (e.id === id ? { ...e, ...entry } : e)));
  /** Runs that ran out of steps, by app: the next request on that app carries on from there. */
  const unfinished = new Map<string, unknown[]>();
  const preview = (id: string) => shell.children.find((c) => c.spec?.id === id);

  const deps = (id: string): AgentDeps => ({
    settings: {
      apiKey: String(shell.get("apiKey") ?? ""),
      model: String(shell.get("model") || "muse-spark-1.3"),
      baseUrl: String(shell.get("baseUrl") || "https://api.meta.ai/v1"),
    },
    http: (req, onLine) =>
      shell.hostCall("http", req as unknown as Record<string, unknown>, onLine && ((u) => typeof u.line === "string" && onLine(u.line))),
    getSpec: () => findApp(shell, id)?.spec as AppSpec,
    screenshot: shell.host.call ? (screen) => screenshot(id, screen) : undefined,
    scripts: shell.host.call
      ? {
        run: (args) => shell.hostCall("script.run", args),
        render: (args) => shell.hostCall("script.render", args),
      }
      : undefined,
    commit: (spec) => commitEdit(shell, id, { ...spec, id }),
    view: (): BuilderView => {
      const spec = findApp(shell, id)?.spec;
      const shown = preview(id)?.nav.peek().at(-1)?.screen;
      const screens = Object.keys(spec?.screens ?? {});
      return { screen: shown ?? spec?.start ?? screens[0] ?? "", screens, selected: (shell.get("selected") as BuilderView["selected"]) ?? null };
    },
    collections: () => formatCollections(((shell.get("apps") as { id: string; spec: AppSpec }[] | undefined) ?? [])),
    log,
    update,
    status: (text) => shell.set("status", text),
  });

  /**
   * What a screen looks like now. The builder shows the user the screen the model looks at
   * (Screen mode on it), then captures that page's app at its full size.
   */
  const screenshot = async (id: string, screen?: string): Promise<string | null> => {
    const spec = findApp(shell, id)?.spec;
    const target = screen && spec?.screens[screen] ? screen : (deps(id).view().screen);
    if (shell.get("mode") !== "screen" || shell.get("focus") !== target) {
      shell.set("focus", target);
      shell.set("mode", "screen");
    }
    // Two frames: the pager's pages are built, then their apps lay out and render.
    await shell.nextFrame();
    await shell.nextFrame();
    const view = shell.embeddedViews().find((v) => v.rt.spec?.id === id && v.screen === target);
    if (!view) return null;
    const shot = await shell.hostCall<{ data?: string }>("screenshot", { id: view.rt.root.id });
    return shot?.data ?? null;
  };

  const run = async (id: string, request: EditRequest) => {
    if (shell.get("busy")) return;
    shell.set("busy", true);
    try {
      const outcome = await runEdit(deps(id), { ...request, continueFrom: unfinished.get(id) });
      if (outcome.finished) unfinished.delete(id);
      else unfinished.set(id, outcome.conversation);
    } catch (e) {
      log({ role: "error", text: (e as Error).message });
    } finally {
      shell.set("busy", false);
    }
  };

  shell.services.set("builder.edit", (args) => {
    const id = String(args.id ?? "");
    const text = String(args.prompt ?? "").trim();
    if (!id || !text || shell.get("busy")) return;
    log({ role: "user", text });
    shell.set("prompt", "");
    void run(id, { text });
  });

  shell.services.set("builder.create", (args) => {
    const text = String(args.prompt ?? "").trim();
    if (!text || shell.get("busy")) return;
    const id = `app-${Date.now().toString(36)}`;
    addApp(shell, {
      id,
      name: "New app",
      description: text,
      screens: { main: { title: "New app", body: { type: "text", value: "Building…", style: { color: "muted" } } } },
    });
    shell.set("log", []);
    shell.set("newId", id);
    shell.set("newPrompt", "");
    log({ role: "user", text });
    const done = run(id, {
      text: `Create a new app for this, replacing the placeholder spec (keep id "${id}"): ${text}\n\nWrite the complete spec in your message as one \`\`\`json block first, then call set_spec with no arguments.`,
    });
    // The model names the app as it writes it; only then is there something to draw.
    void done.then(() => {
      const entry = findApp(shell, id);
      if (entry && !entry.icon && entry.spec.name !== "New app") void requestIcon(shell, id);
    });
  });

  // A spoken request: record until the second tap, then the audio goes to the model.
  shell.services.set("builder.voiceStart", () => {
    if (shell.get("busy") || shell.get("recording")) return;
    shell.set("recording", true);
    shell.hostCall("audio.start").catch((e: Error) => {
      shell.set("recording", false);
      log({ role: "error", text: `Can't record: ${e.message}` });
    });
  });
  shell.services.set("builder.voiceStop", (args) => {
    if (!shell.get("recording")) return;
    shell.set("recording", false);
    const id = String(args.id ?? "");
    shell
      .hostCall<{ data?: string }>("audio.stop")
      .then((r) => {
        if (!r?.data) throw new Error("Nothing was recorded");
        return run(id, { audio: r.data });
      })
      .catch((e: Error) => log({ role: "error", text: `Can't record: ${e.message}` }));
  });

  shell.services.set("builder.undo", (args) => undoEdit(shell, String(args.id ?? "")));
  shell.services.set("builder.redo", (args) => redoEdit(shell, String(args.id ?? "")));
  shell.services.set("builder.clear", () => shell.set("log", []));

  installGate(shell);
  installBackground(shell);
  installVision(shell);
  installAi(shell);
  installLearn(shell);
  installIcons(shell);
}

/** Stored answers, by app: `grants[appId][capability]` is what the user said. */
type Grants = Record<string, Record<string, boolean>>;

const grantsOf = (shell: Runtime): Grants => (shell.get("grants") as Grants | undefined) ?? {};

/**
 * The permission gate: a stored answer allows or denies; otherwise the shell asks once and
 * remembers. Requests for the same app and capability share one question; different ones
 * queue and are asked one after another. A capability with `asks: false` never reaches
 * here (the runtime allows it).
 */
function installGate(shell: Runtime): void {
  /** Resolvers waiting for each question, by `app capability`. */
  const waiting = new Map<string, ((allow: boolean) => void)[]>();
  /** Questions in order: the first is the one on screen (`asking`). */
  const queue: { app: string; appName: string; capability: string; text: string }[] = [];
  const key = (app: string, capability: string) => `${app} ${capability}`;
  const networkText = (capability: string): string | null => {
    if (!capability.startsWith("network:")) return null;
    const hosts = capability.slice("network:".length);
    return hosts || null;
  };
  const sharedText = (app: AppSpec, capability: string): string | null => {
    if (!capability.startsWith("shared.")) return null;
    const name = capability.slice("shared.".length);
    const apps = (shell.get("apps") as { id: string; spec: AppSpec }[] | undefined) ?? [];
    const pubs = apps.filter((a) => a.spec.publish?.[name]);
    // The collection's name reads as a noun ("your workouts"); a publisher's doc may not.
    const from = pubs.map((p) => p.spec.name).join(", ") || "no apps yet";
    return `${app.name} wants to read your ${name} from ${from}.`;
  };
  shell.gate = (app, capability) => {
    const prior = grantsOf(shell)[app.id]?.[capability];
    if (prior !== undefined) return Promise.resolve(prior);
    const k = key(app.id, capability);
    const pending = waiting.get(k);
    if (pending) return new Promise<boolean>((resolve) => pending.push(resolve));
    const resolvers: ((allow: boolean) => void)[] = [];
    waiting.set(k, resolvers);
    const hosts = networkText(capability);
    const question = { app: app.id, appName: app.name, capability, text: hosts ? `${app.name} wants to connect to ${hosts}.` : sharedText(app, capability) ?? `${app.name} wants to ${CAPABILITIES[capability]?.doc ?? capability}.` };
    queue.push(question);
    // The first question goes on screen; the rest wait their turn.
    if (queue.length === 1) shell.set("asking", question);
    return new Promise<boolean>((resolve) => resolvers.push(resolve));
  };
  shell.services.set("builder.answer", (args) => {
    const asking = shell.get("asking") as { app: string; capability: string } | null;
    if (!asking) return;
    const cur = queue.shift();
    if (!cur) return;
    const allow = Boolean(args.allow);
    shell.set("grants", { ...grantsOf(shell), [cur.app]: { ...grantsOf(shell)[cur.app], [cur.capability]: allow } });
    const resolvers = waiting.get(key(cur.app, cur.capability)) ?? [];
    waiting.delete(key(cur.app, cur.capability));
    shell.set("asking", queue.length ? queue[0] : null);
    for (const resolve of resolvers) resolve(allow);
  });
  shell.services.set("builder.forgetGrant", (args) => {
    const app = String(args.app ?? "");
    const capability = String(args.capability ?? "");
    const caps = grantsOf(shell)[app];
    if (!app || !capability || caps?.[capability] === undefined) return;
    const next = { ...caps };
    delete next[capability];
    const grants = { ...grantsOf(shell) };
    if (Object.keys(next).length) grants[app] = next;
    else delete grants[app];
    shell.set("grants", grants);
  });
}
