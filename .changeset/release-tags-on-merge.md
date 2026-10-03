---
"agent-org": patch
---

A merge to `main` that carries a changeset is tagged and released with no version pull request: `release.yml` builds a release commit on top of the merge (the last tag's version and changelog, the changesets that tag already consumed removed, `changeset version` over the rest) and pushes it as the tag. `main`'s own `package.json` version and `CHANGELOG.md` lag the last tag, and a project pins the tag's tree.
