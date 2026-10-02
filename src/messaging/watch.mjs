// @ts-check
// `messaging:watch` (a11ign/a11ign#2903, done-when 5): THE ONE-SHOT PROGRAM THE `chairman-watch` TIMER RUNS. It reads GitHub, asks each
// source what the chairman should be told, and hands the events to the core. A LEAF module, like the rest of `src/messaging/`.
//
// **IT MAKES READ CALLS AND NOTHING ELSE, AND THE BAN IS IN CODE, NOT IN A COMMENT.** The reader it is given has three methods and all of
// them list; `createGhReader` builds its commands from an allowlist (`assertReadOnlyGh`) that refuses any `gh` verb but `issue list` and
// `pr list` and any flag outside a short list, so a later edit that reaches for `gh issue comment` fails in the reader, before a process
// is started. `watch.test.mjs`'s fixture reader throws on every method outside the three, and the run is asserted never to touch one.
//
// **THE ACCOUNT IS THE UNIT'S, NEVER THE PERSON'S (#1967).** The service declares `GH_CONFIG_DIR`; an agent workspace reaches the workers'
// account through the `gh` routing wrapper by its workspace id. With neither, `gh` would fall back to a person's stored credentials, so
// `main` refuses to start rather than spend them.
//
// **A SOURCE THAT FAILS IS SKIPPED FOR THE TICK, AND THE OTHERS RUN.** Its events are not partly emitted: a request source that could not
// read the labelled rows must emit no "resolved" event (see requests.mjs), and a summary that could read nothing sends nothing. The
// failure is logged and the exit code is 1, so the unit shows failed; the next tick starts clean.
//
// **THE PROVIDER IS INJECTED, AND NONE IS REGISTERED YET.** The Telegram provider is row 3 (#2902) and its going live is row 6 (#2905). Until
// then a configured `messaging` key names a provider this program cannot construct, and it says so and exits 1, which is what the
// service template promised `host:check` would show.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { MessagingConfigRefusal, PROJECT_FILE, readMessagingConfig } from "./config.mjs";
import { createMessenger } from "./core.mjs";
import { createLedger, describeError, foldLedger } from "./ledger.mjs";
import { observeSummary } from "./sources/summary.mjs";
import { parseRequestKey, readRequests } from "./sources/requests.mjs";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64_000_000;
const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const IDLE_ACTIONS = new Set(["duplicate", "held", "already-cleared", "resolved-before-sent"]);
const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });

/** The only methods a reader has. A fixture reader that throws on every OTHER name is how the tests prove the run is read-only. */
export const READ_METHODS = Object.freeze(["issuesLabelled", "mergedPullsSince", "redPulls"]);

const ALLOWED_VERBS = new Set(["issue list", "pr list"]);
const ALLOWED_FLAGS = new Set(["-R", "--label", "--state", "--search", "--json", "--limit"]);

/**
 * @param {readonly string[]} argv the arguments after `gh`
 * @throws {Error} when the command is anything but a list, or carries a flag the readers do not use
 */
export function assertReadOnlyGh(argv) {
  const verb = argv.slice(0, 2).join(" ");
  if (!ALLOWED_VERBS.has(verb)) throw new Error(`chairman-watch reads only: \`gh ${verb}\` is not an allowed command`);
  const stray = argv.slice(2).find((token) => token.startsWith("-") && !ALLOWED_FLAGS.has(token));
  if (stray !== undefined) throw new Error(`chairman-watch reads only: \`gh ${verb} ${stray}\` is not an allowed flag`);
}

/** @param {readonly string[]} argv @returns {Promise<string>} what `gh` printed; the environment (and so the account) is the process's own */
async function runGh(argv) {
  const { stdout } = await execFileAsync("gh", [...argv], { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8" });
  return stdout;
}

/** @typedef {{ name?: string, context?: string, conclusion?: string, state?: string, startedAt?: string, completedAt?: string }} Check */

/** @param {Check} check @returns {number} when the check last moved, for ordering attempts of the same check */
function checkTime(check) {
  return Date.parse(check.completedAt ?? check.startedAt ?? "") || 0;
}

/**
 * The rollup unions every attempt ever made, so a check that failed and was re-run green is still in it as a failure. A raw read would
 * call that pull request red; only the NEWEST attempt of each named check counts (a check run has `name`, a commit status `context`).
 *
 * @param {Check[]} rollup @returns {Check[]}
 */
function newestPerName(rollup) {
  /** @type {Map<string, Check>} */
  const newest = new Map();
  for (const [index, check] of rollup.entries()) {
    const name = check.name ?? check.context ?? `unnamed-${index}`;
    const held = newest.get(name);
    if (held === undefined || checkTime(check) >= checkTime(held)) newest.set(name, check);
  }
  return [...newest.values()];
}

/** @param {{ statusCheckRollup?: Check[] }} pull @returns {boolean} */
function isRed(pull) {
  return newestPerName(pull.statusCheckRollup ?? []).some((check) => FAILING_CONCLUSIONS.has(String(check.conclusion)) || FAILING_STATES.has(String(check.state)));
}

/**
 * The real reader, over `gh`. `run` is injected so a test owns it, and every command it is given has been through `assertReadOnlyGh`.
 *
 * @param {{ run?: (argv: readonly string[]) => Promise<string> }} [deps]
 */
export function createGhReader({ run = runGh } = {}) {
  /** @param {string[]} argv @returns {Promise<any[]>} */
  async function list(argv) {
    assertReadOnlyGh(argv);
    return JSON.parse(await run(argv));
  }
  return {
    /** @param {{ repo: string, label: string, comments?: boolean, limit?: number }} query */
    issuesLabelled({ repo, label, comments = false, limit = 100 }) {
      const fields = comments ? "number,title,url,updatedAt,comments" : "number,title,url,updatedAt";
      return list(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--json", fields, "--limit", String(limit)]);
    },
    /** @param {{ repo: string, sinceMs: number, limit?: number }} query */
    async mergedPullsSince({ repo, sinceMs, limit = 100 }) {
      const since = new Date(sinceMs).toISOString();
      const pulls = await list(["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${since}`, "--json", "number,mergedAt", "--limit", String(limit)]);
      // The search qualifier is the filter and this is the check on it: a count of "merged in 24 h" must not include a merge from last week.
      return pulls.filter((pull) => Date.parse(pull.mergedAt) >= sinceMs);
    },
    /** @param {{ repo: string, limit?: number }} query */
    async redPulls({ repo, limit = 100 }) {
      return (await list(["pr", "list", "-R", repo, "--state", "open", "--json", "number,statusCheckRollup", "--limit", String(limit)])).filter(isRed);
    },
  };
}

/** @typedef {{ reason: string, key?: string }} Note  A `key` marks a note about one thing, logged once per distinct reason and not once per tick. */

/** @typedef {{ github: any, repo: string, now: number, openKeys: string[], summary: { at: string, timezone: string } }} SourceContext */
/** @typedef {{ name: string, observe: (context: SourceContext) => Promise<{ events: Record<string, unknown>[], notes: Note[] }> }} Source */

/** @type {Source} */
const REQUESTS = {
  name: "requests",
  async observe({ github, repo, now, openKeys }) {
    const { events, problems } = await readRequests({ github, repo, openKeys, now });
    return { events, notes: problems.map(({ key, reason }) => ({ key, reason: `chairman-options: ${reason}` })) };
  },
};

/** @type {Source} */
const SUMMARY = {
  name: "summary",
  async observe({ github, repo, now, summary }) {
    const { events, unread } = await observeSummary({ github, repo, now, summary });
    return { events, notes: unread.map((reason) => ({ reason: `summary read: ${reason}` })) };
  },
};

/** The sources this program asks, in order. Row 5 (#2904) adds its incident and stall readers here. */
export const DEFAULT_SOURCES = Object.freeze([REQUESTS, SUMMARY]);

/** @param {Map<string, import("./ledger.mjs").KeyRecord>} state @returns {string[]} the request keys the chairman has been told about and not told cleared */
function openRequestKeys(state) {
  return [...state].filter(([key, record]) => record.open && parseRequestKey(key) !== null).map(([key]) => key);
}

/** @param {Record<string, any>[]} history @param {Note} note @returns {boolean} whether this exact note about this key is already on the record */
function alreadyNoted(history, note) {
  return history.some((line) => line.status === "invalid" && line.kind === "source-note" && line.key === note.key && line.error === note.reason);
}

/**
 * A note about one KEY is written to the ledger once per distinct reason, so a malformed options block is named when it appears and not
 * every five minutes until somebody edits the comment. A note with no key is a reading of the moment (a read failed) and is logged each time.
 *
 * @param {{ notes: Note[], ledger: ReturnType<typeof createLedger>, history: Record<string, any>[], log: (line: string) => void }} input
 */
function recordNotes({ notes, ledger, history, log }) {
  for (const note of notes) {
    if (note.key === undefined) {
      log(note.reason);
    } else if (!alreadyNoted(history, note)) {
      ledger.append({ key: note.key, status: "invalid", kind: "source-note", error: note.reason });
      log(`${note.key}: ${note.reason}`);
    }
  }
}

/**
 * @param {SourceContext} context @param {readonly Source[]} sources
 * @returns {Promise<{ events: Record<string, unknown>[], notes: Note[], failures: string[] }>}
 */
async function gather(context, sources) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {Note[]} */
  const notes = [];
  /** @type {string[]} */
  const failures = [];
  for (const source of sources) {
    try {
      const observed = await source.observe(context);
      events.push(...observed.events);
      notes.push(...observed.notes);
    } catch (error) {
      failures.push(`${source.name}: ${describeError(error)}`);
    }
  }
  return { events, notes, failures };
}

/**
 * One pass: observe, then tell. Everything it touches comes in as an argument, so a test owns the clock, the ledger, the reader and the
 * provider.
 *
 * @param {{ github: any, provider: any, ledger: ReturnType<typeof createLedger>, now: () => number, repo: string,
 *           summary: { at: string, timezone: string }, log?: (line: string) => void, sources?: readonly Source[], coreConfig?: object }} input
 * @returns {Promise<{ decisions: { key: string, action: string }[], failures: string[] }>}
 */
export async function runWatch({ github, provider, ledger, now, repo, summary, log = () => {}, sources = DEFAULT_SOURCES, coreConfig }) {
  const history = ledger.read();
  const openKeys = openRequestKeys(foldLedger(history));
  const { events, notes, failures } = await gather({ github, repo, now: now(), openKeys, summary }, sources);
  recordNotes({ notes, ledger, history, log });
  const messenger = createMessenger({ provider, ledger, now, config: /** @type {any} */ (coreConfig) });
  const decisions = await messenger.tick(events);
  for (const failure of failures) log(failure);
  return { decisions, failures };
}

/** @param {string} root @returns {string} the first tracker's repository: the rows the chairman is asked about are filed there */
export function trackerRepo(root) {
  const path = join(root, PROJECT_FILE);
  const declared = JSON.parse(readFileSync(path, "utf8"))?.tracker?.[0]?.repo;
  if (typeof declared !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(declared)) throw new Error(`${path}: tracker[0].repo is not an owner/name`);
  return declared;
}

/** @param {string} home @returns {string} where the delivery log lives: state, not configuration, so apart from the secrets' directory */
export function defaultLedgerPath(home) {
  return join(home, ".local", "state", "agent-org", "messaging", "ledger.jsonl");
}

/** @param {Record<string, string | undefined>} env @returns {boolean} some account is DECLARED, so `gh` will not fall back to a person's */
function accountIsDeclared(env) {
  return Boolean(env.GH_CONFIG_DIR) || Boolean(env.HERDR_WORKSPACE_ID);
}

/** @param {string} root @param {string} home @param {(line: string) => void} err @returns {ReturnType<typeof readMessagingConfig> | null} null after saying why */
function loadConfig(root, home, err) {
  try {
    return readMessagingConfig(resolve(root), { home });
  } catch (error) {
    if (!(error instanceof MessagingConfigRefusal)) throw error;
    err(`messaging:watch: ${error.message}`);
    return null;
  }
}

/** @param {{ decisions: { action: string }[], failures: string[] }} result @returns {number} */
function exitCodeOf({ decisions, failures }) {
  const refused = decisions.some(({ action }) => action === "failed" || action === "invalid");
  return failures.length > 0 || refused ? EXIT.failed : EXIT.ok;
}

/**
 * @param {{ config: import("./config.mjs").MessagingOn, env: Record<string, string | undefined>, github: unknown, providers: Record<string, unknown> }} input
 * @returns {{ code: number, message: string } | null} why this program will not start, or null
 */
function refusalToStart({ config, env, github, providers }) {
  if (github === undefined && !accountIsDeclared(env)) {
    return { code: EXIT.refused, message: "no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to read as whoever `gh` last logged in as (#1967)" };
  }
  if (providers[config.provider] === undefined) {
    return { code: EXIT.failed, message: `messaging.provider is "${config.provider}" and this program has no implementation of it yet (row 3, a11ign/a11ign#2902)` };
  }
  return null;
}

/** What a caller may leave out. A spread and not parameter defaults: each default is a branch, and `main` was past the complexity limit. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: process.env, home: homedir(), now: Date.now, github: /** @type {any} */ (undefined), providers: /** @type {Record<string, (config: any) => any>} */ ({}),
  out: (/** @type {string} */ line) => console.log(line), err: (/** @type {string} */ line) => console.error(line),
});

/**
 * @param {{ root?: string, env?: Record<string, string | undefined>, home?: string, now?: () => number, github?: any,
 *           providers?: Record<string, (config: any) => any>, out?: (line: string) => void, err?: (line: string) => void }} [deps]
 * @returns {Promise<number>} the exit code: 0 done (or off), 1 something failed this tick, 2 refused to start
 */
export async function main(deps = {}) {
  const { root, env, home, now, github, providers, out, err } = { ...DEFAULT_DEPS(), ...deps };
  const config = loadConfig(root, home, err);
  if (config === null) return EXIT.refused;
  // OFF IS SILENT AND CONSTRUCTS NOTHING: no reader, no provider, no ledger directory.
  if (!config.enabled) return EXIT.ok;
  const refusal = refusalToStart({ config, env, github, providers });
  if (refusal !== null) {
    err(`messaging:watch: ${refusal.message}`);
    return refusal.code;
  }
  const result = await runWatch({
    github: github ?? createGhReader(), provider: await providers[config.provider](config), repo: trackerRepo(root), summary: config.summary,
    ledger: createLedger({ path: defaultLedgerPath(home), now }), now, log: err,
  });
  for (const { key, action } of result.decisions) if (!IDLE_ACTIONS.has(action)) out(`${key}: ${action}`);
  return exitCodeOf(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
