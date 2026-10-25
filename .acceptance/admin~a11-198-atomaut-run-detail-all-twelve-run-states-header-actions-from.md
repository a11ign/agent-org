## What it is

Step 1 of 2 of A11-198, the Atomaut Run detail page, in `ui/src/run-detail/`: `/next/runs/<key>` is the twelve Run detail boards (running, loading, run gone, queued, blocked on an overlap, needs you, handed back, draft awaiting approval, ready to merge, completed, failed, cancelled) over the queue the shell already polls every 5s. `RunsApp` draws it in the shell in place of the placeholder. One component draws every state: `boardOf` picks the board a run's shown status maps to (Talking, Planning and Reviewing use the running board, Publishing and Published the Ready board, Checked the Done board; Needs you is Needs while the run is live and Handed back once it has finished). The header buttons are exactly the verbs `runActions()` returns, in its order, with the board's words and the backend's tooltips. The callout says the backend's strings (`reasonOf`, `waitNote`, `promptNote`, `workingNote`, `completedLine`). "What it will do" draws `plannedSteps` and `currentStep` and the Worker row draws `worker`, all from A11-219 step 1. Talk to it is one button per run: the `talk` verb when `runActions()` offers it, else the terminal link, and herdr failing to open is said in the red banner in each of four cases. The Timeline section is step 2: it needs A11-219 step 2 (`Queue.runLog`, `runTimeline`), which is not on the branch this is stacked on.

## Acceptance

`run-detail-model.test.ts` holds `boardOf` over every status of `RUN_STATUSES`, the callout's body per board, the header's verbs against `runActions`, the steps' marks, the pull request states and the properties. `run-detail-states.test.tsx` draws each of the twelve boards from the stand-in queue and checks its breadcrumb, h1, status line, callout, header buttons and sections. `run-detail-actions.test.tsx` covers a press (post, read again, the refusal in the banner), one Talk to it per run, the four ways herdr fails to open, and the 5s poll moving a step, turning a running run into a failed one and into "run gone". `run-detail-lifecycle.test.tsx` covers a failed queue read. `run-detail.page.test.ts` drives Chromium over the real build under `PAGE_CSP`: each of the twelve states at 1440px and 390px with no horizontal overflow (captures in `ui/captures/run-detail/`), and a long unbroken title, callout, step, repository, worker, pull request name and refusal at 390px.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/captures/run-detail/run-detail-running-1440x900.png ui/captures/run-detail/run-detail-loading-390x844.png ui/captures/run-detail/run-detail-missing-1440x900.png ui/captures/run-detail/run-detail-cancelled-390x844.png'
```

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
