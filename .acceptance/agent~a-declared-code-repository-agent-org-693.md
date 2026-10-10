A declared code repository with no `ci.yml` (a11ign/.github) is read as "no trunk workflow here" instead of a refused read, is said once a day, is not asked again inside the day, and `gh`'s own `Not Found` line no longer reaches the tick's stderr (a11ign/agent-org#693).

Closes a11ign/agent-org#693

## What changes, and why

- **`trunk-red.ts`.** A 404 on the runs read (told from every other failure by `gh`'s `(HTTP 404)` text, the way `work-gate.ts`'s `refusalStatus` reads it) returns `null`, not `undefined`. A marker file per repository and workflow in the state directory (`trunk-workflow-<repo>-<workflow>`, `{"state","at"}`) makes the line once a day and the call once a day: `absent` and under a day old, no call and no line. A 200 body that carries `workflow_runs` writes `present`, and a 404 after that is the case worth hearing about every tick, so it prints each tick and reads `undefined` (unread, not green: the failure ledger must not end a standing red on it, and GitHub also answers an unreadable repository 404).
- **`defaultRun`.** Its stderr is captured (`stdio: "pipe"`) in the call itself. A refusal that is not a 404 still writes what `gh` said, so a 403 or a 5xx is as audible as before.
- **The second event filter is not asked after a 404 or any refusal:** it would answer the same, and a refused read is refused whole.
- **Not touched, by the row:** `.agent-org/project.json` and `repeating-lines.allowlist.json`.

## How you verified it

`AGENT_ORG_HOST` set to the a11y-witness checkout's `.agent-org/host.json`, and `A11IGN_SHADOW_STATE_DIR` to a scratch copy so the suites could not write the host's state directory.

```
$ grep -q 'no trunk workflow' src/trunk-red.test.ts && pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/trunk-red.test.ts
VERDICT pass: 17 tests in 1 file
$ pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/work-gate src/packaging/trunk-revert src/packaging/work-gate.test.ts src/failure-ledger
VERDICT pass: 1001 tests in 44 files   # src/packaging/work-gate.test.ts's drain-marker test fails only under A11IGN_SHADOW_STATE_DIR, and passes without it (419 tests)
$ pnpm exec tsc --noEmit -p tsconfig.json     # only the two pre-existing src/packaging/mjs-ratchet.test.ts errors
```

Acceptance: `grep -q 'no trunk workflow' src/trunk-red.test.ts && pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/trunk-red.test.ts`

Mutation: a 404 never read as one -> 6 red; any failure read as a 404 -> 2 red; the marker never fresh -> 2 red; "present" never written -> 2 red; a known-had 404 read as `null` -> 2 red; `gh`'s stderr inherited -> 1 red; a non-404 refusal's stderr swallowed -> 1 red. The file was restored from a copy and diffed byte-identical.

## Anything a reviewer should be sceptical of

- **The live reading is not made here.** Done-when 3 (`journalctl ... | grep -c 'gh: Not Found'` is 0 after one tick on the merged tool) can only be read after the merge and a tick; it is the gate's, not a reason to hold the claim.
- **`work-gate.ts`'s `codeReadings` re-asks a scope's `main` when the batched read was `undefined`** (`trunkRed = readScopeTrunkRed(scope)` is a default parameter, and a refused read IS `undefined`), unbatched and with `trunk-red.ts`'s own `defaultRun`: that is where the inherited `gh` line came from. Returning `null` for the 404 stops it for this case; a genuinely refused read still gets the second, unbatched ask. That file is outside this row's Region, so it is named here and not changed.
- **Markers are written by any caller of `readTrunkRed` that passes no `stateDir`**, including the other suites' fixtures (three `present` markers for real repositories appeared). A fixture that threw a 404 for a real repository without a `stateDir` would silence its read for a day; none does today.
- **The role file `.agent-org/roles/engineer.md` is not in this repository's tree**; I read the copy in the `wt-4843` checkout.
