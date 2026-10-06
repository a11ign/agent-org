---
"agent-org": patch
---

The scan behind `#2174: no test file joins the history-requirement population` reads each module once per run (a11ign/a11ign#3549). `deriveClosureRequirements(entry, memo)` takes an opt-in `createClosureMemo()` that keeps a file's source, parse, reachable scope, pattern matches and import edges, so a module reached from many entries is read once; omitted, each call gets a fresh memo and answers exactly as before (all 190 `src/packaging` entries return byte-identical hit lists to the unmemoised code). `lib/pin-ratchet.mjs` gains `changedSince`, which `judgePin` passes to the scan, so the scan of the base re-reads only entries whose walk touched a changed file, and the whole base after a deletion or rename. One pass over the packaging directory was 182 CPU-s, twice per run.
