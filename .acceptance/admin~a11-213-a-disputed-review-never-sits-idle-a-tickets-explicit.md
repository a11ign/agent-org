A disputed review reaches a person. Three parts, each proven by a test that runs against this branch:

- **The reviewer yields to the ticket's explicit decision.** `decisionsOf` (`src/ticket-mode/ticket-decisions.ts`) reads a `## Decisions` / `## Behaviour` section and any line marked as the chairman's decision; `briefOf` puts it in the `ReviewBrief` (contract 1.4); the first review, the reprompt and the re-review of the atomic reviewer carry it with `DECISION_RULE` (it overrides a general direction; quote it, do not request changes for it), and `RATCHET_RULE` yields to it.
- **A disputed finding ends Needs you.** The approval round, the board's feedback round and the asked round tell the worker to reply quoting the ticket and end `needs-human` naming the pull request and the finding, and never to write `reviewed` while a disputed review still blocks the head.
- **A stale block is flagged.** The watch stamps `PullHead.blockedSince` from its own clock; a finished, unparked run whose open pull request has sat changes-requested at one head for more than 30 minutes gets a `handedBack` note, which reads Needs you and clears when the head moves, the block lifts or a round starts.

Acceptance:
```bash
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/ticket-decisions.test.ts plugins/atomic-reviewer/prompt.test.ts plugins/atomic-reviewer/port.test.ts src/ticket-mode/pool-reviewers.test.ts src/ticket-mode/review-round-dispute.test.ts src/ticket-mode/board-view/stale-block.test.ts
```

Consumer-declaration: none -- the new modules (`ticket-decisions.ts`, `board-view/stale-block.ts`) are read by `pool-reviewers.ts` and `pool-watch.ts`, which the board's server already runs.
