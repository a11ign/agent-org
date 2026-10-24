An installation refusal for a rate limit, while the GraphQL pool probe reads healthy, now says "a secondary limit: the installation was refused while its pool reads N of M left", with the pool's count, where it said "another resource, search or secondary, which the message does not name". `exhaustedResource` (`src/ticket-port/rows-by-label.ts`) takes that branch when the refusal text matches `for installation ID <n>` and the probe's `remaining` is above zero. The probe's count is the evidence for a secondary limit, so the line names it. An unreadable probe keeps its UNREADABLE wording, and a refusal that names an account and no installation (`for user ID <n>`) keeps the old "not graphql's count … which the message does not name" wording.

"Positive probe" is read as `remaining > 0`. A probe that reads 0 of 5000 left falls through to the old wording, since a spent pool is not a healthy pool.

Acceptance: `node --test plugins/github/rows/rows-by-label-refusal.test.ts` (moved there by A11-160, step 9). (a) an installation refusal with a probe at 4560 of 5000 says "a secondary limit" and the count, and not "which the message does not name"; (b) an unreadable probe keeps the UNREADABLE wording; (c) an account refusal with a healthy probe keeps the old wording; (d) a refused read is not asked again in the same tick, and is asked on the next tick after `forgetRefusedReads`.

Mutation: with `src/ticket-port/rows-by-label.ts` backed up, changed by one exact string, and restored by `cp` and proven byte-identical with `cmp` after each case. Each row is the number of failing tests, then the tests named:
- M1, the new branch never fires (`probe.remaining > 0` changed to `probe.remaining < 0`): 1 (a).
- M2, the new branch always fires on any probe (`/for installation ID \d+/.test(textOf(error)) && probe.remaining > 0` changed to `true && probe.remaining > 0`): 1 (c).

Measured: `ℹ tests 4, pass 4, fail 0` for the acceptance command, run in the worktree. Before the change, (a) failed and (b), (c), (d) passed. `pnpm run typecheck` exits 0 with no errors. The package has no `lint` script, so no lint was run. `pnpm test` (rstest) fails 113 of 11812 tests in 710 files with this change, and 113 of 11808 at HEAD (`2424c443`, the new test removed). The failing test names are identical in both runs, so no failure is new and none names the new wording.

Outside the row's Region, two files are touched: `src/packaging/no-search-reads.test.ts` (its pinned `/search or secondary/` assertion now pins the new line for the same installation and healthy-pool scenario), and `src/packaging/rows-by-label-fixtures.ts` (a `poolProbeAnswer` helper, because the tree-wide guard "the pool reading has ONE definition" (`src/packaging/work-gate.test.ts`) fails any top-level `src/*.ts` that writes the `X-Ratelimit-Remaining` header literally). Both are declared with `Outside-Region:` lines in the body.

Closes a11ign/agent-org#1523

platform: linux, Node v24; the test drives `readUnlessRefused` and `readRowsByLabel` with a fake `run` and a fake probe answer, so no `gh` or host state is read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
