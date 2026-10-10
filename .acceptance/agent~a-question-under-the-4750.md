A question the provider is held back on by its floor, on more than 30% of at least 20 decisions, now files ONE improvement row for itself (ledger class `provider-low-confidence`), and never a second while one is open. Before this, `model-routing/score` at 0.64 median was a line in a daily reading that somebody had to notice; the #4627 loop's second use is that the reading itself opens the row.

Closes a11ign/a11ign#4750

## What changes, and why

- **`lowConfidenceQuestions(reading, { minDecisions, share })` (new, pure).** Over `provider-confidence.ts`'s reading: the questions with `asked >= minDecisions` and `underFloorShare > share`, strictly. The numbers are `MIN_DECISIONS = 20` and `MIN_UNDER_FLOOR_SHARE = 0.3`. 19 decisions at 100% is no; 20 at exactly 30% (6 of 20) is no; 20 at 35% is yes. A 422 or a refusal is `otherFallback` in the reading and is not counted as low confidence.
- **`fileLowConfidence(reading, io)`.** One row per question: the title is `Raise the provider's confidence on <use>/<question>`, the body names the question, the share, the mean, the median, the window and the improvement method, and carries an Open-check, an Acceptance and a Done-when, as #4751 does. It reads the class's rows ONCE (`gh issue list --label class:provider-low-confidence --state all`) and skips a question with an open row, and one whose row was closed after the window began (the reading still holds the decisions the merged fix was for). A listing it cannot read, or one that fills its 200-row limit, files nothing and says so for each question.
- **The provider stays OPTIONAL.** No provider declared, or no use switched on: `fileLowConfidence` returns `{}` and does not call `gh` at all, so there is no label call and no noise.
- **Not `fileClassRepeats`.** That function counts a class's repeats and files ONE row per class; this needs one row per question, each with its own open-row check, so the module reads the tracker itself and shares `runRowFile` with `class-repeat.ts`.
- **The CLI** (`node src/provider-low-confidence.ts [--since 24h] [--log=] [--question=<use>/<q>] [--file --session=<s>]`): the default prints `WOULD FILE:` / `NOT FILED:` and files nothing. `--question` is the Open-check a filed row carries: exit 0 settled, 1 still low, 2 too few decisions or not asked.
- **Not here:** running it on a tick or posting it with the daily reading (a later row), and the `provider-low-confidence` entry in a11ign's `.agent-org/failure-classes.json` that `row-file` needs before the label is accepted.

## Platform first, deleting first

platform: n/a (nothing in GitHub or systemd reads a provider's confidence; the log is this tool's own). Net lines: positive, a new module and its test; nothing it replaces.

## How you verified it

```
$ export AGENT_ORG_HOST=<this checkout>/.agent-org/host.json
$ pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/provider-low-confidence.test.ts
VERDICT pass: 23 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # no error in provider-low-confidence*
```

The whole suite with `AGENT_ORG_HOST` set: 35 failed with this diff, 34 on pristine `origin/main` (12 files: board-truth-audit, failure-ledger, auto-arm-token, milestone-clock*, mjs-ratchet, pr-template-acceptance, public-claim, row-file-refuses-duplicate-title, row-file, tick-heartbeat-is-written, wake-engineer-brief). The 35th was this diff's own (`remedies-say-pnpm.test.ts` refusing `npx` in generated text) and is fixed.

The live CLI over `~/.cache/a11ign/decisions`, filing stubbed (plan mode; nothing was filed), at 2026-10-10T08:30Z:

```
$ node src/provider-low-confidence.ts --since 24h
No question is under the floor on more than 30% of at least 20 decisions: nothing to file.

$ node src/provider-low-confidence.ts --since 2h
Provider low confidence, 2026-10-10T06:30:12.480Z to 2026-10-10T08:30:12.480Z

WOULD FILE: Raise the provider's confidence on model-routing/score (31 of 49, 63%; mean 0.65, median 0.64)
WOULD FILE: Raise the provider's confidence on model-routing/subsystems (28 of 49, 57%; mean 0.68, median 0.66)
```

**What it shows:** the 24h and 7d windows hold 70 decisions answered entirely with HTTP 422 before 2026-10-10 07:26Z, which dilute every share, so they say nothing to file until those age out. The window since the fix says `score` and `subsystems` WOULD file; `mechanical`, `debugging` and `covered` would not.

Acceptance: `cd ~/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/provider-low-confidence.test.ts`

Mutation: no question ever qualifies -> 18 red; the decisions edge dropped -> 2 red; the share edge dropped -> 6 red; the share edge inclusive (`>=`) -> 2 red; the decisions edge exclusive (`>`) -> 6 red; the open-row check ignored -> 1 red; the closed-in-window hold ignored -> 1 red; the provider's switched-on uses not consulted -> 2 red; an unreadable tracker read as none open -> 1 red; a listing that filled its limit read as whole -> 1 red; the median dropped from the body -> 1 red; `--question` settled without enough decisions -> 2 red. Each restored byte-identical (`diff`).

## Anything a reviewer should be sceptical of

- The row's command is `cd ~/repos/agent-org && ...`; that path holds a release older than this change, so the command here is run from the worktree.
- The share is `underFloor / asked` as `provider-confidence.ts` defines it, with `asked` counting every decision in the window including those whose answers were 422; the live 2h figures above are a reading at a moment of a log that grows.
- Filing needs `provider-low-confidence` in the project's `failure-classes.json`; without it `--file` is refused by `row-file`, and the refusal is reported per question, not swallowed.
