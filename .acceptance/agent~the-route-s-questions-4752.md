The route's questions are sent as TypeSafe's structured criteria: each choice option is `what`, `not_for` and `examples`, each score level a `summary`, its `signals` and examples, with examples drawn from our own merged rows, on all four questions; the provider-absent route is unchanged.

Closes a11ign/a11ign#4752

## What changes, and why

- **`criteria` goes on the wire as structure (change 2).** `engineer-route.ts` builds each `choice` option as `{ what, not_for, examples }` and each `score` level as `{ summary, signals, examples }`, TypeSafe's shapes from `docs.typesafe.ai/primitives/advanced`; #4764 rendered the same data into one string per option because `wire()` typed them as text. The API's OpenAPI schema (read 2026-10-10, version 0.2.0) takes a string, an object or an array for each description, so `Described` in `triage-provider.ts` widens `ProviderQuestion`, and `decision-provider.ts`'s `Question` and `ScoreLevels` follow. Type-only: `wire()` already passed the value through, and `readAnswer` checks a choice by key.
- **Examples for every question (change 3).** `mechanical` and `debugging` were bare `true of this row` glosses; they now carry options with `what`, `not_for` and examples (`MECHANICAL_DATA`, `DEBUGGING_DATA`), beside `SUBSYSTEMS_DATA` and `SCORE_LEVEL_DATA`. Each example is a row of ours and `merged` is `git diff --numstat <merge>^1 <merge>` less its `.acceptance/` and `.changeset/` files, **re-measured per row**: #4764's figures said `1 file` for #4522 and #4618 (both are a source file and its test) and counted only source files for #4629, #4630 and #4418, so the data is corrected to one definition.
- **State is unchanged (change 4):** `title`, `region`, `acceptance`, `doneWhen`, never a body; the new test posts a body carrying a marker and asserts it is absent and the four keys are exactly those.
- **The provider stays optional (change 5):** `ABSENT_SNAPSHOT` is the route, profile and log line of three provider-less rows recorded from `origin/main` at 5f4b499 BEFORE this change; the test passes unchanged after it.

## Guidance read first (change 1)

The TypeSafe skill was NOT installed: its SKILL.md says the live docs are the source of truth and the docs page offers the file by URL, so the pages were read directly and nothing was left to uninstall (`ls` of the local scope: no `typesafe` entry; `claude plugin list` unchanged). Read, all on 2026-10-10:

- `https://docs.typesafe.ai/primitives/advanced.md`: where structure is allowed (Choice options, Score levels, instructions, Noul criteria) and the two shapes used here.
- `https://docs.typesafe.ai/confidence.md`: confidence is derived from the probabilities; a flat distribution means no option is a clear winner, and for a Score "the levels are ambiguous, multi-dimensional, or the state doesn't contain enough".
- `https://docs.typesafe.ai/primitives/choice.md`, `primitives/score.md`, `concepts/state.md` and the agent skill's `SKILL.md` (`raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md`), the last of which says to use structured objects "when definitions, contrasts, exclusions, or examples clarify" and that score levels "must describe concrete situations and stand on their own".
- `https://api.typesafe.ai/openapi.json`: `ChoiceQuestion` and `ScoreQuestion`, copied into the test as `OPENAPI_QUESTIONS`.

## What was NOT done, and why

- **Done-when 2's AFTER reading is not here.** The BEFORE, measured by `node src/provider-confidence.ts --since 7d` over `~/.cache/a11ign/decisions` on 2026-10-10 ~09:25Z (156 `model-routing` decisions asked, 2026-10-09T21:54Z to 2026-10-10T09:18Z, 86 answered): `score` under the 0.7 floor on 60 (38% of asked, 70% of answered; mean confidence 0.57, median 0.61), `subsystems` on 51 (33% of asked, 59% of answered; mean 0.64). 70 of the 156 fell back for another reason (a refusal, a 422, a timeout) and are not low confidence. The same reading AFTER needs a release carrying this and the host running it, then the log read again; it is not reachable from a worktree and is not claimed.
- **No live provider call was made** to show the new request scores better: the request validates against the API's schema in the test, which is the claim.

## How you verified it

Acceptance below, run from the worktree with `AGENT_ORG_HOST` pointing at the project's `host.json` (the test refuses to start without it, as before): 42 tests in `engineer-route.test.ts`. Also green: `decision-provider`, `triage-provider`, `class-match`, `ci-failure-class`, `duplicate-row`, `review-depth`, `engineer-escalation`, `triage-route` and `provider-confidence` tests (220 in 10 files). `tsc --noEmit` reports only the two `mjs-ratchet.test.ts` errors that `origin/main` carries (`@a11ign/toolchain/mjs-ratchet` is absent from this install).

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; npx rstest run --config scripts/rstest/rstest.config.ts src/engineer-route.test.ts'`

Mutation: an option rendered as a string again -> 1 red (the choice-shape test); a level without its `signals` -> 1 red (the score-shape test); the Sonnet/medium effort constant changed -> 4 red, the provider-absent snapshot among them; a number as a description -> 6 red (the schema check refuses it, and the control names why); each restored byte-identical (`diff` against a copy taken before) and green.

## Anything a reviewer should be sceptical of

- **The examples are my judgment of which rows answer which question**, checked against each row's own text (title and first lines, 2026-10-10), not against an independent label. `a11ign#3228` has no diff of its own (a diagnosis row whose cause was read on the box and filed as #3241 and #3250), and `a11ign#1105`'s diff is the whole merge, tests included. `debugging: yes` has only those two because a row that states its cause is not one: rows that needed their cause found are rare in a log of filed rows.
- **`examples` on a score level is beyond TypeSafe's documented `summary` and `signals`.** The schema accepts any object; whether the model uses the extra key is not measured.
- **A score's levels still mix dimensions** (file count, subsystems, migration). TypeSafe's confidence page names "ambiguous, multi-dimensional" levels as a cause of low confidence; this change does not split the question, which would be a new row.
- **The request is larger** (every option carries examples): input tokens rise from the 426 of the recorded 200. Not measured here.
- Two files outside the row's original Region (`decision-provider.ts`, `triage-provider.ts`), re-scoped on the row (comment 6096116426) before the diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
