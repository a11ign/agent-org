## What it is

The GitHub plugin reads each repository's open pull requests ONCE per sweep, in one GraphQL query (`plugins/github/pull-snapshot.ts`), and every reader in the plugin (`reviews.ts`, `pull-feedback.ts`, `replies.ts`, `open-pulls.ts`, `dependency-pulls.ts`, `merged-findings.ts`, `closed-work.ts`, `stack-retarget.ts`) reads that snapshot instead of calling `gh` for each pull request. The REST reads that repeat are conditional (`conditional-reads.ts`). Every `gh` the plugin starts is counted (`call-counter.ts`), logged per sweep and per minute, and served as `githubCalls` on `/api/health`.

## Change

- `plugins/github/pull-snapshot.ts` (new): the snapshot, its pages, its failure memory, the read by number of a pull request that is not open.
- `plugins/github/call-counter.ts`, `plugins/github/conditional-reads.ts` (new).
- The readers above take `PullSnapshots`; `code-host.ts` makes the snapshots, drops them on every write, keeps the account's login, and counts.
- Code host contract 1.29: `readCallCounts` and `refreshPull`, optional. `src/ticket-mode/health-route.ts` and the board thread carry `githubCalls` to `/api/health`.
- `pool-prepare.ts` and `pool-decisions-change.ts` refresh before writing a head the Stop hook compares later.

## Acceptance

- `pull-snapshot.test.ts` "with 10 open pull requests across 3 repositories, a sweep of every reader makes 3 GitHub calls": proves the batching.
- `no-per-pull-reads.test.ts`: no module under `plugins/github/` outside the snapshot reads a pull request by itself.
- `call-counter.test.ts`, `conditional-reads.test.ts`, `health-route.test.ts`, `board-thread.test.ts`: the counts, the ETag, `/api/health`.

Acceptance:
```bash
bash -c 'set -e; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts plugins/github/pull-snapshot.test.ts plugins/github/no-per-pull-reads.test.ts plugins/github/call-counter.test.ts plugins/github/conditional-reads.test.ts plugins/github/code-host.test.ts plugins/github/conformance.test.ts src/ticket-mode/health-route.test.ts src/ticket-mode/board-thread.test.ts'
```

Consumer-declaration: the code host contract is 1.29 (`readCallCounts`, `refreshPull`, both optional): a plugin of 1.28 is read as one that counts none and holds nothing back.
