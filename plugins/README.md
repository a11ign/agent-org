# Bundled agent-org plugins

Each directory here is one **agent-org plugin**: a code module behind one of the six versioned contracts (`src/plugins/contracts/`): tracker, code host, publisher,
reviewer, exposure and messaging. It is not a Claude plugin (`tickets.plugins` lists those). The directory's name is the plugin's name. The first is `linear` (the tracker, A11-159),
the second is `github` (the code host, A11-160: ticket mode's reads of a pull request move in step by step, and the rest of the GitHub calls follow, so that `plugins/github` is the only place the
repository starts a `gh` process), and A11-161 and A11-162 add the rest.

A plugin is a directory with a `package.json`, found by the registry; it is not a member of a pnpm workspace. This repository has no `pnpm-workspace.yaml`: its layout check
(`@a11ign/toolchain`'s `layout-check`, ADR 0043 Decision 7) requires one package at the root and no workspace file, and nothing needs the workspace, since a host links no plugin
and installs none of its dependencies (below).

## What a plugin package holds

```
plugins/<name>/
  package.json     "agentOrg": the manifest's data half (below). No "dependencies".
  index.ts         the entry module: the manifest's code half (below)
  *.test.ts        the plugin's tests, including its concern's contract suite
```

**`package.json`'s `agentOrg` field** is read without importing any code, so a disabled plugin's code is never loaded:

```json
{
  "name": "@agent-org/plugin-example",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "agentOrg": {
    "concern": "tracker",
    "contract": "1.1",
    "description": "One sentence: what the plugin is for.",
    "entry": "index.ts",
    "settings": { "key": { "key": "tickets.providers.tracker.key", "...": "a SchemaEntry of src/ticket-mode/config-schema.ts" }, "key.path": { "...": "a part of key, drawn as a row of its own" } },
    "tooling": { "mcpServers": ["example"], "connectors": ["^mcp__example__(get|list)_"], "connectorServers": ["example"], "skills": [], "writer": { "...": "a tracker's TrackerWriting, contract 1.1" } }
  }
}
```

`"type": "module"` makes Node read the entry's `.ts` as an ES module. `settings` are the plugin's own: the Settings page draws them, in the tracker's section, where they were drawn when they
were core's. `tooling.connectors` are the read-only tools a worker may call; `connectorServers` names the servers whose patterns in `tickets.connectors` belong to this plugin's block. A
tracker's `tooling.writer` is what a new-ticket run files with (tracker contract 1.1): the tools it is granted, what the hook refuses, how a created ticket's key is read back, and the
priority numbers. It is data and not code because the PreToolUse hook is a process started for every tool call, which must not import a plugin to answer one.

**The entry module** exports `create(settings, deps)`, which returns the concern's contract implementation; `doctorChecks(settings, deps)`, which returns doctor rows; and
`onboardSteps`, the steps onboard runs for it, in order, each given the settings the earlier steps chose, and answering what to say and the settings to write into the plugin's block. It
may also export `keep(settings, deps)`, what `agent-org update` keeps true on the machine at every update (the code host keeps its stacking extension present): safe to repeat, no prompt, never
throws. It imports core with `import type` only: every runtime helper arrives in `deps` (`fetch`; `exec`, which runs a program with an optional `env` laid over this process's, and a `timeoutMs`;
`readFile`, `mode`, the host's `clones`, the board's `pick` scope, and `policy`, which is what core decides about what a code host reports: which check is red, which run of one is newer, and how
a reviewer judges a pull request; an onboard step also has the prompts). `src/plugins/fakes/deps.ts` is the deps a test gives it.

A plugin may also bring a command: `src/commands.ts` can name its program by a path inside the plugin (`../plugins/github/stack-live-check-command.ts`).

## The rules

- **No `dependencies`.** A host installs the tool with `pnpm install --prod --ignore-workspace`, which installs no plugin's dependencies and links no workspace package, so the
  registry refuses a package that declares any, by name (`docs/adr/0001-plugins-load-from-the-checkout.md`).
- **Types only from core.** Node strips types, so a plugin needs no build step; at run time it reaches nothing of core's files. `src/plugins/boundary.test.ts` refuses a runtime import of
  a file outside the plugin's folder, and its other half refuses core any import of a plugin's code and any Linear endpoint or tool name outside `plugins/linear`.
- **A contract version is `<major>.<minor>`.** A minor only adds; a major breaks, and core refuses a plugin of a major it does not read, by name, at start and in `agent-org doctor`.
  While plugins are in this repository, a breaking change to a contract updates every plugin in the same pull request.
- **Pass the contract suite.** Each concern ships `run<Concern>Conformance` (`src/plugins/conformance/`) and an in-memory fake (`src/plugins/fakes/`); a plugin's own test runs the suite.
- **Our plugins only, for now.** Loading third-party code is not supported (Decision 4 of A11-157).
