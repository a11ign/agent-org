The tick names a row shelved by a pull request that closes a row waiting on it, as its own `DEADLOCK` line, and stops printing it as an ordinary B4 shelving (a11ign/a11ign#4625).

- `src/b4-cycle.ts` (new, a leaf): `deadlocksOf` takes the shelvings (shelved row, pull request, the rows it closes) and a `blockersOf` and returns those whose pull request closes a row that transitively waits on the shelved one, with the path; `deadlockLine` is the tick's line.
- `src/blocking-impact.ts`: `resolverOf` also carries `waits` (a pull request's whole `Closes`, held or not, and the open rows' open `blockedBy` edges), `deadlocksAmong` maps the gate's `blocked` list onto it, and `blockingImpactTick` logs each deadlock and counts that row out of the `nobody is known to hold` line (`holdingsOf` takes the rows already named). No change to `work-gate.ts`: the gate already hands `resolverOf` the open rows and pull requests.
- `src/b4-cycle.test.ts` (new, 13 tests): the chain as read 2026-10-09T19:40Z (control#32 closes #4575, which waits on #4514, which waits on #4516) and its twin (the pull request closes a row that does not wait on the shelved one) printing nothing.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/b4-cycle.test.ts
```

Closes: a11ign/a11ign#4625

Verified (measured, `AGENT_ORG_HOST=/home/agent/repos/wt-4625/.agent-org/host.json`, in `agent-org-wt-4625`): `node --test src/b4-cycle.test.ts` (the row's own Acceptance command, on this worktree's copy) 13 pass; `rstest` over `b4-cycle`, `blocking-impact`, `blast-tail`, `work-gate`, `org-retro`, `wake`, `shelved-circle`, `repeating-lines` 759 tests in 60 files pass. `tsc --noEmit`: the only errors are the two in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` not resolvable through the symlinked `node_modules`); none in a file this change touches. The Acceptance above is the row's command made cwd-relative: the row's names `/home/agent/repos/agent-org/src/b4-cycle.test.ts`, the primary checkout, which has no such file until this merges and so cannot pass for any PR.

Mutation: (single-line, one at a time against `b4-cycle.test.ts`, each file restored with `cp` and `diff`): detector never fires (6 red), always fires with a path-less result (4 red, the twin, the closed edge, the cycle walk), own-work skip removed (1), visited set removed (1, the walk does not end), unattributed not counted out (1), closed edges counted as open (1), the pull-request lookup ignoring the repository (1, after adding the bare `#32` test; the first run of that mutation survived and that test is why it no longer does).

Done-when 2 is the live line on the pull request after the tick runs the merged tool, if the cycle still stands: control#32 was closed at 19:28:56Z (branch kept), so it may not.

platform: checked whether GitHub already reports a dependency cycle between a pull request and a row it closes; it reports `blockedBy` edges and nothing about a pull request's `Closes`, so the walk is over the two the gate already reads. Adds one leaf and no call.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
