# Agent-org plugins are found in the tool's checkout, import core type-only, and declare no dependencies

## Context

Decision 3 of A11-157 makes each agent-org plugin a pnpm workspace package under `plugins/<name>`. But a host installs agent-org by cloning a release tag and running `pnpm install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace` (`install.sh:118`, `update-tool.ts:254-257`, pinned by `install-sh.test.ts:167` and `update.test.ts:169`). Under `--ignore-workspace`, no workspace package is linked into `node_modules`, and no plugin's own dependencies are installed.

## Decision

- The registry reads each `plugins/<name>/package.json` from the tool's checkout (`TOOL_ROOT`).
- The loader imports a plugin's entry module by file URL.
- A plugin imports core with `import type` only, and receives every runtime helper through `create(settings, deps)`.
- A bundled plugin that declares `dependencies` is refused by name.

## Why

The host's install stays as it is, and keeps its protection against a parent `pnpm-workspace.yaml`. A plugin needs no build step, because Node strips types. And the contract stays a pure type boundary that a third party could implement later (Decision 4), with no reach into core's files at run time.

## Considered

- **Dropping `--ignore-workspace`** on hosts: rejected. It re-opens the parent-workspace hazard that flag guards against.
- **Linking each plugin as a dependency of the root package**: rejected. `workspace:*` does not resolve under `--ignore-workspace`.

A plugin that genuinely needs a dependency reopens this decision.

## Paths

- `agent-org:src/plugins/`
- `agent-org:plugins/`
- `agent-org:pnpm-workspace.yaml`
- `agent-org:package.json`
