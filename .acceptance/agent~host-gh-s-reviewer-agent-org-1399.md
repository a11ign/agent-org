The reviewer's refusal in `host/gh` (agent-org#1347, a failed App-token mint REFUSES the reviewer's call) ships behind a switch that is OFF: `AGENT_ORG_REVIEWER_REFUSAL=1`, set in the reviewer instance's environment, turns it on, and any other value or none falls back to the account as before #1347. Until the token cache is writable in the reviewer's sandbox (agent-org#1342), every mint fails there and a refusal would stop every review. The incident line says which of the two happened: `fell back to the account` or `refused, not sent as the account`. `src/packaging/host-project-paths.test.ts` moves its wrapper pin for the change.

Acceptance:
```bash
node --test src/packaging/reviewer-app-role.test.ts
```

Mutation: `reviewer_refusal_on` made always true failed 2 tests (the switch-OFF fallback and the "only `1` is the switch" test); always false failed 1 (the switch-ON refusal). Each mutant was restored from a copy and compared byte-identical. The switch-OFF test also fails on the pre-change `host/gh` (`git show HEAD:host/gh`), which refuses unconditionally.

History: full

Consumer-declaration: none -- a host whose reviewer instances do not set `AGENT_ORG_REVIEWER_REFUSAL` gets the fallback; the refusal is inert until the switch is turned on, and turning it on is a separate change outside this Region (the reviewer's environment in `wake.ts`).
