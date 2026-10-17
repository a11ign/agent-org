The row's Acceptance command, run as written from the worktree: no file under `.github` or `src` names the pin-bump class, fact, route or measure. It exits 0 here and 1 on `origin/main`.

Acceptance:
```bash
node -e 'const r=require("child_process").spawnSync("git",["grep","-l","-E","waitsOnPinBump|waiting-on-pin-bump|wait-for-pin-bump|project-ref-bump|pin-bump-measure","--",".github","src"],{encoding:"utf8"});process.exit(r.stdout.trim()?1:0)'
```

Outside-Region: src/machinery-flag.ts — imported `PIN_BUMP_FLAG` from the deleted measure and listed `retro.pinBump` in the flag registry.
Outside-Region: src/flag-switch-ledger.ts — carried the `retro.pinBump` entry of the flags with another home.
Outside-Region: src/packaging/machinery-flag-switch.test.ts — imported the deleted measure for the flag and tested switching it; the registry list loses the flag.
Outside-Region: src/packaging/flag-switch-ledger.test.ts — imported the deleted measure for the flag and tested the flag-OFF report; the map test stays.
Outside-Region: src/spec-lint.test.ts — passed the removed `pinBumpOn` seam to the retro classes.
Outside-Region: src/pin-bump-measure.test.ts — the test of the deleted measure; it goes with its subject.
Note: the route `wait-for-pin-bump` lived in `ci-failure-class.ts` (in the Region), not in the wake routing.

Outside-Region: src/org-retro-no-pin-bump.test.ts — the new runtime guard for the removal: a canary state still recording `retro.pinBump` adds no retrospective class, and a stray pin/bump reading prints no line.
Outside-Region: src/wake.ts — one doc comment of `withCiFailureClass` said a rule routes to WAIT for a pin bump; it now names the route that remains (a review found it stale).

Mutation: `// waitsOnPinBump` appended to `src/machinery-flag.ts` -> the command exits 1 (file restored from a copy, `diff` empty, exits 0 again). In `src/ci-failure-class.ts`, `notesTheOrder` without its `push-or-update-branch` arm -> the rewritten `src/wake-ci-class-review-depth.test.ts` test fails (1 of 43 in the two CI-class files) and nothing else (restored from a copy, `diff` empty).

Runtime guard (review of `7b8531c8`): `src/org-retro-no-pin-bump.test.ts` (2 tests, pass). A canary state still recording `retro.pinBump` ON adds no retrospective class, and a report handed a stray pin/bump reading prints no such line. Mutated: a `"pin and bump"` class put back in `retroClasses` -> test 1 fails and test 2 passes; the `pinBump` read in `buildReport` plus its line in `renderReport` put back -> test 2 fails and test 1 passes (`org-retro.ts` restored from a copy, `diff` empty each time).

Measured, on this branch on top of `main` `c2a7ebb4`:
- The command above exits 0 here.
- `tsc --noEmit -p tsconfig.json` exits 0.
- The changed tests (`ci-failure-class`, `wake-ci-class-review-depth`, `machinery-flag-switch`, `flag-switch-ledger`, `spec-lint`, `no-project-names`): `VERDICT pass: 118 tests in 6 files`.
- The whole suite, one `rstest run --config scripts/rstest/rstest.config.ts` against a committed copy of `src/packaging/fixtures/project-tree/` as the `suite` job does, in this session's environment (no herdr, `gh` rate-limited): 64 failures in 20 files. The same 20 files on unmodified `main` (`c2a7ebb4`, same fixture): 62 failures; the two extra were `no-project-names` reading the committed tree while my deletions were uncommitted, and with the change committed the failing set is IDENTICAL to `main`'s (compared by test name). So this change adds no failure; the 62 are environmental here, and the PR's `suite` run is the proof for Done-when 2.

Net: the pin-bump measure, its flag and its tests are deleted; `retro.pinBump` is gone from the flag registry and the flag ledger, so `machinery:flag on retro.pinBump` is now refused as an unknown flag, as any name no module reads.

platform: nothing to check, this is a removal.
Closes: a11ign/agent-org#1654
