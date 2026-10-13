---
"agent-org": patch
---

A reply that quotes a NOT CONVINCED review is no longer read as that verdict. `verdictAtHead` (`src/review-verdict.ts`) took a verdict phrase from any comment, so the PR author's own reply on agent-org#1352 ("Reply to the NOT CONVINCED review at `c84ce2fc`: ...") was the verdict at the head: the gate ordered `verdict-not-convinced` six times and never started a reviewer. A comment now counts only when it opens in the reviewer's form (`**Review of #<n> at ...`, or `Re-read of`) and was not written by the PR's own author. A review body counts as before, and a comment whose author is not named still counts.
