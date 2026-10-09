The work gate's class row is filed in the home tracker (a11ign/a11ign) and a refused filing logs its real reason, not the launch notice (a11ign/a11ign#4615).

- `src/class-repeat.ts`: `classRowArgv` adds `--tracker=`, so `row-file` does not send a Region of `.agent-org/failure-classes.json` to a11ign/agent-org. `refusalOf` skips the line `primaryLaunchDecision` prints (`proceeding anyway`) and reports the first line after it; when the notice is all that was written it says so, with the exit status.
- `src/class-repeat-files-row.test.ts`: the argv carries `--tracker=`; a filer whose stderr is the notice then a real refusal logs the real refusal; a filer that wrote only the notice is reported as such.
- `.changeset/the-gate-files-class-rows-in-home-tracker-4615.md`: the changeset every change here carries.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/class-repeat-files-row.test.ts
```

Closes: a11ign/a11ign#4615

Verified (measured, in the agent-org worktree `agent-org-wt-4615` with `AGENT_ORG_HOST=/home/agent/repos/wt-4615/.agent-org/host.json`): the command above prints `VERDICT pass: 15 tests in 1 file`. The row's own Acceptance names the primary clone's paths, which hold this code only after the merge; run against this worktree, its first command exits 0 (it exited 1 at 777c569) and its second, `node --test class-repeat-files-row.test.ts`, passes 15 of 15 (the two new tests failed before the change); with `src/class-repeat*.test.ts` and `src/org-health*.test.ts` 66 pass. `tsc --noEmit`: only the two `src/packaging/mjs-ratchet.test.ts` errors that `origin/main` already has.

Mutation: three single-line mutations, each file restored byte-identical (`cp` before, `diff` after): `--tracker=` dropped (the home-tracker test red, nothing else); the notice never recognised, i.e. `refusalOf` reads the first line again (the notice test red, nothing else); every line treated as the notice (the notice test and the existing "a refused filing keeps the order to ceo" test red).

platform: checked whether `row-file` already files in the home tracker on request; it does (`--tracker=`, #4078), so this only passes the flag the class row already needed. Nothing is added to `row-file`.

Done-when 2 is not mine to read yet: it needs the tick to run the merged tool. `orchestrator` reads `journalctl --user -u a11ign-work-tick --since -10min -o cat | grep -c 'could not file class'` and the `Failure class hand-reroute repeated` row in a11ign/a11ign after the merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
