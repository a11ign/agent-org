---
"agent-org": patch
---

`ownerOfPr` has a `dependency-bot` rung (a11ign/a11ign#4624): a pull request opened by Dependabot or Renovate (`app/dependabot`, `dependabot[bot]`, `app/renovate` ...) is owned by `ceo` BY NAME and no longer reads as "nobody could be named". #4386 stamped agent-org's own pull requests from their row and left a pull request no session ever claims untouched, so a11ign/a11ign#4470, #4471 and #4472 (Dependabot, opened an hour after #4386 closed) each landed on the `ceo` rung and were recorded as `owner-unresolved`. A `session:` label on such a pull request still wins; the order's words say a dependency bot opened it, not that its owner is unknown, and the recorder and the resolver-defect flag (both keyed on the `ceo` source) no longer see it.
