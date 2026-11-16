---
"agent-org": patch
---

The interim guards are retired on the agents host, so their code is gone. `agent-org doctor` no longer shows the `keep-herdr.conf`, `gh-wrapper watchdog` and `gh-read-cache-off.conf` rows. `agent-org onboard` and `agent-org start herdr --move` no longer look for those files or remove them. A host that still has one of them keeps it until a person removes it by hand.
