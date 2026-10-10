---
"agent-org": patch
---

`class-repeat.test.ts` pins, end to end, that the failure ledger's two counters (`unclassified`, `unidentified-caller-order`) read as `clear` through `classRepeatReadings` and that a real unknown ledger key is still an `unknown class`. Test only: the filter landed in a11ign/a11ign#4618. agent-org#508.
