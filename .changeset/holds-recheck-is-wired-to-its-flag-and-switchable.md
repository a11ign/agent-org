---
"@a11ign/agent-org": patch
---

`holds.recheck` (agent-org#1165) is wired to its flag and has its switch (agent-org#1187). It shipped OFF with nothing able to turn it on: `perPullRequestOrders` called `sharedFileOrders(prs)` with no option, and the flag was in no registry, so `machinery:flag on holds.recheck` was refused and the org-health digest listed it as `flag-without-a-switch`. `decide` now reads the flag from the canary state (`recheckFlagOn`, absent or unreadable is OFF) and passes `{ nowMs, recheck }` to `perPullRequestOrders`, which passes `recheck` to `sharedFileOrders`; a caller that passes a bare clock, as every caller did, gets today's ordering byte for byte. `holds.recheck` is in `FLAG_REGISTRY` and in `FLAGS_WITH_ANOTHER_HOME`, so `agent-org machinery:flag on holds.recheck --session=<you>` is the switch and the digest no longer counts it.
