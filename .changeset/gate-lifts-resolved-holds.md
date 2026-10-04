---
"agent-org": patch
---

The work gate lifts a pull request's `hold:*` itself when every `Waiting-for:` it declares is `merged` or `closed` and true, through `pr-hold.mjs --release` (which re-arms a pull request that carried `rearm-on-release`), instead of ordering a possibly busy session to remove one label. A hold on a row, a label or unreadable condition, `manual`, an `answer:*` and `blocked` stay with a session, and a release that fails falls back to the old order (a11ign/a11ign#3364).
