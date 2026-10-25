Refs A11-249

Partial: step 1 of 2. When a pull request the board holds is closed without merging, the board lists the work it still held against its base (the commits not on the base, and the files they change, from the code host's compare), keeps the branch, and posts the list on the ticket as "Closed pull request #N: work not on <base>" with the branch and every commit's full SHA. A pull request whose commits are all on its base is recorded as "no unique work". The code host contract is 1.20 with one optional read, `readClosedWork(url)`. Step 2 (the next run is briefed with the list, the plan check refuses a plan with no account, and the reviewer checks it) is not in this pull request.

Acceptance:
```bash
# Closing an unmerged pull request with unique commits records the list, posts it with the branch and both SHAs, and keeps the branch; one with nothing unique records "no unique work"; a read that cannot be made writes nothing; a refused comment is posted again with no second record.
npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-closed-work.test.ts
# The code host read: GitHub's compare against the head SHA (paged, file cap said), and the fake and GitHub both pass the contract suite.
npx rstest run --config scripts/rstest/rstest.config.ts plugins/github/closed-work.test.ts plugins/github/conformance.test.ts src/plugins/fakes/code-host.test.ts
```
Run with `AGENT_ORG_HOST` naming a host declaration, as CI's `suite` job does (the fixture project copied to a temporary directory).

After merge, the chairman session checks the next pull request closed unmerged has its work listed on its ticket by the board: a comment titled "Closed pull request #N: work not on <base>" and the files under `<stateDir>/tickets/<key>/closed-pulls/`.
