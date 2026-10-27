import type { Occurrence } from '../../core/src/schedule.ts';
const timers = new Map<string, number[]>();
/** Playground only: browser timers cannot fire after the page closes. */
export async function setSchedule(app: string, items: Occurrence[]): Promise<void> {
  for (const timer of timers.get(app) ?? []) clearTimeout(timer);
  timers.set(app, []);
  if (!items.length) return;
  if (!('Notification' in window)) throw new Error('Notifications are unavailable in this browser');
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') throw new Error('Notifications denied');
  const pending: number[] = [];
  for (const item of items) {
    const delay = item.at - Date.now();
    if (delay <= 0 || delay > 2147483647) continue;
    pending.push(window.setTimeout(() => {
      const notice = new Notification(item.title, { body: item.body, tag: `${app}/${item.id}` });
      notice.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('jig-open', { detail: { app, screen: item.open } })); notice.close(); };
    }, delay));
  }
  timers.set(app, pending);
}
