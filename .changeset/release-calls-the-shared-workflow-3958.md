---
"agent-org": patch
---

`release.yml` is now a call of the shared per-merge release workflow in a11ign/toolchain (`kind: tag`, pinned by full sha) instead of a release job of its own. The tag is still `v<version>`, cut from a release commit on no branch with the CHANGELOG entry as the Release notes, so what a project pins and what `update-tool` follows are unchanged. The repository now carries a `pnpm-lock.yaml`, a `packageManager` and `@changesets/cli` as a dev dependency, which that workflow's version job installs from.
