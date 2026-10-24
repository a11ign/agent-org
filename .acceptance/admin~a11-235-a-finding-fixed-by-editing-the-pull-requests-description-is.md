## What it is

A finding the reviewer blocked on, answered with no new commit, is re-reviewed on the same head (A11-235). The board records a LOOK for each start of the reviewer (the time and the pull request body it saw, in the reviewer memory file), and a blocked head is re-reviewed when its body now differs from the last look's, or a trusted reply was posted after both the block and the last look. The brief gives the reviewer the description's changed lines and the replies, and the prompt tells it to review the whole diff again. For a pull request a run holds, a re-review waits for the end of the run's round and counts as one of the run's rounds; with none left the run is handed to a person and no reviewer starts. The GitHub plugin matches the workers' App by its REST spelling `a11ign-workers[bot]` and its GraphQL spelling `a11ign-workers`, which is why a reply never reached the reviewer on agent-org#1865. The reviewer contract is 1.5.

## What it checks

`plugins/github/replies.test.ts` reads a reply by the Bot `a11ign-workers` for the named `a11ign-workers[bot]`, and not a person with the bare name or another app. `plugins/atomic-reviewer/prompt.test.ts` holds the re-review prompt for a description edit alone, for an edit with a reply, and for a reply alone, each with the whole-diff sentence. `src/ticket-mode/review-command.test.ts` holds the look a `ticket:review` start records.

Not in the block below, because they need a host declaration (`AGENT_ORG_HOST`) as CI's `suite` job sets it: `plugins/atomic-reviewer/port.test.ts` (the brief's changed lines reach the prompt), `src/ticket-mode/reviewer-port.test.ts` (the looks round-trip, including a file from before them), `src/ticket-mode/pool-rereview.test.ts` (a body-only fix starts a re-review on the same head; a reply with no change and no body edit does not loop; the cap holds, with the run handed back; a run mid-round waits; a refused start is asked again; the look survives a restart) and the A11-156 cases in `src/ticket-mode/pool.test.ts`. Run them as CI does, with the fixture project copied out, committed and named by `AGENT_ORG_HOST`.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/replies.test.ts plugins/atomic-reviewer/prompt.test.ts src/ticket-mode/review-command.test.ts
```

Consumer-declaration: none -- no option of a project declaration is added; `ReviewBrief.rereview.body` is an optional field of reviewer contract 1.5, and the reviewer memory file gains an optional `looks` key that a file written before it reads as none.
