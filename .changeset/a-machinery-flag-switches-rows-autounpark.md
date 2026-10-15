---
"@a11ign/agent-org": patch
---

`rows.autoUnpark` is a machinery flag: `agent-org machinery:flag on|off rows.autoUnpark --session=<you>` switches it, and `machinery:flag list` shows it. It was refused as "not a flag any module reads", so the flag ledger counted it as unset for ever. The flag now sits in the registry, and the ledger records that `machinery:flag` is its home, so it is no longer reported unset (a11ign/agent-org#1161).
