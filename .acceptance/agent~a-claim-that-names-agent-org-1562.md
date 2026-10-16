A claim that names the wrong tracker for a row number is now refused with the way out, and the 404 refusal names the other trackers. `trackerFor` names the declared key when an undeclared key is a declared repository's `owner/repo`, its name, or its owner; when the owner owns two declared repositories, both are listed and neither is picked. `fetchLabels` adds a second line to a refusal on a gh 404 only: the number is not in that tracker, and the other declared trackers are named. A rate limit or an outage gets no such line. The first line of the ledger entry, the cause, is unchanged.

The kind of the 404 is decided here and does not move: it stays `claim-refused`, because GitHub also answers 404 for a repository a token cannot see, so the refusal says both readings. The undeclared-key refusal also stays `claim-refused`.

Tests: `src/row-claim-tracker-hint.test.ts` (new, 9 tests: cases 1, 1b, 2, 3, 4, 4b, 5, 6, 7). Cases 5 and 6 are negative controls. The existing `src/row-claim-refusal-kind.test.ts` is run unchanged.

Mutation: the owner/name match dropped from `undeclaredKeyHint` -> 3 red (cases 1, 1b, 3); the 404 hint always on -> 1 red (case 5, the rate-limit control); the 404 hint never on -> 2 red (cases 4, 4b). Each mutated file was restored byte-identical from a scratchpad copy. Positive control: `origin/main`'s `src/row-claim.ts` swapped in -> 6 of 9 red (cases 1, 1b, 2, 3, 4, 4b); cases 5, 6 and 7 pass there, as the controls should.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/row-claim-tracker-hint.test.ts src/row-claim-refusal-kind.test.ts`
