---
"agent-org": patch
---

A refusal posted for a failing check no longer dead-ends the pull request once the check is green at an equal patch (a11ign/a11ign#3199, from #3154). A verdict is valid for a patch on a base, and the patch id cannot see a defect in the base: when a `CHANGES_REQUESTED` was posted at a commit with a failing check run and the head has none, the reviewer door (`pr-review-verdict`) posts a newer review of either state, and the gate stops reading the refusal as the pull request's verdict, so the reviewer seat is asked for a fresh look instead of the author being told the rework is theirs. One decider, `refusalLifted`, reads check-run conclusions (never the review's prose) for both; an approval, an all-green refused commit, a failing head and an unreadable check all stay refused. The extra reads happen only on the equal-patch refusal path, one check-runs read per commit compared.
