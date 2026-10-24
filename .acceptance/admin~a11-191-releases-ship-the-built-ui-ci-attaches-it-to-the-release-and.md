## What it is

A release now carries the board UI's build, and `install.sh` and `agent-org update` fetch it before a version becomes current (A11-191, part of A11-187). CI builds the UI into each release, so no machine runs the UI's toolchain.

## Change

- `release.yml`: `ui-build` (reads, runs the repository's code) finds the tag the push released, builds `ui/` at it and packs `agent-org-ui-<tag>.tar.gz` and its `.sha256` with `scripts/ui-asset.ts`; `ui-attach` (writes, runs none of the repository's code) adds both to the GitHub Release, the tarball first, never replacing one. `ci.yml`'s `ui` job runs the same install, build and pack on every pull request (dry run, tag `dry-run`, no upload) and archives the two files as `agent-org-ui-dry-run`.
- `package.json` says `agentOrg.shipsUiBuild`. A release without it installs as before, with no network call.
- `install.sh` (a `Downloaded its UI build` step; `curl` and `gzip` in preflight) and `agent-org update` (`src/install/ui-asset.ts`, called from `buildVersion`) download the asset and its checksum from the release, verify it, and unpack it into `versions/<tag>/ui-build/` before `current` moves. A mismatch, or a build not attached yet, fails the install or refuses the move and leaves `current` where it was.
- The update that finds nothing newer completes the current folder's missing build.
- `doctor` has a `ui build` row that warns when the running version's release ships a build and none is found.

## Acceptance

The tests run `install.sh` and `buildVersion`/`update` against a stand-in for GitHub (a static server on 127.0.0.1) with the build present, absent and with a bad checksum; run `scripts/ui-asset.ts` against git and tar fixtures; and hold `release.yml`'s two jobs and the pull request's dry run to the same commands.

Acceptance:
```bash
set -e
npm run typecheck
npm run lint
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/packaging/ui-asset.test.ts src/packaging/release-triggers-itself.test.ts src/packaging/release-tag-on-merge.test.ts src/release-consumer-check.test.ts src/install/ui-asset.test.ts src/install/install-sh.test.ts src/install/update.test.ts src/install/doctor.test.ts src/install/onboard.test.ts
```

After merge (the chairman session): the next release has `agent-org-ui-<tag>.tar.gz` and its `.sha256` (`gh release view <tag> --repo a11ign/agent-org --json assets --jq '.assets[].name'`), and on the agents host, at least ten minutes after that release became current, `ls ~/.agent-org/tool/current/ui-build/index.html && agent-org doctor | grep 'ui build'` shows the file and an `ok` row; `/next/` then answers 200.

Consumer-declaration: none -- no existing host file or project changes meaning. A release that does not declare a UI build installs exactly as before.
