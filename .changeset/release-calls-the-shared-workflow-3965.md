---
"agent-org": patch
---

`release.yml` is now a call of the shared per-merge release workflow in a11ign/toolchain (`kind: tag`, pinned by full sha) instead of a release job of its own. The tag is still `v<version>`, cut from a release commit on no branch with the CHANGELOG entry as the Release notes, so what a project pins and what `update-tool` follows are unchanged. No lockfile, `packageManager` or `@changesets/cli` dependency is added: the call names the pnpm and the changesets version, which the shared workflow runs through `pnpm dlx`. The guard tests that ran the old steps now pin the properties of the call, and say where the rest moved.
