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
