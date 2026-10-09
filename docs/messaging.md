# Chairman messaging

How the organisation tells its chairman things, and (in later stages) how the chairman answers, over a chat provider. Telegram is
the first. **This is the design as the chairman decided it (2026-10-01, `a11ign/a11ign#2899`) and the limits it states about
itself, as amended by the chairman's direction of 2026-10-04 (`a11ign/a11ign#3409`): the chairman talks to a session whose only job is the chat, the
liaison, and not to `ceo`.** The build is thirteen rows and then nineteen more under #3409; this document says at the end what exists so far.

The repository is public. Nothing in this document, the code or its tests may carry a token, a chat id or a user id: those are
read from files on the host, by reference (decision 1, "Secret by reference only").

## Decision 1. A provider-free core, and optional providers

`src/messaging/` is a **leaf**: it imports nothing from the tool and reads no project checkout, so its tests (`*.test.mjs`, on
`node:test`) run in this repository's own `gate`, which cannot run the tool's suite (it needs a project checkout, ADR 0040
decision 8).

- **Event** = `{ key, kind, severity, firstSeenAt, text, links, resolved? }`. `key` is the stable identity of the thing
  (`request:a11ign/a11ign#2885`, `incident:trunk-red`, `stall:no-merge`, `summary:2026-10-02`). **Dedupe is by key, never by
  text**, so a tick that re-observes the same fact sends nothing. One optional field is added: `state`, the watcher's declaration of
  what "the state" of the fact is, which is what a reminder's "until the state changes" compares.
- **Lifecycle:** observed -> (hold-down: incidents wait **30 minutes**, unresolved) -> sent -> (resolved: ONE "cleared" message if
  the original was sent). Requests send at once. **Reminders:** at most 3, 24 h apart (the measured defect: a `needs:chairman` row
  asked 19 times in a day), then silence until the state changes. All the numbers are config, with these defaults.
- **Rate limit**, in the core, from the provider's declared capability (Telegram: about one message a second per chat): a token
  bucket, plus an hourly cap (default 12) whose overflow collapses into ONE digest line, never a drop.
- **Delivery log:** append-only JSONL, one line per attempt `{ ts, key, provider, status, providerMessageId, error }`, and a `sent` line adds `silent`: the flag the provider APPLIED (`null` when it returned none; lines written before this field carry none). Error text
  is passed through the secret redactor first. Inbound lines (stages 2 and 3) go in the same file as
  `{ ts, direction: "in", updateId, verdict, reason }`, **with content stored as a length and a sha256, never the text** (a dropped
  message is attacker-chosen text).
- **Provider interface (small):** `{ id, capabilities: { silent, buttons, replies, conversation, maxText }, send({ text, silent,
  actions, replyTo }) -> { messageRef }, poll?(cursor, signal) -> { updates, cursor } }`. One exported `runProviderConformance(provider)`;
  **every provider's own test calls it**, and it is the only definition of "a provider".
- **Optional and off by default:** the `messaging` key in `.agent-org/project.json` (`provider`, `tokenFile`, `chairmanFile`,
  `summary: { at: "08:00", timezone: "Europe/London" }`), read like `causes`. **Absent means nothing is constructed, no unit is
  installed and `host:check` is silent.** **The daily summary is opt-in and OFF** (chairman, 2026-10-04, `a11ign/a11ign#3410`: he does not want a daily
  message): an absent `summary` key is no summary at all, and a PRESENT one (`summary: {}` is enough) keeps the 08:00 London defaults. A summary that is
  declared is idempotent per LOCAL date (DST-correct, via `Intl`) and is sent silent.
- **Secret by reference only:** `tokenFile` names a file under `~/.config/agent-org/`. The reader refuses a file that is not mode
  0600 or not owned by the running user, never puts the token in argv, env, a unit file or a log, and **redacts the Telegram URL
  (`/bot<token>/`) from every error it surfaces** (a failed `fetch` quotes it). The chairman's Telegram user id and chat id are not
  secrets but are personal data in a public repository: they live in `chairmanFile` (0600), written by a **pairing command**. The
  chairman runs `messaging:pair` in their own shell, the host prints a one-time code, they send `/pair <code>` to the bot within 10
  minutes, and the bot records the first sender that proves it. Nobody types an id into a repository.
- **Long polling (`getUpdates`), no inbound port**, one listener process under a single-instance lock (a second poller gets
  `409 Conflict`), the offset persisted after each accepted batch.
- **No quiet hours.** The summary, where one is declared, is the only silent message.

## Decision 2. Two-way, "done right", each point a test

- **(a) Identity.** `acceptUpdate` accepts only `from.id == chairman.userId AND chat.id == chairman.chatId AND chat.type ==
  "private"`, for messages and button presses alike. Edits, forwards, group events and everything else are DROPPED and logged
  (reason, ids, length, hash). The bot leaves any chat that is not theirs.
- **(b) Chairman -> the liaison only; the liaison -> `ceo` only through `prompt:session`** (the first reading was "chairman -> `ceo` only";
  `a11ign/a11ign#3416` and #3409 replaced it). An accepted message is queued for the `liaison` through the existing `prompt:session` queue, with a sender
  the listener alone supplies (`chairman via Telegram`); `resolveSender` derives every other sender from a workspace id, so no agent
  session can produce it. **The liaison reaches `ceo` in one way**: `chairman:ask-ceo`, which runs `prompt:session ceo --needs-decision` and refuses a
  question that names nothing that clears it (below). **One exception, and it is the chairman's (2026-10-04, `a11ign/a11ign#3538`): a message the
  liaison's queue refuses (the seat is not running, its inbox is full) is passed to `ceo` and the chairman is told so in plain words, because his message
  is never dropped.** `converse.mjs` holds the two recipients as constants, and a test scans every file under `src/messaging/` for a second caller of the queue.
  **There is no code path from a chat message to a worker.** `createInbound(...).handle` forwards a value branded with a
  module-private symbol (after the classifier, for the configured chairman), and the only function that writes a chairman-attributed
  row comment accepts nothing else.
- **(c) GitHub is the record.** A button press or reply to a request writes a row comment quoting it with provenance (Telegram
  message ref, time, "verified id"), removes `needs:chairman` (taking the label off IS the act of answering) and sets `answer:ceo`,
  so `ceo` is woken with the answer as data. **A conversational answer or correction is recorded on its row by the liaison** (`chairman:record`,
  `chairman:correct`), in its own name and never the chairman's: the comment says `Recorded by liaison from the chairman's message <ref>; not written by the
  chairman`, and the provenance line above is written by the listener alone. A ruling `ceo` makes is recorded by `ceo` on the row it concerns before it acts.
- **(d) Never from chat: credentials, secrets, deletions, money.** Inbound text is classified before anything is forwarded.
  Secret-shaped strings (the leak-scan patterns plus key, token and password shapes) are DROPPED, `deleteMessage` is attempted, and
  the bot replies that it does not take credentials in chat and where to put one. Deletion verbs on a repository, branch, row, data
  or file, and spending (purchase, subscribe, plan, an amount), are refused with the same one-line reply and not forwarded. **A
  classifier has false negatives, so it is the first of three layers, not the guarantee:** the second is `ceo`'s brief, the third
  is that the outbound path can carry only checked facts (next).
- **(e) Answers are facts, checked before they are sent.** `chairman:reply` takes text containing **placeholders from a closed
  vocabulary** (`{{issue:2885.labels}}`, `{{pr:2881.state}}`, `{{run:36891064128.status}}` (and `.conclusion`, once the run has one), `{{ready.count}}`, `{{open.count}}`,
  `{{last-merge.age}}`, `{{unit:work-tick.state}}`, and a verbatim quote of a row comment with its link). **The core re-reads each at
  send time and stamps the message "as of HH:MMZ"**. A read that fails REFUSES the send and tells `ceo` which, and "I could not check
  X" is itself sendable. A `#<number>`, a state word (merged, green, red, passing, failed) or a count outside a placeholder is
  refused, so an unchecked claim cannot ride in free text. Opinion goes under an explicit "My read:" line.

## Decision 3. Stages, each usable on its own

**S1 notify** (rows 1-6): one-way; the chairman sees requests, stalls, incidents and the summary. **S2 answer** (rows 7-9, 13):
buttons and replies resolve requests on their rows. **S3 conversation** (rows 10-12): free messages to the liaison (and, when its queue refuses, `ceo`) and checked replies.

## Decision 4. The liaison: the chairman talks to a session whose only job is the chat (chairman, 2026-10-04, `a11ign/a11ign#3409`)

His words: *"sending tickets isn't really ideal because it's a waste of my energy having to go into the ticket and read the whole ticket ... I'd rather it was more of
a conversation and explained what's needed from me"*, and *"a lot of the time things are incorrectly labelled, and I need a back-and-forth."* `ceo` is cleared before
each order (`clearBeforeOrder`), so it could not keep a conversation; the liaison is the session that can.

**The seat.** `liaison` is a persistent role (`"persistent": true` in `.agent-org/roles/sessions.json`, brief `.agent-org/roles/liaison.md`, both in `a11ign/a11ign`; B1 and B5): the tick never clears it and compacts
it when its window fills. It reports to `ceo`, is never offered work, claims no row, and runs nothing that reaches the fleet or the lab. A summary of a conversation is not a citation, so
after a compaction everything it believes about the organisation is a belief until it re-reads it that turn.

**Its duties are six, and the brief lists each:** answer from facts it checked this turn; say when it is unsure; follow up when a watched thing changes; ask `ceo` for a ruling and relay the
answer in the chairman's words; record what the chairman said and take his corrections back to the rows; keep him posted on a thing until it ends. **It decides nothing and never acts as the
chairman.** The listener, not the liaison, acknowledges every message at once and in words (B2), with no model in the path, so the chairman hears "Got it" at the speed of a poll; the liaison's
turn is the answer.

**Two closed sets of commands, and nothing else.** A command that is absent or refuses is reported to the chairman as that, and a `gh` comment is not a substitute, because the command is what ties
a write to a real message.

| Set | Commands | What it may do | Where it is described |
|---|---|---|---|
| **B4: what it writes to a row, or asks `ceo`** | `chairman:record`, `chairman:correct`, `chairman:ask-ceo` | `record` quotes his words on a row, in the liaison's name, with `--message=<ref>` an accepted inbound line whose words hash to the receipt's. `correct` is a CLOSED set of three verbs: `withdraw` (the row stops asking him: `needs:chairman` is the only label it removes), `reroute` (sets `answer:product-manager`, nothing else) and `re-ask` (a new brief). `ask-ceo` asks for a ruling and refuses a question that names no `Waiting-for:` condition the gate reads. | "The liaison's commands", below |
| **D1: what it asks of the chairman's OWN session** | `chairman:queue add` (the org's side); `list`, `take`, `done` (his session's side) | A one-line ask (what, why, the result wanted) for a session only a human runs, written after his OK is verified as `record` verifies one. **There is no executor**: nothing in `src/messaging/` that touches the queue file may spawn a process, and the org never holds the credential the act needs. | "`chairman:queue`", below |

The rest of what it does is read-only or already checked: `chairman:reply` (every fact is a placeholder the core re-reads at send time, stamped "as of HH:MMZ"), `chairman:watch` (the ledger is the
watch list; a watch ends when its final state has been TOLD) and `messaging:measure` (time to acknowledge and to answer, asks sent, answered and withdrawn, and hand-fixes by the chairman's session).

### What the chairman sees, and the buttons (C1, `a11ign/a11ign#3423`)

Outbound is a message when something happens, and no more: a **need**, written as a BRIEF (what is happening, why only he can do it, the steps, what comes back, the link LAST; A2), a **release**
shipped (A3), an **incident or stall** starting and clearing with its impact and what is being done (A6), a **milestone** the project declared (A4, A8) and a **watch-list item** (A5). Not merges, audits or
label changes. Plain English and short.

A message that asks for something carries inline buttons, drawn by the Telegram provider as `reply_markup.inline_keyboard` (before C1 the provider declared `buttons: false` and drew none). **The vocabulary is
closed**: `ans:<option id>` (one of the options the brief offered) or `act:<word>` for `approve`, `done`, `stuck`, `later`, `explain` and `forme`; any other `callback_data` is dropped as
`unknown-callback-data` and never forwarded. A press is routed by the ledger-known message it sits under, never by the data:

| Button | What it does |
|---|---|
| An option, **Approve**, **Done** | resolves the request on its row (decision 2(c)): comment, then `needs:chairman` off, then `answer:ceo` on |
| **Later** | snoozes the request's reminders for 24 hours; the label stays, so it is not an answer |
| **Explain more**, **Stuck** | each queues ONE order for the liaison, who answers in the chat |
| **Do it for me** | drawn only under a brief that names the act in a `Do it for me: <the act>` line (the alert shows it); writes ONE ledger line (`step: "forme"`, `via: "button"`) that `chairman:queue add` accepts as his OK; it leaves the label alone, because a press is not an answer |

### A physical or account ask is walked through (C2, `a11ign/a11ign#3425`; shipped, and its live check is #3425's)

A brief with a `Steps:` list is a procedure. `walk.mjs` sends the first step with Done / Stuck / Explain more under it; on Done the step's `Verify: {{placeholder}} is|contains <value>` is READ through the
checked-facts vocabulary at that moment, and only a read that shows it moves the walk on. A read that fails, or says something else, tells him plainly that it is not seen, and offers Done again, Stuck and Later. A
step with no `Verify:` is confirmed on Done alone, and the message says "I can't check that one from here". After the last verified step the request is answered on its row through the same path as any other
press, and the closing message says what it unblocked. **The walk's memory is the ledger** (one `direction: "walk"` line per transition), so a restart finds it where it was.

## Where it runs

The host executes the tool from the monorepo copy today and from this repository's checkout after the cut-over
(`a11ign/a11ign#2623`). **Nothing here edits `work-gate.mjs`, `wake.mjs` or any file of the shadow window's import closure**: events
come from a SEPARATE watcher unit (the `fleet-watch` / `lab-watch` pattern) that reads GitHub and the ledger, never from inside the
tick.

## What this design CANNOT promise

Agents and the listener share a host and a GitHub account. **"No agent ever writes as the chairman" is enforced by construction (no
code path, a sender nobody else can derive, a branded value) and made DETECTABLE by the ledger's Telegram update ids, which the
chairman can check against their own chat. It is not cryptographic**, and an agent with shell access could write a comment saying
anything. The classifier in 2(d) is a heuristic.

**What the liaison design adds to this, in three sentences.**

1. **The liaison and every agent share the host and one GitHub account, so a recorded answer is traceable to a Telegram message ref the chairman can check and is not cryptographically proven.** `chairman:record`
   and `chairman:correct` refuse a ref the ledger lacks and words that do not hash to the receipt, and they say in the comment that the liaison wrote it; an agent with a shell can still write any comment with `gh`.
   What the design buys is that the chairman can compare any recorded answer with his own chat, and that a row never claims he wrote what the liaison did.
2. **The do-it-for-me queue cannot know his session is running.** It is a file that only his own session reads. The only thing recorded about that session is `lastRead`, the time its `list` or `take` last ran, so
   `chairman:queue status` can say "never read", "not read since <time>" or "last read <time>", and it cannot say "running". An ask can sit unread; nothing here retries it or acts in its place, by design (there is no executor).
3. **A walk-through verifies only what a read can see.** A step whose `Verify:` is a placeholder is confirmed by the organisation's own reading; a step with none is confirmed on his word, and the message says so. A step
   done in a place the checked-facts vocabulary cannot read (a console, a device, an account on another service) is not verified, however the walk reads.

**One more limit, because the design now has two recipients.** A message the liaison's queue refuses goes to `ceo` (2(b)): the chairman is never left unanswered, and the price is that the fallback reader is a session that
is cleared before each order and has no memory of the conversation.

## What exists so far (every row merged or done; read 2026-10-07 from the tracker, `a11ign/a11ign` rows #2900-#2913 and the children of #3409)

**The thirteen rows of #2899.** Rows 6 and 13 are host acts (units installed, a real round trip), so they are "done" and have no code of their own; rows 5b and 12 are follow-ups the sequence grew.

| Row | What it is | Where |
|---|---|---|
| 1 | The provider-free core, the delivery log, the provider contract and its conformance test | `core.mjs`, `ledger.mjs`, `rate-limit.mjs`, `provider-contract.mjs`, `fake-provider.ts` |
| 2 | The `messaging` key, `messaging:check`, and the `chairman-watch` unit pair (optional, off without the key) | `config.mjs`, `check.mjs`, `host/chairman-watch.*.in` |
| 3 | The Telegram provider: send, silent, split, retry, pairing | `providers/telegram/send.mjs`, `providers/telegram/pair.mjs` |
| 4 | The one-shot program the timer runs, and the request and summary sources | `watch.mjs`, `sources/requests.mjs`, `sources/summary.mjs` |
| 5 | The stall and incident sources, every read injected | `sources/stall.mjs`, `sources/incidents.mjs` |
| 5b | The real reads for row 5, wired into `watch.mjs`, and the `messaging:watch` package script | `sources/readers.mjs`, `watch.mjs`, `package.json` |
| 6 | **Live, first real message and the units installed** (a host act; closed 2026-10-04) | `host/chairman-watch.*.in` |
| 7 | Stage 2's inbound core (identity, the classifier, the branded value) | `inbound.mjs`, `classify.mjs` |
| 8 | The Telegram long poll and the listener unit | `providers/telegram/poll.mjs`, `listen.mjs`, `host/chairman-listen.service.in` |
| 9 | Answers: a button or a reply resolves a request on its row | `answers.mjs` |
| 10 | Conversation in: a free message queued for the liaison (it was `ceo` when the row was written; decision 2(b)) | `converse.mjs` |
| 11 | Conversation out: replies are checked facts | `placeholders.mjs`, `reply.mjs`, `reply-cli.mjs` |
| 12 | `ceo`'s brief and the known gaps say what the code cannot enforce | `.agent-org/roles/ceo.md` and `docs/known-gaps.md` in `a11ign/a11ign` |
| 13 | **Live, the round trip** (a host act; closed 2026-10-05) | the ledger, and the rows it wrote |

**The liaison epic, #3409** (the chairman's direction of 2026-10-04; its rows are in the order they were built, wave by wave).

| Row | What it is | Where |
|---|---|---|
| A1 #3410 | The daily summary is opt-in and absent means off | `config.mjs`, `sources/summary.mjs` |
| A7 #3411 | How fast the org acknowledges and answers is readable from the ledger | `measure.mjs` (`messaging:measure`) |
| A2 #3412 | A request reaches the chairman as a brief | `sources/requests.mjs` |
| A3 #3413 | A release shipping is told in one line | `sources/releases.mjs` |
| A4 #3414, A8 #3422 | A milestone moving is told, and the first milestones are declared | `sources/milestones.mjs` |
| A5 #3418 | The watch list: "keep me posted on X" is recorded once, told when X changes, and ends when X ends | `watch-list.mjs`, `sources/watched.mjs` (`chairman:watch`) |
| A6 #3419 | An incident or stall message says what it is, its impact, and what is being done | `sources/incidents.mjs`, `sources/stall.mjs` |
| B1 #3415 | A seat that is never cleared | `"persistent": true` in `.agent-org/roles/sessions.json` |
| B3 #3420 | The checked facts the liaison may state beyond issue, PR and run: fleet, gate, release | `placeholders.mjs` |
| B5 #3421 | The liaison's brief and its roster entry | `.agent-org/roles/liaison.md` and `sessions.json` in `a11ign/a11ign` |
| B2 #3416 | The chairman's messages go to the liaison, acknowledged at once in words; `ceo` is the fallback (#3538) | `converse.mjs` |
| B4 #3417 | The liaison records the chairman's answers on the row and fixes what he says is wrong; `chairman:ask-ceo` (#3490) | `record.mjs`, `correct.mjs`, `ask-ceo.mjs` |
| C1 #3423 | Buttons are drawn, and the vocabulary is closed | `providers/telegram/send.mjs`, `answers.mjs` |
| C2 #3425 | A physical or account ask is walked through, one verified step at a time | `walk.mjs`, `sources/requests.mjs` |
| D1 #3427 | "Do it for me": a queue for the chairman's own session, written only after his OK | `session-queue.mjs` (`chairman:queue`) |

**Not done:** **E2 #3431, which is the live one**: the liaison seat is started, one real conversation is had, and the first before-and-after readings are taken. Until then the chairman's
messages that the liaison's queue refuses go to `ceo`, which is what the fallback in 2(b) is for. **C2's live check is #3425's** (the walk-through is merged and its tests pass; it has not been walked on a real request). E3 `a11ign/a11ign#3430`
is this repository's own record and rules (`ceo`'s brief, the labellers' rule for a brief), and this document is E1. The units run `pnpm run messaging:watch` and `pnpm run messaging:listen` in the PROJECT's
checkout (`WorkingDirectory=@@checkout@@`), so each name must resolve there.

### Row 1: the core, the provider contract and its conformance test

Nothing in this row sends a message to anyone.

| File | What it is |
|---|---|
| `src/messaging/event.mjs` | `normalizeEvent`: the one door an event comes in through; throws a `TypeError` naming the field. |
| `src/messaging/core.mjs` | `createMessenger({ provider, ledger, now, config }).tick(events)`; the pure `planNotification`; `composeText`, `composeDigest`. |
| `src/messaging/ledger.mjs` | The delivery log, `redact`, `describeError`, and `foldLedger`, which rebuilds the core's memory from the log. |
| `src/messaging/rate-limit.mjs` | The token bucket and the hourly cap, on an injected clock. |
| `src/messaging/provider-contract.ts` | `runProviderConformance(provider)`. |
| `src/messaging/fake-provider.ts` | The in-memory provider that passes it, and records what it was given. |

The clock, the ledger path and the provider are injected, so every test is hermetic and fast. The core takes no `fetch`: only a
provider reaches a network. `node --test "src/messaging/**/*.test.mjs"` runs in `gate`.

### Choices row 1 made that the design did not spell out

Each is a decision a later row may revisit, and each is pinned by a test.

- **The ledger is the only state.** There is no second state file. `foldLedger` replays the lines on start, so dedupe, the reminder
  count and the hour's allowance all survive a restart; a ledger line that is not JSON stops the core (a skipped line could send
  again what was already sent).
- **The digest goes out when the hour has room for it**, not at the moment of overflow: the cap is a sliding hour, so a held event
  is told about up to an hour late, as ONE line naming every event held since. The alternative (send at once) cannot be ONE line
  if a second event overflows after it. The digest counts toward the next hour's cap.
- **A token-bucket refusal is a deferral, not a digest:** it is a wait of seconds, the event is retried on the next tick, and one
  ledger line (`deferred`) is written per refusal.
- **An event resolved while only a digest holds it is withdrawn** (a `withdrawn` line) and the digest stops naming it, rather than
  sending "cleared" for something the chairman never saw.
- **A provider's `send` returns `{ messageRef, silent }`**, `silent` being what it applied: without it a provider that drops the
  flag and one that honours it return the same value and "drops `silent`" cannot fail a check. It also REJECTS text over
  `maxText` and empty text; the core shortens text to `maxText` (keeping the links whole) before it sends.
- **A held-down, duplicate or already-cleared observation writes no line.** It is not an attempt, and 100 ticks must not write 100
  lines. A deferral, a failure, a digest overflow, a withdrawal and a malformed event each write one.

### Limits of what row 1 can show

- **The conformance suite checks what a provider RETURNS, not what it puts on the wire.** A provider that echoes `silent: true` and
  does not set `disable_notification` passes it. Each provider's own test asserts its wire request.
- **The redactor is a pattern list with a catch-all for long opaque strings.** It removes the token shapes the tests name and any
  32+ character run of token characters; a secret in a shape outside both is not caught. It also redacts legitimate long
  identifiers in an error message, which is the safe direction.
- **Events come from watchers that do not exist yet** (rows 4 and 5), so `firstSeenAt` is whatever a watcher supplies: the
  hold-down is only as honest as that timestamp.

## Rows 5 and 5b: the stall and incident sources, and what reads for them

`sources/stall.mjs` and `sources/incidents.mjs` decide; `sources/readers.mjs` reads. Each reader throws on a failed call and the source turns the
throw into `cannot-ask`: no event, one log line, never a "cleared".

| Reader | What it reads | Feeds |
|---|---|---|
| `readLastMerge` | the newest `merged_at` among the 30 most recently updated closed pull requests into `main` (not the newest commit: `main` carries "Merge origin/main into <branch>" commits) | `stall:no-merge` |
| `readTrunkRuns` | the last 20 runs of `trunk.yml` on `main` | `incident:trunk-red` |
| `readCiRuns` | the last 20 completed runs of every workflow, each failed run with its failed jobs' annotations | `incident:ci-permission` |
| `readGateUnit` | `systemctl --user show <prefix>work-tick.service`: `ActiveState` and `InactiveEnterTimestamp` (when the unit last RAN), and the tick's own completion record (when a tick last COMPLETED) | `incident:gate-crash` |
| `readFleetState` | `runs/fleet-watch-state.json` in the project checkout, and its modification time; **only the worker's name is kept, never its address** | `incident:fleet-down` |
| `readTicks` | this watcher's own samples, newest first | `stall:all-idle` |
| `readFixRow(key)` | the open row OR PULL REQUEST that holds the fix for an incident or stall, and the org's newest word on it: `issues?labels=incident&state=open` filtered to the item whose body carries an `Incident: <key>` line (the oldest; its `session:` label is returned as `holder`), then the newest comment by an org account from `issues/<n>/comments` (the page the listing's `comments` count names). **`null` only when GitHub answered and no item names the key; a failed call throws** | the `Being done` line of every SENT incident and stall |
| `readEpisodeStart(key)` | when the chairman was TOLD of the episode open now: the ledger's first delivered line since the last clear. No `gh` call. A floor on how long it stood, never the start itself | the `Lasted` line of every CLEARED incident and stall |

**Decisions this row made that the design did not spell out:**

- **A fix row says which incident it fixes by a body line, `Incident: <key>`, on a row labelled `incident` (a11ign/a11ign#3419, replacing the per-key label of #3439).**
  The chairman's row names that shape, and one label for every kind is one listing call instead of one per key. The listing returns bodies, so the key is matched here
  and the search API (a separate, smaller pool that matches words, not lines) is not touched. Several open rows for one key name the oldest. **Opening the row is not this
  program's job**; until one carries the line a sent event reads `Being done: nobody has picked this up yet`, which is the useful fact.
- **The reader accepts an open PULL REQUEST, and the own-path order does not ask for a second artefact (a11ign/a11ign#3449).** `trunkRedOrders` tells the fixer to open a
  pull request, and the issues listing returns pull requests with the same `labels=` filter, so the choice was between the reader skipping them (which hid the fix exactly while
  it was open: the first real `incident:trunk-red` would have been sent with `nobody has picked this up yet` beside an open fix PR) and the order also asking for a row whose only
  job is to be read, which nobody would remember to open. The reader changed; the item's `session:` label comes back as `holder` (rendering it belongs to the `Doing` line, not
  here). **Both orders (own path, routed path) carry one sentence** telling the fixer to label what it opens `incident` and put `Incident: incident:trunk-red` on a line of its
  own in the body; `src/trunk-red.test.ts` follows that sentence through `readFixRow`, so the two cannot drift apart. The `incident` label is not created by anything: the
  sentence says to `gh label create incident` first when `gh` reports it missing. **The other keys (`incident:gate-crash`, `incident:fleet-down`, `incident:ci-permission`, `stall:*`)
  have no standing order that opens a fix, so no instruction of theirs can carry the sentence: label it by hand until one exists.**
- **What is being done is the newest comment by an ORG account on that row, quoted with its age** (`readers.mjs`'s `ORG_LOGINS`, restated from `hand-fix-ledger.mjs` because
  the sources are a leaf). A comment from anyone else is not the org's word. A row the org has not commented on says so, which is not `nobody has picked this up yet`; a read that
  failed says `I could not read it`, and the event is still sent. The path `issues/<n>/comments` was added to `watch.mjs`'s `READ_API_PATH`: without it every live read
  would be refused and every message would say `I could not read it`.
- **A cleared message says how long it lasted, as `at least` the time since the chairman was told.** The sources keep no state and a resolved reading no longer holds when the
  thing began, so the only memory of an episode is the ledger, and what it holds is the send. The floor is honest; a start it cannot know is `not known`, never a short one.

- **The gate's last COMPLETED tick is a record the tick writes, not systemd's timestamp (#3040).** `InactiveEnterTimestamp` answers "did the unit run", and a tick
  that died at import moves it exactly as a good one: on 2026-10-02 it advanced on every one of 63 crashed ticks. `work-tick.mjs` writes
  `work-tick-completion.json` (time and exit code) beside the wake ledger only when it reaches the end of `main()`, so a tick that threw writes nothing and a
  tick that exited 1 (orders with nowhere to go) still does. `readGateUnit` takes `lastRecordAt` from it and THROWS when it is absent or unreadable, which the source
  turns into `cannot-ask`. A unit that is `failed`, or whose last COMPLETED tick is more than three intervals old, is the incident, and its text says which
  silence it is: ticks still starting and not finishing, or no tick starting at all.
- **`readTicks` is a history the watcher keeps.** Each run first takes a SAMPLE (the time, every seat's state from `herdr --session org workspace list`,
  the rows waiting) and appends it to `~/.local/state/agent-org/messaging/samples.jsonl`: a week of them (2,016), compacted once a day. One sample alone
  never makes `stall:all-idle`; it needs a streak of ten minutes, so **the timer's period (five minutes) must stay under that**. A sample whose seats or rows
  could not be read is not written, and the source then reads a history that stopped growing, which is `cannot-ask` once it is more than three ticks old.
- **A row is "waiting" when it is open, labelled `ready`, and carries none of `blocked`, `hold*`, `answer:*`.** That approximates the gate's own order list,
  which this program may not call: a row held by a `Not-before` date still counts, and a pull request awaiting a reviewer does not.
- **`fleet-watch` runs hourly, so its file is up to an hour old on a healthy host.** `incidents.mjs`'s 30-minute default would have read half of every
  hour as "the watcher stopped"; `watch.mjs` passes 130 minutes (two missed firings and a margin).
- **A failed run's annotations are read once.** A completed run's never change, so they are kept by run id in `ci-annotations.json`, six runs per
  watcher run at most. **A failed run not yet read makes `readCiRuns` throw** (`cannot-ask`), because an unread run is not a clear one. A run that
  fails to START (`startup_failure`) has no job to carry an annotation and is not read: a permission refusal of that shape is not seen.

**The `gh` calls one run makes, all `gh api` on the CORE pool and none on GraphQL** (the label sources' `gh issue list` / `gh pr list` calls spend
GraphQL and are not counted here):

| Call | Per run |
|---|---|
| `issues?labels=ready` (the sample's waiting rows) | 1 |
| `pulls?state=closed&base=main` (`readLastMerge`) | 1 |
| `actions/workflows/trunk.yml/runs` (`readTrunkRuns`) | 1 |
| `actions/runs?status=completed` (`readCiRuns`) | 1 |
| `issues?labels=incident&state=open`, then `issues/<n>/comments` (`readFixRow`) | one or two per event that is about to be SENT (the second only when the fix row has comments), none otherwise |
| `actions/runs/<id>/jobs`, then `check-runs/<id>/annotations` per failed job | only for a failed run not read before: at most 6 runs, each ONCE ever |
| `releases?per_page=100` (the `releases` source, a11ign/a11ign#3413) | one per declared code repository (four for this project) |

**Four calls per run when nothing new has failed and nothing is sent** (`readers.test.mjs` pins the list), so 1,152 a day at the five-minute timer: about 48 an hour, about 1%
of the account's 5,000-point core pool. **The `releases` source adds one call per declared code repository on top** (four here, so eight a run, 2,304 a day, about 2%: computed from the table, not measured). Measured once on 2026-10-02 against the live repository: a double sample plus one asking of every source made 8
calls, the 5 above and 3 annotation calls, which are not repeated. The account is the unit's declared `GH_CONFIG_DIR`, never
a person's (#1967); `assertReadOnlyGh` admits `gh api <path>` for seven REST paths and nothing after the path, so no flag can turn the read into a write.

**What the first week's reading (row 13) counts:** how many `stall:no-merge` events fired while the queue was EMPTY. The ruling on #2904 keeps that event
unconditional, and the count is what would change it. The queue at each moment is the `orders` of the sample at that time (`samples.jsonl`, a week deep);
the events are the delivery log's `stall:no-merge` lines. **Read it from the host, not from a checkout: neither file is in a repository.**

**Limits of what this row can show:** the tests hand each reader a recording and a failure; none runs `gh`, `systemctl` or `herdr`. The live reading was one
hand-run of the readers against this host (read-only), not a unit run, because the unit is row 6's. On that run `incident:fleet-down` was open with 15
workers not ready, the oldest since 2026-09-30 per `fleet-watch`'s own file. **That was a false alarm, and the reader was right to report it:** the fleet is switched
off on purpose (`orchestrator`, ruling on #3008, 2026-10-02), and `fleet-watch` counts an `unreachable` box as non-ready. The fix is in the writer, a11ign/a11ign#3023,
and row 6 is blocked by it, so the unit is not installed while the alarm would fire. After it lands the state file lists no worker while the fleet is off.
**What stays uncovered, for row 13's first-week reading to look for:** a fleet that is genuinely dead (power cut, switch down) reads the same as one that is off, so
`incident:fleet-down` will not fire for it. `fleet:wake` is the cover, at the next capture window; catching a dead fleet between windows needs a different signal and its own row.

## The releases source (a11ign/a11ign#3413, chairman point 2 of #3409)

A release of a declared package is told in one line, `<package> <version> is out: <first sentence of the release notes>`, the release page last. `sources/releases.mjs` reads
`gh api repos/<repo>/releases?per_page=100` for every `code` repository `project.json` declares and emits `release:<repo>@<tag>` for each PUBLISHED release not yet seen, oldest first.
The core's kind `release` has no hold-down, never reminds, is not silent and is never cleared: a release is a thing that happened, not a condition that stands.

- **The first read of a repository tells nothing.** It records every release it finds as seen and a `release-baseline:<repo>` marker, as `source-note` ledger lines (the only memory the
  watcher keeps), and the log says so once. **The marker, not a count, says "not the first run"**: a repository with no release yet records none, and its first real release must not read as history.
- **A read that failed records nothing** (`cannot-ask`), so that repository is the first run again when it answers. A draft and a pre-release are neither told nor recorded; one promoted later is told then.
- **The sentence is read from the notes, never written for them.** Changesets' markdown has its heading, list marker, commit-hash prefix, backticks and link addresses removed, and is cut at 240 characters.
  Empty notes say `(no summary was written)`.
- **A burst** (three releases in 75 minutes, as on 2026-10-04) is collapsed by the core's rate limit, whose overflow is one digest line. Nothing here adds a limit.

## Stage 2, the inbound core (row 7 of 13)

`src/messaging/inbound.mjs` and `src/messaging/classify.mjs`: **who may speak through the chat, and what becomes of what they say.**
Still no provider and no listener (rows 8-10): the functions take an update, shaped like Telegram's `getUpdates` entry, and
return what the caller must do. Nothing here fetches, sends, deletes or forwards.

| File | What it is |
|---|---|
| `src/messaging/inbound.mjs` | `acceptUpdate(update, { chairman })` (identity); `createInbound({ ledger, chairman }).handle(update)` (identity, classifier, dedupe, ledger); `isAccepted(value)`. |
| `src/messaging/classify.mjs` | `classifyText(text)` -> `forward`, `drop` (a definite secret), `withhold` (one token shaped like a pasted secret; the chairman may resend it with "not a secret") or `refuse` (a deletion, or spending), with a one-line `reply`. |

### The threat model of the inbound path

The chairman's bot is addressable by **anyone who can find it**, and a message it receives is text an attacker may have chosen.
What the design defends, and against whom:

| Who or what | What they could try | What stops it | Where it is pinned |
|---|---|---|---|
| A stranger messaging the bot | Be taken for the chairman | Identity: `from.id`, `chat.id` AND `chat.type == "private"` must all match; the ids are integers or the update is dropped | `inbound.test.mjs`, "identity" |
| A stranger adding the bot to a group | Speak to the organisation from a chat the chairman is also in | The right user in a group is a distinct drop (`not-private-chat`); the drop names the chat so the listener can leave it | same |
| Anyone forwarding or editing | Put third-party words in the chairman's mouth, or change a message after it was judged | A forward and an edit are dropped | same |
| An update with a missing or doubled field | Make `undefined === undefined` accept it | A chairman with a missing id refuses to start; an update without an integer `update_id`, a sender, or exactly one payload is `malformed` | same |
| A replayed or duplicated batch | Act on one instruction twice | Dedupe by the provider's update id, remembered in the ledger so it survives a restart | "a replayed update id" |
| Code in this repository | Forge an "accepted" value: by hand, by copying one, by minting one for other ids (`createInbound` with a chairman of its own), or by skipping the classifier (`acceptUpdate` alone) | The value is branded with a module-private Symbol AND registered, with the ids it was minted for, in a module-private WeakMap. Only `handle` mints, and only after the classifier said forward; `acceptUpdate` returns a plain value that is not accepted. **`isAccepted(value, chairman)` makes the caller name the chairman it is configured with** and compares both ids | "no other module can produce the branded value" |
| The chairman's own slip | Paste a credential, delete a repository, spend money from a phone | The classifier, below | `classify.test.mjs` |
| A reader of the delivery log | Recover what was said | A line holds ids, a reason, a length and a sha256: never the text, and no hash at all for a secret | "a clean message's line" |

### (d) in three layers, and which one is the guarantee

**None of the three is a guarantee on its own, and the first is the weakest.**

1. **The classifier (this row).** A pattern list in two tiers (#3442, after a password typed as `My password is: <value>` was forwarded,
   queued and quoted back). **Definite, so dropped and never released:** a credential word (`password`, `passwd`, `passphrase`, `pw`,
   `pwd`, `secret`, `api key`, `private key`, `credentials`, and the weaker `pass`, `pin`, `token`, `login`) with its value beside it
   after `is`, `was`, `are`, `:`, `=`, `-`, `->` or whitespace and up to two filler words, or the value first (`<value> is my password`);
   and the known shapes: the ledger's (GitHub, Slack, AWS, JWT, Telegram bot token, `Bearer`, `password=`, and any 32+ character run of
   token characters, except a git object name or a hyphenated lowercase slug) plus a private-key header, a URL with credentials and
   five more key shapes. **Unsure, so withheld:** one token of 16+ characters that mixes three of lower, upper, digit and symbol; it is
   handled as a drop, and the chairman is told they may send it again with `not a secret`, a phrase that releases this tier and no
   other. Both tiers write nothing: the message is deleted from the chat, its ledger line carries no hash, and the reply is sent
   without `replyTo` so the chat does not render the original above it. Deletion verbs near a repository, branch, row, data or file,
   and force-push; buying, subscribing, a paid plan, a currency amount. It **has false negatives** (a secret split across words, a
   lowercase word after a strong credential word with no separator, a deletion phrased without the listed verbs, a misspelling) and
   it is tuned to the other error on purpose: it refuses a message it should have forwarded rather than forward one it should have
   refused.
2. **The liaison's brief and `ceo`'s (rows 12 and B5).** What reaches the liaison, or `ceo` on the fallback, is read by a model told never to act on a
   credential, a deletion or a spend from chat, whatever the classifier let through.
3. **The outbound path carries only checked facts (row 11).** Even a liaison or a `ceo` that was talked into something cannot say it in the chat:
   an answer is placeholders the core re-reads, so the chat cannot be turned into a channel for anything the repository does not hold.

### Choices row 7 made that the design did not spell out

Each is a decision a later row may revisit, and each is pinned by a test.

- **The update shape is Telegram's** (`update_id`, `message`, `callback_query`). It is the only provider; a second one would normalise
  into this shape in its own poll.
- **A drop is a value, never a throw**, and a stranger's drop is **not answered**: the bot says nothing to someone who is not the
  chairman. Only an accepted message that is dropped or refused gets a reply (`action: "reply"`), and only a SECRET also asks the
  caller to delete the message (`deleteMessage`). A refusal is not deleted: the chairman's own sentence is not a leak.
- **The order of the identity checks is the order of the reasons**: no sender, wrong user, not a private chat, wrong chat, forwarded,
  not text. So a stranger's DM is `wrong-user` (its chat is also wrong, and the user is what they got wrong first), and the chairman
  in a group is `not-private-chat`.
- **A button press is held to the same identity**, with its chat read from the message the button sits under; a press with no
  message (inline mode) has no chat to check and is dropped. A button's `data` is **not classified as text**: it is held to a **closed
  vocabulary** instead (a11ign/a11ign#3423): `ans:<option id>` (the shape a brief's options block accepts) or `act:<word>` for one of
  `approve`, `done`, `stuck`, `later`, `explain`, `forme`. Anything else is dropped as `unknown-callback-data`, with a hash of the data in
  its ledger line, and is never forwarded. The press is then routed by the ledger-known message it sits under, never by the data
  (`answers.mjs`): an option, `approve` or `done` resolves the request; `later` snoozes its reminders for 24 hours (one ledger line, the label
  stays, so it is not an answer, and the watcher does not observe the request until the snooze ends, or the request is answered or cleared);
  `explain` and `stuck` each queue ONE order for the `liaison` (through `converse.mjs`, the only module that queues); `forme` ("Do it for me") writes ONE ledger line,
  `{direction: "answer", step: "forme", via: "button", messageRef}` (`answers.mjs`), leaves the label alone because a press is not an answer, and tells him
  his session was asked. A press on a message whose request is answered or no longer asking is told so and its keyboard is taken off
  (`editMessageReplyMarkup`). The Telegram provider draws `actions` as `reply_markup.inline_keyboard`, one button per row, on the first part of
  a split message only; a request with more options than fit (6) carries no keyboard, since a partial one is a quieter wrong than none.
- **A secret's ledger line has no sha256.** The design says every verdict carries one; for this verdict a hash of a short password is
  a dictionary attack away from the password, and the update id and the length already say what a reader needs about a message that
  was thrown away.
- **A replay writes no line and acts on nothing** (`action: "replayed"`), for the reason row 1's core gives: 100 replays must not
  write 100 lines. **The line is written BEFORE the caller is told to act**, so a crash between the two loses one message and never
  repeats one (at-most-once). If the ledger cannot be written, `handle` throws and the message is not forwarded.
- **An update with no integer `update_id` is dropped as `malformed`**: with no id it cannot be deduplicated, so it could be acted on
  twice.

### Limits of what row 7 can show

- **The classifier is a heuristic and is tested against the sentences its author thought of.** The tests show that the shapes they name
  are caught and that a spread of ordinary sentences is not; they cannot show that nothing else is a secret.
- **It refuses ordinary sentences.** "Remove the blocked label from row 5" is refused as a deletion on a row, "what did $5 buy" as
  spending, and a branch name of 32 or more characters in a message is dropped as a secret by the redactor's catch-all. Each is one
  sentence the chairman types differently or does themselves.
- **It reads the text, not what a model will make of it.** A deletion phrased as a request for a script, in another language, or in
  words the list lacks, is forwarded. Layers 2 and 3 are the answer to that, not a longer list.
- **The leak scan's two patterns (a private LAN address, a named SSH key file) are not reused**: they guard what is *published*, they live
  outside this leaf module, and a private address typed in a private chat is not a credential.
- **Identity is the provider's claim.** `from.id` is what Telegram says; an attacker who held the bot token could send updates that
  say anything. The token is a secret on the host (decision 1), and the ledger's update ids let the chairman check their own chat
  against what the organisation believes they said.
- **The branded value is not cryptographic** (see "What this design CANNOT promise"): code that can edit this module can mint one.
  The scan test shows that no OTHER module exports a way to, today (`createInbound` is the only one, and `isAccepted` makes a value it
  minted for other ids useless to a caller that names the real chairman).
- **What the brand proves, and what it does not.** It proves THIS module's identity check and classifier ran, for the ids the value is
  registered against. It does not prove those ids are the chairman's: code in this process that knows the chairman's two ids (they are
  configuration, not secrets) can still call `createInbound` with them and a made-up update. Nothing in-process can stop that; the
  defence is that row 9 reads the ids from its own configuration, passes them to `isAccepted`, and that the listener (row 8) is the
  only caller of `handle`.
- **Findings of ceo's review of 4113f67 not fixed in this row** (non-blocking, for rows 8 and 9 or a follow-up): false negatives
  (`gh repo delete`, `git branch -D`, `git push origin :main`, `upgrade to pro`, `password hunter2`, `pw:`, a bare `BEGIN RSA PRIVATE
  KEY` header, combining accents and homoglyphs); false positives (a 40-hex SHA is read as a secret and deleted, `how do I remove a
  label from a row?` is refused); the content of a group or forwarded message is hashed before the identity check (at odds with "no
  hash of a secret"); and a stranger can grow the ledger by one line per update.

## The liaison's commands: `chairman:record`, `chairman:correct`, `chairman:ask-ceo`, `chairman:watch` (a11ign/a11ign#3417, #3490, #3418, #3502)

The liaison acts for the chairman through four commands and no others; each (`watch` for `add`) takes a `--message=<ref>` that must be an accepted inbound line in the ledger, and the three
that write or send say in their own text that the liaison wrote it. `record` and `correct` write to a row (their source headers hold the rules: a closed set of three verbs, `needs:chairman` the only label removed).
`ask-ceo` writes to no row: it asks `ceo` for a ruling. `watch` writes to no row either: it keeps the chairman posted on a thing until the thing ends (below).

### `chairman:ask-ceo`: what "names something that clears it" is

```
pnpm run chairman:ask-ceo -- --row=3333 --message=45      (the question on stdin)
```

It is `prompt:session ceo --needs-decision` with two refusals in front, both before anything is sent: the ref is not in the ledger, or **the question carries no `Waiting-for:` line
that the gate reads**. The predicate is `parseWaits` (`wait-condition.mjs`), the parser `work:tick` and `org-health` run, asked whether any wait in the text is `closed`, `merged`,
`labelled` or `unlabelled` on a row. So `Waiting-for: unlabelled answer:ceo #3490` passes (the label coming off the row is the answer), and `Waiting-for: soon`, `Waiting-for: manual`,
a bare `#3490` in a sentence and a `Waiting-for:` line inside a code fence do not.

**Why this one of the candidates.** A waiting condition is data, not a sentence: a ruling asked in prose has nothing that ends the wait, so it is queued and left to stall. The
candidates were a row reference plus the decision asked (prose, which no reader of the gate parses), or a named field the answer would set. The second is chosen, and it is
the `Waiting-for:` grammar and not a new field, because that is the one the gate already reads and already reports as `wait-without-reason` when it cannot. What passes here is therefore
what the gate can later find true. It is not a promise that the condition is a good one, or that the row named exists: `ask-ceo` checks the grammar and not the tracker.

**The target is `ceo` and nothing else** (`RECIPIENT`; `parseArgs` is strict, so a `--to` is refused). **The order is sent by running `prompt:session`, not by importing its queue**, so it has
the same refusals, the same `decision: true` entry and a sender derived from the caller's herdr workspace, which is `liaison` only when it is run in the liaison's seat; the order's first line
names the liaison either way. **Exit `2` of `prompt:session` is QUEUED, reported as queued and never retried.** One consequence to know: `converse.test.mjs` bounds the callers of the queue under
`src/messaging/` by scanning for the queue's functions and `prompt-session.mjs`, and `ask-ceo.mjs` runs the command by name, so the scan does not see it. It is a second sender to a session
other than the liaison, from a command the liaison runs and not from a chat message, which is the path that scan exists to bound; `ask-ceo.test.mjs` pins its own single target.

### `chairman:queue`: "can you do it for me?" (a11ign/a11ign#3427, D1 of #3409)

```
pnpm run chairman:queue -- add --message=45 --what=... --why=... --result-wanted=...     (his OK, as he wrote it, on stdin)   the org's side
pnpm run chairman:queue -- status                                                         never read / not read since <time> / last read <time>
pnpm run chairman:queue -- list | take <id> | done <id> --result=<one line> [--hand-fix]  the chairman's session's side
```

**There is no executor.** The queue is a file only a human's session reads (`~/.local/state/agent-org/messaging/chairman-session-queue.jsonl`, 0600, in a directory that must be 0700: `add` refuses a looser one and does not re-mode it), and `session-queue.test.mjs` fails if a module under
`src/messaging/` that touches it also spawns a process. The org never holds the credential the act needs; the ask says what, why and what result is wanted, and the chairman's session does the rest.
**An ask needs his OK, verified as `chairman:record` verifies one**: a message ref the ledger took in with his words hashing to the receipt's, or a "Do it for me" press line (`direction: "answer"`, `step: "forme"`,
`via: "button"`, written by `answers.mjs`, one per message). One OK is one ask. Text carrying a credential shape is refused with the file unchanged; a deletion or a purchase is not, because that refusal is about what the CHAT may
pass on and not about what his own session may be asked.
**What happened to an ask is in the delivery ledger** (`direction: "queue"`: `read`, `take`, `done`), so the file holds one kind of line and is never rewritten. `list` and `take` write `lastRead`, which is
the only thing the liaison can say about his session: it cannot say it is running. `done --hand-fix` counts into `messaging:measure`.

### `chairman:watch`: keep the chairman posted on a thing until it ends (a11ign/a11ign#3418, #3502)

```
pnpm run chairman:watch -- add <row|pr|run|unit> <id> --message=45     start watching
pnpm run chairman:watch -- list                                          what is being watched
pnpm run chairman:watch -- remove <row|pr|run|unit> <id>                 stop, without a message
```

**The ledger is the list**: `add` and `remove` are `direction: "watch"` lines, `list` folds them, and the watcher tells the chairman each change of state and **ends the watch when its final state has
been told**, not when it was seen. The state is read through the placeholder vocabulary, so a thing the vocabulary cannot read is refused at `add`, and so is a thing already in its final state (nothing
would change). The states that end a watch: a row `closed`; a pull request `merged` or `closed`; **a run, any conclusion GitHub names** (`success`, `failure`, `cancelled`, `skipped`, `neutral`, `timed_out`,
`action_required`, `stale`, `startup_failure`); a unit never ends and is removed by hand.

**A run in progress can be watched** because its state is `{{run:<id>.status}}`: the run's status (`queued`, `in_progress`, `waiting`) while it runs and its conclusion once it has one, so one field follows
a run from start to end, and each move is told. `{{run:<id>.conclusion}}` is unchanged and still refuses a run that has not concluded. Before this field, `add` could not succeed for a run: the one reader
refused every run still going, and a run that has concluded is final.
