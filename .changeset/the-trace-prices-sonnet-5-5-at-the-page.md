---
"agent-org": minor
---

The trace pricer charges a Sonnet 5.5 cache read at the pricing page's $0.10 per MTok (it charged $0.20, which is what Claude Code 2.1.289's own `cost_usd` agrees with and the page does not), Fable 5.1 at $0.25 and Fable 5 at $1 (one `claude-fable-5` prefix priced both at $0.25; the page lists them apart, so `claude-fable-5-1` stands first). `claude-sonnet-5-5` is no longer marked `verified`: a figure that disagrees with the page does not verify the row, and Haiku 4.5 is the one verified row left. Every report restates the whole stored history at the new rates with no re-ingest (`repriceEvents`). The weekly report prints the Codex turns it could not price (no OpenAI rate is sourced) as a line of their own, with their count and tokens, and not inside a total.
