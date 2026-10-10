---
"agent-org": patch
---

The DORA reading asks a repository's ancestry of its declared clone (`clones` in `host.json`, read through `$AGENT_ORG_HOST`) with `git merge-base --is-ancestor` and `git rev-list`, after one bounded `git fetch --tags origin` when the clone lacks a commit, and keeps GitHub's `compare` as the fallback for a repository with no clone or a clone that still lacks the commit. The reading carries `ancestry` (`clone`, or `github compare (<why>)`) and the retro prints a line when the fallback was taken, so `a11ign/agent-org`'s lead time is a number and not `unknown` for a range of 1,341 commits. a11ign/a11ign#4690.
