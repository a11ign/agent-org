---
"agent-org": minor
---

The listener records the chat id of a channel the bot is added to, and `messaging:chats` prints it without the token in sight (a11ign/a11ign#4743, #928 row 5 of 5). Telegram allows one `getUpdates` caller, so only the listener can see the `my_chat_member` and `channel_post` updates a channel produces. `ALLOWED_UPDATES` now asks for both; `inbound.ts` classifies them as a chat notice, which is recorded once per chat as a `chat-seen` ledger line (`{chatId, type, title}`, nothing from a post's text) and is never delivered as a chairman message or a command. A notice is a new `noted` action rather than an `ignore`, because the listener leaves a group, supergroup or channel an `ignore` names. `messaging:chats` reads those lines and prints each chat's id and type; it imports neither the configuration nor the secret, so the token file's path and contents are not reachable from it.
