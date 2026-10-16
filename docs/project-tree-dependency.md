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
| 3 | https://github.com/a11ign/agent-org/issues/1602 | 1601 | Work-gate family to the fixture (section below) |
| 4 | https://github.com/a11ign/agent-org/issues/1603 | 1602 | Row-file and filing-gate family, after reading the unnamed readers |
| 5 | https://github.com/a11ign/agent-org/issues/1604 | 1603 | Remaining families, the 43 unresolved files, and the 10 tests-the-project and 14 needs-real-project subtests |
| 6 | https://github.com/a11ign/agent-org/issues/1593 | 1590, 1600 to 1604 | Delete `PROJECT_REF` (already filed) |

The 10 tests-the-project subtests that move to a11ign's packages are not filed here; they need a row in a11ign's tracker.

## The wake family against the fixture (agent-org#1601)

Acceptance run on the row's branch with the fixture copy, before the change: `VERDICT fail: 4 of 33 tests failed in 3 files`. The other 29 pass, `wake-order-shape.test.ts` among them. Each of the four failing subtests, with the reader its failure points at:

| Subtest file | Subtest | Reader | What the fixture lacks | Class | Resolution |
|---|---|---|---|---|---|
| `src/packaging/fyi-does-not-wake-a-seat.test.ts` | #3562 only a lead seat holds an FYI, and only an order that declares no decision | `isLeadSeat` (`src/wake.ts`) reads `.agent-org/roles/sessions.json`, `live` | No `liaison` entry; `isLeadSeat("liaison")` is false. a11ign's roster has one | declaration | `liaison` entry added to the fixture `sessions.json`, with `.agent-org/roles/liaison.md` beside the other briefs |
| `src/reviewer/reviewer-setup.test.ts` | the shipped reviewer recipe symlinks no whole node_modules, and still builds its own @a11ign links | `.agent-org/roles/reviewer.md` (`ROLE_DOC`) | The fixture brief is a stub. The emptiness check passes on it; its positive control (`ln -sfn .*\.venv`) fails | project content | Moved to `src/reviewer/reviewer-recipe.test.ts`, byte for byte; still runs against a11ign |
| `src/reviewer/reviewer-setup.test.ts` | known-gaps §48 records the accepted exposure | `docs/known-gaps.md` §48 (`KNOWN_GAPS`) | No §48. The fixture file has three lines | project content | Moved to `src/reviewer/reviewer-recipe.test.ts`, byte for byte |
| `src/reviewer/reviewer-setup.test.ts` | the reviewer role document says the rules stop accident, not a wall, and points at §48 | `.agent-org/roles/reviewer.md`, section "What your sandbox rules are, and are not" | No such section | project content | Moved to `src/reviewer/reviewer-recipe.test.ts`, byte for byte |

The §48 record and the recipe are a11ign's decisions and text. The fixture's own brief says it "carries no project's rules", so they are not copied into the fixture, and the tests are not skipped or weakened on it. The `liaison` entry is a declaration the fixture carries. The product-manager ruled on this split (2026-10-16).

After the change the fixture run is `VERDICT pass: 28 tests in 3 files`: the 33 less the five subtests that moved (the three project-reading tests, and the two pure control tests of the helper they depend on). `reviewer-recipe.test.ts` run with no fixture variable, so against a11ign's own host, passes 5 of 5, and no coverage is lost. Row 5 moves that file to a11ign.

## The work-gate family against the fixture (agent-org#1602)

Acceptance run on the row's branch with the fixture copy, before the change: `VERDICT fail: 71 of 470 tests failed in 5 files` (work-gate 48, awaiting-evidence 1, cross-repo-pr-owner 8, cross-repo-red-refusal 8, cross-repo-red-disarms 6). Three causes were fixed in the tests or the fixture, and the rest moved:

- **Test data, not the fixture.** The tests' pull-request literals lacked `isCrossRepository`, which `decide` reads as "outside" unless it is `false` (`src/review-trust.ts:111`). Production `readPrs` always supplies it, so the literals now do too. The tests pin `decide`'s identities to a test-owned list (#1311), as `work-gate-cross-repo-pr-owner.test.ts` does with `DECLARED`.
- **Fixture declaration.** `.agent-org/project.json` declares `lab` (`a11ign/lab`) under `code`. `legSourceOf` (`src/cross-repo-red.ts:98`) reads it, and every cross-repo-red test needed it. This is the only fixture file the row changes.
- **Moved, byte for byte.** Twenty-eight top-level subtests read a fact the fixture tree cannot supply. They are in `src/packaging/work-gate-a11ign-readers.test.ts`, which runs in the default suite against a11ign's checkout. Nothing is skipped or weakened. Each subtest's reader is named below.

The fixture run after the change is `VERDICT pass: 442 tests in 5 files`: the 470 less the 28 that moved. `work-gate-a11ign-readers.test.ts` is declared in `DECLARED_HISTORY_POPULATION` (`work-gate.test.ts`), because it imports the same `host-units.ts` edge as the other entries there.

| Subtest | Original line | Reader | What the fixture lacks | Class | Resolution |
|---|---|---|---|---|---|
| #2296 a shelved `priority` row stays shelved | 265 | `declaredRegionFiles` (`src/region-paths.ts`) reads `git ls-files` in the project | Acceptance copies the tree and runs `git init` but stages nothing, so no top-level directory is tracked and `.github/workflows/release.yml` declares nothing | git index | Moved |
| a row whose Region overlaps an open PR is NOT offered | 655 | same | same | git index | Moved |
| the SAME row IS offered when no open PR touches its Region (positive control) | 667 | same | same | git index | Moved, with its negatives |
| NO REGION is cannot-ask, not no-overlap | 743 | same | same | git index | Moved |
| a TRUNCATED pull-request file list is dropped from the comparison | 758 | same | same | git index | Moved |
| #2101 a row is OFFERED although an open PR holds its Region, when that PR declares `Closes` | 788 | same (`docs/messaging.md`) | same | git index | Moved |
| #2101 NEGATIVE: the same row is still SHELVED | 795 | same | same | git index | Moved |
| #2101 the shelving REPORT names the same two | 806 | same | same | git index | Moved |
| #2493 THE POSITIVE: a held PR closing only the asking row does not shelve it | 893 | same | same | git index | Moved |
| #2493 NEGATIVES, through the gate | 902 | same | same | git index | Moved |
| #2493 a held PR closing NOTHING, or closing two rows with one edge missing | 914 | same | same | git index | Moved |
| prFiles omitted means every row is offered | 976 | same | same | git index | Moved |
| the empty-shelf order says WHY the pool is empty | 982 | same | same | git index | Moved |
| #2493 product-manager's brief says `SOLE HOLDER IS A HELD PR` | 943 | `.agent-org/roles/product-manager.md`, the bullet's text | The fixture brief is a stub without that bullet | project content | Moved; the brief is a11ign's text and is not copied into the fixture |
| every cause is classified as START or FINISH | 1064 | `START_CAUSES` (`src/cause-declaration.ts:734`) | On the fixture host `fleet-batch-due` is not in the START list the test pins | host configuration, not traced further | Moved |
| a red check that CAN block the merge still wakes its session | 1310 | `decide`'s owner routing for `session:worker-capture` | The fixture roster (`roles/sessions.json`) holds `worker-<n>` from 4 and no `worker-capture`; the order routes elsewhere, so none is returned to the test | session roster | Moved |
| #2538 the pr-checks-failing order keeps its (a)/(b)/(c) triage | 1322 | same | same | session roster | Moved |
| an UNREADABLE required set counts every check | 1334 | same, with the required set | same | session roster | Moved |
| a CANCELLED required check with nothing else running still reaches its author | 1378 | same | same | session roster | Moved |
| the same two red jobs WITHOUT the hold still order | 1422 | same | same | session roster | Moved |
| a THIRD red job ends the exemption | 1432 | same | same | session roster | Moved |
| ANY session's hold answers a PR red only from it | 1445 | same | same | session roster | Moved |
| a rowOwner-routed PR under any hold generates no order | 1473 | same | same | session roster | Moved |
| HOLD_RED_JOBS names the jobs ci.yml defines | 1489 | `.github/workflows/ci.yml`, read at test line 1490 | The fixture `ci.yml` has one job, `ci`; a11ign's defines the `deliberateRefusals` and the other jobs `HOLD_RED_JOBS` names | project content | Moved |
| a held PR at the cap stops appearing in stuck (positive control) | 1537 | same as 1310 | same | session roster | Moved |
| a PR held by SOMEBODY ELSE at the cap is not stuck (positive control) | 1556 | same as 1310 | same | session roster | Moved |
| a SUPERSEDED red run does not wake anyone | 2094 | same as 1310 | same | session roster | Moved |
| #1941 the retired timer's units are gone from the shipped host set | 3162 | `shippedUnits` (`src/host-units.ts`) | The fixture host does not ship a11ign's unit set, so the positive control (the tick's own units still ship) fails | host configuration | Moved |

The "session roster" class is inferred from the failure, not traced line by line: the fixture roster has no `worker-capture` seat, and the test's order comes back `undefined` where it expects one. Each of these fails at HEAD too on this sandbox's default host (`VERDICT fail: 38 of 416 tests failed` for the unchanged `work-gate.test.ts`, 11 of them in this group), so the sandbox cannot show them green. They are expected to pass on a11ign's own host in CI, where the roster and CI jobs exist, but this row did not verify that.

## The row-file and filing-gate family against the fixture (agent-org#1603)

Acceptance run on the row's branch with the fixture copy, before any change: `VERDICT fail: 90 of 250 tests failed in 5 files` (`row-file.test.ts` 72 of 184, `row-file-refuses-duplicate-title.test.ts` 6 of 9, `row-claim-session-eligibility.test.ts` 2 of 31, `spec-block-refusal.test.ts` 9 of 10, `duplicate-row.test.ts` 1 of 16). Each failing subtest's reader is named below, from its test body and the code it calls. The classes are:

- `tests-project`: the test names a path under `packages/`, a tracked top-level directory of a11ign's checkout that the fixture does not have.
- `declaration`: the test needs `vocabulary.resources` in `.agent-org/project.json`, which the fixture declares as `[]`, so the fleet and lab routing patterns (`FLEET_LAB_PATTERNS`) are empty.
- `project-content`: the test reads the tracked `docs/` directory. The fixture has `docs/`, but the Acceptance copy runs `git init` and never stages it, so `trackedTopLevelDirs()` finds nothing.

Skips. Each skip is conditional on its reader being absent, and it names the reason only when it fires. In a11ign's checkout the check runs:

- `SKIP_NO_PACKAGES` (set in the four files that hold `tests-project` rows) is `false` wherever `trackedTopLevelDirs()` lists `packages/`.
- `SKIP_NO_RESOURCES` (`row-file.test.ts`) is `false` wherever `RESOURCES` declares at least one resource.

Results:

- The Acceptance as written, after the skips and with the copy staged and committed (the amendment of 2026-10-16T16:20Z): `VERDICT pass: 164 tests in 5 files (86 skipped)`.
- Before that amendment, the Acceptance copied the fixture without committing it, and the 4 `project-content` subtests below stayed red: `VERDICT fail: 4 of 164 tests failed in 5 files`. Their reader is the fixture's `docs/`, which the fixture supplies, so they were not skipped. Committing the copy is what lets `trackedTopLevelDirs()` read it.
- The same five files against a11ign's host (`AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json`, the Acceptance's other variables unset as in the Acceptance): `VERDICT pass: 250 tests in 5 files`, with no skips. The ordinary case runs.

| Subtest file | Subtest | Reader | Class | Action |
|---|---|---|---|---|
| `src/duplicate-row.test.ts` | the state sent is the two titles and the two Region lists, and never a body | tracked top-level dir `docs/` of the project checkout (git ls-files in HOME_CHECKOUT) | project-content | Not skipped: reads the fixture's `docs/`; passes once the Acceptance copy is committed (see above) |
| `src/packaging/row-claim-session-eligibility.test.ts` | #462's own acceptance shape: a CONSTRUCTED region overlap refuses, end to end | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-claim-session-eligibility.test.ts` | MUTATION TARGET: --blocked-by given while the refusal is B4 (file overlap), not  | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 1. THE LAYOUT CASE: the same title filed twice while the first is open is refuse | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 2. POSITIVE CONTROL: a title one word apart is NOT refused, and the tool did ask | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 3. a title equal to a CLOSED row's is not refused (a reopened-and-refiled row is | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 4. a title differing only in case or surrounding space IS refused | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 5. a failed list read REFUSES rather than files, and says so (CANNOT_ASK, never  | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | 7. `--allow-same-title` files the second row, asks nothing, and is not passed on | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | a complete body is not refused | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | ACCEPTANCE: a complete body with --session= files -- spawnGh receives the body W | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE, MUTATION TARGET: the board label is added via a SEPARATE gh iss | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | ACCEPTANCE: the issue is added to Project 2 and its Status is moved to match the | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | ACCEPTANCE, MUTATION TARGET: the issue number and https URL are read back and pr | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #883 ACCEPTANCE: a MULTI-LANE Region derives and applies BOTH lane labels throug | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | a gh failure (non-zero exit) is surfaced as this tool's own exit code, not swall | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE: gh issue create succeeding but printing something that is not a | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE: a failure adding the issue to Project 2 is refused distinctly ( | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE, MUTATION TARGET: a Status move that does not succeed is refused | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE: a label-add failure AFTER a successful Status move is refused d | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #844 ACCEPTANCE, MUTATION TARGET: everything succeeds but the READ-BACK disagree | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1011 FOLLOWABILITY: filing again with the refusal's OWN suggestion passes | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1011: `--label out-of-release` with no milestone is ALLOWED -- the deliberate e | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1011: a milestone GITHUB DID NOT APPLY is named by the read-back -- the #1003 h | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1158: the warning reaches the author, and is a warning rather than a refusal | tracked top-level dir `docs/` of the project checkout (git ls-files in HOME_CHECKOUT) | project-content | Not skipped: reads the fixture's `docs/`; passes once the Acceptance copy is committed (see above) |
| `src/packaging/row-file.test.ts` | #1174 clause 1: an Open-check asserting an output with NO transcript is refused | tracked top-level dir `docs/` of the project checkout (git ls-files in HOME_CHECKOUT) | project-content | Not skipped: reads the fixture's `docs/`; passes once the Acceptance copy is committed (see above) |
| `src/packaging/row-file.test.ts` | #1174 clause 2: a transcript present but NON-ADJACENT is refused | tracked top-level dir `docs/` of the project checkout (git ls-files in HOME_CHECKOUT) | project-content | Not skipped: reads the fixture's `docs/`; passes once the Acceptance copy is committed (see above) |
| `src/packaging/row-file.test.ts` | #1241: a pathless row whose acceptance reaches the fleet gets lane:orchestrator | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1241: the lab is its own reason, and an ordinary row gets neither | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1241: it reads the COMMANDS list, and a prose line IS one of those | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1241: the two rows this was filed on are both routed | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1241: a clause below the first line is still read | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1912: #1911's Acceptance -- the Proxmox key named only in a bullet -- derives n | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1912: the same name in a fence or a numbered clause still routes | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1912: an INVOCATION in a bullet still routes -- only named things are read as a | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1914: a WRAPPED bullet is prose on every line -- its continuation does not rout | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1914: a bullet item ENDS at a numbered clause, a heading, or a blank line then  | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1914: a fence ENDS the bullet item -- an unindented sentence after the closing  | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1912: createIssue files a fleet-Acceptance row with lane:orchestrator and witho | tracked top-level dir `packages/` of the project checkout; secondary: .agent-org/project.json vocabulary.resources | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1988: a NAMED pattern only in the scope-disclaiming paragraph does not route th | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1988: a Done-when clause naming hardware still routes, before or after the same | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1988: an INVOCATION in the disclaimer still routes -- only NAMED things are tri | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #1988: createIssue on a disclaimer-only systemd mention files lane:any and NAMES | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1914: createIssue on a bullet-only Proxmox mention files lane:any and WARNS on  | tracked top-level dir `packages/` of the project checkout; secondary: .agent-org/project.json vocabulary.resources | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322 ACCEPTANCE (case 1): an explicit lane that DIFFERS from the derived one re | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322 CONTROL (case 1): an explicit lane EQUAL to the derived one files, with ex | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322 ACCEPTANCE (case 2): `--label=ready` boards Ready and is never `backlog` t | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322 CONTROL (case 2): no board flag at all still files `backlog` | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322: `ready` and `backlog` together refuse, in any mix of --ready and --label | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1322: the board and lane labels never reach `gh issue create`; every other labe | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2147: the lanes a filing applies are the derived set exactly, and never `lane:a | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1393 ACCEPTANCE: every spelling gh takes files with the Out of release mileston | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1393 CONTROL: `--label out-of-release` still files with the milestone, and no l | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1962 ACCEPTANCE, DRIVEN: `--milestone "Out of release"` alone files WITH the la | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1962 CONTROL: a REAL milestone gets no `out-of-release` label -- the direction  | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1962 CONTROL: the MILESTONE this tool added is read back too, not only the one  | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1962 CONTROL: a label the read-back does NOT find is REFUSED, not reported as f | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1488 ACCEPTANCE: a heading followed by an `Acceptance: none` line (the 22-row s | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1488: an Acceptance section the parser reads as MISSING is refused, in both sha | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1488 CONTROL: the one-header forms are accepted -- a heading with a command blo | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #1488: the refusal is FOLLOWABLE -- the refused body, collapsed to the one heade | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2099: a row whose Acceptance is an UNDECLARED `gh` command is refused by `fileR | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2099 CONTROL: the SAME row carrying the declaration files clean -- the ruling i | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, MUTATION TARGET: the Status moves first, and the labels are th | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, MUTATION TARGET, FAILURE INJECTION: when the label write FAILS | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, FAILURE INJECTION: the RECOVERY -- a second run after a failed | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, FAILURE INJECTION: if the endpoint APPENDED instead of replaci | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, MUTATION TARGET: a claim landing between the gate and the writ | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE: promotionLabelsSettled is what stops an already-Ready row bein | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE: a row already carrying BOTH labels is repaired by the one writ | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE, MUTATION TARGET: a well-formed row is NOT refused -- the contr | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111: the claimability refusal is the SAME rule the claim side enforces, named  | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2111 ACCEPTANCE: the read-back refuses to report success when `backlog` is stil | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2175: a row answering No is NOT routed by a named pattern in a numbered clause  | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #2175: a row answering Yes IS routed even when no pattern matches anywhere in it | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #2175: a body with no answer, or one that is not an unambiguous No or Yes, deriv | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #2175: an INVOCATION under a No still routes -- the declaration outranks only th | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #2175: a disagreement between the declaration and the patterns is NAMED, whichev | .agent-org/project.json vocabulary.resources (RESOURCES, src/project-vocabulary.ts:163 -> FLEET_LAB_PATTERNS, src/acceptance-commands.ts:113-120) | declaration | Skipped: `SKIP_NO_RESOURCES` |
| `src/packaging/row-file.test.ts` | #2175: createIssue on #2174's shape files lane:any and SAYS the declaration deci | tracked top-level dir `packages/` of the project checkout; secondary: .agent-org/project.json vocabulary.resources | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2175: createIssue on a Yes with no pattern files lane:orchestrator, without lan | tracked top-level dir `packages/` of the project checkout; secondary: .agent-org/project.json vocabulary.resources | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/row-file.test.ts` | #2175: createIssue on a No that still runs an invocation routes it AND prints th | tracked top-level dir `packages/` of the project checkout; secondary: .agent-org/project.json vocabulary.resources | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | the control block is fileable on its own, and the hand parser agrees with yaml a | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | a block missing each required field is refused naming the field path | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | an empty field is refused naming the field path | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | a `then` that asserts nothing is refused, with the case index in its path | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | more than one spec block is refused | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | a spec fence that is never closed, and YAML that does not read, are refused rath | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | NEGATIVE CONTROL: a valid block with the optional fields absent passes, and with | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | the exemption: a row with no spec fence, or a spec shown inside another fence, p | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |
| `src/packaging/spec-block-refusal.test.ts` | the flag off passes everything; the flag is on only when exactly true | tracked top-level dir `packages/` of the project checkout (git ls-files in HOME_CHECKOUT = $AGENT_ORG_HOST primary checkout); fixture has no packages/ | tests-project | Skipped: `SKIP_NO_PACKAGES` |

## The remaining families against the fixture (agent-org#1604)

Acceptance (the row's five-file command, copy committed) before any change: `VERDICT fail: 26 of 83 tests failed in 5 files` (`auto-arm-token.test.ts` 7, `public-claim.test.ts` 12, `row-filing-guidance.test.ts` 7). `primary-checkout-guard.test.ts` and `shared-stash-guard.test.ts` passed unchanged.

After: `VERDICT pass: 57 tests in 5 files (26 skipped)`, EXIT=0. The CI-runnable block in `.acceptance/agent~agent-org-stands-alone-agent-org-1604.md` leaves out the two token-needing files: `VERDICT pass: 32 tests in 3 files (26 skipped)`, EXIT=0. `tsc --noEmit` exits 0.

Skips. Each is `{ skip: SKIP_FIXTURE }` on a `test(` call, where `SKIP_FIXTURE` is `false` wherever `trackedTopLevelDirs()` lists `packages/`, and otherwise a named reason. The skip markers were checked against the TypeScript AST, so each sits on a real call header.

| Subtest file | Subtests skipped | Reader | Class |
|---|---|---|---|
| `src/packaging/auto-arm-token.test.ts` | 7 of 22 (#4198 arm and sweep, MUTATION TARGET, contents, secrets read, stored-token name, `issues: write`, #2358/#4198/#4486) | `.github/workflows/auto-arm.yml` of the checkout; the fixture's copy is 9 lines with no arm or sweep jobs | project-content |
| `src/packaging/public-claim.test.ts` | 12 of 27 | the public claim block, README claim, and recorded gate entries; the fixture has none of them. The "most recently recorded gate entry" test passes and is not skipped | project-content |
| `src/packaging/row-filing-guidance.test.ts` | 7 of 9 | `docs/row-filing.md`, a one-line stub in the fixture | project-content |
| `src/packaging/wake-engineer-brief.test.ts` | 5 of 14 | the engineer brief and `packages/lab/CLAUDE.md`, `packages/judge/CLAUDE.md` | tests-project |
| `src/packaging/owned-path-signoff.test.ts` | 3 of 12 | the two real pull request bodies (#584, #613) and the owner's owned-path list | tests-project |
| `src/packaging/wake.test.ts` | 1 of 151 (line 467) | the live roster `.agent-org/roles/sessions.json` | needs-real-project |
| `src/wake-reviewer-instance.test.ts` | 1 of 63 (line 712) | `reviewer.md` | needs-real-project |

The last two rows, and `wake-engineer-brief` and `owned-path-signoff`, are not in the Acceptance's five files. Their skips are from reading the test bodies; they were not run here, because those files reach the org multiplexer (see the incident below). `wake-engineer-brief` has one failing subtest in the configuration-3 table that no reader identifies, so 5 of 6 are skipped.

The 43 files still unresolved (the Open section's "188 unresolved subtests (43 files)"). Reader and class come from reading each file's imports, helpers, and literal paths (a keyword pass for the files marked "none found"). `Action` says what the file does now.

| File | Reader | Class | Action |
|---|---|---|---|
| `src/packaging/row-file.test.ts` | `SKIP_NO_PACKAGES`, `SKIP_NO_RESOURCES` (1603); `declaredRegionFiles`; tool-source reads | tests-project, declaration, pure | Guarded (1603) |
| `src/orchestrator-one-shot.test.ts` | `RESOURCES` hash pin | declaration | Not skipped; unverified on the fixture |
| `src/ceo-one-shot.test.ts` | `RESOURCES` hash pin | declaration | Not skipped; unverified on the fixture |
| `src/packaging/spec-block-refusal.test.ts` | `packages/lab/...` Region | tests-project | Guarded (1603) |
| `src/packaging/row-file-refuses-duplicate-title.test.ts` | `packages/` Region | tests-project | Guarded (1603) |
| `src/packaging/row-claim-session-eligibility.test.ts` | `packages/` Region at 155, 467 (guarded), and `SPLIT_REGION_FILE` at 659 | tests-project (3), pure (rest) | 659 group not guarded; open |
| `src/packaging/cross-repo-red-refusal.test.ts` | `homeProjectDeclaration().code` | declaration | Not skipped; unverified |
| `src/packaging/cross-repo-red-disarms.test.ts` | the default in `cross-repo-red.ts:132` | declaration | Not skipped; unverified |
| `src/work-gate-one-wave.test.ts` | `homeProjectDeclaration()` | declaration | Not skipped; unverified |
| `src/work-gate-other-scopes-concurrent.test.ts` | `homeProjectDeclaration()` | declaration | Not skipped; unverified |
| `src/dora-direct-to-latest-has-no-channels.test.ts` | `homeProjectDeclaration().dora` | declaration | Not skipped; unverified |
| `src/packaging/project-roles.test.ts` | roles, causes, profiles; absence check on `packages/agent-org/docs/roles` | declaration, pure | Not skipped; the absence check passes on the fixture |
| `src/packaging/project-vocabulary.test.ts` | `.agent-org/project.json`; `RESOURCES.length === 15` and `named === 5` | declaration | Not skipped; the pins are a11ign's numbers |
| `src/ci-health-liveness.test.ts` | `scripts/ci-health.ts` (2 tests) | project-content | Not guarded; open |
| `src/event-tunnel.test.ts` | live-host test, already guarded | declaration, pure | Live test already guarded |
| `src/work-gate-truncated-pr-files.test.ts` | `docs/messaging.md` Region | project-content | Not guarded; open |
| `src/defect-class-line.test.ts` | `packages/` Region at 163 | project-content | Not guarded; open |
| `src/unsplit-done-when.test.ts` | `packages/` Region at 18 (`createIssue` at 87) | project-content, pure | Not guarded; open |
| `src/unsplit-done-when-post-merge.test.ts` | `packages/` Region at 18 (`createIssue` at 133) | project-content, pure | Not guarded; open |
| `src/packaging/row-file-refuses-unreadable-wait.test.ts` | `COMPLETE_BODY` Region | project-content | Not guarded; open |
| `src/packaging/board-appendix-gate-record.test.ts` | `docs/board/reported` gate records | project-content | Not guarded; open |
| `src/packaging/persistent-seat-running.test.ts` | a persistent seat named `RECIPIENT` in the roster (test at 261) | declaration, pure | Not skipped; open |
| `src/packaging/reconstitution-drill.test.ts` | `HOME_CHECKOUT` in 3 live tests | needs-real-project, pure | Not skipped; open |
| `src/packaging/multi-board-gate.test.ts` | declared brief path in pinned prompts | declaration | Not skipped; open |
| `src/packaging/fyi-does-not-wake-a-seat.test.ts` | roster must know `ceo` and `liaison` | declaration | Not skipped; open |
| `src/packaging/worktree-owner.test.ts` | `HOME_CHECKOUT` as a git repo with a HEAD commit | project-content | Not guarded; open |
| `src/duplicate-row.test.ts` | tracked `docs/` (the 1603 section's record) | project-content | Classified pure by keyword pass; corrected here. Passes once the copy is committed |
| `src/packaging/host-install-agent-org-launcher.test.ts` | its own `host-units` fixture | pure | None needed |
| `src/packaging/acceptance-exit-code.test.ts` | tmp dirs; inert path strings | pure | None needed |
| `src/packaging/acceptance-prose.test.ts` | literals, injected `commandExists` | pure | None needed |
| `src/packaging/release-tag-on-merge.test.ts` | the tool's own checkout | pure | None needed |
| `src/packaging/wake-order-shape.test.ts` | tool source | pure | None needed |
| `src/tmp-fixtures-are-removed.test.ts` | the tool's own tests | pure | None needed |
| `src/packaging/queue-stalled.test.ts` | the tool's own script; git in the tool repo | pure | None needed |
| `src/packaging/pr-stall-reason.test.ts` | import-time `project.json` read in `work-gate.ts` | pure | None needed |
| `src/packaging/verdict-valid-while-patch-unchanged.test.ts` | the tool's own source | pure | None needed |
| `src/decision-run/classes/answer-owed.test.ts` | tmp dirs | pure | None needed |
| `src/work-gate-github-incident.test.ts` | none found | pure (keyword pass) | None needed |
| `src/work-gate-runner-start-red.test.ts` | none found | pure (keyword pass) | None needed |
| `src/work-gate-unordered-review-pr.test.ts` | none found | pure (keyword pass) | None needed |
| `src/pr-approved-not-counted-cause.test.ts` | none found | pure (keyword pass) | None needed |
| `src/work-gate-checkless-pr.test.ts` | none found | pure (keyword pass) | None needed |
| `src/work/gate/shared-file-orders-recheck-switch.test.ts` | none found | pure (keyword pass) | None needed |

Open, not done in this row:

- The five `Not guarded; open` project-content files above, and `ci-health-liveness`, `board-appendix-gate-record`, `worktree-owner`, and `row-claim-session-eligibility` 659. None is in the Acceptance's five files, so none is run here.
- The `declaration` rows marked `Not skipped; unverified` need a fixture `project.json` and a run to confirm.
- `acceptance-commands` (8 failing, runtime), `tracker-leak-refusal` (2, runtime), `live-tree-independence` (2, runtime; its only reader sits in the `UNCONVERTED_CONTROL` template literal, so the edit was reverted), and `late-edition` (1, `packages/cli/package.json`) are not skipped.

Incident. The whole-suite fixture run was started during measurement and was stopped. Before it stopped, it queued real handoff orders into the live herdr org session: IDs `c2036934`, `1516692d`, `cabdb946`, `fc954679`, `52694a80`, `db2bf7e4`, `99a0a706`, `503f5815`, and `55a766ed` (to reviewer-2754). Some were queued twice. The test file that triggered them is not identified. They are not retracted: retracting is destructive and awaits approval. No further suite-wide run, and no run of a wake, prompt-session, messaging, or runtime test, was done after it.

## Open

- The 188 unresolved subtests (43 files) need their test bodies read. The 43-file table above covers the files; the per-subtest decisions are row 5's, except the 1604 items listed under "Open, not done in this row".
- The configuration-3 role briefs came from a11ign, not from a fixture. Row 1 writes minimal fixture briefs and reruns to confirm the 22 files cleared here still clear.
- The 514 import-time refusals in configuration 1 are measured, but the fix (a root `.agent-org/project.json`) is a hypothesis until row 1 runs.
- The 14 "needs the real project / runtime" subtests and the 10 "tests the project" subtests are named but not decided. The decision is row 5's.
