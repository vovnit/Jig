// Phase B: location and heading live values, slider and time picker controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpec } from "../src/spec.ts";
import { registerAsyncAction, unregisterAsyncAction } from "../src/spec.ts";
import { installBuilder } from "../src/builder/index.ts";
import { validateSpec } from "../src/builder/validate.ts";
import { boot, byText, frame } from "./fake-host.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

const locSpec = (body: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
  ({ id: "l", name: "L", capabilities: ["location"], screens: { main: { body } }, ...extra }) as AppSpec;

test("live location reaches a bound text after the gate allows it", async () => {
  const spec = locSpec({ type: "text", value: "{{location ? location.lat : 'Locating…'}}" });
  const { host, rt } = boot(spec, undefined, undefined, { gate: () => true });
  frame(host);
  assert.ok(byText(rt, "Locating…"), "null until the first fix");
  await tick();
  assert.ok(host.locationWatch, "the gate allowed it, so the watch started");
  host.pushLocation({ lat: 51.5, lon: -0.1, accuracy: 65 });
  frame(host);
  assert.ok(byText(rt, "51.5"));
  assert.deepEqual(rt.errors, []);
});

test("a denied location stays null with one error", async () => {
  const spec = locSpec({ type: "text", value: "{{location ? 'here' : 'Locating…'}}" });
  const { host, rt } = boot(spec, undefined, undefined, { gate: () => false });
  frame(host);
  await tick();
  frame(host);
  assert.ok(byText(rt, "Locating…"));
  assert.deepEqual(rt.errors, [{ where: "location", message: "Location isn't allowed" }]);
  assert.equal(host.locationWatch, null, "no watch after a denial");
});

test("a watch error keeps the last value and is recorded once", async () => {
  const spec = locSpec({ type: "text", value: "{{location ? location.lat : 'Locating…'}}" });
  const { host, rt } = boot(spec, undefined, undefined, { gate: () => true });
  frame(host);
  await tick();
  host.pushLocation({ lat: 10, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(rt, "10"));
  host.failLocation("No location available");
  host.failLocation("No location available");
  frame(host);
  assert.ok(byText(rt, "10"), "the value stays as it was");
  assert.equal(rt.errors.filter((e) => e.message === "No location available").length, 1);
});

test("stop is called on dispose and on a fresh load", async () => {
  const spec = locSpec({ type: "text", value: "{{location ? 'here' : 'Locating…'}}" });
  const { host, rt } = boot(spec, undefined, undefined, { gate: () => true });
  frame(host);
  await tick();
  assert.ok(host.locationWatch, "watching");
  rt.dispose();
  assert.ok(host.calls.some((c) => c.service === "location.stop"), "dispose stops the watch");

  const again = boot(spec, undefined, undefined, { gate: () => true });
  frame(again.host);
  await tick();
  assert.ok(again.host.locationWatch, "watching again");
  again.rt.load(spec);
  frame(again.host);
  assert.ok(again.host.calls.some((c) => c.service === "location.stop"), "a fresh load stops the watch");
});

test("heading needs no gate", async () => {
  const spec: AppSpec = {
    id: "h",
    name: "H",
    capabilities: ["heading"],
    screens: { main: { body: { type: "text", value: "{{heading ? heading.degrees : 'No compass'}}" } } },
  };
  let gates = 0;
  const { host, rt } = boot(spec, undefined, undefined, {
    gate: () => {
      gates++;
      return true;
    },
  });
  frame(host);
  await tick();
  assert.ok(host.headingWatch, "the watch started without asking");
  assert.equal(gates, 0);
  host.pushHeading({ degrees: 90, accuracy: 5 });
  frame(host);
  assert.ok(byText(rt, "90"));
});

test("a slider's change updates its bound value and runs onChange", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    state: { volume: 0.5, note: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "slider", bind: "volume", min: 0, max: 1, step: 0.1, onChange: { set: "note", to: "value" } },
            { type: "text", value: "{{volume}}" },
          ],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  frame(host);
  const slider = [...rt.nodes.values()].find((n) => n.type === "slider")!;
  rt.dispatch(slider.id, "change", { value: 0.8 });
  frame(host);
  assert.equal(rt.get("volume"), 0.8);
  assert.equal(rt.get("note"), 0.8);
  assert.ok(byText(rt, "0.8"));

  rt.dispatch(slider.id, "change", { value: "0.9" });
  frame(host);
  assert.equal(rt.get("volume"), 0.9, "the slider's value is coerced to a number");
});

test("a time picker's change updates its bound value and runs onChange", () => {
  const spec: AppSpec = {
    id: "s",
    name: "S",
    state: { alarm: "07:00", note: "" },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "timePicker", bind: "alarm", onChange: { set: "note", to: "value" } },
            { type: "text", value: "{{alarm}}" },
          ],
        },
      },
    },
  };
  const { host, rt } = boot(spec);
  frame(host);
  const picker = [...rt.nodes.values()].find((n) => n.type === "timePicker")!;
  rt.dispatch(picker.id, "change", { value: "08:30" });
  frame(host);
  assert.equal(rt.get("alarm"), "08:30");
  assert.equal(rt.get("note"), "08:30");
  assert.ok(byText(rt, "08:30"));
});

test("validation requires the capabilities for location and heading", () => {
  const body = (node: unknown, extra: Partial<AppSpec> = {}): AppSpec =>
    ({ id: "t", name: "T", screens: { main: { body: node } }, ...extra }) as AppSpec;
  assert.match(validateSpec(body({ type: "text", value: "{{location.lat}}" })).join("\n"), /uses 'location'; add "location" to capabilities/);
  assert.match(validateSpec(body({ type: "text", value: "{{heading.degrees}}" })).join("\n"), /uses 'heading'; add "heading" to capabilities/);
  assert.deepEqual(validateSpec(body({ type: "text", value: "{{location.lat}}" }, { capabilities: ["location"] })), []);
  assert.deepEqual(validateSpec(body({ type: "text", value: "{{heading.degrees}}" }, { capabilities: ["heading"] })), []);
  // An app's own key shadows the live value.
  assert.deepEqual(validateSpec(body({ type: "text", value: "{{location}}" }, { state: { location: "home" } })), []);
});

test("the shell's permission question appears for location in an embedded app", async () => {
  const inner: AppSpec = {
    id: "inner",
    name: "Inner",
    capabilities: ["location"],
    screens: { main: { body: { type: "text", value: "{{location ? 'here' : 'Locating…'}}" } } },
  };
  const outer: AppSpec = {
    id: "shell",
    name: "Shell",
    data: { grants: { type: "object", default: {} } },
    state: { asking: null, app: inner },
    screens: { main: { body: { type: "app", spec: "{{app}}" } } },
  };
  const { host, rt } = boot(outer, undefined, undefined, { trusted: true });
  installBuilder(rt);
  // `boot` already framed before the gate was installed; reload so the child inherits it.
  rt.load(outer);
  frame(host);
  await tick();
  assert.deepEqual(rt.get("asking"), {
    app: "inner",
    appName: "Inner",
    capability: "location",
    text: "Inner wants to know where you are, roughly.",
  });
});

test("a wrong async action argument type is rejected", (t) => {
  registerAsyncAction("test.echo", { capability: "clock", doc: "echoes text back", args: { text: "text" }, result: "the text" });
  t.after(() => unregisterAsyncAction("test.echo"));
  const spec: AppSpec = {
    id: "t",
    name: "T",
    capabilities: ["clock"],
    state: { x: "" },
    screens: { main: { body: { type: "button", label: "Go", onTap: { "test.echo": { text: {} }, then: { set: "x", to: "value" } } } } },
  };
  assert.match(validateSpec(spec).join("\n"), /text/);
});

const locInner = (id: string, prefix: string): AppSpec =>
  ({
    id,
    name: prefix,
    capabilities: ["location"],
    screens: { main: { body: { type: "text", value: `{{location ? '${prefix} ' + location.lat : '${prefix} Locating…'}}` } } },
  }) as AppSpec;

const locOuter = (a: unknown, b: unknown): AppSpec =>
  ({
    id: "outer",
    name: "Outer",
    state: { a, b },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "app", spec: "{{a}}" },
            { type: "app", spec: "{{b}}" },
          ],
        },
      },
    },
  }) as AppSpec;

test("two embedded apps share one location watch", async () => {
  const { host, rt } = boot(locOuter(locInner("a", "A"), locInner("b", "B")), undefined, undefined, { gate: () => true });
  frame(host);
  await tick();
  assert.ok(host.locationWatch, "the first subscriber started the host watch");
  assert.equal(host.calls.filter((c) => c.service === "location.watch").length, 1, "one host watch for two apps");

  host.pushLocation({ lat: 10, lon: 20, accuracy: 5 });
  frame(host);
  const [childA, childB] = rt.children;
  assert.ok(byText(childA, "A 10"), "both apps get the update");
  assert.ok(byText(childB, "B 10"));

  // A new subscriber gets the latest value at once, without a second host watch.
  host.pushLocation({ lat: 11, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(childA, "A 11"));
  assert.ok(byText(childB, "B 11"));

  // Disposing one keeps the other's updates.
  childA.dispose();
  assert.ok(host.locationWatch, "one subscriber left, so the watch stays");
  assert.equal(host.calls.filter((c) => c.service === "location.stop").length, 0);
  host.pushLocation({ lat: 12, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(childA, "A 11"), "the disposed app is frozen");
  assert.ok(byText(childB, "B 12"), "the other keeps updating");

  // Disposing both stops it.
  childB.dispose();
  assert.equal(host.locationWatch, null, "no subscribers left");
  assert.equal(host.calls.filter((c) => c.service === "location.stop").length, 1, "the last unsubscribe stops the host watch");
});

test("a denied embedded app never subscribes; its dispose doesn't stop the allowed watch", async () => {
  const allowed = locInner("allowed", "A");
  const denied = locInner("denied", "D");
  const { host, rt } = boot(locOuter(allowed, denied), undefined, undefined, { gate: (app) => app.id !== "denied" });
  frame(host);
  await tick();
  frame(host);
  assert.ok(host.locationWatch, "the allowed app started the watch");
  assert.equal(host.calls.filter((c) => c.service === "location.watch").length, 1);
  const [childA, childD] = rt.children;
  assert.deepEqual(childD.errors, [{ where: "location", message: "Location isn't allowed" }], "the denied app stays null with one error");

  host.pushLocation({ lat: 30, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(childA, "A 30"));
  assert.ok(byText(childD, "D Locating…"), "the denied app never gets updates");

  childD.dispose();
  assert.ok(host.locationWatch, "the denied dispose never subscribed, so the watch stays");
  assert.equal(host.calls.filter((c) => c.service === "location.stop").length, 0);
  host.pushLocation({ lat: 31, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(childA, "A 31"), "the allowed app keeps updating");

  childA.dispose();
  assert.equal(host.locationWatch, null);
  assert.equal(host.calls.filter((c) => c.service === "location.stop").length, 1);
});

test("a late embedded subscriber gets the latest location at once", async () => {
  const first = locInner("a", "A");
  const outer: AppSpec = {
    id: "outer",
    name: "Outer",
    state: { a: first, b: null },
    screens: {
      main: {
        body: {
          type: "column",
          children: [
            { type: "app", spec: "{{a}}" },
            { type: "app", spec: "{{b}}" },
          ],
        },
      },
    },
  } as unknown as AppSpec;
  const { host, rt } = boot(outer, undefined, undefined, { gate: () => true });
  frame(host);
  await tick();
  host.pushLocation({ lat: 42, lon: 20, accuracy: 5 });
  frame(host);
  const [childA] = rt.children;
  assert.ok(byText(childA, "A 42"));

  rt.set("b", locInner("b", "B"));
  frame(host);
  await tick();
  frame(host);
  assert.equal(host.calls.filter((c) => c.service === "location.watch").length, 1, "still one host watch");
  const childB = rt.children.find((c) => c !== childA)!;
  assert.ok(byText(childB, "B 42"), "the new subscriber got the latest value at once");
});

test("two embedded apps share one heading watch", async () => {
  const headInner = (id: string, prefix: string): AppSpec =>
    ({
      id,
      name: prefix,
      capabilities: ["heading"],
      screens: { main: { body: { type: "text", value: `{{heading ? '${prefix} ' + heading.degrees : '${prefix} waiting'}}` } } },
    }) as AppSpec;
  const { host, rt } = boot(locOuter(headInner("a", "A"), headInner("b", "B")));
  frame(host);
  assert.ok(host.headingWatch, "the first subscriber started the host watch");
  assert.equal(host.calls.filter((c) => c.service === "heading.watch").length, 1);

  host.pushHeading({ degrees: 90, accuracy: 5 });
  frame(host);
  const [childA, childB] = rt.children;
  assert.ok(byText(childA, "A 90"));
  assert.ok(byText(childB, "B 90"));

  childA.dispose();
  assert.ok(host.headingWatch);
  host.pushHeading({ degrees: 180, accuracy: 5 });
  frame(host);
  assert.ok(byText(childB, "B 180"));

  childB.dispose();
  assert.equal(host.headingWatch, null);
  assert.equal(host.calls.filter((c) => c.service === "heading.stop").length, 1);
});

test("showcase device screen is reachable and handles polar day", async () => {
  const { readFileSync } = await import("node:fs");
  const spec = JSON.parse(readFileSync(new URL("../../specs/showcase.json", import.meta.url), "utf8")) as AppSpec;
  const main = spec.screens.main.body as { children?: { label?: string; variant?: string; onTap?: unknown }[] };
  const button = main.children?.find((c) => JSON.stringify(c.onTap ?? {}).includes('"device"'));
  assert.ok(button, "main has a button that navigates to the device screen");
  assert.equal(button?.variant, "secondary", "in the style of the long-list button");

  const { host, rt } = boot(spec);
  frame(host);
  rt.dispatch(byText(rt, button?.label as string)!.id, "tap");
  frame(host);
  assert.equal(rt.nav.peek().at(-1)?.screen, "device", "the button navigates to the device screen");

  // The pole never crosses the horizon, so sunrise and sunset are null.
  await tick();
  host.pushLocation({ lat: 90, lon: 0, accuracy: 10 });
  frame(host);
  assert.ok(byText(rt, "No sunrise today"), "null sunrise isn't formatted");
  assert.ok(byText(rt, "No sunset today"), "null sunset isn't formatted");
  assert.deepEqual(rt.errors, []);
});


test("late subscribers receive a shared watch's terminal error", async () => {
  const { host, rt } = boot(locOuter(locInner("a", "A"), null), undefined, undefined, { gate: () => true });
  await tick();
  host.failLocation("No location available");
  rt.set("b", locInner("b", "B"));
  frame(host);
  await tick();
  frame(host);
  assert.deepEqual(rt.children[1].errors, [{ where: "location", message: "No location available" }]);
});

test("a join after a watch error restarts the host watch", async () => {
  const { host, rt } = boot(locOuter(locInner("a", "A"), null), undefined, undefined, { gate: () => true });
  await tick();
  frame(host);
  assert.equal(host.calls.filter((c) => c.service === "location.watch").length, 1);
  host.failLocation("No location available");
  rt.set("b", locInner("b", "B"));
  frame(host);
  await tick();
  frame(host);
  assert.equal(host.calls.filter((c) => c.service === "location.watch").length, 2, "the late join restarts the dead watch");
  const childB = rt.children[1];
  assert.deepEqual(childB.errors, [{ where: "location", message: "No location available" }], "the terminal error is kept");
  // The restarted watch feeds every subscriber, and a second failure is recorded again.
  host.pushLocation({ lat: 7, lon: 20, accuracy: 5 });
  frame(host);
  assert.ok(byText(rt.children[0], "A 7"));
  assert.ok(byText(childB, "B 7"));
  host.failLocation("Lost signal");
  frame(host);
  assert.ok(childB.errors.some((e) => e.message === "Lost signal"), "the next error is recorded for the restarted watch");
});

test("nested apps subscribe without requiring location on intermediate containers", async () => {
  const wrapper = locOuter(locInner("a", "A"), null);
  const { host, rt } = boot(locOuter(wrapper, null), undefined, undefined, { gate: () => true });
  await tick();
  host.pushLocation({ lat: 42, lon: 20, accuracy: 5 });
  frame(host);
  const inner = rt.children[0].children[0];
  assert.ok(byText(inner, "A 42"));
  assert.deepEqual(inner.errors, []);
  assert.equal(host.calls.filter(c => c.service === "location.watch").length, 1);
});
