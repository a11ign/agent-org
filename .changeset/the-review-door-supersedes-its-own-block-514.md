---
"agent-org": patch
---

The review door (`pr-review-verdict`) posts an APPROVE at an equal patch when it supersedes a CHANGES_REQUESTED the same account posted and its body names that review (its id, or `Review of #<n> at <sha8>`, on a line after the verdict line). Before, a verdict that misread the diff stood at an unchanged head with no way for its own reviewer to correct it (a11ign#4558). Every other second review at an equal patch is still refused: a same-state repeat, a CHANGES_REQUESTED over an APPROVED, an APPROVE that names nothing, and an APPROVE over another account's block. a11ign/agent-org#514.
