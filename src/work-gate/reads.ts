import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.ts";
import { waitingOn, todayIso } from "../waiting-condition.ts";
import { newestPerName } from "../newest-check-run.ts";
import { LS_REMOTE_ARGS, rowBranchesInListing } from "../row-claim/row-branch-rule.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { DEFAULT_RECONCILE_MINUTES, homeHostConfig, stateEntryPath } from "../host-config.ts";
import { type Budget, GATE_VALIDATORS_DIR, conditionalGate, graphqlReadOf, meteredBatch, meteredRun, partitionUnchanged, restConditionalOn, seenOf } from "../gh-conditional.ts";
import { type Ask, parseReply, readValidators, saveValidators } from "../trace/publish.ts";
import { narrowedPrList, readPrList, writePrList } from "../pr-list-memory.ts";
import { readTickScopes } from "../tick-scopes.ts";
import type { Scope as TickScope } from "../event-queue.ts";
import { type Pacing, GRAPHQL_SWEEP_MINUTES, OTHER_SCOPES_MEMORY, readOtherScopesMemory, rememberOtherScopes, scopesToRead } from "./pacing.ts";
import { cachedReleaseBehind, readReleaseBehind, npmRegistryRead } from "../release-behind-main.ts";
import { armedFromApi, openPullRequestsQueryArgs } from "../auto-arm-sweep.ts";
import { REPO } from "../project-identity.ts";
import { herdrRun as herdrProbe } from "../herdr-agents.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { conditionalGetArgs, pullViewArgs } from "../ticket-port/conditional-reads.ts";
import { isRowsByLabelRead } from "../ticket-port/rows-by-label.ts";
import { recordDueInstants } from "./due-index-write.ts";
import { stillRunning } from "./pr-state.ts";
import { NOT_STARTABLE, PARKED_LABEL, REVIEWER_STATE_DIR, ROW_BLOCKED_BY, ROW_LABELS, type Scope, type ScopeRepository, labelledRows, labelsOf,
  scopesOf, sessionOf, tagged } from "./vocabulary.ts";

/**
 * FOUR STATES, AND THE POLARITY IS DELIBERATE.
 *
 * `0` is QUIET, matching `org-watch`, `stranded-branches` and `merge-guard`. The reason is not symmetry.
 * Under this polarity the predictable misuse -- `if work-gate.ts; then wake; fi` -- wakes EVERY session
 * on EVERY quiet tick, which is impossible to miss for more than one tick. Under the opposite polarity
 * the same mistake sleeps silently through a rate limit and nobody finds out for ten hours, which is the
 * 2026-09-08 outage this whole design exists to prevent. Choose the polarity whose misuse announces itself.
 *
 * `3` PARTIAL exists because this asks about several lanes at once (ADR 0037). One unreadable lane must
 * not void the other's orders and must not be reported as quiet either: the orders on stdout are real and
 * the lane that could not be read is NAMED on stderr.
 *
 * `4` PACED is PARTIAL's twin for a tick whose ONLY unread lanes were skipped BY DESIGN (`gate.graphqlPacing`, or no event named the repository):
 * nothing was refused, so the tick must not say a lane "could not be read" (agent-org#1414). A single refused lane is still `3`.
 */
export const EXIT = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3, PACED: 4 };

/** Where the drain marker lives. `touch` it to open a window; `rm` it to close one. */
export const DRAIN_MARKER = stateEntryPath("drain");

/**
 * Is the org draining -- finishing what is in flight and taking on nothing new?
 *
 * A MARKER FILE, NOT A FLAG OR AN ENV VAR, because of who has to operate it. Turning a window on and
 * off is `touch` and `rm` over ssh; a systemd `Environment=` line is an edit plus a `daemon-reload`,
 * and a CLI flag would have to be threaded through the unit file to reach the tick at all. It also
 * survives a restart and can be READ by anyone wondering why the queue went quiet, which an env var
 * inside a transient unit cannot.
 *
 * It sits beside the wake ledger deliberately: one directory holds the org's runtime state.
 */
export function draining(path: string = DRAIN_MARKER, exists: (p: string) => boolean = existsSync) {
  return exists(path);
}

/**
 * THE REPOSITORY THE READS ARE ABOUT, when it is not the checkout's own (#2618, child 3c of #69). `undefined` -- the primary
 * project's, and every read before a second repository existed -- runs `gh` exactly as it always ran, with no `env` option
 * added, so one declared project makes the same calls it made. Any other repository is `GH_REPO`, which `gh pr`, `gh issue`,
 * `gh label` and the `{owner}/{repo}` placeholders of `gh api` all honour, so ONE seam scopes every reader including the zero-argument
 * wrappers `main` calls, without threading a repository through thirty signatures.
 *
 * Synchronous (`execFileSync`) and restored in a `finally`, which is what makes an ambient safe: no read of one repository
 * can run while another's is set.
 */
let activeRepo: string | undefined;

/**
 * Run `read` with every `gh` call it makes aimed at `repo` (`undefined` is the checkout's own).
 */
export function inRepo<T>(repo: string | undefined, read: () => T): T {
  const outer = activeRepo;
  activeRepo = repo;
  try {
    return read();
  } finally {
    activeRepo = outer;
  }
}

/** The repository a literal-path read (`repos/<repo>/...`) asks about: the scoped one, else the checkout's own. */
export const repoNow = () => activeRepo ?? REPO;

/**
 * THE MOST ONE `gh` MAY TAKE before the gate cuts it (#3737). Without a bound a `gh` that never returned held the whole tick until `TimeoutStartSec=600`
 * killed it, and `systemctlRun` and `herdrRun` already carry one. The same 30 s as `wake.ts`'s `defaultGh`, so a `gh` is cut at one time wherever it runs.
 *
 * DERIVED, NOT TYPED, AND THE LEDGER HAS NO DURATION COLUMN (`host/gh` writes a call's end second, no more), so the slowest single call is read as the
 * longest gap between consecutive `work-gate.ts` calls inside one run, which holds a call's time and the gate's own between calls, so it can only overstate.
 * Measured 2026-10-06 over the workers' and leads' ledgers (1,396 gate calls, 17:22Z to 19:27Z and from 00:35Z): within a run the gaps ran 0 to 10 s, and two
 * gaps (28 s, 42 s) cannot be told from the quiet between two runs. So 10 s is the slowest call the ledger shows, 42 s the most it could be, and 30 s is three
 * times the first and under the gate's own 40.6 s (measured 2026-10-05) for all of its 17 `pr list` reads.
 */
export const GH_READ_TIMEOUT_MS = 30_000;

/** The two words a `gh` call is named by in the ledger and in a line: `pr list`, `api repos/o/r/issues`. A body, a query or a token is never among them. */
export const ghCallName = (args: string[]) => args.slice(0, 2).join(" ");

/**
 * `gh`, run to completion or cut at `timeoutMs`. A call that hits the bound is TOLD (naming the subcommand) and then thrown as `execFileSync` throws it
 * (`code: "ETIMEDOUT"`), which is a refusal every reader already turns into `null` for ITS lane and nobody else's: nothing new is thrown. `SIGKILL`, because a
 * `gh` that has hung is not one that answers a polite request.
 *
 * @param [how] `stdio: "pipe"` captures `gh`'s stderr on the error instead of inheriting it; `log` is where the cut is told
 */
export const ghWithin = (timeoutMs: number, { stdio, log = (line) => process.stderr.write(line) }: { stdio?: "pipe"; log?: (line: string) => void; } = {}) => (args: string[], repo = activeRepo) => {
  try {
    return execFileSync("gh", args, { ...ghOptions(repo), timeout: timeoutMs, killSignal: "SIGKILL", ...(stdio === undefined ? {} : { stdio }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "ETIMEDOUT") {
      log(`GH CUT in ${repoNow()}: \`gh ${ghCallName(args)}\` ran past ${timeoutMs / 1000} s and was killed. That read is refused (null); the other reads go on.\n`);
    }
    throw error;
  }
};

/**
 * a11ign#5169 (the wiring of #5128): THE TICK'S GRAPHQL BUDGET, held by the tick (`tick.ts` calls `holdTickBudget` when the process is the gate and
 * `gate.restConditional` is on) and charged by every GraphQL read made through `defaultRun`, `capturedRun` and `runBatch`. `null` is the flag off, or a
 * process that is not the gate (a live run, a CLI that imports this file): nothing is charged and `gh` runs as it always has.
 */
let heldBudget: Budget | null = null;

export function holdTickBudget(budget: Budget | null): void {
  heldBudget = budget;
}

/** `run`, charged to whatever budget is held WHEN IT IS CALLED, so the order in which modules load never decides whether a read is metered. */
const metered = (run: (args: string[], repo?: string) => string) => (args: string[], repo?: string) =>
  (heldBudget === null ? run(args, repo) : meteredRun(run, heldBudget)(args, repo));

/**
 * agent-org#1095: AN IDENTICAL READ IS ASKED ONCE A TICK. The gate's readers each ask for the lists they need and several ask for the same one: 567 to 745
 * `gh` calls a tick, `pr list --state merged --limit 100` eight times and `pr list --state open --limit 20` seven, until the tick's 300 s ran out
 * (`GATE OUT OF BUDGET`, 30 times in 3 h) and a release it had decided was refused for the primary rate limit it had spent on its own repeats. `host/gh`
 * answers an identical read from disk for 20 s, which is shorter than the tick, so the repeat went to GitHub.
 *
 * WHAT IS REMEMBERED is the successful answer to a read-only call, by repository and argv (`readOnlyGh`). A refusal is never kept, so a read that failed is
 * asked again as it was. ANY OTHER CALL FORGETS EVERYTHING, before its answer is used and whether it threw or not, so a read after a write is fresh; a
 * write by another process is not seen from here, which is why the memo is held by the gate alone (`isGateProcess`) and never by a CLI that imports
 * this file (`row-claim` writes and then reads back through `runBatch`). A process the tick ends is the memo's end: nothing is written to disk.
 */
const readMemo = { on: false, answers: new Map<string, string>(), bytes: 0, hits: 0 };

/** The most the memo holds (a `gh` body may be 32 MiB): past it an answer is returned and not kept, which is a repeat call, never a wrong answer. */
export const READ_MEMO_MAX_BYTES = 64 * 1024 * 1024;

/** `gh` verbs that only read, beside `pr|issue list|view` and `api`, which `readOnlyGh` tells by their flags. A verb that is not named here is a write. */
const READ_VERBS = new Set(["run list", "run view", "label list", "pr checks", "pr diff", "repo view"]);

/** The `--method` an `api` call names, in any of `--method M`, `--method=M`, `-X M` and `-XM`; `undefined` when it names none. */
function methodOf(args: string[]): string | undefined {
  for (const [at, arg] of args.entries()) {
    if (arg === "--method" || arg === "-X") return args[at + 1];
    const joined = /^(?:--method=|-X)(.+)$/.exec(arg);
    if (joined !== null) return joined[1];
  }
  return undefined;
}

/**
 * Does this `gh` call only READ? Anything that cannot be shown to is a write: the cost of a wrong "write" is one repeated read, and of a wrong "read" a stale
 * answer after a change. A GraphQL query is a read and a mutation is not (`graphqlReadOf`); a REST call is a read when it is a GET, and `gh api` makes it a
 * POST by itself when it is given a field or a body without a method.
 */
export function readOnlyGh(args: string[]): boolean {
  if (graphqlReadOf(args)) return true;
  const [head, verb] = args;
  if (head !== "api") return READ_VERBS.has(`${head} ${verb}`);
  if (verb === "graphql") return false;
  const method = methodOf(args);
  if (method !== undefined) return method.toUpperCase() === "GET";
  return !args.some((arg) => /^(-[fF]|--field|--raw-field|--input)/.test(arg));
}

/** Is this process the gate (`work-gate.ts`)? The same test `tick.ts` makes (`runningAsGate`) and `work-gate.ts` makes of itself: importing this file is not running a tick. */
export function isGateProcess(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === new URL("../work-gate.ts", import.meta.url).href;
  } catch {
    return false; // "cannot tell" (`node -e`, a REPL) is never the gate
  }
}

/** Turn the memo on or off, emptied either way. The gate holds it for its own process (below); a test holds it for the one it makes. */
export function holdReadMemo(on: boolean): void {
  readMemo.on = on;
  readMemo.answers.clear();
  readMemo.bytes = 0;
  readMemo.hits = 0;
}

/** @returns how many calls the memo answered and how many answers it holds: what the gate prints at the end of a tick, so the next reading of reads per tick can be taken */
export const readMemoReading = () => ({ hits: readMemo.hits, held: readMemo.answers.size });

export const forgetReads = () => { readMemo.answers.clear(); readMemo.bytes = 0; };

function rememberRead(key: string, answer: string): void {
  if (readMemo.bytes + answer.length > READ_MEMO_MAX_BYTES) return;
  readMemo.answers.set(key, answer);
  readMemo.bytes += answer.length;
}

/**
 * `run`, answering a read it has answered before from memory. Outside `metered` on purpose: an answer from memory is not a GraphQL read and spends no point of the
 * tick's budget. The key resolves the repository as `ghWithin` does (`repo = activeRepo`), so one argv aimed at two repositories is two reads.
 */
const memoised = (run: (args: string[], repo?: string) => string) => (args: string[], repo?: string): string => {
  if (!readMemo.on) return run(args, repo);
  if (!readOnlyGh(args)) {
    try { return run(args, repo); } finally { forgetReads(); }
  }
  const key = callKey(args, repo ?? activeRepo);
  const held = readMemo.answers.get(key);
  if (held !== undefined) {
    readMemo.hits += 1;
    return held;
  }
  const answer = run(args, repo);
  if (typeof answer === "string") rememberRead(key, answer);
  return answer;
};

holdReadMemo(isGateProcess());
if (readMemo.on) {
  process.on("exit", () => {
    const { hits, held } = readMemoReading();
    process.stderr.write(`read memo: ${hits} identical read(s) answered from memory, ${held} distinct answer(s) held at the end of the tick.\n`);
  });
}

/** @param [repo] the repository to aim at; the ambient one when omitted */
export const defaultRun = memoised(metered(ghWithin(GH_READ_TIMEOUT_MS)));

/**
 * a11ign#5169 (the reviewer's finding on agent-org#1108): WHICH `run` STANDS FOR `gh`. The conditional reads are for the gate's own `gh`, and a test's `run` must
 * never be given a REST read it did not make; but the gate's reads reach `readPrs` and `readOpenRows` through WRAPPERS (the first wave's rehearsal and replay,
 * a lane's aim), so `run === defaultRun` is false for every production read and the flag would have selected nothing. A wrapper made of a run that stands for `gh`
 * stands for it too (`standingFor`); one made of anything else does not.
 */
const standsForGh = new WeakSet<object>([defaultRun]);
export const isGhRun = (run: object): boolean => standsForGh.has(run);
export function standingFor<W extends object>(run: object, wrapper: W): W {
  if (standsForGh.has(run)) standsForGh.add(wrapper);
  return wrapper;
}

/**
 * WHICH `run` READS THE CHECKOUT'S OWN REPOSITORY, with no repository aimed (a11ign/a11ign#5043, agent-org#1093). The narrowing and the due-index are keyed by the
 * repository a read is of, and a lane's `aimed` wrapper (`readLanes`) is a `run` that stands for `gh` and is aimed at another one, so `isGhRun` cannot say
 * it: the gate's `defaultRun`, and the first wave's wrappers made of an ambient `run`, are the ones that take `repoNow()`.
 */
const ambientRuns = new WeakSet<object>([defaultRun]);
export const isAmbientRun = (run: object): boolean => ambientRuns.has(run);
function ambientStandingFor<W extends object>(run: object, wrapper: W): W {
  if (ambientRuns.has(run)) ambientRuns.add(wrapper);
  return standingFor(run, wrapper);
}

/**
 * #4128: THE RELEASE-BEHIND-MAIN FACTS, at most once an hour (see the comment in `GH_READS`). Through `defaultRun`, the identity the tick already reads as and never another config.
 * @param [where] the directory the hour's facts are kept in; the tick's own unless a caller (a live run) must not write the tick's
 * @returns `null` is a declaration that will not parse, a stated gap
 */
export function releaseBehindNow({ stateDir = REVIEWER_STATE_DIR }: { stateDir?: string; } = {}): import("../release-behind-main.ts").RepoFact[] | null {
  try {
    const repositories = homeProjectDeclaration().dora;
    return cachedReleaseBehind({ stateDir, now: Date.now(), read: () => readReleaseBehind({ gh: defaultRun, registry: npmRegistryRead, repositories }) });
  } catch (err) {
    process.stderr.write(`org-health: release-behind-main could not list the dora repositories (${String((err as any)?.message ?? err).split("\n")[0]})\n`);
    return null;
  }
}

const ghOptions = (repo: string | undefined): import("node:child_process").ExecFileSyncOptionsWithStringEncoding =>
  ({ encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...(repo === undefined ? {} : { env: { ...process.env, GH_REPO: repo } }) });

/** `defaultRun` with `gh`'s stderr CAPTURED on the error instead of inherited: for a read whose refusal is an answer the caller handles (#3724). */
const capturedRun = memoised(metered(ghWithin(GH_READ_TIMEOUT_MS, { stdio: "pipe" })));

/**
 * The reader a refusal-handling read asks through: the default one is swapped for the capturing one, and a test's `run` stands for `gh` as it is.
 */
export const capturingStderr = (run: (args: string[], repo?: string) => string) => (run === defaultRun ? capturedRun : run);

/** The most `gh` calls one batch has in flight: the other repositories number single digits, and GitHub answers a burst with a secondary limit. */
export const BATCH_MAX_CALLS = 16;

const BATCH_MAX_BUFFER = 256 * 1024 * 1024;

/** How long past a call's own bound the batch's outer wait is held, so the worker reports a call it cut before `execFileSync` kills the worker itself. */
export const BATCH_OUTER_GRACE_MS = 5_000;

/**
 * The `node` one batch runs: each call through ASYNC `execFile` so they wait together, answers printed as one JSON list in the order asked. `GH_REPO`
 * aims a call exactly as `defaultRun` does, so the census (preloaded through `NODE_OPTIONS`) still counts each `gh` by repository.
 *
 * (#4148) THE FIRST LINE NAMES THE SCRIPT. `host/gh` records the calling process's command line cut at 160 characters, and a `node -e <code>` has nothing in it that is
 * a file, so 852 of 7,053 ledger calls (12% of the 14:00Z-15:45Z window, measured 2026-10-08) read `/usr/bin/node` and belonged to no one. The comment is what the ledger's
 * script-name pattern finds.
 */
const BATCH_WORKER = `/* work-gate.ts runBatch */
const { execFile } = require("node:child_process");
const one = ({ args, repo }) => new Promise((done) => execFile("gh", args,
  { encoding: "utf8", maxBuffer: ${BATCH_MAX_BUFFER}, timeout: Number(process.argv[2]), killSignal: "SIGKILL",
    env: repo === undefined ? process.env : { ...process.env, GH_REPO: repo } },
  (error, stdout, stderr) => done(error === null ? { stdout }
    : { failed: true, stdout, stderr, status: typeof error.code === "number" ? error.code : null,
        code: error.killed ? "ETIMEDOUT" : typeof error.code === "string" ? error.code : undefined })));
Promise.all(JSON.parse(process.argv[1]).map(one)).then((answers) => process.stdout.write(JSON.stringify(answers)));
`;

/**
 * (#3566, slice 2) `gh` CALLS ASKED TOGETHER WAIT TOGETHER. The gate is synchronous, so each of the eight repositories' reads waited for the one before it:
 * 17 `pr list` calls were 10.5 s of a 40.6 s gate, measured 2026-10-05 with a timing shim on PATH. ONE synchronous spawn of a `node` that starts the
 * calls at once costs the slowest of them instead of their sum, and the tick keeps its shape: no reader becomes asynchronous.
 *
 * (#3843) EACH CALL IS CUT AT `callMs`, THE BOUND `defaultRun` GIVES A `gh` ON ITS OWN. A cut call answers as a refused one (`failed`, `status: null`,
 * `code: "ETIMEDOUT"`, as `ghWithin` throws it), so every caller's fail-open verdict stands and the other calls' answers are intact. The worker's own wait
 * is `BATCH_OUTER_GRACE_MS` longer, so it reports the call it cut before it is killed; if it is killed anyway, `runBatch` throws and the caller runs its calls one by one.
 *
 *
 * @param [callMs] the bound on each call
 * @returns one answer per call, in order
 */
export function runBatch(calls: { args: string[]; repo: string | undefined; }[], env: NodeJS.ProcessEnv = process.env, callMs: number = GH_READ_TIMEOUT_MS): ({ stdout: string; } | { failed: true; stdout: string; stderr: string; status: number | null; code?: string; })[] {
  const send = (sent: typeof calls) => meteredBatch(sent, heldBudget, (live) => runUnmetered(live, env, callMs), (stderr) => ({ failed: true as const, stdout: "", stderr, status: null }));
  return readMemo.on ? memoisedBatch(calls, send) : send(calls);
}

/**
 * `send`, without the reads the memo holds and without a read asked twice in the batch: each is sent once and answered to every asker. The batch's answers
 * are kept as `defaultRun`'s are -- except that a batch holding a write forgets instead, because its calls run together and a read beside a write is not
 * known to have come first. The key is the call's own repository, as `runUnmetered` aims it (the callers resolve the ambient one themselves).
 */
function memoisedBatch<A extends { stdout: string; } | { failed: true; stdout: string; }>(calls: { args: string[]; repo: string | undefined; }[], send: (sent: typeof calls) => A[]): A[] {
  const keys = calls.map(({ args, repo }) => (readOnlyGh(args) ? callKey(args, repo) : null));
  const answers: (A | undefined)[] = calls.map(() => undefined);
  const sentAt = new Map<string, number>();
  const toSend: number[] = [];
  keys.forEach((key, at) => {
    const held = key === null ? undefined : readMemo.answers.get(key);
    if (held !== undefined) {
      answers[at] = { stdout: held } as A;
      readMemo.hits += 1;
    } else if (key === null || !sentAt.has(key)) {
      if (key !== null) sentAt.set(key, at);
      toSend.push(at);
    }
  });
  const sent = toSend.length === 0 ? [] : send(toSend.map((at) => calls[at]));
  toSend.forEach((at, order) => { answers[at] = sent[order]; });
  const wrote = toSend.some((at) => keys[at] === null);
  keys.forEach((key, at) => {
    if (answers[at] !== undefined || key === null) return;
    answers[at] = answers[sentAt.get(key) as number];
    readMemo.hits += 1;
  });
  if (wrote) forgetReads();
  else for (const at of toSend) {
    const answer = answers[at] as A;
    if (!("failed" in answer)) rememberRead(keys[at] as string, answer.stdout);
  }
  return answers as A[];
}

/** `runBatch` without the budget: the calls it is handed are sent. */
function runUnmetered(calls: { args: string[]; repo: string | undefined; }[], env: NodeJS.ProcessEnv, callMs: number) {
  const answers = [];
  for (let from = 0; from < calls.length; from += BATCH_MAX_CALLS) {
    const chunk = calls.slice(from, from + BATCH_MAX_CALLS);
    answers.push(...JSON.parse(execFileSync(process.execPath, ["-e", BATCH_WORKER, JSON.stringify(chunk), String(callMs)],
      { encoding: "utf8", maxBuffer: BATCH_MAX_BUFFER, env, timeout: callMs + BATCH_OUTER_GRACE_MS, killSignal: "SIGKILL" })));
  }
  return answers;
}

const callKey = (args: string[], repo: string | undefined) => JSON.stringify([repo ?? "", args]);

/** How many open rows `readOpenRows` asks for (it spells the number itself: `packaging/work-gate.test.ts` pins that one literal); a list that comes back this long may have been cut, and answers nothing a narrower list could be taken from. A drift between the two turns the fold off, which `work-gate.test.ts` (1a) reads. */
export const OPEN_ROWS_LIMIT = 500;

type OpenRowsList = { label: string | null; limit: number; fields: string[] };

/** @returns what `issue list --state open --limit N --json F` asks (the whole open list, which is no search), or `null` for any other call (an extra flag is a different question, and is never folded) */
function wholeOpenListOf(args: string[]): OpenRowsList | null {
  const rest = args.slice(4);
  const shaped = args.slice(0, 4).join(" ") === "issue list --state open" && rest.length === 4 && rest[0] === "--limit" && rest[2] === "--json" && /^\d+$/.test(rest[1]);
  return shaped ? { label: null, limit: Number(rest[1]), fields: rest[3].split(",") } : null;
}

/** The names a GraphQL selection asks of the row itself, nested selections and their arguments left out: `number labels(first:50){nodes{name}}` is `number`, `labels`. */
function topLevelFields(select: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let word = "";
  for (const char of select) {
    if (depth === 0 && /\w/.test(char)) { word += char; continue; }
    if (word !== "") names.push(word);
    word = "";
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth -= 1;
  }
  return word === "" ? names : [...names, word];
}

/**
 * @returns what a FIRST PAGE of `ticket-port/rows-by-label.ts`'s read of OPEN rows carrying a label asks, or `null` for any other call -- a later page (`after=`), a closed
 * read, or text that is not that reader's query. `limit` is the page size: a label with more rows than that is not answered from the open list (`answerFromOpenRows`).
 */
function labelledOpenListOf(args: string[]): OpenRowsList | null {
  if (!isRowsByLabelRead(args) || args.some((arg) => arg.startsWith("after="))) return null;
  const query = args.find((arg) => arg.startsWith("query=")) ?? "";
  const asked = /issues\(states:OPEN,labels:\[\$label\],first:(\d+),after:\$after[^)]*\)\{pageInfo\{hasNextPage endCursor\} nodes\{(.*)\}\}\}\}$/.exec(query);
  const label = args.find((arg) => arg.startsWith("label="))?.slice("label=".length);
  return asked === null || label === undefined ? null : { label, limit: Number(asked[1]), fields: topLevelFields(asked[2]) };
}

const openRowsListOf = (args: string[]): OpenRowsList | null => wholeOpenListOf(args) ?? labelledOpenListOf(args);

/**
 * #4899: ONE LIST OF THE OPEN ROWS, ASKED ONCE, ANSWERS THE LISTS OF ITS LABELS. The wave asks `issue list --state open --limit 500` for every open row
 * (`readOpenRows`) and, beside it, `--label chairman-blocked`, `--label backlog` (and `--label ready` for another repository's tracker): each a GraphQL read of
 * the same rows with fewer fields, which the 500 already carries. A call whose fields the 500 names and whose label is one of the rows' own is not sent; its
 * answer is made from the 500's, in the order and at the page size `gh` would have given it.
 *
 * `derived` maps a folded call to the call whose answer it is made from. WHEN THE 500 CAME BACK FULL it may have been cut, and a label's rows can lie beyond
 * it, so the folded call is not answered here and is asked as it always was (`readWithFirstWaveTogether` falls through to `run`): the fold is a saving
 * when the list is complete and never a different answer.
 */
function foldIntoOpenRows(calls: { args: string[]; repo: string | undefined }[]): { send: typeof calls; derived: Map<string, { from: string; list: OpenRowsList; call: (typeof calls)[number] }> } {
  const asked = calls.map((call) => ({ key: callKey(call.args, call.repo), repo: call.repo ?? "", list: openRowsListOf(call.args) }));
  const wholes = new Map<string, { key: string; list: OpenRowsList }>();
  for (const { key, repo, list } of asked) if (list !== null && list.label === null && list.limit === OPEN_ROWS_LIMIT) wholes.set(repo, { key, list });
  const derived = new Map<string, { from: string; list: OpenRowsList; call: (typeof calls)[number] }>();
  for (const [at, { key, repo, list }] of asked.entries()) {
    const whole = wholes.get(repo);
    const foldable = list !== null && list.label !== null && whole !== undefined && list.limit <= OPEN_ROWS_LIMIT && list.fields.every((field) => whole.list.fields.includes(field));
    if (foldable) derived.set(key, { from: whole.key, list, call: calls[at] });
  }
  return { send: calls.filter((call) => !derived.has(callKey(call.args, call.repo))), derived };
}

/**
 * A folded call whose list could not answer it (the page came back full, or was refused) is asked as it always was: together with the others like it, in
 * ONE more batch, and never one by one -- those reads were in the first wave before the fold. A single call is left to `run`, which is what a batch of one is.
 * A batch that cannot be made leaves them to `run` too.
 */
function askTogether({ calls, batch, waiting, log }: { calls: { args: string[]; repo: string | undefined }[]; batch: typeof runBatch; waiting: Map<string, unknown>; log: (line: string) => void }): void {
  if (calls.length < 2) return;
  try {
    const answers = batch(calls);
    calls.forEach((call, at) => waiting.set(callKey(call.args, call.repo), answers[at]));
  } catch (err) {
    log(`NOTE: ${calls.length} folded gh calls could not be batched, so they run one by one: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * @returns the folded call's answer made from the whole list's, in the CONNECTION's shape the by-label reader parses (`labels` as `{ nodes }`), or `undefined` when that list is
 * not a complete array of rows or the label has more rows than one page of the connection holds (a first page that is not the whole answer is never made here)
 */
function answerFromOpenRows(whole: string, { label, limit, fields }: OpenRowsList): string | undefined {
  let rows: any;
  try { rows = JSON.parse(whole); } catch { return undefined; }
  if (!Array.isArray(rows) || rows.length >= OPEN_ROWS_LIMIT) return undefined;
  const hasLabel = (row: any) => Array.isArray(row?.labels) && row.labels.some((l: any) => l?.name === label);
  const matched = rows.filter(hasLabel);
  if (matched.length > limit) return undefined;
  const node = (row: any) => Object.fromEntries(fields.map((field) => [field, field === "labels" ? { nodes: row.labels } : row[field]]));
  return JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: matched.map(node) } } } });
}

/**
 * `read`, with the `gh` calls it makes FIRST asked together. A rehearsal runs `read` against a `run` that answers every call `[]` and notes it; those
 * calls go out as one batch; then `read` runs for real against the answers. So the commands, their parsing and every verdict are the reader's own, and
 * only WHEN the waiting happens moves. A call the rehearsal did not foresee (the widened page after a full first one) runs on its own as it always did,
 * and an answer is handed out ONCE: asking again is a new read, as it was. A refusal replays as the throw `execFileSync` made.
 *
 * Only for `defaultRun` unless a `batch` is handed in: a test's `run` stands for `gh` and must see its calls one at a time, and `batch` is the seam
 * that shows them arriving together.
 */
export function readWithFirstWaveTogether<T>(read: (run: (args: string[], repo?: string) => string) => T, run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined, log: (line: string) => void = (line) => process.stderr.write(line)): T {
  if (batch === undefined) return read(run);
  const asked: Map<string, { args: string[]; repo: string | undefined; }> = new Map();
  try {
    read(ambientStandingFor(run, (args: string[], repo = activeRepo) => { asked.set(callKey(args, repo), { args, repo }); return "[]"; }));
  } catch (err) {
    log(`NOTE: a reader threw on the rehearsal's empty answers, so its calls run one by one: ${err instanceof Error ? err.message : String(err)}\n`);
    return read(run);
  }
  const calls = [...asked.values()];
  if (calls.length < 2) return read(run);
  const { send, derived } = foldIntoOpenRows(calls);
  let answers;
  try {
    answers = batch(send);
  } catch (err) {
    log(`NOTE: ${calls.length} gh calls could not be batched, so they run one by one: ${err instanceof Error ? err.message : String(err)}\n`);
    return read(run);
  }
  const waiting = new Map(send.map((call, at) => [callKey(call.args, call.repo), answers[at]]));
  const notFolded: typeof calls = [];
  for (const [key, { from, list, call }] of derived) {
    const whole = waiting.get(from);
    const answer = whole !== undefined && !("failed" in whole) ? answerFromOpenRows(whole.stdout, list) : undefined;
    if (answer !== undefined) waiting.set(key, { stdout: answer });
    else notFolded.push(call);
  }
  askTogether({ calls: notFolded, batch, waiting, log });
  return read(ambientStandingFor(run, (args: string[], repo = activeRepo) => {
    const key = callKey(args, repo);
    const answer = waiting.get(key);
    if (answer === undefined) return run(args, repo);
    waiting.delete(key);
    if (!("failed" in answer)) return answer.stdout;
    throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}\n${answer.stderr}`),
      { status: answer.status, stdout: answer.stdout, stderr: answer.stderr, ...(answer.code === undefined ? {} : { code: answer.code }) });
  }));
}

/**
 * #3674: THE OPEN LIST IS ASKED AT THE SMALLEST PAGE THAT CAN BE COMPLETE, AND AT `OPEN_PRS_LIMIT` ONLY WHEN IT WAS NOT. The request's price is
 * the size of the page it asks for times the nested connections each pull request carries (comments, labels, files, reviews, closing issues,
 * check contexts), NOT the number of pull requests that answer: at 100 it costs 7 GraphQL points and at 20 it costs 1, MEASURED 2026-10-05 by
 * replaying the query `gh` sends (`GH_DEBUG=api`) with `rateLimit { cost }`, the same answer for every repository. The gate asked 100 of each
 * of six code repositories every two minutes, and they held 1, 1, 0, 0, 0 and 0 open pull requests: 42 of the run's 49 `pr list` points.
 * A page that comes back FULL may have been cut, so it is asked again at the limit; a page with room left is the whole list, and no pull
 * request can fall out of it silently, which is the property the 100 was chosen for.
 */
export const OPEN_PRS_FIRST_PAGE = 20;

/** How many open pull requests one repository's list can hold before the gate stops seeing the oldest (as it always has: `gh`'s own `--limit`). */
export const OPEN_PRS_LIMIT = 100;

/** @returns the `--json` fields of a pull request: the open list's, and one pull request's alike */
function prFields(): string {
  return "number,isDraft,headRefOid,baseRefName,statusCheckRollup,author,comments,labels,files,changedFiles,body,"
      // #2084: `reviewDecision` IS WHAT GITHUB ITSELF MERGES ON, AND NO QUEUE READ HERE TOUCHED IT.
      // Measured at `468a74f1b`: `git grep -l reviewDecision -- '*.mjs'` returns exactly ONE file, and it
      // is not a queue read -- `row-claim/own-pr-health-rule.ts` (#2126, merged the same day #2084 was
      // filed) reads it to answer "may this session claim ANOTHER ROW". That refusal emits no order, wakes
      // nobody, fires only on `CHANGES_REQUESTED`, and only for the session holding that row. Nothing that
      // reads the QUEUE touched the field: not this file, not `queue-table.ts`, not `merge-guard.ts`,
      // not `auto-arm-sweep.ts` -- so #2049 sat green, armed and unmergeable for over seven hours with
      // every org read calling it healthy. (#2084's own body says the grep returned zero; that was true
      // when it was filed at 08:5xZ and #2126 landed the same day. The list of readers it names is right.)
      // It arrives on the `pr list` call this function already makes -- one more name in the `--json`
      // list, no extra request and no extra pool -- which is the whole reason the blind spot is worth
      // closing HERE rather than in `queue-table.ts`, whose own header records dropping
      // `mergeStateStatus` precisely because a GraphQL-only field meant a second, refusable call.
      + "reviewDecision,"
      // #2470: `headRefName` -- WHICH BRANCH a pull request is on, so a claimed row can be asked "does it have an open
      // one". One more name on the call already made, like the two above; it is what keeps a row whose author is in
      // review out of `claim-stalled`, whose subject is the build and not the wait for a verdict.
      + "headRefName,"
      // #3445: `title`, the third rung of `ownsPr` (a title ending in the row's `owner/repo#n`); `labels` is already above, the fourth.
      + "title,"
      // #1311: `isCrossRepository` AND `headRepository`, on the same call. The reviewer's trust (`review-trust.ts`) is INSIDE only for a
      // pull request GitHub says is NOT from a fork, so the flag is the one input the decision cannot do without; `headRepository` names
      // the fork for the record. Two more names on a request already made, like the ones above.
      + "isCrossRepository,headRepository,"
      // #2209: `mergeStateStatus` AND `mergeable`, BOTH ON THE SAME CALL, because nothing here read whether
      // a pull request CONFLICTS with `main`. #2203 went DIRTY when #2205 merged, was green and approved,
      // and was reported as a credential outage while six Ready rows sat behind it. `gh pr list --json`
      // offers both names (checked 2026-09-24), so this is two more names on a request already made --
      // not the second, refusable call `queue-table.ts`'s header records avoiding. GitHub computes them
      // lazily and may answer `UNKNOWN`; `conflictStateOf` reads that as unread, never as clean.
      + "mergeStateStatus,mergeable,"
      // #2365: `reviews` AND NOT `latestReviews`, MEASURED 2026-09-24 against `gh` on this host. Both ride on
      // the `--limit 100` call without tripping GraphQL's node limit (which `commits` does), but
      // `latestReviews[].commit.oid` comes back the EMPTY STRING and `reviews[].commit.oid` carries the sha the
      // review was posted at -- and "was this convinced verdict converted into a review AT THIS HEAD" is a
      // question about exactly that sha. `gh api .../pulls/N/reviews` `commit_id` agrees with it. No second call.
      + "reviews,"
      // #2823: `closingIssuesReferences` (what GitHub will close) and `createdAt` (how long the condition has stood), on the
      // same call, so `closesUnresolvedOrders` reads the Closes condition without a second request.
      // #2996: `updatedAt`, the QUIET SINCE of a wait with no stated reason, on the same call.
      + "closingIssuesReferences,createdAt,updatedAt";
}

/** @returns `gh`'s arguments for the open list, newest `limit` first */
function openPrsArgs(limit: number): string[] {
  return ["pr", "list", "--state", "open", "--limit", String(limit), "--json", prFields()];
}

/**
 * Open PRs with everything the draft lane needs: ONE call, and a second only for a list that filled its first page (`OPEN_PRS_FIRST_PAGE`).
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `queueReport`'s rule (#1286), and for its reason: a refused `gh`
 * exits non-zero with empty stdout, so a reader that returns `[]` for it reports "nothing is queued" and
 * the org acts on it. Every caller below must keep the two apart. A refused SECOND read is `null` too: the first page alone is a list that may
 * be cut, which is the one answer a caller cannot tell from a whole one.
 */
export function readPrs(run: (args: string[]) => string = defaultRun, conditional: ConditionalReads | null = isGhRun(run) ? conditionalFor(undefined) : null, { home = isAmbientRun(run), tickScopesPath = process.env[TICK_SCOPES_VARIABLE], memoryPath, nowMs = Date.now() }: { home?: boolean; tickScopesPath?: string; memoryPath?: string; nowMs?: number; } = {}): any[] | null {
  const scopes = home && tickScopesPath !== undefined ? readTickScopes(tickScopesPath) : null;
  if (scopes === null) return readPrsWhole(run, conditional);
  // resolved here and not as a default: poll mode never asks the host declaration for a path, so one it cannot read changes nothing there
  memoryPath ??= stateEntryPath(OPEN_PRS_MEMORY);
  const repo = repoNow();
  const memory = readPrList({ path: memoryPath, repo, nowMs, maxAgeMs: MAX_UNCHANGED_SECONDS * 1000 });
  const narrowed = narrowedPrList({ repo, memory, scopes, view: (number) => JSON.parse(run(pullViewArgs(number, `${prFields()},state`))) });
  if (narrowed.mode === "narrowed") {
    rememberOpenPrs({ memoryPath, repo, prs: narrowed.prs, readAtMs: narrowed.readAtMs });
    return withPagedFiles(narrowed.prs, { run });
  }
  const whole = readPrsWhole(run, conditional);
  // A repository with NO open pull requests is never remembered (below), so its list reads whole every tick and its old entry ages for as long as it
  // stays empty: the line would repeat each tick about a state that is not a fault (2026-10-13: one repository was empty for 2 h 20 min, 60 ticks).
  // Said only when there was something to patch, or a list that was not empty.
  if (whole === null || whole.length > 0) process.stderr.write(`work-gate: the open list is read whole (${narrowed.reason}: ${narrowed.detail})\n`);
  // An EMPTY list is never remembered: the first-wave rehearsal answers every call `[]`, and a remembered `[]` would be served as the repository's list
  // (every pull request but the named ones gone). A repository with no open pull requests reads whole each tick, which is one cheap call.
  if (whole !== null && whole.length > 0) rememberOpenPrs({ memoryPath, repo, prs: whole, readAtMs: nowMs });
  return whole;
}

/** The open list read whole: through the conditional reader when it is on, and as `readPrsAsListed` asks it when it is not or it fell back. `null` when refused. */
function readPrsWhole(run: (args: string[]) => string, conditional: ConditionalReads | null): any[] | null {
  const answered = conditional === null ? undefined : conditionalPrs({ run, conditional });
  return answered === undefined ? readPrsAsListed(run) : answered;
}

/** `readPrs` as the gate has always asked it, and what every fallback of the conditional read is: the flag off, a REST read that failed, a list that may be cut. */
function readPrsAsListed(run: (args: string[]) => string): any[] | null {
  try {
    const first = JSON.parse(run(openPrsArgs(OPEN_PRS_FIRST_PAGE)));
    const parsed = Array.isArray(first) && first.length >= OPEN_PRS_FIRST_PAGE ? JSON.parse(run(openPrsArgs(OPEN_PRS_LIMIT))) : first;
    return Array.isArray(parsed) ? withPagedFiles(parsed, { run }) : null;
  } catch {
    return null;
  }
}

/**
 * a11ign#5169, THE WIRING OF #5128: `readPrs` AND `readOpenRows` ASK GITHUB LESS WHEN `gate.restConditional` IS ON, and are what they always were when it is not.
 *
 * WHY THE LISTING IS REST. A GraphQL `pr list` is charged by the page and the connections each pull request carries (1 point at 20, 7 at 100, measured
 * 2026-10-05, above), and a REST list of the same repository is a conditional GET: its `ETag` comes back `304` when nothing in it changed, which GitHub does
 * not charge to the primary limit (documented, NOT measured here; the live hour is what says). The REST list carries only what CHANGES a pull request's
 * detail (its head sha and `updated_at`), so it decides which pull requests' detail must be asked again, and everything else is kept.
 *
 * WHAT IS KEPT IS THE GRAPHQL ANSWER, NOT THE REST ONE (`gate-conditional/kept-reads.json`, beside the validators), because the gate reads
 * `statusCheckRollup`, `reviewDecision` and `mergeStateStatus` and the REST list has none of them. Three of those do NOT move `updated_at`: a check
 * finishing, a re-run, and `main` moving under a pull request (the #2209 conflict). So a kept detail is trusted only while (1) its head and `updatedAt` are
 * unchanged, (2) no check in its rollup is still running (`withChecksPending`, the one reader of that meaning) and (3) it is under
 * `KEPT_READ_MAX_AGE_MS` old. A pull request that fails any is asked again. (3) is the one place the flag makes a reading LATER than it was: a conflict is
 * seen up to ten minutes after `main` moved, where it was seen on the next tick.
 *
 * NOTHING HERE IS ALLOWED TO MAKE A READ WORSE THAN THE FLAG-OFF ONE. Every failure (the REST call, its parse, a view, a store that will not read) is said
 * on stderr and answered by the read as it always was; a list that fills its page may be cut, so it is asked as it always was too; and an answer is
 * NEVER KEPT UNLESS IT AGREES WITH THE LISTING IT WAS VALIDATED AGAINST (open rows), or EMPTY (pull
 * requests). That is what lets the first-wave rehearsal (`readWithFirstWaveTogether`, which answers every call `[]`) run these readers without a `[]` ever
 * being kept in place of a list.
 */
export type ConditionalReads = { ask: Ask; dir: string; now: number; repo: string; };

/**
 * One GET of `path`, with the `If-None-Match` it is given. `-H` comes FIRST so the `gh` ledger (two words) counts the conditional reads apart (`api -H`).
 * Made through `ghWithin`, the one place this file spawns `gh`, so the read is cut at the same bound and the call-site ratchet (agent-org#826) holds no new spawn;
 * the arguments are the ticket port's (`conditionalGetArgs`), which is where a new call shape goes.
 * `gh` exits 1 on a 304, so a numeric exit status is an ANSWER to parse; a timeout or a failure to start (no status) is thrown as it is.
 */
export const ghAskWithin = (timeoutMs: number): Ask => {
  const run = ghWithin(timeoutMs, { stdio: "pipe" });
  return (path, etag) => {
    try {
      return parseReply({ stdout: run(conditionalGetArgs(path, etag)), stderr: "", path, sent: etag });
    } catch (error) {
      const { status, stdout, stderr } = error as { status?: unknown; stdout?: unknown; stderr?: unknown; };
      if (typeof status !== "number") throw error;
      return parseReply({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), path, sent: etag });
    }
  };
};

/**
 * What a test stands in for the marker, the state directory and `gh api`, so the gate's OWN selection of the conditional reader (`isGhRun`, through the
 * first wave's wrappers) can be walked without a host or a `gh`; `null` is the real one.
 */
let conditionalSource: ((repo: string | undefined) => ConditionalReads | null) | null = null;
export function useConditionalSource(source: ((repo: string | undefined) => ConditionalReads | null) | null): void {
  conditionalSource = source;
}

/**
 * The conditional reads for `repo` (`undefined` is the ambient one), or `null` when `gate.restConditional` is off: the marker is read WHEN A READ IS MADE, so
 * a tick sees one answer and a change lands on the next.
 */
export function conditionalFor(repo: string | undefined): ConditionalReads | null {
  if (conditionalSource !== null) return conditionalSource(repo);
  return restConditionalOn() ? { ask: ghAskWithin(GH_READ_TIMEOUT_MS), dir: stateEntryPath(GATE_VALIDATORS_DIR), now: Date.now(), repo: repo ?? repoNow() } : null;
}

/** How many REST reads this process asked and how many were answered `304`: the tick logs it, and the live hour's "304 share" is read from that line. */
const restReads = { asked: 0, notModified: 0 };
export const restReadsOfTick = () => ({ ...restReads });

const REST_PAGE = 100;

/** A kept detail is asked again at this age whatever else is true of it: `main` moving under a pull request moves nobody's `updated_at`. */
export const KEPT_READ_MAX_AGE_MS = 10 * 60_000;

/** What one `gh pr list` of a repository costs in GraphQL points, MEASURED 2026-10-05 (above): a first page of 20, and the full 100. */
const PR_LIST_POINTS = { firstPage: 1, full: 7 };
const listPoints = (count: number) => (count > OPEN_PRS_FIRST_PAGE ? PR_LIST_POINTS.full : PR_LIST_POINTS.firstPage);

const KEPT_READS_FILE = "kept-reads.json";
type KeptPr = { readAt: number; pr: any; };
type KeptRepo = { prs?: Record<string, KeptPr>; rows?: { signature: string; readAt: number; rows: any[]; }; answers?: { signature: string; readAt: number; rows: any[]; }; };

const said = (cause: unknown) => String((cause as { message?: string; })?.message ?? cause).split("\n")[0];

/** The kept details. Absent, unreadable or ill-shaped is NONE, said on stderr when it was there: the worst a bad store does is cost the reads it would have saved. */
function readKept(dir: string): Record<string, KeptRepo> {
  const path = join(dir, KEPT_READS_FILE);
  if (!existsSync(path)) return {};
  try {
    const kept = JSON.parse(readFileSync(path, "utf8"));
    return kept !== null && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
  } catch (cause) {
    process.stderr.write(`NOTE: ${path} is unreadable (${said(cause)}); the gate reads as it always has\n`);
    return {};
  }
}

/** A temporary file and a rename, so a tick killed mid-write leaves the old store and never half of one. */
function saveKept(dir: string, kept: Record<string, KeptRepo>): void {
  const path = join(dir, KEPT_READS_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(kept));
  renameSync(`${path}.tmp`, path);
}

/** Runs `read` with a conditional GET over the kept validators, and writes them back (and counts the 304s) whether `read` finished or threw. */
function restPages({ ask, dir, now }: ConditionalReads, read: (get: (path: string, reduce: (body: any) => any) => any) => void): void {
  const held = readValidators(dir);
  const reader = conditionalGate({ held, ask, now });
  try {
    read(reader.read);
  } finally {
    restReads.asked += reader.reads.asked;
    restReads.notModified += reader.reads.notModified;
    saveValidators({ out: dir, held, now });
  }
}

type Listed = { number: number; headRefOid: string; updatedAt: string; };

/** The open pull requests' head and `updatedAt`, from ONE REST page; `null` when the page is full, which may be a cut one. */
function listOpenPrs(conditional: ConditionalReads): Listed[] | null {
  let listed: Listed[] = [];
  restPages(conditional, (get) => {
    listed = get(`repos/${conditional.repo}/pulls?state=open&per_page=${REST_PAGE}`, (body) => {
      if (!Array.isArray(body)) throw new Error("the pull request list was not a list");
      return body.map((pr) => ({ number: pr.number, headRefOid: pr.head.sha, updatedAt: pr.updated_at }));
    });
  });
  return listed.length >= OPEN_PRS_LIMIT ? null : listed;
}

/** `true` when a kept detail can no longer be trusted: a check still running, or old enough that nothing but time could have changed it. */
const stillMoving = (kept: KeptPr, now: number): boolean => now - kept.readAt >= KEPT_READ_MAX_AGE_MS || withChecksPending([kept.pr])[0].checksPending;

const isDetailOf = (kept: KeptPr | undefined): kept is KeptPr =>
  kept !== undefined && typeof kept.pr?.number === "number" && typeof kept.pr.headRefOid === "string" && typeof kept.pr.updatedAt === "string" && Number.isFinite(kept.readAt);

/** One pull request's detail, with the fields the open list asks (so a view and a list can never disagree about shape). */
function viewPr(number: number, run: (args: string[]) => string): any {
  const pr = JSON.parse(run(pullViewArgs(number, prFields())));
  if (Array.isArray(pr)) return null; // `gh pr view` answers an object: a list is a stand-in (the first wave's `[]`), and says so
  if (pr?.number !== number) throw new Error(`gh pr view ${number} answered something else`);
  return pr;
}

/**
 * The open pull requests, asked of GraphQL only for those that CHANGED. `undefined` is "could not, ask as always"; `null` is REFUSED, never empty (#1286).
 * Reading the changed ones one by one costs a point each, so a list that would cost no more than that is read whole (`listPoints`): below twenty open
 * pull requests that is any change at all, and the saving is the tick on which NOTHING changed.
 */
function conditionalPrs({ run, conditional }: { run: (args: string[]) => string; conditional: ConditionalReads; }): any[] | null | undefined {
  try {
    const listed = listOpenPrs(conditional);
    if (listed === null) return undefined;
    return listed.length === 0 ? [] : keptOrAsked({ run, conditional, listed });
  } catch (cause) {
    process.stderr.write(`NOTE: the conditional read of ${conditional.repo}'s pull requests failed (${said(cause)}); read as the gate always has\n`);
    return undefined;
  }
}

function keptOrAsked({ run, conditional, listed }: { run: (args: string[]) => string; conditional: ConditionalReads; listed: Listed[]; }): any[] | null {
  const { dir, now, repo } = conditional;
  const all = readKept(dir);
  const held = Object.fromEntries(Object.entries(all[repo]?.prs ?? {}).filter(([, kept]) => isDetailOf(kept)));
  const { reread, unchanged } = partitionUnchanged(listed, seenOf(Object.values(held).map((kept) => kept.pr)));
  const mustRead = new Set([...reread, ...unchanged.filter((pr) => stillMoving(held[pr.number], now))].map((pr) => pr.number));
  if (mustRead.size >= listPoints(listed.length)) return readWholeAndKeep({ run, conditional, all });
  const fresh = new Map<number, any>();
  for (const number of mustRead) fresh.set(number, viewPr(number, run));
  // Every view was asked, so a rehearsal has named them all for the batch; an answer that was a stand-in has no value to keep or to return.
  if ([...fresh.values()].includes(null)) return [];
  const prs = listed.map(({ number }) => fresh.get(number) ?? held[number].pr);
  saveKept(dir, { ...all, [repo]: { ...all[repo], prs: Object.fromEntries(prs.map((pr) => [pr.number, { readAt: fresh.has(pr.number) ? now : held[pr.number].readAt, pr }])) } });
  return withPagedFiles(prs, { run });
}

/**
 * The whole list, as always asked, and kept unless it came back EMPTY: it is reached only when the REST listing named pull requests, so an empty answer
 * is a refusal's cousin or the rehearsal's `[]`, and keeping it would erase every detail already held. A partial one is safe to keep, because each kept
 * detail is checked against the listing by number, head and `updatedAt` before it is trusted.
 */
function readWholeAndKeep({ run, conditional: { dir, now, repo }, all }: { run: (args: string[]) => string; conditional: ConditionalReads; all: Record<string, KeptRepo>; }): any[] | null {
  const whole = readPrsAsListed(run);
  if (whole !== null && whole.length > 0) {
    saveKept(dir, { ...all, [repo]: { ...all[repo], prs: Object.fromEntries(whole.map((pr) => [pr.number, { readAt: now, pr }])) } });
  }
  return whole;
}

/** The open ISSUES' numbers and `updated_at`, read page by page (pull requests, which this list also carries, are left out); `null` when every page was full, which may be a cut one. */
function listOpenIssues(conditional: ConditionalReads): { numbers: number[]; signature: string; } | null {
  const stamps: string[] = [];
  let whole = false;
  restPages(conditional, (get) => {
    for (let page = 1; page <= OPEN_ROWS_LIMIT / REST_PAGE && !whole; page += 1) {
      const answer = get(`repos/${conditional.repo}/issues?state=open&per_page=${REST_PAGE}&page=${page}`, (body) => {
        if (!Array.isArray(body)) throw new Error("the issue list was not a list");
        return { count: body.length, stamps: body.filter((issue) => issue.pull_request === undefined).map((issue) => `${issue.number}@${issue.updated_at}`) };
      });
      stamps.push(...answer.stamps);
      whole = answer.count < REST_PAGE;
    }
  });
  return whole ? { numbers: stamps.map((stamp) => Number(stamp.split("@")[0])), signature: stamps.join(",") } : null;
}

/**
 * The open rows, kept while the REST listing is the one they were read under. Nothing is asked of GraphQL on a tick where no row moved, and a row that
 * moved has the whole list asked again: `blockedBy` and `subIssuesSummary` are GraphQL's alone, so a changed row cannot be read any narrower.
 */
function conditionalOpenRows({ run, conditional }: { run: (args: string[]) => string; conditional: ConditionalReads; }): any[] | null {
  const { dir, now, repo } = conditional;
  let listing: ReturnType<typeof listOpenIssues> = null;
  try {
    listing = listOpenIssues(conditional);
  } catch (cause) {
    process.stderr.write(`NOTE: the conditional read of ${repo}'s open rows failed (${said(cause)}); read as the gate always has\n`);
  }
  const all = readKept(dir);
  const kept = all[repo]?.rows;
  if (listing !== null && kept !== undefined && Array.isArray(kept.rows) && kept.signature === listing.signature && now - kept.readAt < KEPT_READ_MAX_AGE_MS) return kept.rows;
  const rows = readOpenRowsAsListed(run);
  if (listing !== null && rows !== null) {
    const named = new Set(rows.map((row) => row?.number));
    if (listing.numbers.every((number) => named.has(number))) saveKept(dir, { ...all, [repo]: { ...all[repo], rows: { signature: listing.signature, readAt: now, rows } } });
  }
  return rows;
}

/**
 * agent-org#1636: THE CLOSED ROWS AND PULL REQUESTS THAT STILL OWE AN ANSWER ARE KEPT FOR `KEPT_ANSWERS_MAX_AGE_MS`, when `gate.restConditional` is on. They are the dearest list the gate asks
 * (one GraphQL point per answer label per kind, every tick) and the one that moves least: a row is on it only after it was closed with an `answer:` label kept on it. `signature` is the
 * labels asked for, so a session that is new (or ended) is asked for at once; the age is the one place this makes a reading later, by at most the age, of a question nobody has answered yet.
 * `read` is what the gate always made; a `null` (refused) is never kept, and a flag off, or a run that is not `gh`, is `read()` as it was.
 */
export const KEPT_ANSWERS_MAX_AGE_MS = 5 * 60_000;
export function keptClosedAnswers(signature: string, read: () => any[] | null, conditional: ConditionalReads | null): any[] | null {
  if (conditional === null) return read();
  const { dir, now, repo } = conditional;
  const kept = readKept(dir)[repo]?.answers;
  if (kept !== undefined && Array.isArray(kept.rows) && kept.signature === signature && now - kept.readAt >= 0 && now - kept.readAt < KEPT_ANSWERS_MAX_AGE_MS) return kept.rows;
  const rows = read();
  if (rows !== null) {
    const all = readKept(dir);
    saveKept(dir, { ...all, [repo]: { ...all[repo], answers: { signature, readAt: now, rows } } });
  }
  return rows;
}

/** Where the whole open list is remembered per repository, so a webhook tick re-reads only the pull requests its scopes name (`pr-list-memory.ts`). */
const OPEN_PRS_MEMORY = "open-prs-memory.json";

/** The variable `work-tick.ts` names the tick's scopes in (`TICK_SCOPES_VARIABLE`): this file reads it without importing the tick. */
const TICK_SCOPES_VARIABLE = "A11Y_TICK_SCOPES_FILE";

/** A remembered list older than this is read whole again: the reconcile that catches what no event named. */
export const MAX_UNCHANGED_SECONDS = DEFAULT_RECONCILE_MINUTES * 60;

/** A list that cannot be remembered is said, and the tick still has its list: the next webhook tick then reads whole, which is the safe answer. */
function rememberOpenPrs({ memoryPath, repo, prs, readAtMs }: { memoryPath: string; repo: string; prs: any[]; readAtMs: number; }): void {
  try {
    writePrList({ path: memoryPath, repo, prs, readAtMs });
  } catch (error) {
    process.stderr.write(`work-gate: the open list could not be remembered (${String((error as Error).message).split("\n")[0]}); the next webhook tick reads whole\n`);
  }
}

/** Where a truncated pull request's paged file list is remembered between ticks: each tick is a fresh process, so memory would not outlive one. */
const PAGED_FILES_CACHE = "truncated-pr-files.json";

/** How many paged lists the cache keeps. A version PR's head moves with every push to `main`, so an unbounded file would grow for as long as it lives. */
const PAGED_FILES_KEPT = 20;

/**
 * #3365: A PULL REQUEST OF MORE THAN 100 FILES IS COMPARED BY ALL OF ITS FILES, NOT DROPPED. `gh pr list --json files` returns the first 100 and
 * never says so; `comparablePrFiles` rightly refuses a list shorter than `changedFiles`, so the gate could not shelve a row against such a PR
 * while the claim and the spawn check (`pagedPrFiles`, `file-overlap-rule.ts`) paged REST and refused it. The release workflow's version PR is
 * 146 files and open nearly all the time: a row naming a `package.json` was offered 30 ticks running and refused at the spawn every time.
 *
 * ONLY a truncated PR is paged, and a complete list costs no call and no disk read. The paged list is cached by PR number + head sha, so a
 * two-minute tick pays the REST pages once per head. A PR whose paging FAILS (or comes back with the wrong count) is returned as it was and
 * still drops out of the comparison, as it did before: the gate fails open and the claim stays the authority. That is said on stderr.
 * NEVER THROWS: a failure here must not turn into a refused `pr list`.
 *
 * `{owner}/{repo}` are `gh api`'s own placeholders, resolved from the `GH_REPO` that `run` is aimed with.
 */
export function withPagedFiles(prs: any[], { run, cachePath = stateEntryPath(PAGED_FILES_CACHE), log = (line) => process.stderr.write(line) }: { run: (args: string[]) => string; cachePath?: string; log?: (line: string) => void; }): any[] {
  const truncated = prs.filter((pr) => Array.isArray(pr?.files) && pr.files.length < Number(pr.changedFiles));
  if (truncated.length === 0) return prs;
  const cache = readPagedFilesCache(cachePath, log);
  let fetched = false;
  const paged = new Map(truncated.map((pr) => {
    const key = typeof pr.headRefOid === "string" ? `${pr.number}@${pr.headRefOid}` : null;
    const cached = key === null ? undefined : cache[key];
    if (Array.isArray(cached) && cached.length === pr.changedFiles) return [pr, cached];
    const files = pageFilesOf(pr, { run, log });
    if (files !== null && key !== null) { cache[key] = files; fetched = true; }
    return [pr, files];
  }));
  if (fetched) writePagedFilesCache(cachePath, cache, log);
  return prs.map((pr) => ((paged.get(pr) ?? null) === null ? pr : { ...pr, files: (paged.get(pr) as string[]).map((path) => ({ path })) }));
}

/** @returns `null` when the pages could not be read whole */
function pageFilesOf(pr: any, { run, log }: { run: (args: string[]) => string; log: (line: string) => void; }): string[] | null {
  try {
    const files = run(["api", "--paginate", `repos/{owner}/{repo}/pulls/${pr.number}/files?per_page=100`, "--jq", ".[].filename"]).split("\n").filter(Boolean);
    if (files.length === pr.changedFiles) return files;
    log(`work-gate: #${pr.number} lists ${files.length} files when paged, not the ${pr.changedFiles} it reports -- left out of B4's comparison; the claim still refuses (#3365)\n`);
  } catch (error) {
    log(`work-gate: could not page #${pr.number}'s files past ${pr.files.length} (${String((error as Error).message).split("\n")[0]}) `
      + "-- left out of B4's comparison, so the gate fails open and the claim still refuses (#3365)\n");
  }
  return null;
}

/** @returns an absent file is an empty cache; an unreadable one is said aloud and is too */
function readPagedFilesCache(path: string, log: (line: string) => void): Record<string, string[]> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    log(`work-gate: ${path} is unreadable (${(error as Error).message}); paging again (#3365)\n`);
    return {};
  }
}

/** Keeps the newest `PAGED_FILES_KEPT` entries (insertion order), and writes through a rename so a tick reading it never sees half a file. */
function writePagedFilesCache(path: string, cache: Record<string, string[]>, log: (line: string) => void) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const kept = Object.fromEntries(Object.entries(cache).slice(-PAGED_FILES_KEPT));
    const scratch = `${path}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(kept));
    renameSync(scratch, path);
  } catch (error) {
    log(`work-gate: could not remember the paged file lists in ${path} (${(error as Error).message}); the next tick pages again (#3365)\n`);
  }
}

/**
 * WHAT A TICK ACTUALLY COSTS, COUNTED RATHER THAN REMEMBERED.
 *
 * "Two `gh` calls, no model" is this org's shorthand for the gate -- it is in `agent-practices.md`, it was
 * in two comments in this file, and IT WAS WRONG. `main` has made four unconditional reads since long
 * before the recent causes: the pull-request list, the Ready rows, the promotable backlog and the
 * chairman-blocked rows. The number was true when the file was written and nobody re-counted it while
 * three readers were added.
 *
 * FOUND BY A REVIEWER, ON A CHANGE THAT REPEATED IT. #1769's own comment claimed "the two-call steady
 * state is unchanged"; `reviewer` measured the call sites and reported it as a should-fix. The claim that
 * mattered -- that the new read is CONDITIONAL and a healthy tick does not pay it -- was true. The number
 * it was attached to was inherited, and this constant exists so the next person inherits a count that is
 * checked instead.
 *
 * The conditional reads are deliberately NOT in this number: `requiredCheckNames` is paid only by a tick
 * that saw a settled-red check.
 *
 * THERE IS NO LONGER A SILENCE-CONDITIONAL READ, and its removal is #1938. `readOpenRowState` used to
 * ask for `number,body,blockedBy` over the same 500 open rows the UNCONDITIONAL `readOpenRows` had
 * already fetched in the same process, one tick earlier -- a strict subset of a list the gate held in
 * hand. `openRowState` now derives the same answer from those rows without asking again. The key that
 * named it is gone rather than emptied, so nothing reads a stale name.
 *
 * THERE IS NO LONGER AN EMPTY-SHELF-CONDITIONAL READ EITHER, and its removal is #4042. `readEpics` (`issue list
 * --label epic`) was paid only by a tick that found no Ready row, so a finished epic reached nobody while a
 * single row was Ready (#2899 sat at 13 of 13 for three days). `readOpenRows` now carries `subIssuesSummary`
 * and `epicRowsOf` filters the epics out of it: the unconditional count is UNCHANGED at the number the test
 * pins, and the conditional read is gone, so a tick makes one `gh` call fewer on an empty shelf and none more
 * on a busy one.
 *
 * THE THREE LABEL LISTS BELOW ARE A CEILING, NOT A COUNT (#4899). `readWithFirstWaveTogether` makes `issue list --label ready|backlog|needs:chairman`
 * from the one 500-row open list when that list came back COMPLETE (under 500 rows) and names the fields the label read asked for, so a healthy tick sends
 * ONE `issue list` per tracker where it sent three or four. A full page falls back to the per-label reads, which is why they stay in this list and the
 * number the test pins stays where it was: the ceiling is what a tick with 500 or more open rows pays. `src/work-gate.test.ts` counts the calls of a
 * fixed fixture, in both shapes.
 */
export const GH_READS = Object.freeze({
  // #3674: ONE `pr list` PER CODE REPOSITORY (readPrs, at `OPEN_PRS_FIRST_PAGE`, 1 point each), the primary's here and the others' in `perOtherCodeRepositoryOpenList`.
  unconditional: ["pr list --state open --limit 20 (readPrs)",
    // #5050: THE THREE LABEL LISTS ARE CONNECTIONS, NOT SEARCHES -- `repository.issues(labels:, states: OPEN)` over `gh api graphql`, charged to the GraphQL points and never to the
    // search allowance a `gh issue list --label` spends. On a tick whose open list is complete they are made from it and never sent (`foldIntoOpenRows`).
    "api graphql repository.issues(labels: ready, states: OPEN) (readReadyRows)", "api graphql repository.issues(labels: backlog, states: OPEN) (readPromotableRows)",
    "api graphql repository.issues(labels: needs:chairman, states: OPEN) (readChairmanBlocked)", "issue list (all open: answer/blocked labels)",
    // #2202: TWO SMALL CALLS, because a closed row still owing an answer is invisible to the open read above
    // and `gh` cannot filter a label PREFIX. The first lists the repo's `answer:` label names, the second
    // asks for the closed rows carrying any of them -- exact, so no window a row can fall out of silently.
    "label list --search answer: (readClosedAnswerRows)",
    "api graphql repository { a<n>: issues(labels: [<answer label>], states: CLOSED) } (readClosedAnswerRows -- answer-owed on a closed row; one alias per label, since a search's OR is a connection's AND)",
    // #2641: THE THIRD OF THEM, and the one that moved the count from 9 to 10. A pull request that is no longer open is
    // not an `issue list` row and not a `readPrs` row, and a stuck cause whose subject is a MERGED one (`trunkRedOrders`)
    // labels it `answer:ceo` where nothing looked. Same label names as the call above, so no second `label list`.
    "api graphql repository { a<n>: pullRequests(labels: [<answer label>], states: [CLOSED, MERGED]) } (readClosedAnswerRows -- answer-owed on a merged or closed pull request)",
    // #2356: ONE REST CALL on the core pool -- the newest runs of `trunk.yml` on `main` (readTrunkRed).
    "api actions/workflows/trunk.yml/runs (readTrunkRed -- trunk-red)",
    // #2075: ONE GRAPHQL CALL PER 100 OPEN ROWS (one, at 50 open), each row carrying ITS OWN `projectItems` -- never the board
    // listing, which lags minutes behind an add (see `readRowsOffBoard`).
    "api graphql repository.issues(states: OPEN) { projectItems } (readRowsOffBoard -- row-off-board)",
    // #2936: ONE REST CALL on the core pool -- the 20 newest-updated closed pull requests, of which the latest `merged_at` is the last merge.
    "api repos/{repo}/pulls?state=closed&sort=updated (readLastMergedAt -- org-health's no-merge-while-work-exists)",
    // #4001: ONE REST CALL on the core pool -- the 30 newest `release.yml` runs on `main` (readReleaseRuns -- org-health's release-run-failed). While the newest verdict is a failure it makes TWO
    // MORE (that run's jobs, and `.changeset/` on `main`), which are the failure's detail and are not counted here.
    // agent-org#887: THE SAME CALL FOR EACH OTHER REPOSITORY THE ORG RELEASES (`releaseRepositories`: the project's, then every `dora` entry -- eight today, so eight calls a tick, 240 an hour of the
    // 5,000 core pool). A failing repository costs ONE MORE (the failed job's log, for its first error line), and the open `incident` list is read while any release verdict is read (the same call
    // `readFleetBuildIncidents` makes, which `host/gh` answers from disk inside 20 s).
    "api repos/{repo}/actions/workflows/release.yml/runs (readReleaseRuns -- org-health's release-run-failed)",
    // #4126: ONE REST CALL on the core pool -- the 100 newest-updated closed rows, projected to number, state, close time and labels (readClassRepeat -- org-health's class-repeat). It makes ONE MORE
    // PER CLASS whose newest instance closed in the last 90 minutes (that class's closed rows, all time), which are the repeat's detail and are not counted here.
    "api repos/{repo}/issues?state=closed (readClassRepeat -- org-health's class-repeat)",
    // #4405: ONE REST CALL on the core pool -- the open issues labelled `incident` (readFleetBuildIncidents -- org-health's fleet-build-mixed-over-4h), kept when their body carries the fleet-build line.
    "api repos/{repo}/issues?state=open&labels=incident (readFleetBuildIncidents -- org-health's fleet-build-mixed-over-4h)"],
  // #4128: NOT A PER-TICK READ, so it is in none of these lists. `releaseBehindNow` reads every dora repository at most ONCE AN HOUR (`cachedReleaseBehind`, kept in the state directory) and
  // judges the kept facts against the clock on every tick. Per hour, per repository: the latest release (the npm registry, or ONE `releases` call), one `commits?path=` call per releasable
  // path, and TWO calls (`commits/{sha}`, `commits/{sha}/pulls`) per unreleased commit up to 20 -- measured in the pull request that added it.
  // #3535: ONE GRAPHQL CALL, ONLY WHEN HERDR LISTS AT LEAST ONE `worker-<n>`, for THOSE rows' numbers (one aliased `issue(number: n)` each, state, labels and comments), asked with the
  // follow-ups' wave (`readOpenRowFollowUps`) so its wall time overlaps theirs. A row CLOSED while it still carries the claim is in none of the open lists above, and the instance
  // holding it is only ever visible in herdr; an org running no per-row instance pays nothing. NOT the closed `in-progress` list, with their comments: 264 rows today, none a live claim.
  // #3883: ONE CALL, EVERY TICK THAT HAS A COMPLETE HERDR LISTING (always, on a live org): the CLOSED rows still carrying `in-progress`, `number,labels` only, filtered
  // server-side, so what comes back is the claim debris and nothing else (the 25 live-seat rows plus whatever a hand close left since the last tick), never 264 rows' comments.
  conditionalOnCompleteHerdrListing: "api graphql repository.issues(labels: in-progress, states: CLOSED) number,labels,closedAt, the newest 500 (readClosedClaimLabelRows, once per declared tracker -- a closed row's claim labels, stripped when the holder is not listed, or is an idle worker past ten minutes)",
  conditionalOnListedWorker: "api repos/<repo>/issues/<n> for each listed worker-<n>, and each worker-<key>-<n> in its own tracker, then issues/<n>/comments, issues/<n>/timeline and pulls/<n> for each CLOSED claimed row (readClosedClaimedRows -- a closed row's claim, over REST: GraphQL's pool can run dry, REST's does not, agent-org#1113)",
  // #3390: TWO REST CALLS PER ROW LABELLED `needs:chairman` (its `labeled` events, and its comments), and NONE when nothing carries the label.
  conditionalOnChairmanLabelledRow: "api repos/{owner}/{repo}/issues/{n}/events and /comments (withChairmanEventTimes -- chairman-answered)",
  // #3079: THREE REST CALLS PER NON-PRIMARY CODE REPOSITORY, every tick (agent-org#539; it was one) -- the newest push runs and the newest schedule runs of its `ci.yml` on
  // `main`, and the jobs of the newest verdict run, which a green run needs for a red `cross-repo` leg -- and three more on a tick that finds it red. None for one declared project, which is why it is not in `unconditional`: that list is the primary's own.
  // #3674: AND TWO MORE `pr list` PER NON-PRIMARY CODE REPOSITORY -- its open list (`readLanes`) and its merged one (`readElsewherePrs`, paid when any row is claimed). 1 point
  // each; the primary's own merged list is `conditionalOnClaimedBranches`. A list that FILLS its first page is asked again at `OPEN_PRS_LIMIT` (7 points): `conditionalOnFullOpenPage`.
  perOtherCodeRepositoryOpenList: "pr list --state open --limit 20 (readPrs via readLanes -- per non-primary code repository)",
  perOtherCodeRepositoryMergedList: "pr list --state merged --limit 100 (readMergedPrs via readElsewherePrs -- per non-primary code repository, while a row is claimed)",
  conditionalOnFullOpenPage: "pr list --state open --limit 100 (readPrs -- only for a repository whose first page of OPEN_PRS_FIRST_PAGE came back full)",
  perOtherCodeRepository: "api repos/{repo}/actions/workflows/ci.yml/runs, once for event=push and once for event=schedule, and actions/runs/{id}/jobs of the newest verdict run (readTrunkRed -- trunk-red for a declared code repository)",
  // ONE call, and it needs no admin (#2331). It used to be two -- the admin-only protection endpoint, then
  // `branches/main` as the discriminator for its 404 (#2106, #2022) -- and the discriminator's only job
  // was to explain the admin-only 404, which `branches/main` does not give a non-admin credential. Conditional on a settled-red check.
  // #3448: AND ON A GREEN DRAFT, which the ready-flip over a red verify stamp needs the required list for (`requiredWhenNeeded`).
  // #5020: TWO calls when the rulesets give nothing -- `rules/branches/main` first, `branches/main` only then.
  conditionalOnRed: "api rules/branches/main, then branches/main only if that gave no list (requiredCheckNames)",
  // #2117: ONE MORE CORE READ ON THE SAME RED TICK -- `main`'s tip commit, so the `pr-checks-failing` prompt can
  // say whether `main` moved after the failing run started. `branches/main` already carries that commit, but
  // `requiredCheckNames` returns a bare list and four tests pin its shape; a second read costs one call on a tick
  // that is already paying one, and never touches a healthy tick.
  conditionalOnRedBase: "api commits/main (readBaseTip -- pr-checks-failing's `has main moved`)",
  // #1969, AND IT IS COUNTED HERE BECAUSE THE LAST ONE WAS NOT. This constant exists because "two `gh`
  // calls" was repeated for weeks while three readers were added, and a reviewer had to measure the call
  // sites to find it. The condition is `shouldBeMerging` finding a green, unheld, non-draft PR -- which
  // on a healthy queue is the COMMON case, so unlike the two above this one is usually paid. It is still
  // conditional rather than unconditional: a tick with nothing green and unheld makes no call at all.
  // #3045 (was #2176's commit chain): ONE REST CALL PER PULL REQUEST THE REVIEW QUESTION IS ASKED OF, plus one per older head a review or
  // verdict names (at most MAX_EVIDENCE_HEADS), on the CORE pool; a pull request whose checks are running adds the commit list. `commits`
  // cannot ride on `pr list`: GraphQL refuses it.
  conditionalOnUnreviewedGreenPr: "api repos/{repo}/compare/{base}...{head} (withPatchIds -- the patch id), and pulls/{n}/commits while checks run",
  // a11ign#3199: ONE REST CALL PER COMMIT COMPARED, and only for a pull request with a refusal at an older head whose patch equals the head's
  // (`refusalHeads`): each such commit, then the head when one of them had a failing check. A pull request with no such refusal pays none.
  conditionalOnEqualPatchRefusal: "api repos/{repo}/commits/{sha}/check-runs (withFailingChecks -- does the refusal still apply)",
  // #2416: ONE REST CALL PER OPEN PULL REQUEST CARRYING `awaiting-evidence`, and NONE when no open pull
  // request carries it -- the label's age is not on `pr list`, so the labelled ones are asked and only those.
  conditionalOnAwaitingEvidenceLabel: "api repos/{repo}/issues/{n}/events (readEvidenceLabelledAt -- awaiting-evidence-stale)",
  // #3384: ONE REST CALL PER CLAIMED ROW ALREADY OVER THE CALL-COUNT THRESHOLD that declares no wait now -- the events say when its last wait was lifted,
  // so the calls made during the wait are not charged to it. A row at or under the threshold, or waiting, pays none.
  conditionalOnCallCountedRow: "api repos/{repo}/issues/{n}/events (readWaitClearedAt -- row-call-count-signal)",
  // #3632: ONE REST CALL PER CLAIMED OPEN ROW UPDATED IN THE LAST `ANSWER_GIVEN_WINDOW_MS` (its timeline -- a label's removal writes `updatedAt`),
  // and NONE when no claimed row moved in that window, nor when herdr says the claimant is not live.
  conditionalOnRecentlyTouchedClaimedRow: "api repos/{repo}/issues/{n}/timeline (readRowTimeline -- answer-given)",
  conditionalOnGreenUnheldPr: "api graphql (open PRs' mergeQueueEntry -- readUnarmed)",
  // #3019: ONE GRAPHQL CALL PER UNARMED CANDIDATE (the timeline's queue events, readEjections), and for one the queue EJECTED, one REST
  // call for the failed `merge_group` run and one `run view --log-failed`. A healthy tick has no unarmed candidate and pays none of it.
  conditionalOnUnarmedPr: "api graphql timelineItems (readEjections); api actions/runs?event=merge_group; run view --log-failed (readEjectionRun)",
  // #2110, AND IT IS ONE CALL FOR THE WHOLE CLAIMED POPULATION RATHER THAN ONE PER ROW. `--label
  // in-progress` filters server-side, so the page is the claimed rows and nothing else -- 8 of them on
  // 2026-09-23 against 500 open rows -- and asking every one of them for its comments in a single
  // `issue list` is what keeps this a bounded read as the org grows. A per-row `issue view` would have
  // been N calls and would have made the tick's cost a function of how busy the org is, which is the one
  // property `work:tick` cannot trade away.
  //
  // CONDITIONAL, AND HONESTLY SO: the condition is that ANY row is claimed, which a busy org always
  // satisfies. It is counted as conditional rather than unconditional because a quiet org genuinely pays
  // nothing, and because the answer is already in hand -- `readOpenRows` has fetched the labels, so
  // asking costs no call of its own. The comment bodies are NOT added to the unconditional 500-row read:
  // that would carry every comment on every open row through a 32MB buffer on every tick.
  conditionalOnClaimedRows: "issue list --label in-progress --json number,comments"
    + " (readClaimedRowComments -- claimed-row-amended); plus, only when a row comes back at the 100-comment cap, ONE batched"
    + " api graphql for those rows' last 100 comments (#3821)",
  // #2470: ONE MORE READ, PAID BY THE SAME CONDITION (some row is claimed) and for the same reason it is one call and not
  // one per row: the newest merged pull requests, of which the claimed branches' are found by name. It bounds what a
  // release for a MERGED row can see to the newest 100 -- at this org's rate about a day -- and a merge older than that,
  // seen only after the gate was down for longer, is missed, not guessed.
  conditionalOnClaimedBranches: "pr list --state merged --limit 100 --json number,headRefName,mergedAt,title,labels"
    + " (readMergedPrs -- claim-stalled's merged release)",
  // #2286, WIDENED BY #2741: ONE CALL FOR EVERY BLOCKER, paid only when some unclaimed row OR some
  // claimed one has a cleared blocker to ask about. `gh`'s `blockedBy` nodes carry no closing time, and a
  // per-blocker read would make the tick's cost a function of how many rows are waiting.
  // #3892: ONE `pr list --head <branch> --state all` PER BRANCH on `origin` carrying an UNCLAIMED READY row's number -- none for a tick with no such branch,
  // which is the ordinary tick. `ls-remote` cannot say whether a branch's pull request was closed on purpose, and a bulk `--state closed` page would miss an old one.
  conditionalOnBranchedReadyRows: "pr list --head <branch> --state all --limit 100 --json number,state (readBranchPrs -- a closed-unmerged branch is a replacement, not unshipped work; a full page is refused)",
  conditionalOnClearedRows: "issue list --state closed --limit 100 --search sort:updated-desc --json number,closedAt,updatedAt"
    + " (readRecentlyClosed -- unclaimed-blocker-cleared's and blocker-cleared's backoff)",
  // #2356: FOUR MORE REST CALLS, paid ONLY by a tick that found `main` red -- the run's jobs, the recheck
  // job's annotations, `run view --log-failed` for the failing test names, and the merged PR's session.
  // A healthy `main` pays none of them; a red one is rare and short-lived by the ruling this cause serves.
  conditionalOnRedTrunk: "api runs/{id}/jobs, check-runs/{id}/annotations, run view --log-failed,"
    + " commits/{sha}/pulls (readTrunkRed -- trunk-red)",
  // agent-org#492: ONE GRAPHQL CALL (`issue(number:)` through the ticket port's `readItem`) PER REPEATING LINE AN OPEN ROW CITES, at most three candidates for a line,
  // and one more `issue comment` write at a count milestone. A tick with no repeating line, or with one no row cites, pays none (`settleCitedRepeatingLines`).
  conditionalOnCitedRepeatingLine: "api graphql repository.issue(number) (settleCitedRepeatingLines -- repeating-log-line, through the ticket port)",
  // agent-org#491: ONE `issue comment` WRITE (the ticket port's `postDecision`) PER CHANGE OF THE `overdue` LIST, and no read at all. A tick whose list is what it was at the last write pays none.
  conditionalOnOverdueList: "issue comment (settleOverdueLists -- org-health's overdue list, through the ticket port)",
  // agent-org#490: PER ROW THE GATE BOARDS, which is a row off Project 1 whose label names a Status (none for a tick with no such row, the ordinary tick): ONE GRAPHQL CALL (the port's
  // `changeState` reads the row), `project item-add`, a scoped board snapshot read and `project item-edit`, and one `issue comment`. The off-board read above is the same one as before.
  conditionalOnOffBoardRows: "api graphql issue(number), project item-add, project item-edit, issue comment (settleOffBoardRows -- row-off-board, through the ticket port)",
  // agent-org#488: PER UNARMED PR THE GATE ARMS, which is a green unheld PR nothing armed in a queue that has an armed one (none for the ordinary tick, and none for an
  // all-unarmed queue, which is a manager's): `arm-pr`'s own reads (`pr view`, the closing rows' blockers, the PR's timeline), `pr merge --auto`, the armed read-back and one `issue comment`.
  conditionalOnUnarmedArm: "pr view, api graphql (blockers, ejection, armed read-back), pr merge --auto, issue comment (settleUnarmedPrs -- pr-green-unarmed, through the code-host port)",
});

/**
 * THE READS THAT SPEND NO API POOL AT ALL, counted separately BECAUSE they are free rather than left out
 * because they are.
 *
 * `GH_READS` above exists because "two `gh` calls" was repeated for weeks while three readers were added,
 * and a reviewer had to measure the call sites to find it. A read that costs no pool is even easier to
 * add uncounted, and this one is load-bearing in a way that makes its cost worth writing down: #2031's
 * detection MUST NOT spend GraphQL, because the board goes stale precisely when the pool is exhausted
 * and a detector that spent it would be blind in the same outage that produces the defect. That is a
 * property of the implementation, so it is stated where the next person adding a read will read it, and
 * pinned behaviourally in `work-gate.test.ts` (the seam is handed a spy and the binary it spawns is
 * asserted to be `git`, never `gh`).
 */
export const GIT_READS = Object.freeze({
  unconditional: ["git ls-remote --heads origin (readRowBranches -- row-branch-unshipped)"],
  // #2470: LOCAL, AND SPENDS NO POOL. Per claimed row: `git rev-parse` and `git log` for the newest commit on its branch and
  // on `origin/<branch>`; `git status`, `git rev-list` only for a row that is quiet or blocked or merged. Plus one
  // `systemctl --user show herdr.service` for the restart the no-progress clock may not start before.
  // #2941: LOCAL, ONE CALL AT MOST. `git worktree list --porcelain` plus a `.a11y-owner` read per stamped tree, made only when a
  // pull request reaches the stamp rung of `ownerOfPr` -- no label, no live row, no live session in its head ref.
  conditionalOnUnownedPr: "git worktree list --porcelain; .a11y-owner per stamped tree (withNamedOwners -- ownerOfPr's stamp rung)",
  conditionalOnClaimedRows: "git rev-parse/log per claimed branch; git status/rev-list per QUIET claimed worktree;"
    + " systemctl --user show herdr.service (claim-stalled)",
});

/**
 * Every `git` spawn in this file, stripped of the `GIT_*` redirects git exports into a hook environment.
 * `git-env.ts`'s header records the incident: fifteen commits landed in the wrong checkout because an
 * inherited `GIT_DIR` beat `cwd`. This tick runs under systemd, where the environment is not one a
 * person typed and is therefore not one anybody has looked at.
 */
export const defaultSpawn = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * `git`'s leading arguments for every read about the PROJECT: `-C <the project checkout>`. #3091: the tick's
 * `WorkingDirectory` is this TOOL's checkout since the cut-over, so a bare `git ls-remote --heads origin` asked
 * the TOOL's repository about the PROJECT's rows -- a tool branch ending `-3064` shelved row #3064 for 88
 * ticks. `HOME_CHECKOUT` is what every other project-file read in the tool already asks.
 */
export const PROJECT_GIT = Object.freeze(["-C", HOME_CHECKOUT]);

/**
 * WHAT ORIGIN ACTUALLY HOLDS -- every branch whose name ends `-<digits>`, with that row number.
 *
 * #2031: THE GATE HAD NO WAY TO SEE PUSHED WORK, and `ready` with no `session:` label was the entire
 * question it asked before offering a row as a fresh start. Measured 2026-09-22 on #2000: the branch
 * `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z and the row read `ready` and unclaimed until
 * 21:22Z, with `gh pr list --head <branch> --state all` returning `[]` for that whole window. The gate
 * offered it throughout and routed a second session into the same three Region paths at 21:06Z; what
 * stopped that session was a worktree-PATH collision, which is not a guard aimed at this.
 *
 * `ls-remote` RATHER THAN A `gh` CALL, AND THAT IS THE DESIGN RATHER THAN A SAVING. Opening the pull
 * request is the act that makes a row look claimed, and that act spends GraphQL -- #1996's PR was never
 * opened because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale
 * exactly when the pool is gone, and a detector that spent the pool would be blind in the one outage it
 * exists for. This is a LOCAL git call: it fits inside the tick's budget without widening `GH_READS`.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the cause is not evaluated this
 * tick and NOTHING is shelved. "Could not ask origin" is not "no row has a branch", and it is not
 * "every row has one" either: a tick that cannot reach the remote must go on offering rows exactly as it
 * did before this existed. `row-claim.ts` THROWS on the same failure and that difference is deliberate
 * -- a claim is about to write and must refuse on a guess; a tick is about to say nothing new.
 *
 *
 * @returns `null` when refused, never `[]`
 */
export function readRowBranches(run: (cmd: string, args: string[]) => string = defaultSpawn): { branch: string; head: string; row: number; }[] | null {
  try {
    return rowBranchesInListing(run("git", [...PROJECT_GIT, ...LS_REMOTE_ARGS]));
  } catch {
    return null;
  }
}

/** How many pull requests one branch's list is asked for. A page that comes back this full may have been CUT, and `gh` cuts the OLDEST -- the ones a merge hides behind. */
const BRANCH_PRS_LIMIT = 100;

/**
 * #3892: EVERY PULL REQUEST EVER OPENED FROM THESE BRANCHES, one `gh pr list --head` each, so {@link branchesToReplace} can tell a branch whose pull request was
 * CLOSED ON PURPOSE from one no pull request carries. `ls-remote` cannot (#2031), and `--state all` is what makes a closed one visible at all: the tick's own
 * `pr list` is `--state open`.
 *
 * `null` FOR ONE REFUSED READ, NEVER `[]` (#1286): a branch whose list could not be read is not a branch with no pull request, and the whole answer is `null`
 * so no row is released on a guess -- each stays shelved exactly as before, which is what the absent answer already means.
 *
 * A FULL PAGE IS A REFUSED READ TOO. `gh` cuts the list at its limit, newest first, so a branch with more pull requests than that can lose an OLD MERGED one
 * and read as closed-only: the page is then not the branch's history, and "every pull request is closed" was never established. A page with room left is the
 * whole list (the rule {@link OPEN_PRS_FIRST_PAGE} reads the open list by).
 */
export function readBranchPrs(branches: readonly { branch: string; }[], run: (args: string[]) => string = defaultRun): { branch: string; number: number; state: string; }[] | null {
  const found = [];
  for (const { branch } of branches) {
    try {
      const parsed = JSON.parse(run(["pr", "list", "--head", branch, "--state", "all", "--limit", String(BRANCH_PRS_LIMIT), "--json", "number,state"]));
      if (!Array.isArray(parsed) || parsed.length >= BRANCH_PRS_LIMIT) return null;
      found.push(...parsed.map((pr: { number: number; state: string; }) => ({ branch, number: pr.number, state: String(pr.state) })));
    } catch {
      return null;
    }
  }
  return found;
}

/**
 * PURE. The ROWS whose every branch on `origin` has at least one pull request and ONLY closed-unmerged ones -- the branches a replacement may be built from
 * (#3892), keyed by row number.
 *
 * A ROW IS REPLACEABLE ONLY WHEN NO BRANCH ON IT IS ANYTHING ELSE. A branch with no pull request is #2031's (nobody knows whether it is finished), one with
 * an OPEN pull request is #3010's (`--adopt` it), and one with a MERGED pull request is landed work; each keeps the row shelved, and one such branch
 * keeps it shelved whatever the others are. ABSENT `branchPrs` is "not asked or refused" and releases nothing.
 */
export function branchesToReplace(rowBranches: { branch: string; head: string; row: number; }[] | null | undefined, branchPrs: { branch: string; number: number; state: string; }[] | null | undefined): Map<number, { branch: string; head: string; prs: number[]; }[]> {
  const replaceable: Map<number, { branch: string; head: string; prs: number[]; }[]> = new Map();
  if (!Array.isArray(branchPrs)) return replaceable;
  const closedOnly = ({ branch }: { branch: string; }) => {
    const mine = branchPrs.filter((pr) => pr.branch === branch);
    return mine.length > 0 && mine.every((pr) => pr.state === "CLOSED") ? mine.map((pr) => pr.number) : null;
  };
  const byRow: Map<number, { branch: string; head: string; row: number; }[]> = new Map();
  for (const found of rowBranches ?? []) byRow.set(found.row, [...(byRow.get(found.row) ?? []), found]);
  for (const [row, branches] of byRow) {
    const closed = branches.map((found) => ({ found, prs: closedOnly(found) }));
    if (closed.every(({ prs }) => prs !== null)) {
      replaceable.set(row, closed.map(({ found, prs }) => ({ branch: found.branch, head: found.head, prs: (prs as number[]) })));
    }
  }
  return replaceable;
}

/**
 * #3892: `readBranchPrs` for the branches the question is ABOUT -- those carrying an UNCLAIMED ready row's number -- and for no others, so a tick with none pays no call.
 * A claimed row's branch is its holder's and nothing here releases it.
 *  @param rowBranches `null` (not asked) asks nothing
 */
export function readBranchPrsOfUnclaimed(readyRows: any[], rowBranches: { branch: string; row: number; }[] | null, run: (args: string[]) => string = defaultRun) {
  const unclaimed = new Set(readyRows.filter((row) => !labelsOf(row).includes(CLAIM_LABEL) && !sessionOf(row)).map((row) => Number(row.number)));
  const asked = (rowBranches ?? []).filter(({ row }) => unclaimed.has(row));
  return asked.length === 0 ? null : readBranchPrs(asked, run);
}

/**
 * The open `backlog` rows carrying NO label that already means unpickable.
 *
 * RETURNS THE ROWS, NOT A COUNT, because the lane matters and re-reading to learn it would be a second
 * `gh` call for a fact the first one already fetched. Callers that only want a number take `.length`.
 *
 * A COUNT IS NOT A TARGET. `product-manager`'s brief says Ready holds at least three product rows, and
 * nothing here enforces that number: `ready:audit` was filed 2026-09-06 after `dispatcher` labelled two
 * rows `ready` TO HIT THE FLOOR -- one disputed, one with no Region or Acceptance -- and its finding is
 * the rule here, *"a floor met by a label I control is not a measurement"*.
 *
 *
 * @returns `null` when the read was refused -- never [], which would read as "nothing there"
 */
export function readPromotableRows(run: (args: string[]) => string = defaultRun): any[] | null {
  try {
    // `blockedBy` AND `body` RIDE THE CALL THAT WAS ALREADY BEING MADE. `blockedBy` is GitHub's own
    // dependency edge -- `gh issue create --blocked-by` writes it, the UI renders it, and this `--json`
    // returns it -- so reading a waiting condition costs nothing this tick did not already spend.
    const parsed = labelledRows({ label: BACKLOG_LABEL, state: "OPEN", newest: 200, run,
      select: `number title createdAt ${ROW_LABELS} body ${ROW_BLOCKED_BY}` });
    // `NOT_STARTABLE`, NOT `NOT_PICKABLE`: a routed row is kept here and removed again by `ownerOf` for
    // the pool, so the one session it belongs to can still be told about it.
    const today = todayIso();
    // `answer:<session>` IS NOT IN `NOT_STARTABLE` AND NEVER CAN BE -- it is a PREFIX over one name per
    // session, not a literal in the frozen list. A row carrying it is routed to whoever owes the answer
    // and is already independently waking that session (`answerOrders`); it is neither unlaned nor
    // unpickable, so counting it as promotable stock is what made `ready-queue-empty` re-ask a judgment
    // already settled (#1899: #1889 and #1878, both correctly parked, both still counted).
    //
    // #1899 FIXED THAT HERE, WITH A SECOND READER OF THE PREFIX, AND ONLY HERE -- which is why #2005
    // happened one door down: this function was the only one that knew, so the identical question asked
    // by `partitionUnclaimed` ("may this be OFFERED?") still answered `yes`. The local `answered` set is
    // gone and `waitingOn` below now carries it, so the two questions cannot answer differently again.
    //
    // `needs:chairman` IS A WAIT THAT `waitingOn` DOES NOT READ, AND THIS IS THE SECOND READER OF THAT GAP
    // (#2604, after #2583/#2585 closed `unclaimedClearings`). The label names a person and clears when
    // removed, so a row carrying it is not stock anybody can promote: `ready-queue-empty` counted #2561 (whose
    // first step, a private repository, did not exist) and woke `product-manager` to re-derive a verdict
    // already on the row. Dropped HERE, in this reader's own population, and not taught to `waitingOn`, which
    // every reader of that function would then inherit -- the same choice #2585 made.
    return parsed.filter((r) => !labelsOf(r).some((n: string) => NOT_STARTABLE.includes(n)))
      .filter((r) => !labelsOf(r).includes(CHAIRMAN_LABEL))
      // `parked` IS THE THIRD READER OF THE SAME GAP (#2653): a row parked until its prerequisite phase is done is
      // not stock either, and `laneBacklogOrders` and `decide`'s pool count consume THIS list, so they inherit it.
      .filter((r) => !labelsOf(r).includes(PARKED_LABEL))
      .filter((r) => waitingOn(r, today) === null);
  } catch {
    return null;
  }
}

/**
 * Open rows carrying `ready`. FILTERED SERVER-SIDE by the label the API already indexes, so this stays
 * one call and this file never spells the literal -- `claim-labels.ts` owns it (#804).
 */
export function readReadyRows(run: (args: string[]) => string = defaultRun): any[] | null {
  try {
    return labelledRows({ label: READY_LABEL, state: "OPEN", newest: 100, run,
      select: `number title ${ROW_LABELS} body ${ROW_BLOCKED_BY} milestone{number title}` });
  } catch {
    return null;
  }
}

/**
 * #3486: THE CLAIMED ROWS' COMMENTS AS THE OUTCOME CLOCK READS THEM. `claimedRowCommentsWhenHeld` answers `null` for TWO things -- no row is claimed (nothing
 * was asked) and the read was refused -- and the clock must tell them apart: the first is "no claimed row to age", the second is "unread", reported as such
 * and never as nothing overdue. A claimed row and a `null` is the refusal; no claimed row is `[]`.
 */
export function claimedCommentsForClock(openRows: any[], claimedComments: any[] | null): any[] | null {
  return claimedComments ?? (openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL)) ? null : []);
}

/**
 * Every open row that carries an `answer:` label, and nothing else.
 *
 * SERVER-SIDE IS NOT AVAILABLE HERE. `gh issue list --label` matches one exact label, and this is a
 * PREFIX over eight possible names, so the filter is local. The read is still one call and asks only for
 * `number,labels` -- no bodies, which is what keeps a 500-row page cheap.
 *
 * EVERY OPEN ROW, not just the promotable ones. A question can sit on a `blocked` or `epic` row -- #914,
 * the row that cost 6.5 hours, is `fleet-gated` and would have been outside a promotable-only read. A
 * cause that could not see the row it was written for would be the same defect one level up.
 *
 *
 * @returns `null` when refused, never `[]`
 */
export function readOpenRows(run: (args: string[]) => string = defaultRun, conditional: ConditionalReads | null = isGhRun(run) ? conditionalFor(undefined) : null, { home = isAmbientRun(run), webhook = home && webhookMode(), dueIndexPath }: { home?: boolean; webhook?: boolean; dueIndexPath?: string; } = {}): any[] | null {
  const rows = conditional === null ? readOpenRowsAsListed(run) : conditionalOpenRows({ run, conditional });
  // a11ign/a11ign#5043: the rows are in hand, so the dated waits they carry are recorded where the tick reads them. NOT from an empty list (the first-wave
  // rehearsal answers `[]`, and recording it would forget every wait), and NOT from one at the cap, which may be cut.
  if (webhook && rows !== null && rows.length > 0 && rows.length < OPEN_ROWS_LIMIT) {
    recordDueInstantsOrSay({ path: dueIndexPath ?? stateEntryPath(DUE_INDEX_ENTRY), repo: repoNow(), rows });
  }
  return rows;
}

/** The due-index file under the state directory: `work-tick.ts`'s `DUE_INDEX_ENTRY`, named again here because this file does not import the tick (a test holds the two equal). */
export const DUE_INDEX_ENTRY = "due-index.json";

/** Whether this host declares `webhook` events. A host whose declaration cannot be read polls, as the tick does, so it records nothing. */
export function webhookMode(): boolean {
  try {
    return homeHostConfig().events?.source === "webhook";
  } catch (error) {
    void error; // no readable declaration is `poll`
    return false;
  }
}

/**
 * (agent-org#1240) THE OTHER REPOSITORIES A TICK READS. Flag off, a poll tick, or a run that is not the gate's own: all of them. Flag on and a webhook
 * tick: those the event queue named and those due a sweep (`scopesToRead`). Asked from `readOtherScopes`, so the first-wave rehearsal asks it too; it
 * reads the memory and writes nothing, which is why the memory is stamped from the REAL reads by `rememberOtherScopesRead` in `main`.
 */
export function otherScopesToRead(run: object, scopes: readonly Scope[], facts?: GateFacts): Scope[] {
  const gate = eventGateOf(run, facts);
  return gate === null ? [...scopes] : scopesToRead({ scopes, ...gate });
}

/**
 * (agent-org#1417) THE OTHER REPOSITORIES AN AMBIENT TICK READS, given the pool it left: NONE below the floor (`belowFloor`), the event gate's list
 * otherwise. Between the floor and the reserve they ARE read, so a settled-green pull request in another repository still gets its reviewer order.
 * `readOtherScopes` reads exactly this list, so the rule and the read are one.
 */
export function otherScopesForTick(run: object, scopes: readonly Scope[], pacing: Pick<Pacing, "belowFloor">, facts?: GateFacts): Scope[] {
  return isAmbientRun(run) && pacing.belowFloor ? [] : otherScopesToRead(run, scopes, facts);
}

/** The facts an event gate is decided from: the flag, the host's declaration, the event queue's named scopes (`null`: none, so read all), the memory and the clock. */
export type GateFacts = { on: boolean; webhook: boolean; tickScopesPath: string | undefined; memoryPath: string; nowMs: number; };

/** What an event gate says a tick may read: the repositories it named and the memory of each one's last whole read. */
export type EventGate = { named: readonly TickScope[]; lastReadAt: Readonly<Record<string, number>>; nowMs: number; };

/**
 * (agent-org#1240) THE EVENT GATE THIS TICK APPLIES, or `null` for none: the run is not the gate's own, the host polls, or the event
 * queue's file cannot be read (which reads everything, as a poll tick does). The host's `webhook` declaration is the switch (agent-org#1353: behind `gate.graphqlPacing`, absent from the canary, the
 * gate took a whole read every tick and calls per hour did not fall at the webhook switch); the revert is `"source": "poll"`. `facts` is the test's; omitted, they are read from this host.
 */
export function eventGateOf(run: object, facts?: GateFacts, declaresWebhook: () => boolean = webhookMode): EventGate | null {
  if (!isAmbientRun(run)) return null;
  const live = facts ?? (declaresWebhook() ? liveGateFacts() : null);
  if (live === null || !live.on || !live.webhook) return null;
  const named = live.tickScopesPath === undefined ? null : readTickScopes(live.tickScopesPath);
  return named === null ? null : { named, lastReadAt: readOtherScopesMemory(live.memoryPath), nowMs: live.nowMs };
}

function liveGateFacts(): GateFacts {
  return { on: true, webhook: true, tickScopesPath: process.env[TICK_SCOPES_VARIABLE], memoryPath: stateEntryPath(OTHER_SCOPES_MEMORY), nowMs: Date.now() };
}

/**
 * (agent-org#1240) THE OTHER REPOSITORIES THE EVENT GATE DROPPED, each REPORTED unread with its reason, as a paced skip is (`unreadLanes`). Empty where
 * no gate applies: a dropped repository is never silently clean.
 */
export function unreadScopes(run: object, scopes: readonly Scope[], facts?: GateFacts): string[] {
  const gate = eventGateOf(run, facts);
  if (gate === null) return [];
  const read = new Set(scopesToRead({ scopes, ...gate }).map((scope) => scope.key));
  return scopes.filter((scope) => !read.has(scope.key)).map((scope) => `the lanes of ${scope.code?.repo ?? scope.tracker?.repo ?? scope.key} (no event named it, and it was read less than ${GRAPHQL_SWEEP_MINUTES} minutes ago)`);
}

/**
 * (agent-org#1417) THE OTHER REPOSITORIES AN EVENT GATE DROPPED, REPORTED unread on an ambient tick. Below the floor they are not read at all, and the
 * paced skip names them (`pacedUnread`), so they are not reported twice: nothing here. Between the floor and the reserve, the gate's own report.
 */
export function eventUnreadForTick(pacing: Pick<Pacing, "belowFloor">, run: object, scopes: readonly Scope[], facts?: GateFacts): string[] {
  return pacing.belowFloor ? [] : unreadScopes(run, scopes, facts);
}

/**
 * (agent-org#1240) WHETHER THE PRIMARY'S OWN TRACKER LANES ARE READ THIS TICK: on an event-gated tick, only when an event named the home repository or
 * its last whole read is a sweep old. No gate, or no home repository to name: read, as it always has.
 */
export function primaryDue(run: object, home: Scope | undefined, facts?: GateFacts): boolean {
  const gate = eventGateOf(run, facts);
  return gate === null || home === undefined || scopesToRead({ scopes: [home], ...gate }).length > 0;
}

/** `read()` when `primaryDue`, else every lane `null`: the same answer a refused read gives, so every reader already says it could not read them. */
export function primaryLanes<T extends object>(run: object, home: Scope | undefined, read: () => T, skipped: { [K in keyof T]: null }, facts?: GateFacts): T | { [K in keyof T]: null } {
  return primaryDue(run, home, facts) ? read() : skipped;
}

/**
 * (agent-org#1240) Stamps the repositories whose lanes were ALL answered as read now. A refused lane is not a sweep: that repository is due again next tick,
 * and its refusal is already reported PARTIAL. A failed write is said, and the next webhook tick then finds every repository due, which reads whole.
 * `homeKey` is the primary's key when ITS tracker lanes were answered this tick (`primaryLanes`), so its sweep is remembered as the others' are.
 */
export function rememberOtherScopesRead(reads: { scope: Scope; read: { prs: unknown; readyRows: unknown; promotableRows: unknown; chairmanBlocked: unknown; openRows: unknown; }; }[], homeKey: string | null = null): void {
  if (!(webhookMode())) return;
  const answered = reads.filter(({ read }) => [read.prs, read.readyRows, read.promotableRows, read.chairmanBlocked, read.openRows].every((lane) => lane !== null)).map(({ scope }) => scope.key);
  const keys = homeKey === null ? answered : [homeKey, ...answered];
  if (keys.length === 0) return;
  try {
    rememberOtherScopes({ path: stateEntryPath(OTHER_SCOPES_MEMORY), keys, nowMs: Date.now() });
  } catch (error) {
    process.stderr.write(`work-gate: the other repositories' read times could not be remembered (${String((error as Error).message).split("\n")[0]}); the next webhook tick reads them all\n`);
  }
}

/** A failed write is said and the rows are still returned: the tick then reads an index that is older than the rows, which only makes it read more, never less than it did. */
function recordDueInstantsOrSay(args: { path: string; repo: string; rows: any[]; }): void {
  try {
    recordDueInstants(args);
  } catch (error) {
    process.stderr.write(`work-gate: the due instants could not be recorded (${String((error as Error).message).split("\n")[0]})\n`);
  }
}

/** `readOpenRows` as the gate has always asked it: ONE `issue list`, whose literal `500` `packaging/work-gate.test.ts` pins. */
function readOpenRowsAsListed(run: (args: string[]) => string): any[] | null {
  try {
    // ONE READ, SEVERAL CAUSES. `answer-owed` needs the labels and `blocked-without-a-referent` needs
    // `body` and `blockedBy` as well; asking once and filtering twice keeps the unconditional call
    // count where `GH_READS` says it is. #4048: `createdAt` RIDES IT TOO, so `stateLabelFindings` can tell a row being filed from one in no state. #4042: `subIssuesSummary` RIDES THIS READ so the epic causes
    // (`epicRowsOf`) are answered from rows already in hand on every tick, not by a second call.
    const answer = run(["issue", "list", "--state", "open", "--limit", "500",
      "--json", "number,title,labels,body,blockedBy,milestone,updatedAt,subIssuesSummary,createdAt"]);
    const parsed = JSON.parse(answer);
    if (Array.isArray(parsed)) return parsed;
    // agent-org#1624: an answer that parses but is not a list is a refusal too, and it was the one `null` here that said nothing (three silent ticks, 2026-10-15/16).
    throw new Error(`the answer was not a list: ${JSON.stringify(String(answer).slice(0, 120))}`);
  } catch (cause) {
    // agent-org#1401: the refusal is said WITH gh's reason, so the journal names it; a silent `null` left the 19:35:53Z and 19:55:01Z ticks without one.
    process.stderr.write(`NOTE: the open rows could not be read (${said(cause)}); read as refused\n`);
    return null;
  }
}

/**
 * The comments on every CLAIMED row, in one call.
 *
 * `--label in-progress` IS THE WHOLE POINT. The claimed population is the only one this cause has a
 * question about, and filtering server-side is what makes this a bounded read rather than 500 rows of
 * comment bodies through a 32MB buffer. See `GH_READS.conditionalOnClaimedRows` for the arithmetic.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the comment half of
 * `claimed-row-amended` is not evaluated this tick. The body and edge halves still are, because they ride
 * the read that has already happened.
 *
 * #3821: `gh issue list --json comments` RETURNS AT MOST THE FIRST 100 COMMENTS OF A ROW, OLDEST FIRST, AND SAYS NOTHING ABOUT THE REST. On a row
 * with more, the newest claim record is not in the page, `claimRecordOf` takes an OLD one for the newest, and a pull request merged since then reads as
 * "merged after the claim": #3566 was released twice within two minutes of being claimed. A row that comes back AT the cap is therefore re-read from
 * its END (`readNewestComments`), in ONE batched call for all such rows and none on a tick where no row is at the cap. A row whose end could not be
 * read is LEFT OUT of the page: the claim-stall pass finds no claim record for it and SKIPS it, which costs a tick, where a release destroys a worktree's claim.
 *
 * agent-org#747: `repo` is the tracker the claimed rows are of, which the capped re-read must ask too: `run` is already aimed at it, but the batched read names its
 * repository in the query itself, and the ambient one would read the home tracker's rows of the same numbers.
 *
 * @returns `null` when refused, never `[]`
 */
export function readClaimedRowComments(run: (args: string[]) => string = defaultRun, repo: string = repoNow()): any[] | null {
  try {
    const parsed = labelledRows({ label: CLAIM_LABEL, state: "OPEN", newest: 200, run,
      select: `number comments(first:${ISSUE_LIST_COMMENT_CAP}){nodes{id body createdAt author{login}}}` });
    return withNewestCommentsOfCappedRows(parsed, run, repo);
  } catch {
    return null;
  }
}

/** What `gh issue list --json comments` returns of a row: its first this-many comments, whatever the row holds (#3821). */
export const ISSUE_LIST_COMMENT_CAP = 100;

/**
 * `rows` with each capped row's comments replaced by its LAST `ISSUE_LIST_COMMENT_CAP`, oldest first -- the shape `issue list` gives, so no reader changes --
 * and a capped row whose end could not be read dropped.
 */
function withNewestCommentsOfCappedRows(rows: any[], run: (args: string[]) => string, repo: string): any[] {
  const capped = rows.filter((row) => (row?.comments?.length ?? 0) >= ISSUE_LIST_COMMENT_CAP);
  if (capped.length === 0) return rows;
  const newest = readNewestComments(capped.map((row) => Number(row.number)), run, repo);
  return rows.flatMap((row) => {
    if (!capped.includes(row)) return [row];
    const comments = newest?.get(Number(row.number));
    if (comments !== undefined) return [{ ...row, comments }];
    process.stderr.write(`claim-stall: #${row.number} has ${ISSUE_LIST_COMMENT_CAP} or more comments and its newest could not be read -- the row is NOT evaluated this tick.\n`);
    return [];
  });
}

/**
 * The last `ISSUE_LIST_COMMENT_CAP` comments of each named row, in ONE GraphQL call (an aliased `issue(number:)` per row, so the cost is not a function of
 * how many rows are capped), or `null` when the call was refused or its answer is not whole: `errors` beside `data` is refused too (#555), and a row the
 * answer does not carry is left out of the map, never filled with `[]`.
 */
function readNewestComments(numbers: number[], run: (args: string[]) => string, repo: string): Map<number, any[]> | null {
  const [owner, name] = repo.split("/");
  const fields = numbers.map((n) => `r${n}: issue(number: ${Number(n)}) { number comments(last: ${ISSUE_LIST_COMMENT_CAP}) { nodes { id body createdAt author { login } } } }`);
  try {
    const parsed = JSON.parse(run(["api", "graphql", "-f", `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
      "-F", `owner=${owner}`, "-F", `name=${name}`]));
    const repository = parsed?.errors ? null : parsed?.data?.repository;
    if (repository === null || typeof repository !== "object") return null;
    const read = Object.values(repository).filter((issue) => Array.isArray((issue as any)?.comments?.nodes));
    return new Map(read.map((issue: any) => [Number(issue.number), issue.comments.nodes]));
  } catch {
    return null;
  }
}

// --- #2470: A CLAIM THAT DOES NOT MOVE ---------------------------------------------------------------------------------

/**
 * The newest merged pull requests, in ONE call, for the claimed branches whose work landed while the row stayed open.
 * `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "nothing merged", and the merged release is simply not
 * evaluated this tick.
 */
export function readMergedPrs(run: (args: string[]) => string = defaultRun): { number: number; headRefName: string; mergedAt: string; title: string; labels: { name: string; }[]; }[] | null {
  try {
    const parsed = JSON.parse(run(["pr", "list", "--state", "merged", "--limit", "100", "--json",
      "number,headRefName,mergedAt,title,labels"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Each open pull request with `checksPending`: a check of its NEWEST run per name is still running. The idle-claimant reading counts that as a wait
 * (#2999), and it is decided HERE, through `newestPerName` and `stillRunning`, so there is one reader of the rollup and one meaning of "running".
 */
export function withChecksPending(prs: any[]) {
  return prs.map((pr) => ({ ...pr, checksPending: newestPerName(pr?.statusCheckRollup ?? []).some(stillRunning) }));
}

/**
 * (#3075) THE OTHER TRACKED CODE REPOSITORIES' OPEN AND MERGED PULL REQUESTS, for `claimFactsFrom`: a claim's work can be in a repository other than the
 * one holding the row (`a11ign/agent-org`'s #38 for #3039), and a list of this repository's alone reads that holder as one with nothing built. Each lane
 * is read by the readers the scope enumeration already uses (`readPrs`, `readMergedPrs`), aimed at the repository, and its members are tagged with the key.
 * `undefined` for a project with one code repository, so its reads are exactly what they were. An OPEN list is `null` when ANY repository's was refused (the
 * claim is then skipped); a merged one only when EVERY repository's was.
 *
 * (#3566) `known` IS WHAT `readOtherScopes` ALREADY ASKED THIS TICK. Its `prs` lane is the same `readPrs`, aimed at the same repository and tagged the
 * same way, so asking again was one repeated `gh pr list` per other repository per tick (5 of 53 calls, about 4.6 s, measured by the census's `GH_REPO`
 * field). A scope present in `known` has its open list taken from there, `null` (refused) included: a refusal is not retried, since a retry is a new read.
 *
 * (#3566, slice 2) Its merged lists, one per repository, go out together (`readWithFirstWaveTogether`).
 */
export function readElsewherePrs(scopes: readonly Scope[] = scopesOf([homeProjectDeclaration()]), run: (args: string[], repo?: string) => string = defaultRun, known: readonly { scope: Scope; read: { prs: any[] | null; }; }[] = [], batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined): { open: any[] | null; merged: any[] | null; } | undefined {
  const lanes: { open: any[] | null; merged: any[] | null; }[] = readWithFirstWaveTogether((through) => scopes.filter((scope) => scope.key !== "" && scope.code !== null).map((scope) => {
    const repo = (scope.code as ScopeRepository).repo;
    const aimed = (args: string[]) => through(args, repo);
    const already = known.find((entry) => entry.scope.key === scope.key);
    return { open: already === undefined ? tagged(readPrs(aimed), scope.key, repo) : already.read.prs, merged: tagged(readMergedPrs(aimed), scope.key, repo) };
  }), run, batch);
  if (lanes.length === 0) return undefined;
  return { open: lanes.some((lane) => lane.open === null) ? null : lanes.flatMap((lane) => lane.open ?? []),
    merged: lanes.every((lane) => lane.merged === null) ? null : lanes.flatMap((lane) => lane.merged ?? []) };
}

export const systemctlRun = (args: string[]) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/** The project checkout this tool serves (`HOME_CHECKOUT`, not `src` up three): where `../wt-<row>` claim records are resolved against. */
export const REPO_CHECKOUT = HOME_CHECKOUT;

/**
 * Which of these candidates has NOTHING armed -- read from the API, and `null` when it could not be read.
 *
 * THE COST, AND WHY IT IS A GRAPHQL CALL AND NOT A FIELD. `armedFromApi`'s third state is
 * `mergeQueueEntry`, and the merge queue is a GraphQL-only object: measured 2026-09-23 against
 * `gh version 2.100.0`, `gh pr list --json` offers `autoMergeRequest` and NOT `mergeQueueEntry`, so the
 * gate's existing `pr list` structurally cannot answer this however many fields are added to it. One
 * conditional call is the cheapest form the question has.
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `readPrs`'s rule (#1286) and for its reason. An empty list here
 * says "every green unheld PR is armed", which during the very outage this was built for is the one
 * answer that must never be invented.
 *
 * A CANDIDATE THE QUERY DID NOT RETURN IS DROPPED, NOT REPORTED. `=== false` and not `!== true`: an
 * absent number means the read did not cover it (a PR against another base, or past the 100-PR window),
 * and calling that "unarmed" would wake somebody to arm a pull request nothing has looked at.
 */
export function readUnarmed(candidates: number[], run: (args: string[]) => string = defaultRun): number[] | null {
  return readArming(candidates, run)?.unarmed ?? null;
}

/**
 * agent-org#488: `readUnarmed`'s read, WITH THE COUNT IT ALREADY HOLDS. The same one call, the same `null` for a refused read; `armed` is the
 * candidates the API says ARE armed now (a candidate the query did not return is in neither list, as it is in neither for `readUnarmed`).
 * "One unarmed among armed ones" and "every candidate unarmed" are the two arms of a fork, and the count is what tells them apart.
 */
export function readArming(candidates: number[], run: (args: string[]) => string = defaultRun): { unarmed: number[]; armed: number[]; } | null {
  if (candidates.length === 0) return { unarmed: [], armed: [] };
  try {
    const nodes = JSON.parse(run(openPullRequestsQueryArgs(repoNow())));
    if (!Array.isArray(nodes)) return null;
    const armed = new Map(nodes.map((n) => [Number(n?.number), armedFromApi(n)]));
    return { unarmed: candidates.filter((n) => armed.get(n) === false), armed: candidates.filter((n) => armed.get(n) === true) };
  } catch {
    return null;
  }
}

export const herdrRun = (args: string[]) => herdrProbe(args, 10_000);
