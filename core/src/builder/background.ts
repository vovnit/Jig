import type { Runtime } from '../runtime.ts';
import { DataStore } from '../store.ts';
import { occurrences } from '../schedule.ts';
import type { AppSpec } from '../spec.ts';
import { isWidgetTimeDependent, renderAppWidgets } from '../widgets.ts';
import type { AppEntry } from './registry.ts';

/** One schedule and widget owner per app, including closed apps; preview copies cannot replace it. */
export function installBackground(shell: Runtime): void {
  const sent = new Map<string, string>();
  const pending = new Map<string, number>();
  let sequence = 0;
  let known = new Set<string>();
  // Widget renders, by app: the data they were rendered from and the minute they cover.
  const widgetData = new Map<string, string>();
  const widgetMinute = new Map<string, number>();
  const widgetSent = new Map<string, string>();
  const sync = () => {
    const apps = (shell.get('apps') as AppEntry[] | undefined) ?? [];
    const ids = new Set(apps.map(a => a.id));
    for (const id of known) if (!ids.has(id)) {
      pending.delete(id); sent.delete(id);
      void shell.hostCall('schedule.set', { app: id, items: [] }).catch(() => {});
      void shell.hostCall('files.clear', { app: id }).catch(() => {});
      if (widgetSent.has(id)) {
        widgetData.delete(id); widgetMinute.delete(id); widgetSent.delete(id);
        void shell.hostCall('widgets.set', { app: id, widgets: [] }).catch(() => {});
      }
    }
    known = ids;
    const current = shell.nav.peek().at(-1);
    const all: Runtime[] = [];
    const visit = (rt: Runtime) => { for (const c of rt.children) { all.push(c); visit(c); } };
    visit(shell);
    const grants = (shell.get('grants') as Record<string, Record<string, boolean>>) ?? {};
    for (const { id, spec } of apps) {
      const running = current?.screen === 'run' && current.params?.id === id ? all.find(r => r.spec.id === id) : undefined;
      const allowed = grants[id]?.notifications;
      if (!spec.schedule && !sent.has(id)) continue;
      const data = running?.snapshot() ?? stored(spec, shell);
      const location = shell.get('lastLocation') as { lat: number; lon: number } | null;
      let items;
      try {
        items = spec.capabilities?.includes('notifications') && allowed === true
          ? occurrences(spec, { lookup: k => data[k], has: k => Object.hasOwn(data, k) }, Date.now(), location)
          : [];
      } catch (e) { shell.recordError('schedule', `${spec.name}: ${(e as Error).message}`); continue; }
      const signature = JSON.stringify(items);
      if (sent.get(id) !== signature) {
        sent.set(id, signature);
        const ticket = ++sequence; pending.set(id, ticket);
        void shell.hostCall('schedule.set', { app: id, items }).catch((e: Error) => {
          if (pending.get(id) === ticket) shell.recordError('schedule', e.message);
        });
      }
      // Only the running app may initiate a new permission question.
      if (running && spec.schedule && allowed === undefined && spec.capabilities?.includes('notifications') && !pending.has(`gate:${id}`)) {
        pending.set(`gate:${id}`, ++sequence);
        void Promise.resolve(shell.gate?.(spec, 'notifications')).then(() => {
          pending.delete(`gate:${id}`); sync();
        });
      }
    }
    syncWidgets(shell, apps, current, all, widgetData, widgetMinute, widgetSent);
  };
  shell.onFrame = sync;
  shell.onLocation = location => { shell.set('lastLocation', location); };
}

function runningChild(current: { screen: string; params?: Record<string, unknown> } | undefined, all: Runtime[], id: string): Runtime | undefined {
  if (current?.screen === 'run' && current.params?.id === id) return all.find(r => r.spec.id === id);
  return undefined;
}

/**
 * Renders every app's widgets (closed apps too) at most once per frame and sends
 * `widgets.set` when they changed. Deleting the app clears them (handled above);
 * removing `widgets` from the spec sends an empty list.
 */
function syncWidgets(
  shell: Runtime,
  apps: AppEntry[],
  current: { screen: string; params?: Record<string, unknown> } | undefined,
  all: Runtime[],
  widgetData: Map<string, string>,
  widgetMinute: Map<string, number>,
  widgetSent: Map<string, string>,
): void {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const measure = (text: string, style: { fontSize: number; fontWeight: number; lineHeight: number; fontFamily?: 'mono' }, maxWidth: number) =>
    shell.host.measureText(text, style, maxWidth);
  for (const { id, spec } of apps) {
    const widgets = spec.widgets ?? {};
    const names = Object.keys(widgets);
    if (!names.length) {
      if (widgetSent.has(id)) {
        widgetData.delete(id); widgetMinute.delete(id); widgetSent.delete(id);
        void shell.hostCall('widgets.set', { app: id, widgets: [] }).catch(() => {});
      }
      continue;
    }
    const data = runningChild(current, all, id)?.snapshot() ?? stored(spec, shell);
    const dataSig = JSON.stringify({ data, widgets: spec.widgets });
    const live = names.some(n => isWidgetTimeDependent(spec, n));
    if (widgetData.get(id) === dataSig && (!live || widgetMinute.get(id) === minute)) continue;
    let updates;
    try {
      updates = renderAppWidgets(spec, data, now, measure);
    } catch (e) { shell.recordError('widgets', `${spec.name}: ${(e as Error).message}`); continue; }
    widgetData.set(id, dataSig);
    widgetMinute.set(id, minute);
    const signature = JSON.stringify(updates);
    if (widgetSent.get(id) !== signature) {
      widgetSent.set(id, signature);
      const payload = { app: id, appName: spec.name, widgets: updates };
      void shell.hostCall('widgets.set', payload).catch((e: Error) => shell.recordError('widgets', e.message));
    }
  }
}
function stored(spec: AppSpec, shell: Runtime): Record<string, unknown> {
  const values: Record<string, unknown> = { ...spec.state };
  for (const [key, field] of Object.entries(spec.data ?? {})) {
    if (!field.secret) values[key] = field.default ?? (field.type === 'list' ? [] : field.type === 'number' ? 0 : field.type === 'boolean' ? false : field.type === 'object' ? {} : '');
  }
  if (shell.host.db) Object.assign(values, new DataStore(shell.host.db, spec.id).read());
  for (const [key, field] of Object.entries(spec.data ?? {})) if (field.secret) delete values[key];
  return values;
}

export function openApp(shell: Runtime, app: string, screen?: string): void {
  const entry = ((shell.get('apps') as AppEntry[]) ?? []).find(a => a.id === app);
  if (!entry) return;
  const target = screen && entry.spec.screens[screen] ? screen : entry.spec.start ?? Object.keys(entry.spec.screens)[0];
  shell.nav.set([{ screen: 'home', params: {} }, { screen: 'run', params: { id: app } }]);
  void shell.nextFrame().then(() => {
    const child = shell.children.find(c => c.spec.id === app);
    child?.nav.set([{ screen: target, params: {} }]);
  });
}
