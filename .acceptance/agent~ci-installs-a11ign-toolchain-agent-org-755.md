CI installs `@a11ign/toolchain` at `0.7.1` EXACT in both jobs that install it (`suite`, line 94; `typecheck`, line 176), so a pull request that imports `@a11ign/toolchain/lib/*` can resolve those subpaths. Closes a11ign/agent-org#755.

Closes a11ign/agent-org#755

## What changes, and why

- `.github/workflows/ci.yml`: both `npm install ... "@a11ign/toolchain@0.1.5"` become `@a11ign/toolchain@0.7.1`. The ruling is `ceo`'s (agent-org#522 comment 6101500236); the pin stays EXACT for the a11ign/a11ign#4308 reason (0.1.6 shipped with no `dist/`).
- The comments beside the pins now say what is true at 0.7.1 and name no version the file no longer installs: the `suite` one says 0.7.1 ships `dist/` and exports the `./lib/*` subpaths; the `typecheck` one no longer pins `package.json`'s range by number; the layout-check one says `dist/layout-check.mjs` now begins `#!/usr/bin/env node` and that the step still calls it by path.
- **No changeset:** a workflow edit ships nothing, and the `changeset` job's `releasable-paths` is `src/`, which this diff does not touch.

## How you verified it

The Acceptance below is the row's two commands without their `cd /home/agent/repos/agent-org` (that path holds `main`, which carries this only after the merge). Both print `ok` on this branch; at `origin/main` the first counts 0 and the second fails.

Registry, read on this branch (measured): `npm view @a11ign/toolchain@0.7.1 exports` lists `./rstest-config` and the `./lib/*` subpaths; `npm pack @a11ign/toolchain@0.7.1` holds `dist/rstest-config.mjs`, `dist/layout-check.mjs` and `dist/lib/{git-sandbox,product-home,tree-wide-guard,walk-scope-declaration,walk-scope-discovery,ci-changed}.mjs`, and `dist/layout-check.mjs` line 1 is `#!/usr/bin/env node`. The workflow parses as YAML (jobs `suite`, `typecheck`, `changeset`, `gate`).

## Anything a reviewer should be sceptical of

- **Done-when item 1 is this pull request's own `typecheck`, `suite` and `gate` runs**, which only CI can produce; they are not read here. Item 2 (agent-org#713 rebased, its `Cannot find module` message absent) is agent-org#522's row's, as the row says.
- `package.json` still says `^0.1.5`, which `0.7.1` is outside; CI installs by name with `--no-save`, so it does not read it. Moving it is agent-org#713's build (`^0.7.0`), and `package.json` is outside this row's Region.

Acceptance: `bash -c 'test "$(grep -c "toolchain@0.7.1\"" .github/workflows/ci.yml)" -ge 2 && ! grep -q "toolchain@0.1.5\"" .github/workflows/ci.yml'`

platform: n/a (a pin in a workflow file)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
