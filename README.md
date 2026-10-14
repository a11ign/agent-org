# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

`agent-org` is published to no registry. A project takes it as a git dependency pinned to a release tag, with `typescript` beside it:

```bash
pnpm add -D typescript "github:a11ign/agent-org#semver:^0.1.0"
pnpm exec agent-org <command> [args]
```

`agent-org` with no command, or a name that is not a command, refuses and lists the commands. There is no default command. A command is the
name a project's `package.json` script used (`row-file`, `pr:open`, `board:settle`), and `src/commands.ts` is the table.

## The project is the repository you run it in

The tool reads `.agent-org/project.json` of the project it serves, and never answers with another project's values. Which project that is:

| layout | `$AGENT_ORG_HOST` unset | `$AGENT_ORG_HOST` set |
|---|---|---|
| installed (`node_modules/agent-org`) | the git repository the command is run in; REFUSED naming `.agent-org/project.json` and the directory looked in if it holds none | the host file's primary project |
| monorepo (`packages/agent-org/src`) | the repository root | the host file's primary project |
| the tool's own checkout | REFUSED naming `AGENT_ORG_HOST` | the host file's primary project |

## Which GitHub account each role calls as

`gh` calls are made by four roles: the **scheduler** (the gate, the tick and the `host:*` scripts: a process outside any agent workspace), the **workers** (engineer sessions), the
**managers** (the standing leads) and the **reviewer** (the pull-request review instances, `a11ign-bot` today; a process that sets `AGENT_ORG_GH_ROLE=reviewer`). `host.json`'s `github.identity` sets, per role, how that role authenticates:

```json
{
  "github": {
    "identity": {
      "scheduler": { "mode": "github-apps", "appId": 1234567, "slug": "my-scheduler", "keyPath": "/home/agent/.config/agent-org/apps/scheduler.pem" },
      "workers": { "mode": "user-accounts" }
    }
  }
}
```

| mode | what the role calls as | what it needs |
|---|---|---|
| `user-accounts` (the default, and what a role left out gets) | the personal account whose `gh` config directory the host already routes the role to | nothing; a host with no `github` key behaves exactly as before |
| `github-apps` | `<app>[bot]`, with a one-hour installation token minted from the app's private key and cached | `appId` and an absolute `keyPath` (a mode-600 `.pem`); `installationId` only when the app is installed in more than one place; `slug` (the app's name in `github.com/apps/<slug>`, without `[bot]`) for `gh api user` to be answered |

The roles are chosen one at a time, so a host can move the scheduler first and leave the rest (`scheduler` is the role whose shared pool starved: the gate hit GitHub's secondary
limit as the workers' account). A role that is not one of the four, a `github-apps` role without `appId` and `keyPath`, and a `user-accounts` role that names an app are refused by
field name when `host.json` is read. A role outside any agent workspace is the scheduler; `AGENT_ORG_GH_ROLE=scheduler|workers|managers|reviewer` states the role when that guess is wrong, and is the only way the `reviewer` is named (its own config directory names none).

How it behaves:

- **A separate pool per role.** Each app's installation token spends the app's own rate limit, not the personal account's.
- **Minted on demand, refreshed before it expires.** The token is cached under the host's state directory (`app-tokens/<role>.token`, mode 600) and replaced when less than
  five minutes of it is left, so a call is not handed a token that dies under it. Reading the cache starts no process.
- **A failed mint falls back to today's account**, so the call still goes through, and records one ledger line with resource `incident` naming the stage that failed (`key`,
  `installation` or `token`). The role is not asked again for a minute.
- **An explicit `GH_TOKEN` or `GITHUB_TOKEN` wins**: a CI runner or a person who named a credential is not re-routed.
- **`gh api user` is answered from the declaration.** An installation token is refused `GET /user`, so for a call that goes out as a role's app, `gh api user` and
  `gh api user --jq .login` print `<slug>[bot]` without calling GitHub (ledger resource `declared`). A role whose app declares no `slug`, any other `api user` form (another filter,
  `-i`, `-H`), a failed mint and an explicit token are sent to GitHub as they were.

The trade-offs, which are why this is an option and not the default:

- **Authorship changes to `<app>[bot]`**, in commits' pushes, comments, reviews and PRs; whatever matches on the old login (rulesets' bypass lists, CODEOWNERS, `a11ign-bot`
  rules) must be told the app, and an app's approval counts toward a required review only where the ruleset allows it. Verify this per role before moving it.
- **An installation token cannot answer `viewer`** (the GraphQL query for "who am I") and only reaches repositories the app is installed on and the permissions it was granted.
- **The key is a standing secret** on the host; a leaked token is good for an hour, a leaked key until the app's key is revoked.
- **The minter needs `node` and the network**; with neither the role runs on its personal account and the incident says so.

## Ticket mode: a local board that turns the tickets you pick into draft pull requests

The org (the gate, rows, the board, the reviewer) decides its own work. Ticket mode does not: you pick tickets, and a pool of Claude workers
takes them one each. `agent-org ticket:serve` starts a board on `127.0.0.1` and prints its URL, which carries no secret.

- **Pair a browser once.** A browser the board has not seen shows a pairing page. Run `agent-org ticket:pair` and type the code it prints:
  a code works once, within 10 minutes, and five wrong codes spend it. The browser then holds a session of its own, as an HttpOnly cookie,
  for a year and across restarts. The board keeps only the sessions' hashes, in `<stateDir>/tickets/browsers.json`, and deleting that file
  unpairs every browser. The board refuses to start on a file that does not hold sessions, rather than unpair every browser silently. A script on the machine sends the board's key, from `<stateDir>/tickets/board.key`, as the `x-ticket-token`
  header. Only the key makes a pairing code. The key never goes to a browser, because a browser sends its cookies for `127.0.0.1` to every port there. The board makes both
  files with mode 600, and refuses a key file another user owns or can read.

- **Pick.** Your assigned Linear tickets that are not done or canceled, grouped by status the way Linear shows them, with Select All per
  group and for the page. A ticket sits under its parent, whatever its own status. A parent folds the tickets under it away, and starts folded.
  Its checkbox picks every ticket under it that is not on the queue, never the parent itself, and shows part ticked when only some are picked.
  A parent that is not yours, such as an epic someone else owns, says so. Filter by Linear project or priority (several of each at once) or by search, and fold any status group; each is remembered in the
  browser. On a machine that sets `tickets.plan`, a ticket with no plan of its own is marked, so you can attach one before a worker starts it.
  The mark is muted when the ticket's parent has a plan, because a worker is briefed with its parent's plan too. An epic is never marked or
  counted, because no worker starts one. A Plan filter, also remembered, shows only the tickets with a plan, or only those without, each
  under its epic. Queue runs them on the model and effort the footer shows, which start as the default set in Settings. Changing them in
  the footer applies to that batch only: the default stays as it is, runs already queued keep their own, and the next batch starts from
  the default again. You do not choose a repository: the worker does.
- **Planned first.** On a machine that sets `tickets.planner`, the footer offers Plan first whenever a selected ticket has no plan of its
  own, and Queue says how many it will plan. Each such ticket's first run is a planning run, on the planning model and effort set in
  Settings, apart from the run's. It plans and changes no code, and the hook refuses it a commit, a push, a worktree and a pull request.
  When it writes `planned`, the board attaches the files it left to the ticket and moves an unstarted ticket to the planner's state. The
  ticket then goes back on the queue where it was, and its run is told the plan was not agreed with a person, so its pull request lists
  each decision the plan made for you. A plan the tracker will not take ends the run for you, with its files kept.
- **Board.** Every run in one list, newest activity first, each with a status icon after GitHub's Actions runs, and a filter per status
  with its count: Needs you, In progress, Planning, Blocked, Queued, Awaiting review, Completed, Failed and Cancelled. A run is Completed once the tracker
  completes its ticket, or once its pull requests have merged, as Linear's GitHub integration reports them. Linear completes a ticket on a
  merge only where its team's workflow says so. A run whose pull requests all closed unmerged is Cancelled. The board asks every two minutes. A run can be removed
  while queued, stopped while running, and retried once it has failed. The number of workers at once is set in Settings, and a change takes effect straight away. On a machine
  that sets `tickets.terminal`, a live or parked run has an Open terminal link to its agent's terminal in the browser.
- **Parked, not closed, when a run needs you.** A run that ends `needs-human`, `wrong-repo` or with no outcome keeps its herdr workspace
  and holds no slot, so you can answer the agent in its terminal. Once the agent works again the run is In progress again, its old outcome
  is moved to `outcome.prev.json`, and the worker must write a new one before it stops. Close shuts a parked run's workspace and keeps its
  outcome, and a parked run is retried only once it is closed.
- **Blocked until what blocks it is done.** A queued run whose ticket the tracker marks "blocked by" another waits, as Blocked, naming what
  it waits on, and holds no slot, while a run queued after it with nothing blocking it starts first. A blocker lets go once the tracker
  completes it, or, when it is on the queue itself, once its run is Completed, which its pull requests merging is enough for. A canceled or
  duplicate blocker never lets go, so a person decides. The blockers are read before a run first starts, and nothing starts while the tracker
  cannot say; they are read again every two minutes, so a relation changed in the tracker counts. A run that waited names its blockers and
  their pull requests in its brief, and checks that any release it depends on is out before relying on it.
- **Paused until you start it.** A new queue is paused, so queueing a ticket never also starts it: queue what you want, then press
  Start workers on the Board when what the workers need is ready. Pause stops new starts and leaves running workers alone, and the
  choice survives a restart of the board.

Each run starts in the ticket's own folder, `<worktreeRoot>/<ticket>`, among the repositories `clones` lists, in one herdr workspace of
ticket mode's own session (never the org's). The worker reads its ticket and decides where the work lands, which a model can do from what a
ticket says and a rule cannot, then makes its worktree there with `ticket:worktree <repo>`. That command keeps the branch rules in code: the
ticket's own branch (`branchName` in Linear, so Linear links the pull request), from the remote's default branch as `ls-remote` reports it,
never an existing branch, and the same worktree again on a retry. The board shows the repositories once the worker has made them. Its brief
is written from the ticket as Linear has it when the run starts, on the branch it was queued with. The brief carries the files on the
ticket, both those its description links to and those attached beside it, such as a plan. When the ticket is part of a parent ticket, the
brief also carries the parent's description, quoted, and the parent's files. Before it commits, a subagent that has not seen the worker's
reasoning reviews the diff, read only, for behaviour it changed but meant to keep. The worker then checks its diff against each
acceptance criterion and each decision that binds the ticket, and backs each behaviour its pull request body claims with an assertion of
exactly that behaviour, run on the base. The worker reads each repository's `CLAUDE.md`/`AGENTS.md` for its commands,
opens a DRAFT pull request per repository it changed, and writes an outcome file: `draft-pr`, `wrong-repo` (the fix belongs in none of them)
or `needs-human`. A worker writes nothing to Linear. The board writes only a planning run's files, attached to its ticket, and the
ticket's move to the planner's state.

**What a worker may not do** is enforced by `ticket:hook`, which the ticket folder's `.claude/settings.local.json` names, so a session herdr
resumes after a restart keeps it. A stop with no outcome file is refused twice in a row. These are refused outright: a pull request that
is not a draft, `gh pr ready`, `merge` and `review`, requesting a reviewer, `gh workflow run`, a force push, and every MCP connector the
machine does not name in `tickets.connectors`. A worker runs with the person's connectors, Slack and mail among them, so a machine names
only the tools its workers need, such as its tracker's reads. A machine adds its own refusals with `tickets.deny`.

**Configuration** is machine facts only, in the host file `$AGENT_ORG_HOST` names. Only `clones` is required, and it lists every repository
a worker can choose from:

```json
{ "clones": { "nbl-ui-netbox": "/path/to/nbl-ui-netbox", "platform-monorepo": "/path/to/platform-monorepo" },
  "tickets": { "max": 3 } }
```

| key | default |
|---|---|
| `tickets.max` | `3` workers at once. A new one also waits while the 1-minute load average is above the core count |
| `tickets.port` | `4747` |
| `tickets.herdrSession` | `tickets` |
| `tickets.worktreeRoot` | `<stateDir>/tickets/worktrees` |
| `tickets.linearKey` | `{ "keychain": "agent-org-linear" }` (macOS Keychain service), or `{ "path": "/abs/file" }` |
| `tickets.brief` | none. A markdown file added to every worker's brief under "On this machine", read again for each run: how workers share the machine, such as the command that starts a dev server without taking a fixed port |
| `tickets.plugins` | none. `["name@marketplace", ...]`: Claude Code plugins every worker runs with, already installed on the machine. A worker starts in its ticket's folder, where none of the person's project settings apply, so a plugin enabled only for a project would be missing |
| `tickets.deny` | none. `[{ "pattern": "<regular expression>", "reason": "<why>" }]`: Bash commands the hook refuses as well as its own, each matched against the whole command, with the reason the worker is told |
| `tickets.connectors` | none, and every connector is refused. `["^mcp__<connector>__<tools>", ...]`: regular expressions, each anchored with `^mcp__`, for the connector tools a worker may call, matched against the tool's name. Linear's reads through the claude.ai connector: `["^mcp__claude_ai_Linear__(get\\|list\\|search\\|extract)_"]`. The brief names them, so a worker can read its ticket's parent and blockers |
| `tickets.terminal` | none, and the board shows no terminal link. A web address that serves a run's terminal, with `{workspace}`, `{pane}` and `{key}` filled in per run: for [herdr web ui](https://github.com/devswha/herdr-web-ui) serving the `tickets` session on port 7318, `"http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal"` |
| `tickets.plan` | none, and the board marks no ticket. A regular expression that the name of a file uploaded to a ticket matches when the file is the ticket's plan. NBL's create-ticket names a plan `<KEY>-0001-plan-<slug>.md`: `"-plan-[^/]*\\.md$"`. A bare `plan` would also match `floorplan.png` |
| `tickets.planner` | none, and the board plans nothing. Needs `tickets.plan`. `{ "run": "<instruction>", "state": "<state>" }`: what a planning run is told, with `{key}` and `{dir}` filled in per run (the ticket, and the folder its plan's files go in), and the tracker state a planned ticket moves to if it has not started. A team with no state of that name keeps the ticket's state, and the board's log says so, because teams name their states differently. NBL: `{ "run": "Run the nbl-ui:create-ticket skill with this request: unattended: plan {key} into {dir}", "state": "Planned" }` |
| `stateDir` | `~/.local/state/agent-org`: the queue, each ticket's brief, attachments and outcome |

The Linear key is a personal API key, so ticket mode reads as you and needs no workspace admin. On macOS, store it once with
`security add-generic-password -a "$USER" -s agent-org-linear -w`, which prompts for it without echoing it.

## What an install holds

`src/` (the programs and their data, without `*.test.*`), `host/` (the unit templates `host:install` reads), `LICENSE`, `README.md` and
`package.json`. The tests are not shipped: they read the project's tree and run in this repository's CI.

`typescript` is a peer dependency, resolved from the project's directory first and the tool's own tree second, so the tool parses the project's code
with the project's compiler. Tested on Node 24.21.0.

## Source is TypeScript

**Every source file is `.ts`, run by `node file.ts` with no loader** (ADR 0043, a11ign/a11ign#3550, #4389). Node 24 strips the types itself
(`process.features.typescript` prints `strip`), `engines.node` is `>=24`, and `tsx` is not a dependency. `src/packaging/mjs-ratchet.test.ts` judges the
`.js`/`.mjs`/`.cjs` files against `mjs-ratchet.baseline.json` and fails on a file the baseline does not list, so the count can only go down and there is no raise.
The mapping from `@ts-check` JSDoc to types is in the ADR's table. Type stripping erases syntax and nothing else, so `enum`, `namespace` and parameter properties are
refused (`erasableSyntaxOnly`), and a relative import names the `.ts` file.

**One limit: Node refuses to strip types under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on 24.21.0 and decided on the real path). So the tool
runs from a checkout outside `node_modules`, which is what `host/agent-org` and the `AGENT_ORG_TOOL` clone are; a copy a package manager installs under `node_modules` can
be read but not run.

## Releases

**A tag is the release.** `v<version>` on this repository, with a GitHub Release carrying the `CHANGELOG.md` entry, and nothing is published to a registry. **A tag is
never moved or deleted once a project can have pinned it**: a moved tag changes what a pinned project gets, so a mistake is fixed by the next version.

A release starts itself, on the merge that carries a changeset, and no pull request stands between the merge and the tag (a11ign/a11ign#3134, #3187); nobody dispatches anything:

1. A pull request that changes what a project gets carries a changeset (`pnpm run changeset add`). Merge it.
2. On that push to `main`, **release** waits for `gate` to have succeeded on that sha, then reads which changesets the last tag already consumed (the ones its commit deleted
   from its parent). If any other is pending it builds a **release commit** on top of the merge, carrying the last tag's version and `CHANGELOG.md` with `changeset version`
   run over the unreleased changesets, and pushes it as the tag `v<version>` with a Release carrying the changelog entry. The release commit is on no branch, so nothing is
   written to `main`, and nothing else is needed: no pull request per release, no token beyond the job's own. It refuses if `CHANGELOG.md` has no entry for the version or the
   remote's tags cannot be read, never forces the push, and holds `contents: write` and nothing else.
3. **`main`'s `package.json` version and `CHANGELOG.md` lag the last tag**, and are left to: a project pins the tag's tree, which holds both, and the next version is computed
   from the tag. A later merge with no unreleased changeset cuts nothing, and the next one that carries a changeset is a different, later tag.

The tag is what reaches the running org: the host that runs the org runs the newest `vX.Y.Z` tag (`update-tool` checks it out), and `host.json`'s `toolVersion` pins one tag
instead, which is the whole of a rollback. A merge with a changeset is live about nine minutes after it lands (measured from the tag history on a11ign/a11ign#3443), and a merge
with no changeset is never tagged and so never live. A release therefore changes what a project's CI installs and what the running org does.

A project bumps its pin by editing the range in its `package.json` (`github:a11ign/agent-org#semver:^0.1.0`) in an ordinary dependency pull request and reading the
changelog it links. While the version is `0.x`, `^0.1.0` takes patches only, so a `minor` is the bump a project opts into.
