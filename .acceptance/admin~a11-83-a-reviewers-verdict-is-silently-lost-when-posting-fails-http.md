## What it is

A ticket-mode reviewer's verdict was lost silently when posting it failed. On 2026-10-17 `reviewer-agent-org-1738` finished its review (not convinced, two findings), and the verdict door could not post it: the reviewer App token had never been minted (HTTP 401). The reviewer ended its turn "done" with the verdict only in `verdict-1738.md`, the pull request showed no review, and the worker got no round.

## Change

Three places, in the order the failure travels.

- **The door retries a failed mint once.** `pr-review-verdict` posts; when the post is refused for its token (the host `gh` wrapper's `gh: refused: the reviewer call is NOT sent as the account` line) or rejected with HTTP 401, it clears the failed-mint memo and posts once more. A second failure exits `6` and prints `pr-review-verdict: NOT POSTED.` with the cause. Any other failure is not retried.
- **The pool checks that a reviewer's review is on its pull request.** After a reviewer for a head has ended (idle, done, or no agent) with no review at that head, the pool posts its verdict file through the door again, with the reviewer's token minted first (`ensureReviewerToken`). A reviewer that ended with no verdict file is prompted once. Each head has at most three attempts (`MAX_REPOST_ATTEMPTS`), remembered in `reviewers.json`, so a restart does not reset them. A door refusal that a repost would only repeat (exits 2, 3 and 5) is final at once.
- **What is still not posted is said on the run.** The run's queue entry carries `verdictNotPosted` (`verdict not posted: <reason>`), a log line says it once, and the board shows it on the run. The field clears once a review at that head is on the pull request.

## Verified

- `door-retries-a-failed-mint.test.ts`: a refused post and a 401 are each posted once more; two failures exit 6 with the cause; the memo is gone for the retry; a failure that is neither is not retried (the control).
- `reviewer-port.test.ts`: the verdict file is found by what it says, for its head, newest first; a repost mints first and gives the door the word the file opens with; a mint that fails stops before the door; each door exit is final or not; a reviewer's state reads working, ended, or gone; a reprompt names the head; the memory keeps re-post counts and reads an older file.
- `pool.test.ts`: a verdict file written and not posted is re-posted once; a refusal then a posting leaves one posting and forgets the count; three refusals surface `verdict not posted: <reason>`, and a restart does not post again; a final refusal is said at once; no file prompts once and then says so; a working reviewer, a review at the head, and a moved head trigger nothing; a review the reviewer posted and a person dismissed is not re-posted over the dismissal.
- `queue.test.ts`: the field is recorded on a finished run and cleared, and a queued run takes none.

Refs A11-83

Flag: none. The door's retry runs only for a mint refusal and a 401, and the pool's repost runs only for a reviewer that has ended with no review at its head.
Revert: revert this PR; the door posts once and the pool stops checking, as before.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-83/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/packaging/door-retries-a-failed-mint.test.ts src/packaging/door-refuses-second-review.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/pool.test.ts src/ticket-mode/queue.test.ts src/ticket-mode/board-view.test.ts'`
