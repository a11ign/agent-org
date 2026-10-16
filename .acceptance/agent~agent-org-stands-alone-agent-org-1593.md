The row's Acceptance command, run as written from the worktree: no file under `.github`, `renovate.json` or `src` names `PROJECT_REF`. It exits 0 here and 1 on `origin/main`.

Acceptance:
```bash
node -e 'const r=require("child_process").spawnSync("git",["grep","-l","-F","PROJECT_REF","--",".github","renovate.json","src"],{encoding:"utf8"});process.exit(r.stdout.trim()?1:0)'
```

Mutation: `# PROJECT_REF` appended to `.github/workflows/ci.yml` -> the command exits 1 (restored byte-identical, `diff` empty, and it exits 0 again).

Measured, on this branch on top of `agent-org` `main` `ff498ea4`:
- `node_modules/.bin/tsc --noEmit -p tsconfig.json` exits 0.
- The whole suite, one `rstest run --config scripts/rstest/rstest.config.ts`, in an empty environment (`env -i`: no herdr, gh or ssh variables, a scratch `HOME`), with `AGENT_ORG_HOST` naming a copy of `src/packaging/fixtures/project-tree/` that was `git init`ed and committed (the `suite` job's step): `Test Files 3 failed | 725 passed | 2 skipped (730)`, `Tests 13 failed | 11853 passed | 231 skipped (12097)`. The three files are `installed-layout` (9), `release-dry-run` (3) and `wake-order-shape` (1). The first two died on a missing corepack cache in the scratch `HOME`, and `wake-order-shape` on the 757-byte order (bound 700), which carries the fixture's path (the scratch path is far longer than CI's `$RUNNER_TEMP/project`).
- Those three files again, with the fixture at `/tmp/ao1593-project` and the real `HOME` (still no herdr, gh or ssh variables): `Test Files 3 passed`, `Tests 47 passed`. So the suite is green on the fixture with no a11ign checkout in this measurement; the CI run is done-when 1's own proof and is linked from the PR when it has run.
- Before the change (the row's first measurement, with the then-unfixed fixture), the same run was `41 failed | 689 passed`; #1650 to #1653 took it to the figure above.

Not covered, named:
- The `suite` job's YAML was parsed (`yaml.parse`) but not run on a GitHub runner here. That run is the PR's CI.
- `wake.test.ts` and `wake-reviewer-instance.test.ts` print "herdr's panes could not be read" in the empty environment and passed there; neither was run with a herdr session, which I do not touch.
- agent-org#1654 removes the dead `waiting-on-pin-bump` class, `waitsOnPinBump` and the route, `org-retro.ts`'s pin-bump measure and `outside-nightly.yml:14`; they are outside this Region.

Closes: a11ign/agent-org#1593
