The org side runs a project's tree-wide guards on an agent pull request, and the verdict gates arming; the guards a11ign's `guardSweep` runs are sorted below (a11ign/agent-org#1503, receiving side of a11ign#5460, ADR 0045 cut c).

Acceptance:
```bash
node --test src/lib/tree-wide-guard.test.ts
```

Measured: the command above printed `ℹ tests 7 / ℹ pass 7 / ℹ fail 0` at this head (`(1503 a)` to `(1503 f)` with `c2`). `pnpm run typecheck` exits 0. `pnpm test` printed `VERDICT fail: 113 of 11796 tests failed in 708 files`; the baseline before this change printed `113 of 11795` (one more test: `c2`), and the failing-test lines are identical (`diff` of the sorted failure lines of both logs is empty; the 27 failing files run on `HEAD`'s versions of the three changed source files gave the same names). They are the environment's (`Cannot find module 'tsx/package.json'`, the `@@eventsPort@@` placeholder, red-order tests); none is in a file this change touches.

Mutation: each applied to one file, run over `tree-wide-guard.test.ts`, restored from a copy and compared byte-identical. A file never declares: `(1503 a)`, `b` go red. A file always declares: `a`, `b`. Import alone declares: `a`, `b`. A file that ran nothing passes under `node --test`: `c`. No VERDICT line passes under rstest: `c2`. Fewer files than asked passes: `c2`. The project's rstest config ignored: `c2`. Tokens passed on to the run: `c`. Floor of 0 files: `d`. No eligibility check: `d`. Checkout not released: `d`. Heads not compared: `e`. A refusal ignored in `firstRefusalOf`: `e`, `f`.

REAL-TREE READING (measured, NOT a pull request): `treeWideGuardVerdict` with `treeWideGuardFilesIn` and `runTreeWideGuards` over a clone of a11ign `origin/main` at `a738173781f7a2941863f1376e4ac31e0f01e5cb` (offline frozen install) discovered 5 files and printed `{"kind":"pass","why":"5 tree-wide guard file(s) passed at a7381737 (48 tests)"}` in 6 seconds. The first reading under `node --test` FAILED on `criteria-counts-are-not-spelled-out.test.ts` (`./coverage.js` resolves only under the runner's resolver), which is why the run goes through the project's rstest config.

THE SORT (the list the row's open-check names). Re-derived from a11ign `.github/workflows/ci.yml` (`guardSweep` runs `pnpm run guards:sweep`, `packages/guards/src/tree-wide-guards.ts` | `assert-glob-not-empty.ts`) at `a73817378`: the population is the tracked `*.test.ts` that import the marker AND call `declareTreeWideGuard(`, comment-stripped. A loose `git grep` finds 6 files; the discovery finds **5** (`lab-delete.test.ts` only spells the marker inside string fixtures). The plan's "~24" is not what runs today.

| guard file (a11ign) | what it reads | sort |
| --- | --- | --- |
| `packages/guards/src/entry-points.test.ts` | the product's own entry points | product invariant: plain `ts` test (marker dropped) or ESLint rule |
| `packages/judge/src/criteria-counts-are-not-spelled-out.test.ts` | prose/source in the judge package | product invariant: plain `ts` test or ESLint rule |
| `packages/guards/src/layer-edges.test.ts` | `LAYER_PACKAGES` = nvda-worker, nvda-speech, agent-org, worker-fleet, lab, control: none exists in `packages/` (cli, evidence, guards, judge, scorer) | dead: delete |
| `packages/guards/src/lab-delete.test.ts` | tombstone for a departed `lab` directory; claim 7 reads the sweep's own discovery | dead: delete |
| `packages/guards/src/tracked-prose-leak-guard.test.ts` | tracked prose for leaked internals | org-side check on agent pull requests (this row's build) |
| `packages/guards/src/tracked-source-leak-guard.test.ts` | tracked source for the same | org-side check on agent pull requests (this row's build) |

The org-side check names no a11ign file: it runs whatever a project still marks. The a11ign rows, one per family, are filed `ready` by this session: product invariants a11ign/a11ign#5560 (drop the marker; both stay `ts` tests), dead a11ign/a11ign#5561 (delete both files). The two leak guards need no a11ign row: they stay marked and the org side runs them. The `ts` job already runs all of these files when TypeScript changed; the sweep's unique value was the docs-only pull request where `ts` is skipped, which the org-side run now covers for agent pull requests.

Outside-Region: `src/work-gate/tick.ts` (the arming decision is `readArmingOf`/`settleUnarmedPrs` there; `gateUnarmedOnAcceptance` gains the second family and the switch `A11IGN_PR_TREE_WIDE_GUARDS_BY_GATE`) and the new `src/lib/tree-wide-guard-org-side.ts` (tick must load with no `node_modules`, `work-gate.test.ts` #2174, and `./tree-wide-guard.ts` re-exports a bare specifier). The Region's `src/lib/tree-wide-guard.ts` gets a header comment only. `.changeset/` carries the release note.

Not done: (a) Done-when is NOT met: no run against a real a11ign agent pull request. a11ign has no open agent pull request at this time (only dependabot #5528) and the merge refs of merged ones are gone; the reading above is a worktree of `origin/main`, labelled so. The run against a real pull request, and its naming on a11ign#5460, is left open on the row. (b) The switch is off by default; turning it on in the live tick is the host owner's, so merging this changes no live behaviour. (c) `src/lib/tree-wide-guard.ts` and the `./tree-wide-guard` export are NOT deleted: a11ign's pinned tool still resolves `agent-org/tree-wide-guard`; deleting it follows a11ign's half (removing `guardSweep` from `gate` `needs`, which waits on this row merging). (d) The org's required `process` status is chairman's word (plan section 6 decision 1); not touched. (e) The 113 baseline failures are not this row's.

platform: GitHub's `refs/pull/<n>/merge` and `isCrossRepository` are used as given, as in #1502; nothing re-derives either.

Consumer-declaration: none -- the marker's export is unchanged and the new gate is off unless the host sets the variable.
