---
"agent-org": patch
---

An unattended run now declines a Claude Code safety prompt raised by one of its worker's subagents, and by the main agent on Claude Code 2.1.310, which draws a bare `No`. The worker is told which subagent ran which command, the card names the subagent, and the worker brief says its subagents inherit the rule to guard every delete with `${VAR:?}` and never a bare `*` after `cd`.
