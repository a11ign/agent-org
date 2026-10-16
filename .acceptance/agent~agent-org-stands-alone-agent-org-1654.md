The row's Acceptance command, run as written from the worktree: no file under `.github` or `src` names the pin-bump class, fact, route or measure. It exits 0 here and 1 on `origin/main`.

Acceptance:
```bash
node -e 'const r=require("child_process").spawnSync("git",["grep","-l","-E","waitsOnPinBump|waiting-on-pin-bump|wait-for-pin-bump|project-ref-bump|pin-bump-measure","--",".github","src"],{encoding:"utf8"});process.exit(r.stdout.trim()?1:0)'
```

Outside-Region: src/machinery-flag.ts, src/flag-switch-ledger.ts, src/packaging/machinery-flag-switch.test.ts, src/packaging/flag-switch-ledger.test.ts, src/spec-lint.test.ts, src/pin-bump-measure.test.ts: they import `pin-bump-measure.ts` or name its flag `retro.pinBump`, which the Acceptance's `pin-bump-measure` pattern reaches, so the measure cannot go without them. The route `wait-for-pin-bump` lived in `ci-failure-class.ts` (in the Region), not in the wake routing.

Closes: a11ign/agent-org#1654
