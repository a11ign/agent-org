The spawner now names a spare for a row of another tracker: `engineers/ready-row-unclaimed/agent-org#481` with every roster address held yields `{ role: "worker-agent-org-481" }`, a name that is never the first tracker's `worker-481` and is the one `row-claim`'s `claimNames` gives the same claim. `spawnClaimability` reads the keyed row's `blockedBy` edge and B4's open pull requests in ITS tracker and names the repository in the refusal; `spawnClaimer` claims from the keyed clone with `--tracker=<key>` and `wt-<key>-<n>`; `withSpareInstances`, `spareInstances`, `isLiveSession` and the teardown recognise a keyed spare, for a declared key only (`worker-capture-481` is none).

Evidence (this branch, agent-org worktree): `src/wake-spawn-worktree.test.ts` 24/24 pass; the 14 other files that import the changed functions (`engineer-route`, `wake-drain`, `wake-row-named-instance`, `wake-spare-teardown`, `multi-board-gate`, `wake`, ...) pass unchanged; `tsc --noEmit` reports only the pre-existing `mjs-ratchet.test.ts` missing-module error. Four mutations each turn the named cases red and restore green: the name ignoring the key (4 red), `blockedBy` read from the first tracker (1 red, case d), the keyed claim made from the primary checkout (2 red), the family reader refusing every keyed name (5 red).

Acceptance: `cd /home/agent/repos/agent-org && npx rstest run --config scripts/rstest/rstest.config.* src/wake-spawn-worktree.test.ts`

Closes a11ign/a11ign#4685

platform: n/a (no GitHub, pnpm, systemd or git feature names a worker for a row of another tracker)

Net lines: positive, in tests and the keyed branch of existing functions; no function was added where an existing one could take a key.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
