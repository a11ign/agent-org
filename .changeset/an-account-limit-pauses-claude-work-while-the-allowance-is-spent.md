---
"@a11ign/agent-org": minor
---

A new flag, `gate.accountLimitPause` (default off; `machinery:flag on gate.accountLimitPause` turns it on), pauses the account's Claude work while a Claude session shows its allowance message (agent-org#1307). The pause is recorded per account (the home directory the seats share) in `account-limit.json` until the reset it names; a record that cannot be read holds the pause until it is repaired, and a flag whose state cannot be read is not taken as off. While it holds, no row is claimed for a Claude spawn, no Claude worker, manager or `claude -p` decision run starts, and no prompt goes to a Claude seat. Codex reviewers, review orders, the merge queue, CI reruns and the sweeps carry on, and a claimed row keeps its claim. Entering and leaving the pause are each said once. Revert: switch the flag off.
