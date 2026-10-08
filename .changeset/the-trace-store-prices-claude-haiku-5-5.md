---
"agent-org": patch
---

The trace store prices `claude-haiku-5-5`: $0.10 input, $0.50 output, cache reads $0.01 per million tokens, from the claude-api skill's model docs (2026-10-08), `verified: false`. Its turns read `costUsd: null` before, so a report that summed cost counted them as not priced (found on a11ign/a11ign#4183). The row carries `maxPrompt: 100_000`: the page lists a second card ($0.50 / $2.50) for a longer prompt, and a request above it costs `null` rather than the wrong rate. a11ign/a11ign#4186.
