---
"agent-org": minor
---

A lane marked `reviewOnly` in the project's lanes file protects its owner's REVIEW, not authorship (a11ign/a11ign#3254, #1756 Ruling item 7). `row-file` derives no `lane:<owner>` label from such a lane, so a path-only pipeline row is filed `lane:any` and an engineer can claim it; a Region that also touches another lane keeps that lane's label, and `lane:<owner>` for a genuine decision is still set by hand. And the owner's own login (`ROLE_LOGIN`, `ceo` is `a11ign-ai-leads`) may no longer author or arm a pull request touching the lane: `arm-pr` exits `REFUSED` without arming, `auto-arm-sweep` skips it so it cannot undo that one job later, and `pr-open create` refuses before anything is sent. There is no override and no `Lane-exception:` form. A lane without the field behaves exactly as before.
