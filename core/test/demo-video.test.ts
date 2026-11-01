// The side-by-side composer's segment math (scripts/demo-compose.mjs): the two
// takes stay in step at every shared mark, with the shorter side of each segment
// held on its last frame.
import { test } from "node:test";
import assert from "node:assert/strict";
// The compose script is plain JS outside the core package.
 // @ts-ignore
import { commonMarks, filterComplex, planSegments } from "../../scripts/demo-compose.mjs";

const ios = { startedAt: 1000, marks: [{ name: "a", t: 5000 }, { name: "b", t: 9000 }, { name: "solo", t: 12000 }] };
const and = { startedAt: 2000, marks: [{ name: "b", t: 11000 }, { name: "a", t: 6000 }] };

test("common marks follow the iOS order", () => {
  assert.deepEqual(commonMarks(ios.marks, and.marks).map((m: any) => m.name), ["a", "b"]);
});

test("segments line up at every shared mark", () => {
  const segs = planSegments(ios, and);
  assert.equal(segs.length, 3);
  // Lead-in: each side's own length to the first mark, trimmed to the shorter.
  assert.deepEqual(segs[0], { ios: [0, 4], and: [0, 4] });
  // Mark a→b in each side's clock.
  assert.deepEqual(segs[1], { ios: [4, 8], and: [4, 9] });
  // Tail runs 3 s past the last mark.
  assert.deepEqual(segs[2], { ios: [8, 11], and: [9, 12] });
});

test("no shared marks means no segments", () => {
  assert.deepEqual(planSegments(ios, { startedAt: 0, marks: [] }), []);
});

test("the filter holds the shorter side and stacks iPhone left", () => {
  const filter = filterComplex(planSegments(ios, and));
  // Segment 1's iOS side (4 s) is held for the Android side's extra second.
  assert.ok(filter.includes("tpad=stop_mode=clone:stop_duration=1"), filter);
  // The lead-in matches on both sides, so it holds nothing.
  assert.ok(!filter.includes("stop_duration=0"), filter);
  assert.ok(filter.includes("scale=-2:1920,fps=30"), filter);
  assert.ok(filter.includes("concat=n=3:v=1:a=0"), filter);
  assert.ok(filter.includes("pad=iw+40:ih"), filter);
  assert.ok(filter.includes("hstack=inputs=2[vout]"), filter);
});

test("each lead-in ends at its own first mark", () => {
  const first = planSegments(
    { startedAt: 0, marks: [{ name: "a", t: 5000 }] },
    { startedAt: 0, marks: [{ name: "a", t: 3000 }] },
  );
  assert.equal(first.length, 2);
  // L = min(5, 3) = 3: both lead-ins run 3 s and end at their own mark.
  assert.deepEqual(first[0], { ios: [2, 5], and: [0, 3] });
});

test("a short take holds its last frame through the 3 s tail", () => {
  const tail = [{ ios: [10, 13], and: [10, 13] }];
  const filter = filterComplex(tail, { ios: 11, android: 20 });
  // The iOS trim ends at the recording's real end; the missing 2 s are held.
  assert.ok(filter.includes("trim=start=10:end=11"), filter);
  assert.ok(filter.includes("tpad=stop_mode=clone:stop_duration=2"), filter);
});

test("both short takes still play the full tail", () => {
  const tail = [{ ios: [10, 13], and: [10, 13] }];
  const filter = filterComplex(tail, { ios: 11, android: 11 });
  // Each side shows 1 s and holds 2 s, so both halves stay 3 s long.
  const holds = filter.match(/stop_duration=2/g) ?? [];
  assert.equal(holds.length, 2);
});

test("a segment ending past the recording is clamped and held", () => {
  const segs = [{ ios: [0, 4], and: [0, 4] }];
  const filter = filterComplex(segs, { ios: 2, android: 10 });
  assert.ok(filter.includes("trim=start=0:end=2"), filter);
  assert.ok(filter.includes("tpad=stop_mode=clone:stop_duration=2"), filter);
});
