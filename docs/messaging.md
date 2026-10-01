# Chairman messaging

How the organisation tells its chairman things, and (in later stages) how the chairman answers, over a chat provider. Telegram is
the first. **This is the design as the chairman decided it (2026-10-01, `a11ign/a11ign#2899`) and the limits it states about
itself.** The build is thirteen rows; this document says at the end what exists so far.

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
- **Delivery log:** append-only JSONL, one line per attempt `{ ts, key, provider, status, providerMessageId, error }`. Error text
  is passed through the secret redactor first. Inbound lines (stages 2 and 3) go in the same file as
  `{ ts, direction: "in", updateId, verdict, reason }`, **with content stored as a length and a sha256, never the text** (a dropped
  message is attacker-chosen text).
- **Provider interface (small):** `{ id, capabilities: { silent, buttons, replies, conversation, maxText }, send({ text, silent,
  actions, replyTo }) -> { messageRef }, poll?(cursor, signal) -> { updates, cursor } }`. One exported `runProviderConformance(provider)`;
  **every provider's own test calls it**, and it is the only definition of "a provider".
- **Optional and off by default:** the `messaging` key in `.agent-org/project.json` (`provider`, `tokenFile`, `chairmanFile`,
  `summary: { at: "08:00", timezone: "Europe/London" }`), read like `causes`. **Absent means nothing is constructed, no unit is
  installed and `host:check` is silent.** The summary is idempotent per LOCAL date (DST-correct, via `Intl`) and is sent silent.
- **Secret by reference only:** `tokenFile` names a file under `~/.config/agent-org/`. The reader refuses a file that is not mode
  0600 or not owned by the running user, never puts the token in argv, env, a unit file or a log, and **redacts the Telegram URL
  (`/bot<token>/`) from every error it surfaces** (a failed `fetch` quotes it). The chairman's Telegram user id and chat id are not
  secrets but are personal data in a public repository: they live in `chairmanFile` (0600), written by a **pairing command**. The
  chairman runs `messaging:pair` in their own shell, the host prints a one-time code, they send `/pair <code>` to the bot within 10
  minutes, and the bot records the first sender that proves it. Nobody types an id into a repository.
- **Long polling (`getUpdates`), no inbound port**, one listener process under a single-instance lock (a second poller gets
  `409 Conflict`), the offset persisted after each accepted batch.
- **No quiet hours.** Only the summary is silent.

## Decision 2. Two-way, "done right", each point a test

- **(a) Identity.** `acceptUpdate` accepts only `from.id == chairman.userId AND chat.id == chairman.chatId AND chat.type ==
  "private"`, for messages and button presses alike. Edits, forwards, group events and everything else are DROPPED and logged
  (reason, ids, length, hash). The bot leaves any chat that is not theirs.
- **(b) Chairman -> `ceo` only.** An accepted message is queued for `ceo` through the existing `prompt:session` queue, with a sender
  the listener alone supplies (`chairman via Telegram`); `resolveSender` derives every other sender from a workspace id, so no agent
  session can produce it. **There is no code path from a chat message to a worker.** `acceptUpdate` returns a value branded with a
  module-private symbol, and the only function that writes a chairman-attributed row comment accepts nothing else.
- **(c) GitHub is the record.** A button press or reply to a request writes a row comment quoting it with provenance (Telegram
  message ref, time, "verified id"), removes `needs:chairman` (taking the label off IS the act of answering) and sets `answer:ceo`,
  so `ceo` is woken with the answer as data. A conversational ruling is recorded by `ceo` on the row it concerns before it acts.
- **(d) Never from chat: credentials, secrets, deletions, money.** Inbound text is classified before anything is forwarded.
  Secret-shaped strings (the leak-scan patterns plus key, token and password shapes) are DROPPED, `deleteMessage` is attempted, and
  the bot replies that it does not take credentials in chat and where to put one. Deletion verbs on a repository, branch, row, data
  or file, and spending (purchase, subscribe, plan, an amount), are refused with the same one-line reply and not forwarded. **A
  classifier has false negatives, so it is the first of three layers, not the guarantee:** the second is `ceo`'s brief, the third
  is that the outbound path can carry only checked facts (next).
- **(e) Answers are facts, checked before they are sent.** `chairman:reply` takes text containing **placeholders from a closed
  vocabulary** (`{{issue:2885.labels}}`, `{{pr:2881.state}}`, `{{run:36891064128.conclusion}}`, `{{ready.count}}`,
  `{{last-merge.age}}`, `{{unit:work-tick.state}}`, and a verbatim quote of a row comment with its link). **The core re-reads each at
  send time and stamps the message "as of HH:MMZ"**. A read that fails REFUSES the send and tells `ceo` which, and "I could not check
  X" is itself sendable. A `#<number>`, a state word (merged, green, red, passing, failed) or a count outside a placeholder is
  refused, so an unchecked claim cannot ride in free text. Opinion goes under an explicit "My read:" line.

## Decision 3. Stages, each usable on its own

**S1 notify** (rows 1-6): one-way; the chairman sees requests, stalls, incidents and the summary. **S2 answer** (rows 7-9, 13):
buttons and replies resolve requests on their rows. **S3 conversation** (rows 10-12): free messages to `ceo` and checked replies.

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

## What exists so far (row 1 of 13)

The core, the provider contract and its conformance test, with **no provider**: nothing here sends a message to anyone.

| File | What it is |
|---|---|
| `src/messaging/event.mjs` | `normalizeEvent`: the one door an event comes in through; throws a `TypeError` naming the field. |
| `src/messaging/core.mjs` | `createMessenger({ provider, ledger, now, config }).tick(events)`; the pure `planNotification`; `composeText`, `composeDigest`. |
| `src/messaging/ledger.mjs` | The delivery log, `redact`, `describeError`, and `foldLedger`, which rebuilds the core's memory from the log. |
| `src/messaging/rate-limit.mjs` | The token bucket and the hourly cap, on an injected clock. |
| `src/messaging/provider-contract.mjs` | `runProviderConformance(provider)`. |
| `src/messaging/fake-provider.mjs` | The in-memory provider that passes it, and records what it was given. |

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
