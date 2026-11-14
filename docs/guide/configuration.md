# Configuration

[Back to the README](../../README.md). Part of [ticket mode](ticket-mode.md).

**Configuration** is machine facts only, in the host file `$AGENT_ORG_HOST` names. Only `clones` is required, and it lists every repository
a worker can choose from:

```json
{ "clones": { "nbl-ui-netbox": "/path/to/nbl-ui-netbox", "platform-monorepo": "/path/to/platform-monorepo" },
  "tickets": { "max": 3 } }
```

| key | |
| --- | --- |
| [`tickets.providers`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.provider`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.enabled`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key.path`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.key.keychain`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.connectors`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.workingState`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.plannedState`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.tracker.takenStates`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.provider`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.enabled`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.mode`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.appId`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.keyPath`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.installationId`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.identity.<role>.slug`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.workers`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leads`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsHeader`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces[].id`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.gh.leadsWorkspaces[].role`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.codeHost.stack`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.provider`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.enabled`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.run`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.model`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.effort`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.publish.connectors`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.provider`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.enabled`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.reviewer.required`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.provider`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.enabled`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.port`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.uiPort`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.terminal`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts.ui`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.providers.exposure.tailnetPorts.terminal`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.max`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.port`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.uiPort`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.serve`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.servePorts`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.herdrSession`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.instance`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.worktreeRoot`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.linearKey`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.brief`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.review`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.plugins`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.deny`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.connectors`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.terminal`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.plan`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.planner`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.publish`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.writer`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.preflight`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.drafts`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.prReview`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.reviewer`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.pick`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.stallMinutes`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.ciBudgetMinutes`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.updateMaxDeferHours`](../../src/ticket-mode/config-schema.ts) | |
| [`tickets.workingState`](../../src/ticket-mode/config-schema.ts) | |
| [`stateDir`](../../src/ticket-mode/config-schema.ts) | |

**Turning a setting on safely**

- [`tickets.drafts`](../../src/ticket-mode/config-schema.ts): Canary: set it on one machine first. Its new runs show Awaiting review with no Approve, and their pull requests on GitHub are not drafts (`gh pr view <url> --json isDraft` gives `false`). Revert: remove the line, or set it `true`. Runs already opened ready are not changed back: they stay Awaiting review, and are reviewed and merged on GitHub, since the board offers no Approve for them.
- [`tickets.prReview`](../../src/ticket-mode/config-schema.ts): Canary: set it on one machine, then check that a new run's folder holds `pr-review.json` and that its pull request's body has the `Pre-PR review:` line. Revert: remove the line. Runs already started keep the gate they were given.
- [`tickets.reviewer`](../../src/ticket-mode/config-schema.ts): Canary: one `reviewer-<n>` workspace per ready head in the `tickets` session, not one per watch; a reviewer's workspace closes within one watch of its verdict, and a merged or closed pull request's workspace and `~/reviews/<seat>` checkout are gone within one sweep (every 3 minutes), a line naming any uncommitted changes discarded with the checkout; a `no reviewer for <url>` line in the board's log names a refusal; each ready pull request has one review from `a11ign-reviewer` on its head, and a `changes requested` review answered with no new commit asks for one more review of that head: a reply (from the board's own account or a person the org declares) posted after the review, or an edit of the pull request description since the reviewer last looked at the head (the reviewer is told the changed lines and the replies, and still reviews the whole diff). Each such re-review needs something new since the last, waits for the end of the run's round, and counts as one of the run's `MAX_FEEDBACK_ROUNDS` rounds: with none left the run is handed to a person and no reviewer starts. The board words it as `re-review asked by reply at <head>`, for either answer. **A re-review that stays not convinced at an unchanged head is a stand-off, and it is never lost (A11-290).** The verdict door refuses a second review at an equal patch (exit 3) and keeps a copy of the verdict file it refused beside it (`refused-<file>`); once the re-review's reviewer has ended, the board logs `rereview: still not convinced` with the reasons on the run, comments the result on the pull request (`rereview: still not convinced at <head>`, a comment of the board's own account that answers nothing), and routes the stand-off once for each head: to the planner first when the worker's reply disputes a decision of the plan or the ticket (it quotes a line of the decisions, or has a line that starts `Disputes a decision:` or `Plan cannot be met:`) or when the ticket's Decisions changed and summoned the re-review that stayed not convinced (a reviewer that denies a Decision it was given; the planner is shown the changed Decision at once, and may not change it), then to the worker. The planner's round (a review round that starts as the planner, with the review, the reply and the re-review) writes `standoff-decision.json`: it amends the decision in the plan, records it under "Decisions made without a person" and the board attaches the amended plan, after which the reviewer re-reviews the same head bound by the amendment (`rereview.planDecisions`, reviewer contract 1.10); or it upholds the decision. The worker's round carries the re-reviewer's reasons and must change the code, or the measurement or the evidence in the pull request description: the Stop hook refuses a `reviewed` that leaves every pull request at the same head with the same description, unless the worker stops on an item of the escalation list. Neither round counts toward `MAX_FEEDBACK_ROUNDS`. The A11-213 flag (a pull request changes requested for more than 30 minutes with no push and no run) waits for both routes, and then says what the reviewer and the worker last said and what the planner decided. `/api/interventions` (the health number, A11-257) also carries `standoffs` for each of the last seven days: the stand-offs settled with no person (a new head or an approval after one). They are in no total, since they are no intervention, and the pool bar says them after today's number. Revert: remove the line. Reviewers already running finish, and the sweep closes their workspaces and removes their checkouts once their pull requests have merged or closed.
- [`tickets.pick`](../../src/ticket-mode/config-schema.ts): Canary: the Pick view's count reads `assigned to you` by default and `open in team <key>` or `open in project <name>` with a team or a project, and the Anyone chip reads as that count. Revert: remove the line.
- [`tickets.stallMinutes`](../../src/ticket-mode/config-schema.ts): Canary: a `<key> has been idle for <n> minutes or more since it wrote working` line in the board's log, once per stall. Revert: remove the line.
- [`tickets.ciBudgetMinutes`](../../src/ticket-mode/config-schema.ts): Canary: set it low (`20`) on one machine, push a ticket's branch with a macOS job, and see its run's card read `CI: 1 push, 1 job, ~10 min` and, past the budget, `· over budget (20)`; the worker's pane gets the one `CI budget:` line, and at twice the budget the log says `Held: CI ~<n> min, over twice this ticket's budget of 20` and the run starts its next round a pass later. Revert: remove the line, or set it to `0`, which keeps the figures and stops the warning and the hold.

The Linear key is a personal API key, so ticket mode reads as you and needs no workspace admin. On macOS, store it once with
`security add-generic-password -a "$USER" -s agent-org-linear -w`, which prompts for it without echoing it.
