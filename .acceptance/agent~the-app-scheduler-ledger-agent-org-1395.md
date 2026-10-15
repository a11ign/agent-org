The `host/gh` ledger carries the pool's own counter (`X-Ratelimit-Used` / `-Reset`, 11th and 12th fields) for every `api graphql` call, and `gh-ledger.ts` `settle` reads the counter's movement as the points spent, so `api-pool-low`'s Spender sentence accounts for the pool within 10% where the ledger holds the counter, and says `read` / `shared` / `floor` / `unplaced` where it does not know.

Acceptance:

```bash
node --test src/packaging/gh-ledger-per-hour.test.ts src/org-health-app-spender.test.ts
```

Mutation: each source backed up with `cp`, changed by one exact string, restored by `cp`, and `diff` proved the restore byte-identical.
- M1, the wrapper never asks for the counter (`host/gh`: the `shift 2; set -- api graphql -i "$@"` line replaced by `:`): 1 failing, "through the wrapper, an hour the responses never costed is accounted for by the pool's counter, within 10%".
- M2, `settle` returns its input unsettled (`return entries.map(...)` as its first line): 4 failing, the two sentence tests in `org-health-app-spender.test.ts`, the wrapper test, and the `unplaced` test.
- M3, a file other than `app-token.ts` and `host/gh` that imports `mintInstallationToken` (added under `src/`): 1 failing, "the scheduler App's token is handed out by `host/gh` alone"; removed again, the file passes.

Measured: `ℹ tests 17, pass 17, fail 0` for the acceptance command (10 in `gh-ledger-per-hour.test.ts`, 7 in `org-health-app-spender.test.ts`), run in the worktree. `pnpm run typecheck` exits 0. `sh -n host/gh` passes. `pnpm test` (rstest, the whole suite): 8 of 11414 failed; 5 of them (`host-install-agent-org-launcher` 1, `live-tree-independence` 2, `multi-board-gate` 1, `release-tag-on-merge` 1) fail the same way on a detached worktree of this branch's base, without this diff, and are not touched here; the other 3 were this diff's (`gh-identity` #791's stub echoed the `-i`, `host-project-paths` #2620 pins the wrapper's digest, `git-spawn-classification` caught a `git grep` in the new test) and are fixed, the three files green (29 tests). This repository has no `verify`, `lint` or `test:org` script: `pnpm run lint` answers `Missing script: lint`.

The 1,557 floor points and the 5 of 5000 are MEASURED (the ledger on the host and the row's own reading). The cost-per-shape figures (`pr list` of 100 is 7 points, of 20 is 1) are from `src/work-gate/reads.ts`'s own measured comment, not re-measured here.

Not here, and named:
- DONE-WHEN 3, "the next reading names a Spender within 10%", cannot be read from this branch: it needs the wrapper installed on the host (`host:install`) and one hour of calls under it. The test is the stand-in (a ledger of the shape the wrapper writes, a pool read off the same numbers); the live reading is #5408's canary at 20:30Z, not this PR's.
- A real full-hour pool reading under the scheduler's token was NOT taken: that would borrow another role's credential. The split between "outside the wrapper" and "an understated floor" is therefore an INFERENCE from the ledger: the repository holds no non-wrapper holder of the installation token (the structural test pins this for `src`, `scripts` and `host/gh`; `.github` workflows were not searched), and the floor is what every one of 1,557 lines read as.
- Calls that are not `api graphql` (`pr list`, `issue view`) are not asked for the head: their points are only shared, an inference. An hour already trimmed into the rollup stays at the floor (the rollup rows carry no counter).
- `src/org-health.ts` is outside the row's Region and is unchanged: the sentence's total is the ledger's, and the pool's `limit - remaining` is not put beside it there. Filed as a follow-up on the row.

Closes a11ign/agent-org#1395

platform: linux, Node v24.21.0; the wrapper tests run `host/gh` under `sh` against a stub `gh-real` and a scratch `GH_CONFIG_DIR`, so no network, no account's token and no host ledger is read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
