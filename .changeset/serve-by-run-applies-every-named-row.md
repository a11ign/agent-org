---
"@a11ign/agent-org": patch
---

`serveByRun` (`src/serve-by-run.ts`) applies every row a class names in its answer, not only the served item (a11ign/agent-org#1133). A `ready-queue-empty` answer that posts on several rows was sent to its seat because the one-post rule refused it. Each post, with its optional change, is now applied through `applyDecision`, and every row is checked before the first is written: a post on a row the class did not name refuses the whole answer, and a row that goes stale part-way falls back with its reason naming how many rows were already written. Production is unchanged until a class declares the rows it names (`ServeByRunDeps.namedItems`); with no declaration only the served item is named, as before.
