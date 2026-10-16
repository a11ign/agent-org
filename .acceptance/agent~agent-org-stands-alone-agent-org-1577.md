The outside home of the project's nightly org jobs, behind `outside.nightly` in the project's `.agent-org/decisions.json`, shipped OFF (epic a11ign/a11ign#5602, "agent-org stands alone").

**What changes.**
- `src/outside-nightly.ts` (the `outside-nightly` command): reads `outside.nightly` through `readSwitches`, the reader every other key in that file uses (absent, `false` or unusable is off: nothing runs, exit 0). On, it runs the selected jobs (`ready-audit`, `gateSweep`, `closeRowsSweep`, `watch`, named as the project's `nightly.yml` names them) with `GITHUB_REPOSITORY` set to the project's repository, since in this repository's workflow it would be this repository.
- The `watch` job's posting, which the project kept in workflow shell, is built here: a non-zero `org-watch` is posted on the report issue unless a comment from the last 50 minutes states the same finding (`findingKey` ignores the "for Nh" clock). A comment read that fails posts anyway and says so. The read is `commentsSince` and the post is `src/ticket-port/issue-comment.ts`, through the port as `gh-call-ratchet.test.ts` requires, over the runner `merge-guard/lookups.ts` already exports, so the new file spawns nothing.
- `.github/workflows/outside-nightly.yml`: the clock, after the project's (06:47 against 06:17, :52 against :37). It checks out the public project read-only, asks `--read-flag`, and mints the Octo STS token only when the answer is `true`.
- **First read (done-when 1):** `ready:audit`, `trunk-sweep` and `close-rows-sweep` were full replacements of their jobs except for `GITHUB_REPOSITORY` and the project checkout (built here); `org-watch` was not, its posting being workflow shell (built here). Posted in full on the row.

**The second actor does nothing (the epic's idempotence), one test per sweep, each first showing the first actor acted:** `trunk-sweep` against a stub `gh` (dispatch once, then check runs exist, no second dispatch); `closeOnePr` run twice (closes and files the verify row once, then ALREADY CLOSED); `watch` (posted once, then "already carries this finding", including a comment the home did not write).

Mutation (each restored byte-identical from a scratchpad copy, `diff` clean): flag never on (1 red) and always on (1 red); dedupe never fires (2 red) and always fires (4 red); the issue filter on the comments read dropped (1 red); `GITHUB_REPOSITORY` not passed (1 red); a failed job stops the rest (1 red).

Evidence: `src/outside-nightly.test.ts` 8 of 8; the whole suite under `rstest` from this clone: 26 files fail, the environment's 26 (none touches this change; `gh-call-ratchet` and `private-tmp`, which this change first tripped, now pass); `tsc --noEmit` clean; `.github/scripts/workflow-paths.ts` and `leak-scan.ts` clean. Measured at this head.

Acceptance: `git grep -l -F outside.nightly -- src`

Closes a11ign/agent-org#1577.

Outside-Region: src/outside-nightly.ts — the new command; the four files of the Region are commands the project's own jobs also run, so the flag cannot live in them.
Outside-Region: src/ticket-port/issue-comment.ts — the comment's arguments, in the port's directory because `gh-call-ratchet.test.ts` refuses a new call shape anywhere else.
Outside-Region: src/outside-nightly.test.ts — its tests.
Outside-Region: src/commands.ts — the command table entry.
Outside-Region: .github/workflows/outside-nightly.yml — the clock.
Outside-Region: .changeset/outside-nightly-home-1577.md — the entry a project that pins a tag reads.

platform: Octo STS (already the project's token exchange) and a scheduled workflow; GitHub has no cross-repository scheduled job that reads another repository's declaration and acts on it.

Net lines: positive (a new command, its test and a workflow). The four jobs are not reimplemented: the command runs the existing ones; the only logic built is the flag read and the report posting the project kept in shell.
