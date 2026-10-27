# Plan: native capabilities

Apps can show data and change it, but they can't play a sound, open a file, know the time as it passes, or show up outside the app. This plan adds those as capabilities of the container: declared in the spec, implemented natively on each host, permissioned per app. An app still can't run code.

## What the apps people ask for need

The test requests so far, and what each lacks:

| Request | Missing |
| --- | --- |
| Sundial clocks with a tutorial | the time as it passes, the sun's position for a place and time, location, compass heading |
| Sunrise clock | the time as it passes, sunrise and sunset times, location, an alarm that fires while the app is closed, a sound, a time picker, keeping the screen lit and bright |
| EPUB reader | opening a file from the device, unpacking the book, showing chapters as formatted text, remembering the page |

Other likely asks: audio and video playback, photos and the camera, sharing a file or text, home-screen widgets, reminders.

## Principles

- **A capability is a contract in core.** It shows up as one of four things:
  - a node type (`video`);
  - an action (`pickFile`);
  - a live value (`clock`, `location`);
  - a section of the spec (`widgets`, `schedule`).

  Each is added to the format tables in `spec.ts`. The JSON Schema, the validator and the prompt then pick it up without further work, so the model can use a capability the day it lands.
- **Each host implements it natively** (iOS, Android, web), and the fake host implements it for tests. A capability is done when it works on all three hosts and the model uses it correctly in a live test.
- **Permissions are per app.**
  - An app declares what it uses: `"capabilities": ["location", "notifications"]`. Validation rejects any use of an undeclared capability.
  - The shell asks the user once per app, the first time it's needed. The platform's own prompt follows (location, microphone).
  - Settings lists what each app may use, and the user can revoke it there.
- **Large data lives in files, not in rows.** Books, recordings and photos go to a per-app file store. Data holds a handle `{id, name, type, size}`, which `image`, `audio` and `video` accept as `src`.
- **Results come back as values.** An action that finishes later, such as a picked file, a photo or a location fix, takes `then` actions. Those actions get the result as `value`, as `onChange` already does.

## Foundations (first, because everything below uses them)

1. **Time that moves.**
   - The problem: the JS engines on the native hosts have no timers, and `now()` is evaluated only once.
   - A `clock` live value fixes this. Any binding that reads `now()` or `clock` is re-evaluated when the host ticks. The tick is every second or every minute, at the finest grain the screen uses.
   - Hosts drive it from CADisplayLink or a timer (iOS), Choreographer or a Handler (Android), and `setTimeout` (web). Ticks stop while nothing on screen reads the time.
2. **Async actions.** `{"pickFile": {...}, "then": [...]}` and the like. The runtime keeps the action's scope until the host answers. Errors go to an `else` branch or to the log.
3. **Capability declarations and the permission flow**, described under Principles. This needs a small shell screen for granting and revoking.
4. **A file store**, the `files` service:
   - Storage: the app's sandbox directory on iOS and Android, and OPFS on the web.
   - Interface: import, read as text, read as a range of bytes, and delete. Data fields get a `file` type.
   - When an app is deleted, its files go with it.

## Capabilities

### 1. Audio and video playback

- **Nodes:** `video {src, playing, loop, muted, controls, fit}` and `audio {src, playing, loop, volume}`.
  - `audio` is invisible unless it has `controls`.
  - `playing` can be bound to state, and `position` is reported back.
  - Events: `onEnded`, plus `onTime` (throttled).
- **iOS:** AVPlayer, with AVPlayerLayer for video and AVPlayerViewController when `controls` is set. The audio session is ambient by default, and set to playback for alarms.
- **Android:** Media3 ExoPlayer and PlayerView, with audio focus.
- **Web:** `<video>` and `<audio>`.
- **Sources:** https URLs, file handles, and a small set of bundled sounds (`@chime`, `@birds`, `@alarm`), so an app can make a sound without needing a file.
- **Recording** reuses the builder's recorder as a `record` action that saves a file.

### 2. Files, photos, camera and sharing

- **`pickFile {accept: ["epub", "pdf", "image/*"], multiple}`.** It imports the chosen file into the store and returns a handle.
  - iOS: UIDocumentPickerViewController.
  - Android: ACTION_OPEN_DOCUMENT (the Storage Access Framework).
  - Web: `<input type=file>`.
- **`pickPhoto {multiple}` and `takePhoto`.**
  - iOS: PHPickerViewController, which needs no library permission, and UIImagePickerController for the camera.
  - Android: the system Photo Picker and ACTION_IMAGE_CAPTURE.
  - Web: `<input accept="image/*" capture>`.
  - These feed the SAM pantry demo later.
- **`share {text, url, file}`.**
  - iOS: UIActivityViewController.
  - Android: ACTION_SEND.
  - Web: the Web Share API, with a download as the fallback.

### 3. Time, sun and place

- **Builtins in core**, written in pure JS so every host gets the same answer and they can be tested in Node:
  - `sunTimes(lat, lon, date)`: sunrise, sunset, solar noon and dawn.
  - `sunPosition(lat, lon, datetime)`: azimuth and altitude.
  - `formatTime`, and durations between times.
- **`location`**, a live value, coarse by default: CoreLocation, the fused location provider, and `navigator.geolocation`. Apps can also take a place the user types instead.
- **`heading`**, a live value from the compass, for aligning a sundial: CLHeading, the rotation-vector sensor, and DeviceOrientation.
- **Controls:**
  - `slider`: native UISlider, SeekBar and `<input type=range>`, with the value reported on release, as the README describes for continuous gestures.
  - `timePicker` and `datePicker`: UIDatePicker, MaterialTimePicker, and `<input type=time>`.

### 4. Alarms, reminders and background jobs

- **A `schedule` section:** "at sunrise, or at 07:00 on weekdays, notify with this text and sound, and open this screen".
  - The container schedules it with the OS ahead of time, because no JS runs while the app is closed.
  - It reschedules when the data changes or the app opens.
- **iOS:** UNUserNotificationCenter for reminders, and AlarmKit (iOS 26) for an alarm that sounds through silent mode.
- **Android:** NotificationManager, plus AlarmManager exact alarms (with their permission) and full-screen intents for alarms.
- **Web:** the Notifications API while the tab is open, for the playground only.
- **A sunrise alarm** combines these with `keepAwake` and `brightness`. When the alarm opens the app, a screen fades from dark to warm light.

### 5. Home-screen widgets

- **A `widgets` section:** `{"today": {"sizes": ["small", "medium"], "body": node, "tap": {"navigate": "main"}}}`, bound to the app's data like a screen.
- **How it's drawn.**
  - Widgets can't run the JS runtime, so the app renders each widget headlessly at the widget's size: layout runs in JS, as it does today.
  - The result is a static tree of positioned text, shapes and images, written to shared storage.
- **iOS:** an App Group, and a WidgetKit extension that draws the tree in SwiftUI. Taps use `widgetURL`, which deep-links to the app and screen.
- **Android:** a Glance or RemoteViews widget that shows the tree drawn to a bitmap. Taps use a PendingIntent.
- **When it updates:**
  - when the app's data changes;
  - from a timeline for anything that reads the clock, with the next entries rendered ahead (a sunrise countdown every minute).
- **Interactive widgets** (App Intents, Android widget actions) come after: a tap on a widget runs one of the app's actions.
- **The web** has no widgets. The playground shows a preview of each size.

### 6. Documents

- **An `epub` service:** it unzips the book, reads the OPF, and returns chapters as structured text: headings, paragraphs, emphasis, images and links. EPUBs are XHTML, so this parser can be shared.
- **A `richtext` node** draws that structure natively, with no web view:
  - iOS: NSAttributedString, in a text view that's selectable but can't be edited.
  - Android: Spanned text.
  - Web: plain DOM.

  It can paginate to the screen, reports `onPage`, and the app stores the position.
- **PDF later:** PDFKit, PdfRenderer and pdf.js.

### 7. Smaller ones

| Capability | iOS | Android | Web |
| --- | --- | --- | --- |
| `haptic` (light, success, warning) | UIImpactFeedbackGenerator / UINotificationFeedbackGenerator | `View.performHapticFeedback` | `navigator.vibrate` |
| `keepAwake`, `brightness` | `isIdleTimerDisabled`, `UIScreen.brightness` | `FLAG_KEEP_SCREEN_ON`, window `screenBrightness` | Wake Lock API, none |
| `speak` (read a tutorial step aloud) | AVSpeechSynthesizer | TextToSpeech | `speechSynthesis` |
| `copy`, `openUrl` | UIPasteboard, `open` | ClipboardManager, Intent | Clipboard API, `window.open` |

## Order

Each phase ends working on all three hosts, with core tests, the prompt and schema updated, and a live model test of the app it unlocks.

| Phase | Builds | Unlocks | Size |
| --- | --- | --- | --- |
| A | clock ticks, async actions, capability declarations and permissions, the file store | everything below | 2 days |
| B | sun and time builtins, `location`, `heading`, slider and time picker | the sundial | 2 days |
| C | audio and video, bundled sounds, haptics, `keepAwake` and brightness, `speak` | the sunrise clock in the foreground | 2 days |
| D | the `schedule` section: notifications, alarms (AlarmKit, exact alarms) | the sunrise alarm while closed, reminders for the meds app | 2–3 days |
| E | file, photo and camera pickers, `share` | photo inputs, the SAM pantry demo | 1–2 days |
| F | `epub` and `richtext` with pagination | the EPUB reader | 3 days |
| G | widgets, then interactive widgets | the water and sunrise widgets | 3–4 days |

## How each one is checked

- **Core tests** with the fake host: the spec shape, validation, permissions, actions with results, and the clock re-evaluating only the bindings that read it.
- **On each host:** the iOS simulator, the Android emulator and the web playground, using a small showcase screen for every capability, as the showcase app does today.
- **Live:** the builder makes the app that capability unlocks (sundial, sunrise clock, EPUB reader), and the result is checked to work and to use the capability rather than faking it.

## Open questions

- **When to ask for permission:** when an app is created, or the first time it uses each capability. The plan assumes the first use, with the list editable in Settings.
- **Alarms on older iOS:** below iOS 26 a real alarm isn't possible. The fallback is a time-sensitive notification with a sound, which silent mode can mute.
- **Widget rendering on Android:** a bitmap is simplest and matches iOS exactly, but the text isn't accessible. RemoteViews built from the tree would be, but it supports fewer layouts.
