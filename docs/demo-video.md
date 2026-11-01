# Demo video plan

A 3-minute video for the hackathon submission. It shows three apps made from a sentence each, and what only the container gives them: reminders while closed, data shared between apps, and Meta's model inside an app. Every scenario below was rehearsed on Nov 1 in the web playground against the live API; the frames in [`demo/`](demo/) are from that run.

## Setup

```bash
npm install
npm run build:native   # only for the iOS / Android takes
npm run dev            # playground at http://localhost:5173
```

- `META_API_KEY` in the repo's `.env` lets the playground build apps with nothing entered. The native apps need the key in the shell's Settings.
- Start each take from a clean slate: clear the site data for `localhost:5173` (DevTools → Application → Clear site data) and reload, which removes generated apps and grants. **Reset app data** (bottom left) resets only the app that's open, e.g. open Pantry and reset it to restore its three items.
- Make the browser window about 1280×900 so the phone frame and the inspector both fit.
- Allow browser notifications for `localhost:5173`. Otherwise the inspector shows a red "schedule: Notifications denied" once an app queues a reminder.
- Keep the playground's window in front while recording. A hidden or background tab throttles animation frames, so screen transitions freeze halfway and saves are delayed.

## Recording commands

```bash
# Web playground: macOS screen recording of a region (or Cmd+Shift+5)
screencapture -v -R 0,0,1280,900 ~/Desktop/jig-web.mov
```

```bash
# iOS Simulator: run the app from Xcode first
xcrun simctl io booted recordVideo --codec=h264 ~/Desktop/jig-ios.mp4
```

```bash
# Android emulator or device: three minutes at most per file
adb shell screenrecord --bit-rate 8000000 /sdcard/jig.mp4
```

```bash
adb pull /sdcard/jig.mp4 ~/Desktop/jig-android.mp4
```

```bash
# Speed up the model's waiting time 4x in post
ffmpeg -i in.mov -filter:v "setpts=0.25*PTS" -an out.mp4
```

Stop the recorders with Ctrl+C. Generation takes 30–150 s per app, so record it in full and time-lapse it in editing, keeping the streamed thoughts readable for a second or two.

## Recording the side-by-side video

The submission's phone footage is scripted takes of the same scenarios on a physical iPhone and Android phone, recorded at the same time and composed into one side-by-side video. A demo script runs inside Jig's JS runtime and drives the app; the model's HTTP traffic is replayed from a tape. Demo scenarios live in `demo/scenarios/<name>.json`, tapes in `demo/tapes/<name>.json` (record a tape in the web playground with `?demo=<name>&record`).

```bash
node scripts/demo-record.mjs [scenario ...]   # → demo/out/<name>-{ios,android}.{mp4,json}
node scripts/demo-compose.mjs --speed generating=2,editing=2 [scenario ...]  # → demo/out/side-by-side.mp4
ELEVENLABS_API_KEY=... node scripts/demo-produce.mjs  # → demo/out/jig-demo.mp4
```

`--speed` plays the segments that start at those marks faster (the model building and editing), and the composer writes `side-by-side-timeline.json` with where each mark lands. `demo-produce.mjs` builds the finished cut from `demo/captions.json`: a still title card, a section of capability tiles that appear one by one, a showcase of the scenarios listed under `showcase` (both phones framed on a 16:9 stage with a chapter title, crossfaded), and a still end card (all stills rendered by `scripts/demo-cards.swift`). It voices `demo/narration.json` with ElevenLabs (`eleven_v4`, which takes performance tags like `[excited]`; lines are cached in `demo/out/voice`). Each line is cued at a scenario's mark, or `intro` / `capabilities` / `outro` plus a `delay`, and a line still talking delays the next. An optional `demo/out/music.mp3` loops under the voice and ducks while it talks.

What they need: both phones unlocked and connected, the iPhone trusted and in Developer Mode, Android USB debugging on. The iPhone shows ReplayKit's "Allow screen recording" prompt at the start of each scenario; accept it so the take records. The iPhone take uses the app's screen recording (its first frame is the take's start), the Android take uses `adb screenrecord`; each side's `.json` stamps that start plus the script's marks, and the composer holds the slower side's last frame in every segment so the two halves stay in step at each mark.

## Storyboard

| Time | Shot | Voiceover |
| --- | --- | --- |
| 0:00–0:15 | Home list on the phone | "Everyone needs small apps no store sells. Jig makes them from a sentence: native apps, not code." |
| 0:15–1:05 | **Scenario 1: plant care**, then one edit | "Muse Spark writes a spec, the container checks it and repairs what fails, and the app runs natively. It even reminds me while it's closed." |
| 1:05–1:45 | **Scenario 2: shopping list from the pantry** | "Apps share data, with my permission. The shopping list reads what my pantry app counted." |
| 1:45–2:25 | **Scenario 3: dinner ideas** with Meta's model | "Apps can ask Meta's model too, with my key staying in the shell." |
| 2:25–2:45 | The same app on iPhone and Android | "One spec, three platforms: the web, UIKit and Android Views." |
| 2:45–3:00 | Home list with the three new icons | "Describe it, use it, change it. That's Jig." |

## Scenario 1: plant care, then an edit

Shows generation, validation and repair, Muse Image icons, a notification permission and an edit with Select.

1. **New app**, type, then **Create**:
   > My houseplants need water on different schedules. Let me add each plant with how many days between waterings, tap to mark it watered, see which are due today, and remind me at 9am when one is due.
2. Stay on the builder while the thoughts stream in ([frame](demo/1a-plants-thinking.jpg)). In the rehearsal it took 35 s, including one "Fixing a change that didn't apply" step, which is the repair loop worth pointing at ([frame](demo/1b-plants-built.jpg)).
3. Back to Home: the app has its Muse Image icon ([frame](demo/1c-home-icon.jpg)). Open it; the shell asks for notifications on first use ([frame](demo/1d-plants-permission.jpg)). **Allow**.
4. Add "Monstera" (7 days) and "Boston fern" (3 days). Tap **Water**.
5. **Change**, then **Screen**, then **Select**, and tap the button on a plant row ([frame](demo/1e-select.jpg)). Type:
   > Make this a Water button that's filled green only when the plant is due, and show the due plants' names in red
6. The model changes the app, then takes a screenshot to check it, and fixes anything that looks off ([frame](demo/1f-edit-log.jpg)). In the rehearsal it fixed doubled numbers ("2 2 plants") without being asked. That bug is fixed now, so expect a different catch or none. Result with a due plant: [frame](demo/1g-plants-after-edit.jpg).

**Reminder while closed:** film this on the iPhone simulator, where reminders are real OS notifications. The web playground only uses browser timers. For a quick take, ask the builder to "move the reminder to <two minutes from now>", keep one plant due, go to the home screen and wait for the banner.

## Scenario 2: shopping list from the pantry

Shows the shared data store and its permission prompt.

1. **New app**:
   > A shopping list that reads my pantry inventory and adds anything I have fewer than 2 of. I can also add my own items, check them off in the store, and clear the checked ones.
2. 35 s in the rehearsal, with one repair and one screenshot check.
3. Open it: "Shopping List wants to read your pantry from Pantry". **Allow** ([frame](demo/2a-shopping-permission.jpg)). Spaghetti (1 left) is already on the list.
4. Add "Oat milk", check items off, **Clear checked**.
5. The payoff: open **Pantry**, count a shelf photo with SAM 3.1 (or lower Jars to 1), then go back to the shopping list. Jars is on it now ([frame](demo/2b-shopping-from-pantry.jpg)). Have a shelf photo ready on the device for the SAM take.

## Scenario 3: dinner ideas with Meta's model

Shows `ask`: an app calling Meta's model without ever seeing the key.

1. **New app**:
   > What's for dinner: I type what's in my fridge, Meta's model suggests three dinners I can cook in 30 minutes with short steps, and I can save the ones I like to a favorites list.
2. This was the slowest build: about 2.5 minutes, with two repairs. Time-lapse it.
3. Open it, keep the prefilled fridge list (or type "eggs, rice, frozen peas, soy sauce, chicken breast"), tap **Suggest 3 dinners**, then **Allow** the AI permission. Three recipe cards arrive in about 20 s ([frame](demo/3a-dinner-ideas.jpg)).
4. **Save to favorites**, scroll to Favorites, tap it: a recipe screen with ingredients and steps ([frame](demo/3b-recipe.jpg)).

## Fixed after the rehearsal

The rehearsal found four problems, all fixed since:

1. **Reminders for days ahead never fired.** `occurrences()` checked a schedule's `if` once, against today's data, so a plant that came due in three days, while the app stayed closed, got no reminder. Now `if`, the title and the body are checked at each occurrence's own time.
2. **`{"set": "x", "to": ""}` failed at runtime**, which the model wrote in two of three apps to clear a text field. An empty action value now means `""`. Validation now also compiles every action expression, so the repair loop catches syntax errors before anyone taps.
3. **The model guessed builtin signatures.** It wrote "2 2 plants total" with `plural`, and "me27ium" with `formatDate(d, 'medium')`. The prompt now gives signatures for those builtins and a few others. A regenerated plant app used both correctly.
4. **Long app titles ran under Change and Done.** The shell now reserves room for them, and long titles wrap to a second line.

## Rehearsal results (Nov 1)

| Scenario | Build time | Repairs | Works in the app |
| --- | --- | --- | --- |
| Plant care | 35 s | 1 | Add, water, due list, schedule queued while a plant is due; label glitches until the edit |
| Plant care edit | 40 s | 0 | Water button and red names; it fixed the doubled numbers on its own |
| Shopping list | 35 s | 1 | Reads Pantry live, check off, clear; `to: ""` error (fixed) |
| Dinner ideas | ~150 s | 2 | Three recipes from the model, favorites, detail screen; `to: ""` error (fixed) |
| Plant care, after the fixes | ~50 s | 3 | Labels clean ("0 due today • 0 plants", "Every 7 days"); reminders queued from the day a plant comes due |

Not rehearsed yet: the native takes (iOS and Android, with the key entered in Settings), the closed-app notification, and the SAM photo count.
