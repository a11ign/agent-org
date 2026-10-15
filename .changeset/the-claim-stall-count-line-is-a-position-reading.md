---
"@a11ign/agent-org": patch
---

The claim-stall count line, `claim-stall: tracker \`agent-org\` (a11ign/agent-org): N claimed rows, N evaluated.`, is allowlisted in the repeating-lines check as a position reading (a11ign/agent-org#941). The tick prints it once per keyed tracker per tick while that tracker holds a claimed row, and `normaliseLine` turns every count to `N`, so one line repeated for 30 ticks and was offered to `orchestrator` as a fault. The faulting forms the same formatter prints (`not evaluated`, `UNREAD`, `NO claim was evaluated`, `is HELD, not released`, `could not run`) are not allowlisted and stay offered.
