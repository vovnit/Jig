import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, frame } from './fake-host.ts';
import { validateSpec } from '../src/builder/validate.ts';
import type { AppSpec, Actions } from '../src/spec.ts';
const tick = () => new Promise(r => setTimeout(r, 0));
function spec(action?: Actions): AppSpec {
  return { id: 'media', name: 'Media', capabilities: ['screen', 'speech', 'haptics'], state: { playing: true, position: 0 }, screens: { main: { body: { type: 'column', children: [
    { type: 'audio', src: '@chime', playing: '{{playing}}', onEnded: { set: 'playing', to: false }, onTime: { set: 'position', to: 'value.position' } },
    { type: 'button', label: 'Go', onTap: action ?? [] },
  ] } } } };
}
test('media events update state and audio occupies no visible space', () => {
  const { host, rt } = boot(spec());
  const audio = [...rt.nodes.values()].find(n => n.type === 'audio')!;
  assert.equal(audio.frame[2], 0);
  assert.equal(audio.frame[3], 0);
  rt.dispatch(audio.id, 'time', { position: 2.5, duration: 10 });
  assert.equal(rt.get('position'), 2.5);
  rt.dispatch(audio.id, 'ended');
  frame(host);
  assert.equal(rt.get('playing'), false);
});
test('device actions require capabilities and teardown restores state', async () => {
  const s = spec([{ keepAwake: { on: true } }, { brightness: { level: 0.7 } }, { speak: { text: "'Hello'" } }]);
  assert.deepEqual(validateSpec(s), []);
  assert.match(validateSpec({ ...s, capabilities: [] }).join('\n'), /capabilit/);
  const { host, rt } = boot(s);
  rt.dispatch([...rt.nodes.values()].find(n => n.type === 'button' && n.props.label === 'Go')!.id, 'tap');
  await tick();
  rt.dispose();
  assert.ok(host.calls.some(c => c.service === 'keepAwake' && c.args.on === false));
  assert.ok(host.calls.some(c => c.service === 'brightness' && c.args.level === null));
  assert.ok(host.calls.some(c => c.service === 'stopSpeaking'));
});
test('queued actions do not start after disposal', async () => {
  const { host, rt } = boot(spec({ keepAwake: { on: true } }));
  rt.dispatch([...rt.nodes.values()].find(n => n.type === 'button' && n.props.label === 'Go')!.id, 'tap');
  rt.dispose();
  await tick();
  assert.equal(host.calls.filter(c => c.service === 'keepAwake').length, 0);
});
