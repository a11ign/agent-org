---
"agent-org": patch
---

`agent-org doctor` on Linux now shows one row for each of the three interim guards set by hand on the agents host: `keep-herdr.conf`, `gh-wrapper watchdog` and `gh-read-cache-off.conf`. A row passes once its guard is off disk. It fails while the guard is on disk and its replacement is proven, which `agent-org onboard` reads too: the row says the guard can be removed, and names the command that removes it. While the replacement is not proven, the row also fails, says the guard is kept, and names what proves its replacement. So a passing row always means the guard is gone. Before this change, a retired guard had no row, and the read-cache row failed even when onboard would have kept the guard.
