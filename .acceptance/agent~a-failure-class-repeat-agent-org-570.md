A failure-class repeat row is the fix for its class, not an instance of it (a11ign/agent-org#570). `classRowArgv` filed it with `--label class:<id>` and `rowOf` counted every closed row carrying one, so closing the row that answered a repeat made it instance N+1, the newest, and the discriminator of the next `class-repeat` offer. The row is now filed without the label, and `rowOf` skips any closed row titled as the class row of some class, whatever labels the classifier (#4633) or a hand put on it. A genuine occurrence is counted exactly as before.

Closes a11ign/agent-org#570

## What changes, and why

- **`src/class-repeat.ts`.** `classRowArgv` drops `--label class:<id>`; `ROW_PROJECTION` carries `title`; `rowOf` skips a closed row whose title is `classRowTitle` of some class (`isClassRowTitle`, including a title cut at 120 characters by a long id). `fileOne` still makes the label: nothing applies it to the class row now, but `org-health`'s order tells a human to put it on a row, and `class-repeat-files-row.test.ts` pins the refusal of a label that cannot be made.
- **`src/packaging/class-repeat-fix-row-not-instance.test.ts`** (new): the three cases the row names, each with its positive control, and a title case (another id, a cut title, a genuine row with a nearby title).
- **`src/class-repeat-files-row.test.ts`** (outside the row's Region, two assertions): they pinned `--label class:x` and `--label class:main-red` on the filed row, which is the defect. They now assert no `--label`. The row's Acceptance names this file as one that "still passes", which cannot hold with its Change 1 and these assertions unchanged.
- **`.changeset/class-repeat-fix-row-not-instance.md`**.

## How you verified it

`AGENT_ORG_HOST` was set to the a11y-witness checkout's `.agent-org/host.json` (unset, the files report `0 of 0 tests`).

```
$ npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/class-repeat-fix-row-not-instance.test.ts
VERDICT pass: 5 tests in 1 file
$ npx rstest run --config scripts/rstest/rstest.config.ts --include src/class-repeat.test.ts
VERDICT pass: 20 tests in 1 file
$ npx rstest run --config scripts/rstest/rstest.config.ts --include src/class-repeat-files-row.test.ts
VERDICT pass: 15 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # only the two pre-existing mjs-ratchet.test.ts errors
```

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.ts --include src/packaging/class-repeat-fix-row-not-instance.test.ts`

Mutation: the title filter never fires -> 4 red (the count, the discriminator, the alone-row and the title cases); the filter fires on every titled row -> 5 red (the same four plus the argv case, whose group is then empty); the label put back on the class row -> 3 red (the new argv case and the two `files-row` assertions); a title cut at 120 characters not recognised -> 1 red (the title case). Each restore was byte-identical (`cmp`).

## Anything a reviewer should be sceptical of

- **Region.** The row's Region omits `src/class-repeat-files-row.test.ts`, which has to change (above). If `pr:open` refuses the diff for it, the Region needs amending, not the test.
- **A title is the only discriminator.** A hand-filed row given the class row's exact title is skipped too; that is the intended reading (it is the class row), and the title is `row-file`'s own dedupe key.
- **The label create stays.** Deleting `fileOne`'s `label create` would also drop the refusal path `class-repeat-files-row.test.ts` pins and leave `class:<id>` to be created by the first hand label; I kept it and said why in the comment.
