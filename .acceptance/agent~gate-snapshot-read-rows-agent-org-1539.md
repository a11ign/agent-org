`gate-snapshot-read rows` prints number and title only. `rows --json` now prints ONE JSON object, `{ source, readAt, ageMs, rows }`, where each row carries its number, title, labels and body as stored. A row the store has no body for prints `"body": null`, never `""`; a row with no stored label list prints `"labels": null`. `ageMs` is the time since the gate's read and is never negative, as the text header's is. The text output is unchanged. `prs --json` and `board --json` are refused with the usage line and exit 2.

Acceptance: `cd ~/repos/agent-org && node --test src/gate-snapshot-read.test.ts`

Mutation: `body` made `""` instead of `null` failed the body control; `labels` made `[]` instead of `null` failed the label control; the `--json` branch made never to run failed the command control (the text printed where JSON was asked); the `prs`/`board` refusal removed failed the refusal control. Each mutation was made on a copy saved before the edit and restored byte-identical (`diff` against that copy).

Measured: `node --test src/gate-snapshot-read.test.ts` in the worktree prints 9 pass, 0 fail (the five existing controls and four new ones). `pnpm run typecheck` exits 0. `pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/gate-snapshot-read.test.ts` passes 9 of 9. The full `pnpm test` fails 113 tests in 26 files; none of the 26 imports `gate-snapshot-read` or `commands.ts`, and the only other importer (`gh-manager-list-reads.test.ts`) passes 10 of 10.

Closes a11ign/agent-org#1539

platform: Node's own `JSON.stringify` and the `node:test` runner the file already uses; no library added.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
