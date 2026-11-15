# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

Install the newest release with one command. It uses no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
```

Then `agent-org onboard` sets the machine up. Each task has a short page of its own:

| page | what it covers |
|---|---|
| [Install](docs/guide/install.md) | the installer's prerequisites and what it changes, taking agent-org as a project's dependency, and what an install holds |
| [Onboard](docs/guide/onboard.md) | `agent-org onboard`, profiles, the host file, which project the tool serves, and which GitHub account each role calls as |
| [Services](docs/guide/services.md) | `start`, `stop`, `status` and `update`, auto-update, breaking releases, and restarts that leave the workers alone |
| [Ticket mode](docs/guide/ticket-mode.md) | the local board: picking, planning, the runs, review rounds, publishing, stacking |
| [Configuration](docs/guide/configuration.md) | the host file's keys, and turning a setting on safely |
| [Plugins](docs/guide/plugins.md) | the agent-org plugins behind each external concern, and `agent-org plugin` |
| [Other machines](docs/guide/other-machines.md) | showing another machine's instance on this board, over SSH or https |
| [Troubleshooting](docs/guide/troubleshooting.md) | `agent-org doctor`, the watchdog and the board's health |
| [Working on agent-org](docs/guide/development.md) | the TypeScript source and the board UI package (`ui/`) |

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
