---
"agent-org": patch
---

The headers of `src/lib/product-home.mjs` and `src/lib/fixture-symbols.ts` name the `.ts` originals the core renamed them to (`scripts/product-home.ts`, `scripts/fixture-symbols.ts`, a11ign/a11ign#4274), so `readDeclaredCopies` reads both and `copyDriftReading` can answer `clear` for them instead of `unknown` (a11ign/a11ign#4515). Reading them showed the originals gained types: `fixture-symbols.ts` is now byte-identical to its original (header: `NOTHING`), and `product-home.mjs` names a fourth changed line, the `productHome` signature it keeps untyped.
