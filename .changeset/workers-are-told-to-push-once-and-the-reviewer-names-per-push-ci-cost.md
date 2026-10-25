---
"agent-org": minor
---

Every worker brief and the shipped worker house notes now carry the push-once rule (A11-261): run the repository's tests, typecheck and lint locally before pushing, push once per meaningful change, never push only to see what CI says, batch fix-ups, and keep heavy workflow jobs off a pull request while it is still a draft. The atomic reviewer is told that a change to a CI workflow that adds a per-push job without a `paths:` filter or a cancelling `concurrency:` group, or that runs heavy jobs on drafts, is a finding. The notes file of a machine that already has one is not overwritten, so the brief is what reaches its workers.
