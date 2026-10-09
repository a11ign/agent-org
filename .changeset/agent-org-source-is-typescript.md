---
"agent-org": patch
---

The top level of `src/` is TypeScript: 140 files renamed by `js-to-ts` and the residue fixed to a clean `tsc --noEmit` (a11ign/a11ign#4272). Every command that runs one names the loader (`node --import tsx file.ts`), `tsx` is now a runtime dependency because the installed tool and `bin.mjs` load it, and the ratchet baseline falls from 252 to 112 files. The sources a plain-`node` entry imports stay `.mjs`.
