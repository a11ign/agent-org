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
| `agent-org onboard` | Writes the host file, `~/.agent-org/host.json` (or the file `$AGENT_ORG_HOST` names). It asks for the repositories a worker can choose from and where the Linear key is read from, or takes them as `--repo <name>=<path>` (repeated) and `--linear-keychain <service>` or `--linear-key-file <path>`. It keeps the host file's other keys. When no key is readable, it stores one from a prompt that does not echo. It records the host file's path in `~/.agent-org/host-file`, so a shell with no `AGENT_ORG_HOST` finds it. It sets up the web terminal: it installs `bun` into `~/.bun/bin` when there is none (from bun's release zip, with no `unzip` and no `sudo`), installs the herdr plugin `devswha/herdr-web-ui`, and writes `tickets.terminal` when it is absent (`--no-terminal` skips this). With a readable key and no `linear` MCP yet, it registers Linear's MCP for Claude Code at user scope, authenticated by the key, and adds Linear's read and comment tools to `tickets.connectors`. It never prints the key. It installs the `github/gh-stack` extension, which a worker's `gh stack link` needs, for the workers' account (the host file's `gh.workers`) when it is not listed. A failure is said with the command to run by hand, and does not fail onboard: `doctor` does. It then starts the instance, ui, terminal and auto-update services, unless you pass `--no-start`. `--no-auto-update` leaves auto-update unregistered, and `--update-channel main` makes it follow `main`. A terminal or auto-update service that cannot start is reported and skipped. An instance or ui service that cannot start fails onboard. With `tickets.serve` set, the ui and terminal services are also served on the tailnet, as `start` describes. |
| `agent-org doctor` | Checks Node, the launcher on `PATH`, the host file, `herdr`, the Linear key, and that `claude mcp list` shows `linear` connected. It checks whether each service is registered and answers on its port. For the web terminal, it checks that `tickets.terminal` is on this machine's loopback and that herdr web ui answers `/api/health` there. For auto-update, it checks that the service is registered. A unit systemd will not load (`bad-setting`) is reported with the line systemd refused. Doctor prints the fix for each check that fails, and exits 1 when any check fails. With `tickets.serve` set, it also checks tailscale (Running, with a DNS name) and each served port: its `tailscale serve` entry, that it is not on Funnel, and that it answers under the machine's name. It also says how many releases behind the newest one the install is, and since when (`update lag`; it fails once the install has waited past `tickets.updateMaxDeferHours` and an hour's grace). It checks the `github/gh-stack` extension a worker's stacked pull request needs, for the workers' account, and fails with the install command when it is missing. Where a clone is on GitHub it also checks that GitHub makes stacked pull requests available to that repository: stacked pull requests are a GitHub preview, so a repository GitHub refuses is named, with the preview requirement (`stacked pull requests`). It fails when a herdr server of the instance's session is still inside the instance's cgroup, a server started before herdr had its own scope, and prints both fixes: restart herdr when no run is working, or `KillMode=process` in the instance unit (`herdr scope`). |
| `agent-org start [instance\|ui\|terminal\|auto-update]` | Registers the service to start at login and starts it: a launchd user agent on macOS, a systemd user unit on Linux. The instance service runs `ticket:serve`, the queue and its workers. The ui service runs `ticket:ui`, the page. The terminal service runs herdr web ui for `tickets.herdrSession` on `127.0.0.1`, on the port `tickets.terminal` names (`7318` by default). The auto-update service runs `agent-org update` every hour: a systemd timer on Linux, a launchd `StartInterval` job on macOS. The service is `instance` when you name none. Starting a service writes its unit again, which fixes a unit systemd refused. With `tickets.serve: "tailscale"`, the ui and terminal services are also served on the tailnet with `tailscale serve --bg`, on `tickets.servePorts`, after their checks pass: tailscale is Running with a DNS name, and the port is free of Funnel and of other entries. A check that fails names its fix, and the service is not started. The instance and auto-update are never served. A service that is started but cannot be served on the tailnet says so, and it stays on loopback. |
| `agent-org stop [instance\|ui\|terminal\|auto-update]` | Stops the service and keeps it from starting at login. `agent-org stop auto-update` turns automatic updates off. With `tickets.serve`, the ui and terminal services also lose their own tailnet entry, on their own port only: no other entry on the host is named, and no Funnel is changed. If that entry cannot be removed, the service stays stopped and the command says how to remove it. |
| `agent-org status [instance\|ui\|terminal\|auto-update]` | Prints whether the service is running, stopped or not registered, and the reason when systemd will not load its unit. It exits 3 when the service is not running. |
| `agent-org update` | Moves the install to the newest release, or to `--version vX.Y.Z`, and restarts each service that was running. `--channel main` follows `main` instead of releases. It refuses a checkout with changes to tracked files. While the instance service runs a live run, it moves nothing and prints `deferred: N runs live` (with why and until when) only when a restart would interrupt a worker, and exits 0; `--force` updates and restarts anyway. It keeps the `github/gh-stack` extension present on every run, whether it moved, did not move, or was deferred; a failure is said and does not change its exit code. |

The macOS service writes its log to `~/.agent-org/logs/<service>.log`. On Linux, read it with `journalctl --user -u agent-org-<service>`.

**Kept up to date.** The auto-update service runs `agent-org update` every hour, following `release` or, when `~/.agent-org/update-channel`
says `main`, `main`. Update restarts the instance and ui services only when the checkout moved, so an hour with nothing new restarts nothing.
It refuses a checkout with changes to tracked files, as a manual update does. A live run on the instance holds a release back only while a
restart would interrupt a worker (A11-90). When nothing is newer, it says nothing about deferring. When a release is newer, it goes ahead at once if
herdr's server is outside the instance's cgroup (checked from `/proc` and systemd, or the launchd job's process group on macOS), or if no agent is
mid-tool-call. Otherwise it moves nothing, says `deferred: N runs live` with why and until when, and the next hour tries again. A deferral lasts
at most `tickets.updateMaxDeferHours` (2 by default) from its first hour, and then the update goes ahead. Each run writes
`~/.agent-org/update-status.json`, which `doctor` reads to say how far behind the install is, and since when.

**A restart leaves the workers alone.** The workers run in ticket mode's herdr server, which the instance starts outside its own service (on
Linux under systemd, in a scope of its own through `systemd-run --user --scope`), so restarting the instance never stops a worker. The instance
that starts up adopts the runs herdr lists and carries on watching them: it sends their panes no key, no prompt and no second start, and a
reviewer it started for a head is not started again. A herdr server an older instance started is still inside that instance's service, so the
first restart after updating to this version still stops it; update waits for no run to be live before it does.

**The host file without `AGENT_ORG_HOST`.** Every command finds the host file in this order: `$AGENT_ORG_HOST`, then the path in
`~/.agent-org/host-file` (which onboard writes), then the `AGENT_ORG_HOST` in the instance service's unit, then `~/.agent-org/host.json`.
A `ticket:*` command started with no `AGENT_ORG_HOST` gets that path. With no `GH_CONFIG_DIR`, it also gets the workers' `gh` account the host
file declares (`<gh.workers>/gh`). The instance, ui and auto-update units carry the same account. So `ssh <machine> agent-org ticket:remote-info`
and a `ticket:*` command from a plain shell read what the services read.

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

- **Pair a browser once.** A browser the page's service has not seen shows a pairing page. Run `agent-org ticket:pair` and type the board's code, which it prints first, into the board page:
  a code works once, within 10 minutes, and five wrong codes spend it. The browser then holds a session of its own, as an HttpOnly cookie,
  for a year and across restarts. The service keeps only the sessions' hashes, in `<stateDir>/tickets/browsers.json`, and deleting that file
  unpairs every browser. The service refuses to start on a file that does not hold sessions, rather than unpair every browser silently.
  Only the board key makes a pairing code. A request that holds it is passed on to no instance, but it can pair a browser, which reaches
  every connection, so whoever holds the key is trusted as you are. The key never goes to a browser, because a browser sends its cookies
  for `127.0.0.1` to every port there. An instance ignores a browser's cookie. Both files are made with mode 600, and a key file another
  user owns or can read is refused.

- **Pair the worker terminal.** The worker terminal (herdr web ui) has a pairing code of its own. `agent-org ticket:pair` prints it after the
  board's code when `tickets.serve` is set and `tickets.terminal` is this machine's own, and `agent-org ticket:pair --terminal` prints it
  alone (`--board` prints the board's alone). No path is typed: the command runs herdr web ui's own `pair` with the terminal service's
  variables set over this shell's environment. The code works once, within 10 minutes, for one device. If the terminal is not running, the
  command exits 1 and says how to start it, after the board's code is printed. A terminal that another machine serves is paired there, with
  `agent-org ticket:pair --terminal` run on that machine; a served board names it. If this machine's tailnet name cannot be read, the board
  says so, rather than naming another machine.

- **A worker link pairs the terminal for a paired browser.** Following a run's "Open terminal" link, a paired browser goes through the
  page's service, which asks this machine's terminal for a code and opens the terminal with `?pair=<code>` in its address. The page's service
  asks only for a paired browser, only for that connection's own terminal address, and redirects with `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`. Nothing logs the code. The terminal asks as its own `pair` does: from this machine, over loopback with no
  proxy headers, with herdr web ui's token from its config directory when one is set. Any failure, such as a terminal that is not running,
  a token it refuses, or a route a newer release changed, opens the plain address, and `--terminal` pairs by hand as before. The residual
  risks are that anyone holding the redirected address within its 10 minutes can pair one device, and that asking for a code replaces one
  `--terminal` printed a moment before. Checked against herdr web ui 0.4.11 (`server/devices.ts`, `server/access.ts`, `scripts/plugin.ts`):
  the terminal's own gate decides who may ask, and the board adds no new trust path.

- **On the tailnet, if you serve it.** With `tickets.serve: "tailscale"`, the page and the terminal are served on your tailnet with
  `tailscale serve`, on `tickets.servePorts` (`9443` and `9444`), and never with Funnel. Tailscale decides who can reach the board, and
  pairing still decides which browser may use it. The page accepts this machine's MagicDNS name as its `Host` as well as `127.0.0.1`, and any
  other `Host` is refused as before. The instance is not served and answers only on `127.0.0.1`. The terminal plugin keeps its own access
  rules: the board sets none of them, so a device that reaches the terminal is subject to herdr web ui's settings, not to the board's pairing.
  The board never uses Funnel, and `agent-org stop` removes only the two entries this feature made.

- **Pick.** The open Linear tickets, grouped by status the way Linear shows them, with Select All per group and for the page. An Assignee row
  chooses whose they are: you (the default, so the list starts as it always has), Anyone, Unassigned, or each other person with an open ticket,
  each with its count. Every ticket outside your own list shows its owner on its row, so one is never queued by accident. The choice is not
  remembered: each load starts on the default. A tracker that cannot say whose key it is lists Anyone's tickets, and says why in the row's title.
  An instance from before the Assignee row lists your assigned tickets as it did. A ticket sits under its parent, whatever its own status. A parent folds the tickets under it away, and starts folded.
  Its checkbox picks every ticket under it that is not on the queue, never the parent itself, and shows part ticked when only some are picked.
  A parent that is not yours, such as an epic someone else owns, says so. A ticket Linear says has open sub-issues (not completed, canceled
  or a duplicate, read with the list in the same request) is a parent too, even when none of them is in your list: it is marked "Parent",
  counts them, has no checkbox, and offers Queue its children instead. That queues its open sub-issues, on the footer's model and effort,
  in the order their "blocked by" relations give, or in identifier order where Linear gives none, which the page then says. A sub-issue
  that is itself a parent is left out and named. The instance refuses a parent on `/api/queue` with a 400 saying why, whatever asked, and
  once every sub-issue is done or canceled the ticket is an ordinary one again. Filter by Linear project or priority (several of each at once) or by search, and fold any status group; each is remembered in the
  browser. Labels filter too: each Linear label group among the listed tickets (a parent label, such as a group "Goal" whose labels say what
  each ticket is for) gets a row of its own, named after it, with its labels as chips and their counts, and a "(no Goal)" chip for the
  tickets still without one. The labels in no group share one "Labels" row, shown only when there are any. A row works like the projects:
  All clears it, several chips show a ticket with any of them, and rows combine with each other and every other filter. The labels are read
  in the same request as the list, the choice is remembered in the browser, and each ticket shows its group labels as small tags after its title. On a machine that sets `tickets.plan`, a ticket with no plan of its own is marked, so you can attach one before a worker starts it.
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
  that sets `tickets.terminal`, a live or parked run has an Open terminal link to its agent's terminal in the browser. A run whose worker wrote `done` is Completed too: the board moves its ticket to the tracker's completed state and posts the worker's reason and evidence on it (see Outcomes below).
- **Parked, not closed, when a run needs you.** A run that ends `needs-human`, `wrong-repo` or with no outcome keeps its herdr workspace
  and holds no slot, so you can answer the agent in its terminal. Once the agent works again the run is In progress again, its old outcome
  is moved to `outcome.prev.json`, and the worker must write a new one before it stops. A worker that writes a new outcome file after its
  run parked, even between two of the board's looks, ends the run on it once its agent is idle. Close shuts a parked run's workspace and keeps its
  outcome, and a parked run is retried only once it is closed.
- **The ticket goes back when its run ends without a pull request.** When a run moves its ticket to `tickets.workingState`, the board keeps the
  state the ticket came from on the run. A run that is stopped, crashes or checks its ticket, or a queued run that is removed, puts the ticket
  back in that state. A run that ends `needs-human`, `wrong-repo` or with no outcome keeps the ticket In Progress while it is parked, and Dismiss
  puts it back, but Close does not. A run that opened a pull request is never put back: the tracker's own integration moves its ticket from there.
  A person who has moved the ticket since is left to it, and the record goes. A restore the tracker refuses is logged, and the board tries it again
  on its next refresh, while Remove and Dismiss say why and leave the run where it is.
- **Still working, not Needs you, while a worker's own background work runs.** A worker that ends a turn while a shell, a Monitor or a task
  of its own is still running and will wake it (a long Ansible run, say) writes `{ "kind": "working", "reason": "..." }`. The run stays In
  progress, holding its slot, with that reason as its note, and the outcome it writes when its work wakes it replaces the note and ends the
  run as usual. The stop hook lets one stop through on a `working` outcome and refuses a later stop on the same file, so a woken worker says
  how the run stands, or writes `working` again. An agent idle with no newer outcome for `tickets.stallMinutes` is marked Stalled on its row,
  with the note: the run is not ended and the agent is not prompted. `working` is never for a question: that is `needs-human`.
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
- **A stacked pull request is retargeted when its base merges.** A run stacked on a blocker's pull request keeps that pull request's branch as its
  base. When the blocker merges and its branch is not deleted, GitHub does not retarget the stacked one, so the board does it: every 3 minutes it
  moves an open pull request whose base was the head of a merged pull request to the repository's default branch (`gh pr edit --base`), reads the
  base back, and leaves the head as the worker pushed it. A base whose branch is gone with nothing merged on it is not moved, since its work may
  never have landed: the run says `Needs retarget` on the board, with the pull request and the branch, until a person retargets it. A retarget that
  is refused is said the same way, and tried again on the next sweep.
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
- **New ticket, written from a request.** On a machine that sets `tickets.writer`, the Pick view has a New ticket button. You say what the
  ticket is for, in plain words, and optionally choose its project, repository, goal, priority or parent. Quick (the default) runs unattended:
  a short writer run reads the repositories and the tracker, checks for a ticket that already asks for the same thing, and leaves one or
  more drafts. Grill runs in a terminal the board opens, and asks you its questions there before it drafts; it needs `tickets.terminal`.
  Each draft is shown on the board, editable, with its title, why, done-when, project, team, goal, labels, priority, parent, and what it
  blocks or is blocked by. A draft that names a duplicate shows the ticket linked, above its buttons, and Approve waits until you tick that
  they are duplicates. **Approve** creates the ticket in the tracker, assigned to the key's own user so it shows in Pick, with its project,
  goal, labels, priority, parent and relations; **Approve and queue** does that and puts it on the queue, planned first when Plan first is on;
  **Discard** creates nothing. Nothing is created until you approve, and a creation that the tracker refuses (a label or project that does
  not exist, say) creates nothing and names the name: the draft stays editable, with the reason. The writer's tracker access is read-only
  by construction (a connector that only reads, whatever `tickets.connectors` allows), and no worker can create a ticket. Workers keep their
  read-and-comment access. It works on a ticket-only host, and through a remote connection or the tailnet-served board as the rest of the
  board does. A request is refused by name when it is empty or too long, names a repository the machine does not have, or a parent that does
  not exist. At most three new-ticket requests are unfinished at once.
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
  repository, or a blocker with no open pull request there, waits as before. A planner that says a ticket waits until its blocker
  merges, rather than stacking on it, sets `"wait": "merged"` on that ticket's entry in `order.json`. The ticket stays Blocked, and the
  board says "Waits for NBF-1 to merge", until the blocker's pull request merges, then it starts on the default branch. Stacking is for
  code that builds on the blocker's diff. Merged is for work that needs the blocker's change live, such as fleet state, a deployed or
  released package, or a published artifact. Left out, `wait` means stacked.
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
opens a DRAFT pull request per repository it changed with `pr:open create --draft`, and writes an outcome file: `draft-pr`, `wrong-repo` (the fix belongs in none of them),
`checked` (nothing needs to change, and the ticket is not finished), `done` (see below), `needs-human`, or, for a turn that ends while its own background work runs on, `working`, which does not
end the run. A worker writes nothing to Linear. The board writes only a planning run's files, attached to its ticket, the
ticket's move to the planner's state, a batch's order as "blocks" relations, and the completion of a ticket on a worker's `done` or a merged pull request.

**Outcomes that finish a ticket without a pull request.** A ticket whose work needs no code (setup, configuration, verification) ends with
`done` when every one of its Done-when items is verified. The outcome carries a `reason` and an `evidence` list, one line per Done-when item, saying
what the worker ran or read and what it showed. A `done` with no reason or no evidence is `needs-human`, naming what it lacks, so a bare claim completes
nothing. The board then moves the ticket to its team's completed state (the one listed first by position), posts the reason and the evidence as a
comment, and shows the run Completed. A worker never completes a ticket itself: it has read-and-comment access to Linear only. `done` is refused,
as `needs-human`, for a planning or review run (a review run's ticket completes when its pull requests merge), and for a ticket with open sub-issues,
which are completed by their own work. If the tracker cannot complete the ticket, the ticket stays where it is and the run is handed to a person with
both reasons. `checked` stays for a ticket that was looked at and is not finished: its ticket stays open, and nothing is posted.

**A worker's proposed edit to a ticket's text.** `done`, `checked` and `needs-human` may carry an `edit` with a `title`, the whole `description`, or both,
and a `why`. The board records the proposal beside the text the tracker held, and changes nothing. The run's row shows the proposal, with Apply edit
and Discard edit. Apply writes the title and description to the ticket only on a person's request, and is refused, keeping the proposal, when the
ticket's text has changed since the worker read it. Dismissing the run drops an unapplied proposal with it. An edit on a planning or review run is
refused as `needs-human`.

**Opening a pull request in ticket mode.** A worker opens each pull request with `pr:open`, which checks it before `gh pr create` sends it. A
ticket has no GitHub row, so `pr:open` reads the ticket through the tracker instead, and makes the checks a row's pull request gets: the Region,
read from the ticket's description and its plan files (a `## Region` section listing each path the work changes, one per line, prefixed
`<repo>:` where the ticket spans repositories); the body's keyword for the ticket, which is `Closes <KEY>` when the pull request completes it
(its done-when is fully met) and `Refs <KEY>` with a `Partial: <what remains>` line when it is partial, leaving the ticket open, in place of
`Closes #N`; a `Refs`-only body with no `Partial:` line is refused, and so are `Closes` of any other ticket, `Closes: none`, and a `Partial:`
line beside a `Closes` (the words are the tracker's, `Closes` and `Refs` for Linear); the owner, which is the run and must sit in its own worktree on its
own branch; the draft policy, from `tickets.drafts` (`--draft` is required when it is true, and refused when it is false, so the pull request
opens ready); and a changeset in the diff, or a `no-release:` line, in a repository that has `.changeset/config.json`. The acceptance file, the
body reports and the leak check are the same as for a row. Nothing is armed or labelled, because a ticket worker never merges. A ticket that
cannot be read refuses the create, and so does a path outside the Region that no `Outside-Region: <path> — <reason>` line clears.

**The merge backstop.** A worker's ready pull request, or a review run's, that merges while its ticket is still open completes the ticket: the board
moves it to the tracker's completed state and posts the merged pull requests on it, since the body may have been wrong. A run declared partial
(a `partial` in its outcome file, the same words as the body's `Partial:` line) is never completed this way, and nor is a ticket the tracker has
already completed, canceled or marked a duplicate.

**What a worker may not do** is enforced by `ticket:hook`, which the ticket folder's `.claude/settings.local.json` names, so a session herdr
resumes after a restart keeps it. A stop with no outcome file is refused twice in a row. These are refused outright: a pull request that
is not a draft, `gh pr ready`, `merge` and `review`, requesting a reviewer, `gh workflow run`, a force push, every `gh stack` command but
`gh stack link`, the `post-pr-to-slack` skill, and every MCP connector the
machine does not name in `tickets.connectors`. Only a publish run may run that skill and call the connectors `tickets.publish.connectors`
names: the board leaves a `publish-run` mark in its folder, which no worker may write, as it leaves `review-run` for a review run. A worker runs with the person's connectors, Slack and mail among them, so a machine names
only the tools its workers need, such as its tracker's reads. A machine adds its own refusals with `tickets.deny`. With `tickets.prReview` named, a push or a pull request is refused until that skill has run since the worker's last commit: the hook logs each review and each commit in `pr-review-log` beside the outcome file, which no worker may write.

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
| `tickets.serve` | none: the page and the terminal are served on `127.0.0.1` only. `"tailscale"`: serve both on your tailnet with `tailscale serve`, never Funnel, on `tickets.servePorts`. `start`, `onboard` and `doctor` run and check it, and `stop` removes only those two entries. A refusal names its fix, such as `sudo tailscale set --operator=<user>` |
| `tickets.servePorts` | `{ "ui": 9443, "terminal": 9444 }`: the tailnet HTTPS ports `tickets.serve` uses. Each is a port from 1 to 65535, and the two must differ. Read only with `tickets.serve` |
| `tickets.herdrSession` | `tickets` |
| `tickets.worktreeRoot` | `<stateDir>/tickets/worktrees` |
| `tickets.linearKey` | `{ "keychain": "agent-org-linear" }` (macOS Keychain service), or `{ "path": "/abs/file" }` |
| `tickets.brief` | none. A markdown file added to every worker's brief under "On this machine", read again for each run: how workers share the machine, such as the command that starts a dev server without taking a fixed port |
| `tickets.review` | none. A markdown file added to every review run's brief under "How this machine reviews", read again for each run: which checks must pass and which reviewer to wait for once a pull request is marked ready. Read only by a review run, which an approved draft starts, so a machine with `tickets.drafts: false` never reads it. `tickets.reviewer: "atomic"` does not read it either: its reviewer is the gate's own, started from code, and its prompt is not this file |
| `tickets.plugins` | none. `["name@marketplace", ...]`: Claude Code plugins every worker runs with, installed for the user (`--scope user`). A worker starts in its ticket's folder, which is a project of its own, so a plugin installed only for another project would be missing: the board refuses to start a run until each one is installed for the user, and names the command |
| `tickets.deny` | none. `[{ "pattern": "<regular expression>", "reason": "<why>" }]`: Bash commands the hook refuses as well as its own, each matched against the whole command, with the reason the worker is told |
| `tickets.connectors` | none, and every connector is refused. `agent-org onboard` adds Linear's MCP read and comment tools, `"^mcp__linear__(get\\|list\\|search\\|extract)_"` and `"^mcp__linear__save_comment$"`, when it registers that MCP. `["^mcp__<connector>__<tools>", ...]`: regular expressions, each anchored with `^mcp__`, for the connector tools a worker may call, matched against the tool's name. Linear's reads through the claude.ai connector: `["^mcp__claude_ai_Linear__(get\\|list\\|search\\|extract)_"]`. The brief names them, so a worker can read its ticket's parent and blockers |
| `tickets.terminal` | none, and the board shows no terminal link. A web address that serves a run's terminal, with `{workspace}`, `{pane}` and `{key}` filled in per run: for [herdr web ui](https://github.com/devswha/herdr-web-ui) serving the `tickets` session on port 7318, `"http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal"`. `agent-org onboard` writes that value when the key is absent, and its terminal service serves it. It runs the plugin's `server/supervisor.ts` with bun, with `HERDR_SOCKET` naming the session's socket. The plugin reads `HERDR_SOCKET`, not `HERDR_SOCKET_PATH`. |
| `tickets.plan` | none, and the board marks no ticket. A regular expression that the name of a file uploaded to a ticket matches when the file is the ticket's plan. NBL's create-ticket names a plan `<KEY>-0001-plan-<slug>.md`: `"-plan-[^/]*\\.md$"`. A bare `plan` would also match `floorplan.png` |
| `tickets.planner` | none, and the board plans nothing. Needs `tickets.plan`. `{ "run": "<instruction>", "state": "<state>" }`: what a planning run is told, with `{key}` and `{dir}` filled in per run (the ticket, and the folder its plan's files go in), and the tracker state a planned ticket moves to if it has not started. An instruction that names `{keys}` instead plans the tickets queued together in one run: `{keys}` is their keys, separated by a comma and a space, and `{dir}` the run's one plan folder. A ticket planned alone gets its own key there. One that names only `{key}` plans every ticket alone. A team with no state of that name keeps the ticket's state, and the board's log says so, because teams name their states differently. NBL: `{ "run": "Run the nbl-ui:create-ticket skill with this request: unattended: plan {key} into {dir}", "state": "Planned" }`, or `plan {keys} into {dir}` to plan in batches |
| `tickets.publish` | none, and the board shows no Publish tick or button. `{ "run": "<instruction>", "model": "haiku", "effort": "low", "connectors": ["^mcp__..."] }`: what a publish run is told, with `{prs}` (the ticked runs' open pull requests, one per line) and `{dir}` (its folder) filled in, the model and effort it runs on, and the connector tools it alone may call, each anchored with `^mcp__`, such as the one that sends a Slack message. NBL: `{ "run": "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json" }` with its Slack send tool in `connectors` |
| `tickets.writer` | none, and the board shows no New ticket button. `{ "run": "<instruction>", "model": "opus", "effort": "high" }`: what a new-ticket writer run is told, with `{request}` (the person's request, quoted) and `{dir}` (the folder its drafts go in) filled in per run, and the model and effort it runs on. The instruction names the ticket-writing skill, for example `"Run the a11ign:create-ticket skill, quick, for this request: {request}. Write each draft under {dir}/drafts."`. The board owns the draft format (one JSON file per ticket, checked by name and field), so the skill need not know it. The writer reads the tracker with a connector in `tickets.connectors` that reads a ticket: `agent-org doctor` says "ticket writer" and fails when none does |
| `tickets.drafts` | `true`, and each worker opens its pull requests as drafts, which a person approves on the board. `false`: each worker opens them ready for review (`gh pr create`, with no `--draft`), and the run waits for review with no Approve, watched for feedback like a run Ready to merge. Anything but `true` or `false` refuses the board's start, naming the setting. Canary: set it on one machine first. Its new runs show Awaiting review with no Approve, and their pull requests on GitHub are not drafts (`gh pr view <url> --json isDraft` gives `false`). Revert: remove the line, or set it `true`. Runs already opened ready are not changed back: they stay Awaiting review, and are reviewed and merged on GitHub, since the board offers no Approve for them |
| `tickets.prReview` | none, and no pre-PR review is asked for or gated. `"a11ign:clean-code-review"` (a skill's name, `name` or `plugin:name`): a worker's brief has it run on the whole diff after its last commit, and before any push or pull request, with the repository's checks re-run after each fix, and its pull request's body carries a `Pre-PR review:` line naming it. The ticket hook refuses `gh pr create`, `pr:open create` and `git push` until that skill has run since the last commit, and a review round is gated the same way. A name of another shape is refused by name, as the other settings are. Canary: set it on one machine, then check that a new run's folder holds `pr-review.json` and that its pull request's body has the `Pre-PR review:` line. Revert: remove the line. Runs already started keep the gate they were given. |
| `tickets.reviewer` | none, and no reviewer is started. `"atomic"`: for each ready head of a watched run's pull request, the board starts the gate's codex reviewer (the same code the org's reviewer runs, started in the `tickets` herdr session), once per head. It posts as `a11ign-reviewer`, and a pull request whose author is outside the org gets none. A `CHANGES_REQUESTED` on the head resumes the same worker for a round, at most 3 (`MAX_FEEDBACK_ROUNDS`), and an approval resumes nothing. Any other value refuses the board's start, naming the setting. Its prompt is still a stub in this change, so until it is the gate's own, a reviewer may post no verdict and the run waits with no round. Canary: one `reviewer-<n>` workspace per ready head in the `tickets` session, not one per watch; a reviewer's workspace closes within one watch of its verdict, and a merged or closed pull request's workspace and `~/reviews/<seat>` checkout are gone within one sweep (every 3 minutes), a line naming any uncommitted changes discarded with the checkout; a `no reviewer for <url>` line in the board's log names a refusal; each ready pull request has one review from `a11ign-reviewer` on its head. Revert: remove the line. Reviewers already running finish, and the sweep closes their workspaces and removes their checkouts once their pull requests have merged or closed. For a pull request that no run owns (for example one a person opened for a run that ended `needs-human`), `agent-org ticket:review <pull request url>` starts the same reviewer at its current head, with the same refusals. |
| `tickets.pick` | `"assigned"` (the default): the Pick view's Assignee row starts on the person whose Linear key the board reads with, and lists the open tickets assigned to them, as it always has. The page opens on those tickets alone, so it never waits for the rest of a large workspace. The Assignee row counts everyone from a separate, small read of who holds the open tickets, and another person's tickets, Unassigned or Anyone are read when chosen, a page at a time. `{ "team": "<key>" }` (a team's key is the start of its tickets' keys, such as `A11`) or `{ "project": "<name>" }` (as Linear spells it): the Pick view lists every open ticket of that team or project, whoever it is assigned to, and the row starts on Anyone. Open is the same as for `"assigned"`: not completed, canceled or a duplicate. Anything else refuses the board's start, naming the setting. An empty Pick view says why and names this setting. Canary: the Pick view's count reads `assigned to you` by default and `open in team <key>` or `open in project <name>` with a team or a project, and the Anyone chip reads as that count. Revert: remove the line
| `tickets.stallMinutes` | `30`. How many minutes a run whose worker wrote `working` may sit idle with no newer outcome before its row on the board says Stalled, with the worker's note. It ends nothing and prompts nobody, and the agent working again clears it. A whole number of 1 or more; anything else refuses the board's start, naming the setting. Canary: a `<key> has been idle for <n> minutes or more since it wrote working` line in the board's log, once per stall. Revert: remove the line |
| `tickets.updateMaxDeferHours` | `2`. How many whole hours the hourly `agent-org update` may hold a new release back for live runs, counted from its first deferral for that release, before it updates anyway. It holds a release only while a restart would interrupt a worker: herdr inside the instance's cgroup and an agent mid-tool-call. A whole number of 1 or more; anything else refuses the host file, naming the setting. |
| `tickets.workingState` | none, and no ticket is moved. The tracker state a ticket moves to as a worker starts implementing it, if it has not started yet: `"In Progress"`. A planning run moves nothing. A team with no state of that name keeps the ticket's state, and the board's log says so. The ticket goes back to the state it came from when its run ends without a pull request (see the run list) |
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
  for the routes the page calls. A pairing code for a worker terminal is asked for only by the page's service, for a paired browser following
  a worker link, and only from that connection's own instance. A connection that cannot be reached is shown on the page as
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
which it does with no `AGENT_ORG_HOST` once that machine has been onboarded (see "The host file without `AGENT_ORG_HOST`" above). Its instance is
running, with `agent-org ticket:serve`. Its instance has made its key, which its first start does. `ticket:remote-info` refuses to print
the key to a terminal. Check the whole path from this machine with `ssh <target> agent-org ticket:remote-info > /dev/null && echo ok`,
which prints `ok` and not the key.

**Connect a second machine over https.** An instance stays on `127.0.0.1` unless you expose it on purpose, behind TLS, on a network you
trust, such as a private network. The TLS proxy in front of it must send the instance `Host: 127.0.0.1:<port>`, as nginx's
`proxy_pass` does by default, because the instance refuses any other host. A proxy that passes the original host on is refused. Copy that machine's `<stateDir>/tickets/board.key` to this one,
`chmod 600` it, and name it as the connection's `keyFile`. Anyone who can reach the address and holds the key can drive that instance, so
keep the address off the public internet. Open terminal on that machine's runs shows only when its `tickets.terminal` is not on its own
loopback.

### Stacking, and the repository a ticket's work lands in

A ticket blocked by another starts on top of its blocker rather than waiting for it to merge (A11-77, A11-116). A blocker stacks once its branch is
pushed in the repository the run works in: the pull request is not needed for that. The worker branches from the blocker's branch and bases its own
pull request on it, and links it with `gh stack link` only when both pull requests exist. A blocker that is canceled or a duplicate never releases
the run, and nor does one the planner said to wait on to merge: a person decides. The board says why a Blocked run waits.

A ticket's repository is its Linear project's: the project's summary names it with a `github.com/<owner>/<repo>` address, and it must be one of the
host file's `clones`. A planner that names another repository for a ticket overrides it. A project that names none leaves the worker to choose.

When the blocker's branch moves (a rebase, review fixes, or a force-push), agent-org rebases the stacked run onto it. It does that once the worker has
stopped, never while the worker holds the worktree, and never the worker itself: the worker is told not to rebase, merge the base in or force-push.
The rebase replays the run's commits from the commit it was branched at, which `ticket:worktree --from` records in the ticket's `stack-base.json`, so
a force-pushed blocker's old commits are not repeated. The push is a lease on the run's own branch. A rebase that conflicts is aborted and left for a
person: the board says "Rebase onto NBF-1 conflicted in <files>: a person resolves it". When the blocker merges, its stacked pull request is retargeted to
the default branch (A11-106).

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
