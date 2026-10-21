## What it is

Two instances on one project (the agents host and a laptop) both sweep every open pull request and each starts a reviewer on each new green head, so one head gets two reviews. Before a reviewer starts, the instance now claims the head on GitHub: a commit status `agent-org/review` on the head, whose description names the instance and the time. An instance that finds another's live claim starts nothing. A claim older than the lease (60 minutes) with no verdict is taken over, and the board says so. The verdict door sets the claim to the verdict when the review posts. `ticket:review` honours the same claim. The stacked retarget sweep is idempotent and is tested for it.

## Change

- `src/ticket-port/review-claim.ts`: the claim protocol, `claimHead`, pure over an injected `read` and `write`, and the `gh` calls behind them (`claimEntriesOf`, `writeClaimStatus`). A release (`released by <claimant>`) cancels that claimant's most recent standing claim, so a head whose reviewer could not start is free at once.
- `src/lib/tool-version-agreement.ts`: `ghWith(env)` runs `gh` with an environment laid over this process's, and `defaultGh` is `ghWith()`. The one counted `gh` spawn stays one, so the gh-call ratchet is unchanged.
- `src/ticket-mode/settings.ts`: the install id (`instanceIdOf`, kept in the state directory) and the claimant, `<tickets.instance>.<id>`, so two installs with one host name are two claimants.
- `src/ticket-mode/reviewer-port.ts`: `startReviewer` claims the head after the seat's checkout is prepared and before the spawn; the reviewer is spawned with `AGENT_ORG_INSTANCE`, and so is the door's repost. `atomicReviewerPort` takes the instance's name.
- `src/ticket-mode/pool-reviewers.ts`, `board-view/pull-review-state.ts`: a takeover is logged and shown as `reviewing (took over the claim of ...)`.
- `src/ticket-mode/review-command.ts`, `pool-context.ts`: pass the instance's name; `ticket:review` prints the holder's name when it refuses.
- `src/ticket-mode/settings.ts`, `config-schema.ts`: `tickets.instance`, default the machine's host name, at most 40 characters of letters, digits, `.`, `_`, `-`.
- `src/reviewer/pr-review-verdict.sh`: `finish_claim` sets the claim to `<verdict> by <instance> at <time>` after the post; best effort, never fails the post.
- `README.md`: the key row and a paragraph on the claim and the lease.

## Acceptance

Two pools against one fake pull request start one reviewer; the second says which instance holds the head. A claim taken over at the lease is said on the board. The claim protocol's cases, the reviewer port's refusals, the door's claim write and the retarget sweep's idempotence are each a named test.

Acceptance:
```bash
A11Y_PRIVATE_TMP_BASE=/tmp/ao-private-tmp npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-port/review-claim.test.ts src/ticket-mode/review-claim-two-pools.test.ts src/ticket-mode/reviewer-port.test.ts src/ticket-mode/review-command.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/board-view.test.ts src/ticket-port/stack-retarget.test.ts src/packaging/door-finalises-review-claim.test.ts
```

## After merge (chairman's session)

This is not a merge condition. The corrected done-when, set by the chairman in Linear, is met before merge by the two-pools test, the claim and lease tests, and every Acceptance line mapped to a named test. The live check below needs two live instances on the released version, and the laptop has no instance until A11-145 merges, so the chairman runs it with the chairman's session after merge, once the laptop runs its own instance.

The live check of the done-when, "with the agents host and the laptop both running, a new pull request gets exactly one review", needs two running instances on two hosts and a live reviewer on GitHub, so no pull request's checks can run it. Each step is a command; the pass is stated after them.

1. Copy the agents host's `host.json` to `/tmp/a11-149-live/host.json` and change four keys in the copy: `tickets.instance` to `live-check`, `tickets.port` and `tickets.uiPort` to free ports, `stateDir` to `/tmp/a11-149-live/state`, and `tickets.herdrSession` to `a11-149-live`.
2. Start the second instance against the copy: `AGENT_ORG_HOST=/tmp/a11-149-live/host.json agent-org ticket:serve` (in its own terminal, or as a unit).
3. Open a test pull request in a scratch repository that both instances clone, with a change that has green checks.
4. When its checks are green, count the claims on its head and the reviews on it:
   `gh api repos/<repo>/commits/<sha>/statuses --jq '[.[]|select(.context=="agent-org/review")]|length'`
   `gh api repos/<repo>/pulls/<n>/reviews --jq '[.[]|select(.user.login=="a11ign-reviewer")]|length'`
5. Read both instances' logs for `started reviewer-` and `holds the review of`.

**Pass:** the first count is 1 (the claim) or 2 (the claim and the finished entry); the second is 1; exactly one instance's log says `started reviewer-`, and the other's says it `holds the review of` that head.

**Cleanup:** stop the second instance, close the test pull request, delete its branch, and remove `/tmp/a11-149-live`.

Mutation: the protocol's "held" branch was made to return "won" for every instance (5 tests red); the door's claim write was removed (3 door tests red); the port's claim step was bypassed (2 two-pool tests red); the release calls after a refused start were removed (1 two-pool test red). Each was restored and the files compared byte for byte before the suite ran again.

Consumer-declaration: none -- `atomicReviewerPort` and `tickets.instance` are read only inside this repository: the port's callers (`pool-context.ts`, `review-command.ts`) and every test that builds one pass the instance, and `parseTicketSettings` is the only reader of the setting. No other repository reads either.
