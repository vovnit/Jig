import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, type Scope } from "../src/expr.ts";
import { sunPosition, sunTimes } from "../src/sun.ts";

const scope = (vars: Record<string, unknown>): Scope => ({ lookup: (n) => vars[n], has: (n) => n in vars });
const MIN = 60000;

test("London midsummer sunrise and sunset", () => {
  const day = Date.UTC(2026, 5, 21);
  const t = sunTimes(51.5074, -0.1278, day);
  const { sunrise, sunset, noon, dawn, dusk } = t;
  assert.ok(sunrise != null && sunset != null);
  assert.ok(Math.abs(sunrise - (day + (3 * 60 + 43) * MIN)) <= 2 * MIN, `sunrise ${new Date(sunrise).toISOString()}`);
  assert.ok(Math.abs(sunset - (day + (20 * 60 + 21) * MIN)) <= 2 * MIN, `sunset ${new Date(sunset).toISOString()}`);
  assert.ok(dawn != null && dusk != null);
  assert.ok(dawn < sunrise && sunrise < noon && noon < sunset && sunset < dusk);
  // The sun sits on the horizon at sunrise, and high at noon.
  assert.ok(Math.abs(sunPosition(51.5074, -0.1278, sunrise).altitude + 0.833) < 1);
  assert.ok(sunPosition(51.5074, -0.1278, noon).altitude > 50);
});

test("equator equinox noon is nearly overhead", () => {
  const p = sunPosition(0, 0, Date.UTC(2026, 2, 20, 12, 0));
  assert.ok(p.altitude > 85, `altitude ${p.altitude}`);
  assert.ok(p.azimuth >= 0 && p.azimuth < 360);
});

test("Tromso midnight sun has no sunrise or sunset", () => {
  const t = sunTimes(69.6496, 18.956, Date.UTC(2026, 5, 21));
  assert.equal(t.sunrise, null);
  assert.equal(t.sunset, null);
  assert.equal(t.dawn, null);
  assert.equal(t.dusk, null);
  assert.ok(Number.isFinite(t.noon));
});

test("sun builtins work in spec expressions", () => {
  const s = scope({});
  const pos = compile("sunPosition(51.5074, -0.1278, '2026-06-21T12:00:00Z')")(s) as { azimuth: number; altitude: number };
  assert.ok(pos.altitude > 50, `altitude ${pos.altitude}`);
  assert.ok(pos.azimuth >= 0 && pos.azimuth < 360);
  const t = compile("sunTimes(51.5074, -0.1278, '2026-06-21')")(s) as ReturnType<typeof sunTimes>;
  const day = Date.UTC(2026, 5, 21);
  assert.ok(t.sunrise != null && Math.abs(t.sunrise - (day + (3 * 60 + 43) * MIN)) <= 2 * MIN);
  assert.ok(t.sunset != null && Math.abs(t.sunset - (day + (20 * 60 + 21) * MIN)) <= 2 * MIN);
  const polar = compile("sunTimes(69.6496, 18.956, '2026-06-21')")(s) as ReturnType<typeof sunTimes>;
  assert.equal(polar.sunrise, null);
  assert.equal(polar.sunset, null);
});

test("solar noon azimuth faces south in London, north in Sydney", () => {
  const day = Date.UTC(2026, 5, 21);
  const london = sunPosition(51.5074, -0.1278, sunTimes(51.5074, -0.1278, day).noon);
  assert.ok(Math.abs(london.azimuth - 180) <= 1, `London azimuth ${london.azimuth}`);
  assert.ok(Math.abs(london.altitude - 61.9) <= 0.5, `London altitude ${london.altitude}`);
  const sydney = sunPosition(-33.8688, 151.2093, sunTimes(-33.8688, 151.2093, day).noon);
  assert.ok(Math.min(sydney.azimuth, 360 - sydney.azimuth) <= 1, `Sydney azimuth ${sydney.azimuth}`);
});

test("New York midsummer sunrise, sunset and civil twilight", () => {
  const day = Date.UTC(2026, 5, 21);
  const t = sunTimes(40.7128, -74.006, day);
  assert.ok(t.sunrise != null && Math.abs(t.sunrise - (day + (9 * 60 + 25) * MIN)) <= 2 * MIN, `sunrise ${t.sunrise == null ? null : new Date(t.sunrise).toISOString()}`);
  assert.ok(t.sunset != null && Math.abs(t.sunset - (day + (24 * 60 + 30) * MIN)) <= 2 * MIN, `sunset ${t.sunset == null ? null : new Date(t.sunset).toISOString()}`);
  assert.ok(t.dawn != null && Math.abs(t.dawn - (day + (8 * 60 + 52) * MIN)) <= 3 * MIN, `dawn ${t.dawn == null ? null : new Date(t.dawn).toISOString()}`);
  assert.ok(t.dusk != null && Math.abs(t.dusk - (day + (24 * 60 + 63) * MIN)) <= 3 * MIN, `dusk ${t.dusk == null ? null : new Date(t.dusk).toISOString()}`);
});

test("Tromso polar night has no sunrise or sunset", () => {
  const t = sunTimes(69.6496, 18.956, Date.UTC(2026, 11, 21));
  assert.equal(t.sunrise, null);
  assert.equal(t.sunset, null);
});

test("sunTimes takes the UTC day of an offset datetime", () => {
  const s = scope({});
  const a = compile("sunTimes(51.5074, -0.1278, '2026-06-21T23:30:00-05:00')")(s);
  const b = compile("sunTimes(51.5074, -0.1278, '2026-06-22')")(s);
  assert.deepEqual(a, b);
});
