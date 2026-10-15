`host/gh` refuses a whole-board `gh project item-list` unless `--limit` is 50 or less, and prices the call it allows. Before, a manager's listing of the board went through the wrapper unpriced: its ledger line read `graphql?` and the ledger could not say what it cost (about 52 points for one `--limit 50` call). Now a call with no `--limit`, or with one over 50 (every spelling), exits 1 before gh-real and before the ledger, so it writes no line, and names `agent-org row-file --promote=<n>` for one row or `board-snapshot` for the board. An allowed listing's line is `graphql` with the pool's counter after the call, read from the debug head `GH_DEBUG=api` makes gh-real print for that call alone (`pool_debug`); the head is taken out of the caller's stderr only when every request's block is whole. Other `gh` calls are unchanged.

Acceptance: `node --test src/gh-project-item-list.test.ts`

Measured: the acceptance command, run in this worktree on the final bytes of `host/gh` and the test, 7 of 7 pass (`ℹ tests 7 / ℹ pass 7 / ℹ fail 0`), exit 0. `pnpm run typecheck` exits 0. The existing wrapper and ledger tests (`src/gh-ledger.test.ts`, `src/gh-identity.test.ts`, `src/app-token.test.ts`, `src/app-role-silent.test.ts`, `src/packaging/gh-*.test.ts`) pass 166 of 166. The repository has no `lint` script, so none was run.

Before (the wrapper at `origin/main`, 405de309, swapped in for `host/gh` and restored by `cp` from a saved copy, then `cmp`-checked): `ℹ pass 3 / ℹ fail 4`. Failing: control (a) (the listing with no `--limit` ran and wrote a line), both `--limit 50` tests (no debug head, no priced line), and the refusal forms in (c). Passing, as they must: the caller's plain stderr passes through, the allowed forms of `--limit` reach the stub, and (d) `project item-add` and `issue view` are untouched.

Points of one `--limit 50` call: read off the pool's counter through the wrapper's debug head, the counter moved 2 → 54 across one call (52 points; the listing's own request went 2 → 3, then the items request 3 → 54). Concurrent sessions spend from the same pool, so that movement is not isolated from them; the figure is one measurement, not a bound. Under the ~100-point threshold, so the allowed form stays allowed.

Real path, through this worktree's `host/gh` against the real `gh-real` (`--limit 1`, to spend little): exit 0, stdout 4274 bytes, stderr empty, one ledger line with resource `graphql`, cost empty, pool counter 57. The same call without `--limit` exited 1 with the refusal naming both helpers and wrote no line.

Mutations, each applied to `host/gh` by `sed` on a saved copy, the acceptance file run, and the copy restored with `cp` (`cmp` after each restore):
- M1, threshold 50 → 51: `ℹ fail 1 / ℹ pass 6`, the (c) test fails (`--limit 51` allowed).
- M2, the `project item-list` ledger resource no longer `graphql`: `ℹ fail 1 / ℹ pass 6`, the first (b) test fails (the line is not `graphql`).
- M3, `GH_DEBUG=api` exported for every `project` call: `ℹ fail 1 / ℹ pass 6`, (d) fails (`item-add` ran with `GH_DEBUG=api`).
- M4, the limit check always passes: `ℹ fail 2 / ℹ pass 5`, (a) and (c) fail.

Closes a11ign/agent-org#1510

host: `host:install` is the host's step and was NOT run; the installed `gh` wrapper does not carry this change until the host installs it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
