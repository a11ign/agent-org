`DEPENDENCY_BOT_LOGIN`, the pattern for the login a dependency bot opens a pull request as, moves from `src/work-gate/pr-orders.ts` to a new leaf module `src/dependency-bot-login.ts` that imports nothing, so the hand-fix ledger can share it without naming the work gate (a11ign/agent-org#705). No behaviour moves.

Closes a11ign/agent-org#705

## What changes, and why

- **`src/dependency-bot-login.ts` (new).** `DEPENDENCY_BOT_LOGIN` and its #4624 comment, moved verbatim, under a short module header saying why it is a leaf. No import line.
- **`src/work-gate/pr-orders.ts`.** The definition is deleted. `import { DEPENDENCY_BOT_LOGIN }` (the one `isDependencyBotPr` reads) and `export { DEPENDENCY_BOT_LOGIN } from` the leaf sit beside the other imports, so `import { DEPENDENCY_BOT_LOGIN } from "../work-gate/pr-orders.ts"` is unchanged for every reader.
- **Not here:** the ledger's use of it is a11ign/agent-org#560, blocked by this row.

## How you verified it

Run from this worktree (the row's `cd /home/agent/repos/agent-org` is the primary checkout, which holds the old definition, so it would not read this diff). `node_modules` is a symlink to the primary checkout's, and `AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json` was set.

- The row's Acceptance: the five tests of `src/packaging/pr-owner-dependency-bot.test.ts` pass, unchanged, and the `node -e` check exits 0.
- `npx rstest run --config scripts/rstest/rstest.config.ts src/work-gate src/packaging src/work-gate.test.ts`: 33 of 5352 tests fail in 12 files, and the **same 12 files fail on `origin/main` (ed9fb407)** run the same way in a clean worktree, so none is this change's.
- `npx tsc --noEmit -p tsconfig.json`: only the two `src/packaging/mjs-ratchet.test.ts` errors (`@a11ign/toolchain/mjs-ratchet` is not resolvable here), which are not in a file this change touches.

## Acceptance

```bash
node --import tsx --test src/packaging/pr-owner-dependency-bot.test.ts
node -e "const s=require('node:fs').readFileSync('src/dependency-bot-login.ts','utf8'); const o=require('node:fs').readFileSync('src/work-gate/pr-orders.ts','utf8'); if(/^\s*import\b/m.test(s)||!/export const DEPENDENCY_BOT_LOGIN/.test(s)||/export const DEPENDENCY_BOT_LOGIN/.test(o)) process.exit(1)"
```

Mutation: the leaf gains an import line -> the `node -e` exits 1; `pr-orders.ts` defines `export const DEPENDENCY_BOT_LOGIN` again -> exits 1; the leaf is emptied (no export) -> exits 1. Each file was restored from a copy and compared byte-identical.

## Anything a reviewer should be sceptical of

- **`.agent-org/roles/engineer.md` is not in this repository's tree**; I read the newest copy in a sibling checkout (`wt-4850`).
- **The check cannot see a transitive cycle.** It proves the leaf has no import line, which is the row's definition of a leaf; the leaf has nothing to import, so there is none to be transitive.
- **The row's one line is two lines.** `pr:open`'s parser refuses `&&` on a line that runs a test file ("the arguments to `tsx --test` are not this command's argv"), so the row's `cd ... && test && node -e` is the test and the `node -e` on separate lines of one block, the `node -e` byte-identical to the row's. The `cd /home/agent/repos/agent-org` is dropped: that is the primary checkout, which still holds the old definition.

platform: n/a (a module move; nothing GitHub, pnpm, systemd or git does)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
