---
"@a11ign/agent-org": patch
---

A worktree `row-claim claim --branch --worktree` makes is provisioned from the repository's committed pnpm lockfile (a11ign/agent-org#871, replaces #851; a11ign#4957 cause 2): when the new tree has a `pnpm-lock.yaml` and no `node_modules`, the claim, once recorded, runs `pnpm install --frozen-lockfile --ignore-scripts` in it, probes it (`node_modules/.bin/rstest` exists and a trivial `node --test` file runs), and its line ends `/ installed`, `/ install failed: <first error line>` or `/ not ready: <what failed>`. A failed install does not fail the claim; a repository with no lockfile, a tree that already has its modules and an adopted tree are claimed as before. The repository now commits `pnpm-lock.yaml`; `ci.yml` still installs by name (a follow-up joins the two).
