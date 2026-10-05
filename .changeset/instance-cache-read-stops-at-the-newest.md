---
"agent-org": patch
---

`instanceCacheRead` (the wake's read of an instance's context size, once per order delivered) no longer parses every transcript on the host. It reads transcripts newest first and stops at the first that names the session, which is the one that already won ("the most recently written transcript naming it"), and it skips a file whose first 64 KB already names another session without reading the rest. A head that names nothing, or cannot be read, still falls through to the whole-file read, so no answer changes. Measured: one call read 3.3 GB across 4,256 transcripts, 22.5 s wall and 23 s CPU, 554 MB RSS. a11ign/a11ign#3566, slice 6 of the tick's cost: the `wake` phase.
