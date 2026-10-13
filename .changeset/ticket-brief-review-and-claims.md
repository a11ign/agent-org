---
"agent-org": minor
---

A ticket-mode worker's brief adds two checks before the commit. A subagent that has not seen the worker's reasoning reviews the diff, read only, for behaviour it changed but meant to keep, and each real finding is fixed with a test that fails without the fix. And each behaviour the pull request body claims, fixed, kept or changed, needs a test assertion of exactly that behaviour, run on the base: a fix fails there, and a kept behaviour passes there too. Review of nbl-ui-netbox#794 found three behaviour changes a passing suite missed, and a claimed fix whose test checked a neighbouring value.
