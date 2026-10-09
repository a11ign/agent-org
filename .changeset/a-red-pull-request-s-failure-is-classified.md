---
"agent-org": patch
---

`src/ci-failure-class.ts` classifies a red pull request's failure as own defect, flaky, another repository changed or infrastructure, and names its route (owner, one rerun, a cross-repo incident, a rerun after the reset). It asks the decision provider (use `ci-failure-class`) over the trimmed error lines and code-computed facts, and takes the deterministic rule with no provider, no key, the use off, a refusal or a confidence under the floor. Nothing calls it yet: the `work-gate.ts` call site is its own row. a11ign/a11ign#4632.
