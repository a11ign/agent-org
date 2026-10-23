# Bundled agent-org plugins

Each directory here is one **agent-org plugin**: a code module behind one of the six versioned contracts (`src/plugins/contracts/`): tracker, code host, publisher,
reviewer, exposure and messaging. It is not a Claude plugin (`tickets.plugins` lists those). The directory's name is the plugin's name, unless its manifest's `agentOrg.name` gives another (`plugins/atomic-reviewer` is the plugin `atomic`, the name live host files use, so none is migrated). The first is `linear` (the tracker, A11-159),
the second is `github` (the code host, A11-160: ticket mode's reads of a pull request move in step by step, and the rest of the GitHub calls follow, so that `plugins/github` is the only place the
repository starts a `gh` process). A11-162 adds the two exposures, `local` (the concern's default: the board on loopback only) and `tailscale` (the board and the worker terminal on the tailnet, which is
the only place the repository runs `tailscale`), and `telegram` (messaging: the only place `api.telegram.org` is called). A11-161 adds the last two, `slack` (the publisher) and `atomic` (the reviewer): no concern's code is built into core any more, and "none" is the absence of an enabled plugin.

| Plugin | Concern | What it is |
| --- | --- | --- |
| `linear` | tracker | Linear: where tickets are kept and read |
| `github` | code host | GitHub: pull requests, reviews and checks (their logs and reruns), the review claim, the verdict door the reviewers post with (`reviewer/pr-review-verdict.sh` and its installer), and the routing `gh` wrapper of an org host (`wrapper/gh`, its renderer, the App-token minter and the rows and onboard step that check and set them up), and, for row mode, the optional `rows` group (`rows/`: the GitHub adapter of the ticket port and the reads and writes of rows, pull requests, checks, the merge queue and the board; contract 1.7) |
| `local` | exposure | serves nothing: the board listens on `127.0.0.1`; refuses `serve` by name |
| `tailscale` | exposure | `tailscale serve` for the page and the terminal, never Funnel; a path open to the internet for the event receiver (contract 1.1) |
| `telegram` | messaging | Telegram: asks and announcements for the chairman, configured in `project.json`'s `messaging` key |
| `slack` | publisher | Slack: announces the pull requests a person chose, through a publish run (the `post-pr-to-slack` skill); the plugin makes no Slack call, and builds the run's brief, names its connectors, model and effort and reads its outcome (contract 1.1) |
| `atomic` (`plugins/atomic-reviewer`) | reviewer | The gate's codex reviewer, started for each ready pull request in the tickets' herdr session; its port, seats, claims and verdict files are the plugin's, and the gate it drives stays core's |

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

**`package.json`'s `agentOrg` field** is read without importing any code, so a disabled plugin's code is never loaded. `name` is optional: absent, the plugin is named for its directory; present, it is the plugin's name (lower-case letters, digits and hyphens), and a name another plugin has is refused by name:

```json
{
  "name": "@agent-org/plugin-example",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "agentOrg": {
    "name": "example",
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

**A setting that names a secret declares the command that sets it.** An entry with `"secret": "path"` or `"secret": "keychain"` must also declare `"setCommand"`, the exact command that sets it, or the registry
refuses the manifest by name: the Settings page never takes a secret, so it shows this command with a copy button (A11-163). `{value}` is the setting's current value, and `{value|fallback}` takes `fallback` when the
host file holds none (`security add-generic-password -a "$USER" -s {value|agent-org-linear} -w`). A plugin that needs a secret is installed with `agent-org plugin install` or `agent-org onboard`, so the page offers its
install command and these, and no Install button.

**A messaging plugin's settings are keys of the project's `messaging` object** (`project.json`), not of a block under `tickets.providers`: its manifest keys them `messaging.<name>` with `"file": "project.json"`.

**The entry module** exports `create(settings, deps)`, which returns the concern's contract implementation; `doctorChecks(settings, deps)`, which returns doctor rows; and
`onboardSteps`, the steps onboard runs for it, in order, each given the settings the earlier steps chose, and answering what to say and the settings to write into the plugin's block. It
may also export `keep(settings, deps)`, what `agent-org update` keeps true on the machine at every update (the code host keeps its stacking extension present): safe to repeat, no prompt, never
throws. It imports core with `import type` only: every runtime helper arrives in `deps` (`fetch`; `exec`, which runs a program with an optional `env` laid over this process's, and a `timeoutMs`;
`readFile`, `mode`, the host's `clones`, the board's `pick` scope, `place` (where the host file says the machine keeps what a code host's wrapper is rendered from, asked only by a code host's doctor rows) and `policy`, which is what core decides about what a code host reports: which check is red, which run of one is newer, and how
a reviewer judges a pull request; `publishing`, the publish protocol a publisher builds its run's brief and reads its outcome with (`briefText`, `result`), which stays core's and says nothing of a chat service; `reviewing`,
what a reviewer needs of core, below; an onboard step also has the prompts). `src/plugins/fakes/deps.ts` is the deps a test gives it.

It may also export `release(settings, deps)`, what the plugin must take off the machine before it stops being the enabled plugin of its concern (the Tailscale exposure removes this board's `tailscale serve`
entries). `agent-org plugin` calls it while the plugin is still the enabled one, after the readers accepted the change and before the host file is written, on a switch (`enable <name>` of another plugin of the
concern), `disable`, `uninstall` and `install --replace`; `{ ok: false, detail }` refuses the change by name and nothing is written, and it must be safe to repeat and never prompt. A messaging plugin may export `pair`, its
step of `agent-org messaging:pair` (a provider cannot be built before there is a chairman to pair, so it is not on the provider). `deps` also carries `probe` (a GET of a host and port: what an exposure's doctor
rows ask) and, for a messaging plugin, `deps.messaging`: the secret by reference, the fetch that cannot leak it and the chairman's ids, which a plugin cannot import.

**`deps.reviewing`** is how a reviewer plugin reaches THE GATE, which stays core's because the org's own reviewer shares it (`wake/*`, `review-trust.ts`, `work-gate/pr-orders.ts`, `project-config.ts`, the door path and `host-config.ts`): `loadGate()` reads its modules and keeps a refusal
(a host with no `primary` cannot load them) rather than throwing it, `gateRefusal()` says it and `gate()` is the modules, which throw it. Beside them are the functions the atomic reviewer calls (seat names, the herdr listing, the claim on a head, the verdict reader, `ghWith`), and `board()`: the board's
collaborators (its herdr session and runner, the activated code host, the instance's claimant name, and the head each seat's reviewer was started for), which a process that is not a board does not have, and which refuses by name when a reviewer asks. A reviewer built at activation asks the gate only when it
is used, and `refusal()` after `load()` says whether it can start here: the pool starts none while it does.

**A code host's `wrapper`** (code host contract 1.3, optional) is the routing `gh` of an org host: the plugin renders it, core writes it. The plugin answers where it is installed and the text it must hold for the host's place, accounts and
identities (`file`), why a write of it must be refused (`refusal`: the A11-84 rules that keep a wrapper naming no App off a host that declares one), what is wrong with an installed copy (`divergence`, `identityStale`), and whether a
role's App can mint (`mintFailure`); core's `host:install`, `host:check`, the tick and the instance's start-up ask it, and write the file themselves. The plugin's doctor rows and onboard steps do the rest (`gh wrapper`, `wrapper roles`, `app token <role>`, the App's key). The programs the wrapper runs (`app-token.ts`, `author-flag.ts`)
are run by their paths under the installed tool, never imported.

**A code host's `rows`** (code host contract 1.7, optional) are row mode's GitHub operations, which `src/ticket-port/` held until A11-160 moved them (`docs/adr/0007-row-modes-github-operations-are-core-delegates-over-the-code-hosts-rows.md`). Each takes the `run` its caller hands it, so the caller's timeout, memo and call census still apply, and
reads the project's vocabulary and board through `deps.rows`, which core hands over when an operation asks. A code host with none serves ticket mode only. Core loads the code host for them by `require`, which Node 24 allows on a module graph with no top-level `await`:
a plugin of this kind keeps its graph free of one.

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
