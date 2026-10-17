# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

Install the newest release with one command. It needs Node 24 or newer and git, and it uses no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
```

The installer clones the newest release tag into `~/.agent-org/agent-org` (`$AGENT_ORG_HOME/agent-org` when that is set), installs the
release's dependencies, and writes the `agent-org` launcher into `~/.local/bin`. It changes nothing else. When `~/.local/bin` is not on your
`PATH`, it prints the line to add. Add `-s -- --version vX.Y.Z` after `bash` to install one release. Running it again updates the same checkout.

Then run these commands:

| command | what it does |
|---|---|
| `agent-org onboard` | Writes the host file, `~/.agent-org/host.json` (or the file `$AGENT_ORG_HOST` names). It asks for the repositories a worker can choose from and where the Linear key is read from, or takes them as `--repo <name>=<path>` (repeated) and `--linear-keychain <service>` or `--linear-key-file <path>`. It keeps the host file's other keys. When no key is readable, it stores one from a prompt that does not echo. It then starts the instance service, unless you pass `--no-start`. |
| `agent-org doctor` | Checks Node, the launcher on `PATH`, the host file, `herdr`, the Linear key and the instance service, and prints the fix for each check that fails. It exits 1 when any check fails. |
| `agent-org start [instance\|ui]` | Registers the service to start at login and starts it: a launchd user agent on macOS, a systemd user unit on Linux. The instance service runs `ticket:serve`. The service is `instance` when you name none. |
| `agent-org stop [instance\|ui]` | Stops the service and keeps it from starting at login. |
| `agent-org status [instance\|ui]` | Prints whether the service is running, stopped or not registered. It exits 3 when the service is not running. |
| `agent-org update` | Moves the install to the newest release, or to `--version vX.Y.Z`, and restarts each service that was running. `--channel main` follows `main` instead of releases. It refuses a checkout with changes to tracked files. |

The macOS service writes its log to `~/.agent-org/logs/<service>.log`. On Linux, read it with `journalctl --user -u agent-org-instance`.

### As a project's dependency

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
takes them one each. Ticket mode is two services, both on `127.0.0.1`:

- **The instance**, `agent-org ticket:serve`, on `tickets.port` (`4747`). It holds the queue, the pool of workers, herdr, the tracker and the
  `/api/...` routes, and serves no page. It answers only to its key, from `<stateDir>/tickets/board.key`, sent as the `x-ticket-token`
  header. Scripts call it with that key as before. Run one instance per machine.
- **The page**, `agent-org ticket:ui`, on `tickets.uiPort` (`4748`). It serves the board's page and holds no queue. It shows each instance
  its connections file names (see "Other machines' instances" below), and with no file it shows this machine's. It prints its URL, which
  carries no secret. The browser talks only to it, and it passes the page's calls on to the chosen instance with that instance's key.

- **Pair a browser once.** A browser the page's service has not seen shows a pairing page. Run `agent-org ticket:pair` and type the code it prints:
  a code works once, within 10 minutes, and five wrong codes spend it. The browser then holds a session of its own, as an HttpOnly cookie,
  for a year and across restarts. The service keeps only the sessions' hashes, in `<stateDir>/tickets/browsers.json`, and deleting that file
  unpairs every browser. The service refuses to start on a file that does not hold sessions, rather than unpair every browser silently.
  Only the board key makes a pairing code. A request that holds it is passed on to no instance, but it can pair a browser, which reaches
  every connection, so whoever holds the key is trusted as you are. The key never goes to a browser, because a browser sends its cookies
  for `127.0.0.1` to every port there. An instance ignores a browser's cookie. Both files are made with mode 600, and a key file another
  user owns or can read is refused.

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
- **Queued together, planned together.** When `tickets.planner.run` names `{keys}`, the tickets one press of Queue plans first are one
  batch, and one planning run plans them, at most 8 to a run: a larger batch splits into runs of 8, in queue order. Tickets queued at
  different times are never batched. Every ticket of the batch shows as Planning, all linking to the run's one terminal, and the batch holds
  one worker slot. The run writes a folder per ticket in its plan folder, holding that ticket's plan files or a `QUESTION.md`, and an
  `order.json` giving each ticket's repository and the tickets of the batch it waits on. When it writes `planned`, each ticket with plan
  files has them attached and is queued again to be worked. A ticket with a question, or with nothing, ends as Needs you, and the others
  carry on. The board records the order in the tracker as "blocks" relations, so a ticket that waits on another shows as Blocked until it
  is done. An order that names a ticket outside the batch, a ticket waiting on itself or a cycle records no relation, and the board's log
  says why. A run that ends any other way ends every ticket of the batch that way. Stop on any ticket stops the whole run, and Retry plans
  a ticket again on its own.
- **Board.** Every run in one list, newest activity first, each with a status icon after GitHub's Actions runs, and a filter per status
  with its count: Needs you, In progress, Planning, Reviewing, Blocked, Queued, Awaiting review, Ready to merge, Publishing, Published, Completed, Failed and Cancelled. A run is Completed once the tracker
  completes its ticket, or once its pull requests have merged, as Linear's GitHub integration reports them. Linear completes a ticket on a
  merge only where its team's workflow says so. A run whose pull requests all closed unmerged is Cancelled. The board asks every two minutes. A run can be removed
  while queued, stopped while running, and retried once it has failed. The number of workers at once is set in Settings, and a change takes effect straight away. On a machine
  that sets `tickets.terminal`, a live or parked run has an Open terminal link to its agent's terminal in the browser.
- **Parked, not closed, when a run needs you.** A run that ends `needs-human`, `wrong-repo` or with no outcome keeps its herdr workspace
  and holds no slot, so you can answer the agent in its terminal. Once the agent works again the run is In progress again, its old outcome
  is moved to `outcome.prev.json`, and the worker must write a new one before it stops. A worker that writes a new outcome file after its
  run parked, even between two of the board's looks, ends the run on it once its agent is idle. Close shuts a parked run's workspace and keeps its
  outcome, and a parked run is retried only once it is closed.
- **Approve, once you have reviewed the drafts.** A run Awaiting review offers Approve. It queues the ticket again
  as a review run, which resumes the worker that wrote the code in its own Claude session: the board saves it when a run ends, and for an
  older run takes the newest session Claude Code kept for the ticket's folder, starting a fresh worker only when there is none. The review run
  marks each pull request ready, which only a review run may do, waits up to 30 minutes for its checks and its review, fixes and answers what
  they find, pushes, and waits for the checks on that push. It waits in the foreground, with blocking commands such as
  `gh pr checks <url> --watch --interval 30`, and never by ending its turn: a turn that ends without an outcome reads as a run that stopped.
  It ends Ready to merge only when every check passed on the last commit, and otherwise hands the run back as Needs you. `tickets.review` says
  what a review is on this machine.
- **Watched once Ready to merge, and answered on its own.** Every 3 minutes the board reads the open pull requests of each run Ready to merge
  or Published. A review that comments or requests changes, a conversation comment or an inline comment newer than the run's last round, from
  anyone but the GitHub account the workers use (`gh api user`), queues another review round. So does a check that failed on the head commit
  since then: the required checks, or every check where none is required. The round resumes the same worker, names what started it, and has
  the worker fix what is right with a test, answer what is wrong with evidence, push, and wait for the checks. The board starts at most 3 such
  rounds. The next trigger hands the run to you as Needs you, saying its pull requests keep getting feedback. Feedback that arrived while a
  round was running is not answered twice. Merged or closed pull requests are never watched.
- **Respond to review, for pull requests that are ready already.** A run Ready to merge, Published, or handed back after the board's 3 rounds,
  offers Respond to review. It queues a review round straight away, resuming the same worker, told that you asked it to answer the current
  feedback: reviews, comments and failing checks. It starts the count of the board's own rounds again, so watching carries on after it.
- **Publish, once a run is Ready to merge.** On a machine that sets `tickets.publish`, each run Ready to merge has a Publish tick, and
  "Publish selected (N)" publishes every ticked run in one press. Nothing else can be ticked: nothing reaches a channel before you approved it
  and it passed its review and checks, and a Published run is never posted twice. The press starts one publish run, in its own folder
  `<stateDir>/tickets/publish/<id>`, holding one slot, on `tickets.publish.model` and `effort`. It starts even while workers are paused,
  because you just asked for it. While it works, each run it posts shows Publishing, with the spinning ring and, on a machine that sets
  `tickets.terminal`, an Open terminal link to the publish run's own terminal. It writes `published.json`, `{ "links": ["<message url>"] }`, and the outcome `published`. Each run it
  posted then shows Published, with a link to the first message, stays watched, and still turns Completed when its pull requests merge. A
  publish run that fails, or takes over 30 minutes, leaves its runs Ready to merge, and the Board says why.
- **Blocked until what blocks it is done.** A queued run whose ticket the tracker marks "blocked by" another waits, as Blocked, naming what
  it waits on, and holds no slot, while a run queued after it with nothing blocking it starts first. A blocker lets go once the tracker
  completes it, or, when it is on the queue itself, once its run is Completed, which its pull requests merging is enough for. A canceled or
  duplicate blocker never lets go, so a person decides. The blockers are read before a run first starts, and nothing starts while the tracker
  cannot say; they are read again every two minutes, so a relation changed in the tracker counts. A run that waited names its blockers and
  their pull requests in its brief, and checks that any release it depends on is out before relying on it.
- **Stacked on its blocker when both land in one repository.** A queued run whose planner recorded its repository (a ticket planned in a
  batch) does not wait for a blocker that has an open pull request, a draft included, in that same repository. It starts on top of it
  instead, and the board says "Stacked on NBF-1 #12". The brief names each such blocker's pull request and branch. The worker makes its
  worktree from the branch it builds on with `ticket:worktree <repo> --from <branch>`, opens its draft pull request, and runs
  `gh stack link <blocker's pull request> <its own>`. This holds for every "blocked by", whoever recorded it. A run with no planned
  repository, or a blocker with no open pull request there, waits as before.
- **Paused until you start it.** A new queue is paused, so queueing a ticket never also starts it: queue what you want, then press
  Start workers on the Board when what the workers need is ready. Pause stops new starts and leaves running workers alone, and the
  choice survives a restart of the board.

Each run starts in the ticket's own folder, `<worktreeRoot>/<ticket>`, among the repositories `clones` lists, in one herdr workspace of
ticket mode's own session (never the org's). The worker reads its ticket and decides where the work lands, which a model can do from what a
ticket says and a rule cannot, then makes its worktree there with `ticket:worktree <repo>`. That command keeps the branch rules in code: the
ticket's own branch (`branchName` in Linear, so Linear links the pull request), from the remote's default branch as `ls-remote` reports it
(or, with `--from <branch>`, from the branch of a blocker it is stacked on), never an existing branch, and the same worktree again on a retry. The board shows the repositories once the worker has made them. Its brief
is written from the ticket as Linear has it when the run starts, on the branch it was queued with. The brief carries the files on the
ticket, both those its description links to and those attached beside it, such as a plan. When the ticket is part of a parent ticket, the
brief also carries the parent's description, quoted, and the parent's files. Before it commits, a subagent that has not seen the worker's
reasoning reviews the diff, read only, for behaviour it changed but meant to keep. The worker then checks its diff against each
acceptance criterion and each decision that binds the ticket, and backs each behaviour its pull request body claims with an assertion of
exactly that behaviour, run on the base. The worker reads each repository's `CLAUDE.md`/`AGENTS.md` for its commands,
opens a DRAFT pull request per repository it changed, and writes an outcome file: `draft-pr`, `wrong-repo` (the fix belongs in none of them)
or `needs-human`. A worker writes nothing to Linear. The board writes only a planning run's files, attached to its ticket, the
ticket's move to the planner's state, and a batch's order as "blocks" relations.

**What a worker may not do** is enforced by `ticket:hook`, which the ticket folder's `.claude/settings.local.json` names, so a session herdr
resumes after a restart keeps it. A stop with no outcome file is refused twice in a row. These are refused outright: a pull request that
is not a draft, `gh pr ready`, `merge` and `review`, requesting a reviewer, `gh workflow run`, a force push, every `gh stack` command but
`gh stack link`, the `post-pr-to-slack` skill, and every MCP connector the
machine does not name in `tickets.connectors`. Only a publish run may run that skill and call the connectors `tickets.publish.connectors`
names: the board leaves a `publish-run` mark in its folder, which no worker may write, as it leaves `review-run` for a review run. A worker runs with the person's connectors, Slack and mail among them, so a machine names
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
| `tickets.port` | `4747`: the instance's port |
| `tickets.uiPort` | `4748`: the page's port. It must differ from `tickets.port` |
| `tickets.herdrSession` | `tickets` |
| `tickets.worktreeRoot` | `<stateDir>/tickets/worktrees` |
| `tickets.linearKey` | `{ "keychain": "agent-org-linear" }` (macOS Keychain service), or `{ "path": "/abs/file" }` |
| `tickets.brief` | none. A markdown file added to every worker's brief under "On this machine", read again for each run: how workers share the machine, such as the command that starts a dev server without taking a fixed port |
| `tickets.review` | none. A markdown file added to every review run's brief under "How this machine reviews", read again for each run: which checks must pass and which reviewer to wait for once a pull request is marked ready |
| `tickets.plugins` | none. `["name@marketplace", ...]`: Claude Code plugins every worker runs with, installed for the user (`--scope user`). A worker starts in its ticket's folder, which is a project of its own, so a plugin installed only for another project would be missing: the board refuses to start a run until each one is installed for the user, and names the command |
| `tickets.deny` | none. `[{ "pattern": "<regular expression>", "reason": "<why>" }]`: Bash commands the hook refuses as well as its own, each matched against the whole command, with the reason the worker is told |
| `tickets.connectors` | none, and every connector is refused. `["^mcp__<connector>__<tools>", ...]`: regular expressions, each anchored with `^mcp__`, for the connector tools a worker may call, matched against the tool's name. Linear's reads through the claude.ai connector: `["^mcp__claude_ai_Linear__(get\\|list\\|search\\|extract)_"]`. The brief names them, so a worker can read its ticket's parent and blockers |
| `tickets.terminal` | none, and the board shows no terminal link. A web address that serves a run's terminal, with `{workspace}`, `{pane}` and `{key}` filled in per run: for [herdr web ui](https://github.com/devswha/herdr-web-ui) serving the `tickets` session on port 7318, `"http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal"` |
| `tickets.plan` | none, and the board marks no ticket. A regular expression that the name of a file uploaded to a ticket matches when the file is the ticket's plan. NBL's create-ticket names a plan `<KEY>-0001-plan-<slug>.md`: `"-plan-[^/]*\\.md$"`. A bare `plan` would also match `floorplan.png` |
| `tickets.planner` | none, and the board plans nothing. Needs `tickets.plan`. `{ "run": "<instruction>", "state": "<state>" }`: what a planning run is told, with `{key}` and `{dir}` filled in per run (the ticket, and the folder its plan's files go in), and the tracker state a planned ticket moves to if it has not started. An instruction that names `{keys}` instead plans the tickets queued together in one run: `{keys}` is their keys, separated by a comma and a space, and `{dir}` the run's one plan folder. A ticket planned alone gets its own key there. One that names only `{key}` plans every ticket alone. A team with no state of that name keeps the ticket's state, and the board's log says so, because teams name their states differently. NBL: `{ "run": "Run the nbl-ui:create-ticket skill with this request: unattended: plan {key} into {dir}", "state": "Planned" }`, or `plan {keys} into {dir}` to plan in batches |
| `tickets.publish` | none, and the board shows no Publish tick or button. `{ "run": "<instruction>", "model": "haiku", "effort": "low", "connectors": ["^mcp__..."] }`: what a publish run is told, with `{prs}` (the ticked runs' open pull requests, one per line) and `{dir}` (its folder) filled in, the model and effort it runs on, and the connector tools it alone may call, each anchored with `^mcp__`, such as the one that sends a Slack message. NBL: `{ "run": "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json" }` with its Slack send tool in `connectors` |
| `tickets.workingState` | none, and no ticket is moved. The tracker state a ticket moves to as a worker starts implementing it, if it has not started yet: `"In Progress"`. A planning run moves nothing. A team with no state of that name keeps the ticket's state, and the board's log says so |
| `stateDir` | `~/.local/state/agent-org`: the queue, each ticket's brief, attachments and outcome |

The Linear key is a personal API key, so ticket mode reads as you and needs no workspace admin. On macOS, store it once with
`security add-generic-password -a "$USER" -s agent-org-linear -w`, which prompts for it without echoing it.

**Other machines' instances, from this page.** Each machine runs its own instance on its own `127.0.0.1`, with its own queue, workers,
worker limit and load check. One page can show several of them, picked from a switcher in the header. The choice is remembered in that
browser. Switching changes only what the page shows: every instance keeps working while another is shown, and one that cannot be reached
shows its reason without affecting the others. The connections file is `~/.config/agent-org/connections.json`, or
`$XDG_CONFIG_HOME/agent-org/connections.json` when that variable is an absolute path:

```json
{
  "work": { "local": true },
  "personal": { "ssh": "agents" },
  "lab": { "https": "https://agents.example.ts.net", "keyFile": "~/.agent-org/keys/lab" }
}
```

- `{ "local": true }` is this machine's instance, read with the key in its state directory. At most one connection is local. A machine
  that runs only the page can have none.
- `{ "ssh": "<target>" }` is the instance on the machine `ssh <target>` reaches, exactly as `herdr --remote` takes it, such as a `Host`
  from `~/.ssh/config` or `me@host`. It may also name `agentOrg`, the path of `agent-org` on that machine, when a non-interactive shell
  there does not find it on its `PATH`. Nothing on that machine is exposed.
- `{ "https": "<address>", "keyFile": "<path>" }` is an instance exposed on purpose behind TLS, such as on a private network. The address
  is the instance's address alone. Plain `http://` is refused unless the host is `127.0.0.1`, `localhost` or `[::1]`, because the key
  would cross the network in the clear. The key file holds a copy of that instance's `board.key`. It must be yours and mode 600, or that
  connection is refused when it is reached.
- A name is 1 to 32 letters, digits, `-` or `_`. With no file, the page shows this machine's instance alone, as
  `{ "local": { "local": true } }`. A file that is not JSON or breaks a rule above is refused, the page's service names why in its log and
  on the page, and it shows this machine's instance alone.
- A `profiles.json` in the same directory, the file this one replaced, is read as the connections file when there is no
  `connections.json`, and the log says so. Its entries are connections already. It is read until the next major version: rename it.
- The page's service holds every key in its memory. A key is not written to a log, a command line or the page, and it is sent only in the
  `x-ticket-token` header. Only a paired browser's call to `/c/<connection>/api/...` is passed on, as the instance's own `Host`, and only
  for the routes the page calls, so a pairing code is never asked for there. A connection that cannot be reached is shown on the page as
  `cannot reach <connection> <how>: <reason>`.

**Connect a second machine over SSH.** The page's service opens the SSH connection itself. It runs
`ssh <target> agent-org ticket:remote-info` once per connection, which prints that instance's port, key and terminal address as JSON. It
then holds `ssh -N` open, forwarding a Unix socket in a directory only you can enter to that instance's port, and a free port on this
machine's `127.0.0.1` to its terminal service. Both run with `BatchMode=yes` and no TTY, so a key that needs a passphrase not held in an
agent fails rather than waits. They share no connection, agent or X11 forwarding from your ssh config. A tunnel that drops is opened
again, after 2 seconds and up to a minute between tries. Every tunnel closes when the service exits, unless it is killed with `SIGKILL`,
which leaves its `ssh` processes running. Open terminal on that machine's runs goes through the same SSH connection when its
`tickets.terminal` is on its own `127.0.0.1` or `localhost`. Any process on this machine can reach that forwarded port while the tunnel
is open, as it can reach the remote's own terminal service from that machine.

That machine needs four things. This machine reaches it with `ssh <target>` and no prompt, through a key in an agent or one with no
passphrase. agent-org is installed there, and a non-interactive `ssh <target> agent-org ticket:remote-info` finds it and its host file,
so `AGENT_ORG_HOST` must be set for that shell (`~/.zshenv` for zsh, or `agentOrg` naming a wrapper that sets it). Its instance is
running, with `agent-org ticket:serve`. Its instance has made its key, which its first start does. `ticket:remote-info` refuses to print
the key to a terminal. Check the whole path from this machine with `ssh <target> agent-org ticket:remote-info > /dev/null && echo ok`,
which prints `ok` and not the key.

**Connect a second machine over https.** An instance stays on `127.0.0.1` unless you expose it on purpose, behind TLS, on a network you
trust, such as a private network. The TLS proxy in front of it must send the instance `Host: 127.0.0.1:<port>`, as nginx's
`proxy_pass` does by default, because the instance refuses any other host. A proxy that passes the original host on is refused. Copy that machine's `<stateDir>/tickets/board.key` to this one,
`chmod 600` it, and name it as the connection's `keyFile`. Anyone who can reach the address and holds the key can drive that instance, so
keep the address off the public internet. Open terminal on that machine's runs shows only when its `tickets.terminal` is not on its own
loopback.

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
