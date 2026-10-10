`host:check` stops reporting `PROGRAM MISSING` for a unit whose `node -e "<code>"` load check runs fine: `scriptOfNode` returns nothing for inline code (`-e`, `--eval`, `-p`, `--print`, and the `--eval=`/`--print=` forms) instead of the eval string (a11ign/agent-org#581).

Closes a11ign/agent-org#581

## What changes, and why

- **`src/host-units.ts`**: `scriptOfNode` returns `undefined` on meeting an inline-code option, so `programCandidates` yields no candidate for `node -e "import('./packages/control/src/fleet-watch.ts')"`. `--import` handling and the "past its flags" rule are as they were.
- **`src/packaging/host-units.test.ts`**: one test beside the `-c` case. The positive control is `node ./packages/control/src/fleet-watch.ts` (still its path); `-e`, `--eval`, `-p`, `--print` and `--eval=` each give `[]`; `--import tsx <script>` still gives the script; and the unit as filed (load check plus real program) through `missingUnitPrograms` is clean when the real program exists.

## How you verified it

```
$ node --test src/packaging/host-units.test.ts
ℹ tests 158
ℹ pass 158
ℹ fail 0
$ AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node repro.ts   # programCandidates(`node -e "import('./packages/control/src/fleet-watch.ts')"`, { repoRoot: "/home/agent/repos/a11y-witness", scripts: {} }), the row's Open-check, at this branch
[]
$ cd /home/agent/repos/a11y-witness && ~/.local/bin/node -e "import('./packages/control/src/fleet-watch.ts')"; echo "load rc=$?"
load rc=0
```

The Open-check printed `["/home/agent/repos/a11y-witness/\"import('./packages/control/src/fleet-watch.ts')\""]` at `04c94f6`.

Acceptance: `node --test src/packaging/host-units.test.ts`

Mutation: deleting the early return turns the new test red (157 of 158) and no other; replacing it with an unconditional `return undefined` turns the new test red along with the six tests that need a script path read (7 of 158 fail), so the positive control is doing its work. The file was restored byte-identical (`diff` clean).

## Anything a reviewer should be sceptical of

- Done-when 2 (`agent-org host:check` on a host with the fleet-watch unit installed) is a post-release hand run; the repro above is the shipped function handed the unit's own command, not `host:check` itself.
- `pnpm run typecheck` and `verify` were not run: this worktree has no `node_modules`.
- `.agent-org/roles/engineer.md` is not in this repository; the brief was read from a11y-witness's checkout.
