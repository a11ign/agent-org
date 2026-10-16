Adds `src/packaging/fixtures/project-tree/`, the fixture project agent-org's suite runs against in place of a11ign's tree: the declaration (`.agent-org/project.json` with `units`, `host.json`, `roles/sessions.json` and four minimal briefs plus `orchestrator.md`), `package.json`, `docs/lane-ownership.json`, `README.md`, and the project-content paths the failures read (`docs/{try-it,row-filing,known-gaps}.md`, `docs/board/reported/`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/{ci,auto-arm,trunk}.yml`, `scripts/git-hooks/{pre-commit,post-checkout,reference-transaction}`, `.claude/rules/org-routing-and-timers.md`). No test family is switched.

Acceptance:
```bash
bash -c 'test -f src/packaging/fixtures/project-tree/.agent-org/project.json && test -f src/packaging/fixtures/project-tree/package.json && test -f src/packaging/fixtures/project-tree/docs/lane-ownership.json'
```

Measured (full `rstest run --config scripts/rstest/rstest.config.ts`, 725 files, from this worktree at the parent commit `4db74608`; the `AGENT_ORG_HOST` host file points at a git-initialised copy of the tree):
- org-health declaration alone (agent-org#1590 configuration 2): 469 of 11949 tests failing, 98 files failing a test.
- the same plus a11ign's `.agent-org/roles/*.md` (configuration 3): 379 failing, 77 files failing a test; 22 of the 98 files pass.
- this fixture: 344 failing, 70 files failing a test. 30 of the 98 now pass; the 22 that pass with a11ign's briefs all still pass on the minimal briefs. Two files not among the 98 (`org-retro`, `worker-profile`) fail a test now; both failed at file level in configuration 2 (no `ceo.md`, no `.claude/rules`), so they moved from file-level to test-level and are not new.
- Change 3, the import-time claim, is FALSE as stated. No project, `AGENT_ORG_HOST` unset: 528 of 725 files fail (3167 tests, 19 failing; 375 mentions of "REFUSED: it is unset"). A root `.agent-org/project.json` alone (the fixture's, copied to the worktree root, removed after): 413 files fail and 5936 tests run. It clears the `resolveHomeCheckout` refusal (375 mentions fall to 1, a test that runs in a temp directory) and 115 files, and the rest stop on the next two reads: `roles.dir` does not exist (198 files) and `.agent-org/host.json` cannot be read (170 files). The root declaration needs `.agent-org/roles/` and `.agent-org/host.json` with it.

`pnpm run typecheck` is clean. There is no `lint` or `verify` script in this repository.

Not covered, named: the `packages/*` paths (row 5), and `worker-profile`/`org-retro`/`public-claim`/`row-filing-guidance` content, which read a11ign's own wording and are rows 2 to 5.

Closes: a11ign/agent-org#1600

platform: nothing in GitHub, pnpm or git holds a fixture project; the tree is data.
