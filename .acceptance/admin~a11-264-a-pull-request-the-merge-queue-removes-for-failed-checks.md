Closes A11-264

When the merge queue removes a pull request the board holds, the board answers it. A removal for `failed_checks` starts a fix round whose brief names the failing job and step and its error lines from the `merge_group` run and says the failure is on the merged result; a conflict removal starts a conflict round; any other reason is named on the card. The same pull request removed three times for failed checks with no push between is held from the arm bot with the label `hold:board` and the card says "removed from the merge queue 3 times: <job>"; the hold is lifted when the head changes. The code host contract is 1.21, with `PullFeedback.queue`, `readQueueFailure` and `holdFromQueue`, all optional.

Acceptance:
```bash
# A failed_checks removal starts a round with the merge_group run's errors; a repeat without a new push does not re-arm (the third removal holds the pull request and the card says so); the hold lifts when the head changes; a conflict removal starts a conflict round; another reason is named on the card. Over the recorded a11ign/announcement-emulator#18 run, jobs and log.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-merge-queue.test.ts
# The code host: the timeline of #18 (three removals since the last commit, each with its merge group), the failing job and step from the recorded jobs answer, and the label calls; the fake and GitHub both pass the contract suite.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/merge-queue.test.ts plugins/github/conformance.test.ts plugins/github/pull-feedback.test.ts src/plugins/fakes/code-host.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge: none. The first live `failed_checks` removal on a run the board holds shows its round on the card.
