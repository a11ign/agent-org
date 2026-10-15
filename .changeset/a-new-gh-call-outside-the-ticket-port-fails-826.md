---
"@a11ign/agent-org": patch
---

A pull request that adds a non-test file calling `gh` outside `src/ticket-port/`, or adds call sites to a file that already does, now fails `src/packaging/gh-call-ratchet.test.ts` (agent-org#826, Phase 0b of a11ign/a11ign#4505, the detector ADR 0046's ruling owes after #484). `docs/gh-call-baseline.json` holds, for each of the 95 files outside the port that call `gh` today, the most `spawns` and `calls` it may have (136 and 389 in all, read from `docs/gh-call-inventory.json` at `1a682ec2`). The test reads a fresh inventory through `buildInventory` and `judgedRoot`, so it has no second scanner, and names the file and both numbers; a count below its entry, or a file that is gone, does not fail, so the baseline is only ever edited to lower it. New GitHub-specific code goes through the ticket port or the code-host port.
