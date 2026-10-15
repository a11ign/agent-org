---
"agent-org": patch
---

The pre-push armed-PR guard no longer refuses a push to an armed, green, up-to-date PR whose review is `CHANGES_REQUESTED` or `REVIEW_REQUIRED`, since such a PR cannot merge while `main` requires an approval. Only a PR whose decision is `APPROVED` still refuses, because its merge can complete underneath the push.
