`releaseStats` (`src/org-retro.ts`) counts as a voiding only the reasons that are a claim that stopped moving (`stalled`, `gone`), and reports `closed`, `blocked` and `wait` beside them as `otherReleases`; `merged` stays unreported. `RELEASE_REASON_KINDS` classifies every reason, and the test parses the `why` union of `ReleaseRequest` so an unclassified new reason fails.

Acceptance: `node --import tsx --test src/org-retro-release-reasons.test.ts`

Mutation: `stalled` classified `released` failed 2 of 4 tests (the one-line-per-reason fixture and the stalled-counts-1); `closed` and `blocked` classified `voiding` failed those two plus the retro report tests in `org-retro.test.ts`; `wait` removed from the classification failed the union-coverage test plus those two. `org-retro.ts` restored byte-identical each time (`diff` against a copy).

Measured: `src/org-retro-release-reasons.test.ts` with `src/packaging/org-retro.test.ts`: 37 pass, 0 fail. `eslint` could not run (no eslint config reachable in this worktree) and `tsc --noEmit` shows nothing in `org-retro*`.

Not here: `src/packaging/org-retro.test.ts` (outside the Region) had two assertions pinning the old count (`voided: 3` with `blocked x1`, and the rendered line) and is updated to the new numbers, since the change would otherwise break it.

Closes a11ign/a11ign#4689
