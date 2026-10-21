# Bundled agent-org plugins

Each directory here is one **agent-org plugin**: a code module behind one of the six versioned contracts (`src/plugins/contracts/`): tracker, code host, publisher,
reviewer, exposure and messaging. It is not a Claude plugin (`tickets.plugins` lists those). The directory's name is the plugin's name. There are none yet: A11-159 adds the
first (Linear), and A11-160 to A11-162 add the rest.

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
  "agentOrg": {
    "concern": "tracker",
    "contract": "1.0",
    "description": "One sentence: what the plugin is for.",
    "entry": "index.ts",
    "settings": { "key": { "key": "tickets.providers.tracker.key", "...": "a SchemaEntry of src/ticket-mode/config-schema.ts" } },
    "tooling": { "mcpServers": [], "connectors": ["^mcp__example__"], "skills": [] }
  }
}
```

**The entry module** exports `create(settings, deps)`, which returns the concern's contract implementation; `doctorChecks(settings, deps)`, which returns doctor rows; and
`onboardSteps`, the steps onboard runs for it. It imports core with `import type` only: every runtime helper arrives in `deps`.

## The rules

- **No `dependencies`.** A host installs the tool with `pnpm install --prod --ignore-workspace`, which installs no plugin's dependencies and links no workspace package, so the
  registry refuses a package that declares any, by name (`docs/adr/0001-plugins-load-from-the-checkout.md`).
- **Types only from core.** Node strips types, so a plugin needs no build step; at run time it reaches nothing of core's files.
- **A contract version is `<major>.<minor>`.** A minor only adds; a major breaks, and core refuses a plugin of a major it does not read, by name, at start and in `agent-org doctor`.
  While plugins are in this repository, a breaking change to a contract updates every plugin in the same pull request.
- **Pass the contract suite.** Each concern ships `run<Concern>Conformance` (`src/plugins/conformance/`) and an in-memory fake (`src/plugins/fakes/`); a plugin's own test runs the suite.
- **Our plugins only, for now.** Loading third-party code is not supported (Decision 4 of A11-157).
