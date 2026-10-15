Wake mints the reviewer's App token before it starts an instance and refreshes it on a tick, so the reviewer's sandbox is handed a token file and never the key. `ensureReviewerToken` in `src/wake.ts` runs `src/app-token.ts` (unsandboxed) into the instance's `node_modules/.cache/app-tokens`, and `reviewerEnvironment` names that directory (`A11Y_APP_TOKEN_DIR`), never the key path. A spawn is refused, by name, when the token cannot be minted. The freshness read (`tokenNeedsRefresh`) lives in `src/app-token.ts`, the one module that holds a token, so the ledger holder scan (#1395) still names only the minter and `host/gh`.

Acceptance: `cd /home/agent/repos/wt-agent-org-1348 && node --test src/wake-reviewer-instance.test.ts src/packaging/reviewer-app-role.test.ts`

Mutation (each applied to a copy of `src/wake.ts`, run, then restored and confirmed byte-identical with `cmp`):
- the token seam not passed to `spawnReviewer` (m1): failed #1348 (1) and (1b).
- the refresh check removed, so every call mints (m2, re-run after the `tokenNeedsRefresh` move): failed #1348 (2b) only.
- the rename into place removed (m3): failed #1348 (2) and (2b).
- the key path added to the reviewer environment (m4): failed #2401 (1b) and #1348 (1).

Holder scan: the first draft read the cache file in `wake.ts` (`parseTokenFile`), which `gh-ledger-per-hour.test.ts` (#1395) reports as an unledgered holder. It now reads the file in `app-token.ts` through `tokenNeedsRefresh`; that file passes 10 of 10 and matches `main`.

On `main` the reviewer test file does not load (it imports `ensureReviewerToken`, which `main` does not export), so every test in it fails there. The per-behaviour evidence is the mutation list above, and m1 is the closest check on `main`'s behaviour.

Known gap, not closed here: `host/gh` (outside this Region) still holds the key path and mints for itself if a token has less than 300s left. The 1800s refresh on the tick is meant to keep that from happening; it is not unit-tested beyond typecheck and code reading.

Done-when 2 (the key is not needed to complete a review under `codex sandbox -c sandbox_mode="workspace-write"`) MOVED to agent-org#1490 by product-manager's ruling (15:37Z, and 15:56Z on #1477); it is not closed by this row. The sandbox measurement stays here as evidence, taken from this worktree: `codex sandbox -c sandbox_mode="workspace-write" -- ls -l /home/agent/.config/agent-org/apps/a11ign-reviewer.pem` shows `-rw------- 1 agent agent 1675`, and `head -c 0` on it exits 0. The key is still readable inside that sandbox, because its file mode did not change; this change stops the reviewer's environment naming the key path.
