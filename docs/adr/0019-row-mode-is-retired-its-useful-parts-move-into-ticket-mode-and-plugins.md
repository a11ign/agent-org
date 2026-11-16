# Row mode is retired: its useful parts move into ticket mode and its plugins, and the rest is deleted

Status: Proposed (A11-448). The maintainer accepts it by merging this file. Nothing is deleted until then, and each deletion is its own follow-up ticket.

## Context

Agent-org has two ways of running work.

- **Row mode** is the older one. Its tracker is GitHub issues, and its queue is GitHub project items and labels (a "row"). Its tick, `work-gate`, decides what may start. `wake` starts sessions, `row-claim` and `row-file` claim and file rows, and `decision-run` routes decisions. `org-health` and `org-retro` watch the org, and `trace` records what runs did and what they cost.
- **Ticket mode** is the newer one. Its tracker is a plugin (Linear, `plugins/linear`), GitHub is only its code host, and the board moves each ticket through its states.

ADRs 0002 and 0006 to 0011 put row mode's GitHub operations behind one optional part of the code-host contract, `rows`. ADR 0002 says this lets row mode "be retired later by removing `rows` in a major version". ADR 0011 counts the chairman's watch (`src/messaging/`) among those operations.

Three of row mode's parts are useful, and ticket mode is gaining its own versions of them. None of the three has merged yet:

| Row-mode part | Ticket-mode replacement |
|---|---|
| `src/org-retro.ts` and `src/org-retro/` (daily retro) | M3, A11-432, #2059: `src/ticket-mode/retro/` writes per-repository lessons |
| `src/trace/` (cost tracing) | M1, A11-430, #2056: `src/ticket-mode/outcomes/` writes outcome records and rolls them up at configured prices |
| `src/wake/exit-and-limits.ts` (account limits) | R2, A11-434, #2041: `src/account-limit-message.ts` and `src/ticket-mode/allowance.ts`, on R2's branch, make a run wait for the allowance to reset |

The maintainer reports that nobody runs row mode, and asks that whatever row mode did well come back through plugins, the way Linear is the tracker plugin.

## Decision (proposed)

Row mode is retired.

- Its retro, cost tracing and account limits belong to ticket mode (M3, M1, R2).
- The row-mode code that ticket mode still loads moves into ticket mode, or behind the plugin contract it belongs to.
- Then the rest is deleted, and `rows` leaves the code-host contract in a major version, as ADR 0002 planned.

Anything that talks to an outside system comes back as a plugin behind its contract (tracker, code host, reviewer, messaging), never as core code. If GitHub issues are wanted as a tracker again, that is a tracker plugin (`concern: "tracker"`, implementing `src/plugins/contracts/tracker.ts`), as Linear is.

## Considered options

- **A. Move the useful parts, then delete the rest (recommended).** This is the decision above.
- **B. Freeze row mode.** Row mode stays as it is, with no new features, and is fixed only when it breaks. Nothing moves and nothing is deleted. Rejected, because freezing does not stop the cost:
  - ticket mode's reviewer start still loads 60 row-mode files at run time (see Evidence);
  - every row-mode module is still type-checked, linted and tested on every push, and kept inside the closure guards;
  - a ticket-mode change can still break code that nobody runs.

## Why

- **Nobody runs it.** The maintainer says so, row mode's tick timer (`a11ign-work-tick.timer`) is disabled on the agents host, and no change has touched only row-mode code since 2026-10-17.
- **Its useful parts already have a home.** M1, M3 and R2 build them inside ticket mode, and nothing else in row mode is on ticket mode's path except through the seams listed below.
- **Plugins fit what comes back.** The tracker, code-host, reviewer and messaging contracts exist, and Linear shows the pattern. A capability that comes back as a plugin can be dropped or replaced without touching core.

## Evidence

These were measured on M3's branch (`admin/a11-432-featticket-mode-m3-a-daily-retro-writes-per` at `f29e8dcab`, which holds M1 and M4), with `origin/main` at `d42249674`, on 2026-11-14 and 2026-11-15.

- **Activity.**
  - The last commit that changed only row-mode paths (and their `.changeset` or `.acceptance` files) was on 2026-10-17: `fix(canary): board-disagrees-with-reality reads the offers the tick made`.
  - Since 2026-10-24, nine commits have touched row-mode paths. All of them were ticket-mode or shared work: the reviewer port, CI, herdr, and M1's `src/trace/tokens.ts`.
  - In October, 348 commits changed only row-mode paths, so the drop is recent.
- **Size.** The named row-mode modules hold about 68,000 lines with their tests:

  | Module | Lines |
  |---|---|
  | `src/work-gate/` | 19.5k |
  | `src/trace/` | 16.1k |
  | `src/row-claim*` | about 9.5k |
  | `src/wake/` | 8.7k |
  | `src/org-health*` | about 4.4k |
  | `src/row-file*` | about 4k |
  | `src/decision-run/` | 3.5k |
  | `src/org-retro*` | about 2.9k |

  Row mode's GitHub code in `plugins/github/rows/` is another 12.7k lines. The rest of row mode is the top-level `src/*.ts` programs it runs, such as `work-tick`, `claim-stall`, `close-rows-*`, `ceo-one-shot`, `orchestrator-one-shot` and `merge-queue`.
- **What ticket mode loads at run time.** This is a walk of runtime imports with the TypeScript parser: `import type` is skipped, and a literal dynamic `import()` is counted.
  - **Entries:** every `ticket:*`, `start`, `status`, `stop`, `update`, `doctor`, `onboard`, `plugin`, `host:*` and `messaging:*` command; every file under `src/ticket-mode/`, `src/install/` and `src/plugins/`, except the `rows` files; and every plugin entry except `plugins/github/rows/`.
  - **Reached:** 60 files of the named row-mode modules (29k lines). They are 16 in `src/work-gate/`, 12 in `src/wake/`, 19 in `src/trace/`, 8 in `src/org-health*` and 5 in `src/row-claim/`.
  - **Never reached:** `work-gate.ts`, `wake.ts`, `row-claim.ts`, `row-file.ts`, `org-retro.ts`, `work-tick.ts` and `decision-run/`.
- **Three seams pull row mode in.**
  1. **The reviewer start.** `src/ticket-mode/reviewer-port.ts:46` loads `wake/reviewer-tokens-and-checkouts.ts`, `wake/ci-class-and-spares.ts`, `wake/pull-request-spawn-orders.ts`, `wake/seat-reset.ts`, `wake/reviewer-start-async.ts` and `work-gate/pr-orders.ts`. It loads them lazily, by `import()`, when a reviewer starts. Through `work-gate/pr-orders.ts:24` → `approved-unqueued.ts:28` it also loads `org-health.ts`. Cutting this seam takes the row-mode files reached from 60 down to 27.
  2. **The chairman's watch.** `src/messaging/watch.ts:68-69` imports `org-health/claim-and-tick-readings.ts` and `org-health/fleet-build-readings.ts`, and through them `work-tick-health.ts`, `row-claim/file-overlap-rule.ts` and `row-claim/blocked-by-edge-rule.ts`. Its timer, `a11ign-chairman-watch.timer`, is disabled on the agents host.
  3. **Cost tracing.** `src/ticket-mode/outcomes/` imports `trace/prices.ts`, `trace/tokens.ts` and `trace/codex-turns.ts` (M1). `trace/codex-turns.ts:19` imports `trace/store.ts`, which loads the rest of `src/trace/`. With seams 1 and 2 cut, the 18 `src/trace/` files reached through this seam are the only row-mode code ticket mode still reaches.
- **Shared helpers ticket mode uses, which are not row mode.** These are top-level `src/` files that ticket mode imports directly, and they stay: `herdr-agents.ts`, `host-config.ts`, `project-config.ts`, `private-tmp.ts`, `session-tmp.ts`, `newest-check-run.ts`, `scaffold-dirs.ts`, `declared-clone.ts`, `review-attribution.ts`, `review-verdict.ts`, `review-trust.ts`, `project-identity.ts`, `reviewer-door-path.ts`, `pane-dialog-read.ts`, `ci-log-lines.ts`, `ci-rerun-on-5xx.ts`, `fresh-fetch.ts`, `red-pr.ts`, `reviewer-gh-config-dir.ts`, `derived-name.ts`, `hang-settings.ts`, `pr-open-region.ts`, `region-paths.ts` and `commands.ts`.
- **Workflows that call row-mode programs.**
  - `.github/workflows/auto-arm.yml` calls `arm-pr` and `auto-arm-sweep`.
  - `org-reports.yml` calls `outside-reports`.
  - `outside-nightly.yml` and `outside-trunk.yml` call the programs of the same names.
  - `ci.yml` path-filters `pr-hold-state.ts` and `work-gate/pr-orders.ts`.
- **Row-mode units on the agents host.** All of these run from `/home/agent/repos/agent-org`.
  - **Disabled:** row mode's tick (`a11ign-work-tick.timer`), the chairman's watch, and the board-report, weekly, manager-spend and shadow-window timers.
  - **Still running:** the timers `a11ign-trace-ingest.timer` (`src/trace/freshness.ts`) and `a11ign-trace-publish.timer`, and the services `a11ign-trace-publish-serve`, `a11ign-otel-receiver` and `a11ign-event-receiver` (`src/event-receiver.ts`).
  - `~/.local/state/agent-org/` holds only ticket-mode state.

The walk can't see an import whose path is computed, and `bin.ts` dispatches commands through `commands.ts`, so the walk reads those commands as entries. Each follow-up ticket re-runs the walk, or a closure guard, before it deletes anything.

## Modules to move or delete

Each step is one follow-up ticket, in this order.

- **Steps 1 to 5 move code or decide.** They delete nothing.
- **Deleting starts at step 6.** The row-mode modules import one another, so none of them can go before the tick does. For example, `work-gate.ts:45` imports `org-retro.ts`, `work-gate/route-outcome-pass.ts:32` imports the trace store, and nine files import `account-limit.ts`.

1. **Cut the reviewer seam (move).**
   - Move the reviewer start steps that `reviewer-port.ts` loads into the reviewer, behind `src/plugins/contracts/reviewer.ts` (`plugins/atomic-reviewer`), or into `src/ticket-mode/`. These are the five `wake/` files named under Evidence, `wake/reviewer-start-steps.ts`, the parts of `work-gate/pr-orders.ts` it uses, and what it needs from `approved-unqueued.ts`.
   - Add a closure guard, beside `src/packaging/board-snapshot-scope.test.ts`. It checks that the reviewer start's runtime import graph reaches no `work-gate`, `wake`, `row-claim`, `org-health` or `org-retro` module.
2. **The chairman's watch (decide, then move or mark).**
   - If ticket mode needs `messaging:watch`, move the canary readings it uses out of `src/org-health/`.
   - If it does not, it is row mode: take it off ticket mode's entries, and delete it in step 6.
   - Then widen step 1's guard to every ticket-mode entry.
3. **Cost tracing (move).**
   - After M1 merges, move `trace/prices.ts`, `trace/tokens.ts` and `trace/codex-turns.ts` to `src/ticket-mode/outcomes/`.
   - Cut `codex-turns.ts`'s import of `trace/store.ts`.
   - Leave a re-export in `src/trace/` while row mode still imports them.
   - Add `trace` to the guard's list.
4. **Account limits (keep R2's).** After R2 merges, keep `src/account-limit-message.ts`. `src/wake/exit-and-limits.ts` imports it too, so it stays where it is until step 6, then moves under `src/ticket-mode/`.
5. **Workflows and host units (decide each).**
   - For each of `auto-arm.yml`, `org-reports.yml`, `outside-nightly.yml` and `outside-trunk.yml`, decide whether ticket mode still needs it. Check the arm bot that merges stacked pull requests first.
   - Do the same for each running unit under Evidence: the trace ingest, publish and publish-serve, the OTel receiver and the event receiver.
   - A program that a kept workflow or unit needs moves into ticket mode or a plugin. Any other workflow or unit is retired in step 6, together with the program it runs. Its unit is stopped through the host's install path, never by hand.
6. **Row mode (delete).** Delete the tick and everything only it reaches:
   - **The tick and its parts:** `src/work-gate.ts` and `src/work-gate/`, `src/wake.ts` and the rest of `src/wake/`, `src/row-claim.ts` and `src/row-claim/`, `src/row-file.ts` and `src/row-file/`, and `src/decision-run/`.
   - **The health readings and retro:** `src/org-health.ts` and `src/org-health/`, `src/org-retro.ts` and `src/org-retro/`.
   - **The rest of `src/trace/`.**
   - **Row mode's own account limit, in `work-gate` and `wake`:** `src/account-limit.ts`, `src/account-limit-record.ts` and `src/wake/exit-and-limits.ts`.
   - **Its programs:** `src/serve-by-run.ts`, `src/work-tick*.ts`, `src/wakes-per-row.ts`, the claim and close-rows programs, and `src/machinery-flag.ts` if step 5 kept nothing that uses it.
   - **The incident detectors that feed the retro:** `src/*-incident.ts`, `found-by-chairman.ts`, `spec-lint.ts`, `untiered-ready-rows.ts`, `unwaited-stock-rows.ts` and `blocking-impact.ts`.
   - **The tests of everything above.**
   - **Their commands in `src/commands.ts`:** `row-claim`, `row-file`, `work:gate`, `work:tick`, `work:wake`, `spawn:cycles`, `wakes:per-row`, `board:settle`, `org-retro`, `trace`, `close-rows-for-merged-pr`, `close-rows-sweep`, `org-watch` and the rest.

   The ticket for this step may split it into several pull requests, leaves first.
7. **The `rows` contract (delete, major version).** Remove `rows` from `src/plugins/contracts/code-host.ts`, along with `code-host-rows*.ts`, `src/plugins/rows*.ts` (including `src/plugins/rows-helpers.ts`), `src/plugins/row-mode.ts`, `plugins/github/rows/`, `src/ticket-port/` and the `rows` fakes. This needs a changeset that starts `Breaking:`, as ADR 0002 says.
8. **What is left (delete).** Re-run the walk, and delete each top-level `src/*.ts` program and `src/lib/` file that no entry reaches any more.

**Kept:**
- the shared helpers listed under Evidence
- `src/ticket-mode/`
- `src/install/`
- `src/plugins/` without `rows`
- every plugin

## Consequences

- If this ADR is accepted, the board can queue steps 1 to 8 as follow-up tickets. Step 7 is a major release.
- Until step 1 lands, a change to row-mode code can still break ticket mode's reviewer start. Step 1 comes first for that reason.
- If it is rejected (option B), the reviewer start keeps loading row mode, and A11-429's ideas go on building beside it.

## Paths

- `agent-org:docs/adr/`
