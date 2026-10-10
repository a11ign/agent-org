---
"agent-org": patch
---

The retro's "Claim-stall voidings" counts only the claims that stopped moving (`stalled`, `gone`). `releaseStats` counted every release but `merged`, so a declared wait, a block or a closed row moved the headline number (2026-10-10 read 20, of which one was a stall). Those releases are now reported beside it as `otherReleases`, and `RELEASE_REASON_KINDS` classifies every reason in `ReleaseRequest["why"]`. a11ign/a11ign#4689.
