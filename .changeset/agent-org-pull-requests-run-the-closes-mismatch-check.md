---
"@a11ign/agent-org": patch
---

A pull request of agent-org is now run through `closes-mismatch-check` in agent-org's own CI (a11ign/agent-org#863). The check ran only in a11ign/a11ign's `ci.yml`, whose repository argument defaults to a11ign/a11ign, so no agent-org pull request had ever been compared with what GitHub will close for it; a11ign/a11ign#4904 and #4906 were both agent-org pull requests (#782, #770), and the refusal agent-org#838 builds could not have reached them. The step is in `suite`, run from the project the job already lays the tool into (the tool resolves the project's declaration at import and refuses from a bare checkout), with the pull request's number and `github.repository` as its arguments, on `pull_request` only. `gate` needs `suite`, so a refusal, or a lookup the check could not make (exit 2), blocks the merge; `gate`'s needs are unchanged.
