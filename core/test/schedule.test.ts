import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { occurrences } from '../src/schedule.ts';
import { validateSpec } from '../src/builder/validate.ts';
import { installBuilder } from '../src/builder/index.ts';
import { openApp } from '../src/builder/background.ts';
import { seedApps } from '../src/builder/registry.ts';
import { boot, frame } from './fake-host.ts';
import type { AppSpec } from '../src/spec.ts';
const scope = (v: Record<string, unknown> = {}) => ({ lookup: (k: string) => v[k], has: (k: string) => Object.hasOwn(v, k) });
const sample = (): AppSpec => ({ id: 'reminder', name: 'Reminder', capabilities: ['notifications'], data: { time: { type: 'string', default: '09:00' }, enabled: { type: 'boolean', default: true } }, schedule: { morning: { at: '{{time}}', if: 'enabled', body: 'Hello', open: 'details' } }, screens: { main: { body: { type: 'text', value: 'Main' } }, details: { body: { type: 'text', value: 'Details' } } } });
const tick = () => new Promise(r => setTimeout(r, 0));
test('schedule expands weekdays, bindings and conditions with stable IDs', () => {
  const spec = sample(); spec.schedule!.morning.days = ['mon'];
  const now = new Date(2026, 9, 26, 8).getTime();
  const items = occurrences(spec, scope({ time: '09:30', enabled: true }), now);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'morning-2026-10-26');
  assert.equal(new Date(items[0].at).getHours(), 9);
  assert.deepEqual(occurrences(spec, scope({ time: '09:30', enabled: false }), now), []);
});
test('schedule caps occurrences, skips polar sun events and applies offsets', () => {
  const spec = sample();
  spec.schedule = Object.fromEntries(Array.from({length: 10}, (_, i) => [String(i), { at: '12:00' }]));
  assert.equal(occurrences(spec, scope(), new Date(2026, 9, 26, 8).getTime()).length, 64);
  spec.schedule = { sun: { at: { sun: 'sunrise', offset: -30 } } };
  const now = Date.UTC(2026, 11, 1);
  assert.deepEqual(occurrences(spec, scope(), now, { lat: 90, lon: 0 }), []);
  assert.deepEqual(occurrences(spec, scope(), now), []);
  const offset = occurrences(spec, scope(), now, { lat: 48.85, lon: 2.35 });
  spec.schedule.sun.at = { sun: 'sunrise' };
  const plain = occurrences(spec, scope(), now, { lat: 48.85, lon: 2.35 });
  assert.equal(plain[0].at - offset[0].at, 30 * 60000);
});
test('local time survives DST and nonexistent spring-forward times are skipped', () => {
  const previous = process.env.TZ; process.env.TZ = 'Europe/Paris';
  try {
    const spec = sample(); spec.schedule = { morning: { at: '09:00' } };
    const items = occurrences(spec, scope(), new Date(2026, 2, 28, 8).getTime());
    assert.equal(items[1].at - items[0].at, 23 * 3600000);
    assert.ok(items.every(i => new Date(i.at).getHours() === 9));
    spec.schedule = { missing: { at: '02:30' } };
    assert.ok(!occurrences(spec, scope(), new Date(2026, 2, 28, 8).getTime()).some(i => i.id === 'missing-2026-03-29'));
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
test('schedule validates capabilities, times, weekdays and destination screens', () => {
  assert.deepEqual(validateSpec(sample()), []);
  assert.match(validateSpec({ ...sample(), capabilities: [] }).join('\n'), /notifications/);
  const s = sample(); s.schedule!.morning.open = 'missing';
  assert.match(validateSpec(s).join('\n'), /no screen/);
  s.schedule!.morning.at = '25:90';
  assert.ok(validateSpec(s).some(e => e.includes('at')));
});
test('schedule conditions and titles read each occurrence time', () => {
  const pad2 = (v: number) => String(v).padStart(2, '0');
  const base = new Date(2026, 9, 26);
  const last = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
  const now = new Date(2026, 9, 26, 8).getTime();
  const spec: AppSpec = { id: 'plants', name: 'Plants', schedule: { water: { at: '09:00', if: '{{daysBetween(last, today()) >= 3}}' } }, screens: { main: { body: { type: 'text', value: 'Main' } } } };
  const items = occurrences(spec, scope({ last }), now);
  assert.ok(items.length > 0);
  assert.equal(items[0].id, 'water-2026-10-29');
  assert.equal(new Date(items[0].at).getHours(), 9);
  assert.ok(!items.some((i) => ['water-2026-10-26', 'water-2026-10-27', 'water-2026-10-28'].includes(i.id)));

  const titled: AppSpec = { id: 'plants', name: 'Plants', schedule: { water: { at: '09:00', title: '{{today()}}' } }, screens: { main: { body: { type: 'text', value: 'Main' } } } };
  const withTitles = occurrences(titled, scope({}), now);
  assert.equal(withTitles[0].title, '2026-10-26');
  assert.equal(withTitles[1].title, '2026-10-27');
});
test('container schedules closed apps, clears revoked and deleted apps, and opens notification destination', async () => {
  const shell = JSON.parse(readFileSync(new URL('../../specs/shell.json', import.meta.url), 'utf8')) as AppSpec;
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  installBuilder(rt);
  seedApps(rt, [sample()]);
  rt.set('grants', { reminder: { notifications: true } });
  frame(host); await tick();
  assert.ok(host.calls.some(c => c.service === 'schedule.set' && (c.args.items as unknown[]).length > 0));
  openApp(rt, 'reminder', 'details');
  frame(host); await tick(); frame(host);
  const child = rt.children.find(c => c.spec.id === 'reminder')!;
  assert.equal(child.nav.peek().at(-1)?.screen, 'details');
  child.set('enabled', false); frame(host); await tick();
  assert.deepEqual(host.calls.filter(c => c.service === 'schedule.set').at(-1)?.args.items, []);
  child.set('enabled', true); frame(host); await tick();
  rt.set('grants', { reminder: { notifications: false } }); frame(host); await tick();
  assert.deepEqual(host.calls.filter(c => c.service === 'schedule.set').at(-1)?.args.items, []);
  rt.nav.set([{ screen: 'home', params: {} }]); rt.set('apps', []); frame(host); await tick();
  assert.deepEqual(host.calls.filter(c => c.service === 'schedule.set').at(-1)?.args, { app: 'reminder', items: [] });
});
