`could not read the rows "<session>" holds -- leaving it running` now says why, so a GraphQL pool that was down no longer reads as a keyed-tracker defect; and the three things a11ign#4893 asked for (a keyed holder's rows are read in its own tracker, a red agent-org PR wakes its keyed owner, a closed keyed row's session is ended) are pinned, because they were already true.

Acceptance:

```bash
cd /home/agent/repos/agent-org-wt-4893 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/wake-teardown-keyed-rows.test.ts src/packaging/wake-spare-teardown.test.ts
```

Closes a11ign/a11ign#4893

Measured: that command printed `VERDICT pass` for 6 new tests plus the existing teardown file; the nine adjacent files (teardown, spare family, registry settle, spawn worktree, cross-repo PR owner, PR owner total, wake-one-row, wake-row-named-instance) are 118 tests, all passing at this head. `tsc --noEmit` reports only the `@a11ign/toolchain/mjs-ratchet` module the shared `node_modules` lacks, which is on untouched main too. The row's own Acceptance names `src/work-gate.test.ts` and `src/wake.test.ts`, which do not exist in the tree, so it could not be run as written.

Mutation: six, each restored byte-identical and each turning only its own test red -- the keyed read ignoring its tracker (test 1), the cause never recorded (test 3), the line ignoring the cause (test 4), keyed names not family members (4 of 6, the control and every test that needs a keyed member), `withScopedPrOwners` dropping `rowsRepo` (test 6).

platform: n/a (the cause was already on the failing call's stderr)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
