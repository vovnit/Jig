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
6. The model changes the app, takes a screenshot of it, and fixes a glitch it saw on its own. In the rehearsal it fixed the doubled numbers ("2 2 plants") without being asked ([frame](demo/1f-edit-log.jpg)). Result with a due plant: [frame](demo/1g-plants-after-edit.jpg).

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

## Fix before recording

Found in the rehearsal, most important first:

1. **Reminders for days ahead never fire.** `occurrences()` checks a schedule's `if` once, against today's data ([schedule.ts:28](../core/src/schedule.ts)). A plant that comes due in three days, while the app stays closed, gets no 9 am reminder. Fix: check `if` for each occurrence with the clock set to that time (`withClock`).
2. **`{"set": "x", "to": ""}` fails at runtime** ("Unexpected token in: "). The model wrote it in two of three apps, to clear a text field, and the red error shows under the inspector on camera. Validation doesn't compile action expressions, so the repair loop never sees it. Fix: compile every action expression when validating, and/or treat `""` as an empty string.
3. **The prompt lists function names without signatures** ([prompt.ts:61](../core/src/builder/prompt.ts)). The model guessed wrong twice: `plural(n, 'plant', 'plants')` already includes the number, which gave "2 2 plants total", and `formatDate(d, 'medium')` printed "me27ium". Fix: give the few ambiguous builtins a signature and an example.
4. **Long app titles run under Change and Done** in the shell ("Shopping Lis", "What's for di").

## Rehearsal results (Nov 1)

| Scenario | Build time | Repairs | Works in the app |
| --- | --- | --- | --- |
| Plant care | 35 s | 1 | Add, water, due list, schedule queued while a plant is due; label glitches until the edit |
| Plant care edit | 40 s | 0 | Water button and red names; it fixed the doubled numbers on its own |
| Shopping list | 35 s | 1 | Reads Pantry live, check off, clear; `to: ""` error |
| Dinner ideas | ~150 s | 2 | Three recipes from the model, favorites, detail screen; `to: ""` error |

Not rehearsed yet: the native takes (iOS and Android, with the key entered in Settings), the closed-app notification, and the SAM photo count.
