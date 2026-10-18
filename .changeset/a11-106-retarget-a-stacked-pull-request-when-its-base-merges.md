---
"agent-org": patch
---

Ticket mode retargets a stacked pull request to the repository's default branch when the pull request its base is merged into merges and its branch was not deleted, so the stacked one no longer stays aimed at a dead branch (a11ign/agent-org#1749). The board's run says `Needs retarget` for a base whose branch is gone with nothing merged on it, and for a retarget GitHub refuses, and the worker brief tells a stacked worker to expect a stale base. The stack step asks for a pull request, not a draft pull request (A11-106).
