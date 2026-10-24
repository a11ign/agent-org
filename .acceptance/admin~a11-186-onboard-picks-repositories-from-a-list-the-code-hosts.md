## What it is

At a terminal, `agent-org onboard` asked `Repository:` once per checkout path, so a person had to know every path, have cloned every repository and know the `name=path` form (A11-186, seen on the second laptop's first onboard). Onboard now lists the code host's checkouts in the folder it runs in, pre-ticked and named as the code host names them, and offers to add and clone more from the account's organisations and repositories.

## Change

- `src/plugins/contracts/code-host.ts`: contract 1.14, an OPTIONAL `repositories` group (`readOwners`, `readRepositories`, `repositoryOfRemote`, `cloneCommand`, `cloneRepository`), with its types.
- `plugins/github/repositories.ts` (new): the group over the plugin's own `gh` runner, as the person's own login; `plugins/github/code-host.ts` wires it.
- `src/plugins/fakes/code-host.ts` and `src/plugins/conformance/code-host.ts`: the fake's group (`seedOwners`, `seedRepositories`, `repositoriesWorld.cloned`) and two conformance checks that apply when the group is present.
- `src/install/prompts.ts` (new): the three-call seam (`pickMany`, `confirm`, `text`) over `@clack/prompts` 1.8.1.
- `src/install/onboard-repos.ts` (new): step 1 (the scan of the folder onboard runs in, one level down plus itself, main checkouts only, read from `.git/config`), step 2 (organisations, repositories, the clone folder and the clone offer) and the summary.
- `src/install/onboard.ts`: calls the picker where it asked for paths, in `profileFor` and `clonesOf`, only at a terminal with no `--repo` and a code host that has the group; a cancel refuses onboard.
- `README.md`, `plugins/README.md`, `package.json`, `pnpm-lock.yaml`, and the installed-layout test's offline override for the new dependency.

## Acceptance

Lint has no errors and typecheck passes. The named tests pass: `onboard-repos.test.ts` (a folder with three checkouts lists exactly those three, pre-ticked, by their code host names; no checkouts goes straight to the organisation list; the organisation and repository lists with the code host stubbed; pre-ticking from the host file; a found checkout against one cloned, with the command shown; the summary), `onboard.test.ts` (the picker at a terminal, the profile it writes, a cancel, and the non-TTY path unchanged with no prompt and no repositories call), `prompts.test.ts` (the real library driven by key bytes, and the whole flow's transcript), `plugins/github/repositories.test.ts` (each `gh` argv, the limit, every remote form and the clone), and the conformance suites over the fake and the GitHub plugin.

Acceptance:
```bash
bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/install/onboard-repos.test.ts src/install/onboard.test.ts src/install/prompts.test.ts plugins/github/repositories.test.ts plugins/github/conformance.test.ts plugins/github/index.test.ts src/plugins/fakes/code-host.test.ts src/plugins/built-in.test.ts src/packaging/gh-call-ratchet.test.ts src/packaging/installed-layout.test.ts'
```

Consumer-declaration: none -- the code host contract grows an OPTIONAL group only (1.14: `repositories`), so a 1.13 code host plugin still passes and onboard asks it for paths as before; no host file changes meaning. `plugins/github` declares contract 1.14. No other repository reads these modules as a library.
