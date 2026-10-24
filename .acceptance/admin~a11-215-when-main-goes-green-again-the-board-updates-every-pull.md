## What it is

On 2026-10-24 agent-org main's `ui` job went red and was fixed by #1853 (A11-214). Two pull requests the board held as "ui is red on main / not this run's" (#1851, #1852) stayed on their red heads until the chairman session merged main into each by hand (A11-215). The board now records which main check a held pull request waits on, and when main's head reports that check passing it brings the pull request up to date through the code host's update-branch, as the workers' identity and with no worker turn.

## Change

- `src/plugins/contracts/code-host.ts`: contract 1.15. `DefaultBranchRed` gains an OPTIONAL `passing` (positive evidence that a check is green on the default branch's head), and the base contract an OPTIONAL `updateBranch(url, expectedHead)` answering `updated`, `conflict`, `up-to-date` or `refused` (never throws).
- `plugins/github/default-branch-checks.ts`, `plugins/github/pull-feedback.ts`: `passing`, from the same rollup `failing` is read from, each name once.
- `plugins/github/update-branch.ts` (new), `plugins/github/code-host.ts`: `PUT repos/{o}/{r}/pulls/{n}/update-branch` with `expected_head_sha`, through the plugin's default `gh` runner (the workers' App).
- `src/plugins/fakes/code-host.ts`, `src/plugins/conformance/code-host.ts`: the fake's `updateBranch` (`branchUpdates`) and a conformance case for it; the `readDefaultBranchRed` shape check accepts `passing`.
- `src/ticket-mode/pool-foreign-checks.ts`: `ForeignReds` answers `{ names, onMain, mainPassing }`, keeping "red on main" apart from "red on another run's pull request".
- `src/ticket-mode/pool-checks.ts`, `src/ticket-mode/board-view/view-types-and-filters.ts`: a `not-ours` record gains `waitingOnMain`; the rule `updateHeld` and the `updated` record, kept once for the head.
- Tests, `plugins/README.md`, and the version `plugins/github/package.json` declares.

## How it is checked

Lint has no errors and typecheck passes. The named tests pass: `pool-checks.test.ts` (a check red on main is recorded as waited on main and one red only elsewhere is not; main's passing report updates a held pull request once and the card says so; the record stays while the new head's checks run; a conflict adds the conflict line, up-to-date leaves the failure the run's own, a refusal is asked again; a pull request with a check of its own red is not updated; no passing report from main, no update; a conflicting pull request, a host without update-branch and a hold recorded before this rule), `pool.test.ts` (two finished runs held on `ui`: main turns green, three watches, one update each, no round; a conflict queues the conflict round and the other run is still updated; an unwatched run is resumed with the conflict line), `plugins/github/update-branch.test.ts` and `default-branch-checks.test.ts`, and the conformance suites over the fake and the GitHub plugin.

Acceptance:
```bash
bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts plugins/github/update-branch.test.ts plugins/github/default-branch-checks.test.ts plugins/github/conformance.test.ts plugins/github/index.test.ts src/plugins/fakes/code-host.test.ts src/plugins/built-in.test.ts'
```

The two board test files (`src/ticket-mode/pool-checks.test.ts`, `src/ticket-mode/pool.test.ts`) load the board's service wiring, which needs the project's history, so CI's acceptance job cannot run them; the `suite` job does, and they passed on this branch (`rstest run` of both: 429 tests).

Consumer-declaration: none -- the code host contract grows OPTIONAL members only (1.15: `passing`, `updateBranch`), so a 1.14 code host plugin still passes and the board holds a pull request as it did; no host file changes meaning. `plugins/github` declares contract 1.15. No other repository reads these modules as a library.
