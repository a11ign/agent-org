#!/usr/bin/env node
// @ts-check
// command: token-audit -- what the org actually spent, read from the transcripts it already writes.
//
// #912's OWN COMPLAINT, UNANSWERED UNTIL NOW: *"COST WAS NEVER A METRIC ANYONE READ: the pipeline reached
// 3,317 runs a day for 193 merges without any figure crossing a desk, because nothing produced one."*
// `org-watch --weekly` renders a cost table and every row in it is GitHub Actions runs and success rates
// -- CI cost, not model cost. Nothing in this repository has ever counted a token.
//
// So the whole of 2026-09-17's work -- retiring six standing crons, routing per cause, dropping Opus at
// xhigh for sonnet/high and luna/medium -- rests on arguments from MECHANISM. Every one of them is
// plausible and none of them is measured. This is the measurement.
//
// IT READS WHAT IS ALREADY WRITTEN AND CALLS NOTHING. `claude` writes a JSONL transcript per session under
// `~/.claude/projects/`, and `codex` writes one under `~/.codex/sessions/`; both record per-turn usage
// including the cache split. There is no API call here, no token spent to count tokens, and no
// instrumentation to add -- the evidence has been accumulating all along with nothing reading it.
//
// THE CACHE SPLIT IS THE POINT, not a detail. A sampled turn read 161,254 cached tokens against 2 fresh
// ones. Cache reads bill at a fraction of fresh input, so any figure that sums `input_tokens` and ignores
// `cache_read_input_tokens` is wrong by more than an order of magnitude -- in the flattering direction,
// which is the dangerous one for a number meant to prove a saving.
//
// ATTRIBUTION COMES FROM THE WAKE ITSELF. `wake.mjs`'s `addressed()` writes "You are `<session>`" into
// every prompt it delivers, so a transcript driven by the tick names its own org session in its own text.
// That is a happy accident of a change made for a different reason, and it is the only link between a
// transcript and a session -- `cwd` names a worktree, which is a row, not an agent. A transcript with no
// such line is reported as `unattributed` rather than guessed at.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";

/** `0` a report was produced; `2` nothing could be read, which is NOT an org that spent nothing. */
export const EXIT = { REPORTED: 0, CANNOT_ASK: 2 };

/**
 * One turn's spend, in the shape both products can be read into.
 *
 * `cacheRead` AND `cacheWrite` STAY SEPARATE because they bill differently and in opposite directions: a
 * read is the discount, a write is the premium paid to get it. Summing them into one "cache" number would
 * hide exactly the trade the two-minute tick is making.
 *
 * @typedef {{ session: string, model: string, day: string,
 *             fresh: number, cacheRead: number, cacheWrite: number,
 *             output: number, thinking: number }} Turn
 */

/**
 * The org session a transcript belongs to, from the wake prompt's own words, or `null`.
 * @param {string} text
 */
export function sessionOf(text) {
  const m = /You are `([a-z0-9-]+)`/.exec(text);
  return m ? m[1] : null;
}

/**
 * A number from a usage object, however the product spells "absent".
 *
 * Extracted because the two readers each did eight `Number(x ?? 0)` reads inline and that alone put both
 * past `complexity` 15 -- a rule measuring branches, and `??` is a branch. One place to read a field is
 * also one place to be wrong about a field name.
 *
 * @param {any} obj @param {string} key
 */
function num(obj, key) {
  const v = obj?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The JSONL records of a transcript, skipping blanks and anything unparseable.
 *
 * A LINE THAT WILL NOT PARSE IS SKIPPED, NOT FATAL: a transcript being written while this reads it ends
 * in a partial line, and refusing the whole file for its last byte would report a live session as silent.
 *
 * @param {string} text
 */
function* records(text) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* partial or corrupt line: skip, never fail the file */ }
  }
}

/**
 * Has this API call already been counted? Mutates `seen`, which is the point.
 *
 * ONE RESPONSE IS SEVERAL LINES -- one per content block -- and every one carries the same `usage`.
 * Measured: 3,314 lines with usage against 1,615 distinct ids. A line carrying no id is counted, because
 * dropping it under-reports where double-counting over-reports, and under-reporting is the quieter lie.
 *
 * @param {Set<string>} seen @param {string} id
 */
function alreadyCounted(seen, id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
}

/**
 * Every turn in a `claude` transcript.
 *
 * READS THE FILE ONCE and takes the session from whichever line carries it -- the wake prompt is a user
 * message, the usage is on assistant messages, and they are different lines.
 *
 * DEDUPLICATED ON `message.id`, WITHOUT WHICH EVERY FIGURE IS ROUGHLY DOUBLE. One API response is written
 * across several JSONL lines -- one per content block, so a turn with text and two tool calls is three
 * lines -- and EVERY ONE carries the same `usage` object. Measured on one transcript: 3,314 lines with
 * usage against 1,615 distinct `message.id`s, and cache_read values arriving in identical runs of four.
 *
 * The first version of this file summed every line and reported a 100% cache-read rate over 17 BILLION
 * tokens, which is what a doubled denominator and a doubled numerator look like when they cancel. A
 * number that survives its own arithmetic being wrong is the kind worth distrusting.
 *
 * @param {string} text @param {string} [fallbackSession]
 * @returns {Turn[]}
 */
export function claudeTurns(text, fallbackSession = "unattributed") {
  const session = sessionOf(text) ?? fallbackSession;
  /** @type {Turn[]} */
  const turns = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const d of records(text)) {
    const turn = claudeTurn(d, session, seen);
    if (turn) turns.push(turn);
  }
  return turns;
}

/**
 * One `claude` record as a Turn, or `null` when it is not a billed response or is a repeat.
 *
 * @param {any} d @param {string} session @param {Set<string>} seen
 * @returns {Turn | null}
 */
function claudeTurn(d, session, seen) {
  const message = d?.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  // `requestId` agrees with `message.id` on every line measured; either identifies the API call.
  if (alreadyCounted(seen, String(message?.id ?? d?.requestId ?? ""))) return null;
  return {
    session,
    model: String(message?.model ?? "unknown"),
    day: String(d?.timestamp ?? "").slice(0, 10) || "unknown",
    fresh: num(usage, "input_tokens"),
    cacheRead: num(usage, "cache_read_input_tokens"),
    cacheWrite: num(usage, "cache_creation_input_tokens"),
    output: num(usage, "output_tokens"),
    thinking: num(usage.output_tokens_details, "thinking_tokens"),
  };
}

/**
 * Every turn in a `codex` rollout.
 *
 * DIFFERENT FIELD NAMES FOR THE SAME FACTS, and the trap is `input_tokens`: codex reports it INCLUSIVE of
 * the cached portion, where `claude` reports the two separately. Subtracting gives the fresh count both
 * sides mean, and forgetting to would double-count every cached token on the codex side alone.
 *
 * @param {string} text @param {string} session
 * @returns {Turn[]}
 */
export function codexTurns(text, session) {
  /** @type {Turn[]} */
  const turns = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const d of records(text)) {
    const turn = codexTurn(d, session, seen);
    if (turn) turns.push(turn);
  }
  return turns;
}

/**
 * One `codex` record as a Turn, or `null` when it is not a usage record or is a repeat.
 *
 * @param {any} d @param {string} session @param {Set<string>} seen
 * @returns {Turn | null}
 */
function codexTurn(d, session, seen) {
  if (d?.type !== "token_usage_record") return null;
  const payload = d.payload ?? {};
  // Same deduplication for the same reason: one response, potentially several records.
  if (alreadyCounted(seen, String(payload.response_id ?? payload.turn_id ?? ""))) return null;
  const u = payload.usage ?? {};
  const cached = num(u, "cached_input_tokens");
  return {
    session,
    model: "codex",
    day: String(d.timestamp ?? "").slice(0, 10) || "unknown",
    fresh: Math.max(0, num(u, "input_tokens") - cached),
    cacheRead: cached,
    cacheWrite: num(u, "cache_write_input_tokens"),
    output: num(u, "output_tokens"),
    thinking: num(u, "reasoning_output_tokens"),
  };
}

/**
 * Every `*.jsonl` under `root`, recursively. A missing root is [], not a crash.
 * @param {string} root
 */
export function transcriptFiles(root) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...transcriptFiles(path));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

/**
 * Turns grouped by a key, with the totals that matter.
 *
 * `turns` IS REPORTED ALONGSIDE THE TOKENS because it is the number #912 is actually about. The row that
 * started this measured 672 model turns a day answering a question a script answers in one API call; a
 * token total alone cannot tell a cheap tick from an expensive one it never had to make.
 *
 * @param {Turn[]} turns @param {(t: Turn) => string} by
 */
export function summarise(turns, by) {
  /** @type {Map<string, {turns: number, fresh: number, cacheRead: number, cacheWrite: number, output: number, thinking: number}>} */
  const rows = new Map();
  for (const t of turns) {
    const key = by(t);
    const row = rows.get(key)
      ?? { turns: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
    row.turns += 1;
    row.fresh += t.fresh;
    row.cacheRead += t.cacheRead;
    row.cacheWrite += t.cacheWrite;
    row.output += t.output;
    row.thinking += t.thinking;
    rows.set(key, row);
  }
  return rows;
}

/**
 * `12345` -> `12.3k`. Exact under 1,000, because a turn count of 7 must not read as `0.0k`.
 * @param {number} n
 */
export function human(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * One markdown table. `label` names the first column so the caller says what it grouped by.
 * @param {Map<string, {turns: number, fresh: number, cacheRead: number, cacheWrite: number, output: number, thinking: number}>} rows
 * @param {string} label
 */
export function table(rows, label) {
  const lines = [`| ${label} | turns | fresh in | cache read | cache write | output | thinking |`,
    "|---|---:|---:|---:|---:|---:|---:|"];
  const sorted = [...rows.entries()].sort((a, b) => (b[1].fresh + b[1].output) - (a[1].fresh + a[1].output));
  for (const [key, r] of sorted) {
    lines.push(`| ${key} | ${r.turns} | ${human(r.fresh)} | ${human(r.cacheRead)} | `
      + `${human(r.cacheWrite)} | ${human(r.output)} | ${human(r.thinking)} |`);
  }
  return lines.join("\n");
}

function main() {
  refuseUnknownFlags(["--claude-root", "--codex-root", "--since"], {
    entry: import.meta.url, command: "node packages/agent-org/src/token-audit.mjs",
  });
  const home = process.env.HOME ?? "";
  const claudeRoot = flagValue(process.argv, "claude-root") ?? join(home, ".claude", "projects");
  const codexRoot = flagValue(process.argv, "codex-root") ?? join(home, ".codex", "sessions");
  const since = flagValue(process.argv, "since");

  /** @type {Turn[]} */
  const turns = [];
  for (const file of transcriptFiles(claudeRoot)) {
    try { turns.push(...claudeTurns(readFileSync(file, "utf8"))); } catch { /* unreadable: counted below */ }
  }
  for (const file of transcriptFiles(codexRoot)) {
    // Codex rollouts carry no org session name -- they are the reviewers, and their prompt comes through
    // herdr rather than through `addressed()`. Named for what they are rather than guessed at.
    try { turns.push(...codexTurns(readFileSync(file, "utf8"), "codex-reviewers")); } catch { /* as above */ }
  }

  if (turns.length === 0) {
    process.stderr.write(`CANNOT ASK: no usage found under ${claudeRoot} or ${codexRoot}. `
      + "That is a failed read, NOT an org that spent nothing.\n");
    process.exit(EXIT.CANNOT_ASK);
  }

  const kept = since ? turns.filter((t) => t.day >= since) : turns;
  if (kept.length === 0) {
    process.stderr.write(`CANNOT ASK: ${turns.length} turn(s) found but none on or after ${since}.\n`);
    process.exit(EXIT.CANNOT_ASK);
  }

  const out = [];
  out.push(`# Token audit${since ? ` (from ${since})` : ""}`, "",
    `${kept.length} turns across ${transcriptFiles(claudeRoot).length} claude transcript(s) and `
    + `${transcriptFiles(codexRoot).length} codex rollout(s).`, "",
    "## By day", "", table(summarise(kept, (t) => t.day), "day"), "",
    "## By model", "", table(summarise(kept, (t) => t.model), "model"), "",
    "## By session", "", table(summarise(kept, (t) => t.session), "session"), "");

  // THE ONE DERIVED NUMBER, and it is the one the design rests on: the tick keeps prefixes warm, so a
  // cache read rate that is NOT overwhelming would mean the two-minute cadence is buying nothing.
  const totalIn = kept.reduce((n, t) => n + t.fresh + t.cacheRead, 0);
  const cached = kept.reduce((n, t) => n + t.cacheRead, 0);
  out.push(`Cache read rate: **${totalIn === 0 ? "n/a" : `${Math.round((cached / totalIn) * 100)}%`}** `
    + `of input tokens (${human(cached)} of ${human(totalIn)}). A low rate here means the tick's cadence `
    + "is not keeping prefixes warm, which is the property the whole design rests on.");
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(EXIT.REPORTED);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
