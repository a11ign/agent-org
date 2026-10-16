# agent-org's dependency on a project tree

Row agent-org#1590, epic "agent-org stands alone" (PROJECT_REF, closes a11ign#5429). This document sizes what agent-org's suite reads from a project tree and classifies each failing subtest. It builds nothing. The build rows it names are filed in the agent-org tracker and block agent-org#1593 (the PROJECT_REF row).

## How this was measured

Three configurations of the same rstest suite, all from the worktree at `1b5d6a82`.

1. **No project.** `AGENT_ORG_HOST` and the fleet variables unset:

   ```
   env -u AGENT_ORG_HOST -u A11Y_CONTROL_HOST_FILE -u A11Y_PVE_KEY \
     node_modules/.bin/rstest run --config scripts/rstest/rstest.config.ts
   ```

2. **Fixture project.** The same command with `AGENT_ORG_HOST` pointing at a host file whose `projects[0].checkout` is a fixture project. The fixture is built outside the repository: `host.json` copied from `src/packaging/fixtures/host-units/host.json`, and `project/` a git repository holding `.agent-org/project.json` and `.agent-org/roles/sessions.json` copied from `src/packaging/fixtures/org-health/project/`.

3. **Fixture project plus role briefs.** Configuration 2, with `.agent-org/roles/*.md` copied from a11ign's own project tree. This copy is a sizing experiment, not the fixture that will ship; it shows which failures the role briefs alone account for.

The failing-subtest list comes from rstest's JSON report, `node_modules/.cache/rstest-run-records/` (newest record for the run). Each failing subtest was classified from its failure message and stack, then the test file was read for the reader where the message did not name one.

## Results

| Configuration | Test files | Files failing | Tests | Tests failing | Notes |
|---|---|---|---|---|---|
| 1. No project | 720 | 514 at import, 9 per test | 3167 | 19 | 347 "REFUSED: it is unset" (`src/project-config.ts` `resolveHomeCheckout`), 167 TDZ on `homeProject` / `ANSWER_PREFIX` as a consequence. 197 pass. |
| 2. Fixture project | 720 | 105 (98 per test, 7 at file level) | 11885 | 469 | Dominant: `.agent-org/roles/*.md` (brief) missing, `project.json` `units` missing, and paths the suite reads from the project tree. |
| 3. Fixture plus role briefs | 98 (re-run) | 76 | 2363 | 378 | 22 of the 98 files pass once the briefs exist. |

Both figures in the row differ in method: the row's "158 of 464 subtests failed without one" does not reproduce here. rstest reports node:test files differently from node:test's own runner, so the subtest counts are not comparable. Configuration 1 files that fail at import are counted at file level, not as 464 subtests. This document reports the rstest numbers; the row's 158 is not reproduced and is not used for sizing.

A configuration-1 run that had `AGENT_ORG_HOST` set to a11ign's own `host.json` (the shell default in the worktree) gave 113 of 11965 failing. That run used the real project and is not a no-project measurement; it is recorded here so it is not mistaken for one.

Command that produced the configuration-2 failing list, after the run:

```
node -e 'const j=require(process.argv[1]); for (const t of j.tests) if (t.status==="fail") console.log(t.testPath+"\t"+t.name)' <newest record in node_modules/.cache/rstest-run-records/>
```

## Classification

Classes:

- **declaration**: a fixture `.agent-org/` (or `host.json`) serves it. Covers `.agent-org/project.json`, `host.json` `units`, role briefs, `sessions.json`.
- **project content**: a small fixture tree serves it. Covers README, `docs/`, `.github/`, `scripts/git-hooks/`, `.claude/rules/`.
- **tests the project**: reads a11ign's `packages/*`. Moves to a11ign or is deleted.
- **needs the real project / runtime**: reads herdr, `pct exec`, `tsx`, or a live fleet. Named, with the reason.
- **unresolved**: the failure does not name its reader and the test body has not been read. These are the open reads; see SIZE.

Per-file table for configuration 3 (76 files, 378 failing tests). "What it reads" is taken from the failure output; where no path is named it says so.

| subtest file | failing / total | what it reads (from failure output) | class |
|---|---|---|---|
| `src/packaging/row-file.test.ts` | 72 / 184 | not identified | unresolved (read the test body) |
| `src/packaging/work-gate.test.ts` | 47 / 416 | `<roster/order fields>`, `.github/workflows/ci.yml`, `<redOrder undefined>`, `.agent-org/project.json` | declaration + project content |
| `src/packaging/public-claim.test.ts` | 12 / 27 | `README.md`, `docs/try-it.md`, `docs` | project content |
| `src/packaging/primary-checkout-guard.test.ts` | 11 / 13 | `scripts/git-hooks/pre-commit`, `scripts/git-hooks/post-checkout` | project content |
| `src/orchestrator-one-shot.test.ts` | 10 / 13 | not identified | unresolved (read the test body) |
| `src/packaging/shared-stash-guard.test.ts` | 10 / 12 | `scripts/git-hooks/reference-transaction` | project content |
| `src/work-gate-unlabelled-pr-owner.test.ts` | 10 / 10 | `<roster/order fields>` | declaration |
| `src/ceo-one-shot.test.ts` | 9 / 15 | not identified | unresolved (read the test body) |
| `src/packaging/auto-arm-token.test.ts` | 9 / 22 | `.github/workflows/auto-arm.yml`, `.github/workflows/trunk.yml` | project content |
| `src/packaging/spec-block-refusal.test.ts` | 9 / 10 | not identified | unresolved (read the test body) |
| `src/packaging/acceptance-commands.test.ts` | 8 / 307 | `<runtime>` | needs the real project/runtime |
| `src/packaging/cross-repo-red-refusal.test.ts` | 8 / 20 | not identified | unresolved (read the test body) |
| `src/packaging/row-filing-guidance.test.ts` | 8 / 9 | `docs/row-filing.md` | project content |
| `src/work-gate-cross-repo-pr-owner.test.ts` | 8 / 13 | `<roster/order fields>` | declaration |
| `src/packaging/pr-owner-total.test.ts` | 7 / 10 | `<roster/order fields>` | declaration |
| `src/work-gate-github-incident.test.ts` | 7 / 16 | not identified | unresolved (read the test body) |
| `src/packaging/cross-repo-red-disarms.test.ts` | 6 / 8 | not identified | unresolved (read the test body) |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 6 / 9 | not identified | unresolved (read the test body) |
| `src/packaging/wake-engineer-brief.test.ts` | 6 / 16 | `packages/lab/CLAUDE.md`, `packages/judge/CLAUDE.md` | tests the project |
| `src/dora-release-commit.test.ts` | 5 / 10 | `<roster/order fields>` | declaration |
| `src/packaging/project-roles.test.ts` | 5 / 19 | not identified | unresolved (read the test body) |
| `src/work-gate-runner-start-red.test.ts` | 5 / 6 | not identified | unresolved (read the test body) |
| `src/decision-run/classes/answer-owed.test.ts` | 4 / 8 | not identified | unresolved (read the test body) |
| `src/host-kernel.test.ts` | 4 / 39 | `.agent-org/project.json` | declaration |
| `src/packaging/org-health.test.ts` | 4 / 34 | `<roster/order fields>` | declaration |
| `src/packaging/pr-owner-gone.test.ts` | 4 / 21 | `<roster/order fields>` | declaration |
| `src/packaging/pr-stall-reason.test.ts` | 4 / 19 | not identified | unresolved (read the test body) |
| `src/packaging/pr-template-acceptance.test.ts` | 4 / 4 | `.github/PULL_REQUEST_TEMPLATE.md` | project content |
| `src/packaging/shadow-window-arm.test.ts` | 4 / 23 | `.agent-org/project.json` | declaration |
| `src/packaging/verdict-valid-while-patch-unchanged.test.ts` | 4 / 22 | not identified | unresolved (read the test body) |
| `src/packaging/host-tool-install.test.ts` | 3 / 20 | `.agent-org/project.json` | declaration |
| `src/packaging/owned-path-signoff.test.ts` | 3 / 12 | `packages/lab/src/packaging/fixtures/pr-584-body.md`, `packages/lab/src/packaging/fixtures/pr-613-body.md` | tests the project |
| `src/packaging/pr-open-requires-verify-stamp.test.ts` | 3 / 9 | `<roster/order fields>` | declaration |
| `src/packaging/ready-flip-on-green-checks.test.ts` | 3 / 5 | `<roster/order fields>` | declaration |
| `src/work-gate-other-scopes-concurrent.test.ts` | 3 / 12 | not identified | unresolved (read the test body) |
| `src/defect-class-line.test.ts` | 2 / 10 | not identified | unresolved (read the test body) |
| `src/dora-direct-to-latest-has-no-channels.test.ts` | 2 / 8 | not identified | unresolved (read the test body) |
| `src/host-check-home-specifier.test.ts` | 2 / 5 | `.agent-org/project.json` | declaration |
| `src/packaging/live-tree-independence.test.ts` | 2 / 4 | `<runtime>` | needs the real project/runtime |
| `src/packaging/project-vocabulary.test.ts` | 2 / 17 | not identified | unresolved (read the test body) |
| `src/packaging/prompt-session.test.ts` | 2 / 31 | `.claude/rules` | project content |
| `src/packaging/queue-stalled.test.ts` | 2 / 51 | not identified | unresolved (read the test body) |
| `src/packaging/row-claim-session-eligibility.test.ts` | 2 / 31 | not identified | unresolved (read the test body) |
| `src/packaging/row-file-refuses-unreadable-wait.test.ts` | 2 / 3 | not identified | unresolved (read the test body) |
| `src/packaging/tracker-leak-refusal.test.ts` | 2 / 14 | `<runtime>` | needs the real project/runtime |
| `src/packaging/work-gate-awaiting-evidence.test.ts` | 2 / 13 | `.claude/rules/org-routing-and-timers.md` | project content |
| `src/work-gate-unordered-review-pr.test.ts` | 2 / 12 | not identified | unresolved (read the test body) |
| `src/ci-health-liveness.test.ts` | 1 / 30 | not identified | unresolved (read the test body) |
| `src/duplicate-row.test.ts` | 1 / 16 | not identified | unresolved (read the test body) |
| `src/event-tunnel.test.ts` | 1 / 18 | not identified | unresolved (read the test body) |
| `src/packaging/acceptance-exit-code.test.ts` | 1 / 23 | not identified | unresolved (read the test body) |
| `src/packaging/acceptance-prose.test.ts` | 1 / 16 | not identified | unresolved (read the test body) |
| `src/packaging/board-appendix-gate-record.test.ts` | 1 / 1 | not identified | unresolved (read the test body) |
| `src/packaging/board-reported-data-integrity.test.ts` | 1 / 2 | `docs/board/reported` | project content |
| `src/packaging/deferred-order-relane.test.ts` | 1 / 6 | `<roster/order fields>` | declaration |
| `src/packaging/fyi-does-not-wake-a-seat.test.ts` | 1 / 14 | not identified | unresolved (read the test body) |
| `src/packaging/host-install-agent-org-launcher.test.ts` | 1 / 6 | not identified | unresolved (read the test body) |
| `src/packaging/late-edition.test.ts` | 1 / 11 | `packages/cli/package.json` | tests the project |
| `src/packaging/multi-board-gate.test.ts` | 1 / 15 | not identified | unresolved (read the test body) |
| `src/packaging/persistent-seat-running.test.ts` | 1 / 15 | not identified | unresolved (read the test body) |
| `src/packaging/reconstitution-drill.test.ts` | 1 / 5 | not identified | unresolved (read the test body) |
| `src/packaging/release-tag-on-merge.test.ts` | 1 / 5 | not identified | unresolved (read the test body) |
| `src/packaging/wake-order-shape.test.ts` | 1 / 11 | not identified | unresolved (read the test body) |
| `src/packaging/wake.test.ts` | 1 / 151 | `<runtime>` | needs the real project/runtime |
| `src/packaging/worktree-owner.test.ts` | 1 / 7 | not identified | unresolved (read the test body) |
| `src/pr-approved-not-counted-cause.test.ts` | 1 / 7 | not identified | unresolved (read the test body) |
| `src/reviewer/reviewer-setup.test.ts` | 1 / 8 | `docs/known-gaps.md` | project content |
| `src/tmp-fixtures-are-removed.test.ts` | 1 / 9 | not identified | unresolved (read the test body) |
| `src/unsplit-done-when-post-merge.test.ts` | 1 / 9 | not identified | unresolved (read the test body) |
| `src/unsplit-done-when.test.ts` | 1 / 10 | not identified | unresolved (read the test body) |
| `src/wake-reviewer-instance.test.ts` | 1 / 63 | `node_modules`, `<runtime>` | needs the real project/runtime |
| `src/work-gate-checkless-pr.test.ts` | 1 / 12 | not identified | unresolved (read the test body) |
| `src/work-gate-one-wave.test.ts` | 1 / 6 | not identified | unresolved (read the test body) |
| `src/work-gate-truncated-pr-files.test.ts` | 1 / 10 | not identified | unresolved (read the test body) |
| `src/work-gate/same-head-refail.test.ts` | 1 / 5 | `<roster/order fields>` | declaration |
| `src/work-gate/shared-file-orders-recheck-switch.test.ts` | 1 / 7 | not identified | unresolved (read the test body) |

Summary of configuration 3 by class, subtests (files):

| Class | Subtests | Files |
|---|---|---|
| declaration (incl. declaration + project content) | 106 | 15 |
| project content | 60 | 10 |
| tests the project | 10 | 3 |
| needs the real project / runtime | 14 | 5 |
| unresolved | 188 | 43 |
| **Total** | **378** | **76** |

Files failing at file level in configuration 2 (not in the table above). Each reads a path that the fixture lacks: `package.json` at the project root (5 files: board-appendix-gate-record, board-liveness, board-reported-data-integrity, row-claim-template-fields-rule, waiting-language-rule), `docs/lane-ownership.json` (standalone-roots), `.agent-org/roles/ceo.md` (org-retro), `.claude/rules` (worker-profile), and a lab job artifact (board-gate-source). Class: declaration for the first three, project content for the rest except the lab artifact, which needs the real project.

## SIZE

- **Suite:** 720 test files, 11885 rstest tests. Configuration 2 fails 105 files and 469 tests; configuration 3 fails 76 files and 378 tests.
- **Import-time refusal:** 514 of 720 files stop at import with no project. A declaration that resolves the home checkout (`.agent-org/project.json` at the root or `AGENT_ORG_HOST` set) is the first thing any fixture must provide. Not verified in this change: that a root `.agent-org/project.json` alone clears the 514. The first build row verifies it.
- **Classification of configuration 3:** declaration 106 subtests in 15 files; project content 60 in 10; tests the project 10 in 3; needs the real project / runtime 14 in 5; unresolved 188 in 43.
- **Files to add to the fixture** (distinct paths the failures read): 21 from file-level and per-test ENOENT, plus `package.json` and `docs/lane-ownership.json` from file-level failures.

## Proposed split

This PR holds only this file. Each build row below is small enough to review on its own.

1. **Fixture project** (declaration, then project content). `src/packaging/fixtures/project-tree/`: `.agent-org/project.json`, `.agent-org/host.json` with `units`, minimal role briefs, `sessions.json`, root `package.json`, `docs/lane-ownership.json`. Then the project-content paths.
2. **Per-family switches, the wake family** (`wake*`, `wake-spawn-*`, `reviewer/*`, `spawn-role-brief`). Needs the brief and roster fixtures from 1.
3. **Per-family switches, the work-gate family** (`work-gate*`, `pr-owner-*`, `ready-flip-on-green-checks`, `cross-repo-red-*`, `ready-row-dispatch`).
4. **Per-family switches, row-file and the filing gate** (`row-file*`, `row-claim-*`, `defect-class-line`, `duplicate-row`, `unsplit-done-when*`, `spec-block-refusal`).
5. **Remaining families:** guards and hooks (`primary-checkout-guard`, `shared-stash-guard`), public claim, auto-arm, acceptance commands. Also the 43 unresolved files (read each body and classify), and the 10 "tests the project" subtests and 14 "needs the real project" subtests, each skipped with a named reason in the suite. Moving the packages tests to a11ign is a row in a11ign's tracker and is not filed here.
6. **Delete PROJECT_REF:** agent-org#1593, already filed. It is blocked by rows 1 to 5.

## Build rows filed

Filed in agent-org's tracker (`row-file --tracker=agent-org`), chained: each row waits on the one before it (`Waiting-for: merged #N` in its body). Each one, and agent-org#1590, blocks agent-org#1593 through the native blocked-by edge.

| Row | Issue | Waits on | Scope |
|---|---|---|---|
| 1 | https://github.com/a11ign/agent-org/issues/1600 | none | Fixture project tree and declaration (`src/packaging/fixtures/project-tree/`) |
| 2 | https://github.com/a11ign/agent-org/issues/1601 | 1600 | Wake family to the fixture |
| 3 | https://github.com/a11ign/agent-org/issues/1602 | 1601 | Work-gate family to the fixture |
| 4 | https://github.com/a11ign/agent-org/issues/1603 | 1602 | Row-file and filing-gate family, after reading the unnamed readers |
| 5 | https://github.com/a11ign/agent-org/issues/1604 | 1603 | Remaining families, the 43 unresolved files, and the 10 tests-the-project and 14 needs-real-project subtests |
| 6 | https://github.com/a11ign/agent-org/issues/1593 | 1590, 1600 to 1604 | Delete `PROJECT_REF` (already filed) |

The 10 tests-the-project subtests that move to a11ign's packages are not filed here; they need a row in a11ign's tracker.

## The wake family against the fixture (agent-org#1601)

Acceptance run on the row's branch with the fixture copy: `VERDICT fail: 4 of 33 tests failed in 3 files`. The other 29 pass, `wake-order-shape.test.ts` among them. Each of the four failing subtests, with the reader its failure points at:

| Subtest file | Subtest | Reader | What the fixture lacks | Class |
|---|---|---|---|---|
| `src/packaging/fyi-does-not-wake-a-seat.test.ts` | #3562 only a lead seat holds an FYI, and only an order that declares no decision | `isLeadSeat` (`src/wake.ts`) reads `.agent-org/roles/sessions.json`, `live` | No `liaison` entry; `isLeadSeat("liaison")` is false. a11ign's roster has one | declaration |
| `src/reviewer/reviewer-setup.test.ts` | the shipped reviewer recipe symlinks no whole node_modules, and still builds its own @a11ign links | `.agent-org/roles/reviewer.md` (`ROLE_DOC`) | The fixture brief is a stub. The emptiness check passes on it; its positive control (`ln -sfn .*\.venv`) fails | project content |
| `src/reviewer/reviewer-setup.test.ts` | known-gaps §48 records the accepted exposure | `docs/known-gaps.md` §48 (`KNOWN_GAPS`) | No §48. The fixture file has three lines | project content |
| `src/reviewer/reviewer-setup.test.ts` | the reviewer role document says the rules stop accident, not a wall, and points at §48 | `.agent-org/roles/reviewer.md`, section "What your sandbox rules are, and are not" | No such section | project content |

The §48 record and the recipe are a11ign's decisions and text. The fixture's own brief says it "carries no project's rules", so the honest fixes are not a copy of them into the fixture. The `liaison` entry is a declaration the fixture should carry. Deciding how the project-content subtests leave this row is the product-manager's, since it changes the Acceptance.

## Open

- The 188 unresolved subtests (43 files) need their test bodies read. Row 5 carries that.
- The configuration-3 role briefs came from a11ign, not from a fixture. Row 1 writes minimal fixture briefs and reruns to confirm the 22 files cleared here still clear.
- The 514 import-time refusals in configuration 1 are measured, but the fix (a root `.agent-org/project.json`) is a hypothesis until row 1 runs.
- The 14 "needs the real project / runtime" subtests and the 10 "tests the project" subtests are named but not decided. The decision is row 5's.
