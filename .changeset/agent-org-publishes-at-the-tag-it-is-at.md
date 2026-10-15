---
"@a11ign/agent-org": patch
---

agent-org is published to npm as `@a11ign/agent-org`, at the version of the release tag it is cut at (ADR 0045 cut (a), a11ign/agent-org#1377). The package `name` is `@a11ign/agent-org` and `release.yml` calls the shared per-merge workflow with `kind: npm`, so the one release that cuts the `vX.Y.Z` tag also publishes that version to the registry with npm trusted publishing; the tag, the Release and `exports` are unchanged, and a project that takes `github:a11ign/agent-org#semver:...` is unaffected. The changeset files name the package by its new name.
