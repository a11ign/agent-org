---
"agent-org": patch
---

The day's board edition no longer judges the comments of a CLOSED row. `commentsToJudge` skips a row whose `state` is `CLOSED`, and `readProseFacts` now marks the rows its issues read lists as closed (that read is `state=all`, so a row closed hours ago was judged like an open one). On the first edition run of #4250 (2026-10-09T23:00Z) 23 of 24 flagged rows were closed and 21 of them went to `product-manager` as `answer-owed` orders at once, which tripped `order-deferred-too-long`. An OPEN row's comments are judged exactly as before, and a row with no `state` is too. agent-org#573.
