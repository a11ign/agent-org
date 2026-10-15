The first line of `host:check` and of `host:install` names the project checkout and HEAD the project's units were read from, and the file count: `project units read from <checkout> @ <short sha>, <n> files`. `host:install` lists each unit it will delete as `ORPHAN <unit> -- not shipped by the directories compared: <shipped dir> and <project units dir>` before it removes anything, then removes the same units it did before. A project units directory that exists, holds no `a11ign-*` unit, and has `a11ign-*` units installed is a `PROJECT UNITS EMPTY` PROBLEM line rather than silence, and the remedy says `host:install` would remove the installed units and to settle which checkout the host serves first. `projectUnitsLine` and `emptyProjectUnitsFinding` are exported for the test; `hostUnitsInstall` prints the reading before any refusal or write, and `--json` carries no reading line, since it is machine output.

Acceptance: `node --test src/host-units-project-checkout.test.ts`

Mutation: the reading line dropped from `hostUnitsInstall` failed 1 test; the `ORPHAN` loop emptied failed 1 test; the `PROJECT UNITS EMPTY` guard made `return []` failed 1 test (the positive control). `src/host-units.ts` restored byte-identical each time (`diff` against a copy).

Measured: `ℹ pass 3` / `ℹ fail 0` for the Acceptance file. `pnpm run typecheck` exits 0. `node --test src/packaging/host-units.test.ts` passes 181 of 181, and the other host-units test files pass (`host-units-event-receiver`, `host-tool-install`). Every test file that references `host-units.ts`, `hostUnitsInstall`, `driftReport` or `host:check` ran against this tree and against a `git archive` of HEAD: the failing names on this tree are a subset of the failing names on HEAD (38 against 40, the two extra on HEAD being `#3485` and the `--arm` case, which fail only in the archive), so nothing new fails.

`host:check` read-only, with the worktree's tool and `AGENT_ORG_HOST` set to each project's `host.json`, prints the new first line: from `role-product-manager`, `project units read from /home/agent/repos/a11y-witness @ f7fcf13db, 14 files`, because that project's `host.json` declares the project `a11ign` with checkout `a11y-witness`; from `a11y-witness`, the same line. The installed tool's run from `a11y-witness` reports `every shipped unit is installed` and from `role-product-manager` reports `1 problem(s)`; the worktree's run reports `1 problem(s)` from both, `gh DIVERGED`, because HEAD's `host/gh` is newer than the installed `/home/agent/.local/bin/gh`. That divergence is the shipped-copy drift the check exists to show, not a change from this row.

Not here, and named: whether `host:install` refuses when the checkout is behind origin/main (the row's own exclusion); an install still removes the installed units of an empty project units directory, as it did before, and the new line and ORPHAN listing are what makes that visible. `host:install` was not run against any live host.

Closes a11ign/agent-org#1505

platform: `node:test` and `git rev-parse --show-toplevel --short HEAD` are what the reading uses; no new dependency and no API.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
