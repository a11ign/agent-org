The gate's chairman set now includes CLAIMED chairman rows. `offerHierarchyNow` verifies `priority:chairman` on the open `in-progress` rows as well as the Ready ones (`readChairmanPriorityOfOffer`), so `overlapVerdict` sees a claimed chairman holder and two chairman rows over one file are not both offered. A claimed holder's label added by another login is ignored and an unreadable history fails closed, as for a Ready row; a chairman row over a claimed plain row is still offered.

Acceptance:

```bash
cd /home/agent/repos/agent-org-wt-4800 && AGENT_ORG_HOST=/home/agent/repos/wt-4800/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate-chairman-claimed-holder.test.ts
```

Closes a11ign/a11ign#4800

Measured: with `AGENT_ORG_HOST` set, the new file and `work-gate-offer-hierarchy.test.ts` printed `VERDICT pass: 13 tests in 2 files`. The unmodified gate cannot run the new test (it imports the new reader); with the claimed rows stripped from the reader, 3 of its 4 tests fail (the shelved-naming-the-holder case, the ignored-label control and the fail-closed case).

Mutation: claimed rows dropped from the verified set breaks the first, third and fourth tests; the plain-holder control stays green. Restored byte-identical (diff clean).

platform: n/a (gate)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
