---
"@a11ign/agent-org": patch
---

The blocking-impact readout of a holder shelving 1 to 4 rows is no longer offered to `orchestrator` as a repeating log line (agent-org#818). `blocking-impact.ts` prints `blocking-impact: <holder> shelves N rows [behind …]: #N …` every tick for every holder; below `BLOCKING_MIN_ROWS` (5) that count is a readout of a count that already has its own threshold and owner, and a ready row held behind an open pull request in review repeated it for an hour (59 ticks measured on 2026-10-11). One entry in `repeating-lines.allowlist.json` allows the unkeyed, keyed and `behind` forms. The episode form (`(episode open)`, the incident at 5 rows for 30 minutes), a line with no row list and the unattributed line are still offered.
