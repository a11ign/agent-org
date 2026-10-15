---
"@a11ign/agent-org": patch
---

An engineer start for another tracker's row (`worker-agent-org-<n>`) now reaches the model router (a11ign/a11ign#4627, a11ign/agent-org#756). `routesForStarts` kept only orders for which `rowOfOrder` is non-null, and that is `null` for a keyed row, so 32 of 75 engineer starts in 13:00Z to 19:50Z took the ordinary `sonnet/high` profile and left no `model-routing` line. A keyed order is now read from its own tracker (`readRowForTier` takes the key and resolves the repository from the declaration), routed, filed under `agent-org#<n>` (the first tracker's rows stay under the bare number) and logged as `row-agent-org-<n>`, so it cannot collide with a11ign's `row-<n>`. `tierOfRow` looks the route up by the same key. A keyed row that cannot be read or routed is absent and takes the ordinary profile, as before; a keyed row with no route is still not read for the first tracker's `tier:haiku` label.
