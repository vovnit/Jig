// The builder's services, which the trusted shell spec calls: `{"call": "builder.edit",
// "args": {"id": "app.id"}}`. They run the agent and report through the shell's state:
// `log` (the conversation), `busy`, and the app list itself (each edit is saved there).
import type { Runtime } from "../runtime.ts";
import type { AppSpec } from "../spec.ts";
import { type AgentDeps, type BuilderView, type EditRequest, type LogEntry, runEdit } from "./agent.ts";
import { addApp, commitEdit, findApp, redoEdit, undoEdit } from "./registry.ts";

export function installBuilder(shell: Runtime): void {
  let nextLog = 1;
  const log = (entry: Omit<LogEntry, "id">) => shell.set("log", [...((shell.get("log") as LogEntry[]) ?? []), { ...entry, id: `l${nextLog++}` }]);
  const preview = (id: string) => shell.children.find((c) => c.spec?.id === id);

  const deps = (id: string): AgentDeps => ({
    settings: {
      apiKey: String(shell.get("apiKey") ?? ""),
      model: String(shell.get("model") || "muse-spark-1.1"),
      baseUrl: String(shell.get("baseUrl") || "https://api.meta.ai/v1"),
    },
    http: (req) => shell.hostCall("http", req as unknown as Record<string, unknown>),
    getSpec: () => findApp(shell, id)?.spec as AppSpec,
    screenshot: shell.host.call ? (screen) => screenshot(id, screen) : undefined,
    commit: (spec) => commitEdit(shell, id, { ...spec, id }),
    view: (): BuilderView => {
      const spec = findApp(shell, id)?.spec;
      const shown = preview(id)?.nav.peek().at(-1)?.screen;
      const screens = Object.keys(spec?.screens ?? {});
      return { screen: shown ?? spec?.start ?? screens[0] ?? "", screens, selected: (shell.get("selected") as BuilderView["selected"]) ?? null };
    },
    log,
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
      await runEdit(deps(id), request);
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
    void run(id, { text: `Create a new app for this, replacing the placeholder spec (keep id "${id}"): ${text}` });
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
        log({ role: "user", text: "🎙 Spoken request" });
        return run(id, { audio: r.data });
      })
      .catch((e: Error) => log({ role: "error", text: `Can't record: ${e.message}` }));
  });

  shell.services.set("builder.undo", (args) => undoEdit(shell, String(args.id ?? "")));
  shell.services.set("builder.redo", (args) => redoEdit(shell, String(args.id ?? "")));
  shell.services.set("builder.clear", () => shell.set("log", []));
}
