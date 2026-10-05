---
"agent-org": patch
---

`trace-publish` reads the rows closed in the last seven days from the REST issues list, not the search API (a11ign/a11ign#3695). `recentClosedRows` lists `repos/<repo>/issues?state=closed&since=<ISO time>` on the `core` pool, which holds every issue closed since the time, and filters by `closed_at` and by the absence of `pull_request`, so the record issue (#928: commented on all day, closed in September) is updated inside the window and still not returned. It reads one counted call per 100 issues where the search read one, and a list not finished in 30 pages is refused rather than cut short. `NO SEARCH` in `trace.test.mjs` no longer names an exception: no source of `src/trace/` reads the search API.
