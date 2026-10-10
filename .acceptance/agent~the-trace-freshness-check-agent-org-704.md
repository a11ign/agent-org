The trace-freshness check counts a session as working only when it wrote a message inside the window (a11ign/agent-org#704, part of a11ign/a11ign#4437 move 1b, unit agent-org#498). **The incident:** three false `metrics-outage` incidents on 2026-10-10 (a11ign/a11ign#928, 11:53Z, 15:00Z, 17:50Z) each read "a session is working" off a transcript's mtime; the ingest was healthy every time and no session had produced a turn, because a finished session still rewrites its `last-prompt` and `cost-state` lines (no timestamp, no message) and so moves its file.

**What changes.**
- *`sessionsWorking`* counts a `.jsonl` only when its newest message line (`assistant` or `user` with its own `timestamp`; a Codex rollout's `response_item`) is inside the window, read from the tail (a 256 KiB window that doubles to 32 MiB while it holds none). The file's mtime stays only as the filter in front of the read: a file not modified since before the window cannot hold a message in it, so about 7,000 transcripts are not each opened every five minutes. A root that cannot be read still throws; so does a transcript refused for any reason but `ENOENT`.
- *`freshnessLine`* says "a message was written in the last 10 minutes" in place of "a transcript changed".
- `STALE_AFTER_MS`, the episode rules and the order text are the same.

**Assumption.** A Codex rollout has no self-rewriting bookkeeping line (measured on one `~/.codex/sessions` rollout of 2026-10-04: every line carries its own timestamp and none is rewritten after the last item), so its `response_item` lines stand for the message lines; its `event_msg` `token_count` and `item_completed` events are not counted.

**Tests.** The fixtures that stood for "working" by touching a file (`touch` in `home()` and in the `--freshness` CLI case) now write a message line at that time; the episode cases are untouched. New: the touched-not-written transcript (mtime inside the window, newest message 30 minutes old, `attachment`, `last-prompt` and `cost-state` after it) is NOT working, with its positive control on the same file and the window's edge; a file not modified is not opened; the message is found past a 600 kB line and a half-written last line; a Codex rollout.

Mutation: the message test replaced by `true` (mtime alone) -> 2 red (the touched transcript and the Codex rollout); both restored byte-identical (copy in the scratchpad).

Acceptance: `node --test src/trace/freshness.test.ts`

Closes: a11ign/agent-org#704

platform: n/a (no GitHub, pnpm, systemd or git feature; the unit's own `gh` effects are untouched)
