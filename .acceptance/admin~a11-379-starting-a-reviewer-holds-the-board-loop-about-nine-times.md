Step 2 of 2 of A11-379: the reviewer and code host contracts answer promises, and the atomic reviewer's port makes no synchronous spawn. Reviewer contract 2.0: `start`, `live`, `settled`, `close`, `retire`, `listedPulls`, `repostVerdict`, `reprompt` and `unblock` answer a promise (`verdictFileOf` reads files only and stays synchronous). Code host contract 3.0: `readReviewClaims` and `writeReviewClaim` answer a promise, run through `deps.execAsync`, and `claimHead` awaits them. The port runs `herdr` through `board.runAsync`, and its checkout, install, token mint, verdict door and Codex trust lookup through the async gate steps of step 1 (`execAsync`); a start in flight holds its seat. A test starts a reviewer through the real port against stub programs and asserts the blocking ledger counted no synchronous spawn (A11-379).

Acceptance:
```bash
# the port and the files it runs make no synchronous spawn: this prints nothing
git grep -nE 'execFileSync|spawnSync|execSync|deps\.exec\(' -- plugins/atomic-reviewer/port.ts plugins/atomic-reviewer/codex-trust.ts src/wake/reviewer-start-async.ts
# the real port against stub programs, with the blocking ledger installed; the contract suites; the claim protocol; the guards
npx rstest run --config scripts/rstest/rstest.config.ts plugins/atomic-reviewer/start-holds-no-loop.test.ts plugins/atomic-reviewer/port.test.ts plugins/atomic-reviewer/conformance.test.ts plugins/github/sync-gh-guard.test.ts plugins/github/conformance.test.ts src/ticket-port/review-claim.test.ts src/plugins/version.test.ts src/plugins/fakes/reviewer.test.ts src/ticket-mode/pool.test.ts
```

Consumer-declaration: the reviewer plugin's contract is 2.0 and the code host's is 3.0 (`plugins/atomic-reviewer/package.json`, `plugins/github/package.json`); a plugin of reviewer major 1 or code host major 2 is refused with `unreadMajorRefusal`. No host file key changes meaning.
