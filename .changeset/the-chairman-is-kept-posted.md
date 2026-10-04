---
"agent-org": patch
---

"Keep me posted on X" is recorded once and told when X changes state. `pnpm run chairman:watch -- add <row|pr|run|unit> <id> --message=<ref>` writes a `direction: "watch"` ledger line naming the thing and a message of the chairman's the ledger took in (an unknown ref, or a thing the placeholder vocabulary's readers cannot read, is refused and writes nothing); `list` and `remove` answer "what are you keeping me posted on" and end a watch without a message. Each tick the new `watched` source reads every active watch through those readers and offers `watch:<thing>` (`<what it is>: now <state>`) when the state differs from the last one told, and a watch ends when its final state (a row closed, a pull request merged or closed) has been told, derived from the ledger, so a final send that failed is offered again. A `run` cannot be watched yet: the vocabulary reads a run only once it has concluded.
