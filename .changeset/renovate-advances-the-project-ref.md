---
"@a11ign/agent-org": patch
---

`PROJECT_REF` in this repository's CI is advanced by a Renovate regex rule (`renovate.json`, extending `local>a11ign/.github`; a11ign/a11ign#5153, item 1), the one pin that was not Renovate's. A bump is a digest update of a11ign/a11ign `main` opened on `bot/project-ref-bump`, the branch `src/ci-failure-class.ts` reads to class a pull request red only on pin drift as waiting on the bump, and the preset's automerge hands it to GitHub's auto-merge, so this repository's own `gate` and the merge queue decide it. `src/packaging/renovate-project-ref.test.ts` runs the rule's pattern over the real `ci.yml` and holds the branch name to `PIN_BUMP_BRANCH`; `ci.yml` copies `renovate.json` into the project tree beside the tool so that test can read it. `project-ref-bump.yml` is NOT deleted here: it goes in its own pull request once one Renovate bump has merged. Revert: `"enabled": false` in `renovate.json`.
