A red dependency pull request with no ready row now gets an engineer: its `pr-checks-failing` order is no longer UNDELIVERED because every engineer has held a row (a11ign/agent-org#1520, the row this closes; a11ign/a11ign#5528 was red for 8 hours).

`src/wake.ts`: `PULL_REQUEST_SPAWN_CAUSES` (`pr-checks-failing`) is a sibling of `SPAWN_CAUSES`, not a widening of it, because the 20-clean-cycles counter runs on that list. `isPullRequestSpawnOrder` reads the pull request from the cause key with `RED_CHECK_KEY`. `isPilotOrder` admits it, so `targetFor` no longer refuses it on `route`'s refusal. `spawnableRole` names the spare for the pull request's number (`spareLabelForRow`) and never hands it a standing role, so one red pull request is one address however many ticks offer it. `targetFor` gives such an order no claimer and no `claimable` check, since there is no row to claim. The pace limit (`MAX_SPAWNS_PER_TICK`), the host-load refusal, the start budget and the memory gate all still apply. A changeset is `.changeset/a-red-pull-request-with-no-row-gets-an-engineer.md`.

Region: `src/wake.ts`, `src/wake.test.ts` (new).

Acceptance:

```bash
cd ~/repos/wt-agent-org-1520 && node --test src/wake.test.ts
```

Closes a11ign/agent-org#1520

Measured at this head: `node --test src/wake.test.ts` -> `tests 5, pass 5, fail 0`. `node --test` over every `src/wake*.test.ts`, `*one-shot*.test.ts` and `*spare*.test.ts` file (32 files) -> `tests 380, pass 380, fail 0`. `pnpm run typecheck` -> exit 0. The repository has no `lint` or `test:org` or `verify` script (`package.json` defines `test` and `typecheck`), so no lint was run.

Positive control: the CONTROL test (a red pull request with no row, every engineer holding a row, host at load 4) starts `worker-5528` once. Run against main's `src/wake.ts` (`git show 08fc7652:src/wake.ts`, swapped in and restored byte-identical), the CONTROL fails, the two-pull-requests-one-tick test fails, the load test fails and the no-claim test fails. The "next tick starts nothing" test passes on main too, because main starts nothing; it is a guard against a second process under the same address, not a proof of the fix.

Assumptions (judgment calls, in the task log): the spare for a pull request is named with its number, so a row and a pull request with the same number share one address. The holder check refuses the second while the first runs; it never starts two processes under one address. A pull-request spare is not ended by `endFinishedSpares`, which ends a spare when its row closes. It holds no row, so it stays until someone ends it; that is left open.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
