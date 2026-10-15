---
"@a11ign/agent-org": patch
---

The model router asks the provider once per row body. `routeOnly` keeps a `route-memory.jsonl` beside the decision log, keyed by a sha256 of the row id, title, body, labels and questions; a later start of the same unchanged row reuses the remembered provider answer, asks zero times and writes one `route reused` line, which `provider-confidence` does not count. A changed body, title, label or Region is another key and asks again. Only an answer the provider gave is remembered (a fallback or refusal is not), and an unreadable memory costs a call, never a route. During a claim outage the gate re-routed the same rows every tick and one row was asked 25 times, which skewed the confidence reading and `route-accuracy`. a11ign/a11ign#4990.
