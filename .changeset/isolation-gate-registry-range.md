---
"agent-org": patch
---

The isolation gate's copy skips an `@a11ign/*` dependency that has no sibling directory when it is spelled as a caret or tilde range (`^0.1.0`, `~0.1.0`), because that is how a package consumes one published from another repository and npm fetches it from the registry; a sibling that exists is still packed, and any other spelling with no sibling still fails. This matches the original, which `agent-org-wiring.test.ts` compares (a11ign/a11ign#3403, move 6 of #69).
