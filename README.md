# agent-org

An AI agent organisation as a tool: rows, claims, the board, the merge queue and the wake gate, run against the repository it is installed in.

## Install

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

`gh` calls are made by three roles: the **scheduler** (the gate, the tick and the `host:*` scripts: a process outside any agent workspace), the **workers** (engineer sessions) and the
**managers** (the standing leads). `host.json`'s `github.identity` sets, per role, how that role authenticates:

```json
{
  "github": {
    "identity": {
      "scheduler": { "mode": "github-apps", "appId": 1234567, "keyPath": "/home/agent/.config/agent-org/apps/scheduler.pem" },
      "workers": { "mode": "user-accounts" }
    }
  }
}
```

| mode | what the role calls as | what it needs |
|---|---|---|
| `user-accounts` (the default, and what a role left out gets) | the personal account whose `gh` config directory the host already routes the role to | nothing; a host with no `github` key behaves exactly as before |
| `github-apps` | `<app>[bot]`, with a one-hour installation token minted from the app's private key and cached | `appId` and an absolute `keyPath` (a mode-600 `.pem`); `installationId` only when the app is installed in more than one place |

The roles are chosen one at a time, so a host can move the scheduler first and leave the rest (`scheduler` is the role whose shared pool starved: the gate hit GitHub's secondary
limit as the workers' account). A role that is not one of the three, a `github-apps` role without `appId` and `keyPath`, and a `user-accounts` role that names an app are refused by
field name when `host.json` is read. A role outside any agent workspace is the scheduler; `AGENT_ORG_GH_ROLE=scheduler|workers|managers` states the role when that guess is wrong.

How it behaves:

- **A separate pool per role.** Each app's installation token spends the app's own rate limit, not the personal account's.
- **Minted on demand, refreshed before it expires.** The token is cached under the host's state directory (`app-tokens/<role>.token`, mode 600) and replaced when less than
  five minutes of it is left, so a call is not handed a token that dies under it. Reading the cache starts no process.
- **A failed mint falls back to today's account**, so the call still goes through, and records one ledger line with resource `incident` naming the stage that failed (`key`,
  `installation` or `token`). The role is not asked again for a minute.
- **An explicit `GH_TOKEN` or `GITHUB_TOKEN` wins**: a CI runner or a person who named a credential is not re-routed.

The trade-offs, which are why this is an option and not the default:

- **Authorship changes to `<app>[bot]`**, in commits' pushes, comments, reviews and PRs; whatever matches on the old login (rulesets' bypass lists, CODEOWNERS, `a11ign-bot`
  rules) must be told the app, and an app's approval counts toward a required review only where the ruleset allows it. Verify this per role before moving it.
- **An installation token cannot answer `viewer`** (the GraphQL query for "who am I") and only reaches repositories the app is installed on and the permissions it was granted.
- **The key is a standing secret** on the host; a leaked token is good for an hour, a leaked key until the app's key is revoked.
- **The minter needs `node` and the network**; with neither the role runs on its personal account and the incident says so.

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
