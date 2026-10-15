Row: a11ign/agent-org#1205

Refs #1205. The row stays open: change item 3 (write per-question floors to `.agent-org/decisions.json` and have the floor code read them) names `src/engineer-route.ts` and `src/decision-provider.ts`, which are outside the Region, so it is not in this PR.

## What this adds

- `src/confidence-floors.ts`: pure `calibrateFloors(lines, { use })`. It joins each `model-routing` request to its outcome lines and, per question, picks the lowest floor on a 0.50–0.95 grid at which the answers at or above it were right at `RIGHT_RATE` (0.8), over at least `MIN_SAMPLE` (30) judged answers. Otherwise the flat 0.7 stands and the reading says so.
- `src/confidence-floors.test.ts`: 5 tests, each with a negative control.
- Turns and compactions are not read yet: the log line does not carry them (compactions live in the trace store).
- Each routing's verdict is applied to every one of its answers, so this is a proxy per question, not a per-question judgement.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts src/confidence-floors.test.ts` in this worktree printed `VERDICT pass: 5 tests in 1 file`, with all five tests listed as passed. Mutation checks: forcing the rate above 1 (always flat) fails 3 of 5; dropping `not-first-pass` from the verdicts fails 3 of 5.

Typecheck: `pnpm run typecheck` exit 0.

Full suite (`pnpm test`): 117 of 11567 tests fail. The same 117 fail on this branch without the two new files (11445 pass of 11562). They are environmental and not this change: a missing `tsx` module, an unfilled `@@eventsPort@@` placeholder, GitHub rate limits, and similar.

## Floors on the live log (read-only, `~/.cache/a11ign/decisions`, 9876 lines)

Judged routings: 266. Unjoined (carry a confidence, no verdict): 902, named by the calibration.

| question | floor | calibrated | sample (judged answers above floor) | right rate |
|---|---|---|---|---|
| mechanical | 0.70 | no: no floor keeps 0.8 over 30 | 266 | — |
| subsystems | 0.50 | yes | 193 | 0.803 |
| debugging | 0.60 | yes | 225 | 0.800 |
| covered | 0.70 | no: 5 under minimum | 5 | — |
| score | 0.50 | yes | 158 | 0.823 |
| route | 0.55 | yes | 74 | 0.824 |
| tier | 0.70 | no: 0 under minimum | 0 | — |

The routing's base first-pass rate is about 79%, so an 0.8 rate is close to the whole-route rate. Read the calibrated floors as a first cut.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
