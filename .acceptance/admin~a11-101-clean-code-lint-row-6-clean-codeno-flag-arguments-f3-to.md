## What it is

`clean-code/no-flag-arguments` (Clean Code F3) flagged 86 production parameters on `main` (`23e90a7a`): a boolean that selects between two behaviours, or carries a fact the function reads. A `warn` does not fail the lint, so a new hit could land unseen. This change resolves every production hit and raises the rule to `error`. Test files are off for the rule, because a test helper's boolean is the fixture's variant.

## Change

- `eslint.config.ts`: `clean-code/no-flag-arguments` is `"error"` on its line in `recommended`, with a comment. A new block turns it off for `**/*.test.ts`, with the reason.
- Mode switches are split into named functions, with the shared body in a private helper: `pinDaemon` (switch) and `pinDaemonReading` (read); `blastRadiusVerdict` and `sweepVerdict`; `requirePublishedSummary` and `readSummary`; `reachableScope` and `entryScope`; `fenceEndAfter` and `blockEndAfter`; `removeContained` and `removeDoomedContained`; `formatReport`, `formatDryRunReport` and `formatAppliedReport` in `prune-tmp.ts` and `prune-worktrees.ts`; `setPaused` as `pauseQueue` and `resumeQueue`; `holdReadMemo` and `releaseReadMemo`; `pacingNow` and `unpacedNow`; `driftReport` and `hostUnitsNotChecked`; `openPullRequestStep` as its draft and ready variants; `requiredLabels` as its option and plain variants; `specBlockRefusal`, whose flag is now checked by its caller.
- Facts become named properties of an argument object, for example `primaryUnread(pacing, { primaryRead })`, `dollars(value, { floor })`, `ledgerLine(at, key, recipient, { noClear })`, and the `…FlagOn({ asked }, read)` readers.
- Four production hits keep an `eslint-disable-next-line` with its reason: `ordersWithin`, `rankOf` and `orderFor` in `src/work-gate/shared-file-orders.ts` (the `recheck` flag changes the ranking, the hold release and the DIRTY order together), and `rewriteOnce` in `src/trace/store.ts` (a dry run and a rewrite share the whole scan).
- Callers and tests are updated where a signature changed. No behaviour changes.

## Acceptance

Lint exits 0, the rule reports 0 hits, its config is `error` for production and `off` for test files, typecheck passes, and the test files this change touches pass against a fixture host declaration.

Acceptance:
```bash
set -e
npm run lint
npm run typecheck
npx eslint src scripts -f json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const n=r.flatMap((f)=>f.messages).filter((m)=>m.ruleId==="clean-code/no-flag-arguments").length;if(n!==0){console.error(n+" no-flag-arguments hits");process.exit(1)}'
npx eslint --print-config src/wake.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));if(c.rules["clean-code/no-flag-arguments"][0]!==2)process.exit(1)'
npx eslint --print-config src/wake.test.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));if(c.rules["clean-code/no-flag-arguments"][0]!==0)process.exit(1)'
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts $(git diff --name-only origin/main -- '*.test.ts')
```
