---
"agent-org": minor
---

`ci-failure-class` and `review-depth` are now asked, not just switched on (a11ign#4888). The wake reads the facts of the first red check on a red-check order (the failing job's log, whether `main` is red at the same time, whether other PRs are red at the same time) and asks `ci-failure-class`; the class and route go in the journal line, and in the order's text when a provider answered. A reviewer start reads the PR's changed paths and the Regions of the rows it closes and asks `review-depth`: `light` runs the reviewer at `low` effort, `full` at `high`, and `.github/workflows/`, auth and security paths are always `full`. With no provider, or when a fact cannot be read, the order and the reviewer are exactly what they were.
