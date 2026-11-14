Each release adds its own CHANGELOG.md section listing the changesets it consumed (A11-441, step 2 of 2). The release already does this. The shared `release-per-merge.yml` restores the last tag's CHANGELOG.md, removes the changesets a tag already consumed and runs this repository's own `changeset version`, but it writes the section on the release commit the tag points at, because `main` is never written (chairman, a11ign/a11ign#928). So `main`'s CHANGELOG.md stops at 0.2.0 while `v0.343.0`'s has every section, 0.343.0 down to 0.1.0 (6,597 lines). This step pins the part only this repository can break, and tells a reader of `main`'s copy where the sections are:

- `src/packaging/changelog-from-changesets.test.ts` (new) runs the installed `@changesets/cli` (3.0.3, from the lockfile) with the real `.changeset/config.json` over a tree shaped like a release commit: version 0.343.0, the last tag's section, and 14 committed changesets (1 minor, 13 patches). It asserts that CHANGELOG.md gains `## 0.344.0` listing exactly those 14 changes once each, above the kept 0.343.0 section, and that the 14 files are consumed. One control turns the config's `changelog` off and gets no section, so the test fails. Another control feeds the reading a section with a change missing, with a change listed twice, and with the older section lost, and each is refused.
- `CHANGELOG.md` on `main` gains a preamble. It says the per-release sections live in `git show v<version>:CHANGELOG.md` and in the GitHub Releases. The 0.2.0 and 0.1.0 entries stay below it, and `release-safety.test.ts` still finds `## 0.2.0`. The release commit replaces this file with the tag's copy, so the preamble never reaches a tag.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/packaging/changelog-from-changesets.test.ts src/packaging/release-safety.test.ts
git fetch --tags -q origin && test "$(git show "$(git tag --list 'v*' --sort=-v:refname | head -1)":CHANGELOG.md | grep -c '^## ')" -gt 300
```

Fails on the base: the preamble test fails on `origin/main`, because CHANGELOG.md has no text before `## 0.2.0`. The 14-changeset test passes on the base too, because it pins behaviour that already exists. Its control shows that it can fail.

Consumer-declaration: none. No command, key or contract changes, and a tag's CHANGELOG.md is unchanged.
