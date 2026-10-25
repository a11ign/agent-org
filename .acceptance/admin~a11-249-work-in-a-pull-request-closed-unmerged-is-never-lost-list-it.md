Closes A11-249

Step 2 of 2: the ticket's next run is briefed with the work a closed pull request held, its plan must say for each commit and file **carried over** (where) or **dropped** (why), and the reviewer checks that account. Step 1 (the board lists the work, keeps the branch and posts the list on the ticket) is on main. A record of a pull request that held nothing asks for no account. The reviewer contract is 1.9 with one optional field, `ReviewBrief.closedWork`.

Acceptance:
```bash
# The next plan without an account is refused; one that accounts for every commit and file (through a directory bullet too) is attached; a record of kind none asks for none; the planner's and the worker's briefs name the record's list file.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/closed-work-account.test.ts
# The reviewer is handed the list (briefOf) and its first-review prompt carries it with the rule that a missing item is a finding.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-reviewers.test.ts plugins/atomic-reviewer/prompt.test.ts plugins/atomic-reviewer/index.test.ts
# Step 1's tests still pass: closing an unmerged pull request with unique commits records the list and keeps the branch; one with nothing unique records no unique work.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-closed-work.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge, the chairman session checks that the next pull request closed unmerged has its work listed on its ticket by the board, and that the follow-up's plan and pull request body account for it under `## Work from closed pull requests`.
