# Onboard a machine

[Back to the README](../../README.md). After [installing](install.md), run `agent-org onboard`.

| command | what it does |
|---|---|
| `agent-org onboard [--profile <name-or-path>] [--verbose]` | With `--profile`, sets the machine up from that profile (see "One command, from a profile" below), asking only for the secrets it lacks. **It installs herdr first (A11-223):** when `herdr` is not on `PATH`, it installs the herdr version this release pins (0.9.3, the same on every machine, never the newest) from herdr's own release assets, checks the download's SHA-256 against herdr's manifest, puts it in `~/.local/bin` (or `$HERDR_INSTALL_DIR`) and says `✓ Installed herdr v0.9.3`. A herdr that is already there, on `PATH` or in that install directory, is left as it is, at whatever version, because replacing it ends live panes (a directory `PATH` does not reach is added to `PATH` for the run, with the line to keep it there). If the install fails, onboard stops at that step with `✗`, the exact command to run by hand, and nothing written, run or started; run onboard again after it. Writes the host file, `~/.agent-org/host.json` (or the file `$AGENT_ORG_HOST` names). It asks for the repositories a worker can choose from, or takes them as `--repo <name>=<path>` (repeated). The Linear key is kept in the macOS Keychain on a Mac and in a private file, `~/.agent-org/linear.key`, elsewhere, and nobody is asked where: `--linear-keychain <service>` or `--linear-key-file <path>` name another place, as an advanced option. At a terminal, with no `--repo`, it does not ask for paths: it lists the GitHub checkouts in the folder it runs in (that folder and each folder one level down, matched by their remote, so run it from the folder that holds your checkouts), pre-ticked and named as GitHub names them. It then asks `Add repositories not cloned here?`: a Yes lists your account and its organisations, then their repositories (type to filter), with the host file's repositories pre-ticked, and offers to clone each one picked that has no checkout into that folder, listing them by name with the path each goes to. In every list space ticks and unticks the highlighted item, the arrows move and enter confirms, and the last line of a list says so (`↑↓ move · space select · enter confirm · type to filter`). Each clone prints one line when it ends, ✓ or ✗ (the command it runs, `gh repo clone <owner>/<name> <path>`, shows with `--verbose`). It then prints each repository with its path, marked found, cloned or kept, once, before it writes the host file, and keeps every repository the host file already names. Without a terminal, `--repo` and a profile work as before and onboard never prompts. It keeps the host file's other keys. **Connect to Linear:** when no key is readable it says where the key is kept and where to create one (Linear → Settings → Security & access → Personal API keys, with Read and Write access), asks for it at a prompt that does not echo, checks it against Linear at once and says whose account it is, and stores it (into the Keychain through `security -i`, so the key is never an argument a process list shows, or into a mode-600 file). A key Linear refuses is asked for again (three tries); a key Linear cannot be asked about is stored and said to be not checked. A key already stored is checked and not asked for, with or without a terminal, so an unattended run makes that one call to Linear, and one that cannot reach Linear says the key was found but not checked (a ✗ line). A doctor check that only warns is drawn as a `!` line and does not count. It records the host file's path in `~/.agent-org/host-file`, so a shell with no `AGENT_ORG_HOST` finds it. It sets up the web terminal: it installs `bun` into `~/.bun/bin` when there is none (from bun's release zip, with no `unzip` and no `sudo`), installs the herdr plugin `devswha/herdr-web-ui` at its newest release tag (`herdr plugin install devswha/herdr-web-ui --ref <tag>`, never the default branch), and writes `tickets.terminal` when it is absent (`--no-terminal` skips this). On every machine from the first run, `--no-terminal` or not, it installs herdr's `claude` and `codex` integrations (`herdr integration install claude`, then `codex`): they are how herdr knows each agent's state and resumes its session, and the board reads agent status from herdr. It installs and enables the agent-org plugins it chose, as `agent-org plugin install` would: a `linear` tracker block and a `github` code host block always, so a fresh machine ends with both listed as installed and enabled by `agent-org plugin list` and on the Settings page, and a block for each optional concern whose choice is not `none`; it says one ✓ or ✗ line for each once that plugin's steps have run, in the setup words of its manifest's `agentOrg.setUp` (`Linear connected as the tracker`, `GitHub connected as the code host`, `Board served on this machine`; the internal sentence, `installed linear as the tracker`, shows with `--verbose`), and leaves a key the host file already holds as it is. With a readable key and no `linear` MCP yet, it registers Linear's MCP for Claude Code at user scope, authenticated by the key, and adds Linear's read and comment tools to `tickets.connectors`. It never prints the key. It installs the `github/gh-stack` extension, which a worker's `gh stack link` needs, for the workers' account (the host file's `gh.workers`) when it is not listed. A failure is a ✗ line with the fix beneath it, and does not fail onboard: `doctor` does. Onboard ends with `agent-org is set up on this machine.` and a `Next:` list (`agent-org ticket:pair`, `agent-org doctor`), or, when a step failed, with `agent-org is not fully set up: N steps above need fixing.` after each ✗ line and its fix; the exit status is the same either way. `--verbose` also shows every command, each service's line and `doctor`'s whole report. It then starts the instance, ui, terminal, auto-update and watchdog services, unless you pass `--no-start`. `--no-auto-update` leaves auto-update unregistered, and `--update-channel main` makes it follow `main`. A terminal or auto-update service that cannot start is reported and skipped. An instance or ui service that cannot start fails onboard. With the Tailscale exposure (`tickets.providers.exposure`), the ui and terminal services are also served on the tailnet, as `start` describes, and its onboard steps say when Tailscale is not on `PATH`, the operator command Tailscale needs, and any tailnet port that is taken. |

## One command, from a profile

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

**The host file without `AGENT_ORG_HOST`.** Every command finds the host file in this order: `$AGENT_ORG_HOST`, then the path in
`~/.agent-org/host-file` (which onboard writes), then the `AGENT_ORG_HOST` in the instance service's unit, then `~/.agent-org/host.json`.
A `ticket:*` command started with no `AGENT_ORG_HOST` gets that path. With no `GH_CONFIG_DIR`, it also gets the workers' `gh` account the host
file declares (`<gh.workers>/gh`). The instance, ui and auto-update units carry the same account. So `ssh <machine> agent-org ticket:remote-info`
and a `ticket:*` command from a plain shell read what the services read.

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
