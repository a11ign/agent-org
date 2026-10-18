## What it is

`clean-code/no-commented-out-code` (C5) reports 10 warnings on `main`. All 10 are prose: file headers, a section note, and two short remarks. None is commented-out code. The rule fires on them because the plugin's heuristic reads two or more `//` lines ending in `;` next to a parenthesis as code. This change clears all 10 by changing the punctuation of those lines, reworks two short remarks that parsed as expressions, and raises the rule to `error`, so a commented-out block now fails `npm run lint`.

## Change

- `eslint.config.ts`: `"clean-code/no-commented-out-code"` goes from `"warn"` to `"error"`. No other line changes.
- Eight prose blocks: the trailing `;` of the listed comment lines becomes `,`, or `:` where the next line continues the sentence. No word changes.
  - `src/gh-conditional.test.ts` lines 5, 6; `src/gh-manager-list-reads.test.ts` lines 8, 10; `src/messaging/providers/telegram/poll.test.ts` lines 9, 10; `src/messaging/providers/telegram/poll.ts` lines 8, 10; `src/messaging/reply-cli.ts` lines 1, 23; `src/messaging/reply.ts` lines 8, 9; `src/messaging/selftest.ts` lines 17, 18, 19; `src/work-gate/causes/rows-offer.ts` lines 109, 110.
- `src/messaging/core.test.ts` line 319: `// failed, sent, deferred` becomes `// one failed, one sent, one deferred`. The three outcomes are unchanged, in the same order.
- `src/trace/growth.test.ts` line 143: `// 100 + 50 + 250 + 10` becomes `// the sum of 100, 50, 250 and 10`. The sum is unchanged.

Only comment text changes in the source files. The diff holds no code change in `src/` or `scripts/`.

## Acceptance

`npm run lint` exits 0 with 0 errors and no `no-commented-out-code` line (10 before). `npm run typecheck` passes. The five touched test files, and the two suites that read the touched sources as text (`reply-cli.test.ts` scans `reply-cli.ts`, and `selftest.test.ts` reads `selftest.ts` with its comment lines filtered out), pass against a fixture host declaration: 222 tests in 7 files.

Acceptance: `bash -c 'set -e; npm run lint; npm run typecheck; P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture; AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/gh-conditional.test.ts src/gh-manager-list-reads.test.ts src/messaging/core.test.ts src/messaging/providers/telegram/poll.test.ts src/trace/growth.test.ts src/messaging/reply-cli.test.ts src/messaging/selftest.test.ts'`
