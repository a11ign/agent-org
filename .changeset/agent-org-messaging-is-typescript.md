---
"agent-org": patch
---

41 of `src/messaging`'s 74 `.mjs` files are TypeScript (a11ign/a11ign#4270, sweep 2 of 4 of the chairman's third direction): `ask-ceo`, `check`, `correct`, `measure`, `provider-contract` and 36 messaging tests, renamed and rewritten by the toolchain's `js-to-ts`; the `messaging:measure`, `chairman:correct` and `chairman:ask-ceo` scripts now run `node --import tsx` because `/usr/bin/node` cannot load a `.ts`. The other 33 stay `.mjs` because a plain-`node` entry (`work-gate`, `wake`, `work-tick`, the `agent-org` command table, a unit) imports them, directly or through a file that stays. No behaviour changes.
