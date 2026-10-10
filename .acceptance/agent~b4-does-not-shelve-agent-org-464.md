B4 no longer shelves a row on a shared manifest alone. `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` at a repository's ROOT join the changesets in the exclusion (`src/row-claim/file-overlap-rule.ts`: one constant, `SHARED_MANIFESTS`, and `isExcludedFromOverlap` in place of `isChangeset` at the three places it was read: the asking row's Region in `fileOverlapReason`, the other pull request's files, and `regionEntriesOf`, the claimed-row reservation that shelved a11ign/a11ign#4442 and #4443). The match is the path at the root with a `<key>:` prefix stripped, so `packages/x/package.json` still collides, and a directory entry covering a manifest still meets the other row's entry.

The row's `.mjs` paths are `.ts` in this tree; the rule is `src/row-claim/file-overlap-rule.ts`.

Acceptance: `bash -c 'cd /home/agent/repos/wt-agent-org-464 && npx rstest run --config scripts/rstest/rstest.config.ts src/shared-manifest-overlap.test.ts src/claimed-region-overlap.test.ts src/packaging/row-claim-file-overlap-rule.test.ts'`

Mutation: the manifest exclusion removed (`isChangeset(path)` only) failed 9 of 11 in `shared-manifest-overlap.test.ts`; the manifest match taken on the basename, not the root, failed 2 of 11 (the `packages/x/package.json` case and its root control); every path excluded failed 10 of 11. `file-overlap-rule.ts` restored byte-identical each time (`diff` against a copy).

Measured: `VERDICT pass: 94 tests in 3 files` (11 new). `--changed=origin/main`: 5 of 808 tests fail in 265 files, all five in `src/wakes-per-row.test.ts`, which fails the same 5 of 42 on the unmodified rule file (`AGENT_ORG_HOST` unset in that environment). `tsc --noEmit` reports only `src/packaging/mjs-ratchet.test.ts`, which cannot resolve `@a11ign/toolchain/mjs-ratchet` in this install; none of the changed files appears.

Outside-Region: src/claimed-region-overlap.test.ts — (10)(3) and (10)(4) used `package.json` as the file two rows collide on; it is no longer compared, so they use `tsconfig.json`, and the prose-versus-fence reading they pin is unchanged.
Outside-Region: src/packaging/row-claim-file-overlap-rule.test.ts — the four #1419 tests named the root `package.json` as the row's file; they name `packages/cli/package.json`, which is in the same recorded list and still collides.

Not done here: `src/work-gate/shared-file-orders.ts` has its own `isChangeset` (the CEO's comment on the row, point 1). Whether it still orders the later pull request behind the earlier one for a shared root manifest is read after this merges; one follow-up row if it does.

Closes a11ign/agent-org#464

platform: n/a (a path comparison inside B4; GitHub, pnpm, systemd and git do not read a row's Region)

Net lines: positive, a constant and two one-line functions; the same exclusion is read at the three places, not a second regex.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
