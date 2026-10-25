# Bundled agent-org plugins

Each directory here is one **agent-org plugin**: a code module behind one of the six versioned contracts (`src/plugins/contracts/`): tracker, code host, publisher,
reviewer, exposure and messaging. It is not a Claude plugin (`tickets.plugins` lists those). The directory's name is the plugin's name, unless its manifest's `agentOrg.name` gives another (`plugins/atomic-reviewer` is the plugin `atomic`, the name live host files use, so none is migrated). The first is `linear` (the tracker, A11-159),
the second is `github` (the code host, A11-160: ticket mode's reads of a pull request move in step by step, and the rest of the GitHub calls follow, so that `plugins/github` is the only place the
repository starts a `gh` process). A11-162 adds the two exposures, `local` (the concern's default: the board on loopback only) and `tailscale` (the board and the worker terminal on the tailnet, which is
the only place the repository runs `tailscale`), and `telegram` (messaging: the only place `api.telegram.org` is called). A11-161 adds the last two, `slack` (the publisher) and `atomic` (the reviewer): no concern's code is built into core any more, and "none" is the absence of an enabled plugin.

| Plugin | Concern | What it is |
| --- | --- | --- |
| `linear` | tracker | Linear: where tickets are kept and read |
| `github` | code host | GitHub: pull requests, reviews and checks (their logs and reruns), the review claim, the verdict door the reviewers post with (`reviewer/pr-review-verdict.sh` and its installer), and the routing `gh` wrapper of an org host (`wrapper/gh`, its renderer, the App-token minter and the rows and onboard step that check and set them up), and, for row mode, the optional `rows` group (`rows/`: the GitHub adapter of the ticket port and the reads and writes of rows, pull requests, checks, the merge queue and the board, what arming a pull request, guarding its merge and running the merge queue ask of GitHub, and what the work gate reads and writes of rows, pull requests, checks and runs, with the process its executor starts; contract 1.9) |
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
    "setUp": "Example connected as the tracker",
    "entry": "index.ts",
    "settings": { "key": { "key": "tickets.providers.tracker.key", "...": "a SchemaEntry of src/ticket-mode/config-schema.ts" }, "key.path": { "...": "a part of key, drawn as a row of its own" } },
    "tooling": { "mcpServers": ["example"], "connectors": ["^mcp__example__(get|list)_"], "connectorServers": ["example"], "skills": [], "writer": { "...": "a tracker's TrackerWriting, contract 1.1" } }
  }
}
```

`"type": "module"` makes Node read the entry's `.ts` as an ES module. `setUp` is optional: the sentence onboard says once the plugin is set up, as a person reads it (`Linear connected as the tracker`, `Board served on this machine`);
without it onboard says the `description`, and never the bare name (A11-222). `settings` are the plugin's own: the Settings page draws them, in the tracker's section, where they were drawn when they
were core's. `tooling.connectors` are the read-only tools a worker may call; `connectorServers` names the servers whose patterns in `tickets.connectors` belong to this plugin's block. A
tracker's `tooling.writer` is what a new-ticket run files with (tracker contract 1.1): the tools it is granted, what the hook refuses, how a created ticket's key is read back, and the
priority numbers. It is data and not code because the PreToolUse hook is a process started for every tool call, which must not import a plugin to answer one.

**A setting that names a secret declares the command that sets it.** An entry with `"secret": "path"` or `"secret": "keychain"` must also declare `"setCommand"`, the exact command that sets it, or the registry
refuses the manifest by name: the Settings page never takes a secret, so it shows this command with a copy button (A11-163). `{value}` is the setting's current value, and `{value|fallback}` takes `fallback` when the
host file holds none (`security add-generic-password -a "$USER" -s {value|agent-org-linear} -w`). A plugin that needs a secret is installed with `agent-org plugin install` or `agent-org onboard`, so the page offers its
install command and these, and no Install button.

**A messaging plugin's settings are keys of the project's `messaging` object** (`project.json`), not of a block under `tickets.providers`: its manifest keys them `messaging.<name>` with `"file": "project.json"`.

**The entry module** exports `create(settings, deps)`, which returns the concern's contract implementation; `doctorChecks(settings, deps)`, which returns doctor rows; and
`onboardSteps`, the steps onboard runs for it, in order, each given the settings the earlier steps chose, and answering what to say and the settings to write into the plugin's block. A step answers `{ ok, detail, settings?, summary? }`: `summary` (A11-222) is its own line in a person's words
(`GitHub stacked pull requests ready`), drawn ✓ or ✗ by `ok`, with `detail` beside it under `agent-org onboard --verbose` when it passed and beneath it as the fix when it failed; a step with no `summary` says
nothing when it passed (its `detail` is for `--verbose`), and when it failed its `detail` is the fix under the plugin's own line. It
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

A reviewer of contract 1.6 may also have `unblock(ref)`: the pool calls it for a started head with no posted review, and it reads the pane of a reviewer herdr shows blocked (`board().herdr.readDialogLines`). It answers the one dialog it may answer (the atomic reviewer's is Codex's "Trust this folder?" for a repository the host file names, `codex-trust.ts`) with `{ answered }`, and reports any other as `{ stuck }` with its first line, which the pool shows on the pull request's review line and hands to a person as the run's Needs you note. A reviewer without the method is read as one that never reports a dialog.

A reviewer of contract 1.7 may be given two more fields of `ReviewBrief.rereview`, both optional: `decisions`, the lines of the ticket's `## Decisions` that changed since the reviewer's last look at the head (a person's answer to a run is written there, A11-250), and `unsupported`, each reply or new description line that claims a person decided something without linking the ticket's Decisions. A re-review with `decisions` is an answer to the block as a reply is, and a claim in `unsupported` answers nothing: the atomic reviewer says so in its prompt (`prompt.ts`). A reviewer of 1.6 ignores both fields, so a re-review that only a change of the decisions asked for reaches it with no reply and no description lines. `decisions` is what `decisionsOf` reads: a `## Decisions` or `## Behaviour` section, and a line marked as the chairman's decision.

A reviewer of contract 1.8 may be given two more fields of `ReviewBrief`, both optional (A11-257): `planDecisions`, the decisions the ticket's plan records (its Key decisions, its Decisions made without a person, and the behaviour the planner settled), and `escalation`, the escalation list, which a decision cannot override. The plan's decisions bind the reviewer as the ticket's `decisions` do, and the ticket's win where the two differ: the reviewer does not request changes on a point a decision settled, and writes a note and not a finding where it disagrees. The atomic reviewer says so in its prompt (`prompt.ts`). A reviewer of 1.7 ignores both fields.

**A code host's `wrapper`** (code host contract 1.3, optional) is the routing `gh` of an org host: the plugin renders it, core writes it. The plugin answers where it is installed and the text it must hold for the host's place, accounts and
identities (`file`), why a write of it must be refused (`refusal`: the A11-84 rules that keep a wrapper naming no App off a host that declares one), what is wrong with an installed copy (`divergence`, `identityStale`), and whether a
role's App can mint (`mintFailure`); core's `host:install`, `host:check`, the tick and the instance's start-up ask it, and write the file themselves. The plugin's doctor rows and onboard steps do the rest (`gh wrapper`, `wrapper roles`, `app token <role>`, the App's key). The programs the wrapper runs (`app-token.ts`, `author-flag.ts`)
are run by their paths under the installed tool, never imported.

**A code host's `repositories`** (code host contract 1.14, optional, A11-186) are the accounts, organisations and repositories a person can pick at onboard: `readOwners` (the signed-in account first, then its organisations), `readRepositories(owner)` (archived ones left out, by name), `repositoryOfRemote(url)` (pure: the repository a git remote URL names on this host, which is how onboard finds the checkouts in the folder it runs in without a call), `cloneCommand` (what a person would type, shown before it runs) and `cloneRepository`. Every operation acts as the person who runs onboard, never as a role, and a read answers `null` for "could not ask", never for "there is none" (a list cut off at its limit is `null` too). A code host without the group keeps onboard's typed prompt. The GitHub plugin's is `repositories.ts`; `runCodeHostConformance` checks the group when it is present.

**A code host's `updateBranch` and `passing`** (code host contract 1.15, optional, A11-215) are how the board mends a pull request it held as red on main: `readDefaultBranchRed` also names the checks whose newest run on the default branch's head passed (`passing`, positive evidence, since "not failing" is also a pending check or a failed read), and `updateBranch(url, expectedHead)` brings the pull request's branch up to date with its base as the workers' account, answering `updated`, `conflict`, `up-to-date` or `refused` with a reason and never throwing. `expectedHead` makes a head that moved since the board read it a refusal and not a race. A host of 1.14 has neither, and the board holds a pull request as before.

**A code host's `stackMergeFactsOf` and `requestStackMerge`** (code host contract 1.16, optional, A11-238) are how the board gets an approved, green stacked pull request merged. GitHub refuses auto-merge for a pull request in a stack, so the arm bot merges the bottom open member with GitHub's stack merge. `stackMergeFactsOf(url)` reads whether the pull request is in a stack, its base and the default branch, whether it is already merged or queued, and the refusal the arm bot left on it with the head it was given at, and answers `null` for "could not ask", never for "not in a stack". `requestStackMerge({ repo, number })` dispatches the arm bot's own job, which re-reads everything with its own identity; the board never merges, and a refused dispatch throws. A host of 1.15 has neither, and the board asks the arm bot for nothing.

**A code host's `readCiRun`** (code host contract 1.17, optional, A11-245) is how the board reads a workflow run a worker declared it waits on: `readCiRun(repository, runId)` answers the run's `status` (`queued`, `in_progress` or `completed`), its `conclusion` (GitHub's word, null until it completes), its page, the workflow's name and the jobs completed of all it lists, and `null` for "could not ask", never for "not finished". A host of 1.16 has none, and a wait on a run is then shown as unreadable.

**A code host's `pullsNaming`** (code host contract 1.18, optional, A11-240) is how the board finds the pull requests a ticket already has when its own record of them was emptied by a crash: `pullsNaming(key, repositories)` answers every pull request of those repositories (`owner/name`) whose title or body names the key, with its address, repository, state (`open`, `merged` or `closed`) and body, and `null` for "could not ask" (a repository the host cannot read, an answer it cannot read, or a list cut short at its limit), never for "none names it". The host judges nothing: a pull request that only mentions the key is listed too, and the board keeps the ones whose `Closes` or `Refs` line names it. A host of 1.17 has none, and a run started again is then told only what the board recorded.

**A code host's `openDependencyPulls`** (code host contract 1.19, optional, A11-255) is how the board finds the pull requests the dependency bot opened: `openDependencyPulls(repository)` answers the open pull requests of `owner/name` that `DEPENDENCY_PULL_AUTHOR` (`dependabot[bot]`) opened, each with its address, number, title, branch, head commit, author and body, and `null` for "could not ask" (a repository it cannot read, an answer it cannot read, a list cut short), never for "there are none". The host filters by author, never by title: the board turns a major update, or a group that stays red, into a ticket for the writer from these, and a pull request anyone else opens with a bot-like title must never reach it. GitHub answers it with a plain `gh pr list --state open` and keeps the pull requests whose author is the bot (it passes no `--author`, which `gh` sends as a search). A code host of 1.18 is read as one that cannot be asked, and the board files no dependency ticket.

**A code host's `readClosedWork`** (code host contract 1.20, optional, A11-249) is how the board lists what a pull request closed without merging still held: `readClosedWork(url)` answers the pull request's number, address, base, branch and head commit, the commits on that head that are not on the base (full SHA and subject, oldest first) and the files they change, read from the host's compare of the base with the head COMMIT (so a deleted branch is still read), with `filesComplete` false when the compare stopped at its cap of files. It answers `null` for "could not ask" and for a pull request that is open or merged, never for "it held nothing": a closed pull request whose commits are all on its base answers an empty list of commits. A host of 1.19 has none, and the board then lists nothing.

**A code host's `closePull`** (code host contract 1.23, optional, A11-248) is how the board closes a member of a stack that holds nothing of its own once everything it held merged with the member below it: `closePull(url, comment)` closes the pull request at `url` as the workers' account and posts `comment` on it, answers nothing, and THROWS in the host's own first line when it cannot (an address that is no pull request included), so no caller reads a refusal as a close. A pull request that is closed already is not an error. GitHub's is `gh pr close <number> --repo <owner/name> --comment <comment>` (`plugins/github/close-pull.ts`). A host of 1.21 has none, and the board then says on the card that the pull request is empty and is to be closed.

**A code host's merge queue reads** (code host contract 1.21, optional, A11-264) are how the board answers a pull request the merge queue removed: `PullFeedback.queue` says whether the pull request is in the queue now and lists the removals since its head last moved, oldest first, each with its time, the host's `reason` (`failed_checks` for a failed `merge_group` run), the `actor` and the merge group's commit, read in the same query as the rest of the feedback, and is absent when the host did not say, which is not "no removals". `readQueueFailure(url, groupCommit)` answers the failing `merge_group` run of that commit (its id and address, and each failing job with its first failing step and the address of its page), and `null` for "could not ask", never for "no job failed". `holdFromQueue(url, on)` puts the `hold:board` label on the pull request or takes it off, which every arm bot in the org already honours, and answers whether the label is now as asked; it throws when it could not ask. A host of 1.20 has none, and the board then answers removals as it did before: not at all.

**A code host's `readBranchCi`** (code host contract 1.22, optional, A11-261) is how the board adds up what a ticket's pushes cost in CI: `readBranchCi(repository, branch, settled)` answers the workflow runs on `branch` of `repository` (`owner/name`), newest first, each with its id, head commit, creation time, status (`queued`, `in_progress` or `completed`) and its jobs, every attempt of a re-run included, each with its runner's labels and its start and completion times. A run whose id is in `settled` (the board holds its jobs and it has completed) is answered with no jobs, so each completed run's jobs are read once. Null is "could not ask" (a repository it cannot read, an answer it cannot parse, a list cut short at the page cap), never "no runs". The board weights each job's minutes, rounded up per job, by its labels as GitHub bills (`macos` ten, `windows` two, any other hosted runner one, `self-hosted` none) and compares the ticket's total with `tickets.ciBudgetMinutes`. A plugin of 1.21 is read as one that reads no branch's CI, and the board then shows and holds nothing.

**A code host's `rows`** (code host contract 1.12, optional) are row mode's GitHub operations, which `src/ticket-port/` held until A11-160 moved them (`docs/adr/0007-row-modes-github-operations-are-core-delegates-over-the-code-hosts-rows.md`). Each takes the `run` its caller hands it while that caller has not moved, so the caller's timeout, memo and call census still apply (a caller that has moved hands none, and the code host runs `gh` itself, with the git variables of a hook taken off for the merge queue's dispatcher), and
reads the project's vocabulary and board through `deps.rows`, which core hands over when an operation asks. A code host with none serves ticket mode only; `rows.acts` says whether the operations act on the caller's `run` (GitHub's, for now) or on the host's own state (the fake's, which models a tracker and a queue in memory). Core loads the code host for them by `require`, which Node 24 allows on a module graph with no top-level `await`:
a plugin of this kind keeps its graph free of one. `ownRun`, the plugin's own `gh`, is the one member that is not a question core asks: it is for the callers that have not moved and hold no runner of their own, and it goes with the last of them (`docs/adr/0008-arming-the-merge-guard-and-the-merge-queue-are-the-code-hosts-rows.md`). The work gate's operations (`rows/gate-*.ts`: a row's events, comments and timeline, the pull requests, commits, checks and runs it reads, the writes it makes) take the `run` of the gate's executor, whose memo, budget, bound and aim stay core's, and the process that executor starts is the plugin's (`gateRun`, `runTogether`, in `rows/gate-runner.ts`); the fake's `rows` model what the gate reads in `FakeRowsWorld.gate` (`docs/adr/0009-the-work-gates-reads-and-writes-are-named-operations-of-the-code-hosts-rows.md`).

**The runners a caller that runs `gh` itself asks for** (contract 1.11): `runnerWith(request)` and `asyncRunnerWith(request)` hand a caller `gh` with the policy it names (where it runs, its bound and buffer, a hook's git variables taken off, stderr let through or kept, and a `guard` that refuses an argument list before a process is started), over `deps.exec` and `deps.execAsync`; `rows.command` is the program core's leak guard judges argument lists under. The board, the org-health and retro readings, the DORA reader, the trace and the chairman's watch and answers moved to named operations in `rows/board-rows.ts`, `health-rows.ts`, `dora-rows.ts`, `trace-rows.ts` and `messaging-rows.ts` (`docs/adr/0011-the-boards-health-and-retro-readings-the-trace-and-the-chairmans-watch-are-named-operations-of-the-code-hosts-rows.md`); the fake models them in `FakeRowsWorld.reports`.

**The last callers (contract 1.12, A11-160 step 9)**: no file outside `plugins/github` calls `gh`. The 50 files that remained ask `rows` for named operations in seven sections (`rows/pullwork-rows.ts`, `audit-rows.ts`, `closing-rows.ts`, `classes-rows.ts`, `queue-rows.ts`, `readouts-rows.ts`, `plumbing-rows.ts`, with their helpers beside them; `docs/adr/0012-the-last-callers-of-gh-ask-the-code-hosts-rows-and-no-file-outside-the-github-plugin-calls-gh.md`); the fake models them in `FakeRowsWorld.tail.<section>`, and the contract suite gathers their checks from `conformance/rows-tail.ts`. The three shell scripts that run `gh` (`board-report-dispatch.sh`, `manager-spend-post.sh`, `trace-weekly-post.sh`) are `plugins/github/host/`'s, started from the tool checkout by the units in `host/`. `runnerWith` also takes `env` (an overlay on the process's environment) and `inherit` (the child's own terminal). `docs/gh-call-baseline.json` is empty, and `src/packaging/gh-call-ratchet.test.ts` refuses any file outside the plugin that spawns `gh` or holds a `gh` call shape.

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
