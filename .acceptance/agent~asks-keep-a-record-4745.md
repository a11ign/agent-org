Asks keep a record, and the message is ticked and the pinned open list rewritten when the row's state changes. An ask is `{askId, messageRef, row, state, outcome}` written when it is first sent, keyed by its row; resolving it EDITS the original message to `✅ <outcome> — <first line>` and sends nothing; one pinned message lists the open asks and is edited only when the set changes. This is a11ign/a11ign#4745, row 3 of 5 of #928.

Closes a11ign/a11ign#4745

## What changes, and why

- **`asks.ts` (new, a leaf):** the fold of the ledger into asks (`foldAsks`), the ticked text, the list's text and fingerprint, and the effects over an injected provider (`createAsks`). A line from before this change carries no `askId` or `row`, so the fold derives them and an ask sent last week is ticked like one sent a minute ago.
- **`core.ts`:** an ask with no row is refused at send (`invalid`, naming why) unless its kind declares a `rowLess` reason (`stall` does); a `cleared` plan for an ask is `tickResolved` and sends nothing; the reminder plan is `none` (`listed`) for an ask; the tick ends with `syncList`.
- **`ledger.ts`:** statuses `edited` and `pinned`, the `asks-list` kind, and `deliveredTimestamps` skips an edited line, so a tick is not a delivery against the hourly cap.

## Judgement calls

- **Kept only where the provider can edit AND pin.** With neither, the old lifecycle is unchanged (a "Cleared:" message, reminders), because an ask that is neither ticked nor listed is visible only through its reminders. Six existing test files declare `edit: false, pin: false` for that reason: the fake provider declares both since #4744, and their assertions count messages on the wire.
- **The tick line is `sent` + `edited: true`, not a status of its own.** `readEpisodeStart`, `snoozedUntil` and `askCycles` all look for `status === "sent" && kind === "cleared"`; a new status would have made every ticked ask read as never cleared.
- **Every message of an ask is ticked,** not the latest: a changed brief is a message of its own, and an unticked one would read as open for ever.
- **A failed edit falls back to the old "Cleared:" send** once and writes a `failed` line, rather than retrying a deleted message every tick.
- **The list is sent silently and past the rate limiter** (then counted by `noteDelivered`): one message, and a held-back list is a list that lies. Its ages are true as of its header's time, since it is rewritten when the set changes and not on a clock.

## Known limits

- **The outcome is the first line of the resolved event's text** (`<repo>#n no longer needs you`): `event.ts` has no `outcome` field and is outside this row's Region.
- A walk's step messages (`direction: "walk"`) are not ticked.
- A pin that keeps failing is retried each tick, as a failed line each time.
- Done-when 2 (a live ask quoted on #928 before and after its row resolves) is a live reading and is not made here.

## Files outside the row's Region

The five test files below changed only to declare `edit: false, pin: false` on their provider (and, in `audience.test.ts`, to give a request's key a row): `audience.test.ts`, `core.test.ts`, `sources/requests.test.ts`, `sources/stall.test.ts`, `watch-buttons.test.ts`, and, found by the merge queue's run against a newer `main`, `decision-confidence-post.test.ts` (#4755's control declares the `summary` kind an ask, which now needs a `rowLess` reason, and runs without the asks' record so its request count is the reading's alone). They could not stay green otherwise.

## How you verified it

Run with `AGENT_ORG_HOST` set (this worktree holds no `.agent-org/project.json`). Measured at this head, rebased on `origin/main`:

- The Acceptance: all pass.
- `src/messaging`, the whole directory: all pass.
- The whole suite fails the same 34 tests as `origin/main` (compared by name).
- `tsc --noEmit`: only the two `mjs-ratchet.test.ts` errors that `origin/main` has too.

Acceptance: `bash -c 'cd /home/agent/repos/agent-org-wt-4745 && AGENT_ORG_HOST=/home/agent/repos/wt-4745/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/messaging/asks.test.ts src/messaging/core.test.ts'`

Mutation: the tick replaced by a send -> 5 red; the list rewritten every tick -> 3 red; the reminder guard removed -> 2 red; a row-less ask accepted -> 1 red; the episode count restarted at one -> 1 red (needs three episodes, a second alone is masked by the core's own count); the list pinned on every sync -> 2 red; the in-place tick skipped in the core -> 6 red. Each restored byte-identical (`diff` against a copy taken before) and green.
