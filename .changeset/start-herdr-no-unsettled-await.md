---
"agent-org": patch
---

`agent-org start herdr` no longer ends silently with Node's "Detected unsettled top-level await" and exit 13 (A11-225): `start`, `stop` and `status` run through a new entry, `service-cli.ts`, so the move's dynamic import no longer waits on the entry's own `await`. `start herdr --move` now says each step as it finishes (unit registered, old server stopped, unit started, server answering in the unit) and ends on a result line, and a failing step names itself and its fix. Every `launchctl`, `systemctl` and `herdr` call, the unit start and the guard retirement have a time limit with a message. `start`, `stop`, `status` and `update` run through a wrapper that names the command if the process ever exits with its work unfinished.
