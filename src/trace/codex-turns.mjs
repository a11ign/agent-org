// @ts-check
// a11ign/a11ign#3519 (slice 2b of #3494): THE CODEX REVIEWERS' TURNS, read from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` into the same turn events the Claude
// transcripts give, so a pull request's trace holds the review that was run on it. A PURE READER: it is handed the text of a session file (or the part of one from a resume
// point) and returns events; it opens no file and reads no home directory. The Codex session files are READ, never written.
//
// THE RECORD SHAPES (measured 2026-10-04 on the 1,134 session files of this host, 44,180 `token_usage_record`s):
//   session_meta        `payload.cwd`: the reviewer's working directory, `/home/agent/reviews/reviewer-<n>` (or `reviewer-<repo>-<n>`), whose last part is the session's NAME,
//                       the same name `reviewerTarget` reads for a Claude reviewer. A session in any other directory is kept under `codex:<directory>` with no row.
//   turn_context        `payload.model`: the model of the turns after it.
//   token_usage_record  one per model REQUEST, unique by `payload.response_id` (no duplicate in 44,180), with `payload.usage` of that request alone. This is the turn.
//                       (`event_msg/token_count` repeats the same figures as a running total and is NOT read: summing both would double count.)
//
// TOKENS: Codex's `input_tokens` INCLUDES `cached_input_tokens` (`total_tokens` = input + output in every record; cached never exceeds input), so `input` here is the
// uncached part, `cacheRead` the cached part, and `output` is `output_tokens` as given, which already includes `reasoning_output_tokens`. `cache_write_input_tokens` was 0
// in every record, and Codex has no write TTL, so both write fields are 0.
// COST: `null`. `PRICES` has no row for a Codex model, and a number invented here would wear the clothes of a measured one.
// WALL-CLOCK (inferred): from the last record that sent something TO the model (an order, a tool's output, the task's start) to the usage record, which is when the request
// completed. It includes the time the harness spent on the tool call that preceded it, as a Claude turn's does.
import { basename } from "node:path";
import { costOf, readRecords, subjectOfSession } from "./store.mjs";

/** @typedef {{ session: string | null, model: string | null, inputAt: number | null }} CodexCarry what a read leaves for the one that resumes after it */

/** `response_item` payloads that are sent TO the model as input: an order or developer message, or the output of a tool the model called. @param {any} record */
function isModelInput(record) {
  const payload = record?.payload;
  if (record?.type === "event_msg") return payload?.type === "task_started";
  if (record?.type !== "response_item") return false;
  if (payload?.type === "message") return payload.role === "user" || payload.role === "developer";
  return payload?.type === "custom_tool_call_output" || payload?.type === "function_call_output";
}

/** A rollout's id: the uuid ending its file name (`rollout-<time>-<uuid>.jsonl`), which is what `CODEX_THREAD_ID` holds in a shell that session started (measured 2026-10-05 in `~/.codex/sessions`), so `host/gh`'s id on a call names it (#3589). @param {string} file */
const rolloutId = (file) => basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1];

/** The session's name from the directory it ran in. @param {string | undefined} cwd @param {string} file @param {string} rowRepo */
function sessionNamed(cwd, file, rowRepo) {
  const name = cwd ? basename(cwd) : "";
  if (/^reviewer-/.test(name) && subjectOfSession(name, rowRepo).pr !== null) return name;
  return name ? `codex:${name}` : `unnamed:${basename(file)}`;
}

/**
 * Every turn one Codex session file holds, or the part of it from a resume point. `consumed` is how many bytes of `text` are turned into events: a final line that is
 * not JSON yet (half written) is left for the next read. `carry` is `null` for a read from byte 0.
 * @param {{ text: string, file: string, rowRepo: string, carry?: CodexCarry | null }} input
 * @returns {{ session: string, events: import("./store.mjs").TraceEvent[], unreadable: number, consumed: number, carry: CodexCarry }}
 */
export function eventsOfCodexSession({ text, file, rowRepo, carry = null }) {
  const { records, unreadable, end } = readRecords(text);
  let session = carry?.session ?? null;
  let model = carry?.model ?? null;
  let inputAt = carry?.inputAt ?? null;
  /** @type {{ at: number, response: string, usage: any, model: string | null, since: number | null }[]} */
  const requests = [];
  for (const { record, at } of records) {
    if (record.type === "session_meta" && session === null) session = sessionNamed(record.payload?.cwd, file, rowRepo);
    if (record.type === "turn_context" && typeof record.payload?.model === "string") model = record.payload.model;
    if (isModelInput(record) && !Number.isNaN(at)) inputAt = at;
    if (record.type === "token_usage_record" && record.payload?.usage && record.payload.response_id && !Number.isNaN(at)) {
      requests.push({ at, response: record.payload.response_id, usage: record.payload.usage, model, since: inputAt });
    }
  }
  const named = session ?? `unnamed:${basename(file)}`;
  const subject = subjectOfSession(named, rowRepo);
  const events = requests.map(({ at, response, usage, model: used, since }) => {
    const cached = usage.cached_input_tokens ?? 0;
    const tokens = { input: Math.max(0, (usage.input_tokens ?? 0) - cached), output: usage.output_tokens ?? 0, cacheRead: cached, cacheWrite5m: 0, cacheWrite1h: 0 };
    return {
      id: `codex-turn:${response}`, kind: /** @type {"turn"} */ ("turn"), source: /** @type {"transcript"} */ ("transcript"), at, session: named, ...(rolloutId(file) ? { transcript: rolloutId(file) } : {}), ...subject, cause: null, causeKey: null,
      wakeId: null, model: used ?? undefined, tokens, costUsd: costOf(used ?? undefined, tokens), wallClockMs: since === null ? null : Math.max(0, at - since), sidechain: false,
      harness: /** @type {"codex"} */ ("codex"),
    };
  });
  return { session: named, events, unreadable: unreadable.length, consumed: end, carry: { session, model, inputAt } };
}
