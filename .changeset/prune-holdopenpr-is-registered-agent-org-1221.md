---
"@a11ign/agent-org": patch
---

`prune.holdOpenPr` (agent-org#1167) is registered as a machinery flag, so `agent-org machinery:flag on prune.holdOpenPr --session=<you>` can switch it (agent-org#1221). It shipped OFF with nothing able to turn it on: the flag was read from the canary state but was in no registry, so the command refused it and the org-health digest listed it as `flag-without-a-switch`. `prune.holdOpenPr` is now in `FLAG_REGISTRY` and in `FLAGS_WITH_ANOTHER_HOME`, so the switch is accepted and the digest no longer counts it. The flag stays OFF until it is switched, and the prune is unchanged while it is off.
