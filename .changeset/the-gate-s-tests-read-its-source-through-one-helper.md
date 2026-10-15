---
"@a11ign/agent-org": patch
---

The gate's pinning tests read its source through one helper (a11ign/agent-org#1066). `workGateSource()` in `src/lib/work-gate-source.ts` returns `src/work-gate.ts` followed by every non-test file under `src/work-gate/`, sorted, and the 32 test files that read `src/work-gate.ts` with `readFileSync` call it instead, so a split of the gate (a11ign#5152) moves code between files without moving it out of what those tests pin. No behaviour changes: nothing in `src/work-gate.ts` or `src/work-gate/` is touched, and every pin held on the helper's text unchanged.
