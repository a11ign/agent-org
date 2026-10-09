#!/usr/bin/env node
// @ts-check
// a11ign/a11ign#4184 (#4055 next wave, item 5): THE HEADLESS WORKER PILOT'S SCRIPT -- ONE NAMED ROW WORKED AS `claude -p` OVER STREAM-JSON, HAND-RUN, OUTSIDE THE WAKE PATH.
//
//   node src/trace/headless-pilot.mjs --row <n> --named-on <issue> --max-turns <N> --max-budget-usd <D> [--dry-run]
//
// `ceo` ruled the shape on 2026-10-08 (comment on #4184): (b) FIRST, a script a person runs, and no change to `wake.ts`. A second spawn path is built only if this shows a
// saving worth the claim-path work, and that is a new ruling. THIS FILE RUNS NO PILOT: it is the instrument, and the ten runs are a second row's.
//
// WHAT IT DOES, in order: refuse (six ways, each named) -> read the row -> add a throwaway worktree off `origin/main` -> launch `claude` with `agentArgs(profile, { headless })` and send
// the row's brief -> run the row's own Acceptance in that worktree -> write ONE record -> remove the worktree, on a success and on a failure.
//
// THE BRIEF IS `addressed()`'s (wake.ts, exported): the very function a spawned pane worker's first-contact order is built by, handed the same `spawned` facts, so the text is a
// pane worker's for that row and not a copy that drifts. `wake.ts` is imported and never edited. THE PROFILE IS `profileFor("ready-row-unclaimed")`, the cause that spawns a per-row
// engineer. Two things differ from a pane worker, on purpose: the label is `pilot-<row>` (NOT `worker-<row>`: the pane worker that builds the same row afterwards must keep its own
// cost under its own name, and a claim made under `worker-<row>` would be a claim), and a tail paragraph says this is a measurement (below).
//
// READ-ONLY AGAINST THE ORG, THE SCRIPT'S OWN CALLS: it claims, labels and comments on nothing, opens no pull request and pushes nothing. Its `gh` goes through `ghRead`, which REFUSES
// anything that is not `issue view` or a GET `api` -- a guard in the code and not a promise in this paragraph. THE WORKER IT LAUNCHES IS NOT SO CONFINED, and this is stated rather than
// hidden: it must read its row, so `gh` stays usable to it, and a model told "build it here" may reach for `pr:open`. Two containments, neither total: the brief's tail forbids a push, a pull
// request, a label and a comment; and the process starts with `remote.origin.pushurl` pointed at nothing (`GIT_CONFIG_*`, which scopes to that process rather than to the shared
// repository config), so `git push` fails. A comment or label by the worker is a risk the pilot's second row should check for in its transcripts.
//
// DOLLARS ARE THE TRACE STORE'S, NOT THE CLI'S: the transcript the run wrote is read by `eventsOfTranscript` (store.mjs), repriced from `PRICES`, and the turns' `costUsd` summed
// (`traceCostUsd`). The CLI's `total_cost_usd` is recorded BESIDE it and never used: it is computed at the old $0.20 cache-read rate (+5.2% on Sonnet 5.5, #4075). A turn whose model has
// no price makes the sum a FLOOR (`unpricedTurns` > 0), and a transcript that cannot be found makes it `null`: never 0.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "../lib/cli-flags.mjs";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { agentArgs, profileFor } from "../worker-profile.ts";
import { addressed, PRIMARY_CHECKOUT } from "../wake.ts";
import { extractAcceptanceSection, declaredFleetAnswer } from "../acceptance-commands.ts";
import { extractLabeledSection } from "../region-paths.ts";
import { REPO } from "../project-identity.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { eventsOfTranscript, repriceEvents } from "./store.mjs";

/** The cause whose profile a per-row engineer is spawned with (`SPAWN_CAUSES` in wake.ts). */
export const PILOT_CAUSE = "ready-row-unclaimed";
export const ORDER_PREVIEW_LINES = 20;
const MINUTE_MS = 60_000;
/** A run is bounded by its turn and dollar caps; this is only the backstop for a `claude` that hangs. */
const CLAUDE_TIMEOUT_MS = 180 * MINUTE_MS;
const ACCEPTANCE_TIMEOUT_MS = 60 * MINUTE_MS;
const OUTPUT_BUFFER_BYTES = 512 * 1024 * 1024;
const FLAGS = ["--row=", "--named-on=", "--max-turns=", "--max-budget-usd=", "--dry-run", "--scratch=", "--checkout=", "--record-dir="];

/** The paragraph appended to the pane worker's order: the only text this form adds, because a measurement that merges or comments on the row it measures measures something else. */
export const MEASUREMENT_TAIL = "THIS RUN IS A MEASUREMENT ON A THROWAWAY WORKTREE (#4184), NOT THE ROW'S BUILD. Do the work and make the row's Acceptance pass in this directory, "
  + "but do not push, do not open a pull request, do not label or comment on the row or any issue, and do not run `agent-org pr:open`, `row-claim` or `fleet:*`. "
  + "This worktree is deleted when you finish; a pane worker builds the row afterwards.";

/** @typedef {{ maxTurns: number, maxBudgetUsd: number }} Caps */
/** @typedef {{ number: number, state: string, title: string, body: string, labels: { name: string }[] }} Issue */
/** @typedef {{ refusal: string, why: string }} Refusal */

/** The one thing every refusal and every record is keyed by. @param {string} refusal @param {string} why @returns {Refusal} */
const refuse = (refusal, why) => ({ refusal, why });

/**
 * THE GUARD THAT MAKES "READ-ONLY" A PROPERTY OF THE CODE: `issue view` and a GET `api` are the only calls this script may make through `gh`. Anything else throws before it is sent.
 * @param {string[]} args
 */
export function assertGhRead(args) {
  const [group, verb] = args;
  const isView = group === "issue" && verb === "view";
  const writes = args.some((a, i) => /^(-X|--method)$/.test(a) && args[i + 1]?.toUpperCase() !== "GET" || /^(-f|-F|--field|--raw-field|--input)$/.test(a));
  if (isView || (group === "api" && !writes)) return;
  throw new Error(`headless-pilot is read-only against the org: refused \`gh ${args.join(" ")}\``);
}

/**
 * The row numbers on an issue's `Pilot-rows:` line. TWO such lines are ambiguous and read as none: the script does not choose between them.
 * @param {string} body @returns {number[] | null} `null` when the issue has no single `Pilot-rows:` line
 */
export function pilotRowsOf(body) {
  const lines = String(body).split("\n").filter((line) => /^\s*(?:[-*]\s*)?\**Pilot-rows:/i.test(line));
  if (lines.length !== 1) return null;
  return [...lines[0].replace(/^[^:]*:/, "").matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/**
 * Every refusal that needs no row read: an odd row is the pane arm's, and a cap that is missing is one the launch form has no default for.
 * @param {{ row: number, caps: Partial<Caps>, namedOn: number }} input @returns {Refusal | null}
 */
export function earlyRefusal({ row, caps, namedOn }) {
  if (!Number.isInteger(row) || row <= 0) return refuse("bad-row", `--row must be a row number, got ${row}`);
  if (!Number.isInteger(namedOn) || namedOn <= 0) return refuse("no-named-on", "--named-on must name the issue whose `Pilot-rows:` line lists this row");
  if (row % 2 !== 0) return refuse("odd-row", `row #${row} is odd: the pane arm works an odd row, as usual`);
  if (caps.maxTurns === undefined) return refuse("missing-cap", "--max-turns is required: the headless form has no default");
  if (caps.maxBudgetUsd === undefined) return refuse("missing-cap", "--max-budget-usd is required: the headless form has no default");
  return null;
}

/**
 * The row's own answer to "does it need the fleet or the lab": the template's full-question section (`declaredFleetAnswer`), else the `## Fleet` section this row family carries.
 * The platform reader knows only the first, and a row written with the second would otherwise read as undeclared. The first word decides, as it does there; anything else is `null`.
 * @param {string} body @returns {"no" | "yes" | null}
 */
export function fleetAnswerOf(body) {
  const declared = declaredFleetAnswer(body);
  if (declared !== null) return declared;
  const word = (extractLabeledSection(body, "Fleet") ?? "").replace(/^[\s*_`]+/, "");
  if (/^(?:no|neither)(?=$|[\s.,:;!\u2014\u2013])/i.test(word)) return "no";
  return /^(?:yes|both)(?=$|[\s.,:;!\u2014\u2013])/i.test(word) ? "yes" : null;
}

/**
 * Every refusal that needs the row and the issue naming it. ABSENCE IS NOT AN ANSWER: a row with no `## Fleet` section is refused as unreadable, never passed as `No`.
 * @param {{ row: number, namedOn: number, namedBody: string, issue: Issue }} input @returns {Refusal | null}
 */
export function rowRefusal({ row, namedOn, namedBody, issue }) {
  const named = pilotRowsOf(namedBody);
  if (named === null) return refuse("not-named", `#${namedOn} carries no single \`Pilot-rows:\` line, so no row is named for the pilot`);
  if (!named.includes(row)) return refuse("not-named", `row #${row} is not in #${namedOn}'s \`Pilot-rows:\` line (${named.join(", ")}): only a row product-manager has named is run`);
  if (issue.state !== "OPEN") return refuse("not-open", `row #${row} is ${issue.state}, not OPEN`);
  const claimed = issue.labels.map((l) => l.name).find((name) => name.startsWith(SESSION_PREFIX));
  if (claimed) return refuse("claimed", `row #${row} already carries \`${claimed}\`: it is being worked`);
  const fleet = fleetAnswerOf(issue.body);
  if (fleet !== "no") return refuse("fleet", `row #${row}'s \`## Fleet\` is ${fleet === "yes" ? "Yes" : "not a plain No (absent or prose)"}: a pilot row never touches the fleet or the lab`);
  const acceptance = extractAcceptanceSection(issue.body);
  if (acceptance.kind !== "commands") return refuse("no-acceptance", `row #${row}'s Acceptance is ${acceptance.kind}, so there is no command whose exit says success`);
  return null;
}

/**
 * The first-contact order a pane worker would get for this row, plus {@link MEASUREMENT_TAIL}. `addressed` is wake.ts's, handed the facts a spawn hands it.
 * @param {{ issue: Issue, label: string, worktree: string, branch: string }} input
 */
export function pilotOrder({ issue, label, worktree, branch }) {
  const order = { session: label, prompt: "", title: issue.title, cause: PILOT_CAUSE };
  const claimed = { row: issue.number, branch, launchDir: worktree, worktree };
  return `${addressed(order, label, { spawned: claimed, engineers: [] })}\n\n${MEASUREMENT_TAIL}`;
}

/** @param {Caps} caps */
export function launchArgs(caps) {
  const profile = profileFor(PILOT_CAUSE);
  if ("refusal" in profile) throw new Error(profile.refusal);
  return agentArgs(profile, { headless: caps });
}

/** The stream-json line `claude -p --input-format stream-json` reads as one user turn. @param {string} text */
export const userTurn = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

/**
 * What the stream says happened: the session id (from `init`, else the result) and the `result` record's fields. A stream with no `result` line is a run that did not finish.
 * @param {string} stdout
 */
export function readStream(stdout) {
  let sessionId = null;
  let result = null;
  for (const line of stdout.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; } // a non-JSON line is the CLI's chatter; the result line is what counts and its absence is recorded
    if (typeof record?.session_id === "string") sessionId ??= record.session_id;
    if (record?.type === "result") result = record;
  }
  return { sessionId, result };
}

/**
 * The trace store's dollars for one transcript, found by session id under `<config>/projects/*`.
 * @param {{ sessionId: string | null, configDir: string }} input
 * @returns {{ traceCostUsd: number | null, traceApiCalls: number | null, unpricedTurns: number | null, transcript: string | null }}
 */
export function traceCost({ sessionId, configDir }) {
  const none = { traceCostUsd: null, traceApiCalls: null, unpricedTurns: null, transcript: null };
  const root = join(configDir, "projects");
  if (sessionId === null || !existsSync(root)) return none;
  const dir = readdirSync(root).find((name) => existsSync(join(root, name, `${sessionId}.jsonl`)));
  if (dir === undefined) return none;
  const file = join(root, dir, `${sessionId}.jsonl`);
  const read = eventsOfTranscript({ text: readFileSync(file, "utf8"), file, ledger: [], rowRepo: REPO });
  const turns = repriceEvents(read.events).filter((event) => event.kind === "turn");
  const priced = turns.map((turn) => turn.costUsd).filter((cost) => typeof cost === "number");
  return { traceCostUsd: priced.reduce((sum, cost) => sum + cost, 0), traceApiCalls: turns.length, unpricedTurns: turns.length - priced.length, transcript: file };
}

/**
 * The row's own Acceptance, as written, in the worktree. Its exit is the first non-zero command's, else 0.
 * @param {string[]} commands @param {string} cwd
 */
export function runAcceptance(commands, cwd) {
  for (const command of commands) {
    const ran = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: ACCEPTANCE_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES });
    const exit = ran.status ?? 1;
    if (exit !== 0) return exit;
  }
  return 0;
}

/**
 * `success` IS TRUE ONLY WHEN BOTH ARE: the run ended on `subtype: success` AND the Acceptance exited 0. A stop at a cap (`error_max_turns`, a budget stop) is false and is WRITTEN: the cap is
 * the cost of this form and a dropped failure would flatter it (`ceo`'s condition 2).
 * @param {string | null} subtype @param {number | null} acceptanceExit
 */
export const successOf = (subtype, acceptanceExit) => subtype === "success" && acceptanceExit === 0;

/** Where a run's throwaway worktree lives. @param {string} scratch @param {number} row */
export const worktreePathFor = (scratch, row) => join(scratch, `wt-${row}`);

/**
 * @typedef {{ gh?: (args: string[]) => string, git?: (args: string[]) => string, claudeBin?: string, scratch?: string, checkout?: string,
 *   recordDir?: string, configDir?: string, out?: (line: string) => void }} Deps
 */

/** @param {Deps} deps */
function resolved(deps) {
  const checkout = deps.checkout ?? PRIMARY_CHECKOUT;
  return {
    gh: deps.gh ?? ((args) => execFileSync("gh", args, { encoding: "utf8" })),
    // named checkout (#3363) and a scrubbed environment (#1185): a leaked GIT_DIR must not send these calls to another repository
    git: deps.git ?? ((args) => execFileSync("git", args, { cwd: checkout, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })),
    claudeBin: deps.claudeBin ?? "claude",
    scratch: deps.scratch ?? join(tmpdir(), "headless-pilot"),
    checkout,
    recordDir: deps.recordDir ?? join(homedir(), ".cache", "a11ign", "headless-pilot"),
    configDir: deps.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    out: deps.out ?? ((line) => process.stdout.write(`${line}\n`)),
  };
}

/** @param {(args: string[]) => string} gh @param {number} number @returns {Issue} */
function readIssue(gh, number) {
  const args = ["issue", "view", String(number), "--repo", REPO, "--json", "number,state,title,body,labels"];
  assertGhRead(args);
  return JSON.parse(gh(args));
}

/**
 * Add the throwaway worktree on its own branch off `origin/main`, and the function that removes both. The branch is `pilot/…`, a namespace nothing else writes, so `-B` resets only a
 * leftover of this script's own.
 * @param {{ git: (args: string[]) => string, checkout: string, worktree: string, branch: string }} input
 */
function addWorktree({ git, checkout, worktree, branch }) {
  git(["-C", checkout, "fetch", "--quiet", "origin", "main"]);
  git(["-C", checkout, "worktree", "add", "-B", branch, worktree, "origin/main"]);
  return () => {
    git(["-C", checkout, "worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });
    git(["-C", checkout, "worktree", "prune"]);
    git(["-C", checkout, "branch", "-D", branch]);
  };
}

/** One record per row. A record already there is a measurement and is renamed aside, never overwritten. @param {string} dir @param {number} row @param {object} record */
function writeRecord(dir, row, record) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${row}.json`);
  if (existsSync(path)) renameSync(path, join(dir, `${row}.${statSync(path).mtimeMs}.json`));
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/**
 * Launch `claude` in the worktree with the order on stdin. A `claude` that cannot start is a run that ended with nothing, and is returned as one.
 * @param {{ claudeBin: string, args: string[], order: string, cwd: string }} input
 */
function launchClaude({ claudeBin, args, order, cwd }) {
  const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: "headless-pilot-refuses-push" };
  const ran = spawnSync(claudeBin, args, { cwd, env, input: userTurn(order), encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES });
  return { exit: ran.status, launchError: ran.error ? String(ran.error.message) : null, stdout: ran.stdout ?? "" };
}

/** @param {string} claudeBin */
function claudeVersion(claudeBin) {
  const ran = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  return ran.status === 0 ? ran.stdout.trim() : null;
}

/**
 * Work the row in the throwaway worktree and say what happened. The worktree is removed in `finally`, so a run that throws is cleaned up as well as one that finishes.
 * @param {{ issue: Issue, caps: Caps, args: string[], order: string, worktree: string, branch: string, row: number, namedOn: number }} run
 * @param {ReturnType<typeof resolved>} env
 */
function work(run, env) {
  const remove = addWorktree({ git: env.git, checkout: env.checkout, worktree: run.worktree, branch: run.branch });
  try {
    const launched = launchClaude({ claudeBin: env.claudeBin, args: run.args, order: run.order, cwd: run.worktree });
    const { sessionId, result } = readStream(launched.stdout);
    const section = extractAcceptanceSection(run.issue.body);
    const acceptanceExit = section.kind === "commands" ? runAcceptance(section.commands, run.worktree) : null;
    const subtype = result?.subtype ?? null;
    const record = {
      row: run.row, namedOn: run.namedOn, sessionId: sessionId ?? result?.session_id ?? null, claudeVersion: claudeVersion(env.claudeBin), caps: run.caps,
      resultSubtype: subtype, exitCode: launched.exit, launchError: launched.launchError, numTurns: result?.num_turns ?? null,
      cliTotalCostUsd: result?.total_cost_usd ?? null, ...traceCost({ sessionId: sessionId ?? result?.session_id ?? null, configDir: env.configDir }),
      acceptanceExitCode: acceptanceExit, success: successOf(subtype, acceptanceExit),
    };
    return { record, path: writeRecord(env.recordDir, run.row, record) };
  } finally {
    remove();
  }
}

/** The dry run's whole output: nothing is launched and no worktree is made. @param {string[]} args @param {string} order @param {(line: string) => void} out */
function printDryRun(args, order, out) {
  out(`claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
  out(`--- the order's first ${ORDER_PREVIEW_LINES} lines ---`);
  for (const line of order.split("\n").slice(0, ORDER_PREVIEW_LINES)) out(line);
}

/**
 * @param {{ row: number, namedOn: number, caps: Partial<Caps>, dryRun: boolean }} options
 * @param {Deps} [deps]
 * @returns {Promise<{ refused: Refusal } | { dryRun: true, args: string[], order: string } | { record: object, path: string }>}
 */
export async function runPilot(options, deps = {}) {
  const env = resolved(deps);
  const { row, namedOn, caps, dryRun } = options;
  const early = earlyRefusal({ row, caps, namedOn });
  if (early) return { refused: early };
  const issue = readIssue(env.gh, row);
  const namedBody = readIssue(env.gh, namedOn).body;
  const late = rowRefusal({ row, namedOn, namedBody, issue });
  if (late) return { refused: late };
  const worktree = worktreePathFor(env.scratch, row);
  if (existsSync(worktree)) return { refused: refuse("worktree-exists", `${worktree} already exists: a leftover to look at, not one to delete unseen`) };
  const branch = `pilot/headless-${row}`;
  const args = launchArgs(/** @type {Caps} */ (caps));
  const order = pilotOrder({ issue, label: `pilot-${row}`, worktree, branch });
  if (dryRun) {
    printDryRun(args, order, env.out);
    return { dryRun: true, args, order };
  }
  const done = work({ issue, caps: /** @type {Caps} */ (caps), args, order, worktree, branch, row, namedOn }, env);
  env.out(`row #${row}: success=${done.record.success} (record ${done.path}; the CLI's own total_cost_usd is printed beside the trace store's and not used)`);
  return done;
}

/**
 * `--row 4` and `--row=4` are the same flag: the row's usage line is the space form and `flagValue` reads only the `=` form, so the space form is joined to its value first.
 * A value flag at the end of the line with no value stays as it is and reads as absent.
 * @param {string[]} argv
 */
export function normalizeArgv(argv) {
  const valued = new Set(FLAGS.filter((f) => f.endsWith("=")).map((f) => f.slice(0, -1)));
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const joins = valued.has(argv[i]) && i + 1 < argv.length && !argv[i + 1].startsWith("--");
    out.push(joins ? `${argv[i]}=${argv[++i]}` : argv[i]);
  }
  return out;
}

/** @param {string[]} argv @param {string} name @returns {number | undefined} */
function numberFlag(argv, name) {
  const raw = flagValue(argv, name);
  return raw === undefined || raw === "" ? undefined : Number(raw);
}

async function main() {
  const argv = normalizeArgv(process.argv.slice(2));
  refuseUnknownFlags(FLAGS, { entry: import.meta.url, argv, command: "node src/trace/headless-pilot.mjs" });
  const options = {
    row: numberFlag(argv, "row") ?? Number.NaN, namedOn: numberFlag(argv, "named-on") ?? Number.NaN, dryRun: argv.includes("--dry-run"),
    caps: { maxTurns: numberFlag(argv, "max-turns"), maxBudgetUsd: numberFlag(argv, "max-budget-usd") },
  };
  const deps = { scratch: flagValue(argv, "scratch"), checkout: flagValue(argv, "checkout"), recordDir: flagValue(argv, "record-dir") };
  const got = await runPilot(options, Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)));
  if ("refused" in got) {
    process.stderr.write(`headless-pilot: REFUSED (${got.refused.refusal}): ${got.refused.why}\n`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().catch((err) => {
    process.stderr.write(`headless-pilot: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
