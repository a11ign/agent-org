---
"agent-org": patch
---

`agent-org agent-tool:update` is the one owner of a Codex (CLI and daemon) and Claude Code version move. It reads the three installed versions, moves only the tools behind their target, smoke-starts a Codex reviewer and a Claude worker headless after the move, and reverts a move whose smoke stopped on a dialog with one `tool-drift-interactive-prompt` incident naming the tool, both versions and the pane text. It refuses while a seat is mid-turn unless told which sessions to let finish, and names a revert that failed. `host:check`'s `CODEX CLIENT AND DAEMON DISAGREE` detail now names it as the owner. a11ign/agent-org#462.
