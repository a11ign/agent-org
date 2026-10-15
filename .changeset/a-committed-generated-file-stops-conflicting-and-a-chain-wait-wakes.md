---
"@a11ign/agent-org": patch
---

`docs/gh-call-inventory.json` is generated on demand and no longer committed (`.gitignore`; `gh-call-inventory.test.ts` holds the generator against the tree and proves two branches that each add a `gh` call merge in either order), so concurrent pull requests stop conflicting on it. `src/work-gate.ts`: a holder waiting (`Waiting-for: merged|closed #n`) on a pull request that is itself blocked (changes requested, conflicting, red) for 30 minutes is woken once with the choice, and a second period escalates to `orchestrator` (`chainWaitsOf`, `advanceChainWaits`, `chainWaitOrders`), behind the `queue.chainWaitWake` flag (default off).
