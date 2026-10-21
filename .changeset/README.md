# Changesets

A release of agent-org is a git tag `v<version>` and a GitHub Release, cut by `.github/workflows/release.yml` when the version pull request merges; **nothing is published
to a registry**, so `access` above is `restricted` only because changesets requires a value. How a release is cut is in the
README's `Releases` section.

## Adding one

```bash
pnpm run changeset add
```

It writes a markdown file here. Commit it with your change. **Write the entry for a project that pins a tag, not for us:** it goes
into `CHANGELOG.md` and the Release verbatim.

## Choosing the bump level

`patch` for a fix a pinned project takes without reading anything, `minor` for a command, flag or behaviour that is new,
`major` for one a project must change something to keep using. The range a project pins is `#semver:^0.1.0`, which a `0.x` bump of
`minor` leaves behind, so while the version is `0.x` a `minor` is the breaking level.

## Marking a release breaking

A release that a running install must DRAIN for starts its changeset's summary with `Breaking: ` (its first line, exactly that, for example
`Breaking: the instance's queue file moves; a run started before it cannot be resumed`). Changesets writes the line into the tagged `CHANGELOG.md` as
`- <sha>: Breaking: ...` under the release's `## x.y.z` heading, and `agent-org update` reads it from the target tag for every release between the installed one and the
target. A host with runs live does not swap onto a breaking release: it builds the folder, starts no new run, lets the live runs finish, and after
`tickets.updateMaxDeferHours` stops and re-queues the rest and applies the update. Any other release applies at once, with runs live. The bump level is not the marker:
the version is 0.x, where `minor` is already the level a pinned project reads, so a `major` never comes and a `minor` says nothing about draining. Use the marker only when a run started on
the previous release may not survive on this one.

## Cutting the version

Nobody does. On a push to `main` that leaves a changeset pending, `release.yml` opens or updates the one version pull request, running `pnpm run changeset version`
(it bumps `package.json`, writes `CHANGELOG.md` and deletes the consumed entries). Merging that pull request cuts the tag and the Release; it is the only thing that
does. Run the command yourself only to see what it would write.
