The agent-org copies `src/lib/git-sandbox.ts` and `src/lib/tree-wide-guard.mjs` carry their a11ign originals' renamed paths and current headers (a11ign/a11ign#4557).

- `git-sandbox.ts`: the header names `scripts/test-support/git-sandbox.ts` at `a0a4e91c8`, and the one changed line is its sibling import (`../../packages/guards/src/git-env.ts` in the original, `./git-env.mjs` here, because the tool's own `git-env.mjs` sits beside it). The comment naming `git-env` now says `.ts`. Header: `CHANGED FROM THE ORIGINAL, ONE LINE`.
- `tree-wide-guard.mjs`: the header names `packages/guards/src/tree-wide-guard.ts` at `f3b5c5f59`. Comments name `tree-wide-guards.ts` and `local-import-closure.ts` as the originals now do. Header: `CHANGED FROM THE ORIGINAL, 10 NAMED LINES` (the nine type lines, which this plain-JS copy writes as JSDoc or leaves to inference, and the one import, `./git-env.mjs`).
- The stale header pointer to `agent-org-outward-edges.test.ts` (deleted in a11ign #2976) is replaced in both headers with org-health's `copies-drifted` reading.
- Files: the two copies and `.changeset/copies-follow-the-ts-originals-4557.md`.

Acceptance:
```bash
cd /home/agent/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/packaging/agent-org-outward-edges.test.ts src/packaging/org-health-fleet-and-copies.test.ts
```

Run here as the same command with the checkout set to this worktree (`cd /home/agent/repos/agent-org-wt-4557`) and the config glob resolved to `scripts/rstest/rstest.config.ts`, since the checkout named in the row is not this worktree.

STALE: `src/packaging/agent-org-outward-edges.test.ts` does not exist (deleted in a11ign #2976, e4a99efe6). rstest drops a missing path without a message, so the command runs the fixture test alone. The row's Acceptance should name a file that exists, or this one, and product-manager amends it.

Result as run here (`AGENT_ORG_HOST` set to a11y-witness's `.agent-org/host.json`, which the run needs):
```
VERDICT pass: 18 tests in 1 file -- full report: A11Y_RSTEST_FULL_REPORT=1
```
The fixture tests cover the copies reading (`copies: a moved line is not an edit, ...`, `an unreadable original ... never clear`, `the tick reads the copies itself ...`). This command does not discriminate the change: it passes on `origin/main` too. The measure that does is the drift reading below.

Drift reading, org-health's `copies-drifted`, from `readDeclaredCopies({ root: <a11ign checkout>, toolRoot })` and `copyDriftReading({ pairs })`, measured at agent-org `1194e3d` (before) and this branch (after), a11ign `24372fdfe`:

Before (`origin/main` copies):
```
src/lib/git-sandbox.ts <- scripts/test-support/git-sandbox.ts allowed=1 originalRead=true
src/lib/tree-wide-guard.mjs <- packages/guards/src/tree-wide-guard.ts allowed=9 originalRead=true
"signal": "copies-drifted", "status": "tripped",
"detail": "2 declared copies drifted from the original: src/lib/git-sandbox.ts against scripts/test-support/git-sandbox.ts: 2 line(s) only in the copy, 2 only in the original, and its header names 1; src/lib/tree-wide-guard.mjs against packages/guards/src/tre..."
```

After (this branch):
```
src/lib/git-sandbox.ts <- scripts/test-support/git-sandbox.ts allowed=1 originalRead=true
src/lib/tree-wide-guard.mjs <- packages/guards/src/tree-wide-guard.ts allowed=10 originalRead=true
"signal": "copies-drifted", "status": "unknown",
"detail": "13 declared copy(ies) could not be compared: src/lib/changed-files.mjs (packages/guards/src/changed-files.mjs could not be read)"
```

Neither of the two copies is named as drifted after the change. The reading is `unknown`, not `clear`, because 13 other declared copies name originals that a11ign #4393 renamed from `.mjs` to `.ts`, and the reader cannot find them. The row title says "copies-drifted clears", so this gap is not closed by this change. The 13 are listed in the PR body and on the row, with the same fix (update the original path, the `at <sha>` and the changed-line count in each header). That fix lies outside this Region.

Other checks, as run here:
- `node -e "import('./src/lib/tree-wide-guard.mjs')"`: `tree-wide-guard.mjs import: ok`
- `npx tsc --noEmit -p tsconfig.json`: exit 2, 3 errors, all in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` unresolvable from the borrowed `node_modules`). None in the two copies. Pre-existing, as #4515's record shows.
- `npx rstest run --config scripts/rstest/rstest.config.ts --changed=origin/main`: `VERDICT fail: 8 of 612 tests failed`, all 8 in `src/packaging/row-file.test.ts`. The same file alone on a clean `origin/main` worktree gives `VERDICT fail: 8 of 184 tests failed in 1 file`, with the same failing tests and messages (the logs differ only in timestamps, paths and timings). So the failures predate this change. They come from live `gh` calls inside the test (`HTTP 502: Bad gateway`) and a `Region source file(s) do not exist in this checkout` warning, which is an environment fact of this worktree. `row-file.test.ts` imports `src/lib/git-sandbox.ts`, and this change leaves its exports untouched.
- agent-org has no lint script (`package.json` lists `typecheck` only), so there is no lint result to quote.

Not run: `pnpm run verify` (it needs the environment this worktree lacks, and its affected set includes the 8 pre-existing `row-file.test.ts` failures), and the full suite.

Net: 2 copies, 11 insertions and 11 deletions across the two copies, plus one changeset. No fleet, lab or worker command was run.

Mutation: not applicable. The change is in comments and one import specifier. The guard that matters is `copyDriftReading`, and its before/after readings above are the discriminating check.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
