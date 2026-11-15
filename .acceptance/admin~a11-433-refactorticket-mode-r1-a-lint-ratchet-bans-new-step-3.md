## What it is

`src/ticket-mode/pool-resume.ts` no longer makes a synchronous call (A11-433, step 3 of 5), and it leaves `blocking-calls.baseline.json`. Before, when the board refused a plan's `## After-merge checks` section, `sendBack` (`pool-plan-send-back.ts`) prompted the planner's pane through `sendToAgent`. That function ran the synchronous `ctx.herdr`, and also `readAgents` when the run had no pane on record, so the board thread was held for as long as herdr took. Now `sendBack` is async and prompts through `sendToAgentAsync` (over `ctx.herdrCall`). `pool-settle.ts` awaits it inside the run's `ctx.attaching` hold, so no pass settles the same `planned` outcome again while herdr answers. The synchronous `agentTarget` and `sendToAgent` are removed: nothing else called them.

The step's named file, `plugins/github/gh.ts`, makes no synchronous call: it was converted before step 1, and the baseline never listed it. So this step converts the next file whose call holds the board loop.

## Acceptance

- `pool-resume.ts` is no longer in the baseline, so the real ESLint config refuses a synchronous call there. `src/packaging/blocking-calls-ratchet.test.ts` still passes: the baseline only shrank.
- `src/ticket-mode/board-thread-sync-guard.test.ts` no longer allows the two `pool-resume.ts` calls.
- `src/ticket-mode/pool-plan-send-back.test.ts`, test "A11-433: the send-back prompt goes over the async herdr…", checks the following:
  - the prompt is asked over the async herdr (the synchronous one refuses every prompt);
  - three passes while herdr has not answered send no second prompt and count no send;
  - the send is counted once herdr answers, and the stale outcome is not sent back again.
- Test "A11-433: a run stopped while herdr answers the send-back is left as it is" checks that a run that stops being the queue's while the prompt is in flight has no send counted (`sameRun`).
- The existing A11-288 send-back tests pass unchanged.

Acceptance:
```bash
bash -c 'set -euo pipefail
npm run typecheck
npx eslint src/ticket-mode/pool-resume.ts src/ticket-mode/pool-plan-send-back.ts src/ticket-mode/pool-settle.ts --quiet
! grep -n "pool-resume" blocking-calls.baseline.json
! grep -nE "ctx\.herdr\(|\breadAgents\(" src/ticket-mode/pool-resume.ts
AGENT_ORG_HOST= npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/blocking-calls-ratchet.test.ts src/ticket-mode/board-thread-sync-guard.test.ts'
```

`pool-plan-send-back.test.ts` and `pool-resume.test.ts` need the CI fixture project (`AGENT_ORG_HOST`), so CI's `suite` job runs them.

Mutations:
- Restore `origin/main`'s `pool-resume.ts`. `npx eslint src/ticket-mode/pool-resume.ts` then fails with the A11-433 ban at the `readAgents` import and the `ctx.herdr` calls.
- Restore `origin/main`'s `pool-plan-send-back.ts` and `pool-settle.ts`. The new test then fails: "the prompt is asked over the async herdr" (0 !== 1).
- Drop the `await` before `sendBack` in `pool-settle.ts`. The new test then fails: "the passes meanwhile send no second prompt" (4 !== 1), because `attaching` is let go before herdr answers.
- Delete the `sameRun` line in `sendToPlanner`. The stop test then fails: "no send is counted for a run that is no longer the queue's".

Consumer-declaration: none. `agentTarget` and `sendToAgent` were used only inside this repository, and no published surface changes.
