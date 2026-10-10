`host/gh` appends `<!-- decided-by: <role> run: <id> -->` to the body of `gh issue comment`, `gh pr comment` and `gh pr review` when it knows the calling seat, and posts every other call, and every call it cannot attribute, unchanged. `src/packaging/gh-comment-attribution.test.ts` is new (10 cases); `src/packaging/host-project-paths.test.ts` moves its pin of the wrapper's bytes.

**What `<id>` is (measured 2026-10-10 on this host, from a seat's own environment):** the wrapper's ledger already reads `CLAUDE_CODE_SESSION_ID` (a Claude Code session's id, the file name of its transcript), else `CODEX_THREAD_ID`; this row reuses that one function (`session_id`), so the id in a comment is the id in the ledger line of the same call. `HERDR_WORKSPACE_ID` names the seat's workspace but not the run (it survives a restart on purpose), and nothing else in the environment names a run. **What `<role>` is:** the herdr label of `HERDR_WORKSPACE_ID` (`herdr workspace get <id>`, a local socket call, no GitHub point), which is `ceo`, `product-manager`, `orchestrator`, `worker-agent-org-486`. It is asked only for the three commands. No run id leaves `<!-- decided-by: <role> -->`; no workspace id, a herdr that does not answer, an answer for another workspace or a label outside `[A-Za-z0-9._-]` leaves the body unchanged. Live, with the shipped wrapper and the real herdr against a stub `gh-real`: `issue comment 486 --body "live check"` arrived as `live check` + blank line + `<!-- decided-by: worker-agent-org-486 run: cceee379-be63-496b-8505-31c5f9a7b204 -->`.

Not covered, by the row: `gh api .../comments`, `issue create`, `pr create` bodies. A comment posted through `gh api` carries no line.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-486 && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/gh-comment-attribution.test.ts'`

Mutation: `decided_by_line` returning nothing failed 7 of 10; the workspace-id, label-character and workspace-match checks removed (a role guessed `guess` when herdr is silent) failed 1 of 10 (the unattributable-call case); the case guard widened to every command failed 1 of 10 (the negative control). `host/gh` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 10 tests in 1 file`; with the neighbouring wrapper suites (`gh-call-ledger`, `gh-read-cache`, `gh-identity-declared`, `gh-ledger-per-hour`, `host-units`, `host-project-paths`) `pass: 209 tests in 7 files`. `tsc --noEmit` reports nothing in the changed files.

Outside-Region: src/packaging/host-project-paths.test.ts — `TODAYS_GH_WRAPPER` is the sha256 of the shipped wrapper and moves with it, as at a11ign#4397 and #4148.

Closes a11ign/agent-org#486

platform: GitHub has no author-role field on a comment, and herdr already holds the seat's name; the only added state is one HTML comment per post. No new command: the logic is in the existing wrapper.

Net lines: positive (about 90 in `host/gh`, mostly the comment naming what it never guesses); nothing else ships.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
