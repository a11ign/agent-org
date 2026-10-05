---
"agent-org": patch
---

The chairman-messaging listener can now read `{{fleet.workers-up}}`, `{{fleet.workers-down}}` and `{{gate.last-tick.age}}` in a `Verify:` (a11ign/a11ign#3646). `createWatchReaders` built its readers with neither the fleet-watch files nor the gate record, so those three placeholders refused ("this host named no fleet-watch state files") and a walk-through over a worker power-on never advanced. `createWatchReaders(repo, now, files)` now takes what the new `hostFiles({ root, err })` names: `runs/fleet-watch-state.json` and `runs/fleet-captures-state.json` under the project's checkout, and the tick's completion record beside the wake ledger. `listen.mjs` and `watch.mjs` pass it. A host that cannot name the completion record costs `{{gate.*}}` alone, said on the journal. `chairman:watch` is unchanged: a fleet cannot be watched.
