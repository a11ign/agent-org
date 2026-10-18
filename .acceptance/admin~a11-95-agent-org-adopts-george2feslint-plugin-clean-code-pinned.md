## What it is

agent-org had no code linter, only `tsc`, so Clean Code was checked only by a model's judgement and the reviewer. This change pins `eslint`, `typescript-eslint`, `@george2f/eslint-plugin-clean-code` 0.4.1 and `jiti` (the loader ESLint needs for a TypeScript config) at exact versions, and turns every `recommended` rule on as a warning, with the two rules that have no hits at `error`.

## Change

- `eslint.config.ts`: the `recommended` rules, one per line, all `warn` except `no-skipped-tests` and `no-todo-tests`. `npm run lint` runs ESLint over `src/` and `scripts/`.
- CI: a `lint` job installs from the lockfile with `--frozen-lockfile --ignore-scripts` and runs `npm run lint`. `gate` needs it and reads its result.
- Workers: `AGENTS.md` names the commands. The worker brief asks for lint beside the install, test and typecheck, and a fix is re-linted before it is pushed.
- Dependabot: an npm entry for the three packages, with a 7-day cooldown.
- Stale `eslint-disable` lines (13 `no-explicit-any` in test files, 2 `local/bounded-window-reads`, 2 unused `no-control-regex`) are removed, and their reasons are kept as plain comments.

Refs A11-95

Flag: none. Lint is a new job and a new script; no runtime code path changes, and the comment and directive edits change no behaviour.
Health-signals: none
Revert: revert this PR. The lint job, the gate entry, the brief wording and the pinned devDependencies go with it; the stale directives return.

Acceptance:
```bash
npm run lint
npm run typecheck
npx rstest run --config scripts/rstest/rstest.config.ts src/ci-lint-job.test.ts src/ci-changeset-on-push.test.ts src/ticket-mode/worker-files.test.ts src/packaging/mjs-ratchet.test.ts
```

Mutation: `src/ci-lint-job.test.ts` runs each structural check on a copy with its target broken (the lint job's `if:`, `--frozen-lockfile`, `--ignore-scripts`, the `npm run lint` step, the pnpm version; gate's `needs`, its read of the lint result; a range in package.json, a changed lint script, a drifted lockfile version), and each mutation turns the test red. `src/ci-changeset-on-push.test.ts` runs gate's script with `lint` failing, skipped or cancelled, on every event.
