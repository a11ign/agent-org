---
"agent-org": patch
---

A failing check whose output says `Cleared-by: review` holds its pull request for a reviewer (`awaiting-review`, a reviewer ordered at the head, no `pr-checks-failing`), and `Cleared-by: human` files the chairman a brief instead. A check with no marker, or one unmarked failing check among marked ones, is red as before. `review-gated-unasked` reports a review-gated red pull request with no reviewer ordered for two hours (a11ign/agent-org#1538, a11ign#5528).
