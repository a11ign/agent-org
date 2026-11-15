# Install

[Back to the README](../../README.md). [docs/installing-and-updating.md](../installing-and-updating.md) is the longer account of installing and updating.

Install the newest release with one command. It uses no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
```

**Prerequisites:**

- git;
- tar and gzip;
- curl, which downloads the board UI's build from the release (see below);
- Node 24 or newer;
- one way to run pnpm 10.34.5: the corepack beside `node`, a `corepack` on `PATH`, or else `npm exec`, which every npm has. You never need a global pnpm;
- herdr 0.9.3, which runs every worker's terminal. You do not install it yourself: `agent-org onboard` installs the version each release pins when it is missing (by hand: herdr's install page, https://herdr.dev/docs/install/, or the command `agent-org doctor` prints). The installer only says so when herdr is missing, and still installs agent-org.

The installer checks all of these before it changes anything, and lists every one that is missing with the command that fixes it for your platform (Homebrew, nvm, fnm, or a download from nodejs.org). It prints a header, one line per step, then whether agent-org is installed and the next commands. When its output is not a terminal, the last line is `agent-org install OK: ...` or `agent-org install FAILED: ...`, and a failure says what was changed (usually nothing). `--verbose` also shows where it keeps the mirror, the version folders and the `current` link.

**Homebrew note:** Homebrew's `node` formula, like every Node from 25 on, ships no corepack. The installer then runs pnpm through `npm exec`, and says so on the dependencies line. `brew install corepack` (or `npm install -g corepack`) adds corepack if you want it. Reinstalling Node is not a fix for this.

The installer keeps a bare mirror of the repository in `~/.agent-org/tool/repo.git` (`$AGENT_ORG_HOME/tool` when that is set), builds the newest release tag
into a folder of its own, `tool/versions/<tag>`, with the release's dependencies, points `tool/current` at it, and writes the `agent-org` launcher into
`~/.local/bin`, which runs through `current`. It changes nothing else. When `~/.local/bin` is not on your `PATH`, it prints the line to add. Add
`-s -- --version vX.Y.Z` after `bash` to install one release. Running it again builds the newest release beside the others and moves `current`. An earlier
install's checkout, `~/.agent-org/agent-org`, is left as it is, and `agent-org update` moves its services onto `current`.

**A release that ships the board UI's build** (its `package.json` says `"agentOrg": { "shipsUiBuild": true }`, as every release from A11-191 on does) is given it as one more step, `Downloaded its UI build`: the installer downloads `agent-org-ui-<tag>.tar.gz` and its `.sha256` from the release on GitHub (or from `$AGENT_ORG_RELEASES_URL` when that is set, which is where the tests point it), checks the one against the other, and unpacks it into `tool/versions/<tag>/ui-build/` before `current` moves. A checksum that does not match, or a release whose build CI has not attached yet (it is attached a few minutes after the tag), fails the install and leaves `current` where it was; the message says which, and running it again later is the fix. A release before the marker installs as it always did, with no download. `--verbose` adds the address and the verified checksum. `agent-org update` follows the same rule: it fetches and verifies the build before it moves `current`, refuses the move (and tries again on its next run) when it cannot, and, when it finds nothing newer, gives the folder `current` names its build if its release ships one and the folder has none.

## As a project's dependency

`agent-org` is published to no registry. A project takes it as a git dependency pinned to a release tag, with `typescript` beside it:

```bash
pnpm add -D typescript "github:a11ign/agent-org#semver:^0.1.0"
pnpm exec agent-org <command> [args]
```

`agent-org` with no command, or a name that is not a command, refuses and lists the commands. There is no default command. A command is the
name a project's `package.json` script used (`row-file`, `pr:open`, `board:settle`), and `src/commands.ts` is the table.

## What an install holds

`src/` (the programs and their data, without `*.test.*`), `host/` (the unit templates `host:install` reads), `LICENSE`, `README.md`, `docs/guide/` (the pages the README links to) and
`package.json`. The tests are not shipped: they read the project's tree and run in this repository's CI. A version folder installed from a release that ships the board UI's
build also holds `ui-build/` (A11-191): the static files CI built and attached to the release, which `ticket:ui` serves at `/`. It lives inside the version folder, so a run
that started on a version keeps that version's UI, and a prune removes it with the folder.

`typescript` is a peer dependency, resolved from the project's directory first and the tool's own tree second, so the tool parses the project's code
with the project's compiler. Tested on Node 24.21.0.
