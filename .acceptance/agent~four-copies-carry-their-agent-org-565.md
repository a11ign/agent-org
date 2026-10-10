Four declared copies in `src/lib/` carry the changes their a11ign originals took in #4654, #4713 and #4725, and their headers name the commit they were carried to. Comment lines and one `runNpm` call only; no import is added, and the installed `@a11ign/toolchain` (0.1.2, no `lib/`) is not asked for anything.

- `git-env.ts`: header at `c6560f915`; the one comment line now names `@a11ign/toolchain/lib/git-sandbox` (#4590).
- `isolation-gate.ts`: header at `7ed322a32`; #4654's six lines, verbatim, after `init -y` (`runNpm(["pkg", "set", "type=module"], consumer);` and its comment). The named count stays 71, measured below.
- `local-import-closure.ts`: header at `bb8dfa7fb`; the two comment lines now name `@a11ign/toolchain/lib/source-text` (#4713). "NOTHING but this header" stays true.
- `walk-scope.ts`: header at `bb8dfa7fb`; the static `walk-scope-declaration` and the dynamic `walk-scope-discovery` imports are NOT carried as toolchain imports (the copy keeps its sibling copies beside it) and are named in the header's list as the tool's own copies. Count 67 to 68: the static import is one new line with no counterpart; the dynamic one shares a line with the `ci-changed.ts` import the header already named.

**The row's premise held for three of four and not for `local-import-closure.ts`.** The row reads its original as moved by #4713 at `bb8dfa7fb`. At a11ign `origin/main` `138367cc8` the original does not exist: a11ign#4718 (`25f0e9b3e`) deleted `packages/guards/src/local-import-closure.ts` for `@a11ign/toolchain/lib/local-import-closure`. The carry is still right (the copy against `25f0e9b3e^`, the original's last content, differs in no body line: 0 only in the copy, 0 only in the original), and its header says the original is gone. org-health reads that copy as `could not be compared` and not `tripped`, which is why `copies-drifted` tripped on three and not four. The copy itself goes with agent-org#522.

Evidence, measured on this branch against a11ign `origin/main` `138367cc8` (`readDeclaredCopies({ root: <a11ign checkout>, toolRoot: <this worktree> })` then `copyDriftReading`):

Before (`HEAD` copies):
```
tripped | 3 declared copies drifted from the original: src/lib/git-env.ts ... 1 line(s) only in the copy, 1 only in the original, and its header names 0;
src/lib/isolation-gate.ts ... 22 line(s) only in the copy, 77 only in the original, and its header names 71;
src/lib/walk-scope.ts ... 44 line(s) only in the copy, 68 only in the original, and its header names 67
```
After (this branch): `git-env.ts` 0/0 allowed 0, `isolation-gate.ts` 22/71 allowed 71, `walk-scope.ts` 44/68 allowed 68, `local-import-closure.ts` original unreadable (deleted). None of the four is `drifted`. The signal as a whole reads `unknown` and not `clear` because eleven OTHER copies' originals were deleted by #4589, #4590 and #4718; that is agent-org#522's, as the row says.

`org-health-fleet-and-copies.test.ts` 18/18, `org-health.test.ts` 33/33, and the suites that import these modules pass. `tsc --noEmit` reports two errors, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` is not in the installed 0.1.2), a file this change does not touch.

The row's Acceptance names `cd /home/agent/repos/agent-org`, the primary checkout, which carries this change only after the merge; the same four checks run here, in this worktree:

Acceptance: `grep -q 'toolchain/lib/git-sandbox' src/lib/git-env.ts && ! grep -q 'at cd4bdb7dc' src/lib/git-env.ts && grep -q '"pkg", "set", "type=module"' src/lib/isolation-gate.ts && ! grep -q 'at f3b5c5f59' src/lib/isolation-gate.ts && grep -q 'toolchain/lib/source-text' src/lib/local-import-closure.ts && ! grep -q 'at cd4bdb7dc' src/lib/local-import-closure.ts && ! grep -q 'at 57bb9154a' src/lib/walk-scope.ts && grep -q 'walk-scope-declaration' src/lib/walk-scope.ts`

Closes #565

platform: n/a (header text and comments in declared copies; one `npm pkg set` call carried from the original)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
