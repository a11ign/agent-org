The two `src/work-gate` decide pass-through tests are green again: `same-head-refail.test.ts` test (5) and `shared-file-orders-recheck-switch.test.ts` test (2). Both asserted that `decide` passes a reading through to an order, and both found no order, because `decide` reads `prs.ownerRouting` from the host state when the caller omits it (agent-org#1325). That flag is ON on this host, so the fixture PRs, which carry no `isCrossRepository: false`, read as outside and their follow-ups are withheld. The code is right; the tests never pinned a flag they do not test. The change pins `prOwnerRouting: false` in the `decide` call of each test, as the other decide tests pass their readings. No assertion is deleted.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --test src/work-gate/same-head-refail.test.ts src/work-gate/shared-file-orders-recheck-switch.test.ts`

Measured, before the change, at 4db74608 with the host declaration: `tests 12, pass 10, fail 2`; the two failures are `(5)` and `(2)` with `actual: 0, expected: 1`. Measured, after the change, same command: `tests 12, pass 12, fail 0`. `node --test src/work-gate/*.test.ts` (the shell glob, so `causes/` is not in it): `tests 120, pass 120, fail 0`. `pnpm run typecheck`: exit 0.

Measured, the cause: `git bisect run` over `aa822858~1..4db74608` with the two-file run as the predicate found `aaf4180d` (agent-org#1325, prs.ownerRouting) as the first commit where the tests fail. Live reading from this checkout: `prOwnerRoutingFlagOn()` returns `true`, `recheckFlagOn()` and `sameHeadRefailFlagOn()` return `true` against the host's state directory.

Closes a11ign/agent-org#1614
