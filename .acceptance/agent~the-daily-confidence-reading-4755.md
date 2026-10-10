`src/decision-confidence-post.ts` posts the provider-confidence reading (#4748) once a day as an ANNOUNCEMENT: to the announcements channel when `messaging.announcementsFile` is declared, to the chairman chat when only that is configured, and as one comment on a11ign/a11ign#4627 when no messaging is configured. It asks the chairman nothing, posts nothing with no provider declared, and posts once per UTC day.

Closes a11ign/a11ign#4755

## What changes, and why

- **`renderConfidencePost(reading)` (new, pure).** One short message: per use and question the decisions asked, the share under the floor, the mean and median (and the other fall-backs when there are any), the questions over #4750's line, and `Told, not asked: nothing here needs an answer.` A quiet day is the same shape and says `no provider decisions in the window`. Every `?` is removed from the final text, so a question named with one cannot turn an announcement into an ask.
- **`postConfidenceReading({ reading, providerDeclared, delivery, now })` (new).** `delivery` is `messenger` (a provider and the ledger; the kind's declared audience routes it, so the channel and the chairman chat are the PROVIDER's answer, read off the ledger line and not decided again here) or `tracker` (the epic comment). The announcement declaration is `CONFIDENCE_CONFIG`, in the file, riding the existing silent `summary` kind: a kind of its own is `event.ts`, `core.ts` and `audience.test.ts`, outside this row's Region.
- **One post per day.** Messenger: the key is `summary:provider-confidence:<UTC day>` and the ledger dedupes it. Epic: the day's `<!-- decision-confidence-post: <day> -->` comment is asked for first (`postDaysTable`'s shape), so nothing is kept locally to disagree with the row.
- **No provider: nothing at all**, not even a resolved delivery. A host declaration or messaging configuration that cannot be READ exits 2 `CANNOT POST` and is not taken for "none".
- **The CLI** `node src/decision-confidence-post.ts [--log=<path>]` prints `posted: <destination> <ref>`, which is what done-when 2 quotes. It is idempotent per day, so a tick may run it.
- **#4750's line is a copy** (`LOW_CONFIDENCE_LINE`: more than 30% of at least 20), because `provider-low-confidence.ts` is not merged; the file says to import it when it is.

## Platform first, deleting first

platform: GitHub is the state for the epic comment (the day's marker comment is asked for, nothing kept locally) and the messaging ledger already dedupes the channel post; no new store. Net lines: positive, a new module and its test; nothing it replaces.

## Found on the way, and filed

`messaging:watch`'s `telegramProvider` never passes `announcementsChatId`, so in production the channel is unreachable for every announcement, not only this one: a11ign/agent-org#603 (ready, lane:any). This module's CLI reads the channel id itself, and that row deletes the copy.

## How you verified it

```
$ npx rstest run --config scripts/rstest/rstest.config.ts src/decision-confidence-post.test.ts
VERDICT pass: 13 tests in 1 file
$ npx tsc --noEmit -p tsconfig.json     # no error in decision-confidence-post*
```

The whole suite with `AGENT_ORG_HOST=<a host file>` set: 34 failed of 8143 tests (the report names 20 of them, all in 8 files, none of them these two). **Those 8 files re-run with these two files moved aside fail 19 of 145 with the identical test names**, so none is this diff's. (Measured, not inferred: both runs are in this session. A first run set `AGENT_ORG_HOST` to a directory, which the tool refuses at import, and is not the reading above.)

Not run, and why: the CLI against the live host. It posts to the chairman's channel or to #4627, which is the done-when's act after a release, not a development check.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/decision-confidence-post.test.ts`

Mutation: channel kind declared `ask` -> 2 red (the channel destination and the control); provider guard never firing -> 1 red (no-provider); always firing -> 8 red (every post); epic day-ask never finding the day -> 1 red; always finding it -> 2 red; messenger key without the day -> 1 red; `?` removal dropped -> 1 red; line edge `>=` -> 1 red; `minDecisions` edge `>` -> 1 red. Each restored byte-identical (`diff`).

## Anything a reviewer should be sceptical of

- The row's command is `cd /home/agent/repos/agent-org && ...`; that checkout is a release older than this change and has no such file, so the command is run from the worktree.
- `summary` as the kind is a choice made by the Region: it is silent and never reminded, which is right for a reading, and it shares the kind's `summary:` key prefix with the daily summary (the keys differ, `summary:provider-confidence:<day>` against `summary:<date>`).
- The CLI is not exercised by a test: its pieces are (`postConfidenceReading`, `renderConfidencePost`), and the provider and config reads are the same calls `messaging:watch` makes.
