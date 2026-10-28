# AI in apps, and learning apps

Two features that use the Meta Model API key from the shell's Settings:

- **AI apps**: an app can ask Meta's model through an `ask` action. It uses the key without ever seeing it, the same way `findObjects` does.
- **Learning**: an app can be set to learn. While it learns, the shell records how you use it. When you leave it, the model looks at that record and may make one small change to the app, which you can undo.

## AI apps

### In the spec

```json
"capabilities": ["ai"],
"actions": {
  "send": [
    {"ask": {"prompt": "{{input}}", "system": "You are a patient Spanish tutor.", "history": "{{slice(messages, -20)}}", "into": "draft"},
     "then": [{"add": "messages", "value": {"role": "'model'", "text": "value"}}, {"set": "draft", "to": "''"}],
     "else": [{"set": "problem", "to": "error"}]}
  ]
}
```

`ask` is an async action. Its capability is `ai`: "ask Meta's model, using your API key". The capability asks the first time.

Args:

| Arg | Kind | Meaning |
| --- | --- | --- |
| `prompt` | text | The question. Required, and must not be empty. |
| `system` | text | Instructions for the model: a persona, rules, output style. |
| `history` | any | Earlier turns, oldest first: `[{role: "user" \| "model", text}]`. Other items and fields are ignored. |
| `images` | any | One file handle or a list of handles (from `pickPhoto`, `takePhoto` or `pickFile`), sent with the prompt. |
| `schema` | any | A JSON Schema. When it's given, the answer is parsed JSON instead of text. |
| `into` | string | The name of one of the app's `state` keys. The answer's text is set there as it streams, so chat apps show it while it's written. When the call finishes, the key holds the whole text; `then` usually clears it. |
| `effort` | `minimal` \| `low` \| `medium` \| `high` | How hard the model thinks. The default is `low`. |
| `maxTokens` | number | The answer's length limit. The default is 4000; values are clamped to the range 1 to 16000. |

`then` gets `value`: the answer's text, or the parsed object when `schema` is given. `else` gets `error`.

### The shell's service

The `ask` container service lives in `core/src/ai.ts`, installed by `installBuilder` next to `installVision`.

- **No key:** the call fails with "Add a Meta Model API key in Settings to use AI in apps."
- **Request:**
  - `POST {baseUrl}/responses` with the shell's `model`, `stream: true` and `reasoning: {effort}`.
  - `max_output_tokens` is set from `maxTokens`.
  - `instructions` is `system`.
  - `input` is the history turns as `{role: "user" | "assistant", content: text}`, then the user turn: the prompt as `input_text`, plus each image as an `input_image` data URL. Images are read with `files.read` as base64; the MIME type comes from the handle's `type`, defaulting to `image/jpeg`.
- **Streaming:** the `response.output_text.delta` events add up to the answer. While `into` is set, the shell sets the running app's state key to the text so far, at most once every 100 ms, and once more at the end.
  - The running app is the app runtime with that id, among the shell's embedded runtimes at any depth.
  - If `into` isn't one of the app's `state` keys, the call fails before it starts with "`into` must be one of the app's state keys".
  - Reasoning events are ignored.
  - A host that can't stream answers with the whole body; read it the same way the agent does (`readResponseBody`-style).
- **Schema:**
  - The request adds `text: {format: {type: "json_schema", name: "answer", schema, strict: false}}`, and the instructions end with "Answer only with JSON that matches the schema."
  - The answer is parsed with `JSON.parse` after stripping a surrounding ```` ```json ```` fence.
  - If it doesn't parse, the call fails with "The model's answer wasn't valid JSON".
- **Limits** (failures go to `else`):
  - Prompt, system and history text together: at most 100,000 characters, else "The request is too long".
  - At most 4 images, else "Too many images (at most 4)".
  - At most 20 calls per app per minute, else "Too many AI requests; wait a moment". This guards the user's bill against a runaway loop.
  - A 120 s timeout.
- **HTTP errors:**
  - A 401 is reported as "The API key was refused".
  - Any other non-2xx is reported as "The model answered <status>", with the API's `error.message` when the body has one.
- **Privacy:** the service never puts the key into the app's state, `value` or `error`.

### The builder

- **The prompt** gets a short "AI in apps" section:
  - When to use `ask`: chat, writing help, summaries, tutoring, questions about a photo, turning free text into structured data with `schema`.
  - The args, and the chat pattern: messages in a data list, `history: slice(messages, -20)`, `into` a `draft` state key shown as the last bubble while it streams, and a busy flag that disables Send.
  - For another provider's AI, the app keeps the user's key in a `secret` data field and calls that provider from a script with `network`, passing the key in `args`. Prefer `ask`.
- **The `ai` capability** is listed with the others; this follows from the tables.

### Demo

`specs/chat.json`, named "Chat": "Talk with Meta's model, and ask about photos."

- **Data:** `messages` (a list of `{role, text, photo?}`) and `persona` (text, default "").
- **State:** `input`, `draft`, `busy` and `problem`.
- **The main screen:**
  - The conversation is a list of bubbles: the user's right-aligned on an accent background, the model's left-aligned on a surface background. While `draft` isn't empty, it shows as a last model bubble.
  - Below it:
    - an optional photo thumbnail with a remove button;
    - a row with a photo button (`pickPhoto`), a text field bound to `input` and a Send button (disabled while `busy` or the input is empty);
    - a muted caption with `problem` when it's set.
  - Send adds the user message, clears the input and the photo, sets `busy`, and calls `ask` with `history` (the earlier messages), `images` (the photo, if any) and `into: "draft"`. `then` adds the model message and clears `busy` and `draft`; `else` sets `problem` and clears `busy`.
- **Settings screen** (from a header button): a multiline text field for `persona`, used as `system`, and Clear conversation.
- Seed it the way `converter.json` is seeded.

## Learning

### Turning it on

- **Each app's entry** (`AppEntry` in `core/src/builder/registry.ts`) gains:
  - `learning?: boolean`
  - `learnNotes?: string`: the model's notes about how this person uses the app, at most 2,000 characters.
  - `lessons?: {at: number, text: string, undone?: boolean}[]`: what learning changed, newest last, keeping 20.
  - `learnEvents?: Interaction[]`: recorded interactions not yet learned from, keeping the newest 400.
- **Home:** a new swipe action, "Learning", opens a new shell screen, `learn`, with `params.id`. A row whose app is learning shows a small accent caption, "Learning", under its description.
- **The `learn` screen**, titled with the app's name:
  - A switch, "Learn from how I use it", bound to the entry's `learning` through `builder.setLearning {id, on}`.
  - An explanation: "While it learns, Jig records what you tap and type in this app. When you leave the app, Meta's model looks at that record, using your API key, and may make one small change to fit how you use it. Every change is listed here and can be undone."
  - When no key is set, a muted caption says "Add a Meta Model API key in Settings first."
  - "What it changed": the lessons, newest first, each with its date; an undone one reads "(undone)".
  - The notes in a muted caption under "What it noticed", when there are any.
  - "Forget what it learned" (`builder.forgetLearning {id}`) clears the notes, lessons and events. It doesn't change the spec.
- **The run screen:** while the running app is learning, a small "Learning" caption sits next to Change and Done.

### Recording

**Hooking in:** `Runtime` gains `onInteraction?: (app: string, e: Interaction) => void`. A runtime reports its events to its own `onInteraction` when one is set. Otherwise it passes them to the runtime that embeds it; add a `parent` reference to embedded runtimes if there isn't one. The shell sets `onInteraction` and keeps only the events of a learning app that's running full screen on `run`. Whiteboard cards and builder previews don't count.

```ts
interface Interaction {
  /** ms since the session started */
  t: number;
  kind: "tap" | "change" | "submit" | "swipe" | "page" | "link" | "move" | "navigate" | "back" | "error";
  screen: string;
  /** the node's spec path, as select mode records it (`node.path`); "" for navigate, back and error */
  path: string;
  /** node type */
  type: string;
  /** what the node says: a label, text value or placeholder, at most 60 characters */
  label?: string;
  value?: string | number | boolean;
  /** the target screen, the swipe action's label, or the error message, at most 120 characters */
  detail?: string;
}
```

What to record:

- **`dispatch`:** records `tap`, `change`, `submit`, `swipe`, `page`, `link` and `move` for nodes that have the matching handler.
- **`change` values:**
  - Numbers and booleans are recorded as they are.
  - Text is recorded as its first 40 characters.
  - Nothing is recorded for a `secure` text field, or for a field bound to a `secret` data key.
- **Navigation:** `navigate` actions record `navigate` with the target screen in `detail`. `back()` on the app records `back`.
- **Errors:** `recordError` records `error`.

**Sessions:** a session starts when `run` shows a learning app. It ends when the shell's stack no longer shows that app on `run`: Done, the back gesture, or Change. The shell checks after each navigation, the way `background.ts` watches the stack. At the end, the session's events are appended to the entry's `learnEvents`, keeping the newest 400.

### Learning from it

**When it runs:** after a session ends, if all of these hold:

- the app is still learning;
- a key is set;
- `learnEvents` holds at least 8 events other than `navigate` and `back`;
- no learning run is in progress;
- the builder isn't `busy`.

Otherwise the events wait for a later session.

**The run:** `runLearn` in `core/src/builder/learn.ts` reuses the agent's Responses loop and its `apply_patch` validation from `agent.ts`; export what it needs from there.

- **Tools:**
  - `apply_patch`, the same as the builder's;
  - `finish {notes: string, change: string}`: the updated notes, and one sentence telling the user what changed, or "" for no change.
- **Limits:** at most 6 model calls, and reasoning effort `medium`.
- **Input:**
  - the spec as the model sees it (`modelSpec`);
  - a data summary: for each data key, its kind, and for lists the length and field names, never values;
  - the notes;
  - the lessons, with undone ones marked;
  - the events, compacted: consecutive identical `kind`/`path`/`value` entries merge into one with `×n`, and each line reads like `+12s main tap button "Add" [screens.main.body.children[3]]`.
- **Commits** go through `commitEdit`, so the builder's Undo works too.
- **Guard:** a learning commit is refused, and the errors go back to the model as the tool result, when compared with the spec before the run it would:
  - add capabilities, scripts, libraries, `network`, publish or shared;
  - remove a data key or change a data key's kind;
  - remove a screen.
- **The log** goes nowhere visible; the shell's builder `log` is not touched. The shell's `learning` state is `{id, appName, status: "working" | "changed" | "unchanged" | "error", text}`.
- **After `finish`, or after running out of steps** (treated as finishing with no change and the old notes):
  - save the notes (cut to 2,000 characters);
  - add the lesson when `change` isn't empty and a commit happened;
  - clear `learnEvents`;
  - set `learning`.
- **On error:** the events are kept and the status is `error` with the message.

The system prompt for the run:

> You improve a small app by watching how one person uses it. You get the app's spec, a summary of its data (no values), your notes from earlier sessions, the changes you made before (and which ones the person undid), and what they did since then.
>
> Change something only when the record shows a clear pattern or friction:
> - something done the same way 3 or more times that could be one tap (a default, a preset, a shortcut, the last value prefilled);
> - a frequent action that is hard to reach (far down, behind a screen);
> - going back and forth between screens to do one thing;
> - repeated errors or corrections.
>
> Make at most one small change per session, through apply_patch: reorder, set a default, add a shortcut button, rename a confusing label, prefill a field, or move a frequent item up. Never remove a feature or a screen, never delete or rename data, never add capabilities, code or network, and never undo the person's own edits. Never repeat a change they undid. If nothing is clear yet, change nothing. Most sessions should change nothing.
>
> Always end with finish: your notes (what this person does and how, what you've tried, what they undid, at most 2000 characters; keep what still matters from the old notes) and one plain sentence for the person about what you changed and why ("Running is now first, since you log it most"), or "" if you changed nothing.

### Telling the user

- **Home:** while `learning` is set, a card at the top of the list shows it:
  - `working`: "Learning from <App>…".
  - `changed`: "<App>: <text>", with Undo and OK.
  - `unchanged`: "<App>: nothing to change yet.", with OK.
  - `error`: "Couldn't learn from <App>: <text>", with OK.
- **OK** clears `learning`.
- **Undo** calls `builder.learnUndo {id}`:
  - If the app's spec is still the one learning committed (keep its JSON with the lesson in memory, or a hash of it), it calls `undoEdit`, marks the lesson `undone`, and appends "The person undid: <text>" to the notes.
  - Otherwise it sets the card's text to "<App> has changed since; undo it in the builder."
- **The `learn` screen** gets an Undo for each lesson that isn't undone. It does the same, and only for the newest lesson.

## Tests

- **`ask`, against a fake `http`:**
  - the request shape: instructions, history roles, images as data URLs, schema format;
  - `into` streams into the running app's state;
  - schema answers parsed, and bad JSON goes to `else`;
  - no key, a refused key, too many calls, too many images, and the request too long;
  - the key never shows up in the app's state or errors;
  - the gate asks once per app.
- **Interactions:**
  - `dispatch` records taps, changes, navigation and errors with paths;
  - secure and secret fields record no value;
  - an embedded runtime's events reach the shell;
  - only a learning app's full-screen run records;
  - session end appends to `learnEvents`, capped at 400.
- **`runLearn`, against a scripted fake model:**
  - a patch, then `finish`, saves notes and a lesson and clears the events;
  - `finish` with no change;
  - the guard refuses a patch that adds a capability or removes a data key;
  - running out of steps;
  - undo marks the lesson and notes it;
  - the trigger threshold, and no run while the builder is busy.
- **The chat demo** validates.
- The prompt mentions `ask`.
