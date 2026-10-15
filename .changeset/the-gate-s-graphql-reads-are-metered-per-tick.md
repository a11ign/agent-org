---
"@a11ign/agent-org": patch
---

The gate's conditional-read (ETag/304) and per-tick GraphQL budget building blocks land in `src/gh-conditional.ts` (a11ign/a11ign#5128): a reader that sends `If-None-Match` for a repeated URL, a filter that skips a pull request whose head and `updatedAt` are unchanged, a points budget that refuses the spend that would pass its cap, and the `gate-rest-conditional` marker that will turn the metering on. Nothing in the gate calls them yet, so the gate's reads and its behaviour are unchanged by this release. Wiring the reads, and the one-hour measurement, is a separate row (a11ign/a11ign#5169).
