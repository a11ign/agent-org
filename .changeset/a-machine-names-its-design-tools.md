---
"agent-org": minor
---

`tickets.designTools` says whether a machine gives its workers a design tool. Step 7 of every worker's brief told it to decline a design gate's check with "unattended worker, no design tool access", which is right for a machine with no design tool and wrong for one that allows a design connector in `tickets.connectors`: its workers declined the `nbl-ui` design gate and shipped UI with no design check. With `designTools: true`, step 7 has the worker do the check (read the design's values, measure its result, look at the design) and decline it only when a design call is refused, quoting the refusal. Absent or false keeps the old text, so no other machine changes. The key stays in `host.json`, as a machine fact, in the plugin transition (`docs/plugins-versus-host-json-keys.md`). It has a row in the Settings page, in "Plugins and connectors", with a switch.
