---
"agent-org": minor
---

`node src/trace/growth.mjs --from=<ISO> --to=<ISO>` prints how much each worker request grew the context window, summed by the tool before it and by session. Growth is the change in `cacheRead` from the previous request of the same thread, and it is attributed to the tool called two requests earlier, because a request WRITES what its tool result added and the next request READS it (measured: the delta equalled the previous request's `cache_creation_input_tokens`, to the token). The first request, the first after a compaction or a `/clear`, a request whose cache read fell and the one after it print as not derivable, never 0, and a subagent's requests are their own thread and are not counted into the parent's. It reads transcripts, because the store's turns name no tool. a11ign/a11ign#4073.
