A persistent seat's roster entry may now declare `model`, `effort` and `autocompact`, and the seat launcher starts the seat with them, so a restart of the liaison comes back on Haiku 5.5 / high (the chairman's direction on a11ign/a11ign#4627) instead of the fixed `--model sonnet --effort medium`. An entry declaring none starts with the argv it always had, byte for byte, so the tool stays project-agnostic.

Closes a11ign/a11ign#4740

## What changes, and why

- **The fields (`src/project-roles.ts`).** `persistentEntries` returns `model` (an id or alias with no whitespace and no leading `-`), `effort` (one of `CLAUDE_EFFORTS`, `low` to `max`) and `autocompact` (a positive whole number, the value `--autocompact` takes) with the name and brief. A malformed value comes back as a `refusal` naming the entry and the field, never a default, and never a throw: a throw would read as an unreadable roster and `startAbsentSeats` would then stop every seat, not the one. The seat still counts in `persistentRoles`, so `host:check` goes on naming it absent.
- **The launcher (`src/wake.ts`).** `seatStartFlags(entry)` builds a seat's flags from `SEAT_START_FLAGS`: `--model` and `--effort` from the fields when present, `--autocompact <n>` only when present, placed before `--dangerously-skip-permissions` so the list-taking `--disallowedTools` stays last. `SEAT_START_FLAGS` is unchanged (the existing `persistent-seat-running.test.ts` pins it and still passes); `startSeat` prints `SEAT NOT STARTED <name>: <refusal>` for a refused entry and starts nothing.
- **What `autocompact` means.** `--autocompact` takes a WINDOW and compacts about `AUTO_COMPACT_TRIGGER_MARGIN_TOKENS` (35,000) below it, so the chairman's "~90k" is declared as `HAIKU_AUTOCOMPACT_WINDOW_TOKENS` (130,000, a trigger at 95,000). A literal 90,000 would trigger at 55,000, under the liaison's current 59k, and compact on its first turn. The test pins the constant, and the arithmetic. The field is documented in the changeset and on `seatStartFlags` as "the value `--autocompact` takes"; **the project-side row (a11ign's `sessions.json`) declares the constant and is not part of this diff.**

## Platform first, deleting first

platform: n/a (the roster is this tool's own file and the start flags are Claude Code's; nothing in GitHub, systemd or git chooses a model for a seat).

Net lines: positive, mostly tests; the production change is one type, one validator, one flag builder.

## How you verified it

The Acceptance line is the row's command without its `cd /home/agent/repos/agent-org`: that path holds a release older than this change, so a run there says nothing about the diff. **Both test files import `wake.ts` or `project-roles.ts`, which resolve the host checkout at import, so the command needs `AGENT_ORG_HOST` set** (as a11ign/a11ign#4736 found, and as `persistent-seat-running.test.ts` already does); unset, the two files fail to load and report `0 of 0 tests`, which is not a verdict on the diff. I ran with it set to this repository's `.agent-org/host.json`.

```
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.* src/wake-seat-start.test.ts src/project-roles.test.ts
VERDICT pass: 14 tests in 2 files
$ AGENT_ORG_HOST=<a11y-witness>/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.* src/wake-seat-start.test.ts src/project-roles.test.ts src/packaging/persistent-seat-running.test.ts
VERDICT pass: 29 tests in 3 files
$ npx tsc --noEmit -p .     # only the pre-existing mjs-ratchet.test.ts missing-module errors
```

The whole suite with `AGENT_ORG_HOST` set: 34 failed of 8017, in 12 files (`board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock*`, `mjs-ratchet`, `pr-template-acceptance`, `public-claim`, `row-file*`, `tick-heartbeat-is-written`, `wake-engineer-brief`). **The same 12 files, run on a detached `origin/main` (`e2812fc`), fail the same 34 of 362**, so none is this diff's: they read the host checkout and this worktree is not one. Not rerun: CI's tree-wide guards.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/wake-seat-start.test.ts src/project-roles.test.ts`

Mutation: `seatStartFlags` ignoring the entry's fields -> 4 red (the three-fields start, model-only, effort/autocompact-only, the chairman's pin); `--autocompact` always added -> 5 red (the none-declared argv, the single-field cases, the control and `persistent-seat-running.test.ts`'s start); validation never refusing -> 3 red; validation always refusing -> 15 red; `startSeat` ignoring `refusal` -> 1 red (the malformed-field start); all restored byte-identical (diffed).

## Anything a reviewer should be sceptical of

- The row names the test file `src/project-roles.test.ts`, which did not exist (`src/packaging/project-roles.test.ts` is a different file about causes and role directories); this adds it, in `src/`, as the Region lists it.
- `project-roles.ts` now imports `CLAUDE_EFFORTS` from `worker-profile.ts` so the effort vocabulary is not typed twice. The full suite above is the evidence that the import closure (`work-gate-loads-without-roles.test.ts` among them) is intact.
- `model` is checked for SHAPE (an id, never a flag), not against a list of models, because a list would be this tool deciding which models a project may run.
