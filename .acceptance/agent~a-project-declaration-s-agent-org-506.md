A project declaration's `dora` entry may now carry `adopterDocs`: path prefixes an outside adopter reads that ship no code (`README.md`, `RELEASE.md`, `docs/try-it.md`). They count as adopter-facing for the PRIMARY milestone and for nothing else (a11ign/a11ign#4084; `ceo` ruled NO to widening `releasablePaths`, which also decides which pull request owes a version).

- `src/project-config.ts`: `DoraRepository` gains `adopterDocs?: string[]`, parsed by `readAdopterDocs` beside `readAdopterFacing`. Absent stays absent (no key is added). A non-list, an empty list, or an empty or non-string member is refused with a `ProjectDeclarationRefusal` naming `dora[i].adopterDocs`, and so is naming it on an entry declared `adopterFacing: false`.
- `src/work-gate/org-health.ts`: `adopterRowKind` returns `adopter` for a Region with ONE entry that is either what it returned before OR under an `adopterDocs` prefix of an adopter-facing repository. The prefixes go through the same `productRegionsOf` (as that repository's paths), so which repositories are adopter-facing (the tool's, `adopterFacing: false`) is still decided in one place and `regionCovers` is the one prefix rule. The `because` text of a row that is still org is unchanged. `row-file`'s `primaryMilestoneRefusal` and `milestoneClockFact` follow without an edit; the test proves it.
- `src/packaging/adopter-docs.test.ts` (new, 10 tests): each case beside its positive control, and a pin that `dora.ts`, `release-behind-main.ts` and `work-gate.ts` never mention `adopterDocs` (with a control that the marker does find the one reader).
- `.changeset/adopter-docs-primary-milestone.md`: `"agent-org": minor`. DORMANT until a `dora` entry names the key; a11ign/a11ign's own declaration is the next row, filed after this merges.

**The 60% product share is unchanged by choice.** `ceo`'s ruling scopes `adopterDocs` to the primary milestone, so `productRegionsOf` is not widened (the test asserts it `deepEqual` with and without the key). If `ceo` wants the share to follow, it is one line in `productRegionsOf` and a separate row.

Left open: the row's Done-when 2 (a release tagged after the merge) is the release workflow's, after this merges.

platform: n/a (a parsed key and one branch in a decision the repository already owns; nothing a platform feature does)

Net lines: positive, about 25 non-test lines (a parser and one branch) and a test file; nothing in an existing function was copied.

## Acceptance

```bash
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/adopter-docs.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/primary-milestone-adopter-rows.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/product-share-adopter-facing.test.ts
npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/project-config.test.ts
```

Run in this worktree with `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json` (without it every test that loads the home declaration is refused, including these on a clean `main`). Printed: `VERDICT pass: 10 tests in 1 file` (adopter-docs; it does not exist at `origin/main`), `pass: 15 tests` (primary-milestone-adopter-rows), `pass: 7 tests` (product-share-adopter-facing), `pass: 15 tests` (project-config).

## Mutation

Each turned its own named cases red and was restored byte-identical (`diff` against a saved copy):
- `adopterRowKind` never reads `adopterDocs` (never fires): 5 of 10 red, the "adopter with it" cases, the refusal, the clock and the end-to-end case.
- `adopterRowKind` calls every docs-only row adopter (always fires): 6 red, each CONTROL ("org without the key").
- the releasable decision in `dora.ts` also reads `adopterDocs`: 2 red (`isReleasable`/`isShipped` agree, and the one-reader pin).
- `productRegionsOf` also reads `adopterDocs`: 2 red (the share is `deepEqual`, and the one-reader pin).
- the parser accepts `adopterDocs` on an `adopterFacing: false` entry: 2 red. The parser adds the key when absent: 1 red. The parser accepts an empty list: 1 red.

## Evidence

- `rstest run --changed=origin/main` (388 files): 34 of 7466 tests fail, in 11 files (`board-truth-audit`, `failure-ledger`, `auto-arm-token`, `milestone-clock`, `milestone-clock-exact-start`, `pr-template-acceptance`, `public-claim`, `row-file-refuses-duplicate-title`, `row-file`, `tick-heartbeat-is-written`, `wake-engineer-brief`). Measured: the same 11 files, run on a clean detached `origin/main` (`5f4b499`), fail the same 34 tests by name, so this change adds none. They are not mine to fix here and I did not look into why they fail.
- `tsc --noEmit`: the only errors are the two in `src/packaging/mjs-ratchet.test.ts` (an unresolved `@a11ign/toolchain/mjs-ratchet` import), a file this change does not touch. Not compared against a clean tree.
- No `.mjs` is touched. Lint was not run (this repository has no `lint` script); `pnpm run verify` does not exist here (`no-verify`).

Closes a11ign/agent-org#506

Outside-Region: src/work-gate/org-health.ts — the row's Region names `src/work-gate/org-health.mjs`, which is `org-health.ts` in this tree since #4389; it is the file `adopterRowKind` lives in.
