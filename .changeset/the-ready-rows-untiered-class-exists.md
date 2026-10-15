---
"@a11ign/agent-org": patch
---

The `ready-rows-untiered` decision class exists (a11ign/agent-org#909, Move 3 of a11ign/a11ign#4505): a ready row with no tier decision can be tiered by a one-shot run. `sonnet-line` (the default) posts `Tier: sonnet -- <reason>`; `haiku-label` posts the reason and adds `tier:haiku`, and is allowed only when the row's Acceptance is a command in a fenced block; `escalate` writes nothing and returns the order to the standing seat. The class is a file; `seatModeOf("ready-rows-untiered")` stays `seat` until a project says otherwise.
