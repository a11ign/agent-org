---
"agent-org": patch
---

agent-org's CI no longer checks out a11ign: `PROJECT_REF`, the cross-repository checkout it pinned, `project-ref-bump.yml` with its Octo STS policy, Renovate's regex rule (`renovate.json`) and the `ci-pins-the-project` test are deleted, and the `suite` job runs the whole suite against this repository's own fixture project (`src/packaging/fixtures/project-tree/`, copied to a temporary directory and committed, with `AGENT_ORG_HOST` naming its host declaration) from the checkout's root. `ci-failure-class.ts` no longer reads the pin bump a red `gate` may be waiting on (`waitsOnPinBump` is never set; the class and route stay until agent-org#1654 removes them), and `pnpm test` treats a set `AGENT_ORG_HOST` as a laid project and names the command CI now runs (agent-org#1593).
