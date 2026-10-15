---
"@a11ign/agent-org": patch
---

The board-truth audit no longer flags an open epic whose children are all closed while its body carries a `Not-before:` date still ahead, or a `Waiting-for:` condition not yet true (agent-org#840, a11ign#4425 re-raised three times on 2026-10-11). The epic is flagged again once that wait comes true. A condition that cannot be read is not held, so it still flags.
