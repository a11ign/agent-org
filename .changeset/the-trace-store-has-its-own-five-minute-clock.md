---
"agent-org": minor
---

The trace store is ingested on its own five-minute clock, and a stale store raises one incident per episode. `trace -- --ingest` ingests the transcripts, the `gh` ledgers and the deferral log and prints one report line (no rendering, no GitHub call); `a11ign-trace-ingest.timer` runs it every five minutes and then checks the store: no `turn` for ten minutes while a transcript has changed in the last ten is stale, `trace -- --freshness` prints that and exits 1, and the unit comments once on #928 and orders `orchestrator` once per stale episode (again only after a recovery). `readStore` reads the store in chunks: the live store passed V8's longest string and every `trace` mode threw `ERR_STRING_TOO_LONG`.
