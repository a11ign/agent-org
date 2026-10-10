`docs/verify-475-460.md` records the host readings left by agent-org#475 and agent-org#460: two of the five were taken and three are named as not taken, each with its reason. A docs-only change; no code is touched.

Closes a11ign/agent-org#758

## What changes, and why

- Adds `docs/verify-475-460.md`, the file the row names as the place the readings are recorded.
- #475, taken: `compact-store --dry-run` (995,745 lines, 995,745 distinct ids, 0 to remove, at 2026-10-10T20:33:20Z, receiver `active (running)` since 20:17:44Z), `compact-store` (`nothing to remove: the store was not rewritten and no backup was made`, 20:33:28Z) and the `uniq -d | wc -l` count (`0`, 20:33:31Z and again 20:34:42Z). The store had already been brought to one line per id before this row ran, so no compaction happened here and there is no backup name to quote; what compacted it is named as not established.
- #460, not taken: `agent-org worker:state done` (a `worker:*` command, which the engineer brief bans with no exception) and the live idle-without-declaration nudge or replay (the journal shows a nudge then a declaration six seconds later for worker-4765, but the nudge text is recorded nowhere and the two nudge forms share one journal key).

## How you verified it

```
$ bash -c 'test "$(jq -r .id ~/.cache/a11ign/trace/events.ndjson | sort | uniq -d | wc -l)" = 0'
(exit 0 at 2026-10-10T20:34Z)
```

Acceptance: `bash -c 'test "$(jq -r .id ~/.cache/a11ign/trace/events.ndjson | sort | uniq -d | wc -l)" = 0'`

Mutation: n/a -- a record of host readings, no guard changed. The negative half of the Done-when is read by hand: no line in the file claims a run the journal does not show (the three `done` declarations are named as written by other sessions and as not the row's reading).

## Anything a reviewer should be sceptical of

The Acceptance reads the live store, so it passes only on the agents host and says nothing about the readings' wording. Readings 4 and 5 stay open and are for a seat the engineer ban does not bind.
