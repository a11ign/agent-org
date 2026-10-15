---
"@a11ign/agent-org": patch
---

The daily retrospective now reads only what changed since its last tick: merged pull requests are walked above a per-repository mark kept in the retro state entry, and `.acceptance/` contents are cached by merge commit there. A tick logs a `RETRO READS` line with the pages, lists and acceptance reads it made and the seconds each took. Incidents and the `unknown` on a refused read are unchanged.
