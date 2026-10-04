# agent-org

## 0.21.0

### Minor Changes

- 6849076: A run in progress can be watched with `chairman:watch add run <id>` (a11ign/a11ign#3502). Its state is the new vocabulary field `{{run:<id>.status}}`: the run's status (`queued`, `in_progress`) while it runs and its conclusion once it has one, so each move is told and the watch ends with the conclusion. Until now the only run field, `{{run:<id>.conclusion}}`, threw for a run that had not concluded, so `add` refused the one case a watch is for; that field is unchanged. The liaison's brief restates the vocabulary, so a project that pins it learns `run:<id>.status` from `PLACEHOLDER_NAMES`.

## 0.20.0

### Minor Changes

- dee0bc9: A project's `beforeTick` can name one of the tool's own commands (`"beforeTick": "agent-org primary:update"`), and the `work-tick` unit in tool form then runs it from the tool checkout (`/usr/bin/node <tool>/src/update-primary.mjs`, through the same command table `agent-org` itself reads) instead of through the project's `node_modules`. A project that declared `pnpm run primary:update` ran the copy its lockfile pins, a second version of the tool on every tick, for the one step that moves the project's own checkout. The words are split on any whitespace, the one way `parseBeforeTick` lets a command through, so a tab or a run of spaces after `agent-org` is the same command. A command that is not the tool's is still the project's own and runs as written; an unknown tool command refuses, and so does one declared by a project that is not the host's primary, because the tool serves the primary only. To take the change, a project edits its `beforeTick` to `agent-org primary:update` AFTER the host runs this release (an older tool would run the word `agent-org` as a program and the primary would stop moving), then reinstalls the unit with `host:install`.

## 0.19.7

### Patch Changes

- 8c05f9e: "Keep me posted on X" is recorded once and told when X changes state. `pnpm run chairman:watch -- add <row|pr|run|unit> <id> --message=<ref>` writes a `direction: "watch"` ledger line naming the thing and a message of the chairman's the ledger took in (an unknown ref, or a thing the placeholder vocabulary's readers cannot read, is refused and writes nothing); `list` and `remove` answer "what are you keeping me posted on" and end a watch without a message. Each tick the new `watched` source reads every active watch through those readers and offers `watch:<thing>` (`<what it is>: now <state>`) when the state differs from the last one told, and a watch ends when its final state (a row closed, a pull request merged or closed) has been told, derived from the ledger, so a final send that failed is offered again. A `run` cannot be watched yet: the vocabulary reads a run only once it has concluded.

## 0.19.6

### Patch Changes

- 0eefc09: `release.yml`'s header and the README's Releases section no longer say the host tracks `main` and a tag is not a deploy, which `update-tool` made false (a11ign/a11ign#3443): they say the host runs the newest release tag, `host.json`'s `toolVersion` pins one as the rollback, a merge with a changeset is live about nine minutes after it lands and a merge with none is never live. Comment and prose only; the release test now requires `toolVersion` in the README's Releases section in place of the retired sentence.

## 0.19.5

### Patch Changes

- 22a29bb: The board report names the agent-org version that produced it, in one line under its header, read from the tool checkout's live release tag by `liveToolVersion` and never from `package.json` (which a host's checkout can disagree with), so a report read later says which version wrote it. A checkout at no release tag prints `agent-org version not read` with the cause, never a version and never a blank (#3468, of #3443).

## 0.19.4

### Patch Changes

- 3dd492f: The tick's version banner (`agent-org vX.Y.Z (<sha>)` and `agent-org vX.Y.Z`, a11ign/a11ign#3443) is an expected repeating line: `repeating-lines.allowlist.json` names it, so the detector stops offering it to `orchestrator` after 30 ticks (a11ign/a11ign#3497). The banner's fault forms, `agent-org (at no release tag: <sha>)` and `agent-org (version unreadable: ...)`, stay offered.

## 0.19.3

### Patch Changes

- 4303124: A pull request is a claim's own by one test the open and merged lookups share (head, row suffix, title reference, session label), so a merge on a branch the claimant did not claim releases the claim as merged and is no longer read as idle (a11ign/a11ign#3445)

## 0.19.2

### Patch Changes

- 7f01e32: A code-only scope no longer runs the tracker readings against the primary's tracker (a11ign/a11ign#3493). `scopeTick` gave such a scope `[]` for every tracker lane but still ran `readings.tracker` inside `inRepo(undefined)`, which is the ambient repository, so one closed row owing an answer became one `answer-owed` order per code scope, three of them telling the session to put `--repo <scope>` on a row that does not exist there. A scope whose `tracker` is `null` now reads nothing from a tracker (the shapes an empty tracker returns), and the primary and a keyed scope with its own tracker are unchanged.

## 0.19.1

### Patch Changes

- 0532579: B4 now compares a row's Region with the Regions of the rows already claimed (`in-progress`), as well as with open pull requests' files, so a claimed row with no pull request yet holds its files (a11ign/a11ign#3475; #3414 was claimed over three files #3423 had held for 27 minutes, and the two rows ran into three conflicting pull requests). `row-claim claim` refuses a row whose Region shares a file with a claimed row's, naming it and the files; `row-claim check` prints the same verdict; and the gate shelves a Ready row behind it with the holder's number in the reason, offering it again by itself once that row closes or is released. Nothing is written: the holders are derived from the open rows on every tick. The exclusions are the pull-request ones: changesets, the asking row, a `blockedBy` edge in either direction, and a claimed row whose own open pull request declares `Closes #<row>`, which is counted once, by its files. A claim that cannot read the list of claimed rows is refused as INCONCLUSIVE rather than passed, and two rows both already `in-progress` do not refuse each other: the lower number proceeds.

## 0.19.0

### Minor Changes

- 316d657: New command `agent-org trace -- <row-or-pr>` (a11ign/a11ign#3494, first slice): one append-only trace store of the org's model turns and wake-ledger deliveries, keyed by row, pull request and repository, and a printout of one row's events in order with tokens, cost and wall-clock. The model-turn source is the Claude transcript (platform-first reading on the row: Claude Code's OpenTelemetry has no file exporter, needs a receiver the host does not run, and cannot reach a running standing seat). A turn is built once per API message id, because a transcript writes a message once per content block; cost is computed from a price table checked against Claude Code's own `cost_usd`, and is `null`, never 0, for a model with no price. It reads `wakes-per-row.mjs`'s parsers by import. GitHub events, waits, the `gh` call ledger and Codex reviewer turns are not in the store yet, and the report says so.

## 0.18.2

### Patch Changes

- 97477b8: A reviewer instance's ending closes EVERY herdr workspace under its label, not only a label held exactly once (a11ign/a11ign#3482; `reviewer-3460` held `w16B` and `w16N` on 2026-10-04, and the teardown said "left running" on every tick for as long as both lived). Each close is tried even after one fails, a failing close keeps the instance registered, and the warning names the count. A duplicate that holds no agent no longer stops the instance's OTHER workspace from being judged between turns, and no longer makes a live reviewer look dead under an open pull request. That duplicate is written once to the `reviewer-absences` ledger (`duplicate-agentless`), so it is seen while the pull request is still open.

## 0.18.1

### Patch Changes

- 979e4f8: A declared milestone coming true is told to the chairman once, with the sentence the project wrote for it. `messaging.milestones` in `.agent-org/project.json` names a file (absent means none) listing moments as `{ key, what, when }`, where `when` is a row closed, a pull request merged or a release tagged; the `milestones` source emits `milestone:<key>` the first time one holds and never again, and does not infer a milestone from a label or from GitHub's own milestones. The first complete read records the moments already true as seen and tells none of them. A condition that cannot be read is `cannot-ask`, never "not yet". `messaging:check` validates the file and refuses an entry with a missing `key`, `what` or `when` by name. This registers the `milestone` event kind in `event.mjs` and `core.mjs` (told once, never reminded, not silent) and admits `gh api` on `issues/<n>`, `pulls/<n>` and `releases` in the read-only allowlist (a11ign/a11ign#3414).

## 0.18.0

### Minor Changes

- 3427864: `org-health`'s seventh signal is now an OUTCOME CLOCK, `overdue`, in place of `pr-not-progressing` (a11ign/a11ign#3486, the chairman's "how do we make sure nothing happens again?"). Every open pull request has an age since it opened and every claimed row an age since its newest claim record; ONLY A MERGE OR A CLOSE STOPS IT, so a comment, a label, a hold, a draft and a push do not restart it and no state exempts an item. Past 100 minutes for a PR (3 x the 33.7 min median of 289 `a11ign/a11ign` PRs merged 2026-09-27..10-04) or 135 minutes for a claimed row (3 x the 44.5 min median of 282 rows closed 2026-10-01..10-04, from the newest claim record) the item is offered to `ceo` as one `org-health` order that names each item with its kind, the gate's own label for its state (`stallReasonOf`: red, conflicted, held-on-purpose, awaiting-author-draft ...) and its owner. The label rides on the alarm and is never a condition for raising it, which is what hid a hold whose reason had gone and an approved draft with no stamp. A refused read, or an item nothing dates, is an unknown and never young. `PR_NOT_PROGRESSING_MINUTES` (180) and `REASONS_THAT_ARE_NOT_A_STALL` are deleted, and the clock costs no `gh api` call where the signal it replaces paid one per quiet PR. `orgHealthNow` takes the claimed rows' comments as `claimedComments`; a caller that omits it clocks the PRs and says nothing about the rows.

## 0.17.1

### Patch Changes

- d31cf97: `pr-hold.mjs` takes, reads and releases a hold on a pull request of any repository the project declares: `--repo-key=<key>` (the key `project.json`'s `code` gives it) or `owner/repo#n`, absent being the first repository so every existing call is unchanged, and a repository the project does not declare is refused naming the declared ones. Every `gh` call, the marker comment and the re-arm read-back are aimed at that repository. The gate lifts a keyed pull request's resolved hold through the same module, released WITH its key, and reads a bare `#n` in a keyed item's `Waiting-for:` as that repository's (a11ign/a11ign#3479).

## 0.17.0

### Minor Changes

- 6327be6: The `gh` routing wrapper (`host/gh`) now records every call in a size-bounded ledger, `gh-calls.tsv` in the account's own config directory, so the caller that drains a GraphQL pool can be named by measurement rather than guessed. Each line carries the time, the account, the pool (`graphql` and `core` where `gh` says so, `graphql?` where it is inferred from the command family), the `rateLimit.cost` a `gh api graphql` response reported, the exit status, `argv[1] argv[2]`, the herdr workspace and the calling command line. The call itself is unchanged: same arguments, stdin, output bytes and exit status, and a ledger that cannot be written never fails it. The wrapper no longer `exec`s `gh`, so it forwards `TERM`, `INT` and `HUP` to it. `A11Y_GH_LEDGER=off` skips the ledger. `node src/gh-ledger.mjs <gh-calls.tsv> [--account <login>] [--resource graphql] [--top <n>]` ranks callers by points. Re-run `host:install` to pick the wrapper up; `host:check` reports `DIVERGED` until then.

## 0.16.0

### Minor Changes

- aa4735f: The liaison can ask `ceo` for a ruling through `chairman:ask-ceo --row=N --message=<ref>` (the question on stdin), and a question that names nothing that clears it is refused (a11ign/a11ign#3490, split from #3417). It is `prompt:session ceo --needs-decision` with two refusals in front, both before anything is queued: a `--message` ref the ledger does not hold, and a question with no `Waiting-for:` line the gate's own parser (`parseWaits`) reads as a condition on a row (`Waiting-for: unlabelled answer:ceo #3490` passes; `soon`, `manual`, a bare `#3490` and a line inside a code fence do not). The target is the constant `ceo`, with no argument that names another session; `prompt:session`'s exit 2 is reported as queued and not retried; the verb set of `chairman:correct` is unchanged. `docs/messaging.md` says what the predicate is and why.

## 0.15.3

### Patch Changes

- 94a1ffe: The work gate no longer asks a reviewer for a first verdict on a pull request that conflicts with its base (a11ign/a11ign#3476). `draftOrder` read red, then a settled green head, and never asked whether the pull request could merge, so a DIRTY one sat in the reviewer lane as a clean one does: #148 was approved 7m42s after #145 made it DIRTY, at a head the rebase had to replace. A `CONFLICTING` pull request now gets no `draft-awaiting-verdict` order; its owner's `pr-merge-conflict` order already says the rebase is owed, and once it is pushed the head is new and the review is asked once, at the head that can merge. An unread merge state (`UNKNOWN`) still asks for the review, and a verdict already given (rework owed, a convinced draft not yet ready) is still acted on: only the request for a first look is withheld.

## 0.15.2

### Patch Changes

- f24cef3: Neither arming path re-queues a pull request the merge queue ejected for `failed_checks` while its head is unchanged (a11ign/a11ign#3487; #3460 was ejected four times on 2026-10-04, about seven minutes of CI each, every pass failing the same way). `arm-pr` logs `NOT arming` with the ejection time and exits `DONE`; `auto-arm-sweep` reports `SKIPPED` with the same reason; both ask the one `ejectionVerdict` in `pr-armed-state.mjs`, which reads `queueEjectionOf`. A push to the head, a dequeue for any other reason and a PR with no queue history arm as before. A queue read that is refused arms nothing and is reported as a lookup that failed (`arm-pr` exits `CANNOT_ASK`, the sweep exits `1`), never read as "not ejected".

## 0.15.1

### Patch Changes

- 42bd79b: The trunk-red order now tells the fixer how to make its fix findable (a11ign/a11ign#3449): label what it opens `incident` and put `Incident: incident:trunk-red` on a line of its own in the body, on both the own path (the fix pull request) and the routed path (the filed row). `readFixRow` accepts an open pull request carrying that label and line, where it skipped pull requests and so reported `nobody has picked this up yet` beside an open fix PR, and returns the item's `session:` label as `holder`. The other incident and stall keys have no standing order that opens a fix and are labelled by hand.

## 0.15.0

### Minor Changes

- 1370868: A finishing order that has waited past the deferral bound goes to a free engineer where its cause allows (a11ign/a11ign#3465, follow-up of #3448). An order now declares `mayRelane: true` when any session can carry it out, and the only declaration today is `draft-convinced-not-ready` with an attributed verdict (the ready-flip the gate also performs itself); a self-signed or unattributed verdict, and every other cause, stays queued for its owner and is raised to `ceo` as before. When a declared order has been deferred for more than `ORDER_STALL_MINUTES` (15) and an engineer is free (`route`'s own test, `ineligibleReason` included), the tick prompts that engineer with the order under a line saying why, and the ledger records the recipient. It never starts a process for it: with nobody free the order stays queued and its refusal says `not re-laned: <why>`, still in the busy-seat shape so its age keeps counting. An unreadable deferral record re-lanes nothing and says so.

## 0.14.3

### Patch Changes

- 124539a: `host:install` no longer starts a timer whose window ended on purpose: a timer systemd reports `disabled` whose window record holds a `stop` row (no newer arm marker) is written like every unit, gets no `enable --now`, and is reported `SKIPPED <unit> -- its window ended (<cause>, <ticks> ticks, <at>); arm it with shadow-window.mjs --arm`. It used to enable it, so the single remedy every message names undid what `host:check` calls `EXPECTED DISABLED -- ITS WINDOW ENDED`. A timer disabled with no stop row, one re-armed after its stop, and an enabled one are enabled as before, and the `host:check` note no longer says `host:install` would restart it (a11ign/a11ign#3484).

## 0.14.2

### Patch Changes

- 4e9fd64: An order to a live instance carries only what changed. A follow-up header no longer says "your first order and its brief still stand", a spawned engineer's first order is its identity, row, worktree, branch and the one line naming `engineer.md` (it no longer repeats the three autonomy and end-of-turn paragraphs that file now says once), and the dated incident stories in order text (`blocker-cleared`, the claim-stalled nudge and fourteen other causes) moved into the comment above the function that builds each order, leaving one clause of reason in the order.
- ad2aac7: A reviewer workspace that herdr brings back after its ending is looked at again, and a pane stopped at an interactive prompt is reported (a11ign/a11ign#3458). The reviewer teardown walked the registry's keys and nothing else, and an ending deletes the key, so when herdr restarted in the same second and restored the closed workspaces of `reviewer-agent-org-35` and `-36` (2026-10-02) they sat at Codex's working-directory picker for two days. The sweep now also takes every workspace on the listing that carries an instance's label and has no registry key, asks its pull request's own repository, and ends it with the same ledger line when that is closed or merged; an open or unreadable state, a working pane, `reviewer-1` and `reviewer-2`, and a label held by two workspaces are left. A new `org-health` signal, `pane-stopped-at-a-prompt`, offers `ceo` any pane that is not working and has shown Codex's picker or a trust prompt for over fifteen minutes, naming the session, the pane and how long; the first sighting is kept in `pane-prompts` beside the ledger because herdr stamps no time on a screen.

## 0.14.1

### Patch Changes

- 03704ef: A SENT `incident:` or `stall:` message now ends with `Impact:` and **`Being done:`** (it was `Doing:`): the newest comment an org account left on the open row whose body carries `Incident: <key>` (label `incident`), quoted with its age, or `nobody has picked this up yet` when no such row is open, or `I could not read it` when the read failed (the event is still sent). A CLEARED message gains `Lasted: at least <span> (counted from the message that told you)`, read from the ledger through the new `readEpisodeStart(key)` reader, and `not known` when it cannot be read. `readFixRow` changes shape (a row and its newest org comment, not a row and its holder) and now makes up to two `gh api` calls; `watch.mjs`'s read-only allowlist admits `issues/<n>/comments`. The hold-down, the key and `firstSeenAt` are unchanged (a11ign/a11ign#3419).

## 0.14.0

### Minor Changes

- a94d56a: The liaison can record what the chairman said on a row and fix what he says is wrong, through two commands and nothing else (a11ign/a11ign#3417). `chairman:record --row=N --message=<ref>` (his words on stdin) writes one row comment, quoted with its HTML comment markers escaped and opening `Recorded by liaison from the chairman's message <ref>; not written by the chairman`: it never carries the listener's `Chairman answered via Telegram` line, which only the listener may write. `chairman:correct --row=N --message=<ref> --as=withdraw|reroute|re-ask` is a closed set: `withdraw --reason=stale|wrongly-labelled|already-done` removes `needs:chairman` with a comment and writes a `withdraw` ledger line; `reroute` sets `answer:product-manager` and no other label; `re-ask` writes a new brief, refused unless the watcher would send an alert for it. Every command refuses a `--message` ref that is not an accepted inbound line in the ledger, and (but for a `re-ask`'s brief) words that are not the ones the ledger hashed, so nothing is written for a message the chairman did not send; a failure between two steps is resumed by the next call and not repeated. An agent with a shell can still write any comment with `gh`: this makes a recorded answer detectable against the chairman's chat, not impossible.

## 0.13.0

### Minor Changes

- 02ded8f: A standing lead (`ceo`, `product-manager`, `orchestrator`) is no longer `/clear`ed before every order: when its previous order landed 30 minutes ago or less and its window reads at or under 100k cache-read tokens (50% of 200k) it keeps the window and is typed the follow-up shape; recent and over that it is `/compact`ed; older, or whenever the previous order's time or the transcript cannot be read, it is cleared and typed the whole first-contact order as before. Both numbers are unmeasured starting constants (`KEEP_WITHIN_MS`, `KEEP_FILL_TOKENS`, `wake.mjs`). `deliver` and `clearThenPrompt` take the one decision (`prepareContext`), the time of each landed order is kept beside the ledger (`last-order/`), and a kept lead's follow-up says what its window holds from earlier turns is a reading at a moment. The batched-wake header and `prompt:session`'s output and queued-order notice say what THIS delivery did (kept, compacted or cleared) instead of the sentence that was true only of a clear. Reviewers, spawned workers and persistent seats are unchanged (a11ign/a11ign#3440).

## 0.12.0

### Minor Changes

- 97222d5: The chairman's request message now carries buttons (a11ign/a11ign#3423). The Telegram provider declares `buttons: true` and draws `actions` as `reply_markup.inline_keyboard`, and `messaging:watch` hands each `needs:chairman` request its options (or Approve), Explain more and Later; the answers path read `callback_data` and the brief offered options, but nothing had ever drawn a button, so the chairman could only type. A button's `callback_data` is a closed vocabulary (`ans:<option id>`, or `act:` plus `approve`, `done`, `stuck`, `later`, `explain`, `forme`): anything else is dropped with a hash and never forwarded. A press resolves the request (an option, `approve`, `done`), snoozes its reminders for 24 hours (`later`; the label stays), or queues one order for the `liaison` (`explain`, `stuck`); a press on an answered message is told so and its keyboard is removed. Events gain an optional `actions` list that the core hands to a provider that declares `buttons`, and never to a cleared notice. `converse.mjs` queues for the `liaison` as well as `ceo`, through the same single call.

## 0.11.1

### Patch Changes

- 4fe9e8f: `chairman:reply` now hands `createGhReaders` the files `{{fleet.workers-up}}`, `{{fleet.workers-down}}` and `{{gate.last-tick.age}}` read: the two `fleet-watch` files under the project's `runs/`, and the work-tick completion record beside the wake ledger (as `messaging:watch` names them). The wake ledger's directory is resolved when asked, so a host that cannot name it costs `{{gate.*}}` alone, with a diagnostic on stderr, and the command still loads outside a configured host (a11ign/a11ign#3446).

## 0.11.0

### Minor Changes

- bdf181c: The host runs ONE agent-org version, the newest release tag (a11ign/a11ign#3443). `update-tool` fetches tags by name and checks out the newest `vX.Y.Z` (numeric order; a pre-release and a name such as `latest` are ignored) instead of `origin/main`, prints `agent-org vX.Y.Z (<sha>)`, and with no matching tag refuses and leaves the checkout where it is, with no fallback to `main`. `host.json`'s new `toolVersion` is `"latest"` (the default) or one `"vX.Y.Z"`, which pins the host there: pinning the previous tag is the whole of a rollback, and any other value is refused by name. A move restarts the long-running units (`systemctl --user try-restart` of the chairman listener) so no process keeps the old modules, `chairman-listen` and `chairman-watch` render `node <tool>/src/messaging/*.mjs` in tool form, and `work-tick` prints `agent-org vX.Y.Z` as the first line of each tick (`liveToolVersion` is the reader a report can call).

## 0.10.0

### Minor Changes

- 433b9c2: A finished draft no longer waits behind a busy session, and a wait is no longer silent (a11ign/a11ign#3448). **The ready-flip**: a `convinced` draft whose verify stamp is RED (typically "no worktree is at this head", because its author works on another host) is marked ready by the gate with no session woken when every REQUIRED check is settled green at its head; the stamp stays the rule when the required list could not be read, when a required check is red, running or absent from the head, and for `pr:open` without `--draft`. The tick now reads the required-check list when a green draft is open as well as when anything is red (`requiredWhenRed` is `requiredWhenNeeded`). **A deferred order is a stall**: the busy-seat deferral limit is 15 minutes (was 60), and an order deferred that long, or a standing seat's queue whose oldest order is that old, is raised to `ceo` as the `order-deferred-too-long` org-health signal (one constant, `ORDER_STALL_MINUTES`, with its measurement beside it). **The GraphQL pool**: the off-board read now asks for `viewer { login }` and `rateLimit` (never charged), and an account's pool below 20% is raised as the `api-pool-low` signal naming the account, the pool and the reset.

## 0.9.1

### Patch Changes

- cb8825d: A release of a declared package is told to the chairman in one line (package, version and the first sentence of its release notes, with the release page last), where before nothing read releases and three in 75 minutes went unheard. The watcher reads each code repository `project.json` declares; the first read of a repository records its existing releases as seen and tells none of them, and a draft or a pre-release is not told. A release with empty notes says no summary was written. This registers the `release` event kind in `event.mjs` and `core.mjs` (told once, never reminded, not silent) and admits `gh api repos/<owner>/<name>/releases` in the read-only allowlist.

## 0.9.0

### Minor Changes

- 1c7f588: The chairman's chat messages are now queued for `liaison` and for no other session (`RECIPIENT`; the scan over `src/messaging/` still finds one caller and one label, and `ceo` is named nowhere in `converse.mjs`). The chairman is told `Got it, looking.` BEFORE the queue is written, in the same words each time and with no model in it; a refused queue, an absent seat or an entry not found in the queue file is told in words (`I could not reach the liaison: <the queue's refusal, verbatim>. Nothing has been done with your message.`), with no fallback to `ceo`. The handoff id stays in the ledger and no longer reaches the chat, and the ledger's inbound line gains `ackAt`. `provenanceText` no longer tells its reader not to answer with `prompt:session`: that is the liaison's brief (a11ign/a11ign#3416). Not to be merged-and-deployed on a host without the liaison seat running (#3415, E2).

## 0.8.5

### Patch Changes

- 8460e7c: `chairman:reply`'s closed vocabulary gains four checked facts for the liaison: `{{fleet.workers-up}}` and `{{fleet.workers-down}}` (worker NAMES only, from the two files `fleet-watch` writes, refused when either is more than 130 minutes old or the roster is empty), `{{gate.last-tick.age}}` (the tick's completion record) and `{{release:OWNER/REPO.latest}}` (the newest published release). Each is stamped by the send's `as of`, a failed read refuses the send and names which, and `PLACEHOLDER_NAMES` exports the list so the liaison's brief can be tested against it. `createGhReaders` takes the file paths from its host; `chairman:reply` does not pass them yet, so the fleet and gate placeholders refuse there until it does (a11ign/a11ign#3420).

## 0.8.4

### Patch Changes

- 2e3d335: The chairman's inbound classifier no longer forwards a credential typed in plain words. `My password is: <value>` was forwarded, written to the handoff queue and reply-quoted in the acknowledgement, because the one key-then-value pattern needed whitespace straight after `is` and the colon ended it; `pw: X`, `here's my password X`, `my password X` and a bare pasted token passed the same way. A credential word (`password`, `passwd`, `passphrase`, `pw`, `pwd`, `secret`, `api key`, `private key`, `credentials`, and the weaker `pass`, `pin`, `token`, `login`) with a value beside it after `is`, `was`, `are`, `:`, `=`, `-`, `->` or whitespace, and the value-first form (`<value> is my password`), are now dropped; so is `ASIA` (temporary AWS) beside the shapes the ledger's redactor already held. A git object name (40 or 64 hex digits) and a lowercase hyphenated slug (a branch name) are no longer dropped by the 32-character catch-all, which took both. A new `withhold` verdict covers one 16+ character token that mixes three of lower, upper, digit and symbol: it is handled as a drop (deleted from the chat, no hash in its ledger line), the chairman is told "That looks like a credential, so I haven't passed it on; send it again with 'not a secret' if it isn't", and a resend containing `not a secret` passes this tier only, never a definite shape. A drop or a withhold is sent without `replyTo` (it already was; a test now pins it), so the chat does not render the message above the reply.

## 0.8.3

### Patch Changes

- 9d12c24: A request alert reaches the chairman as a brief and not as a ticket with a header: the message opens with `What is happening:` and carries `Ask`, `Only you because`, `Checked`, `How long` and `Unblocks`, the row's number and title appear nowhere in it, and the link is its last line. A brief that offers options (a `chairman-options` block, well-formed or not) must also carry `Recommend` and `Trade-off`; one that offers none must carry `Not the chairman's Claude session because`. A brief missing a required line is refused as before (`alert not sent:`, naming each missing label, logged once). The ledger's `text` field now holds the message as sent, link included (a11ign/a11ign#3412).

## 0.8.2

### Patch Changes

- 50ab14b: `createReaders` gains `readFixRow(key)`, so the `Doing` line of a SENT incident or stall can name the open row that holds the fix instead of reading `not known`. A fix row says which incident it fixes by a label named for the event key (`incident:trunk-red`, `stall:no-merge`), and the holder is its `session:<name>` label. The reader returns `null` only when GitHub answered and no open row carries the label, and throws when it could not be asked (a11ign/a11ign#3439, follows #3424).

## 0.8.1

### Patch Changes

- bf64d78: A SENT `incident:` or `stall:` event now carries two more lines after what started: **Impact** (a fixed table keyed by the event's own key: `Nothing can merge.`, `No worker can be woken.`, `Captures are paused.` and so on, `not known` for a key with no entry) and **Doing** (read once through the optional `readFixRow(key)` reader: the open row and its holder, `no row is open for this yet` only when the reader says `null`, and `not known` when the reader is not wired, throws or returns a non-row). The "cleared" text, the event's key, `firstSeenAt` and the core's hold-down and dedupe are unchanged, and a failed fix-row read never withholds the event. `readFixRow` is not wired in `readers.mjs` yet, so Doing reads `not known` until it is (a11ign/a11ign#3424).

## 0.8.0

### Minor Changes

- d055e5c: `messaging:measure` reads how fast the org acknowledges and answers the chairman from the delivery ledger, for a window (`--window=<n>h`, default 24h): per message from the chairman, seconds to acknowledge and seconds to the first reply that names it (or `unanswered`), and asks sent, answered by the chairman, withdrawn (cleared with no answer before it) and refused by the brief rule. It writes nothing and judges nothing; a window with no lines prints `no messages in the window`, never a zero rate. `chairman:reply --to <messageRef>` (the flag was `--reply-to`) now refuses a ref no inbound ledger line holds, so a reply's `replyTo` always names a message that exists; without it `replyTo` is still `null`, and such a reply answers no message in the reading.

## 0.7.9

### Patch Changes

- a8d857e: A claim that names no branch and no worktree (a host act, a fleet or lab reading, a hand-claim) now writes its own claim record, `Claimed-nothing: <reason>` under the marker, instead of nothing. The stall check used to skip such a claim with `claim-stall: #N carries session:S but no claim record names when or where -- not evaluated` on every tick, so an abandoned one could not be told from a live one; it now reads the record's own time and the claimant's comments like any claim, and the nudge applies. A claim with no git object is never released by the stall check: a stalled one stays `nudged`, and the blockedBy and gone-holder releases ("holds nothing built") leave it held. A release is still spelled `released by` with no field, so the two never share a spelling, and releasing a nothing-claim posts the release record so a later claim that wrote nothing does not inherit the old one's time (a11ign/a11ign#3407).
- 31a5608: The daily summary is opt-in and an absent `messaging.summary` means off (chairman, 2026-10-04: "the chairman does not want a daily message"; a11ign/a11ign#3410). It had defaulted to 08:00 London, so a host that never declared one sent `summary:2026-10-03` and `summary:2026-10-04`. `parseMessagingConfig` now returns `summary: null` for an absent key and `runWatch` then constructs no summary source, so nothing is read for it and nothing is sent; a present key (`summary: {}` included, which takes `DEFAULT_SUMMARY`'s fields) works as before, and a malformed one is still refused. `messaging:check` says `no daily summary` rather than a time. `DEFAULT_SUMMARY` is now the field defaults of a declared summary and no longer a default for an absent one.

## 0.7.8

### Patch Changes

- 7105923: The isolation gate's copy skips an `@a11ign/*` dependency that has no sibling directory when it is spelled as a caret or tilde range (`^0.1.0`, `~0.1.0`), because that is how a package consumes one published from another repository and npm fetches it from the registry; a sibling that exists is still packed, and any other spelling with no sibling still fails. This matches the original, which `agent-org-wiring.test.ts` compares (a11ign/a11ign#3403, move 6 of #69).

## 0.7.7

### Patch Changes

- 801ec25: A row labelled `needs:chairman` whose newest chairman-side event (a comment by the chairman's own login, or an answer comment opening with the messaging provenance line) is newer than its newest `labeled` event now orders `ceo` (`chairman-answered`) to take the label off or re-ask, keyed on the row and the event's time so it fires once per new event. Two REST calls per labelled row and none when nothing carries the label; a row whose timeline could not be read is reported on stderr, never counted as unanswered (a11ign/a11ign#3390).

## 0.7.6

### Patch Changes

- 279a54c: The call-count signal leaves out a claimed row that declares a wait (`needs:chairman`, `answer:<session>`, a `blockedBy` edge, a future `Not-before:`, `parked`, `blocked`, `hold:*`), and counts a row whose wait has been lifted from the lifting rather than from the claim, so a standing seat's work elsewhere during the wait is not charged to the row. The lifting is read once, from the row's events, for a row already over the threshold, and a refused read keeps the whole window and says so on stderr (a11ign/a11ign#3384).

## 0.7.5

### Patch Changes

- 61af713: A keyed repository's dependency change no longer costs a reviewer. When the clone's `node_modules` lacks a package the pull request's `package.json` declares, the tick installs into the REVIEW TREE (`pnpm install --frozen-lockfile --ignore-scripts` when the tree has a lockfile, `--no-lockfile` when it has none) instead of refusing; the shared clone is never written. When that install fails the refusal names the first line of pnpm's failure and a hand remedy that works over a clone that already has a `node_modules`: `rm -rf <clone>/node_modules && cp -a <tree>/node_modules <clone>/node_modules`. The old `mv <tree>/node_modules <clone>/node_modules` moved the tree's directory INTO an existing one (`node_modules/node_modules`) and left every package missing.

## 0.7.4

### Patch Changes

- 8f1813f: A `sent` ledger line records `silent`, the flag the provider says it APPLIED (a boolean, or `null` when the provider returned none), so "was the summary silent" is answerable from `ledger.jsonl` and no longer only from a reading of the code path (a11ign/a11ign#3385, found closing #2905). It is the applied flag and not the requested one: a provider that drops `silent` records `false`. Lines already written carry no key and stay so.

## 0.7.3

### Patch Changes

- 00c26a8: The work gate lifts a pull request's `hold:*` itself when every `Waiting-for:` it declares is `merged` or `closed` and true, through `pr-hold.mjs --release` (which re-arms a pull request that carried `rearm-on-release`), instead of ordering a possibly busy session to remove one label. A hold on a row, a label or unreadable condition, `manual`, an `answer:*` and `blocked` stay with a session, and a release that fails falls back to the old order (a11ign/a11ign#3364).

## 0.7.2

### Patch Changes

- 0b02579: `src/merge-guard/merge-ref-staleness-rule.mjs` is deleted, with its test: `fetchMergeRefBehindBy` ran `git fetch origin pull/N/merge`, `rev-parse` and `rev-list` with no `cwd`, so a caller on the tick would have read the tool's own checkout instead of the project's, and nothing called it. `mergeRefIsStale` and `mergeRefStalenessReason` had no caller either (`git grep` at `origin/main` found only the module's own test), so they go too rather than wait for one. (a11ign/a11ign#3367)
- 95e907f: `pr:open create ...` and `pr:edit edit ...` no longer reach `gh` as `gh pr create create` (a11ign/a11ign#3357). The command table already supplies the mode (`FIXED_ARGS`), and the program's own usage text spells it, so an author following the usage text lost a turn to a failure that said "nothing was created". `planInvocation` now drops a leading repeat of the table's fixed arguments, so `pr:open --title ...` and `pr:open create --title ...` are the same command; a `create` later in the arguments (a title) is left alone.

## 0.7.1

### Patch Changes

- e29309d: The gate compares a row with the whole of a pull request of more than 100 files instead of dropping it: `gh pr list --json files` returns the first 100 and `comparablePrFiles` refuses a short list, so a row overlapping the 146-file version PR was offered every tick and refused at the spawn (30 ticks, 2026-10-03). `readPrs` now pages a truncated PR's files through REST, as the claim does, caches the list by PR number and head sha in the state directory (`truncated-pr-files.json`, newest 20), and, when paging fails, leaves the PR out of the comparison as before and says so on stderr.

## 0.7.0

### Minor Changes

- d11317e: A pull request is marked ready only on a green verify stamp for its head (a11ign/a11ign#3215). `pr:open` refuses a create WITHOUT `--draft` when the project's `verify --check` is not green for this head and this body, naming the reasons and the command that makes it green; a draft opens on a passing body alone. The gate's `gh pr ready` after a `convinced` verdict is withheld on the same reading, and the author (not `product-manager`) is told once per patch. The stamp is read through the project's own script, never re-run: a project declares verify by having a `verify` script in `package.json`, and answers `--check [--draft-body=<file>]` with exit 0 or 1 and `  - <reason>` lines. **A project with no `verify` script is not refused**, and `pr:open` says `no verify declared for <name>`. `main` takes the reading as a `verifyStamp` dependency wired in the entry block, so a caller of `main` is unchanged.

## 0.6.1

### Patch Changes

- 113e15e: A refused chairman alert is logged as `alert not sent: …`, no longer under the `chairman-options:` prefix: `messaging:watch` prefixed every request problem with it, so the refusal added in #122 was filed under the name of the malformed options block and a grep for options problems found refusals too. A request problem now names itself where it is made (`requestEvent`), and the watcher adds nothing. A malformed options block is still logged as `chairman-options: …`, and the ledger's note carries the same text.

## 0.6.0

### Minor Changes

- 422f9a2: A `needs:chairman` alert states the act, or is not sent (a11ign/a11ign#3335). The alert is the row title plus three lines read from the newest org brief on the row (`brief for the chairman` from an OWNER, MEMBER or COLLABORATOR): `Ask:` (the one-line act), `Only you because:` (why no session can do it) and `Checked:` (what was read just before the label went on, and when, that shows the act is not already done). A row with the label and no such brief, or a brief missing any of the three, sends nothing; the reason names the missing lines and goes through the same note channel as a malformed `chairman-options` block (written to the ledger once per distinct reason, and logged). The row stays labelled, so a refusal is never read as the label going and nothing "Cleared" is sent for it. **A project that pins this tag must have its sessions write the three lines in the brief**, or its chairman alerts stop; the first line of the brief is no longer quoted, since `Ask:` replaces it. `Checked:` is a claim the source cannot re-read. The `chairman-options` block is unchanged.

## 0.5.0

### Minor Changes

- de971e0: `row-file --board=<n> --lane=<owner> [--session=<name>]` boards a row that already exists (a11ign/a11ign#3330, for #3328's sweep of `regression` rows filed under `github.token`, which cannot resolve Project 1). An OPEN row on no board gets the Project item, Status Ready, then `ready` and `lane:<owner>` ADDED beside the labels it carries, and the read-back confirms all three. A row already on the board in any Status is left alone (exit 0, says so); a closed row, a claimed row, a body `--promote` would refuse, an unreadable board status and an unknown lane each change nothing and exit 1. `--board=` takes no flag but `--lane=` and `--session=`, and a malformed value never falls through to filing. `boardAndVerify` gained `session: null` (skip the Filed-by read-back for a row somebody else filed) and `lead` (its refusals no longer say "FILED as #n" of a row that already existed).

## 0.4.2

### Patch Changes

- e3da32f: The whole-suite resolver follows a script's delegation through the project's pnpm passthrough, `node scripts/pnpm.mjs run <script>`, as well as `pnpm run <script>` (a11ign/a11ign#3151). It matched only the second, so a project whose `test` script chains through the passthrough (to run on a box with `corepack pnpm` and no `pnpm` on PATH) resolved `test` to no `*.test.ts` glob and refused every whole-suite acceptance. The passthrough is recognised by its file name, `pnpm.mjs`; a runner of any other name is not followed.

## 0.4.1

### Patch Changes

- 814c4a9: The reviewers' verdict door resolves and is kept current (a11ign/a11ign#3316, found on #3311). Orders now print `$HOME/reviewer/bin/pr-review-verdict`, the path `install-reviewer-bin.sh` writes to, because `~/reviewer/bin` is on no PATH and the bare name was `command not found` for a reviewer that had finished its review. `host:check` reads the installed door against the shipped one and reports it `DRIFTED` or `NOT INSTALLED` (a clean report says `CURRENT`), and `host:install` runs the installer, which keeps the previous copy as `.bak-<stamp>` and reads the install back byte for byte.

## 0.4.0

### Minor Changes

- f25625f: `MUTATION: MISSING` is a printed line and no longer fails (a11ign/a11ign#3282, decided on #3213). `mutationRecordReport` returns `ok: true` for a diff that changes a test with no `Mutation:` record, so CI's acceptance job and `pr:open` print the omission and go on; a DUPLICATE `Mutation:` header still fails, being a body the parser cannot read as one record. The project posts the survivors of a machine-chosen mutant set as a pull request comment instead.

## 0.3.1

### Patch Changes

- d0a77c2: A keyed repository's first review's refusals each name something that works. When the clone has no `package.json` (the repository's first pull request adds it), the missing-dependency refusal no longer names `pnpm install` there, which answers `ERR_PNPM_NO_PKG_MANIFEST`: it names the install in the review tree and the move of its `node_modules` into the clone, and a clone with a manifest reads as before. A keyed reviewer herdr refuses with `blocked during startup` whose clone has no `trust_level = "trusted"` entry in the reviewer's codex config now says so, naming the file and the `[projects."<clone>"]` entry to add; any other refusal keeps its text.

## 0.3.0

### Minor Changes

- c3d33b3: A lane marked `reviewOnly` in the project's lanes file protects its owner's REVIEW, not authorship (a11ign/a11ign#3254, #1756 Ruling item 7). `row-file` derives no `lane:<owner>` label from such a lane, so a path-only pipeline row is filed `lane:any` and an engineer can claim it; a Region that also touches another lane keeps that lane's label, and `lane:<owner>` for a genuine decision is still set by hand. And the owner's own login (`ROLE_LOGIN`, `ceo` is `a11ign-ai-leads`) may no longer author or arm a pull request touching the lane: `arm-pr` exits `REFUSED` without arming, `auto-arm-sweep` skips it so it cannot undo that one job later, and `pr-open create` refuses before anything is sent. There is no override and no `Lane-exception:` form. A lane without the field behaves exactly as before.

## 0.2.5

### Patch Changes

- d398f12: The tick's `N order(s) had nowhere to go` summary no longer counts a Ready row that is only waiting for a free engineer seat (a11ign/a11ign#3266). A `ready-row-unclaimed` offer refused because every seat in the roster is `working` or holds its one row (#2407), with or without the `MAX_SPAWNS_PER_TICK` tail, is written `DEFERRED ... (waiting <m> min; retried next tick)` and does not make the tick exit 1, as a seat mid-turn already was (#3029). Past `CAPACITY_WAIT_LIMIT_MS` (30 minutes, sized from the 67 capacity waits of 2026-10-01 to 2026-10-03 that ended in a claim: longest 13) it is `UNDELIVERED` with its age. A roster with an idle, drained, B2-skipped, `unknown`, `absent` or `blocked` seat, or a `; no spawn:` fault, is still `UNDELIVERED`, and `org-retro`'s idle-minutes figure counts both forms.

## 0.2.4

### Patch Changes

- 099e59a: `pr:open` and `pr:edit` now run every report CI's acceptance job runs over a body (a11ign/a11ign#3209). `checkBody` composed two (Acceptance, Closes) while the CI entry composed four, so a body with no `Mutation:` record, or a `## Measured` section with no command and output, passed `pr:open` and went red in CI (8 of 9 sampled acceptance failures were `MUTATION: MISSING`). The four are now one exported list, `CI_BODY_REPORTS`, run by `runCiBodyReports` from both the CLI entry and `checkBody`, so a fifth report reaches `pr:open` with no second edit. The diff `mutationRecordReport` needs is read from the local tree with `ACMR` and `--no-renames`, as CI reads it; one that cannot be read is `UNCHECKED` and not a refusal. The acceptance report's whole-suite NOTE now prints from `pr:open` too, because it is part of what CI prints.

## 0.2.3

### Patch Changes

- d599a63: The tick's review tree links each package under the name its `package.json` declares, not its directory's: `@a11ign/x` lands in `node_modules/@a11ign/x` and an unscoped package such as `a11ign` directly in `node_modules/`, so a reviewer's Acceptance can import a renamed package. An entry with no readable manifest is skipped, the unscoped link is the tree's own and never the checkout's, and a link whose package was removed or renamed is removed.

## 0.2.2

### Patch Changes

- ffc165d: A refusal posted for a failing check no longer dead-ends the pull request once the check is green at an equal patch (a11ign/a11ign#3199, from #3154). A verdict is valid for a patch on a base, and the patch id cannot see a defect in the base: when a `CHANGES_REQUESTED` was posted at a commit with a failing check run and the head has none, the reviewer door (`pr-review-verdict`) posts a newer review of either state, and the gate stops reading the refusal as the pull request's verdict, so the reviewer seat is asked for a fresh look instead of the author being told the rework is theirs. One decider, `refusalLifted`, reads check-run conclusions (never the review's prose) for both; an approval, an all-green refused commit, a failing head and an unreadable check all stay refused. The extra reads happen only on the equal-patch refusal path, one check-runs read per commit compared.

## 0.2.1

### Patch Changes

- e8ca25c: A merge to `main` that carries a changeset is tagged and released with no version pull request: `release.yml` builds a release commit on top of the merge (the last tag's version and changelog, the changesets that tag already consumed removed, `changeset version` over the rest) and pushes it as the tag. `main`'s own `package.json` version and `CHANGELOG.md` lag the last tag, and a project pins the tag's tree.

## 0.2.0

### Minor Changes

- 6123fab: `agent-org dora` measures the four DORA metrics (deployment frequency, lead time for changes, change failure rate, time to restore) for each repository the project declares, from the npm registry or a repository's GitHub Releases, its merged pull requests, its `regression` rows and git ancestry, and never from the org's own state. The daily retrospective carries the block and trends each number against the previous reading. A source that cannot be read is `unknown`, a metric with nothing to measure is `undefined`, and neither is ever 0. `.agent-org/project.json` gains an optional `dora` list (`repo`, `release: { kind: "npm", package } | { kind: "tag" }`, `releasablePaths`).

### Patch Changes

- 071fb5c: `agent-org dora` reads a declared repository with no release yet as `no release yet`, not `unknown`: an npm package the registry answers 404 for (never published, told from a network error), a repository with no release and no merged pull request, and a repository whose issues are disabled (no `regression` rows can exist) are answers rather than refusals, while a reader that throws is still `unknown`. The reading also says which npm package it reads: one per repository, so a release of another package in the same repository is not a deployment.
- a1a9070: The work gate tells a pull request's owner when a required check has been running for more than an hour on a non-draft pull request: it used to be classified `progressing` for as long as it ran, and a check that hangs never stops, so a pull request held for review sat four hours with nobody told. The new stall reason `hung-check` is read from the `startedAt` the gate already has (no new API call, no timer), is keyed on that start so a re-run that hangs again is a new order, and is filed under `pr-checks-failing`.
- cf0a47a: A keyed review checkout is refused, not handed over, when the repository's clone lacks a package the pull request's `package.json` declares: the reviewer used to start on a tree that could not run its tests and die on `ERR_MODULE_NOT_FOUND`. The refusal names the missing packages and the `pnpm install --no-lockfile` that supplies them. `package.json` now declares the three packages the tests need (`tsx`, `yaml`, `typescript`) as `devDependencies`.
- 52017dc: `pr:open` run from another repository's worktree without `--repo` now says so on its Region refusal: it read the tree as the first repository's and refused the row's own paths in words that never named the flag, and the remedy it did print (`Outside-Region:` lines) led a session to write false statements into the PR body. The refusal names `--repo <repo>` when `origin` is a code repository the project declares. A Region path written with a trailing parenthetical (`agent-org:src/x.test.ts (new)`) is now read as the path, as `#3134` was filed.
- f852707: `messaging:watch` can now send: the Telegram provider is registered in its default `providers`, built from the token file and the chairman file the `messaging` key names. It was written and never registered, so every run exited 1 with "no implementation of it yet" and the `chairman-watch` unit never sent the chairman anything; every test injected its own provider, so none could see it. A token file at the wrong mode, or a checkout never paired, now ends the run with a line naming that file and exit 1, with no stack trace and no secret. `main` takes an injectable `fetch`, and a provider factory is called with `(config, { fetch, log })`.
- 681637d: The release workflow's version pull request step now fails when `gh pr create` fails. It piped `gh pr create` into `tee` under the runner's default `bash -e`, which has no `pipefail`, so the pipeline took `tee`'s status and a pull request that could not be opened (`GitHub Actions is not permitted to create or approve pull requests`) left the job `success` on four runs. The URL is captured first and then printed. `release-safety.test.ts` ran the steps under `bash -eo pipefail`, stricter than the platform, and so could not see it: it now runs them under `bash -e` and asserts the shell is not `pipefail`.
- 3db20b5: Every remedy, order and usage line the tool prints says `pnpm run ...` where it said `npm run ...` (and `pnpm exec` where it said `npx`), with the `--` dropped because pnpm hands a literal `--` to the script. `host:check` now reports a `pnpm` that is not on the PATH, or whose version differs from the project's `packageManager`, as a finding that `host:install` does not fix. An acceptance written `pnpm test` or `pnpm run test:all` is recognised as the whole-suite form, as `npm`'s spelling always was, and a release-gate record written by `pnpm run` (whose script banner carries the working directory) is read as the stage it names.
- 256e423: A Telegram send whose `fetch` rejects (no response at all) is now a `TelegramSendError` like every other failed send, so it is logged, and on part 2 or later of a split message it says how many parts WERE delivered; it used to pass through unannotated and unlogged, and the core's whole-message retry then sent the chairman a duplicate with no stated cause. Every request now has a 30-second deadline (`deadline`, injectable like `sleep`), after which it is abandoned and reported as a failure rather than holding the send until the process is killed.
- 0746122: The `row-branch-unshipped` order no longer tells `product-manager` to "open its pull request" or "delete the branch" for a row whose branch already carries an OPEN pull request (the second closes it). It names the PR and the `claim --adopt=<previous holder>` route that finishes it, read off the open-PR list the tick already holds, so no API pool is spent. A branch with no open PR gets the order it always did. `claim`'s own refusal of a row whose branch is on `origin` (#2014) is unchanged.

## 0.1.0

### Minor Changes

- First release: agent-org installs as a git dependency (`github:a11ign/agent-org#semver:^0.1.0`) and serves the repository it is run in, with a `bin`, a command table and no registry.
