Refs A11-277

Step 1 of 3 (agent-org): the owner of an After-merge line is read, each line becomes a check of its own, and a runner closes it with one line of evidence. `ownerOf` (`src/ticket-mode/done-when.ts`) reads the prefix form (`Chairman session: …`, `The chairman: …`, `On the agents host: …`, `The release manager: …`), then the subject form (`The chairman's session moves …`, `The chairman chooses …`), then A11-173's trailing clause, each of at most 6 words and 40 characters. `src/ticket-mode/after-merge/` holds the records (`checks.ts`, pure), their file (`store.ts`, `<stateDir>/tickets/after-merge-checks.json`), the sweep that seeds them from the runs and posts each close on its ticket once (`sweep.ts`, the last call but one of `refreshTracker`), and the close and follow-up routes (`route.ts`). `GET /api/queue` lists the open checks as `afterMergeChecks`; the Runs page's After-merge list shows each row's runner and age, closes it Passed, Failed or Superseded from a one-line field, and offers a failed check's pre-filled follow-up through the New ticket dialog.

Acceptance:

```bash
# done-when.test.ts: every owner form, a 7-word trailing clause and other non-owners, and the 33 lines on the board on 2026-10-25 each reading an owner (31 "Chairman session")
# after-merge/checks.test.ts: the runner of each owner, seeding once, a close by a person, a repeat close refused, the evidence limits, the follow-up text, the post claim, the prune, the age
# after-merge/sweep.test.ts: the 33 lines seeded on the first sweep, a dismissed run keeping its checks, a close posted once and retried after a failed post, two sweeps at once posting once
# after-merge/route.test.ts: through createBoard's api, passed, failed and superseded each with evidence, the row leaving GET /api/queue, a second close answered 409, bad evidence refused
# board-view.test.ts: the list is the open checks and the failed ones with no follow-up, oldest first
# ui: after-merge-list.test.tsx (the age and runner, the three closes, a refused close keeping the row, Failed: follow-up?, the pre-filled New ticket dialog) and runs-parity.test.tsx
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
npm run typecheck
pnpm ui:typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/done-when.test.ts src/ticket-mode/after-merge/checks.test.ts src/ticket-mode/after-merge/sweep.test.ts src/ticket-mode/after-merge/route.test.ts src/ticket-mode/board-view.test.ts
pnpm --dir ui exec rstest run --config rstest.config.ts src/runs/after-merge-list.test.tsx src/runs/runs-parity.test.tsx src/new-ticket/'
```

Steps 2 and 3 (the plan's `## After-merge checks` section and the board's own observations; the session's queue and the overdue resend) follow once A11-275 has merged.
