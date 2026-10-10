---
"agent-org": patch
---

The Haiku trial report (`src/trace/haiku-tier-report.ts`) counts a closed row whose closing pull request names no repository it can read as `unresolved`, and prints that count with the rows that have no closing pull request, in the header of each block: `n=<k> closed (<m> with a merged pull request, <p> with no closing pull request, <u> unresolved)`. It had stopped the whole report on the first such row (a11ign/agent-org#530), which hid every other row; and where it did not, a row it could not resolve would have read as "none merged". With any unresolved row, `first-pass merge` and `review rejections per PR` say `none merged (<u> unresolved, so not a reading)`. a11ign/agent-org#689.
