The 110 `.mjs` under `src/` are `.ts`, `tsx` is out of `dependencies`, `engines.node` is `>=24`, and every `ExecStart` and package script runs `node file.ts` with no loader. The six units (kernel-reboot, otel-receiver, shadow-window, tmp-prune, trace-publish, work-tick) name `%h/.local/bin/node`, and the work-tick preload is `src/lib/crash-exit.ts`.

Trap (a) of ADR 0043, measured on Node 24.21.0: a `.ts` under `node_modules` is refused with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The ONE shipped mechanism is that the tool runs from a checkout outside `node_modules` (`host/agent-org` execs `node "<tool>/src/bin.ts"`), with no loader and no built `dist/`.

Evidence: the full suite is 7583 tests with 33 failing, and all 33 fail the same way on origin/main 07d6a94 (`board-truth-audit` 2, `auto-arm-token` 2, `milestone-clock` 11, `pr-template-acceptance` 1, `public-claim` 2, `row-file` 8, `row-file-refuses-duplicate-title` 1, `tick-heartbeat-is-written` 5, `wake-engineer-brief` 1). `no-loader.test.ts` turns red for each of four mutations (tsx back in `dependencies`, `--import tsx` in a unit, `/usr/bin/node` in a unit, `engines.node` `>=22`), and `mjs-ratchet.test.ts` turns red for a new tracked `.mjs` and for a baseline entry removed; every restore was byte-identical (`diff`) and both guards pass again.

Acceptance: `bash -c 'test "$(git ls-files src | grep -cE "[.](mjs|js|cjs)$")" = 0 && ! git grep -qE -- "--import[= ]tsx" -- host package.json && node -e "process.exit(\"tsx\" in (require(\"./package.json\").dependencies || {}) ? 1 : 0)" && npx tsc --noEmit && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/mjs-ratchet.test.ts'`

Closes a11ign/a11ign#4389

platform: n/a (a rename of the tool's own sources plus its units; nothing it renders for a project changes)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
