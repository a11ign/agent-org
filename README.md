# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

`agent-org` is published to no registry. A project takes it as a git dependency pinned to a release tag, with `typescript` beside it:

```bash
pnpm add -D typescript "github:a11ign/agent-org#semver:^0.1.0"
pnpm exec agent-org <command> [args]
```

`agent-org` with no command, or a name that is not a command, refuses and lists the commands. There is no default command. A command is the
name a project's `package.json` script used (`row-file`, `pr:open`, `board:settle`), and `src/commands.mjs` is the table.

## The project is the repository you run it in

The tool reads `.agent-org/project.json` of the project it serves, and never answers with another project's values. Which project that is:

| layout | `$AGENT_ORG_HOST` unset | `$AGENT_ORG_HOST` set |
|---|---|---|
| installed (`node_modules/agent-org`) | the git repository the command is run in; REFUSED naming `.agent-org/project.json` and the directory looked in if it holds none | the host file's primary project |
| monorepo (`packages/agent-org/src`) | the repository root | the host file's primary project |
| the tool's own checkout | REFUSED naming `AGENT_ORG_HOST` | the host file's primary project |

## What an install holds

`src/` (the programs and their data, without `*.test.*`), `host/` (the unit templates `host:install` reads), `LICENSE`, `README.md` and
`package.json`. The tests are not shipped: they read the project's tree and run in this repository's CI.

`typescript` is a peer dependency, resolved from the project's directory first and the tool's own tree second, so the tool parses the project's code
with the project's compiler. Tested on Node 22.22.1.

## Releases

**A tag is the release.** `v<version>` on this repository, with a GitHub Release carrying the `CHANGELOG.md` entry, and nothing is published to a registry. **A tag is
never moved or deleted once a project can have pinned it**: a moved tag changes what a pinned project gets, so a mistake is fixed by the next version.

Cutting one:

1. In a pull request, run `pnpm run changeset add` for the change and, when releasing, `pnpm run changeset version`. That bumps `package.json` and writes the
   `CHANGELOG.md` entry; nobody writes either by hand. Merge it, and wait for `gate` on `main`.
2. Dispatch **release** (Actions, or `gh workflow run release.yml`) on `main`. It defaults to a **dry run** that checks everything and says which tag it would cut.
3. To cut it, dispatch with `dry-run` false and `confirm` set to `publish-for-real`. The workflow refuses if `gate` has not succeeded on that sha, if the tag exists,
   or if `CHANGELOG.md` has no entry for the version. It holds `contents: write` and nothing else.

A project bumps its pin by editing the range in its `package.json` (`github:a11ign/agent-org#semver:^0.1.0`) in an ordinary dependency pull request and reading the
changelog it links. While the version is `0.x`, `^0.1.0` takes patches only, so a `minor` is the bump a project opts into.
