---
"@a11ign/agent-org": patch
---

A comment the holder posts on its own row is a move on the claim, whatever account the claim record was written under. `commentMove` (`src/claim-stall.ts`) counted only a comment by the claim record's own account, but the record is posted by `a11ign-scheduler[bot]` and a worker comments as `a11ign-workers[bot]` (#793), so no worker comment was a move and a worker whose deliverable was a comment was nudged, then released, for finished work (a11ign#4892, second occurrence of `claimed-worker-stalled`). It now also counts a comment carrying `<!-- decided-by: <session> run: <id> -->` (agent-org#486) that names the claimant's own session; a marker naming another seat, a comment older than the claim record and a claim record itself are still not moves. agent-org#913.
