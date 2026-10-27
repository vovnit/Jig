import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBuilder } from '../src/builder/index.ts';
import { validateSpec } from '../src/builder/validate.ts';
import { seedApps } from '../src/builder/registry.ts';
import { openApp } from '../src/builder/background.ts';
import { isWidgetTimeDependent, renderAppWidgets, renderWidget, renderWidgetEntries } from '../src/widgets.ts';
import type { AppSpec } from '../src/spec.ts';
import type { WidgetNode } from '../src/widgets.ts';
import { boot, frame, measure } from './fake-host.ts';

const tick = () => new Promise(r => setTimeout(r, 0));
const texts = (n: WidgetNode, out: string[] = []): string[] => {
  if (n.kind === 'text') out.push(n.text);
  if (n.kind === 'box') for (const c of n.children) texts(c, out);
  return out;
};
const findText = (n: WidgetNode): WidgetNode & { kind: 'text' } => {
  if (n.kind === 'text') return n;
  if (n.kind === 'box') for (const c of n.children) {
    try { return findText(c); } catch { /* next */ }
  }
  throw new Error('No text node');
};
const findBoxWith = (n: WidgetNode, pred: (b: WidgetNode & { kind: 'box' }) => boolean): WidgetNode & { kind: 'box' } => {
  if (n.kind === 'box') {
    if (pred(n)) return n;
    for (const c of n.children) {
      try { return findBoxWith(c, pred); } catch { /* next */ }
    }
  }
  throw new Error('No matching box');
};

const smallText = (): AppSpec => ({
  id: 'w1', name: 'W1',
  data: { greeting: { type: 'string', default: 'Hi' } },
  screens: { main: { body: { type: 'text', value: 'x' } } },
  widgets: {
    hello: {
      title: 'Hello', sizes: ['small'], open: 'main',
      body: {
        type: 'column', style: { background: 'surface', padding: 8 },
        children: [{ type: 'text', value: '{{greeting}}', style: { color: 'text' } }],
      },
    },
  },
});

test('a small text widget resolves frames and colors in both schemes', () => {
  const spec = smallText();
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const light = renderWidget(spec, { greeting: 'Hi' }, 'hello', 'small', now, measure, 'light');
  const dark = renderWidget(spec, { greeting: 'Hi' }, 'hello', 'small', now, measure, 'dark');
  assert.equal(light.kind, 'box');
  assert.deepEqual(light.frame, { x: 0, y: 0, width: 158, height: 158 });
  const lightBox = findBoxWith(light, b => b.background === '#f2f3f5');
  const darkBox = findBoxWith(dark, b => b.background === '#1e2126');
  assert.equal(lightBox.background, '#f2f3f5');
  assert.equal(darkBox.background, '#1e2126');
  const lt = findText(light);
  assert.equal(lt.text, 'Hi');
  assert.equal(lt.color, '#14161a');
  assert.ok(lt.frame.width > 0 && lt.frame.height > 0);
  assert.ok(lt.frame.x >= 0 && lt.frame.y >= 0 && lt.frame.x + lt.frame.width <= 158.01 && lt.frame.y + lt.frame.height <= 158.01);
  const dt = findText(dark);
  assert.equal(dt.color, '#eef0f3');
});

test('a clock widget gets 31 entries one minute apart', () => {
  const spec: AppSpec = {
    id: 'w2', name: 'W2', capabilities: ['clock'],
    screens: { main: { body: { type: 'text', value: 'x' } } },
    widgets: {
      clock: {
        title: 'Clock', sizes: ['small'], open: 'main',
        body: { type: 'text', value: "{{formatDate(clock, 'HH:mm')}}" },
      },
    },
  };
  assert.ok(isWidgetTimeDependent(spec, 'clock'));
  assert.ok(!isWidgetTimeDependent(smallText(), 'hello'));
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const entries = renderWidgetEntries(spec, {}, 'clock', 'small', now, measure);
  assert.equal(entries.length, 31);
  entries.forEach((e, i) => assert.equal(e.date, now + i * 60000));
  assert.notEqual(texts(entries[0].light)[0], texts(entries[1].light)[0]);
});

test('changing data re-sends widgets, deleting the app clears them', async () => {
  const shell = JSON.parse(readFileSync(new URL('../../specs/shell.json', import.meta.url), 'utf8')) as AppSpec;
  const { host, rt } = boot(shell, undefined, undefined, { trusted: true });
  installBuilder(rt);
  seedApps(rt, [smallText()]);
  frame(host); await tick();
  const first = host.calls.filter(c => c.service === 'widgets.set' && (c.args.app === 'w1'));
  assert.ok(first.length > 0);
  assert.equal((first.at(-1)!.args.widgets as unknown[]).length, 1);
  assert.ok(JSON.stringify(first.at(-1)!.args).includes('Hi'));
  openApp(rt, 'w1', 'main');
  frame(host); await tick(); frame(host); await tick();
  const child = rt.children.find(c => c.spec.id === 'w1')!;
  child.set('greeting', 'Yo');
  frame(host); await tick();
  const resent = host.calls.filter(c => c.service === 'widgets.set' && c.args.app === 'w1').at(-1)!;
  assert.ok(JSON.stringify(resent.args).includes('Yo'));
  rt.nav.set([{ screen: 'home', params: {} }]);
  rt.set('apps', []);
  frame(host); await tick();
  assert.deepEqual(host.calls.filter(c => c.service === 'widgets.set').at(-1)?.args, { app: 'w1', widgets: [] });
});

test('onTap inside a widget is ignored', () => {
  const spec: AppSpec = {
    id: 'w3', name: 'W3',
    screens: { main: { body: { type: 'text', value: 'x' } } },
    widgets: {
      tap: {
        sizes: ['small'],
        body: { type: 'button', label: 'Drink', onTap: { set: 'x', to: '1' } } as unknown as AppSpec['screens']['main']['body'],
      },
    },
  };
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const tree = renderWidget(spec, {}, 'tap', 'small', now, measure, 'light');
  assert.equal(JSON.stringify(tree).includes('onTap'), false);
  assert.ok(texts(tree).includes('Drink'));
  assert.deepEqual(validateSpec(spec), []);
});

test('widgets validate sizes, open screens and bodies that render', () => {
  const ok = smallText();
  assert.deepEqual(validateSpec(ok), []);
  const badSize = smallText() as unknown as Record<string, unknown>;
  ((badSize.widgets as Record<string, { sizes: string[] }>).hello.sizes as string[]) = ['huge'];
  assert.ok(validateSpec(badSize).some(e => e.includes('sizes') || e.includes('huge')));
  const badOpen = smallText();
  badOpen.widgets!.hello.open = 'missing';
  assert.ok(validateSpec(badOpen).some(e => e.includes("no screen named 'missing'")));
  const badBody = smallText();
  badBody.widgets!.hello.body = { type: 'text', value: '{{nope()}}' } as unknown as AppSpec['screens']['main']['body'];
  assert.ok(validateSpec(badBody).some(e => e.includes('widgets.hello')));
  const updates = renderAppWidgets(smallText(), { greeting: 'Hi' }, Date.UTC(2026, 9, 26, 12), measure);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].open, 'main');
  assert.equal(updates[0].size, 'small');
  assert.equal(updates[0].entries.length, 1);
});

test('time reads in nested objects make a timeline, like the validator', () => {
  const bodyFor = (body: unknown): AppSpec => ({
    id: 'w', name: 'W', capabilities: ['clock'],
    screens: { main: { body: { type: 'text', value: 'x' } } },
    widgets: { nested: { title: 'N', sizes: ['small'], open: 'main', body: body as AppSpec['screens']['main']['body'] } },
  });
  const bodies: Record<string, unknown> = {
    componentProps: {
      type: 'Card', props: { title: "{{formatDate(clock, 'HH:mm')}}" },
    },
    rowStyle: {
      type: 'list', items: '[]', row: { type: 'text', value: 'x' }, rowStyle: { background: "{{clock ? 'red' : 'blue'}}" },
    },
    swipeLabel: {
      type: 'list', items: '[]', row: { type: 'text', value: 'x' },
      swipe: [{ label: "{{formatDate(clock, 'HH:mm')}}", do: { set: 'x', to: "'y'" } }],
    },
    emptyText: {
      type: 'list', items: '[]', row: { type: 'text', value: 'x' }, empty: "{{formatDate(clock, 'HH:mm')}}",
    },
    emptyNode: {
      type: 'list', items: '[]', row: { type: 'text', value: 'x' }, empty: { type: 'text', value: "{{formatDate(clock, 'HH:mm')}}" },
    },
  };
  const components = {
    Card: { type: 'text', value: '{{props.title}}' },
  } as unknown as AppSpec['components'];
  for (const [key, body] of Object.entries(bodies)) {
    const spec = { ...bodyFor(body), components };
    assert.ok(isWidgetTimeDependent(spec, 'nested'), key);
    // The validator sees the same read: without the capability it names the fix.
    const undeclared = { ...bodyFor(body), components, capabilities: [] } as unknown as AppSpec;
    assert.ok(validateSpec(undeclared).join('\n').includes("uses 'clock'"), `${key} needs clock`);
  }
  assert.ok(!isWidgetTimeDependent(bodyFor({ type: 'text', value: 'still' }), 'nested'));
});
