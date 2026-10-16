The outside home of the board report, shipped OFF behind `outside.board` (agent-org#1574, of "agent-org stands alone"; chairman's direction a11ign/a11ign#928).

**First read** (posted on the row, comment 6213903465): the commands already live in agent-org and run against the project they are run in; none had a home or a second-actor behaviour. `board:report --post` was not idempotent (a comment per run), `board:document --discussion` rewrote the day's Discussion in place, `board:summary-check` was already once per day by `postAbsence`'s marker. The `board-*.test.ts` files are already in agent-org (`src/packaging/`).

**The change.**
- `src/board-discussion.ts`: `outside.board` is read by `readSwitches` (`outsideBoardOn`); `scheduledRunFindsWorkDone` is true only for a flag-on run whose `GITHUB_EVENT_NAME` is `schedule`; `editionUrlIfPublished`; `--outside-on` exits 0 on and 1 off.
- `src/board-report.ts`: `editionPosted` and the early skip in `main`, before anything is collected.
- `src/board-document.ts`: the same skip before the summary is required, for `--discussion`.
- `src/board-summary-check.ts`: `postAbsence` exported with an injected `run` so a test drives both orders; behaviour unchanged.
- `.github/workflows/board-outside.yml`: the home. Three runs at London 08 / 07:15 / 07:45 (each cron twice), the project's `main` with full history, the tool at the newest stable release tag, `--outside-on` read before the Octo STS mint, `republish` only over an existing edition.

**Evidence.** `src/packaging/board-outside.test.ts` 12 of 12. The skip is driven through the real commands with a fake `gh` first on PATH, in both directions: flag on + scheduled + done writes nothing (report: one read, no comment; document: no mutation); not done, a dispatch, flag off and no event each go on. `npx tsc --noEmit -p tsconfig.json` exits 0; `node .github/scripts/workflow-paths.ts` and `leak-scan.ts` pass. `rstest run --changed=origin/main` printed `108 of 7340 tests failed in 437 files`; the same 108 fail at `origin/main` (22 files, work-gate / pr-owner / org-health, compared batch by batch on a detached `origin/main` worktree: 47+20+11+6+4+20, identical on both trees).

Acceptance: `git grep -l -F outside.board -- src`

(The row's command without its `cd ~/repos/agent-org &&`: the runner already runs in the PR's worktree top level, and a `~` is not a path it rewrites.)

Closes a11ign/agent-org#1574

Mutation: seven, each restored from a copy (`diff` byte-identical) and each red in the test that owns it, 12 of 12 after. (M1) the second actor never skips: 3 red. (M2) it always skips: 3 red. (M3) `editionPosted` always true: 2 red. (M4) the flag always on: 4 red. (M5) `postAbsence`'s marker guard removed: 1 red. (M6) the mint without its flag gate: 1 red. (M7) the reminder step written with `github.token`: 1 red.

Outside-Region: src/packaging/board-outside.test.ts — the new test: the flag, the second actor through the commands, the workflow's shape.
Outside-Region: .github/workflows/board-outside.yml — the home itself, which the row asks for ("a scheduled workflow in agent-org's own repository").
Outside-Region: docs/gh-call-baseline.json — `src/board-report.ts` 4 → 5 calls: the one read of the report issue's comments (`editionPosted`) that the second actor needs; a rise is visible here by design (`gh-call-ratchet`).
Outside-Region: .changeset/the-outside-home-of-the-board-report-off.md — the entry a project that pins a tag reads.

Flag: outside.board
Health-signals: wakes-held
Revert: set `outside.board` to `false` (or delete it) in the project's `.agent-org/decisions.json`; the project's own workflows stay scheduled the whole time. Or revert this pull request.

Not done: (a) the Octo STS trust policy the workflow mints against is the PROJECT's file (a policy is read from the target repository's default branch): filed as a11ign/agent-org#1581, so until it lands the mint step is red WITH THE FLAG ON and does nothing with it off. (b) The live canary (3 consecutive runs) is the switch row's (a11ign/a11ign#5605) and the delete row's (a11ign/a11ign#5606), not this row's. (c) `Health-signals:` names `wakes-held` only because the gate records no board signal; nothing here reaches a wake.

platform: GitHub's own `schedule` and Octo STS (as `auto-arm.yml` and `project-ref-bump.yml`); the second actor's check reads GitHub (the issue's comments, the Discussions) and nothing is kept on disk.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
