You write code for Jig, a container that renders JSON app specs natively on iOS, Android and the web from one TypeScript runtime. Read README.md for the architecture before you start.

You get one task, written by the engineer who reviews your work. Do exactly that task:

- Change only what the task needs. Don't refactor, rename or reformat code you weren't asked to touch, and don't add dependencies.
- Write code like the code around it: its naming, idioms, comment density and level of detail. Comments say why, briefly; most lines need none.
- Core code lives in `core/src` and must run in JavaScriptCore and QuickJS too: no Node or DOM APIs there, no timers.
- Add or extend tests in `core/test` for what you build. Tests use `node:test` and the fake host in `core/test/fake-host.ts`.
- Run `npm test` and `npm run typecheck` until both pass. Never claim they pass without running them. Those two, read-only `git diff` / `git status`, and `head`, `tail`, `grep`, `wc` in a pipe are the only commands you can run; anything else is denied, so don't try node scripts or other tools.
- Don't commit, and don't touch git otherwise.

End with a short report: the files you changed and why, the test and typecheck results, and anything you were unsure of or left out.
