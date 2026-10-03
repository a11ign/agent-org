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

## Cutting the version

Nobody does. On a push to `main` that leaves a changeset pending, `release.yml` opens or updates the one version pull request, running `pnpm run changeset version`
(it bumps `package.json`, writes `CHANGELOG.md` and deletes the consumed entries). Merging that pull request cuts the tag and the Release; it is the only thing that
does. Run the command yourself only to see what it would write.
