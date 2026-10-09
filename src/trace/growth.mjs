// @ts-check
// a11ign/a11ign#4073 (#4055 move 7, measurement first): how much each REQUEST of a worker grew the window, attributed to the tool before it.
//
// WHY THIS IS A READER OF TRANSCRIPTS AND NOT OF THE STORE: a stored turn names no tool (only `toolRead`, for Read, Grep and Glob), so "which tool grew the window" is not
// a number the store holds. The transcript is the source the store itself is built from, read here with the store's own `readRecords` and `tokensOf`.
//
// WHAT IS MEASURED (`growth`): the change in `cacheRead` from the previous request of the same thread. MEASURED, not inferred: both are the API's own `usage`.
//
// THE ATTRIBUTION IS ONE REQUEST EARLIER THAN IT LOOKS, and that is the part a literal reading gets wrong. A request is sent the whole window again; what it ADDS to the window
// (the result of the tool before it) is WRITTEN to the cache by that request and is only READ by the next one. So `cacheRead(k) - cacheRead(k-1)` is what request k-1 wrote, and
// the tool that caused it is the one called by request k-2. Measured on one worker transcript (wt-3562, the first 14 requests): the delta equalled `cacheCreation` of the request
// before it, to the token, every time. Attributing the delta to the tool called by request k-1 would blame the NEXT tool for the PREVIOUS one's result.
//
// WHAT IS NOT DERIVABLE, and prints as such, never as 0:
//   first               the first request of a thread has no request before it.
//   after-compaction    the first request after a compaction summary, or after a `/clear`: the window was replaced, so a difference of two windows is not growth.
//   cache-shrank        `cacheRead` fell (the cache expired or was evicted); a negative growth is not a thing a tool did.
//   cache-rewritten     the request BEFORE shrank, so what this difference holds is the whole window written back to the cache, not a tool result.
//
// SIDECHAINS ARE THEIR OWN THREAD: a subagent's requests run on a window of their own, so they are never differenced against the parent's and never counted into its growth. The
// parent pays for a subagent only through the tool result it returns, which is attributed to `Agent` like any other.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "../lib/cli-flags.mjs";
import { sessionOf, transcriptFiles } from "../token-audit.ts";
import { isWake } from "../wakes-per-row.ts";
import { readRecords, tokensOf } from "./store.mjs";

export const DEFINITIONS = [
  "GROWTH (measured): a request's `cacheRead` less the previous request's, in the same thread. It is the tokens the previous request wrote to the cache, which a later request then pays to read.",
  "ATTRIBUTION: the tool called by the request BEFORE the one that wrote the tokens (two requests before the one measured), because a write is read one request late. `mixed` when that request called more than one distinct tool, `(prompt)` when an order or prompt came between, `(start of window)` when the writer was the first request of its window (the system prompt and, after a compaction, the summary).",
  "NOT DERIVABLE (never 0): the first request of a thread; the first after a compaction or a clear; a request whose `cacheRead` fell; a request whose predecessor's fell (the window was rewritten to the cache).",
  "THREAD: the main thread and a subagent's sidechain are separate sequences. Only the main thread is counted into a session's growth.",
  "POPULATION: the main-thread requests of transcripts whose session is named by their first order, in a window of the request's own time.",
];

/** Why a request has no growth. */
export const NOT_DERIVABLE = /** @type {const} */ ({
  FIRST: "first", AFTER_COMPACTION: "after-compaction", AFTER_CLEAR: "after-clear", SHRANK: "cache-shrank", REWRITTEN: "cache-rewritten",
});

export const START_OF_WINDOW = "(start of window)";
export const PROMPT = "(prompt)";
export const MIXED = "mixed";
/** The by-command labels that are not a command: a request that ran several different commands in parallel, and a command the splitter cannot read. */
export const SEVERAL_COMMANDS = "(several commands)";
export const UNPARSED = "(unparsed)";

/** @typedef {{ id: string, first: number, last: number, thread: "main" | "side", tools: string[], commands: string[], cacheRead: number, at: number }} Message */
/** @typedef {{ session: string, thread: "main" | "side", id: string, at: number, cacheRead: number, growth: number | null, reason: string | null, tool: string | null, calls: string[], commands: string[] }} Request */

/** @param {any} record @returns {string[]} one name per tool call the record's blocks make */
const toolNamesOf = (record) => (Array.isArray(record?.message?.content) ? record.message.content : [])
  .filter((/** @type {{ type?: string }} */ block) => block?.type === "tool_use").map((/** @type {{ name?: string }} */ block) => String(block.name));

/** @param {any} record @returns {string[]} the command of each Bash call the record's blocks make ("" for a call whose input names none, which reads as unparsed) */
const bashCommandsOf = (record) => (Array.isArray(record?.message?.content) ? record.message.content : [])
  .filter((/** @type {{ type?: string, name?: string }} */ block) => block?.type === "tool_use" && block.name === "Bash")
  .map((/** @type {{ input?: { command?: unknown } }} */ block) => (typeof block.input?.command === "string" ? block.input.command : ""));

/**
 * One message per `message.id` (the API message is written once per content block), in order: its usage is the last block's, and its tools are every block's.
 * @param {import("./store.mjs").Rec[]} records @returns {Message[]}
 */
export function messagesOf(records) {
  /** @type {Map<string, Message>} */
  const byId = new Map();
  for (const [position, { record, at }] of records.entries()) {
    const id = record?.type === "assistant" ? record.message?.id : null;
    if (!id || !record.message.usage) continue;
    const seen = byId.get(id);
    byId.set(id, {
      id, first: seen?.first ?? position, last: position, thread: record.isSidechain === true ? "side" : "main",
      tools: [...(seen?.tools ?? []), ...toolNamesOf(record)], commands: [...(seen?.commands ?? []), ...bashCommandsOf(record)], cacheRead: tokensOf(record.message.usage).cacheRead, at,
    });
  }
  return [...byId.values()];
}

/** @param {any} record whether the record replaces the window: a compaction summary, the harness's boundary marker, or the echo of a `/clear` */
function windowBreak(record) {
  if (record?.isCompactSummary === true || (record?.type === "system" && record.subtype === "compact_boundary")) return NOT_DERIVABLE.AFTER_COMPACTION;
  const content = record?.message?.content;
  return record?.type === "user" && typeof content === "string" && content.includes("<command-name>/clear</command-name>") ? NOT_DERIVABLE.AFTER_CLEAR : null;
}

/**
 * A marker resets the window of the thread it is written in: a subagent has a window of its own, so the parent's compaction does not reset it and its compaction does not reset the parent.
 * @param {import("./store.mjs").Rec[]} records @param {{ from: number, to: number, side: boolean }} span the records strictly between two messages of one thread @returns {string | null}
 */
function breakBetween(records, { from, to, side }) {
  for (const { record } of records.slice(from + 1, to)) {
    const found = (record?.isSidechain === true) === side ? windowBreak(record) : null;
    if (found !== null) return found;
  }
  return null;
}

/**
 * Whether the records of one thread between two messages hold only tool results (a prompt, an order or a summary there means the window grew by more than a tool's result).
 * Kept beside its twin in `store.mjs` because that one is private to it.
 * @param {import("./store.mjs").Rec[]} records @param {{ from: number, to: number, side: boolean }} span
 */
function onlyToolResults(records, { from, to, side }) {
  return records.slice(from + 1, to).every(({ record }) => record?.type !== "user" || (record.isSidechain === true) !== side
    || (Array.isArray(record.message?.content) && record.message.content.some((/** @type {{ type?: string }} */ block) => block?.type === "tool_result")));
}

/** @param {string[]} tools the tools one request called @returns {string} */
const toolLabel = (tools) => {
  const distinct = [...new Set(tools)];
  return distinct.length === 1 ? distinct[0] : MIXED;
};

/** @typedef {{ prior: Message, writer: string, writerCalls: string[], writerCommands: string[], priorShrank: boolean }} ThreadState */

/**
 * What caused the tokens that `message` is the first to be written at: the tool called by the request before it when only that tool's results came between, else a prompt.
 * @param {import("./store.mjs").Rec[]} records @param {{ prior: Message, message: Message }} pair @returns {{ writer: string, writerCalls: string[], writerCommands: string[] }}
 */
function writerOf(records, { prior, message }) {
  const clean = prior.tools.length > 0 && onlyToolResults(records, { from: prior.last, to: message.first, side: message.thread === "side" });
  return clean
    ? { writer: toolLabel(prior.tools), writerCalls: [...new Set(prior.tools)].sort(), writerCommands: prior.commands }
    : { writer: PROMPT, writerCalls: [], writerCommands: [] };
}

/**
 * The request's growth and its reason, given the thread's state.
 * @param {ThreadState} state @param {Message} message @returns {{ growth: number | null, reason: string | null }}
 */
function growthOf(state, message) {
  const delta = message.cacheRead - state.prior.cacheRead;
  if (delta < 0) return { growth: null, reason: NOT_DERIVABLE.SHRANK };
  if (state.priorShrank) return { growth: null, reason: NOT_DERIVABLE.REWRITTEN };
  return { growth: delta, reason: null };
}

/** @param {string} session @param {Message} message @param {Partial<Request>} fields @returns {Request} */
const requestOf = (session, message, fields) => ({
  session, thread: message.thread, id: message.id, at: message.at, cacheRead: message.cacheRead, growth: null, reason: null, tool: null, calls: [], commands: [], ...fields,
});

/**
 * Every request of a transcript with its growth. `session` names the seat; a request's growth is read against the previous request of ITS thread, so a subagent's are not between the parent's.
 * @param {string} text one transcript @param {string} session
 * @returns {Request[]}
 */
export function requestsOf(text, session) {
  const { records } = readRecords(text);
  /** @type {{ main: ThreadState | null, side: ThreadState | null }} */
  const states = { main: null, side: null };
  return messagesOf(records).map((message) => {
    const state = states[message.thread];
    const reset = state === null ? NOT_DERIVABLE.FIRST : breakBetween(records, { from: state.prior.last, to: message.first, side: message.thread === "side" });
    if (state === null || reset !== null) {
      states[message.thread] = { prior: message, writer: START_OF_WINDOW, writerCalls: [], writerCommands: [], priorShrank: false };
      return requestOf(session, message, { reason: reset });
    }
    const { growth, reason } = growthOf(state, message);
    states[message.thread] = { prior: message, ...writerOf(records, { prior: state.prior, message }), priorShrank: reason === NOT_DERIVABLE.SHRANK };
    return requestOf(session, message, { growth, reason, tool: growth === null ? null : state.writer, calls: growth === null ? [] : state.writerCalls,
      commands: growth === null ? [] : state.writerCommands,
    });
  });
}

/** The seat a transcript belongs to: the name in its first order, as the store reads it. @param {string} text @returns {string | null} */
export function sessionOfTranscript(text) {
  const { records } = readRecords(text);
  const order = records.find(({ record }) => isWake(record) && sessionOf(record.message.content) !== null);
  return order ? sessionOf(order.record.message.content) : null;
}

// THE COMMAND OF A BASH CALL (`--by-command`): its FIRST command's first word, and for `gh`, `git`, `pnpm` their first subcommand, because "Bash" is every shell command at once and `git status`
// and `git log` are not one thing to cap. A piped or chained line (`a | b`, `a && b`, `a; b`) is its first command: the rest is not read, so a request is never split across two names.
// SETUP IS NOT THE COMMAND: a bare assignment (`S=/tmp/x; …`), `export`, `set` and a `cd <dir> &&` before the real command are skipped. Measured on the week of #4073, read literally they were 61% of the Bash growth
// (`cd` 48.3%, `(unparsed)` 12.8%) and named nothing to cap. A command the splitter cannot read (an unbalanced quote, `$(…)`, an empty call) is `(unparsed)` and keeps its tokens there, never under another's name.
const WORD = /(?:[0-9]*[<>]+&[0-9-]*|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\s"'\\|;&])+/y;
const OPERATOR = /\|\||&&|[|;&\n]/y;
const SPACE = /[ \t]*/y;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_NAME = /^[\w./~@[-]/;
const SETUP_COMMANDS = new Set(["cd", "pushd", "export", "set"]);
const SUBCOMMAND_TOOLS = new Set(["gh", "git", "pnpm"]);
/** Flags of those tools that take a value, which the first subcommand lies past (`git -C <dir> status`, `gh -R <repo> pr list`, `pnpm --filter <pkg> test`). */
const VALUE_FLAGS = new Set(["-C", "-c", "-R", "--repo", "--git-dir", "--work-tree", "--filter", "-F", "--dir"]);

/** @param {string} word @returns {string} the word without its quotes and escapes (enough for a command's name, not a shell's reading of it) */
const unquote = (word) => word.replace(/\\([\s\S])/g, "$1").replace(/["']/g, "");

/** @param {string} path @returns {string} the file's own name, so `/usr/bin/git` and `git` are one command */
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The simple commands of a shell line in order, each as its words, split at `|`, `||`, `&`, `&&`, `;` and newline outside quotes. Lazy, so a later segment is read only if the earlier ones were setup.
 * @param {string} line @returns {Generator<string[] | null>} null, once, when a quote is left open or a character is neither a word nor an operator
 */
export function* segmentsOf(line) {
  const text = line.replace(/\\\n/g, " ").trim();
  /** @type {string[]} */
  let words = [];
  let at = 0;
  while (at < text.length) {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    WORD.lastIndex = SPACE.lastIndex;
    const word = WORD.exec(text)?.[0];
    if (word !== undefined) {
      words.push(word);
      at = WORD.lastIndex;
      continue;
    }
    OPERATOR.lastIndex = SPACE.lastIndex;
    if (!OPERATOR.test(text)) return void (yield null);
    yield words;
    words = [];
    at = OPERATOR.lastIndex;
  }
  yield words;
}

/** @param {string[]} args @returns {string | null} the first argument that is not a flag, past the value of a flag that takes one */
function subcommandOf(args) {
  for (let at = 0; at < args.length; at += 1) {
    if (VALUE_FLAGS.has(args[at])) at += 1;
    else if (!args[at].startsWith("-")) return args[at];
  }
  return null;
}

/** @param {string[]} words a segment's words, its leading `VAR=value` assignments and `(` removed @returns {string} */
function nameOfSegment(words) {
  const [name, ...args] = words.map(unquote);
  const command = baseName(name).replace(/\)+$/, "");
  // `node` has no subcommand: what it runs is its first argument, a flag (`node -e`, `node --test`) or a script (`node growth.mjs`).
  const next = command === "node" ? args[0] : SUBCOMMAND_TOOLS.has(command) ? subcommandOf(args) : null;
  return next === null || next === undefined ? command : `${command} ${baseName(next)}`;
}

/** @param {string[]} words @returns {string[]} the words past the leading assignments (`FOO=1 cmd`) and a subshell's opening `(` */
function afterPrefix(words) {
  const rest = [...words];
  while (rest.length > 0 && ENV_ASSIGNMENT.test(rest[0])) rest.shift();
  if (rest.length > 0) rest[0] = rest[0].replace(/^\(+/, "");
  return rest[0] === "" ? rest.slice(1) : rest;
}

/**
 * The command a Bash call ran, as the by-command table names it: the first segment that is not setup, else the first setup command (a call of only `cd`), else `(unparsed)`.
 * @param {string} line the call's `command` input @returns {string}
 */
export function commandName(line) {
  let setup = null;
  for (const segment of segmentsOf(line)) {
    if (segment === null) return UNPARSED;
    const words = afterPrefix(segment);
    if (words.length === 0) continue;
    const name = nameOfSegment(words);
    if (!COMMAND_NAME.test(name) || baseName(unquote(words[0])) === "") return UNPARSED;
    if (!SETUP_COMMANDS.has(name)) return name;
    setup ??= name;
  }
  return setup ?? UNPARSED;
}

/** @param {Request} request a request whose tool is Bash @returns {string} its one command, or `(several commands)` when it ran different ones in parallel */
export function commandOf(request) {
  const names = new Set(request.commands.map(commandName));
  return names.size === 1 ? [...names][0] : names.size === 0 ? UNPARSED : SEVERAL_COMMANDS;
}

/** @typedef {{ requests: number, tokens: number, share: number }} Total */

/** @param {Request[]} requests @param {(request: Request) => string} key @returns {Map<string, { requests: number, tokens: number }>} */
function totalsBy(requests, key) {
  /** @type {Map<string, { requests: number, tokens: number }>} */
  const totals = new Map();
  for (const request of requests) {
    const total = totals.get(key(request)) ?? { requests: 0, tokens: 0 };
    totals.set(key(request), { requests: total.requests + 1, tokens: total.tokens + (request.growth ?? 0) });
  }
  return totals;
}

/**
 * The table's numbers: growth by tool and by session over the main-thread requests that HAVE a growth, and a count of each reason one does not. A request with no growth adds nothing
 * to any total and is counted apart, so a share is a share of what could be read, and `coverage` says how much that was.
 * @param {Request[]} requests
 */
export function summarise(requests) {
  const main = requests.filter((request) => request.thread === "main");
  const read = main.filter((request) => request.growth !== null);
  const tokens = read.reduce((sum, request) => sum + (request.growth ?? 0), 0);
  const bash = read.filter((request) => request.tool === "Bash");
  const bashTokens = bash.reduce((sum, request) => sum + (request.growth ?? 0), 0);
  const rank = (/** @type {Map<string, { requests: number, tokens: number }>} */ totals, /** @type {number} */ whole = tokens) => [...totals]
    .map(([name, total]) => ({ name, ...total, share: whole === 0 ? 0 : total.tokens / whole })).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  /** @type {Record<string, number>} */
  const notDerivable = {};
  for (const request of main) if (request.reason !== null) notDerivable[request.reason] = (notDerivable[request.reason] ?? 0) + 1;
  return {
    requests: main.length, read: read.length, tokens, coverage: main.length === 0 ? 0 : read.length / main.length, notDerivable,
    sidechainRequests: requests.length - main.length, byTool: rank(totalsBy(read, (request) => request.tool ?? "")),
    bashTokens, bashRequests: bash.length, byCommand: rank(totalsBy(bash, commandOf), bashTokens), bySession: rank(totalsBy(read, (request) => request.session)),
  };
}

const PERCENT = 100;
const pct = (/** @type {number} */ fraction) => `${(fraction * PERCENT).toFixed(1)}%`;
const thousands = (/** @type {number} */ n) => n.toLocaleString("en-US");

/** @param {ReturnType<typeof summarise>["byTool"]} rows @param {string} label @param {string} [shareOf] what the share column is a share of @returns {string[]} */
function tableOf(rows, label, shareOf = "share") {
  return [`| ${label} | requests | growth tokens | ${shareOf} | mean per request |`, "|---|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.name} | ${thousands(row.requests)} | ${thousands(row.tokens)} | ${pct(row.share)} | ${thousands(Math.round(row.tokens / row.requests))} |`)];
}

const TOP_SESSIONS = 15;
const TOP_COMMANDS = 30;
const OTHER_COMMANDS = "(other commands)";

/**
 * The Bash row of the table above, split by command: the first `TOP_COMMANDS`, the rest folded into one row so the printed rows still sum to the Bash line, and the sum check printed beside them.
 * @param {ReturnType<typeof summarise>} summary @returns {string[]}
 */
function byCommandSection(summary) {
  const { byCommand, bashTokens, bashRequests } = summary;
  const rest = byCommand.slice(TOP_COMMANDS);
  const folded = rest.length === 0 ? [] : [{
    name: `${OTHER_COMMANDS}: ${thousands(rest.length)}`, requests: rest.reduce((sum, row) => sum + row.requests, 0), tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
    share: rest.reduce((sum, row) => sum + row.share, 0),
  }];
  const rows = [...byCommand.slice(0, TOP_COMMANDS), ...folded];
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const bashRow = summary.byTool.find((row) => row.name === "Bash");
  const agrees = tokens === bashTokens && requests === bashRequests && tokens === (bashRow?.tokens ?? 0) && requests === (bashRow?.requests ?? 0);
  return [
    "## Bash by command", "",
    "The `Bash` row above, split by the command's first word (`gh`, `git`, `pnpm` by their first subcommand, `node` by what it runs); a piped or chained line is its first command.", "",
    ...tableOf(rows, "command", "share of Bash"), "",
    `Sum check: the rows above total ${thousands(requests)} requests and ${thousands(tokens)} tokens; the Bash row of the table by tool is ${thousands(bashRow?.requests ?? 0)} and ${thousands(bashRow?.tokens ?? 0)}: ${agrees ? "EQUAL" : "NOT EQUAL"}.`, "",
  ];
}

/**
 * @param {ReturnType<typeof summarise>} summary @param {{ from: number, to: number, root: string, sessions: string, transcripts: number, byCommand?: true }} reading the command's own inputs, printed so the table can be re-asked; `byCommand` adds the Bash split
 * @returns {string}
 */
export function renderGrowth(summary, reading) {
  const reasons = Object.entries(summary.notDerivable).map(([why, n]) => `${why} ${thousands(n)}`).join(", ") || "none";
  return [
    `# Worker context growth per request, by the tool before it`, "",
    `Window ${new Date(reading.from).toISOString()} to ${new Date(reading.to).toISOString()}; sessions matching \`${reading.sessions}\`; ${thousands(reading.transcripts)} transcripts under \`${reading.root}\`. Measured from each request's own usage.`, "",
    `${thousands(summary.requests)} main-thread requests; growth was derivable for ${thousands(summary.read)} (${pct(summary.coverage)}) and totals ${thousands(summary.tokens)} tokens. Not derivable: ${reasons}. Subagent (sidechain) requests, not counted: ${thousands(summary.sidechainRequests)}.`, "",
    "## By tool", "", ...tableOf(summary.byTool, "tool"), "",
    ...(reading.byCommand === true ? byCommandSection(summary) : []),
    `## By session (top ${TOP_SESSIONS} of ${summary.bySession.length})`, "", ...tableOf(summary.bySession.slice(0, TOP_SESSIONS), "session"), "",
  ].join("\n");
}

/** @typedef {{ from: number, to: number, root: string, sessions: string }} Query */

/** @param {string[]} argv @returns {Query} */
export function parseArgs(argv) {
  const usage = "usage: growth --from=<ISO> --to=<ISO> [--root=<dir of transcripts>] [--sessions=<regex, default ^worker-[0-9]+$>] [--by-command]";
  const from = Date.parse(flagValue(argv, "from") ?? "");
  const to = Date.parse(flagValue(argv, "to") ?? "");
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error(`${usage}\n--from and --to must be ISO times with from < to`);
  return { from, to, root: flagValue(argv, "root") ?? join(homedir(), ".claude", "projects"), sessions: flagValue(argv, "sessions") ?? "^worker-[0-9]+$" };
}

/**
 * Every request in the window of every transcript whose seat matches. A transcript last written before `from` cannot hold one, and is not read.
 * @param {Query} query @returns {{ requests: Request[], transcripts: number }}
 */
export function readGrowth({ from, to, root, sessions }) {
  const wanted = new RegExp(sessions);
  /** @type {Request[]} */
  const requests = [];
  let transcripts = 0;
  for (const file of transcriptFiles(root)) {
    if (statSync(file).mtimeMs < from) continue;
    const text = readFileSync(file, "utf8");
    const session = sessionOfTranscript(text);
    if (session === null || !wanted.test(session)) continue;
    transcripts += 1;
    requests.push(...requestsOf(text, session).filter((request) => request.at >= from && request.at < to));
  }
  return { requests, transcripts };
}

function main() {
  refuseUnknownFlags(["--from", "--to", "--root", "--sessions", "--by-command"], { entry: import.meta.url, command: "node src/trace/growth.mjs" });
  const query = parseArgs(process.argv.slice(2));
  const { requests, transcripts } = readGrowth(query);
  const byCommand = process.argv.includes("--by-command") ? { byCommand: /** @type {const} */ (true) } : {};
  process.stdout.write(`${renderGrowth(summarise(requests), { ...query, transcripts, ...byCommand })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
