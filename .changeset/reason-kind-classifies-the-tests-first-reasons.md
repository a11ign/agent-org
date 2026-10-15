---
"@a11ign/agent-org": patch
---

The two TESTS-FIRST merge-guard refusals are classified in the verdict log: a PR that moves a named test after its first commit reads `TESTS_FIRST_TESTS_MOVED`, and a first commit that lacks a named test reads `TESTS_FIRST_NOT_IN_FIRST_COMMIT`, where both read `UNCLASSIFIED` before, so reconciliation could not group them (a11ign/agent-org#1009). No refusal changes: no gate decision reads the two new kinds, and the refusal text is the same.
