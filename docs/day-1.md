# Day 1 — Oct 26, 2026

The plan gave days 1–3 to the spec format, the renderer and the data layer. Day 1 got all three, plus the iOS and Android hosts and a motion system: the same JSON spec now runs natively on the web, iPhone and Android from one shared runtime.

## What exists now

| Part | What it does |
| --- | --- |
| `core/` (TypeScript, ~76 KB bundled) | Spec → view tree → layout → one batch of ops per frame. Signals for targeted updates, a safe expression language, keyed lists, actions, navigation, persisted data, dark mode, transitions. |
| `web/` | DOM host plus a playground: app list, live spec editor (edits apply as you type), ops/frame/data inspector. |
| `ios/` | UIKit host. JavaScriptCore on its own queue, text measured and drawn with the same API, SVG path parser, keyboard avoidance, interactive back swipe. |
| `android/` | Android Views host. QuickJS on its own thread, StaticLayout text, predictive back. |
| `core/native/host.js` | The JS glue both native hosts share: one `__native` contract. |
| `specs/` | Water tracker, chore chart, medication log, and a showcase that exercises every primitive. |

All four apps were checked by hand on all three platforms: taps, typing, toggles, list add/remove, navigation and back, persistence across restarts, dark mode, keyboard, and animations.

## The runtime in one paragraph

Each `{{binding}}` is an effect subscribed only to the state it reads, so a tap updates exactly the nodes that depend on it. Layout is a flexbox subset in plain JS with a measurement cache and dirty flags; a clean subtree with unchanged constraints is skipped. Each frame sends one batch of `create / update / insert / remove / frame / command` ops. The host renders those ops and measures text, nothing more. Animation stays native: the runtime describes it (a `transition` style, or a screen `transition` command), and each host animates with its own toolkit.

## Decisions made today

- **One runtime, thin hosts.** Hosts never decide layout; they measure text and apply frames. UIKit and Android Views, not SwiftUI or Compose, because those would fight an external layout.
- **System fonts per platform**, instead of bundling Inter. Each host measures with the font it draws, so layout is exact per platform; line breaks may differ slightly across platforms. (The Inter files in `resources/fonts/` are unused.)
- **Data vs state.** `data` is typed and persisted (and is what a shared data store will see later); `state` is transient UI.
- **Actions run in order**, and each one sees what the previous one wrote. With batching, "toggle a chore, then add a star if it's done" read the old value.
- **Snapshots for screen transitions.** The host snapshots the old screen before applying a navigation batch, so the runtime never keeps two screens alive. The same snapshots power the interactive back gesture.
- **Stroke trim for arcs.** The ring draws a full circle with `trimEnd` instead of rebuilding an arc path, so every platform can animate it natively.
- **Bundled runtime assets.** `npm run build:native` copies the core bundle, the glue and the specs into both apps; the copies are gitignored.

## Bugs worth remembering

Most were mismatches between what the runtime measured and what a host drew:

- **UILabel drops lines.** It lays out text with a different engine than the API we measure with. Fix: draw text with the measuring API (iOS `NSStringDrawing`, Android `StaticLayout`).
- **Pixel rounding on Android.** Rounding the frame and the padding separately made the drawing box a pixel narrower than the measured text, so "Back" wrapped. Fix: 1dp of slack.
- **Columns squeezed headers.** A tall scroll view's overflow was shared across every item in the screen column. Fix: CSS `min-height: auto` semantics, where only scroll views shrink in a column.
- **CSS borders eat the content box.** Fix: draw web borders as inset outlines.
- **Clipping.** Turning off clipping for rounded corners made scroll views draw over the header (iOS). On Android, a view's own clipping is controlled by its parent, so it needed outline clipping.
- **Native controls have their own size.** The newer `UISwitch` is wider than 51×31. Hosts now report control sizes through `measureControl`.
- **Testing traps.** Simulator screenshots lag; synthetic taps can be too short for the new switch; an x=6 start isn't an edge swipe. Slowed animations (`-animationSpeed 0.05` on iOS, the animator scale on Android) made checking motion possible.

## Status against the plan

Core checklist:

- [x] Spec format, runtime, flex layout, phase timers
- [x] Web, iOS and Android hosts
- [x] Per-app storage
- [ ] JSON Schema for validation
- [ ] Spec generation with Muse Spark, the edit loop, automatic repair
- [ ] Scheduler, notifications, shared data store, SAM camera input, Muse Image icons

## Known gaps

- After a back swipe commits, the previous screen briefly shows its snapshot, which can be stale if its data changed meanwhile.
- Text sizes ignore the user's font-size setting on every platform.
- No list virtualization; layout runs on the JS thread for hundreds of nodes, unprofiled on devices.
- Android's framework switch looks flatter than iOS; the toggles work and use the accent color.

## Next (day 2)

1. JSON Schema for the spec, generated from `core/src/spec.ts`, used to validate specs and to drive structured outputs.
2. Muse Spark: describe → spec, then edit by prompt, with validation errors and `runtime.errors` fed back for automatic repair.
3. A prompt UI in the playground and in both native apps.
