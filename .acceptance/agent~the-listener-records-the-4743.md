The listener is the only `getUpdates` caller there can be (a second one is HTTP 409), so a channel's id can only be learned from what it sees. The bot added to a channel produces a `my_chat_member`, and a post in it a `channel_post`; neither was asked for, so the channel's id has never been readable on the host without opening the token file. This is the whole of a11ign/a11ign#4743, row 5 of 5 of #928.

Closes a11ign/a11ign#4743

## What changes, and why

- **The poll asks for both** (`poll.ts`): `ALLOWED_UPDATES` is `message`, `callback_query`, `my_chat_member`, `channel_post`.
- **A chat notice is recorded and never acted on** (`inbound.ts`). `chatNotice` is pure: it names a chat only for exactly one `my_chat_member` or `channel_post` payload, a `group`, `supergroup` or `channel` chat, a safe-integer id that is not the chairman's own chat, and (for `my_chat_member`) a status that is not `left` or `kicked`. Anything else falls through to `acceptUpdate` unchanged, so every old drop reason (`channel-post`, `unsupported-type`, `malformed`) reads as before, and a channel post is still dropped, never routed as a message or a command. The line written is `{direction: "chat-seen", chatId, type, title}`; the title is a stranger's text, so it is stripped of control characters and cut at 128. Nothing from a post's text is read.
- **One line per chat**, deduped from the ledger itself, so a repeat, a replay and a restart write nothing more.
- **A new action, `noted`, not `ignore`.** `chatToLeave` in `poll.ts` acts on an `ignore` that names a group, supergroup or channel: an `ignore` for the channel would have made the bot LEAVE the channel it was just added to. `noted` carries no `chatType` and no `reason`, so nothing in the listener can read it as a chat to leave; `poll.test.ts` pins that the group (control) is left and the channel is not.
- **`messaging:chats`** (`chats.ts`, new) prints `<chat id><TAB><type>`, one per line, in the order first seen, and says plainly when nothing has been seen yet. It reads the ledger and nothing else: no configuration, no token file, no title. `chats.test.ts` pins that by what the file imports, with a positive control for the scan.

## Platform first, deleting first

platform: nothing in Telegram, GitHub, systemd or git lists a bot's chats: `getChat` needs the id, and `getUpdates` is the listener's alone. The only other way to the id is reading the token file by hand, which is what this removes.

Net lines: positive. By `git diff --stat`, the non-test lines added are 76 in `inbound.ts` (comments included), 48 in `chats.ts`, 7 in `poll.ts` and one each in `commands.ts` and `package.json`; the other 293 are tests. Reusing `ledger.ts`'s append-only lines and `watch` as the precedent for a non-conversation `direction` was the only reuse available; no existing reader of the ledger counts a `chat-seen` line.

## How you verified it

The tests need `AGENT_ORG_HOST` pointing at a checkout that holds `.agent-org/project.json` (this worktree has none; on `main` too, so `poll.test.ts` fails to load without it); I ran with it set to `$HOME/repos/a11y-witness/.agent-org/host.json`, the tests' own fallback. The Acceptance line is the row's command without its `cd /home/agent/repos/agent-org`: that path holds `main`, which carries this change only after the merge, and the command run there would test code without it (the row #4736's file did the same, for the same reason). Measured on this host, at this head:

- The Acceptance (the two files the row names): all pass, 67 on `main` and 76 here.
- The three changed test files and `chats.test.ts`: 84 pass.
- The full suite, `main` against this branch: 34 failed of 8035 on `origin/main`, 34 failed of 8052 here, the same 34 names; the 17 added tests pass. None of the 34 is in a file this change touches.
- `pnpm run typecheck`: only the two `mjs-ratchet.test.ts` missing-module errors, identical in the primary checkout. They come from this host's stale `@a11ign/toolchain` install (0.1.2, `package.json` asks `^0.1.5`), not from this change.

Acceptance: `npx rstest run --config scripts/rstest/rstest.config.* src/messaging/providers/telegram/poll.test.ts src/messaging/inbound.test.ts`

Mutation: the classifier treats a `channel_post` as a message -> 5 red, the row's own control (the "never routed as a command" test, the dedupe test, the forged-identity test, the listener test, and the five-drop-reasons test); the notice returned as an `ignore` naming the chat -> 6 red, among them the listener test, where it is the bot leaving the channel; the `chat-seen` line never written -> 7 red; no dedupe -> 2 red; `messaging:chats` printing the title -> 2 red; `ALLOWED_UPDATES` as it was -> 2 red; the chairman's own chat recordable, a bot that left recorded, and private chats recorded -> 1 red each; all restored byte-identical and green.

## Anything a reviewer should be sceptical of

- **Any chat the bot is added to is listed, not only the chairman's channel.** Anyone can add a bot to a group, and a `my_chat_member` for it is recorded; a message in that group is still an `ignore` the listener answers by leaving, as before. `messaging:chats` prints ids and types only, so a stranger's chat is a line on a list and not a message or an action, but the list is not "the chairman's channels". Restricting it to chats the chairman added the bot to (`from.id`) is cheap and I did not do it: a channel's `my_chat_member` `from` is the admin who added the bot, and I could not check on a live channel that it is always the chairman's id.
- **The first real reading is a host act.** Nothing here has seen a live `my_chat_member`: the shapes come from the Bot API's documentation and from the listener's existing fakes. The row's second done-when (the id printed on the host, quoted on a11ign/a11ign#928, written to the `announcementsFile` reference) is outstanding after a release and is not mine.
- **A running listener asks for the old list until it is restarted.** `allowed_updates` is sent on each poll from the constant, so the release's restart is what makes the channel visible; I did not check that a restart is part of how a release lands on the host.
- **The title is stored in the ledger and not printed.** The ledger is the host's own file; the title is kept so a person reading it can tell two channels apart, and no reader in this change prints it.


🤖 Generated with [Claude Code](https://claude.com/claude-code)
