# Wake, the claim and the filing of rows are named operations of the code host's `rows`, and a claim's `gh` is the code host's, not its caller's `run`

## Context

ADRs 0007 to 0009 moved the ticket port's operations, the callers that arm, guard and queue a merge, and the work gate. Step 7 of A11-160 moves the callers that start, hold and file rows: wake (`src/wake.ts`, six files of `src/wake/`, `src/wakes-per-row.ts`), the claim (`src/row-claim.ts` and the six rule files of `src/row-claim/`), the filing of rows (the three files of `src/row-file/`), and the claim and row files at the top of `src/` (`claim-label-strip`, `claim-provenance`, `row-reachability`, `duplicate-row`, and `claim-stall/`). They are 23 files of the baseline, and they differ from the gate in two ways.

- **Most of them were handed a `run` for tests and used it for both `git` and `gh`.** `claimRow`, `declineRow` and the filing took `run: (cmd, args) => string`, and a test answered every command from one stub. That one seam is two things now: `git` and the board snapshot stay the caller's, and `gh` is the code host's.
- **Their reads and their decisions are interleaved less than the gate's.** A claim reads a row, decides, writes labels, comments and a card; the operation is the read or the write, and what it means (a claim's refusal text, B2's umbrella rule, B4's overlap) stays in core.

## Decision

1. **Each question these callers ask of GitHub is a named operation of the code host's `rows` (contract 1.10).** They are named for what the caller asks, in five sections of the contract by caller (wake, the claim, the claim's rules, the filing, the other files). Each builds the argument list the caller built and reads the answer as it did, throwing, or answering `null` where its name says so. Where an operation already existed with the same argument list (`commentOnRow`, `addLabelToRow`, `ensureLabel`, `setProjectStatus`, `postRowComment`, `readPullComments`, `stateOfRow`, `openRowsOf`, ...), it was reused; two that two callers had made apart (creating a label, setting a row's labels) are one each.
2. **A claim's `gh` is the code host's `ownRun`, behind the leak guard (#1053).** `claimGh` is the runner the claim hands each operation: it refuses an argument list with a leak in it, then runs `gh` through the plugin. A caller's `run` no longer carries `gh`: it is `git` and the board snapshot only, and the claim's memo of repeated reads (#3566) and its first wave of reads that wait together keep working over `claimGh`. A caller that has no runner of its own (`duplicate-row`, `row-reachability`, `claim-provenance`, the label events) hands none, and the plugin runs `gh` as the process's account; a call it makes is cut at the plugin's bound (30 s, or the bound the caller named: `ownRunWithin`).
3. **The tests of these callers use the fake.** The fake code host's world models what they read (`FakeRowsWorld.wake`, `claim`, `filing`, `rules`, `misc`): REST reads of a row and its comments, the row's labels as one set, milestones and the roadmap field, the review and file lists of pull requests, a row's label events. A test of what an operation sends, or how it reads GitHub's answer, is the plugin's (`plugins/github/rows/*.test.ts`); a test that counts the commands the claim sends (the memo, the first wave) runs the plugin over a stub `exec`, not the fake, because the fake ignores `run`.
4. **Nothing in these 23 files names `gh`.** The baseline of `docs/gh-call-baseline.json` loses all 23 and rises nowhere. `argumentsRunOf` turns a caller's `(program, args)` runner into the arguments-only runner the operations take, and names `gh` in the plugin, so `row-file`'s callers keep the runner they were handed.

## Why

It takes every `gh` argument list and every parse of GitHub's answer out of wake, the claim and the filing without moving their decisions into a package that cannot import them (the plugin imports core's types only, ADR 0001), and without changing a command the live org sends. A generic `gh(args)` in the contract would have left GitHub's command language in core and the ratchet counting its arguments.

## Considered

- **Keeping `run` for `gh` in `claimRow`, so the many tests that stub it stay as they are**: rejected. It keeps GitHub's answers stubbed in tests of core, which is what the plan's step 9 exit forbids, and a test that forgets to stub reaches the real `gh`.
- **One operation per `gh` command, shared by every caller**: partly done. Operations with an identical argument list are shared (decision 1); the rest differ in a flag (`--repo`, `--jq`, the fields asked) that the callers' tests and the call census see, so they stay apart.
- **Moving the claim's memo and first wave into the plugin**: not this step. They are how the claim runs, not what it asks of GitHub, and they wrap whatever runner the claim holds.

## Paths

- `agent-org:plugins/github/rows/`
- `agent-org:src/plugins/`
- `agent-org:src/row-claim.ts`
- `agent-org:src/wake.ts`
