## What it is

A11-345 starts a run that crashed on a transient `fetch failed` again twice, and the third crash ended it for good. On 10-28 A11-231 used its retries inside the outage and stayed crashed after the network came back, which held A11-232 behind it for two days, with a card that read as an ordinary partial-merge wait.

`finishCrashed` now marks a run whose transient crash found the retries used up (`crashRetry.recovery`, with the earliest restart after a 10 min, 30 min, then 2 h back-off). `recoverCrashed`, run each pass after `retryCrashed`, queues it again once the board's call ledger shows a good Linear or GitHub call after the crash and neither service's latest call failed, at most 3 times in a rolling 24 h. A crash for any other reason carries no mark and is never restarted. The blocked ticket's card reads "Waits on A11-231, which crashed", and the crashed run's card names the tickets waiting on it and what the board does next.

## Acceptance

- A11-231 reproduced: three transient crashes (ECONNRESET, UND_ERR_SOCKET, ECONNRESET), the ledger records good calls, the run starts again and its log says `requeued` / `network-recovered` (`pool-crash-recovery.test.ts`).
- Back-off, evidence and the daily bound: no restart before the back-off, none while the latest call failed or before a call succeeded after the crash, the fourth restart within 24 h refused and allowed once the oldest ages out (same file).
- Any other crash is not restarted (same file), and A11-345's own cases are unchanged (`pool-crash-retry.test.ts`).
- The cards say it (`board-view/crashed-blockers.test.ts`, `ui/src/runs/runs-model.test.ts`).

Acceptance:
```bash
set -e
npm run typecheck
P=$(mktemp -d); cp -r src/packaging/fixtures/project-tree/. "$P"; sed -i "s|@@PROJECT@@|$P|" "$P/.agent-org/host.json"; git -C "$P" init -q; git -C "$P" add -A; git -C "$P" -c user.name=ci -c user.email=ci@localhost commit -q -m fixture
AGENT_ORG_HOST="$P/.agent-org/host.json" npm exec -- rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/pool-crash-recovery.test.ts src/ticket-mode/pool-crash-retry.test.ts src/ticket-mode/call-outcomes.test.ts src/ticket-mode/board-view/crashed-blockers.test.ts
```
