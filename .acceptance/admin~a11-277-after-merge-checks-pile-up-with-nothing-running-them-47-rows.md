Refs A11-277

Step 2 of 3 (agent-org): the plan names who runs each After-merge check, the planner is refused a plan that leaves an owner-less After-merge line unnamed, and the board closes the checks it can observe by itself. `src/ticket-mode/after-merge/plan-section.ts` reads a plan's `## After-merge checks` section (each line quoted, with `Runner:`, `Escalation:`, `Observe:` and `Evidence:`) and checks it against the ticket's After-merge lines and A11-275's moved ones; `planFiles` (`pool-settle.ts`) refuses a plan it finds wanting, and both planner briefs carry the rule (`worker-files.ts`). The sweep (`after-merge/sweep.ts`) reads the section from the attached plan when it copies a line, so the record takes the plan's runner, escalation item, watch and evidence, and `after-merge/observe.ts` passes a `board` check by itself on a dependency-sweep ticket, a review on a named pull request, a merge with no person, or a board wake. Step 1's records, routes and list are unchanged.

Acceptance:

```bash
# after-merge/plan-section.test.ts: the section read with each field; an owner-less After-merge line with no section refused, naming it; an unknown runner, an off-list escalation id, a missing or unknown observe spec, a quoted line that is not an After-merge line, and missing, multi-line or over-long evidence refused; A11-275's moved lines accepted; the board refusing to attach such a plan through the pool, and attaching one that names its runner
# after-merge/observe.test.ts: each of the four specs passes its check with its evidence, and each has cases that do not (a ticket filed already, a merge on a run a person answered, a wake from before the board watched, a late wake, another wait kind)
# after-merge/sweep.test.ts: a planned line's runner, escalation, watch and evidence reach its record; an unreadable section seeds the line as its owner says; the board closes a review check by itself and posts it once; a sweep-ticket check records its baseline and passes on the next ticket filed
# after-merge/checks.test.ts: seeding with a plan, a moved line matched by its Before-merge words, the last bullet deciding
# worker-files.test.ts: both planner briefs carry the rule, the worker's brief does not
bash -c 'set -euo pipefail
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/after-merge/ src/ticket-mode/worker-files.test.ts src/ticket-mode/done-when.test.ts src/ticket-mode/after-merge-move.test.ts src/ticket-mode/pool-after-merge-move.test.ts src/ticket-mode/plan-ticket-decisions.test.ts src/ticket-mode/wait-on/wait-read.test.ts'
```

Step 3 (each check sent to its runner through A11-275's session asks, person checks on the escalation list under Needs you, and the 7-day overdue resend) follows.
