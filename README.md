# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

Install the newest release with one command. It uses no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
```

**Prerequisites:**

- git;
- tar and gzip;
- curl, which downloads the board UI's build from the release (see below);
- Node 24 or newer;
- one way to run pnpm 10.34.5: the corepack beside `node`, a `corepack` on `PATH`, or else `npm exec`, which every npm has. You never need a global pnpm.

The installer checks all of these before it changes anything, and lists every one that is missing with the command that fixes it for your platform (Homebrew, nvm, fnm, or a download from nodejs.org). It prints a header, one line per step, then whether agent-org is installed and the next commands. When its output is not a terminal, the last line is `agent-org install OK: ...` or `agent-org install FAILED: ...`, and a failure says what was changed (usually nothing). `--verbose` also shows where it keeps the mirror, the version folders and the `current` link.

**Homebrew note:** Homebrew's `node` formula, like every Node from 25 on, ships no corepack. The installer then runs pnpm through `npm exec`, and says so on the dependencies line. `brew install corepack` (or `npm install -g corepack`) adds corepack if you want it. Reinstalling Node is not a fix for this.

The installer keeps a bare mirror of the repository in `~/.agent-org/tool/repo.git` (`$AGENT_ORG_HOME/tool` when that is set), builds the newest release tag
into a folder of its own, `tool/versions/<tag>`, with the release's dependencies, points `tool/current` at it, and writes the `agent-org` launcher into
`~/.local/bin`, which runs through `current`. It changes nothing else. When `~/.local/bin` is not on your `PATH`, it prints the line to add. Add
`-s -- --version vX.Y.Z` after `bash` to install one release. Running it again builds the newest release beside the others and moves `current`. An earlier
install's checkout, `~/.agent-org/agent-org`, is left as it is, and `agent-org update` moves its services onto `current`.

**A release that ships the board UI's build** (its `package.json` says `"agentOrg": { "shipsUiBuild": true }`, as every release from A11-191 on does) is given it as one more step, `Downloaded its UI build`: the installer downloads `agent-org-ui-<tag>.tar.gz` and its `.sha256` from the release on GitHub (or from `$AGENT_ORG_RELEASES_URL` when that is set, which is where the tests point it), checks the one against the other, and unpacks it into `tool/versions/<tag>/ui-build/` before `current` moves. A checksum that does not match, or a release whose build CI has not attached yet (it is attached a few minutes after the tag), fails the install and leaves `current` where it was; the message says which, and running it again later is the fix. A release before the marker installs as it always did, with no download. `--verbose` adds the address and the verified checksum. `agent-org update` follows the same rule: it fetches and verifies the build before it moves `current`, refuses the move (and tries again on its next run) when it cannot, and, when it finds nothing newer, gives the folder `current` names its build if its release ships one and the folder has none.

Then run these commands:

| command | what it does |
|---|---|
| `agent-org onboard [--profile <name-or-path>] [--verbose]` | With `--profile`, sets the machine up from that profile (see "One command, from a profile" below), asking only for the secrets it lacks. Writes the host file, `~/.agent-org/host.json` (or the file `$AGENT_ORG_HOST` names). It asks for the repositories a worker can choose from, or takes them as `--repo <name>=<path>` (repeated). The Linear key is kept in the macOS Keychain on a Mac and in a private file, `~/.agent-org/linear.key`, elsewhere, and nobody is asked where: `--linear-keychain <service>` or `--linear-key-file <path>` name another place, as an advanced option. At a terminal, with no `--repo`, it does not ask for paths: it lists the GitHub checkouts in the folder it runs in (that folder and each folder one level down, matched by their remote, so run it from the folder that holds your checkouts), pre-ticked and named as GitHub names them. It then asks `Add repositories not cloned here?`: a Yes lists your account and its organisations, then their repositories (type to filter), with the host file's repositories pre-ticked, and offers to clone each one picked that has no checkout into that folder, listing them by name with the path each goes to. In every list space ticks and unticks the highlighted item, the arrows move and enter confirms, and the last line of a list says so (`↑↓ move · space select · enter confirm · type to filter`). Each clone prints one line when it ends, ✓ or ✗ (the command it runs, `gh repo clone <owner>/<name> <path>`, shows with `--verbose`). It then prints each repository with its path, marked found, cloned or kept, once, before it writes the host file, and keeps every repository the host file already names. Without a terminal, `--repo` and a profile work as before and onboard never prompts. It keeps the host file's other keys. **Connect to Linear:** when no key is readable it says where the key is kept and where to create one (Linear → Settings → Security & access → Personal API keys, with Read and Write access), asks for it at a prompt that does not echo, checks it against Linear at once and says whose account it is, and stores it (into the Keychain through `security -i`, so the key is never an argument a process list shows, or into a mode-600 file). A key Linear refuses is asked for again (three tries); a key Linear cannot be asked about is stored and said to be not checked. A key already stored is checked and not asked for, with or without a terminal, so an unattended run makes that one call to Linear, and one that cannot reach Linear says the key was found but not checked (a ✗ line). A doctor check that only warns is drawn as a `!` line and does not count. It records the host file's path in `~/.agent-org/host-file`, so a shell with no `AGENT_ORG_HOST` finds it. It sets up the web terminal: it installs `bun` into `~/.bun/bin` when there is none (from bun's release zip, with no `unzip` and no `sudo`), installs the herdr plugin `devswha/herdr-web-ui` at its newest release tag (`herdr plugin install devswha/herdr-web-ui --ref <tag>`, never the default branch), and writes `tickets.terminal` when it is absent (`--no-terminal` skips this). On every machine from the first run, `--no-terminal` or not, it installs herdr's `claude` and `codex` integrations (`herdr integration install claude`, then `codex`): they are how herdr knows each agent's state and resumes its session, and the board reads agent status from herdr. It installs and enables the agent-org plugins it chose, as `agent-org plugin install` would: a `linear` tracker block and a `github` code host block always, so a fresh machine ends with both listed as installed and enabled by `agent-org plugin list` and on the Settings page, and a block for each optional concern whose choice is not `none`; it says one ✓ or ✗ line for each once that plugin's steps have run, in the setup words of its manifest's `agentOrg.setUp` (`Linear connected as the tracker`, `GitHub connected as the code host`, `Board served on this machine`; the internal sentence, `installed linear as the tracker`, shows with `--verbose`), and leaves a key the host file already holds as it is. With a readable key and no `linear` MCP yet, it registers Linear's MCP for Claude Code at user scope, authenticated by the key, and adds Linear's read and comment tools to `tickets.connectors`. It never prints the key. It installs the `github/gh-stack` extension, which a worker's `gh stack link` needs, for the workers' account (the host file's `gh.workers`) when it is not listed. A failure is a ✗ line with the fix beneath it, and does not fail onboard: `doctor` does. Onboard ends with `agent-org is set up on this machine.` and a `Next:` list (`agent-org ticket:pair`, `agent-org doctor`), or, when a step failed, with `agent-org is not fully set up: N steps above need fixing.` after each ✗ line and its fix; the exit status is the same either way. `--verbose` also shows every command, each service's line and `doctor`'s whole report. It then starts the instance, ui, terminal and auto-update services, unless you pass `--no-start`. `--no-auto-update` leaves auto-update unregistered, and `--update-channel main` makes it follow `main`. A terminal or auto-update service that cannot start is reported and skipped. An instance or ui service that cannot start fails onboard. With the Tailscale exposure (`tickets.providers.exposure`), the ui and terminal services are also served on the tailnet, as `start` describes, and its onboard steps say when Tailscale is not on `PATH`, the operator command Tailscale needs, and any tailnet port that is taken. |
| `agent-org doctor` | Checks Node, the launcher on `PATH`, the host file, `herdr`, the Linear key, and that `claude mcp list` shows `linear` connected. It checks whether each service is registered and answers on its port. For the web terminal, it checks that `tickets.terminal` is on this machine's loopback and that herdr web ui answers `/api/health` there. With the atomic reviewer, it checks that `codex` is on `PATH` and logged in (`codex login status`). For auto-update, it checks that the service is registered. A unit systemd will not load (`bad-setting`) is reported with the line systemd refused. The agent-org plugins are printed as one section each, in the order tracker, code host, publisher, reviewer, exposure and messaging: a header names the concern, the plugin, its state, its contract version and where its code lives (`tracker: linear (enabled, contract 1.2, plugins/linear)`), the plugin's own checks are indented beneath it, and the concern's row that summarises them closes it. A disabled plugin's section says what the board does without it, a concern with none is `publisher: none`, and a plugin that failed to load (the registry refused its package, it implements a contract major agent-org does not read, or its import or `create` threw) is a FAIL row in its own section with the reason and the fix, which the Settings page shows word for word. What the registry refused, which names no concern, is the section "refused by the registry". Doctor prints the fix for each check that fails, and exits 1 when any check fails. It checks each plugin `tickets.plugins` names, as a worker's session gets it: one that does not load, or whose declared contract does not match the host's keys, fails under its own name (`plugin <name@marketplace>`), and one that is fine is listed as ok. When Claude Code's install record cannot be read, each plugin is shown as not checked, which does not fail. The exposure plugin the host enables adds its own rows: with Tailscale, it checks tailscale (Running, with a DNS name) and each served port (its `tailscale serve` entry, that it is not on Funnel, and that it answers under the machine's name); with the local exposure, that the instance and the page answer on `127.0.0.1` and what the terminal address is. The messaging plugin adds its rows too (for Telegram: the token file is readable by no one else, and the chairman has paired). herdr's `claude` and `codex` integrations are a row each (`herdr claude integration`): a FAIL when outdated or not installed, with `herdr integration install <name>` as the fix. A row printed `WARN` is not a failure and does not change the exit code: `herdr version` warns when herdr is behind the newest release the last `agent-org update` recorded, with the steps a person takes to upgrade it (a herdr upgrade restarts every pane, so `update` never does it), and `herdr plugin devswha/herdr-web-ui` warns when the plugin is behind its newest release tag. It also says how many releases behind the newest one the install is, and since when (`update lag`; it fails once the install has waited past `tickets.updateMaxDeferHours` and an hour's grace). It checks the `github/gh-stack` extension a worker's stacked pull request needs, for the workers' account, and fails with the install command when it is missing. Where a clone is on GitHub it also checks that GitHub makes stacked pull requests available to that repository: stacked pull requests are a GitHub preview, so a repository GitHub refuses is named, with the preview requirement (`stacked pull requests`). `herdr scope` passes when the herdr server of the instance's session runs in `agent-org-herdr.service`, and fails when it is inside the instance's cgroup or in the old transient scope, with the fix `agent-org start herdr --move`; the `keep-herdr.conf` and `gh-wrapper watchdog` rows fail while either guard is still on disk on such a host. It lists each live or parked run with the version of agent-org it started on beside the instance's (`A11-170: v0.273.0 (instance v0.280.0)`, or `all 2 runs are on v0.280.0`), fails the `plugin copy` row when a refresh rewrote the plugin folder a live run's session uses, and says a breaking update that is draining (`update drain`). The `ui build` row (A11-191) is `ok` when the build `/next` is served from is there, and `ok` with "this version ships no UI build" for a release before the marker; it is a `WARN` when the running version's release ships a build and none is found, naming the folder it looked in, with `agent-org update` (which fetches it) as the fix, or `pnpm ui:build` in a checkout. |
| `agent-org start [herdr\|instance\|ui\|terminal\|auto-update] [--move]` | Registers the service to start at login and starts it: a launchd user agent on macOS, a systemd user unit on Linux. The herdr service runs `herdr --session <tickets.herdrSession> server`, which holds every worker's pane, in a unit of its own (`agent-org-herdr.service`): the instance and the terminal `Want=` it and start after it, and nothing `Requires=`, `BindsTo=` or `PartOf=` it, so restarting the instance, the ui or the terminal never reaches a worker. `start herdr` starts the unit and never restarts it; while a herdr server runs outside the unit (one an older instance started in its own cgroup, or in the transient scope the instance once made), it refuses and says how many runs are live, and `start herdr --move`, run once at a quiet moment, stops that server, starts the unit (every pane restarts once) and retires the `KillMode` drop-in and the gh-wrapper watchdog on their proof. The instance service runs `ticket:serve`, the queue and its workers. The ui service runs `ticket:ui`, the page. The terminal service runs herdr web ui for `tickets.herdrSession` on `127.0.0.1`, on the port `tickets.terminal` names (`7318` by default). The auto-update service runs `agent-org update` every ten minutes: a systemd timer on Linux, a launchd `StartInterval` job on macOS. The service is `instance` when you name none. Starting a service writes its unit again, which fixes a unit systemd refused. With the Tailscale exposure (`tickets.serve: "tailscale"`, or `tickets.providers.exposure`), the ui and terminal services are also served on the tailnet with `tailscale serve --bg`, on its `tailnetPorts` (`tickets.servePorts`), after the plugin's checks pass: tailscale is Running with a DNS name, and the port is free of Funnel and of other entries. A check that fails names its fix, and the service is not started. The instance and auto-update are never served. A service that is started but cannot be served on the tailnet says so, and it stays on loopback. |
| `agent-org stop [herdr\|instance\|ui\|terminal\|auto-update]` | Stops the service and keeps it from starting at login. `agent-org stop auto-update` turns automatic updates off. With the Tailscale exposure, the ui and terminal services also lose their own tailnet entry, on their own port only: no other entry on the host is named, and no Funnel is changed. If that entry cannot be removed, the service stays stopped and the command says how to remove it. |
| `agent-org status [herdr\|instance\|ui\|terminal\|auto-update]` | Prints whether the service is running, stopped or not registered, and the reason when systemd will not load its unit. It exits 3 when the service is not running. |
| `agent-org update` | Moves the install to the newest release, or to `--version vX.Y.Z` (or the `toolVersion` the host file pins), and restarts the instance and the ui if they were running. `--channel main` follows `main` instead of releases. The release is built into its own folder, `tool/versions/<tag>`, and `tool/current` is pointed at it; it applies whatever is live, because a run keeps the folder it started on and herdr is not restarted. A release whose changeset starts `Breaking:` with runs live is built and waits instead (see "Kept up to date"); `--force` applies it at once. A release that ships the board UI's build has it downloaded from its GitHub Release, checked against its checksum and unpacked into the folder before `current` moves (see "Install"); a release whose build is not attached yet, or whose checksum does not match, is refused and `current` stays, and the next run tries again. It keeps the `github/gh-stack` extension present on every run; a failure is said and does not change its exit code. It also keeps herdr's side current on every run, in the auto-update log: it reads `herdr integration status` and re-installs the `claude` and `codex` integrations when either is outdated or missing, moves the herdr plugin agent-org installed (`devswha/herdr-web-ui`) to its newest release tag with `herdr plugin install <repo> --ref <tag> -y`, and restarts only the terminal service when the web UI moved. It records the newest versions it saw in `~/.agent-org/herdr-status.json`, which `doctor` reads. It never upgrades or restarts herdr. It also refreshes each conventions plugin in `tickets.plugins` whose marketplace is a GitHub repository (`claude plugin marketplace update`, then `claude plugin update`) at every update, and says the version a plugin moved to: a new run or round gets the new copy, and a running session keeps the one it started with. |

### One command, from a profile

`agent-org onboard --profile <name>` sets up a fresh machine. A profile is a saved answer file, `~/.agent-org/profiles/<name>.json` (or the path
it names, when the name has a `/`). It holds no secret, so a copy of it sets up another machine. It is never shipped with agent-org: the example
below uses invented names.

```json
{
  "schema": 1,
  "tracker": { "provider": "linear", "pick": { "team": "<TEAM KEY>" }, "workingState": "In Progress", "plannedState": "Planned" },
  "codeHost": { "provider": "github", "reviewerApp": { "slug": "<app slug>", "appId": 0, "installationId": 0 } },
  "publish": { "provider": "none" },
  "reviewer": { "provider": "atomic" },
  "exposure": { "provider": "local" },
  "conventions": { "plugin": "<name>@<marketplace>", "marketplace": "<owner>/<repo>", "prReview": false },
  "repos": [ { "name": "<clone name>", "remote": "<owner>/<repo>", "path": "~/repos/<dir>" } ],
  "notes": { "worker": "<optional path to a markdown file>", "review": "<optional path>" }
}
```

With a profile in place, onboard asks only for the secrets: the Linear key, which goes to the Keychain on a Mac and to a mode 600 file on Linux,
and the path of the reviewer App's private key (`.pem`), which it copies to `~/.agent-org/apps/<slug>.pem` (mode 600). Its text is never printed.
Without a profile at a terminal, onboard asks the same few questions and writes the answers to that path (mode 600). Without a terminal, it refuses
and names the file. The flags `--repo`, `--linear-keychain`, `--linear-key-file`, `--no-start`, `--no-terminal`, `--no-auto-update` and
`--update-channel` override the profile. Without `--profile`, onboard keeps its flags-and-prompts behaviour.

What a profile sets, each only where the host file does not already have it:

- The provider blocks under `tickets.providers`, and `tickets.pick` from `tracker.pick`. A block's `provider` names an agent-org plugin of its concern, checked against the registry: any bundled plugin of the concern (`agent-org plugin list` shows them), and `none` for a publisher or a reviewer; a fake, a plugin of another concern, a package the registry refused or an unknown name is refused by the field and the name. Onboard writes each as an installed, enabled plugin (`provider` and `enabled: true`, beside the profile's settings): the tracker and the code host always, and each of the others unless it is `none`. A profile keeps its schema and block shape, so one saved before still reads, and messaging is no profile key: it is configured in a project's `project.json`. The old loose keys are moved into their blocks first, with
  a backup beside the host file, as `agent-org doctor --fix` moves them.
- The repositories: each checkout a profile names that is missing is cloned as your own GitHub login.
- The conventions plugin: its marketplace is added from its repository and the plugin is installed for every session, both as your own GitHub
  login, since the repository is private. A marketplace listed from another source is left as it is and said. The plugin's declared contract sets
  `tickets.plugins`, the planner, the writer and the plan's file pattern. `conventions.prReview: true` also sets `tickets.prReview` to the skill it provides.
- The house notes, `worker-notes.md` and `review-notes.md` beside the host file, named under `tickets.brief` and `tickets.review`. A file that exists
  is never overwritten. A profile's `notes` files are copied instead of the shipped text.
- The reviewer's identity: the App named in `codeHost.reviewerApp`, with its key, under `tickets.providers.codeHost.identity.reviewer`.

Onboard also prints the Codex checklist when the reviewer is `atomic`: Codex is installed (`npm install -g @openai/codex`) and logged in (`codex login`).
Onboard does not do either for you, since each needs your account. It starts the herdr service first. It retires the two guards an earlier hand setup left on Linux, the
`gh-wrapper-watchdog` timer and the `KillMode=process` drop-in on the instance unit, each only once its replacement is proven: the watchdog once the
installed `gh` wrapper is the one the host file declares, the drop-in once herdr's server runs in its own service. A guard whose replacement
is not proven is kept, and the line says what to do (`agent-org start herdr --move`). Running onboard again changes no file, and it ends by printing the same checks as `agent-org doctor`.

The macOS service writes its log to `~/.agent-org/logs/<service>.log`. On Linux, read it with `journalctl --user -u agent-org-<service>`.

**Kept up to date.** The auto-update service runs `agent-org update` every ten minutes, following `release` or, when `~/.agent-org/update-channel`
says `main`, `main`. A tag fetch with nothing new restarts nothing. A new release is built into `tool/versions/<tag>` and `tool/current` is pointed at it; the
instance and ui restart onto it at once, whatever is live, because **a run is pinned to the version it started on**: its hooks and its brief's commands (the Stop
hook, `pr:open`, `ticket:worktree`) name that version's folder, written at each start and each round. A run that started on `v0.273` keeps calling `v0.273` until it
ends; a new round of it (a review round, an answer, a re-queue) picks up the newest. An answered park and a talk session keep the version they had. A folder is
pruned only once no run that is live or parked names it (and never `current`, nor the folder of the process pruning). `doctor` lists each such run's version.
The first update from a checkout install (the clone `install.sh` used to make, or a hand-made one) seeds the mirror from the checkout's remote, builds the first folder, and rewrites the
units, the launcher and the host file's `tool` once to run through `tool/current`; the checkout is left as it is, and runs that started on it keep calling it.
Each run writes `~/.agent-org/update-status.json`, which `doctor` reads to say how far behind the install is, and since when.

**herdr's integrations and plugins are kept current too (A11-184).** Each `agent-org update` run ends by reading `herdr integration status` and re-installing the `claude` and `codex`
integrations when either is outdated or missing (a herdr upgrade leaves them outdated), then moving the herdr plugins agent-org installed (today `devswha/herdr-web-ui`) to their newest
release tag, never a branch, so a broken upstream `main` is never pulled. When the web UI moved, only the terminal service restarts, and only if it was running; the instance and the ui are not
touched by this step, and no live run is. Each change is a line of the update log (`journalctl --user -u agent-org-auto-update` on Linux, `~/.agent-org/logs/auto-update.log` on macOS). **A herdr
upgrade is a person's step:** restarting herdr ends every pane, so auto-update never runs `herdr update`; `doctor` warns when herdr is behind its newest release and prints the steps (at a quiet
moment, with no live run on the board, `herdr update`, then `agent-org stop herdr` and `agent-org start herdr`).

**A breaking release drains.** A release marks itself breaking with a changeset whose first line starts `Breaking: ` (the repository is 0.x, where `minor` is not a
signal; `.changeset/README.md` says how). When one is in the range of an update and runs are live, `update` builds the folder and writes `~/.agent-org/update-drain.json`;
it swaps nothing. While that file exists the instance starts no run and no round, and the Board says so in a banner (`Updating to v0.280 (breaking): no new runs start; 2 runs finishing; forced at 14:30`):
each live run reads "finishing before the update" and each queued one "waits for the update". When the live runs have all finished, the next update applies it. After
`tickets.updateMaxDeferHours` (2 by default) the instance stops the runs still live and queues them again, each keeping its Claude session (`stopped for the update at 14:30 and re-queued;
resumes on v0.280`), and runs the update at once; they resume as rounds on the new version, and the banner clears when the update has applied. `agent-org update --force` applies a breaking release
without draining.

**A restart leaves the workers alone.** The workers run in ticket mode's herdr server, which runs in a systemd service of its own, `agent-org-herdr.service`
(launchd: `io.github.agent-org.herdr`), not in the instance's. The instance and the terminal `Want=` it and start after it, and nothing restarts it with them, so
restarting or updating the instance never stops a worker. The instance that starts up adopts the runs herdr lists and carries on watching them: it sends their panes
no key, no prompt and no second start, and a reviewer it started for a head is not started again. A herdr server an older instance started is still outside that
unit: `agent-org doctor` fails `herdr scope` for it, and `agent-org start herdr --move`, run once at a quiet moment, moves it.

**Two instances review a head once.** Every instance sweeps the open pull requests of the repositories it clones, and starts a reviewer on each new head whose required checks are green. The required checks are the ones GitHub says the pull request's base requires, from its branch protection rules and its rulesets (`isRequired`), read only when the checks are not all green: a failing check that is not required holds nothing, and the reviewer's brief names it ("These checks failed at this head and are not required"). When the list cannot be read, or the base requires nothing, every check counts. Two instances on one project (the agents host and a laptop, say) would both see a new head before either had posted, so before a reviewer starts, the instance claims the head on GitHub: a commit status `agent-org/review` on the head, which every instance can read, whose description names the instance and the time (`claimed by <instance> at <time>, lease 60 min`). An instance that finds another's live claim on the head starts nothing, and `ticket:review` says which instance holds it. A claim is live for its lease (`REVIEW_LEASE_MINUTES`, 60 minutes) and has no verdict; a claim older than that is taken over, and the board says so. The verdict door sets the claim to the verdict when the review posts (`convinced by <instance> at <time>`), so the head reads as finished. The instance's name is `tickets.instance`, which defaults to the machine's host name. The claim is written as the `reviewer` role and read back as the role the instance's own `gh` runs as (`scheduler`), and its read is made past the `gh` wrapper's read cache, since a write by one account does not drop another account's cache. `agent-org doctor` asks each of the two whether its App can use commit statuses (`commit statuses reviewer` must have *Commit statuses: Read and write*, `commit statuses scheduler` at least *Read-only*), by reading the App's installation, and names the exact permission to grant when it cannot. A claim GitHub refuses to take starts no reviewer: the head is not recorded as started, the next sweep tries it again, `ticket:review` can start it once the claim succeeds, its pull request's line reads `cannot claim for review: <reason>`, and the board shows one warning for all such pull requests. The one exception is an instance that is alone: when the write was refused after a clean read, the head read again shows no other instance's live claim, and no other instance's status under `agent-org/review` has been seen on any head within the lease, the reviewer starts anyway, the line reads `reviewing without a claim: <reason>`, and the board's warning says so. With a second instance in sight it does not start.

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

The wrapper that routes each role, the minter that mints its token and the checks of both are the GitHub plugin's (`plugins/github`, the code host): `agent-org doctor` shows `gh wrapper`,
`wrapper roles` (the roles the installed wrapper routes to an App, against the roles `host.json` declares) and `app token <role>` under the code host's section, on a ticket-only host too, and
`agent-org onboard` copies the reviewer App's key into place as the plugin's step.

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

- **Capture a page of the board.** `agent-org ticket:capture /settings --size 1280x800 --out <file-or-dir>` starts this checkout's instance and board on two free ports, from a throwaway host file and state folder, pairs a headless browser the way a browser pairs (a code the board mints, traded for a session), opens the route at the size, writes the PNG, and stops and removes everything it started, whether or not the capture worked. Nothing is signed in with a real account, nothing is uploaded, and a real instance is never touched: the throwaway environment answers herdr's one start question with no workspaces, so no herdr server starts. A capture needs both Chromium builds. `agent-org onboard` installs the browsers as the person who runs it, and the system libraries when it is root or `sudo -n` works; `agent-org doctor` names the command for whatever is missing. A worker is told to capture a page its change alters when `tickets.capture` is true, which onboard sets once both builds start.

- **Pair the worker terminal.** The worker terminal (herdr web ui) has a pairing code of its own. `agent-org ticket:pair` prints it after the
  board's code when the exposure serves the terminal and `tickets.terminal` is this machine's own, and `agent-org ticket:pair --terminal` prints it
  alone (`--board` prints the board's alone). No path is typed: the command runs herdr web ui's own `pair` with the terminal service's
  variables set over this shell's environment. The code works once, within 10 minutes, for one device. If the terminal is not running, the
  command exits 1 and says how to start it, after the board's code is printed. A terminal that another machine serves is paired there, with
  `agent-org ticket:pair --terminal` run on that machine; a served board names it. If the exposure cannot name this machine, the board
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

- **On the tailnet, if you serve it.** With the Tailscale exposure (`plugins/tailscale`; `tickets.serve: "tailscale"` is its old key), the page and the terminal are served on your tailnet with
  `tailscale serve`, on `tailnetPorts` (`9443` and `9444`), and never with Funnel. Tailscale decides who can reach the board, and
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
- **A plan follows the ticket's text, and a worker is told when it changes.** Every brief says when the board read the ticket and when the tracker
  last changed it, above the text, and a worker's pull request body says which version it worked against (`Worked against the ticket as updated
  <time>`). When the board attaches a plan it writes a `## Planned against` section into it, before `## Paths`: the ticket's `updatedAt`, the
  sha256 of its description, the files attached with the plan and the description as planned. If the description no longer has that hash when the
  run is queued (the tracker moves `updatedAt` on every state move, so the hash is compared, not the time), the run says "ticket changed since
  plan, re-planning first" with a "What changed" link that opens the description with the old lines struck and the new added, and, as it starts,
  the board copies the stale plan and the files its stamp lists for the planner, detaches them from the ticket (a person's own attachments stay),
  and plans again on the model and effort the ticket was first planned with ("planning (ticket changed)"). A plan with no stamp, such as one a
  person attached, is never re-planned. A change while a worker runs is sent to it as a message naming a file with the new text and the lines that
  differ ("ticket changed: sent to the worker at 14:05"), and the next round's brief carries the new text and what changed since the last. A
  planning run is not sent a message: its stamp holds the text it started on, so it plans again once its plan is attached.
- **A dependent learns from its blockers' merged pull requests.** When a blocker's pull request merges, the code host reads its title, its body and
  the markdown sections its diff added (`readMergedFindings`), the board saves them under the dependent's folder (`blockers/`), and the dependent's
  queued run says "learns from A11-165 (#3 merged)", linked to the pull request. A planner is given the files and must write a `## What the
  blockers found` section naming each pull request by its address and saying how its findings apply or why they do not; a plan that leaves one
  out is refused. A dependent planned before the merge is planned again with the findings before it starts, and a worker queued with no planning
  has the files named in its brief.
- **Queued together, planned together.** When `tickets.planner.run` names `{keys}`, the tickets one press of Queue plans first are one
  batch, and one planning run plans them, at most 8 to a run: a larger batch splits into runs of 8, in queue order. Tickets queued at
  different times are never batched. Every ticket of the batch shows as Planning, all linking to the run's one terminal, and the batch holds
  one worker slot. The run writes a folder per ticket in its plan folder, holding that ticket's plan files or a `QUESTION.md`, and an
  `order.json` giving each ticket's repository and the tickets of the batch it waits on. When it writes `planned`, each ticket with plan
  files has them attached and is queued again to be worked. A ticket with a question, or with nothing, ends as Needs you, and the others
  carry on: the run keeps its terminal open for the tickets it handed back (parked), and each of their cards says "Planned together with A, B, C: answer in the batch's terminal"
  and links to that one terminal. The person answers there, and when the run writes `planned` again the tickets it still holds are settled the same way, the order read against
  every ticket the batch was planned with. The board records the order in the tracker as "blocks" relations, so a ticket that waits on another shows as Blocked until it
  is done. An order that names a ticket outside the batch, a ticket waiting on itself or a cycle records no relation, and the board's log
  says why. A run that ends any other way ends every ticket of the batch that way. Stop on any ticket stops the whole run, and Retry plans
  a ticket again on its own.
- **Board.** Every run in one list, newest activity first, each with a status icon after GitHub's Actions runs, and a filter per status
  with its count: Needs you, Talking, In progress, Planning, Reviewing, Blocked, Queued, Awaiting review, Ready to merge, Publishing, Published, Completed, Failed and Cancelled. **Ready to merge** is a pull request GitHub would merge as far as its review and its checks go (A11-179): every open pull request of the run is approved at its current head (by the board's reviewer or a person, and GitHub's own review decision does not still ask for a review or for changes), and its required checks are green there. A run whose feedback round ended `reviewed` that is not there yet reads **Awaiting review**, with its outcome still `reviewed`, and its card says what it waits on, in this order: `review: none yet at 58848c34` (or `changes requested at 58848c34`), `checks red: gate`, `checks not passed: gate`, and `not read yet` until a watch has read its pull requests; with more than one open pull request each is named by its address. A run is Completed once the tracker
  completes its ticket, or once its pull requests have merged, as Linear's GitHub integration reports them. Linear completes a ticket on a
  merge only where its team's workflow says so. A run whose pull requests all closed unmerged is Cancelled. The board asks every two minutes. A run can be removed
  while queued, stopped while running, and retried once it has failed. The number of workers at once is set in Settings, and a change takes effect straight away. On a machine
  that sets `tickets.terminal`, a live or parked run has an Open terminal link to its agent's terminal in the browser. A run whose worker wrote `done` is Completed too: the board moves its ticket to the tracker's completed state and posts the worker's reason and evidence on it (see Outcomes below). A Completed run whose pull requests merged says `completed: a11ign/agent-org #1815, a11ign/plugin #9 merged` on its card, whether their bodies said `Closes` or `Refs`. When its ticket's Done-when has After-merge lines, the board lists them on the run and under "After-merge checks" beside "Pull requests" (the ticket, the line, and who runs it, or "owner not named"), posts them once as a comment on the ticket, and the card adds `; 2 after-merge checks listed`: such a run is Completed, never Needs you. A row leaves with its run.
- **The board reads again when you come back, and an update's restart is not an error (A11-211).** The page reads the queue and the new-ticket requests every 5 s, and the moment its tab is shown again or its window is focused, whatever it was waiting for, so a tab left open comes back to current state and every Open terminal link points at the pane its run has now. It does not load the whole board again then, so what you ticked and the Assignee scope stay. A read that gets no answer (connection refused, a network error) or a 502 or 503 from a proxy is an instance or a service restarting, as `agent-org update` does for 10 to 30 s: the page shows a quiet "Reconnecting…" line instead of the red message, tries again after 2 s, 4 s, 8 s ... up to 60 s, and clears the line by itself on the first good read. Red is for an error the server answered with, and for a press (Queue, Pause, Talk ...) that got no answer, which is not retried. A page opened during the restart finishes loading by itself. A click on an Open terminal link when the board was read more than 5 s ago opens the tab and reads the run's pane again first, so it goes to the live pane (or closes when the run is over). An SSH remote its proxy cannot reach is still its own red message.
- **Parked, not closed, when a run needs you.** A run that ends `needs-human`, `wrong-repo` or with no outcome keeps its herdr workspace
  and holds no slot, so you can answer the agent in its terminal. Once the agent works again the run is In progress again, its old outcome
  is marked stale (`outcome-stale-before`, the time the run parked) and not moved, so the worker must write a new one before it stops: the stop hook
  reads the outcome once and judges it as no outcome while it is not newer than that mark (A11-152). A worker that writes a new outcome file after its
  run parked, even between two of the board's looks, ends the run on it once its agent is idle. The stop hook refuses an outcome file that does not
  match the contract and names the field it wants (`ready-pr needs prs: [{repo, url}], you wrote pr`), so the worker fixes it in the same turn. A
  finished run whose outcome file was unreadable is read again when the file changes, so a corrected file ends it without a Dismiss. Close shuts a
  parked run's workspace and keeps its outcome, and a parked run is retried only once it is closed.
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
  It ends `reviewed` only when every check passed on the last commit, and otherwise hands the run back as Needs you; the board then shows it Ready to merge only once its pull requests are approved at their head and green there, and Awaiting review until they are (see "Board" above). `tickets.review` says
  what a review is on this machine.
- **Watched once it ends reviewed, and answered on its own.** Every 3 minutes the board reads the open pull requests of each run that ended `reviewed` (Ready to merge, or Awaiting review until its
  pull requests are approved and green: it is read again until it merges, or it could never become ready), and of each run Published. Each read records, for each pull request, its head, its review at that head, its red required checks and its required checks still running, which is what the card's status and its "waiting on" line are made of. A review that comments or requests changes, a conversation comment or an inline comment newer than the run's last round, from
  anyone but the GitHub account the workers use (`gh api user`), queues another review round. So does a check that is red at the head commit
  (the required checks, or every check where none is required), **once for each head**: the round's brief names each failing check and the error lines of its job's
  log, the jobs behind a failed required `gate` in its place, and a head that stays red after its round, or after a restart, starts no second one (A11-154).
  The same red check also wakes a run that ended needs-human, with no outcome, or crashed, or that is parked on a question, when its pull request is still open: its workspace
  is closed first, as for a conflict. A check that failed for an infrastructure reason (a runner that was lost, a rate limit, a GitHub 5xx or a network error) is not handed to a worker: its
  failed jobs are rerun once for the head, the run says so ("Reran test on 1a2b3c4d: a runner was lost or a rate limit was hit"), and red again on that head it is named for a person. **A red check that is not the run's starts no round** (A11-179): a check that is also failing on the head of the repository's default branch, or on another run's open pull request in the same repository that changes none of the run's plan paths, is named on the card ("refusalOwners is red on main / not this run's; owned by A11-127") and is neither briefed nor rerun, because no diff in the run's region can change it. The owner is the ticket a `Blocked-by:` line of the pull request's body names, else the key of the run's team that the check's own refusal text names, never the run's own. It is read again from fresh reads on every watch, so a check main has since fixed is the run's again and gets its round; a head with some of each is a round for the run's checks, and its brief says the others are not the run's. The pull request is still not Ready to merge while such a check is red there. The round
  resumes the same worker, names what started it, and has
  the worker fix what is right with a test, answer what is wrong with evidence, push, and wait for the checks. The board starts at most 3 such
  rounds. The next trigger hands the run to you as Needs you, whatever its outcome was, saying its pull requests keep getting feedback. Feedback that arrived while a
  round was running is not answered twice. Merged or closed pull requests are never watched.
- **A stacked pull request is retargeted when its base merges.** A run stacked on a blocker's pull request keeps that pull request's branch as its
  base. When the blocker merges and its branch is not deleted, GitHub does not retarget the stacked one, so the board does it: every 3 minutes it
  moves an open pull request whose base was the head of a merged pull request to the repository's default branch (`gh pr edit --base`), reads the
  base back, and leaves the head as the worker pushed it. A base whose branch is gone with nothing merged on it is not moved, since its work may
  never have landed: the run says `Needs retarget` on the board, with the pull request and the branch, until a person retargets it. A retarget that
  is refused is said the same way, and tried again on the next sweep.
- **Respond to review, for any run with a pull request open.** A finished run whose ticket the tracker has not completed or canceled, and that has a pull request open, offers
  Respond to review, whatever its outcome was: Ready to merge, Published, handed back after the board's 3 rounds, needs-human, crashed or ended with no outcome. A parked run's
  workspace is closed first. It queues a review round straight away, resuming the same worker, told that you asked it to answer the current
  feedback: reviews, comments and failing checks. It starts the count of the board's own rounds again, so watching carries on after it. On a run whose pull requests are drafts it acts as
  Approve. A press that cannot act says why on the board: the run has no pull request open, its ticket is completed or canceled, it is still running, or a round is queued already (A11-154).
  A run the board handed back at its cap because its pull request conflicts with its base merges that base in first, keeping both
  changes, and never rebases or force-pushes (A11-125).
- **A round and a Talk never share a session.** A Talk is refused while a round of the run is queued or running. Talk on a run that has a Talk session already (queued, running or
  waiting for you in its terminal) changes nothing, and the page opens the browser tab named for that run, so a second press finds the same pane. A batch is one run: Talk on any of its
  tickets opens one pane for all of them, and every card shows Talking, never Planning. A parked run's pane is never closed as a leftover, whatever else is queued: a queued round or Talk
  waits, saying "Waits for the person to answer in <workspace>", until the person answers or closes it. A queued round or Talk waits, saying "Waits for the Talk session in
  <workspace> to end", while an agent that is working holds the run's Claude session or its herdr name; an agent that is idle, done or has no pane is the run's leftover, and its workspace is
  closed first, said in the log and on the run. A parked run herdr no longer lists has its workspace closed as it is unparked (A11-154).
- **Publish, once a run is Ready to merge.** On a machine that sets `tickets.publish`, each run Ready to merge has a Publish tick, and
  "Publish selected (N)" publishes every ticked run in one press. Nothing else can be ticked: nothing reaches a channel before you approved it
  and it passed its review and checks, and a Published run is never posted twice. The press starts one publish run, in its own folder
  `<stateDir>/tickets/publish/<id>`, holding one slot, on `tickets.publish.model` and `effort`. It starts even while workers are paused,
  because you just asked for it. While it works, each run it posts shows Publishing, with the spinning ring and, on a machine that sets
  `tickets.terminal`, an Open terminal link to the publish run's own terminal. It writes `published.json`, `{ "links": ["<message url>"] }`, and the outcome `published`. Each run it
  posted then shows Published, with a link to the first message, stays watched, and still turns Completed when its pull requests merge. A
  publish run that fails, or takes over 30 minutes, leaves its runs Ready to merge, and the Board says why.
- **New ticket, written from a request.** On a machine that sets `tickets.writer`, the Pick view has a New ticket button. You say what the
  ticket is for, in plain words, and choose its placement. Auto (the default) leaves the project, repository, goal, priority and parent to the
  writer, which picks each from your request. Manual lets you set any of the five, and the writer uses what you set as given and picks the rest;
  a choice left "Not set" is the writer's, and "No priority" is a choice. `POST /api/writer` takes `placement` (`"auto"` or `"manual"`); a body
  that names none is Manual when it names any of the five and Auto when it names none, and an Auto body that names one is refused. Quick (the default) runs unattended:
  the writer runs the `a11ign:create-ticket` skill in full, which grills itself, writes the plan with a "Decisions made without a person"
  section, and files the ticket with its plan attached. Grill runs the same skill with you, in a terminal the board opens, asking its questions
  there, one at a time; it needs `tickets.terminal`. When a Grill run asks a question, its card shows "Waiting for you" with the question, keeps
  its terminal open until you answer there, and resumes; it fails only when its agent exits, or when nobody answers for 4 hours. The run files
  its own tickets: the tracker's create tool and the two attachment tools are granted to that run alone, and a hook refuses any call that
  updates, closes or deletes an existing ticket, names a relation on another ticket (`blocks`), attaches to a ticket the run did not create,
  or creates an eleventh. The hook records each ticket as the tracker returns it, and the board checks the run's outcome against that record,
  reads each ticket back from the tracker, and shows it as a link. A run that fails says why, and keeps any ticket it made before it failed.
  A build worker is refused every filing tool by name, and the refusal says to use New ticket. The writer's model and effort are set in
  Settings, apart from the run's and the planner's, and `tickets.writer.model` and `.effort` stay the defaults until one is chosen there. It
  works on a ticket-only host, and through a remote connection or the tailnet-served board as the rest of the board does. A request is refused
  by name when it is empty or too long, names a placement other than Auto or Manual, names a choice under Auto, names a repository the machine
  does not have, or a parent that does not exist. At most three new-ticket requests are unfinished at once.
- **Blocked until what blocks it is done.** A queued run whose ticket the tracker marks "blocked by" another waits, as Blocked, naming what
  it waits on, and holds no slot, while a run queued after it with nothing blocking it starts first. A blocker lets go once the tracker
  completes it, once its run on the queue is Completed, or once its pull requests have merged, whatever state its ticket is in (a pull request that says `Refs` leaves the ticket In
  Progress). A canceled or duplicate blocker never lets go, so a person decides. The blockers are read before a run first starts, and nothing starts while the tracker
  cannot say; they are read again every two minutes, so a relation changed in the tracker counts. A run that waited names its blockers and
  their pull requests in its brief, and checks that any release it depends on is out before relying on it. A run whose plan cannot be
  downloaded waits, saying why, and the board asks again on every pass; the other runs start, and it takes no slot (A11-125).
- **Held back by an overlap.** A queued run whose plan declares a path another run holds waits, as Blocked, saying which run it waits on
  and every path both touch, such as "Waits on A11-196 #12: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts". When every path is only a
  directory claim and no file is shared, the line adds whose directory to narrow: "a folder claim, not a shared file: narrow A11-196's `ui/test/` in its plan" (A11-212). A run holds the paths its plan declares, and the files its open pull requests change, from the moment it ends.
  Its plan's `## Paths` section lists those paths, `<repo>:<path>` bullets; `pr:open` reads the same section as the Region its pull
  request is checked against. A pull request whose files are not read yet holds its whole repository until a watch reads them.
  A run on one step of a multi-step plan (A11-175) holds that step's paths and its open pull requests' files, not the whole plan's: a plan
  gives each step a `### Step <N> of <M>: <title>` section that ends with its own path bullets, and the run's step is the one its
  `Partial:` line names, else the one after the last merged. A step whose section lists no paths (a plan that numbers its steps as table rows) holds only its open
  pull requests' files once its worker has ended, and the whole plan's paths while it is running or has no pull request open. A queued later step
  contests only its own step's paths. A reviewer of a pull request whose body says `Partial: step N of M` is given that step's section
  of the plan, told to hold the pull request to the ratchets' direction (a baseline or allow-list only shrinks, a rule or check only
  tightens), and shown the ticket's Done-when as the last step's.
- **Planned to run side by side (A11-212).** A planning brief lists the paths every other queued and running ticket holds, grouped by repository, and asks for the narrowest claim that
  holds the change: files, or a folder only this ticket writes into, never a repository's whole `test/` or `captures/`. It asks the plan to avoid the held paths where the design allows
  (per-feature folders, per-feature test data beside its tests, no edit to a registration point another ticket prepared), to say under `## Overlaps that remain` which ones it still shares
  and why, to name a shared integration point (a route table, a registry, a fixtures file) in the plan of the ticket that first creates it, and to prepare it with per-feature entries or
  placeholders. A batch's `order.json` orders a ticket `after` another only when it needs that ticket's code or both change one file. A plan that claims a directory another queued or
  running ticket also writes into is sent back once by the planner's Stop hook, naming the narrower paths, and refused on the board as Needs you when it still does. A file claim is never
  refused: two tickets that name one file share it, and the overlap wait puts them in turn. The list is written beside the brief (`claims-given.json`) so the brief, the hook and the board judge
  the plan against what the planner was shown.
- **Start anyway, for an overlap.** A run Blocked only on such an overlap, and on no ticket that blocks it, offers Start anyway. It
  starts beside the run it overlapped, the board says so on its row ("Started anyway: it overlapped NBF-1 #12 on src/pool.ts; a person
  overrode the wait") and the log records it. It does not pass a blocker, nor a plan that could not be downloaded (A11-125).
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
as `needs-human`, for a planning run and for a ticket with open sub-issues, which are completed by their own work. A review round's `done` is judged by its pull requests: with every one merged (or closed, one merged) the ticket is completed now and the run reads Completed; with one still open, the round ends as its ordinary `reviewed` result and the ticket completes when they merge; with all closed unmerged, a person is asked. A `done` also drops the run's `partial`, since it says nothing remains to build; `checked` and `reviewed` keep it. If the tracker cannot complete the ticket, the ticket stays where it is and the run is handed to a person with
both reasons. `checked` stays for a ticket that was looked at and is not finished: its ticket stays open, and nothing is posted.

**A worker's proposed edit to a ticket's text.** `done`, `checked` and `needs-human` may carry an `edit` with a `title`, the whole `description`, or both,
and a `why`. The board records the proposal beside the text the tracker held, and changes nothing. The run's row shows the proposal, with Apply edit
and Discard edit. Apply writes the title and description to the ticket only on a person's request, and is refused, keeping the proposal, when the
ticket's text has changed since the worker read it. Dismissing the run drops an unapplied proposal with it. An edit on a planning or review run is
refused as `needs-human`.

**Opening a pull request in ticket mode.** A worker opens each pull request with `pr:open`, which checks it before `gh pr create` sends it. A
ticket has no GitHub row, so `pr:open` reads the ticket through the tracker instead, and makes the checks a row's pull request gets: the Region,
read from the plan's `## Paths` section, the list of paths the work changes that the overlap wait reads too, and failing that from the
ticket's description and its plan files (a `## Region` section listing each path the work changes, one per line, prefixed `<repo>:` where
the ticket spans repositories); the body's keyword for the ticket, which is `Closes <KEY>` when the pull request completes it
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
already completed, canceled or marked a duplicate. The board reads the merged pull request's own `Closes` or `Partial:` declaration, and that decides over the outcome's `partial`: `Closes <KEY>` drops it, a `Partial:` line replaces it, a body that declares nothing leaves it, and a run whose pull request disagrees with its outcome says so on its card, naming both, instead of acting on the outcome (A11-181).

**The tracker's own integration can complete a partial ticket, and the board puts it back.** Linear's GitHub integration completes a ticket when a pull request merges whose body has a closing word (close, fix, resolve, complete or implement, in their -s, -d or -ed, and -ing forms) followed by the ticket's key *anywhere*, a code span or a quoted example included, whatever the body's `Refs` and `Partial:` say: a pull request whose tests were about the `Closes` grammar quoted it, and completed its ticket two seconds after it merged, so the board read the run as finished and never queued the next step. So the `closes` report, which `pr:open` and CI's `acceptance` job share, reads a whole body the way the tracker does (the words are the tracker's `closingWords`, contract 1.5). It refuses a `Partial:` body with a closing word next to its own ticket's key, and any body with one next to the key of another ticket of the same team, and says the line it found; describe an example in words ("the closing keyword followed by the key") rather than spelling it differently. What gets through anyway is undone: when the tracker reads a ticket Completed while a finished run's work is partial (its `Partial:` pull requests merged, or it is a later plan step whose own pull request has not merged), the board asks the tracker to put the ticket back (`undoAutomaticCompletion`). The tracker moves it to the state it was in before and posts a comment naming the merged pull requests, the step they finished and the steps that remain, and the same sweep queues the next step. Only a completion by the integration is undone: a ticket a person moved to Done stays Done, the run reads Completed and the board asks no more. When the tracker cannot put the ticket back, cannot say who completed it or has no such operation, the run reads Needs you with `Done in the tracker, but its last merged pull request declared Partial: <what remains>; the board could not put it back (<why>)`, and the board asks again on every sweep. A later step that is queued before the integration completes the ticket is put back as its run starts. The board reads the merged pull request's own `Closes` or `Partial:` declaration, and that decides over the outcome's `partial`: `Closes <KEY>` drops it, a `Partial:` line replaces it, a body that declares nothing leaves it, and a run whose pull request disagrees with its outcome says so on its card, naming both, instead of acting on the outcome (A11-181). Until it has read the merged bodies, the board neither puts a partial run's ticket back nor queues its next step, and the card says it is reading them.

`partial` is what remains of the ticket once every pull request of the run has merged, and only build work that a later run of the ticket does: a plan step. It is not what one pull request leaves to its sibling in the same run, and not an After-merge line of the Done-when. Pull requests that finish a ticket together (two repositories) each say `Refs <KEY>`, since one `Closes` would complete the ticket on the first merge, and each `Partial:` line names the others (which `pr:open` needs); the outcome has no `partial`, and the board completes the ticket once all of them have merged. A pull request that leaves only After-merge lines says `Closes`.

**A plan with numbered steps queues its next step.** A ticket whose plan has numbered steps ships one pull request for each. A worker that finishes step N of M
begins the body's `Partial:` line and its outcome's `partial` with `step <N> of <M>`, and the last step's pull request says `Closes` with no `Partial:` line. When a
`Partial` pull request merges, the board replaces the finished run with a queued one for step N + 1, on the same plan, which starts like any queued run (a fresh worker,
whose brief lists the steps already merged), and the card says `step 1 of 9 merged; step 2 queued`. Only a numbered step that moves forward is queued. A `partial` that gives no `of <M>`, or names no step at all, is counted by the board: the step finished is the first `step <N>` it names (`step 2 of the plan` is step 2) or else the first step the run's record does not show as merged, and the plan's size is the record's, or else the numbered steps of the plan file (`### Step <N>` headings, or a numbered list or table under a heading named `Steps` or `The steps`), read once. The board's log says `A11-160: the Partial line named no step; counted as step 2 of 9; step 3 queued`, the card says `step 2 of 9 merged (counted by the board: the Partial line named no step); step 3 queued`, and the next step's brief says which step the board counted and tells the worker to check the merged pull requests against the plan. A `partial` that names the last step, is not past the last step merged, or belongs to a plan with no numbered steps is not queued, and its run reads Needs you with the reason, so a worker cannot loop the queue. Dismissing such a run and queueing the ticket again needs no move in the tracker. A partial merge whose ticket the tracker's integration completed anyway is put back first, with a comment, so its next step is queued in the same sweep (see above). The last step's pull
request ends the ticket as any `Closes` does. The board reads the merged pull request's own `Closes` or `Partial:` declaration, and that decides over the outcome's `partial`: `Closes <KEY>` drops it, a `Partial:` line replaces it, a body that declares nothing leaves it, and a run whose pull request disagrees with its outcome says so on its card, naming both, instead of acting on the outcome (A11-181). A merged `Partial:` the plan has no numbered step for queues nothing, and the card says to close the ticket and file what remains as its own ticket, starting from the `Partial:` words.

**A ticket another instance holds.** An instance writes a claim on a ticket in the tracker as a run starts on it to plan or to implement it: a comment `agent-org: claimed by
<instance>.<install id>` (the Linear plugin's, contract 1.2), written only when the ticket's latest claim names another instance. Pick shows a ticket as taken, and the queue refuses
it, only when it is In Progress, in a state `tickets.providers.tracker.takenStates` names, or in a state of the started type, and its latest claim names another instance. A
ticket this instance ran is never taken, whatever its state, and neither is one with no claim: a ticket moved to In Progress by hand, or by an instance from before claims, can
be queued, which is the cost of the rule. Before the queue takes a ticket that is in work, it reads the ticket and its claim again, so one moved to Todo since the list was read is
queued; a tracker that cannot be asked answers 503, never "taken" and never "free".

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

Every external concern of ticket mode is an **agent-org plugin**: a code module behind a versioned contract (a "Claude plugin" is something else: `tickets.plugins` lists those). There are six concerns: the tracker, the code host, the publisher, the reviewer, the exposure and messaging. A plugin's settings are the block of its concern under `tickets.providers`: `tracker` (`linear`, the bundled plugin in [`plugins/linear`](plugins/linear), which brings its settings schema, its doctor checks, its onboard steps and its agent tooling: the Linear MCP, its read-only connectors and the tools a new-ticket run files with), `codeHost` (`github`, the bundled plugin in [`plugins/github`](plugins/github), which brings the settings `identity`, `gh` and `stack`, its doctor rows (the stacking extension and the stacked pull requests of each GitHub clone) and its onboard step), `publish` (`slack`, the bundled plugin in [`plugins/slack`](plugins/slack), which brings the settings `run`, `model`, `effort` and `connectors`, the `post-pr-to-slack` skill its publish run uses, its doctor rows and its onboard step, or `none`), `reviewer` (`atomic`, the bundled plugin in [`plugins/atomic-reviewer`](plugins/atomic-reviewer), which brings the gate's codex reviewer with its doctor rows (the gate loads; Codex is installed and logged in) and its onboard step, or `none`) and `exposure` (`local`, the default, in [`plugins/local`](plugins/local), or `tailscale`, in [`plugins/tailscale`](plugins/tailscale)). Messaging is the sixth concern, and it is configured in the primary project's `.agent-org/project.json` `messaging` key and not in a block: `telegram` is the bundled plugin in [`plugins/telegram`](plugins/telegram), with the settings `tokenFile`, `chairmanFile` and `announcementsFile`, and `enabled` (absent is true) there too. In a block, `provider` names an installed plugin, `enabled` (absent is true) turns it off without forgetting its settings, and the rest are the plugin's own settings, each refused by name when the plugin does not declare it. Exactly one tracker and one code host must be enabled, so `enabled: false` on either is refused by name; a disabled publisher publishes nothing, a disabled reviewer starts none, and a disabled exposure serves the board on loopback only. A plugin that implements a contract major this agent-org does not read is refused by name, at start and in `agent-org doctor`. No concern's code is built into core: the tracker moved in A11-159, the code host in A11-160, the exposure and messaging in A11-162 and the publisher and the reviewer in A11-161, so core runs whichever bundled plugin a host enables (and `none`, for the publisher and the reviewer, is the absence of an enabled one). The publisher plugin builds the publish run's brief, names its connectors, model and effort and reads its outcome, over the publish protocol that stays core's; the reviewer plugin's folder is `plugins/atomic-reviewer` but its name stays `atomic` (its manifest's `agentOrg.name`), so no live host file changes. **Reviews required** (`tickets.providers.reviewer.required`) is a per-machine setting of the reviewer concern, valid under any provider, `none` included: absent, it is true when the block (or the old `tickets.reviewer`) names a reviewer plugin, enabled or not, and false when it names none or there is no block, so a machine that runs the atomic reviewer requires it and one with no reviewer (where people review) does not; `agent-org plugin config atomic required=false` sets it, and uninstalling the reviewer keeps an explicit one. When it is required and the reviewer is off (none, switched off, or one whose gate does not load) the Board shows the banner "Reviews are required and the reviewer is off", each open pull request's line says "waiting on the reviewer (off)" and `agent-org doctor` fails with the command that enables it (`agent-org plugin enable atomic`, or `install` when none is installed); when it is not required and there is no reviewer, each run's open pull requests say "awaiting your review" and nothing else is shown. Disabling the reviewer stops new reviewer starts only (a reviewer still running finishes and posts), and enabling it resumes on the next board start, with a reviewer on the current head of every open pull request, once per head. A publisher that is installed and disabled hides the Publish buttons and says "publishing off" on each run that is Ready to merge; enabling it publishes nothing retroactively. The tracker, the code host, the exposure and messaging moved earlier (core asks the activated exposure for the names, addresses and serve calls the board used to take from Tailscale, and the activated messaging plugin for the provider; `src/plugins/boundary.test.ts` refuses the `tailscale` command, a tailnet host or `api.telegram.org` in core): core runs whichever bundled tracker or code host plugin is enabled, imports no plugin's code and names no Linear endpoint or tool (`src/plugins/boundary.test.ts` refuses both), and `agent-org plugin disable linear` and `disable github` are refused while each is the only one of its concern. A11-160 moves the code host's GitHub calls into `plugins/github` in steps, each its own pull request (so far: ticket mode's reads of a pull request, the routing `gh` wrapper and App tokens, and a red check's log and rerun, the review claim and the verdict door the reviewers post with, the last behind code host contract 1.5); `docs/gh-call-baseline.json` lists the files that still call `gh`, `src/packaging/gh-call-ratchet.test.ts` refuses a call in any file outside `plugins/github` that the baseline does not allow, and the baseline only goes down. A block left out takes its plugin's default, which `agent-org doctor` says. The old keys, such as `tickets.linearKey`, `tickets.workingState`, `tickets.publish`, `tickets.reviewer`, `tickets.port` and `tickets.serve`, are read as aliases for one release: `agent-org doctor` names the place each one moves to, and `agent-org doctor --fix` moves them, keeps a backup of the host file beside it, and writes nothing unless the moved file reads the same settings.

`agent-org plugin list|install|enable|disable|uninstall|config` manages them. `enable <name>` of a plugin the concern's block does not name SWITCHES the block to it when the block names another plugin of that concern (`agent-org plugin enable local` on a tailscale host): it keeps each setting both plugins declare, drops the rest (`tailnetPorts`) and a `terminal` that is the outgoing plugin's own address, and says which. The plugin it leaves is RELEASED first, while it is still the enabled one and after the readers have accepted the change: `release` takes what the plugin put on the machine off it (Tailscale removes the two entries it serves for this board, and no other), and a release that cannot (Tailscale not running) refuses the change by name and writes nothing, so the host file and the machine never disagree. `disable`, `uninstall` and `install --replace` release the same way. After a switch, restart the instance, the page and the terminal (`agent-org start instance`, `agent-org start ui`, `agent-org start terminal`): on `local` they listen on loopback and serve nothing, and `agent-org doctor` is green. `list` shows each concern with the plugin enabled for it and every plugin known for it (bundled in `plugins/<folder>`, or a fake for tests), with its contract version and any refusal. `install <name> [--set key=value] [--replace]` writes the plugin's block (it is refused by name when the block names another plugin, unless `--replace`); `enable <name>` and `disable <name>` set `enabled`; `uninstall <name>` removes the block, and the concern falls back to its default (refused for the tracker and the code host, which must keep one); `config <name> [key] [key=value] [--unset key]` shows or sets the block's settings, never printing a secret, only the path of its file. Each write goes through the Settings page's own path: it keeps the file's layout and your `_` notes, is refused when the readers would refuse the new file, and leaves `host.json.bak` beside it. A key the schema marks dangerous needs `--confirm`. A concern still read from an alias is refused a write, naming `agent-org doctor --fix`, and messaging is written to the primary project's `project.json` through the same path (`telegram` there takes `enabled`, `tokenFile`, `chairmanFile` and `announcementsFile`; `uninstall` removes the whole `messaging` key, its `summary` and `milestones` too, and `project.json.bak` holds it). The Settings page's **Plugins section** (A11-163) is where the same plugins are listed and controlled. It is its own call (`GET /api/plugins`), so the rest of the page is drawn while a plugin's checks run and when they fail. It groups the plugins by concern (Tracker, Code host, Publisher, Reviewer, Exposure, Messaging), and each row says its name, agent-org's version, its contract version and its state in words: `enabled`, `disabled`, `not installed` or `failed`. The controls are the CLI's own plans, written through the one writer (`POST /api/plugins/action`, local instances only, refused with the CLI's sentence and nothing written when the file changed since the page read it): Enable and Disable (Disable on the only tracker or code host is drawn disabled, with the reason beside it), Install on a plugin that is not installed (one that replaces another plugin of the concern asks first, naming the plugin and the settings it drops, and keeps the settings both declare), Uninstall (asks first), and Configure, which opens the plugin's own settings from its schema, edited in place as before (`provider` and `enabled` are shown by the state and the controls and are not drawn as settings). A change is in force when the board restarts, which the page says. **A secret is never typed in the page**: a plugin that needs one shows the exact command that sets it with a copy button (each secret setting of a plugin's manifest declares it as `setCommand`), and a plugin that needs one is installed with `agent-org plugin install` or `agent-org onboard`, so it has no Install button but its install command. A required concern with no plugin enabled says "No tracker enabled: the board cannot run" (or "No code host enabled: …") with the command that enables or installs one, and an optional one says "None" with how to add one. A plugin that failed to load is a red row with the reason and the fix, and the other rows are drawn. A remote instance's Plugins section is read-only: its files are changed on that machine.

| key | |
| --- | --- |
| [`tickets.providers`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.provider`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.enabled`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key.path`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key.keychain`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.connectors`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.workingState`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.plannedState`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.takenStates`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.provider`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.enabled`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.mode`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.appId`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.keyPath`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.installationId`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.slug`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.workers`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leads`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsHeader`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces[].id`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces[].role`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.stack`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.provider`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.enabled`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.run`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.model`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.effort`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.connectors`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.provider`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.enabled`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.required`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.provider`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.enabled`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.port`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.uiPort`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.terminal`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts.ui`](src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts.terminal`](src/ticket-mode/config-schema.ts) | |
| [`tickets.max`](src/ticket-mode/config-schema.ts) | |
| [`tickets.port`](src/ticket-mode/config-schema.ts) | |
| [`tickets.uiPort`](src/ticket-mode/config-schema.ts) | |
| [`tickets.serve`](src/ticket-mode/config-schema.ts) | |
| [`tickets.servePorts`](src/ticket-mode/config-schema.ts) | |
| [`tickets.herdrSession`](src/ticket-mode/config-schema.ts) | |
| [`tickets.instance`](src/ticket-mode/config-schema.ts) | |
| [`tickets.worktreeRoot`](src/ticket-mode/config-schema.ts) | |
| [`tickets.linearKey`](src/ticket-mode/config-schema.ts) | |
| [`tickets.brief`](src/ticket-mode/config-schema.ts) | |
| [`tickets.review`](src/ticket-mode/config-schema.ts) | |
| [`tickets.plugins`](src/ticket-mode/config-schema.ts) | |
| [`tickets.deny`](src/ticket-mode/config-schema.ts) | |
| [`tickets.connectors`](src/ticket-mode/config-schema.ts) | |
| [`tickets.terminal`](src/ticket-mode/config-schema.ts) | |
| [`tickets.plan`](src/ticket-mode/config-schema.ts) | |
| [`tickets.planner`](src/ticket-mode/config-schema.ts) | |
| [`tickets.publish`](src/ticket-mode/config-schema.ts) | |
| [`tickets.writer`](src/ticket-mode/config-schema.ts) | |
| [`tickets.preflight`](src/ticket-mode/config-schema.ts) | |
| [`tickets.drafts`](src/ticket-mode/config-schema.ts) | |
| [`tickets.prReview`](src/ticket-mode/config-schema.ts) | |
| [`tickets.reviewer`](src/ticket-mode/config-schema.ts) | |
| [`tickets.pick`](src/ticket-mode/config-schema.ts) | |
| [`tickets.stallMinutes`](src/ticket-mode/config-schema.ts) | |
| [`tickets.updateMaxDeferHours`](src/ticket-mode/config-schema.ts) | |
| [`tickets.workingState`](src/ticket-mode/config-schema.ts) | |
| [`stateDir`](src/ticket-mode/config-schema.ts) | |

**Turning a setting on safely**

- [`tickets.drafts`](src/ticket-mode/config-schema.ts): Canary: set it on one machine first. Its new runs show Awaiting review with no Approve, and their pull requests on GitHub are not drafts (`gh pr view <url> --json isDraft` gives `false`). Revert: remove the line, or set it `true`. Runs already opened ready are not changed back: they stay Awaiting review, and are reviewed and merged on GitHub, since the board offers no Approve for them.
- [`tickets.prReview`](src/ticket-mode/config-schema.ts): Canary: set it on one machine, then check that a new run's folder holds `pr-review.json` and that its pull request's body has the `Pre-PR review:` line. Revert: remove the line. Runs already started keep the gate they were given.
- [`tickets.reviewer`](src/ticket-mode/config-schema.ts): Canary: one `reviewer-<n>` workspace per ready head in the `tickets` session, not one per watch; a reviewer's workspace closes within one watch of its verdict, and a merged or closed pull request's workspace and `~/reviews/<seat>` checkout are gone within one sweep (every 3 minutes), a line naming any uncommitted changes discarded with the checkout; a `no reviewer for <url>` line in the board's log names a refusal; each ready pull request has one review from `a11ign-reviewer` on its head, and a reply to a `changes requested` review (from the board's own account or a person the org declares) with no new commit asks for one more review of that head, which the board words as `re-review asked by reply at <head>`. Revert: remove the line. Reviewers already running finish, and the sweep closes their workspaces and removes their checkouts once their pull requests have merged or closed.
- [`tickets.pick`](src/ticket-mode/config-schema.ts): Canary: the Pick view's count reads `assigned to you` by default and `open in team <key>` or `open in project <name>` with a team or a project, and the Anyone chip reads as that count. Revert: remove the line.
- [`tickets.stallMinutes`](src/ticket-mode/config-schema.ts): Canary: a `<key> has been idle for <n> minutes or more since it wrote working` line in the board's log, once per stall. Revert: remove the line.

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

When the blocker's branch moves (a rebase, review fixes, or a force-push), agent-org merges it into the stacked run's branch. It does that once the worker
has stopped, for a finished run with its workspace closed, and never while a live worker or a parked run's workspace is open. The merge is plain: agent-org
never rebases or force-pushes the run's branch, and the worker is told not to do either while it works. The commit the run was branched at is recorded by
`ticket:worktree --from` in the ticket's `stack-base.json`. A merge that conflicts is aborted. Where the board can start a round on the run (one it resumes on
a conflict, with a pull request open in the blocker's repository), the conflict is recorded and that round starts: its worker merges the base in, keeps both
changes, re-runs the checks and pushes, the same round as for any pull request that conflicts with its base. Until then the board says "Resolving a conflict
with NBF-1 in <file>". Elsewhere (a draft, say) the conflict is not recorded, and the next sweep tries the merge again; an approval round merges the base in
first. A conflict its worker resolved by merging the blocker's branch in by hand is cleared by the next sweep. Past the board's round cap the run is handed
back with the conflict named, and Respond to review starts the round. When the blocker merges, its stacked pull request is retargeted to the default branch
(A11-106).

## What an install holds

`src/` (the programs and their data, without `*.test.*`), `host/` (the unit templates `host:install` reads), `LICENSE`, `README.md` and
`package.json`. The tests are not shipped: they read the project's tree and run in this repository's CI. A version folder installed from a release that ships the board UI's
build also holds `ui-build/` (A11-191): the static files CI built and attached to the release, which `ticket:ui` serves at `/next`. It lives inside the version folder, so a run
that started on a version keeps that version's UI, and a prune removes it with the folder.

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

## The board UI package (`ui/`)

`ui/` is the board UI's foundation (A11-188, part of A11-187): **Astro with React islands**, strict TypeScript, built to **static files** (`output: "static"`, `base: "/next"`) with no adapter and no server of its own. The instance's server stays the only server. Nothing of `src/ticket-mode/ui.html` is ported. The pages are the Atomaut shell (A11-194): the sidebar, the instance switcher, the connection pill and the design tokens, with the Tickets page (A11-196) and a placeholder page for each other route until its own ticket lands (`docs/design/atomaut/BRIEF.md`). The two self-hosted fonts (Inter and JetBrains Mono, bundled from Fontsource) load from the build, and nothing is fetched from another origin.

`ui/` is a private package of its own, **not a pnpm workspace member** (the layout check refuses a `pnpm-workspace.yaml`), with its own `ui/pnpm-lock.yaml`. `package.json`'s `files` does not ship it and `pnpm install --prod` never installs its dependencies, so a machine needs none of them (an install unpacks the tag's source, `ui/` included, and ignores it). **CI builds the UI into each release** (A11-191): `release.yml`'s `ui-build` job checks out the tag the push released, installs `ui/` from its lockfile, builds it and packs `ui/dist` with `scripts/ui-asset.ts pack` into `agent-org-ui-<tag>.tar.gz` (entries sorted, owner 0, mtime 0, `index.html` at the root) and its `.sha256` (`sha256sum` format); `ui-attach` adds both to the GitHub Release, the tarball first. `install.sh` and `agent-org update` fetch and verify them (see "Install"), so no machine ever installs `ui/`'s dependencies or runs `astro build`. `ci.yml`'s `ui` job runs the same install, build and pack on every pull request as a dry run (the tag `dry-run`, uploaded to no Release) and archives the two files as the run artifact `agent-org-ui-dry-run`. `agent-org doctor`'s `ui build` row is `ok` when `/next` has a build to serve, and a `WARN` when the running version's release ships one and none is found (the fix is `agent-org update`, which fetches it; in a checkout, `pnpm ui:build`).

To work on it, from the repository root:

```sh
pnpm --dir ui install          # once, and after a change to ui/package.json
pnpm ui:dev                    # the dev server, http://localhost:4321/next/
pnpm ui:build                  # static files in ui/dist
pnpm ui:typecheck              # astro check (the .astro files) and tsc --noEmit (every .ts and .tsx)
pnpm ui:test                   # rstest: the components, the dev proxy, and the page checks over ui/dist
```

**The dev server proxies `/api/*` to this machine's instance**, so a page can be built against live data. It runs the checkout's own `ticket:remote-info`, which reads the host file (`$AGENT_ORG_HOST`, else the default) and the board key, and passes each call on to `http://127.0.0.1:<port>` with the key in `x-ticket-token`. The key is held in the dev server's memory only: it is never written to a file, a URL, a log line or a response. With no instance or no key the dev server still starts, and a call to `/api/*` answers 502 with `ticket:remote-info`'s own error, which names the remedy (`agent-org ticket:serve` makes the key). Start the instance and call again: no restart is needed.

**The page checks need a build and a browser.** They serve `ui/dist/` with `astro preview` and drive Chromium through `playwright-core`, which `ui/` pins to the root's exact version, the build `onboard` and `doctor` install. They refuse to start, saying so, until `pnpm ui:build` has run. The screenshot helper captures a route at 1440px and at 390px wide, writes full-page PNGs named `<route>-<W>x<H>.png` (A11-151's `captureName`) to `ui/screenshots/` (ignored by git), and fails on horizontal overflow, naming the route, the width, `scrollWidth` and `clientWidth`.

**`ticket:ui` serves the build at `/next/`** (A11-190), beside today's board at `/`, behind the same pairing and with the same remote-instance proxying: a `/next` page calls `GET /api/connections` and `/c/<connection>/api/...` as today's does, and an unpaired browser is shown the pairing page. It looks for the build in `ui-build/` beside the running version (where a release unpacks it), then in `ui/dist/` (a checkout's own `pnpm ui:build`), counting a folder only when it holds `index.html`, on each request, so a build made while it runs is served without a restart. A client-side route is answered with the nearest page above it (`/next/settings/x` takes `settings/index.html`, else the root page), a missing asset is a plain 404, files under `_astro/` are cached for a year and every other file is `no-cache`. With no build, `/next` answers a plain 503 page that says the build is missing, that a release carries it and that `pnpm ui:build` makes it in a checkout.

**The instance API's client is `ui/src/api/`** (A11-189): `createClient(connection, { fetch })` has one typed method per route the board calls, and `usePoll(read, { connection })` polls one of its reads. The answers' types are `import type`s from the server's modules (`server.ts`, `ui-server.ts`, `settings-view.ts`, ...), never copies, so a server change that breaks a page fails `pnpm ui:typecheck`. A call never throws: it resolves to `{ ok: true, data }` or `{ ok: false, status, refusal, unreachable }`, where `refusal` is the server's own `error` sentence for a page to show, and every change goes through `mutate`. The client sends what `ui.html`'s `call()` sends: a same-origin `fetch` carrying the paired browser's session cookie, and no token of its own (`ticket:ui` adds each instance's key). `usePoll` reads every 5s while the page is visible and pauses while it is hidden. When the page is shown again or the window gains focus it forgets the failures in a row and reads at once. After a failure it waits 2s, 4s, 8s ... up to 60s and starts over on a success. It reports `loading`, `ready`, `empty`, `error`, `unreachable` or `reconnecting`, and keeps the last good data. `unreachable` is for an SSH connection whose proxy answers "cannot reach ..."; `reconnecting` is for a read with no answer or a 502 or 503 (`looksLikeRestart` in `src/ticket-mode/board-view/reconnect.ts`, the rule `ui.html` applies too: an instance or a service restarting, shown as a quiet "Reconnecting…" line and tried again); `error` is for what the server answered with. `readAt` is when the data was read, and `current()` resolves to the held data while it is no more than one poll interval old and otherwise reads now: a page that builds a link from the data (a run's terminal) calls it on the click.

**The Atomaut shell is `ui/src/shell/` and `ui/src/lifecycle/`** (A11-194). Each route is an Astro page (`ui/src/pages/`) that renders the one `App` island inside `layouts/Shell.astro`: `/next/tickets`, `/next/runs`, `/next/runs/<key>` (the runs page, which reads the key from the path, since a static build cannot list keys; `ticket:ui` answers it with the nearest page above) and `/next/settings/<models|workers|machine|plugins>`. `/next/` goes on to Tickets and `/next/settings` to Models (small pages that keep the query and the hash, so `?connection=` still names the instance a link is for). Every page carries its styles inline and no asset is inlined as `data:`, because the instance sends its pages with a policy that allows only inline styles (`PAGE_CSP` in `ui-server.ts`). **Every value is a token in `ui/src/styles/tokens.css`**: `ui/test/tokens.test.ts` refuses a colour literal anywhere else under `ui/src/` and a pixel length (bar a 1px hairline and the one 820px media rule in `shell/shell.css`) in any other stylesheet, so a page ticket adds the tokens its boards need to that file and uses them by name. `ShellProvider` reads once what the sidebar shows and a page reuses it through `useShell()`: `/api/connections` once (the instance shown is `?connection=`, else the one remembered under `ticket-mode.connection`, else this machine's, and a switch gives every read a new client for that instance), `/api/config` and `/api/tickets` once per connection (`usePoll`'s `repeat: false`), and `/api/queue` every 5s, which drives the Runs badge and the connection pill. The shared lifecycle components (`Lifecycle`, `Skeleton`, `EmptyState`, `ErrorState`, `UnreachableFrame`) take the polling hook's result and show the skeleton, the empty panel, the page, the error banner with Retry, or the unreachable frame. The page checks (`ui/test/shell.page.test.ts`) answer `/api/connections` and `/c/<name>/api/...` from a stand-in instance (`ui/test/fixtures.ts`).

**The Tickets page is `ui/src/tickets/`** (A11-196): today's Pick tab, drawn as the four Tickets boards draw it (`docs/design/atomaut/BRIEF.md`). Which tickets show, how they group, what can be picked and what a filter keeps are `board-view.ts`, `assignee-filter.ts` and `label-filters.ts`, imported and never restated. The Assignee scope now lives in `ShellProvider`, so the sidebar's counts, projects and goals follow it as `ui.html`'s do; on an instance that reads scopes on demand (`config.scopes`) choosing one reads its pages with `client.ticketsPage`, and who holds the rest (`/api/people`) and the parents the tree nests under (`/api/parents`) are read after the first paint. The page remembers its choices under `ui.html`'s own keys (`ticket-mode.open`, `.open-parents`, `.priorities`, `.plan`, `.labels`), so a choice made on `/` holds on `/next`. The queue options (Plan first, Model, Effort, Change defaults, Reset) sit in a popover behind the Options cog of the queue bar, which shows only while tickets are selected; Queue posts what the Pick footer posts (`keys`, `model`, `effort`, `plan`). New ticket opens the dialog of `ui/src/new-ticket/` (A11-199): the request, Quick or Grill, Auto or Manual placement (Auto leaves the project, repository, goal, priority and parent to the writer; Manual sets the ones chosen and the writer uses them as given), and the writer's model and effort as a pill linking to Settings. The request strip under the header draws each request from `/api/writer` (polled every 5s) in its state: queued, writing, waiting for you, done or failed. The request is held by the page, not the dialog, so closing the dialog stops nothing.

**The update in progress is `ui/src/updating/`** (A11-217): the page left open across an `agent-org update` shows the Updating card (then Slow, then Back) in the main column in place of the page, with the sidebar as last known and the connection pill amber "Updating", and Tickets and Runs carry the drain banner (`updateBanner()`'s words) while a breaking release drains. The page decides it is an update when its queue poll is `reconnecting` and the last good read named one: a drain note, or `update.next`, which `/api/queue` now carries while `update.lock` names a live process (`src/ticket-mode/update-next.ts`: the `.partial` folder being built, else the version `current` names once it is not the running one). Slow is 60 s after the first failed poll; Back is the first good read on another version, and the page reloads itself 5 s later onto that version's code. `node scripts/board-update-check.ts` runs a real throwaway install through a normal and a breaking update in a real browser.

Lint covers `ui/`: `npm run lint` reads `.ts`, `.tsx` and `.astro` with the same Clean Code rules, and CI's `ui` job runs the typecheck, the build and the tests.

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
   **Two jobs follow the call and attach the board UI's build** (A11-191): `ui-build` (`contents: read`, runs the repository's code) finds the tag the push released (the `vX.Y.Z` tag whose commit has the pushed sha as its first parent, because the shared workflow reports no tag; a push that released nothing ends green), builds `ui/` at that tag and packs it, and `ui-attach` (`contents: write`, runs no repository code) uploads `agent-org-ui-<tag>.tar.gz` and then its `.sha256` to the Release, never replacing one. A re-run that finds both attached succeeds; one that finds only one fails and names it. The tag exists a few minutes before its UI build is attached, which is why an install or an update of a release in that window is refused and tries again.
3. **`main`'s `package.json` version and `CHANGELOG.md` lag the last tag**, and are left to: a project pins the tag's tree, which holds both, and the next version is computed
   from the tag. A later merge with no unreleased changeset cuts nothing, and the next one that carries a changeset is a different, later tag.

The tag is what reaches the running org: the host that runs the org runs the newest `vX.Y.Z` tag (`update-tool` checks it out), and `host.json`'s `toolVersion` pins one tag
instead, which is the whole of a rollback. A merge with a changeset is live about nine minutes after it lands (measured from the tag history on a11ign/a11ign#3443), and a merge
with no changeset is never tagged and so never live. A release therefore changes what a project's CI installs and what the running org does.

A project bumps its pin by editing the range in its `package.json` (`github:a11ign/agent-org#semver:^0.1.0`) in an ordinary dependency pull request and reading the
changelog it links. While the version is `0.x`, `^0.1.0` takes patches only, so a `minor` is the bump a project opts into.
