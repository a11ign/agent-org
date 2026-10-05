// @ts-check
// a11ign/a11ign#3516 (slice of #3494): THE `gh` CALL LEDGER AS A SOURCE OF THE TRACE STORE. `host/gh` appends one TAB-separated line per call to `gh-calls.tsv` in the calling account's config
// directory (#3466); `../gh-ledger.mjs` parses it and is imported here, never edited. Every call becomes ONE record, `source: "gh-ledger"`, so a row's trace can show the calls and the
// GraphQL points beside its tokens and dollars. The ledger files are READ, never written.
//
// WHY THE STORE MUST READ IT, AND NOT ONLY WHEN A REPORT WANTS IT: the ledger is bounded (2 MiB, the newest half kept past it), so a call older than the bound is GONE. The ingest reads each
// file incrementally through `ingest-state.mjs` (#3526), and a trim reads as a shrink, which is read again from byte 0 and SAID: safe, because a record's id is made of the line and not of
// where it sits, so a line already held is the same record.
//
// THE KEY IS THE SESSION ID ON THE LINE (#3589). `host/gh` writes `CLAUDE_CODE_SESSION_ID` (a Codex session's `CODEX_THREAD_ID`) as the last field of each line, and that is the file name of the session's transcript, which
// every turn carries (`transcript`). So a call is on the session whose transcript has that name and, through that session's NEXT turn, on a row: exact, however many sessions were waiting on a tool at its second.
// Before it the key was INFERRED from time (a call from a session's shell that exactly one session's tool window covered), which named 27 of 11,751 calls on this host (measured 2026-10-05, a11ign/agent-org#209): that rule,
// `toolWindows`, `keyCalls` and `viaShell`, is deleted. A line with no id is a unit or script outside any session, or was written before the wrapper named its session (the ledgers keep 2 MiB, so those age out); it is
// `unkeyed: "script"` and is never joined by time: a unit's calls on whichever session happened to be waiting would be a guess, and a call must be a measurement or it is unkeyed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { callerScript, parseLine } from "../gh-ledger.mjs";
import { fingerprint, HEAD_BYTES, planRead } from "./ingest-state.mjs";
import { appendToStore } from "./store.mjs";

/** @typedef {import("./ingest-state.mjs").FileState} FileState
 * @typedef {import("./ingest-state.mjs").IngestState} IngestState
 * @typedef {import("./store.mjs").TraceEvent} TraceEvent */

/** A unit's node is started with a preload (`--import file:///.../crash-exit.mjs /.../work-gate.mjs`, or `--import=./src/lib/crash-exit.mjs src/work-tick.mjs`), and `callerScript` names the first script in the line: 2,756 of one ledger's 7,510 calls read `crash-exit.mjs`. */
const PRELOAD = /--import(?:=|\s+)\S+/g;
/** The shell Claude Code runs a Bash tool call in: `zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ms>-<id>.sh ...`. What a session's shell is called: `callerScript` would name its snapshot file, `snapshot-zsh-<ms>-<id>.sh`, which is one per session process and says nothing of what ran. */
const SHELL_NAME = "(a session's shell)";
const HARNESS_SHELL = /\/shell-snapshots\/snapshot-/;
const MS_PER_SECOND = 1000;
/** A second's lines are read together or not at all: a line is written when its call finishes, and identical lines of one second are told apart by their order, which a read that ended between them would break. */
const SETTLE_MS = 2 * MS_PER_SECOND;
const ID_HASH_CHARS = 16;
const NEWLINE = 0x0a;
const NO_CARRY = { session: null, owner: null, lastAt: null, used: [] };
const TOP_UNKEYED = 5;
/** What `keyed` decides, so a record that is keyed again starts from none of it. */
const PLACEMENT = ["session", "row", "pr", "repo", "rows", "prs", "keyedBy", "unkeyed", "candidates", "viaShell"]; // the last two are the time rule's, which a record of before #3589 still holds

/**
 * Each transcript's turns, by its id, oldest first: what a call's session id is looked up in.
 * @param {TraceEvent[]} events
 * @returns {Map<string, TraceEvent[]>}
 */
export function turnsByTranscript(events) {
  /** @type {Map<string, TraceEvent[]>} */
  const byTranscript = new Map();
  for (const event of events) if (event.kind === "turn" && event.transcript) byTranscript.set(event.transcript, [...(byTranscript.get(event.transcript) ?? []), event]);
  for (const turns of byTranscript.values()) turns.sort((a, b) => a.at - b.at);
  return byTranscript;
}

/**
 * The turn that FOLLOWS a call: the first of `turns` (oldest first) that ended in a later second than the call's. The ledger's time is to the second, so a call logged at 10:00:20 finished at some point in 10:00:20.xxx, and
 * the turn that ISSUED it ended before it began, so it is in that second or earlier: starting from the next second can never pick it. The cost is a following turn that ended inside the same second, which is skipped for
 * the one after it, in the same wake and so on the same row.
 * @param {TraceEvent[]} turns @param {number} at
 */
function turnAfter(turns, at) {
  const from = at + MS_PER_SECOND;
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (turns[middle].at < from) low = middle + 1;
    else high = middle;
  }
  return turns[low];
}

/**
 * Put the keys on records, from the turns among `events`. A call whose line names a session is keyed to that session's next turn and so to its ROW, which `eventsForRow` finds; every other call is `session: "gh-ledger"`
 * with no row and says why (`unkeyed`): `script` for a line with no id, `no-turn` for one whose session has no later turn in `events` (yet).
 * @param {TraceEvent[]} calls @param {TraceEvent[]} events
 * @returns {TraceEvent[]}
 */
export function keyed(calls, events) {
  const turns = turnsByTranscript(events);
  return calls.map((call) => {
    const bare = { ...call };
    for (const field of PLACEMENT) delete bare[/** @type {keyof TraceEvent} */ (field)];
    const turn = call.sessionId ? turnAfter(turns.get(call.sessionId) ?? [], call.at) : undefined;
    if (!turn) return { ...bare, session: "gh-ledger", row: null, pr: null, repo: null, keyedBy: null, unkeyed: call.sessionId ? "no-turn" : "script" };
    return { ...bare, session: turn.session, row: turn.row, pr: turn.pr, repo: turn.repo, ...(turn.rows ? { rows: turn.rows } : {}), ...(turn.prs ? { prs: turn.prs } : {}), keyedBy: /** @type {"session"} */ ("session") };
  });
}

/**
 * The records of one read of a ledger's lines, not yet keyed, and how many lines were no call (a half line left by a trim or a crash is skipped as `parseLine` skips it, never guessed at). A
 * record's id is made of the line and of how many identical lines (one call, three times, one second) came before it, so three identical calls are three records and a line read again is the
 * record already held.
 * @param {string} text @returns {{ calls: TraceEvent[], skipped: number }}
 */
export function callsOfLedgerText(text) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {TraceEvent[]} */
  const calls = [];
  let skipped = 0;
  for (const line of text.split("\n").filter((each) => each !== "")) {
    const entry = parseLine(line);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    const nth = seen.get(line) ?? 0;
    seen.set(line, nth + 1);
    calls.push({
      id: `gh-call:${fingerprint(Buffer.from(line)).slice(0, ID_HASH_CHARS)}:${nth}`, kind: "gh_call", source: "gh-ledger", at: Date.parse(entry.time), session: "gh-ledger", row: null, pr: null, repo: null,
      cause: null, causeKey: null, wakeId: null, account: entry.account, resource: entry.resource, cost: entry.cost, exit: entry.status, command: entry.command, workspace: entry.workspace,
      script: HARNESS_SHELL.test(entry.caller) ? SHELL_NAME : callerScript(entry.caller.replace(PRELOAD, "")), ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), keyedBy: null,
    });
  }
  return { calls, skipped };
}

/**
 * Read one ledger from where the state says to; `null` when nothing is to be read. The file is read whole (it is bounded at 2 MiB) and parsed from the offset, up to the last whole line that is
 * older than `SETTLE_MS`: the lines after it are left for the next run and counted in `heldBack`.
 * @param {{ file: string, entry: FileState | undefined, now: number }} input
 */
function readLedger({ file, entry, now }) {
  const stat = statSync(file);
  const bytes = readFileSync(file);
  const plan = planRead({ entry, stat: { size: bytes.length, mtimeMs: stat.mtimeMs }, now, headMatches: () => !entry || fingerprint(bytes.subarray(0, entry.headBytes)) === entry.headHash });
  if (plan.action === "skip") return null;
  const start = plan.action === "resume" && entry ? entry.offset : 0;
  const lines = bytes.subarray(start, bytes.lastIndexOf(NEWLINE) + 1).toString("utf8").split("\n").slice(0, -1);
  let heldBack = 0;
  let settleAt = null;
  while (lines.length > 0 && Date.parse(parseLine(lines[lines.length - 1])?.time ?? "") > now - SETTLE_MS) {
    settleAt ??= Date.parse(/** @type {string} */ (parseLine(lines[lines.length - 1])?.time)) + SETTLE_MS; // the newest held line, and a quiet ledger is read again from then
    lines.pop();
    heldBack += 1;
  }
  const text = lines.map((line) => `${line}\n`).join("");
  const consumed = Buffer.byteLength(text);
  const head = start === 0 ? bytes.subarray(0, Math.min(HEAD_BYTES, consumed)) : null;
  const next = /** @type {FileState} */ ({
    offset: start + consumed, size: bytes.length, mtimeMs: stat.mtimeMs, firstReadAt: entry?.firstReadAt ?? now, settleAt, carry: NO_CARRY,
    headBytes: head ? head.length : (entry?.headBytes ?? 0), headHash: head ? fingerprint(head) : (entry?.headHash ?? fingerprint(Buffer.alloc(0))),
  });
  return { text, next, heldBack, reread: plan.reason, bytes: consumed };
}

/**
 * @typedef {{ read: number, unchanged: number, absent: string[], failed: string[], calls: number, skippedLines: number, heldBack: number, bytes: number, reread: string[],
 *   added: number, rekeyed: number }} GhCallsReport
 */

/**
 * Ingest the ledgers, and key. The new calls are appended to the open store as ONE batch together with the calls already in it that are still unkeyed and could be: one that names a session (its next turn
 * may have been ingested since: a message is held back for five minutes), and one the time rule left as `ambiguous` or `no-turn` before #3589, which is now `script`. A call keyed once is not asked again. The state returned is to be saved AFTER the append. A ledger that cannot be
 * read is listed, never skipped quietly; one that is absent (an account that never called) is listed apart.
 * @param {{ ledgers: string[], store: ReturnType<typeof import("./store.mjs").openStore>, state: IngestState, now: number }} input
 * @returns {{ report: GhCallsReport, state: IngestState }}
 */
export function ingestGhCalls({ ledgers, store, state, now }) {
  const files = { ...state.files };
  /** @type {GhCallsReport} */
  const report = { read: 0, unchanged: 0, absent: [], failed: [], calls: 0, skippedLines: 0, heldBack: 0, bytes: 0, reread: [], added: 0, rekeyed: 0 };
  /** @type {Map<string, TraceEvent>} */
  const batch = new Map(store.events.filter((event) => event.kind === "gh_call" && event.keyedBy === null && (event.sessionId || event.unkeyed !== "script")).map((event) => [event.id, event]));
  for (const file of ledgers) {
    if (!existsSync(file)) {
      report.absent.push(file);
      continue;
    }
    try {
      const done = readLedger({ file, entry: state.files[file], now });
      if (!done) {
        report.unchanged += 1;
        continue;
      }
      const { calls, skipped } = callsOfLedgerText(done.text);
      for (const call of calls) batch.set(call.id, call);
      Object.assign(report, { read: report.read + 1, calls: report.calls + calls.length, skippedLines: report.skippedLines + skipped, heldBack: report.heldBack + done.heldBack, bytes: report.bytes + done.bytes });
      if (done.reread) report.reread.push(`${file}: ${done.reread}`);
      files[file] = done.next;
    } catch (cause) {
      report.failed.push(`${file}: ${/** @type {Error} */ (cause).message}`);
    }
  }
  const { added, superseded } = appendToStore(store, keyed([...batch.values()], store.events));
  return { report: { ...report, added, rekeyed: superseded }, state: { ...state, files } };
}

/** @param {TraceEvent} call a call's GraphQL points: what its response carried, else ONE for a call known (`graphql`) or inferred (`graphql?`) to spend that pool: the floor `../gh-ledger.mjs` reads it with */
const pointsOf = (call) => call.cost ?? (call.resource?.startsWith("graphql") ? 1 : 0);

/**
 * The calls' own account of themselves: how many, which pool, and how many points were READ from a response against how many are the floor of one per call whose response carried none.
 * @param {TraceEvent[]} calls
 */
export function summarize(calls) {
  const graphql = calls.filter((call) => call.resource?.startsWith("graphql"));
  return {
    calls: calls.length, graphql: graphql.length, core: calls.filter((call) => call.resource === "core").length, other: calls.filter((call) => !call.resource?.startsWith("graphql") && call.resource !== "core").length,
    points: graphql.reduce((sum, call) => sum + pointsOf(call), 0), read: graphql.reduce((sum, call) => sum + (call.cost ?? 0), 0), floorCalls: graphql.filter((call) => call.cost === null || call.cost === undefined).length,
    inferredPool: graphql.filter((call) => call.resource === "graphql?").length,
  };
}

/** @param {ReturnType<typeof summarize>} s */
const summaryText = (s) => `${s.calls} calls: ${s.graphql} on the GraphQL pool = ${s.points} points (${s.read} read from responses, ${s.floorCalls} calls FLOOR at 1 point each because the response carried no cost; `
  + `${s.inferredPool} of the pool assignments only inferred, \`graphql?\`), ${s.core} on core, ${s.other} other`;

/** The earliest call per account the store holds: a ledger is bounded, so a call older than its trim is gone and an absence before it is not "nothing was called". @param {TraceEvent[]} everything */
function heldFromLines(everything) {
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const call of everything) if (call.kind === "gh_call") first.set(call.account ?? "?", Math.min(first.get(call.account ?? "?") ?? Number.POSITIVE_INFINITY, call.at));
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length);
  return [...first].sort(([, a], [, b]) => a - b).map(([account, at]) => `  ${account.padEnd(22)} held from ${iso(at)}Z`);
}

/** @param {TraceEvent[]} unkeyed the calls of no row, ranked by points then calls: who burns the pool, by account and script */
function topCallers(unkeyed) {
  /** @type {Map<string, TraceEvent[]>} */
  const byCaller = new Map();
  for (const call of unkeyed) byCaller.set(`${call.account} ${call.script}`, [...(byCaller.get(`${call.account} ${call.script}`) ?? []), call]);
  return [...byCaller].map(([caller, calls]) => ({ caller, ...summarize(calls) })).sort((a, b) => b.points - a.points || b.calls - a.calls).slice(0, TOP_UNKEYED)
    .map((top) => `    ${String(top.points).padStart(7)} pts ${String(top.calls).padStart(6)} calls  ${top.caller}`);
}

/**
 * The `gh` call half of a report: the calls keyed to this row and the points they spent, then every call the store holds that is keyed to NO row, listed apart and never dropped, then from when the store
 * holds calls. `held` is every event of the store.
 * @param {{ events: TraceEvent[], held?: TraceEvent[] }} input `events` are the row's
 * @returns {string[]}
 */
export function ghCallLines({ events, held }) {
  const rowCalls = events.filter((event) => event.kind === "gh_call");
  const out = [`GH CALLS keyed to this row (by the session id on the line; a LOWER BOUND, because a call with no id, from a unit or from before the wrapper wrote one, is keyed to no row): ${rowCalls.length === 0 ? "none" : summaryText(summarize(rowCalls))}`];
  if (!held) return out;
  const everyCall = held.filter((event) => event.kind === "gh_call");
  const unkeyed = everyCall.filter((call) => call.keyedBy === null);
  const why = (/** @type {string} */ reason) => unkeyed.filter((call) => call.unkeyed === reason).length;
  out.push(`GH CALLS KEYED TO NO ROW, listed apart (${everyCall.length - unkeyed.length} of the store's ${everyCall.length} are keyed): ${unkeyed.length === 0 ? "none" : summaryText(summarize(unkeyed))}`,
    `  because: ${why("script")} carry no session id (a unit or script, or written before the wrapper named its session); ${why("no-turn")} name a session the store holds no later turn of yet`);
  if (unkeyed.length > 0) out.push("  the callers spending most of them, by account and script:", ...topCallers(unkeyed));
  out.push("GH CALLS HELD, per account (the earliest call the store holds; a ledger keeps 2 MiB, the newest half past it, so a call older than that is GONE):", ...heldFromLines(held));
  return out;
}

/** The ledger half of the ingest footer. @param {GhCallsReport} report */
export function ghIngestLines(report) {
  const lines = [`gh ledgers: ${report.read} read (${report.bytes} bytes parsed; ${report.unchanged} unchanged since the last run), ${report.calls} calls, ${report.skippedLines} lines skipped as no call, `
    + `${report.heldBack} lines of the last 2 s held back to the next run, ${report.added} new to the store, ${report.rekeyed} re-keyed or corrected`];
  for (const file of report.absent) lines.push(`  no ledger at ${file}: that account has made no call through the wrapper`);
  for (const file of report.failed) lines.push(`  failed: ${file}`);
  for (const reason of report.reread) lines.push(`  read again from byte 0: ${reason}`);
  return lines;
}
