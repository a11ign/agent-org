Step 1 of 2 (merged): every herdr agent name is made by one function, `herdrAgentName` (`src/herdr-agents.ts`): a name herdr accepts comes back unchanged, and a longer one is shortened to 32 characters or fewer with 8 hex characters of a hash of the full name, so `reviewer-announcement-emulator-11` is started and prompted as one agent while its workspace keeps the full label.

Step 2 of 2: a reviewer start that herdr refuses is counted per pull request head in the reviewer memory (`reviewers.json`), keeping herdr's reason and not the changing note about the workspace it closed. The pull request's own line says `not reviewed: <herdr's reason>` from the first refusal. The second refusal in a row for the same reason makes the run that holds the pull request Needs you, and its card says `<pull request>: <herdr's reason>`. A different reason, a start that works, a new head, or a pull request no longer open takes it off. `agent-org doctor` has a `reviewer starts` row that fails with each pull request, its head, how many times, and herdr's reason. The board still tries again on every sweep (A11-241).

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/herdr-agent-name.test.ts src/herdr-agent-call-sites.test.ts plugins/atomic-reviewer/long-seat-name.test.ts src/ticket-mode/reviewer-start-refusal.test.ts src/ticket-mode/reviewer-port.test.ts src/install/doctor.test.ts
```

After merge (the chairman session, for the ticket's Done-when): the first pull request numbered 10 or above in announcement-emulator gets its review. A pass is both of these:
```bash
herdr --session tickets workspace list | grep reviewer-announcement-emulator-11   # the workspace is listed under its full label
gh pr view 11 --repo a11ign/announcement-emulator --json reviews --jq '[.reviews[] | select(.author.login == "a11ign-reviewer")] | length'   # 1 or more
```
If the reviewer still does not start, the run holding the pull request reads Needs you after the second refusal with herdr's reason on its card, and `agent-org doctor` fails `reviewer starts` with the same reason.
