---
"agent-org": patch
---

18 of `src/lib` and `src/trace`'s 59 `.mjs` files are TypeScript (a11ign/a11ign#4269, sweep 1 of 4 of the chairman's third direction): `lib/fixture-symbols`, `lib/pin-ratchet`, `lib/sandbox-exhaustion`, `trace/clock-feed` and 14 trace tests, renamed and rewritten by the toolchain's `js-to-ts`. The other 41 stay `.mjs` because `/usr/bin/node` cannot load a `.ts` (ADR 0043): a plain-`node` entry imports them, or a unit, a project script or the `agent-org` command table runs them by path. No behaviour changes.
