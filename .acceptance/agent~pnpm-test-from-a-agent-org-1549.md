`pnpm test` is now the entry `scripts/test-entry.ts`. From a standalone clone it refuses (not a laid project: neither `AGENT_ORG_TOOL_REPO` set nor the tool sitting at `packages/agent-org` under a project), exits 1, and names CI's laid-out command, read from `.github/workflows/ci.yml` by the test, and the narrow form that works in a clone. Inside a laid project it runs `rstest run --config scripts/rstest/rstest.config.ts` as the script did, and passes its exit status through. The test runs the entry both ways from temporary directories, with a stub `rstest` on PATH so a refusal that starts the suite would show.

Before the change the outside case fails: there is no entry, and `pnpm test` ran the suite from the clone, which printed the failure count.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/packaging/test-entry-refuses-in-clone.test.ts
```

Mutation: each direction restored byte-identical (copy in the scratchpad, `cmp` after the restore):
- *Never laid* (`const laid = true;`): 1 red, the outside case. Restored: 4 of 4.
- *Always laid* (`const laid = false;`): 2 red, the AGENT_ORG_TOOL_REPO case and the path case. Restored: 4 of 4.
- *Env branch removed* (path only): 1 red, the AGENT_ORG_TOOL_REPO case. Restored: 4 of 4.
- *Entry absent* (the state before the change): 3 red, the three cases that copy it. Restored: 4 of 4.

Evidence: the acceptance command 4 of 4. `pnpm run typecheck` exits 0. `pnpm test` from this clone prints the refusal and exits 1. With `AGENT_ORG_TOOL_REPO` set, the entry runs the real `rstest` binary on one file (the acceptance file): VERDICT pass, exit 0.

Consumer-declaration: none -- the entry is reached only through the `test` script, which `.github/workflows/ci.yml` does not run.
