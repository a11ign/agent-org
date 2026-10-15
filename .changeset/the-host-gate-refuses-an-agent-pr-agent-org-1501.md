---
"agent-org": patch
---

The host gate refuses to arm an agent pull request that a11ign's `deliberateRefusals` job would have refused: a `hold:` label, a head that is not the branch's recorded tip, approvals that do not cover the head, a first commit that lacks the row's named tests, or a `Closes` GitHub will not honour (declared against `closingIssuesReferences`, and `Closes: none` against a closure). `arm-pr` and the sweep ask one verdict, `deliberateRefusalVerdict`, say the job's own reason once on the pull request, and arm nothing; a read that fails is a refusal to arm, never clear. A pull request whose head is in a fork, or whose author is no org login, is met by neither. Before, the gate armed such a pull request and a11ign's job was the only refusal (a11ign/agent-org#1501, receiving side of a11ign#5460).
