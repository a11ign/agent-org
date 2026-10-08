---
"agent-org": patch
---

The trace prices `gpt-5.6-luna`, the model the Codex reviewers run, from OpenAI's own rate: $0.2 input, $0.02 cached input and $1.2 output per 1M tokens, sourced in `PRICES` to `https://developers.openai.com/api/docs/models/gpt-5.6-luna.md` with the date it was fetched. The row matches that exact model name only, so every other `gpt-*` stays unpriced (`null`, never `$0`), and a request above 272K prompt tokens is also unpriced because OpenAI states no cached rate there. The aggregate report prints the priced Codex turns as a line of their own beside the unpriced ones. For the 7 days to 2026-10-08: 22,033 turns, $35.95 at list rate (arithmetic from the trace store, not an invoice). a11ign/a11ign#4076.
