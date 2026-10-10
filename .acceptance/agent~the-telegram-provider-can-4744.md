The Telegram provider can edit a sent message (`editMessageText`) and pin one (`pinChatMessage` with `disable_notification: true`), both behind `capabilities.edit` / `capabilities.pin`, and `runProviderConformance` asks for them only when declared. This is the whole of a11ign/a11ign#4744, row 2 of 5 of #928.

Closes a11ign/a11ign#4744

## What changes, and why

- **The contract** (`provider-contract.ts`): `edit` and `pin` are optional booleans, checked by `capabilities-shape` when present. Four checks are conditional: `edit-changes-a-sent-message`, `edit-refuses-empty-and-overlong-text` (both on `edit`) and `pin-is-accepted` (on `pin`); a provider that declares neither reports them `skipped` with `capabilities.<name> is not declared`, never as a pass. Not asked here, on purpose: that an edit to the same text reports `unchanged: true`. That needs the provider's own wire answer, and `audience.test.ts` builds its own Telegram wire fake that does not give it, so the contract asking would break a file outside this Region. The Telegram test and the fake's test pin it.
- **Telegram** (`send.ts`): `edit` and `pin`, in plain text like `send`. "message is not modified" is `unchanged: true` and is no longer logged as a "refused by Telegram" line; `clearKeyboard` had logged the same routine answer as a refusal, and now does not.
- **The fake provider** implements both: an edit rewrites the `text` of the record in `sent` and is kept in `edits`; `pinned` is the refs pinned, once each.

## Two things the row did not say

- **`audience` on both calls.** The row's signatures are `edit({ messageRef, text })` and `pin({ messageRef })`. A message id is unique only within its chat, and the provider has two chats, so a call that names no chat could rewrite or pin a different message. `audience` is optional and absent means `ask`, which is the row's signature exactly.
- **An edit is one message.** `send` splits up to `maxText` (20,480); an edit cannot, so the Telegram `edit` refuses over 4,096 characters before any request, with a message that says so. The contract only requires the refusal at `maxText + 1`.
- **"A newer pin replaces it" is not what I expect of `pinChatMessage`**: from my reading of the Bot API it ADDS to a chat's pinned list. The row says `unpin` is not needed, and I built to that, so the consumer should pin the list once and edit it in place, which is what a ticked ask does anyway. I did not verify this against the live API (no network call was made, none is allowed on this row); the contract comment says it as the provider's behaviour, and it should be confirmed before the asks row relies on a second pin.

## Platform first, deleting first

platform: Telegram's own methods are the whole of it (`editMessageText`, `pinChatMessage`); nothing in GitHub, pnpm, systemd or git edits or pins a Telegram message.

Net lines: positive, in the three source files and their tests. `NOT_MODIFIED`, the status test and the message-id parse were already in `send.ts` for `clearKeyboard` and are now shared by it and `edit` (`isNotModified`, `messageIdOf`), so no second copy was added.

## How you verified it

The tests need `AGENT_ORG_HOST` (this worktree holds no `.agent-org/project.json`); I ran with it set to `/home/agent/repos/wt-4744/.agent-org/host.json`. The Acceptance is the row's command without its `cd /home/agent/repos/agent-org`: that path is `main`, which carries this change only after the merge. Measured on this host, at this head:

- The Acceptance (the two files the row names): all pass (`VERDICT pass: 49 tests in 2 files`).
- `src/messaging`, the whole directory: 1080 pass in 38 files, with `AGENT_ORG_HOST` set; without it the same 12 files fail to load on `origin/main` and here alike (755 tests ran on `main`, 766 here).
- `tsc --noEmit`: only the two `mjs-ratchet.test.ts` missing-module errors, which `origin/main` has too.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/messaging/providers/telegram/send.test.ts src/messaging/provider-contract.test.ts`

Mutation: the pin without `disable_notification` -> 1 red (the pin wire test), the row's own control; `disable_notification: false` -> the same 1 red; "message is not modified" never recognised -> 3 red (the Telegram conformance test, the `clearKeyboard` test, the unchanged test); every 400 read as unchanged -> 3 red (the 400-is-not-retried test, `clearKeyboard`, the unchanged test, whose control is a 400 "not found"); the empty edit not refused -> 2 red (the Telegram conformance test, the edit-refusals test). In the contract: an edit that always says `unchanged: true`, one naming another message, one accepting empty or over-long text, a pin that is missing or names another message, and a malformed `edit`/`pin` declaration each turn exactly their own check red. All restored byte-identical (`diff` against a copy taken before) and green.
