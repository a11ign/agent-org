`src/lib/walk-scope.ts` carries the one hunk its a11ign original took after `bb8dfa7fb`: a11ign#4848's PR #4855 (`42cfb887d`) gave `NOT_WRAPPED.test` two entries for the names Node 24 added to `node:test`, `expectFailure` and `getTestContext`, and the header now names `42cfb887d`. The two strings are copied verbatim; the hunk adds no import and removes none, so the header's named-line list is unchanged.

**The named count stays 68, and it is a ceiling that was not touched.** The hunk is mirrored line for line, so every line count between the original and the copy is the same before and after: measured with `diff` of the original's body against the copy's body, 71 only in the original and 46 only in the copy at `bb8dfa7fb`/old copy and 71/46 at `42cfb887d`/this copy. The detector's own reading moved from 46/74 to not-named (below).

Evidence, measured on this branch against a11ign checkout `adcc8fc74` (`readDeclaredCopies({ root: <a11ign checkout>, toolRoot: <this worktree> })` then `copyDriftReading`):

Before (`origin/main` copy):
```
tripped | 1 declared copy drifted from the original: src/lib/walk-scope.ts against packages/guards/src/walk-scope.ts: 46 line(s) only in the copy, 74 only in the original, and its header names 68
```
After (this branch): `status: "unknown"`, `11 declared copy(ies) could not be compared` (its first named: `src/lib/fixture-symbols.ts`, `scripts/fixture-symbols.ts could not be read`; unreadable originals are agent-org#522's, not this row's); `walk-scope.ts` is not named and nothing is `tripped`.

The module still loads and `NOT_WRAPPED.test` is frozen with 13 entries, `expectFailure` and `getTestContext` among them. `tsc --noEmit` reports the same two errors as before, both in `src/packaging/mjs-ratchet.test.ts` (`@a11ign/toolchain/mjs-ratchet` is not in the installed toolchain), a file this change does not touch. `rstest run --changed origin/main`: 52 of 53 pass; the one failure, `pr-template-acceptance.test.ts` "guidance sits ABOVE the header", fails identically on the `origin/main` copy and is the test reading a11ign's PR template because the run set `AGENT_ORG_HOST` to the a11ign checkout.

The row's Acceptance names `cd /home/agent/repos/agent-org`, the primary checkout, which carries this change only after the merge; the same four checks run here, in this worktree:

Acceptance: `grep -q 'expectFailure' src/lib/walk-scope.ts && grep -q 'getTestContext' src/lib/walk-scope.ts && ! grep -q 'at bb8dfa7fb' src/lib/walk-scope.ts && grep -q 'at 42cfb887d' src/lib/walk-scope.ts`

Closes a11ign/agent-org#691

platform: n/a (a declared copy follows its original; one frozen object literal carried verbatim)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
