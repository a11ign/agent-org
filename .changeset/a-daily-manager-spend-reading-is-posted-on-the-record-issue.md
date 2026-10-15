---
"@a11ign/agent-org": minor
---

A daily timer posts yesterday's `trace manager-spend` reading on the project's record issue (`units.traceWeeklyIssue`, on `tracker[0].repo`), at 07:45 London, so the manager-spend table is on the issue every morning and not only when someone runs it by hand. The post is once a day: a marker is written after a successful post, and a second run the same day posts nothing. A run exits non-zero, and posts nothing, when the trace store is absent, empty or stale (its newest event is before the reported day ends), when the reading fails, and when the project declares no record issue. A refused post is retried by the next run. The unit does not start at `host:install` and needs no `[Install]` to be started by the timer. agent-org#912.
