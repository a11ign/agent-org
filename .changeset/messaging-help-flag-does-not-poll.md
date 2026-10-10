---
"agent-org": patch
---

`messaging:pair --help` and `messaging:listen --help` print the usage and exit 0 instead of running the poller (a11ign/agent-org#513). Both entry points ignored every flag they did not read (`pair` took `--root=` only, `listen` took no `argv` at all), so a reader's first `--help` started a Telegram `getUpdates` long-poll, which Telegram answered with a 409 to the chairman's listener: it exited 2 and left the chairman's messages unread for about three minutes. Both now parse their flags with `node:util` `parseArgs` in strict mode BEFORE the config is read, a secret is read, a lock is taken or any request is made; an unknown flag, or a positional, is refused by name with the usage and exit 2. `pair` keeps `--root=<dir>`; `listen` accepts none but `--help`.
