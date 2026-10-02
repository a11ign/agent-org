// @ts-check
// `messaging:watch` (a11ign/a11ign#2903, done-when 5): THE ONE-SHOT PROGRAM THE `chairman-watch` TIMER RUNS. It reads GitHub, asks each
// source what the chairman should be told, and hands the events to the core. A LEAF module, like the rest of `src/messaging/`.
//
// **IT MAKES READ CALLS AND NOTHING ELSE, AND THE BAN IS IN CODE, NOT IN A COMMENT.** The reader it is given has four methods and all of
// them read; `createGhReader` builds its commands from an allowlist (`assertReadOnlyGh`) that refuses any `gh` verb but `issue list`,
// `issue view` and `pr list` and any flag outside a short list, so a later edit that reaches for `gh issue comment` fails in the reader, before a process
// is started. the fixture reader in `sources/requests.test.mjs` throws on every method outside `READ_METHODS`, and the run is asserted never to touch one.
//
// **THE ACCOUNT IS THE UNIT'S, NEVER THE PERSON'S (#1967).** The service declares `GH_CONFIG_DIR`; an agent workspace reaches the workers'
// account through the `gh` routing wrapper by its workspace id. With neither, `gh` would fall back to a person's stored credentials, so
// `main` refuses to start rather than spend them.
//
// **A SOURCE THAT FAILS IS SKIPPED FOR THE TICK, AND THE OTHERS RUN.** Its events are not partly emitted: a request source that could not
// read the labelled rows must emit no "resolved" event (see requests.mjs), and a summary that could read nothing sends nothing. The
// failure is logged and the exit code is 1, so the unit shows failed; the next tick starts clean.
//
// **THE STALL AND INCIDENT SOURCES RUN HERE TOO (a11ign/a11ign#3008)**, over the readers in `sources/readers.mjs`: `main` builds them for a real host (GitHub on
// the core pool through `gh api`, systemd, herdr and the fleet-watch state file) and `runWatch` asks them after the two label sources. The `gh api` calls a
// run makes are listed in `docs/messaging.md`; the allowlist admits only a GET of the six REST paths they use.
//
// **THE PROVIDER IS INJECTED, AND NONE IS REGISTERED YET.** The Telegram provider is row 3 (#2902) and its going live is row 6 (#2905). Until
// then a configured `messaging` key names a provider this program cannot construct, and it says so and exits 1, which is what the
// service template promised `host:check` would show.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { MessagingConfigRefusal, PROJECT_FILE, readMessagingConfig } from "./config.mjs";
import { createMessenger } from "./core.mjs";
import { createLedger, describeError, foldLedger } from "./ledger.mjs";
import { observeIncidents } from "./sources/incidents.mjs";
import { createReaders } from "./sources/readers.mjs";
import { observeStalls } from "./sources/stall.mjs";
import { observeSummary } from "./sources/summary.mjs";
import { parseRequestKey, readRequests } from "./sources/requests.mjs";
import { readUnitsDeclaration, stateEntryPath } from "../host-config.mjs";
import { readAgents } from "../herdr-agents.mjs";
import { completionPath } from "../lib/tick-completion.mjs";
import { isBrokenRed } from "../red-pr.mjs";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER = 64_000_000;
const IDLE_ACTIONS = new Set(["duplicate", "held", "already-cleared", "resolved-before-sent"]);
const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });

/** The only methods a reader has. A fixture reader that throws on every OTHER name is how the tests prove the run is read-only. */
export const READ_METHODS = Object.freeze(["issuesLabelled", "issueComments", "mergedPullsSince", "redPulls"]);

const ALLOWED_VERBS = new Set(["issue list", "issue view", "pr list"]);
const ALLOWED_FLAGS = new Set(["-R", "--label", "--state", "--search", "--json", "--limit"]);
/** The REST paths `gh api` may be given, after `repos/<owner>/<name>/`: the ones `sources/readers.mjs` reads, each a listing or a lookup. */
const READ_API_PATH = /^repos\/[\w.-]+\/[\w.-]+\/(pulls|issues|actions\/runs|actions\/workflows\/[\w.-]+\/runs|actions\/runs\/\d+\/jobs|check-runs\/\d+\/annotations)(\?[\w=&.,%:-]*)?$/;

/**
 * `gh api <path>` and nothing after the path: a GET is the default and every flag that would change it (`-X`, `-f`, `-F`, `--input`) is a token this refuses.
 * @param {readonly string[]} argv
 */
function assertReadOnlyApi(argv) {
  if (argv.length !== 2 || !READ_API_PATH.test(argv[1])) throw new Error(`chairman-watch reads only: \`gh api ${argv.slice(1).join(" ")}\` is not an allowed read`);
}

/**
 * @param {readonly string[]} argv the arguments after `gh`
 * @throws {Error} when the command is anything but a list, or carries a flag the readers do not use
 */
export function assertReadOnlyGh(argv) {
  if (argv[0] === "api") return assertReadOnlyApi(argv);
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

/** @param {string[]} argv @returns {Promise<string>} `systemctl <argv>`: only ever `--user show`, which `createReaders` builds and nothing else reaches */
async function runSystemctl(argv) {
  const { stdout } = await execFileAsync("systemctl", argv, { timeout: GH_TIMEOUT_MS, encoding: "utf8" });
  return stdout;
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
  /** @param {string[]} argv @returns {Promise<any>} */
  async function view(argv) {
    assertReadOnlyGh(argv);
    return JSON.parse(await run(argv));
  }
  return {
    /** @param {{ repo: string, label: string, comments?: boolean, limit?: number }} query */
    issuesLabelled({ repo, label, comments = false, limit = 100 }) {
      const fields = comments ? "number,title,url,updatedAt,comments" : "number,title,url,updatedAt";
      return list(["issue", "list", "-R", repo, "--label", label, "--state", "open", "--json", fields, "--limit", String(limit)]);
    },
    /** All of one row's comments: the list returns only the oldest hundred (see requests.mjs). @param {{ repo: string, number: number }} query */
    async issueComments({ repo, number }) {
      const row = await view(["issue", "view", String(number), "-R", repo, "--json", "comments"]);
      return Array.isArray(row?.comments) ? row.comments : [];
    },
    /** @param {{ repo: string, sinceMs: number, limit?: number }} query */
    async mergedPullsSince({ repo, sinceMs, limit = 100 }) {
      const since = new Date(sinceMs).toISOString();
      const pulls = await list(["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${since}`, "--json", "number,mergedAt", "--limit", String(limit)]);
      // The search qualifier is the filter and this is the check on it: a count of "merged in 24 h" must not include a merge from last week.
      return pulls.filter((pull) => Date.parse(pull.mergedAt) >= sinceMs);
    },
    /**
     * The chairman's red-PR count is `red-pr.mjs`'s `isBrokenRed` and nothing of this file's own (#3014, the sixth decider #2956 stopped): `labels`
     * is fetched so a `hold:<session>` PR whose only red is the hold's own jobs is not reported as broken. A commit STATUS in `FAILURE`/`ERROR`
     * does not count here, as it counts nowhere else; this org posts none (`pr-review-verdict.sh` posts `success` whatever the verdict).
     * @param {{ repo: string, limit?: number }} query
     */
    async redPulls({ repo, limit = 100 }) {
      return (await list(["pr", "list", "-R", repo, "--state", "open", "--json", "number,labels,statusCheckRollup", "--limit", String(limit)])).filter(isBrokenRed);
    },
    /** One REST GET, on the CORE pool (the lists above spend GraphQL): what the stall and incident readers use. @param {string} path */
    api(path) {
      return view(["api", path]);
    },
  };
}

/** @typedef {{ reason: string, key?: string }} Note  A `key` marks a note about one thing, logged once per distinct reason and not once per tick. */

/** @typedef {{ github: any, repo: string, now: number, openKeys: string[], summary: { at: string, timezone: string }, readers: Record<string, any> }} SourceContext */
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

/**
 * `fleet-watch` runs hourly (`OnCalendar=*:47`), so its state file is up to an hour old on a healthy host. `incidents.mjs`'s 30-minute default would read
 * half of every hour as "the watcher stopped"; two missed firings and a margin is what a stopped watcher looks like.
 */
const FLEET_STATE_MAX_AGE_MS = 130 * 60_000;

/** @param {{ events: Record<string, unknown>[], cannotAsk: { source: string, reason: string }[] }} observation @returns {{ events: Record<string, unknown>[], notes: Note[] }} */
function observed({ events, cannotAsk }) {
  return { events, notes: cannotAsk.map(({ source, reason }) => ({ reason: `cannot-ask ${source}: ${reason}` })) };
}

/**
 * The stall kinds. THE SAMPLE IS TAKEN FIRST, so the history `readTicks` returns includes this run. A sample that could not be taken is a note and
 * the source still runs: it then reads the history it has, and a history that stopped growing is `cannot-ask` by its own age.
 * @type {Source}
 */
const STALLS = {
  name: "stalls",
  async observe({ now, readers }) {
    /** @type {Note[]} */
    const notes = [];
    try {
      await readers.takeSample?.();
    } catch (error) {
      notes.push({ reason: `stall sample not taken: ${describeError(error)}` });
    }
    const result = observed(await observeStalls({ now: () => now, readers, log: () => {} }));
    return { events: result.events, notes: [...notes, ...result.notes] };
  },
};

/** @type {Source} */
const INCIDENTS = {
  name: "incidents",
  async observe({ now, readers }) {
    return observed(await observeIncidents({ now: () => now, readers, config: { fleetStateMaxAgeMs: FLEET_STATE_MAX_AGE_MS }, log: () => {} }));
  },
};

/** The sources this program asks, in order. */
export const DEFAULT_SOURCES = Object.freeze([REQUESTS, SUMMARY]);

/** The sources that read the host (systemd, herdr, files) as well as GitHub, asked only when the caller hands over the `readers` they need. */
export const HOST_SOURCES = Object.freeze([STALLS, INCIDENTS]);

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
 * `readers` is what the stall and incident sources read through (`sources/readers.mjs`). Given, they are asked after the label sources; absent, they are
 * NOT asked, which is a caller that has no host to read (a test's), never a production run: `main` always hands them over.
 *
 * @param {{ github: any, provider: any, ledger: ReturnType<typeof createLedger>, now: () => number, repo: string, readers?: Record<string, any>,
 *           summary: { at: string, timezone: string }, log?: (line: string) => void, sources?: readonly Source[], coreConfig?: object }} input
 * @returns {Promise<{ decisions: { key: string, action: string }[], failures: string[] }>}
 */
export async function runWatch({ github, provider, ledger, now, repo, readers, summary, log = () => {}, sources = readers === undefined ? DEFAULT_SOURCES : [...DEFAULT_SOURCES, ...HOST_SOURCES], coreConfig }) {
  const history = ledger.read();
  const openKeys = openRequestKeys(foldLedger(history));
  const { events, notes, failures } = await gather({ github, repo, now: now(), openKeys, summary, readers: readers ?? {} }, sources);
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

/** `fleet-watch`'s own default state path (`packages/control/src/fleet-watch.mjs`'s `DEFAULT_STATE_PATH`), relative to the checkout its unit runs in: the one this unit runs in. */
const FLEET_WATCH_STATE = join("runs", "fleet-watch-state.json");

/** @param {string} root @param {(line: string) => void} err @returns {string | undefined} the work-tick unit's name, or undefined after saying why not */
function workTickUnit(root, err) {
  try {
    return `${readUnitsDeclaration(root).prefix}work-tick.service`;
  } catch (error) {
    err(`messaging:watch: the work-tick unit's name is unknown, so incident:gate-crash cannot ask: ${describeError(error)}`);
    return undefined;
  }
}

/**
 * The reads the stall and incident sources run on, for a real host. An INJECTED `github` is a test's, and these reach systemd, herdr and files a test
 * must not touch, so there are none for it unless the test brings its own.
 *
 * @param {{ root: string, home: string, now: () => number, err: (line: string) => void, github: any }} input
 * @returns {ReturnType<typeof createReaders>}
 */
function hostReaders({ root, home, now, err, github }) {
  return createReaders({
    github, repo: trackerRepo(root), stateDir: dirname(defaultLedgerPath(home)), fleetStatePath: join(root, FLEET_WATCH_STATE),
    unit: workTickUnit(root, err), now, systemctl: runSystemctl, readSeats: readAgents, log: err,
    // Where the tick writes its record: beside the wake ledger, which with no `--ledger` (as the unit runs) is `wake.mjs`'s `ledgerPathFrom` default. NOT imported
    // from `wake.mjs`: that module reads the project declaration at import, and a watcher that cannot import is the outage this row exists to see.
    completionPath: completionPath(stateEntryPath("wake-ledger")),
  });
}

/** What a caller may leave out. A spread and not parameter defaults: each default is a branch, and `main` was past the complexity limit. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: process.env, home: homedir(), now: Date.now, github: /** @type {any} */ (undefined), readers: /** @type {any} */ (undefined), providers: /** @type {Record<string, (config: any) => any>} */ ({}),
  out: (/** @type {string} */ line) => console.log(line), err: (/** @type {string} */ line) => console.error(line),
});

/**
 * @param {{ root?: string, env?: Record<string, string | undefined>, home?: string, now?: () => number, github?: any, readers?: Record<string, any>,
 *           providers?: Record<string, (config: any) => any>, out?: (line: string) => void, err?: (line: string) => void }} [deps]
 * @returns {Promise<number>} the exit code: 0 done (or off), 1 something failed this tick, 2 refused to start
 */
export async function main(deps = {}) {
  const { root, env, home, now, github, readers, providers, out, err } = { ...DEFAULT_DEPS(), ...deps };
  const config = loadConfig(root, home, err);
  if (config === null) return EXIT.refused;
  // OFF IS SILENT AND CONSTRUCTS NOTHING: no reader, no provider, no ledger directory.
  if (!config.enabled) return EXIT.ok;
  const refusal = refusalToStart({ config, env, github, providers });
  if (refusal !== null) {
    err(`messaging:watch: ${refusal.message}`);
    return refusal.code;
  }
  const reader = github ?? createGhReader();
  const result = await runWatch({
    github: reader, provider: await providers[config.provider](config), repo: trackerRepo(root), summary: config.summary,
    readers: readers ?? (github === undefined ? hostReaders({ root, home, now, err, github: reader }) : undefined),
    ledger: createLedger({ path: defaultLedgerPath(home), now }), now, log: err,
  });
  for (const { key, action } of result.decisions) if (!IDLE_ACTIONS.has(action)) out(`${key}: ${action}`);
  return exitCodeOf(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
