import { compile, compileTemplate, type Scope } from './expr.ts';
import type { AppSpec } from './spec.ts';
import { sunTimes } from './sun.ts';

export interface ScheduleEntry {
  at: string | { sun: 'sunrise' | 'sunset' | 'noon' | 'dawn' | 'dusk'; offset?: number };
  days?: string[];
  if?: string;
  title?: string;
  body?: string;
  sound?: string;
  alarm?: boolean;
  open?: string;
}
export interface Occurrence {
  id: string; at: number; title: string; body: string; sound?: string; alarm: boolean; app: string; open: string;
}
const template = (text: string, scope: Scope): unknown => compileTemplate(text)?.(scope) ?? text;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (v: number) => String(v).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Expand local calendar days rather than adding 24 hours, so DST keeps wall-clock times. */
export function occurrences(spec: AppSpec, scope: Scope, now: number, location: { lat: number; lon: number } | null = null, days = 14): Occurrence[] {
  const items: Occurrence[] = [];
  const end = new Date(now); end.setDate(end.getDate() + Math.min(14, Math.max(0, days)));
  for (const [key, entry] of Object.entries(spec.schedule ?? {})) {
    if (entry.if && !compile(entry.if)(scope)) continue;
    const at = typeof entry.at === 'string' ? template(entry.at, scope) : entry.at;
    for (let i = 0; i <= Math.min(14, days); i++) {
      const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i);
      if (entry.days && !entry.days.includes(weekdays[d.getDay()])) continue;
      let time: number | null = null;
      if (typeof at === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) {
        const [h, m] = at.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        // A nonexistent spring-forward time is skipped instead of silently moved.
        if (d.getHours() !== h || d.getMinutes() !== m) continue;
        time = d.getTime();
      } else if (at && typeof at === 'object' && 'sun' in at && location) {
        const solar = at as { sun: keyof ReturnType<typeof sunTimes>; offset?: number };
        const times = sunTimes(location.lat, location.lon, Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const value = times[solar.sun];
        if (typeof value === 'number') time = value + (solar.offset ?? 0) * 60000;
      }
      if (time == null || !Number.isFinite(time) || time <= now || time > end.getTime()) continue;
      items.push({ id: `${key}-${dateKey(d)}`, at: time, title: String(template(entry.title ?? spec.name, scope) ?? ''), body: String(template(entry.body ?? '', scope) ?? ''), sound: entry.sound, alarm: entry.alarm === true, app: spec.id, open: entry.open ?? spec.start ?? Object.keys(spec.screens)[0] });
    }
  }
  return items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(0, 64);
}
