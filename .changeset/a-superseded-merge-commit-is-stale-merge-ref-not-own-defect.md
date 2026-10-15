---
"agent-org": patch
---

A CI run that checked out a superseded merge commit now fails acceptance as a stale merge ref, not as the pull request's own defect. Its failure said "the diff could not be read", was classed `own-defect` and routed to the owner, and a rerun reuses the same merge commit, so it could not clear it (a11ign/agent-org#1524). That failure is now classed `stale-merge-ref` and routed to a push or an update of the branch, which makes GitHub build a new merge commit. A diff that was read and a test that failed are still the pull request's own defect.
