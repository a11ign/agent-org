The `repeating-lines.allowlist.json` entry `^SHELVED row #N: ` now reads `^SHELVED row ([\\w./-]+)?#N: `, so `SHELVED row agent-org#460: blocked by #458 -- declared on the row, and it clears itself` (a keyed row, which `normaliseLine` turns into `agent-org#N`) is no longer offered to the `repeating-log-line` wake; the unkeyed spelling is still allowed and `SHELVED rows are all gone` (no `#N:`) is still offered.

Evidence (measured on this branch at agent-org `777c569` plus this change): `src/repeating-lines-keyed-shelved.test.ts` and `repeating-lines-primary-update-echo.test.ts` pass, 6 tests in 2 files. Mutation in both directions on the pattern, each breaking only the new file's two tests: reverted to `^SHELVED row #N: ` (never fires for a key) and widened to `^SHELVED` (always fires, so the no-`#N:` control is silenced). The allowlist was restored byte-identical (`diff` clean). The Acceptance below, run against this worktree's file, exits 0; against `origin/main` the row's Open-check printed `false true`.

Acceptance: `node -e "const a=JSON.parse(require('fs').readFileSync('src/repeating-lines.allowlist.json','utf8')).allow; const ok=(l)=>a.some((e)=>new RegExp(e.pattern).test(l)); const t='blocked by #N -- declared on the row, and it clears itself'; process.exit(ok('SHELVED row agent-org#N: '+t)&&ok('SHELVED row #N: '+t)&&!ok('SHELVED rows are all gone')?0:1)"`

Closes a11ign/a11ign#4617

platform: n/a (one allowlist pattern)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
