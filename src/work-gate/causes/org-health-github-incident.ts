import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { newestPerName } from "../../newest-check-run.ts";
import { sharedFailureTick, type RedPr } from "../../ci-failure-class.ts";
import { subjectRef } from "../../review-attribution.ts";
import { machineryCanaryTick, machineryFlagOn, readCanaryOptions, realCanaryIo, readClaimRefusals, type ReleaseRuns, type Suppression, type CanaryIo } from "../../org-health.ts";
import { type UnarmedFacts, hungCheckOf } from "../pr-orders.ts";
import { blockingChecks, checksSettledGreen } from "../pr-state.ts";
import { defaultRun, repoNow } from "../reads.ts";
import { REVIEWER_STATE_DIR } from "../vocabulary.ts";
import { accountAuthoringTimes, type AuthorLedger } from "../../gh-author-fallback.ts";
import { GITHUB_ROLES, type GithubRole } from "../../app-token.ts";
import { homeHostConfig, roleIdentity, type HostConfig } from "../../host-config.ts";
import { REVIEWER_GH_CONFIG_DIR, VERDICT_DELIVERY_FLAG } from "../../review-trust.ts";
import { GITHUB_STATUS_URL } from "../github-status-url.ts";
import { pullReadOf, verdictUndeliveredNow } from "../../verdict-delivery.ts";
import { readReenqueueState } from "./pr-ejected.ts";

// ---- #3723: GITHUB'S OWN STATUS, READ ONCE A TICK, AND WHAT A RUNNER OUTAGE HOLDS ---------------------------------------------------------------

/** Where the gate asks (`../github-status-url.ts`, a leaf the test suite's offline `fetch` shares), and the bound it asks within: 3 s at most, started WITH the tick's first reads, failing open (`ceo`'s exception to #3566's freeze). */
export { GITHUB_STATUS_URL };

export const GITHUB_STATUS_TIMEOUT_MS = 3000;

const GITHUB_STATUS_FILE = "github-status.json";

/** The worker's own boot is not the fetch's wall, and the reader gives it this much beyond the bound before it calls the answer absent. */
const GITHUB_STATUS_GRACE_MS = 500;

const GITHUB_STATUS_POLL_MS = 25;

/** The row's three: a job that cannot START (Actions), cannot be READ (API Requests) or cannot be PUSHED to (Git Operations). Copilot, Pages and the rest are not runner starts. */
const INCIDENT_COMPONENTS = Object.freeze(["Actions", "API Requests", "Git Operations"]);

/** Every status the page has reported for a component. One outside this set is a page the gate does not understand, which is UNKNOWN and never an incident. */
const COMPONENT_STATUSES = Object.freeze(["operational", "degraded_performance", "partial_outage", "major_outage", "under_maintenance"]);

/**
 * The one HTTP call of the tick, run by a CHILD `node` so the gate -- which is synchronous -- does not wait for it: it is started before the first read and
 * collected after the last, by which time it is long finished. It leaves ONE file, written whole and renamed into place, carrying the token of the tick that
 * asked, so a reading an earlier tick left can never stand in for this tick's. It never throws past its own end: any failure is an `error` in the file.
 */
const GITHUB_STATUS_WORKER = `
const { writeFileSync, renameSync } = require("node:fs");
const [url, timeoutMs, file, token] = process.argv.slice(1);
const began = performance.now();
const answer = (reading) => {
  writeFileSync(file + ".part", JSON.stringify({ token, wallMs: Math.round(performance.now() - began), ...reading }));
  renameSync(file + ".part", file);
};
fetch(url, { signal: AbortSignal.timeout(Number(timeoutMs)) })
  .then((res) => res.text().then((body) => answer({ status: res.status, body })))
  .catch((err) => answer({ error: String((err && err.name) || err) }));
`;

export type GithubIncident = { state: "incident", name: string, id: string | null, components: { name: string, status: string }[], wallMs?: number } | { state: "clear", wallMs?: number } | { state: "unknown", why: string, wallMs?: number };

/**
 * PURE. What the status page's answer says about the three components, as `incident`, `clear` or `unknown`. UNKNOWN IS NEVER A HOLD: a fetch that failed, a
 * non-200, a body that is not JSON, one that names none of the three components, or a component status the gate has not seen all leave the gate exactly as it
 * was. A KNOWN non-operational component outranks an unknown one beside it, because it is the one that says something.
 * @param envelope what the worker wrote
 */
export function githubIncidentOf(envelope: { status?: number; body?: string; error?: string; wallMs?: number; } | null | undefined): GithubIncident {
  const wallMs = typeof envelope?.wallMs === "number" ? envelope.wallMs : undefined;
  const unknown = (why: string): GithubIncident => ({ state: "unknown", why, wallMs });
  if (!envelope || typeof envelope !== "object") return unknown("no answer");
  if (envelope.error) return unknown(`the fetch failed (${envelope.error})`);
  if (envelope.status !== 200) return unknown(`HTTP ${envelope.status}`);
  let summary: any;
  try {
    summary = JSON.parse(String(envelope.body));
  } catch {
    return unknown("the body was not JSON"); // the reading, not a swallowed fault: a status page serving HTML is unreadable, and unreadable fails open
  }
  const components = Array.isArray(summary?.components) ? summary.components : [];
  const seen = INCIDENT_COMPONENTS.map((name) => components.find((c: any) => c?.name === name)).filter(Boolean);
  if (seen.length === 0) return unknown("none of the three components was named");
  const down = seen.filter((c) => COMPONENT_STATUSES.includes(c.status) && c.status !== "operational");
  if (down.length > 0) return { state: "incident", ...incidentNamed(summary, down), components: down.map((c) => ({ name: c.name, status: c.status })), wallMs };
  const unrecognised = seen.filter((c) => !COMPONENT_STATUSES.includes(c.status));
  return unrecognised.length > 0 ? unknown(`${unrecognised[0].name} reported "${unrecognised[0].status}", a status the gate does not know`) : { state: "clear", wallMs };
}

/**
 * The incident to NAME: the unresolved one that touches one of the three components, else the first, else the component's own words. Its `id` keys the
 * signal, so the same incident on the next tick is the same order.
 */
function incidentNamed(summary: any, down: { name: string; status: string; }[]): { name: string; id: string | null; } {
  const incidents = Array.isArray(summary?.incidents) ? summary.incidents : [];
  const touching = incidents.find((i: any) => (i?.components ?? []).some((c: any) => INCIDENT_COMPONENTS.includes(c?.name))) ?? incidents[0];
  return { name: String(touching?.name ?? `${down[0].name} is ${down[0].status}`), id: touching?.id ? String(touching.id) : null };
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * START THE ONE STATUS CALL and return the means of collecting it. STARTING costs a process spawn and nothing else, so the tick's first read is not
 * delayed by it; `settle()` is called once the orders are decided and finds the answer already written. IT NEVER WAITS PAST THE BOUND: with no answer by
 * `timeoutMs` plus the worker's boot it returns `unknown`, and a worker that could not be started is `unknown` at once. The call's own wall comes back as
 * `wallMs` (the worker times itself), which `main` prints so the tick's cost can be read per call.
 */
export function startGithubStatus({ url = GITHUB_STATUS_URL, timeoutMs = GITHUB_STATUS_TIMEOUT_MS, file = join(REVIEWER_STATE_DIR, GITHUB_STATUS_FILE),
  spawnWorker = spawn, nowMs = () => Date.now() }: { url?: string; timeoutMs?: number; file?: string; spawnWorker?: typeof spawn; nowMs?: () => number; } = {}): { settle: () => GithubIncident; } {
  const token = randomUUID();
  const began = nowMs();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const worker = spawnWorker(process.execPath, ["-e", GITHUB_STATUS_WORKER, url, String(timeoutMs), file, token], { stdio: "ignore" });
    worker.on("error", () => {}); // an unspawnable worker is the missing file `settle` reads as unknown; the event must not be an uncaught throw
    worker.unref();
  } catch (err) {
    return { settle: () => ({ state: "unknown", why: `the worker could not start (${err instanceof Error ? err.message : String(err)})` }) };
  }
  return { settle: () => collectGithubStatus({ file, token, deadline: began + timeoutMs + GITHUB_STATUS_GRACE_MS, nowMs }) };
}

function collectGithubStatus({ file, token, deadline, nowMs }: { file: string; token: string; deadline: number; nowMs: () => number; }): GithubIncident {
  for (;;) {
    const envelope = readJsonOrNull(file);
    if (envelope?.token === token) return githubIncidentOf(envelope);
    if (nowMs() >= deadline) return { state: "unknown", why: "no answer within the bound" };
    sleepMs(GITHUB_STATUS_POLL_MS);
  }
}

/** @returns the parsed file, or `null` when it is absent or not yet whole -- the caller asks again until its deadline */
function readJsonOrNull(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** @returns the answer, or `null` when `gh` refused or said something that is not JSON: UNCLASSIFIED, which is never held */
function readGhJson(args: string[], run: (args: string[]) => string): any {
  try {
    return JSON.parse(run(args));
  } catch {
    return null;
  }
}

const ACTIONS_JOB_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/;

/** A job that NEVER GOT A RUNNER: no steps and no runner, whatever its conclusion. Measured on the 2026-10-05 jobs: `cancelled`, `runner_name: ""`, zero steps. A cancelled job that had steps ran. */
const neverStarted = (job: any) => job !== null && typeof job === "object" && job.steps === 0 && !job.runner_name;

const JOB_FIELDS = "{conclusion, runner_name, steps: (.steps // [] | length)}";

const NOT_FAILING_JOB_CONCLUSIONS = Object.freeze(["success", "skipped", "neutral"]);

/**
 * PURE (given `run`). WHY AN ORDER IS A RUNNER-START FAILURE, or `null` for "it is not one, or the gate cannot tell". The three kinds of the row, all filed under
 * `pr-checks-failing`, are told apart by the discriminator they already carry: `hung-check` and `ejected` name themselves, and what is left is a settled red.
 *  - red:      EVERY red blocking check is an Actions job that never got a runner (one that RAN and failed sends the order, whatever sits beside it).
 *  - hung:     the check the order names is QUEUED, so it never started; an IN_PROGRESS one ran and hangs, which is its owner's.
 *  - ejected:  the `merge_group` run behind the ejection failed ONLY in jobs that never got a runner.
 * Each read that is refused, or a check with no job to read, is `null`: THE ORDER GOES OUT.
 */
function runnerStartOf(order: any, pr: any, reads: { required: string[] | null; nowMs: number; job: (url: unknown) => any; ghJson: (args: string[]) => any; }): string | null {
  if (order.discriminator === "ejected") return ejectionNeverStarted(order, pr, reads.ghJson);
  if (order.discriminator === "hung-check") return queuedPastItsBound(pr, reads);
  const red = blockingChecks(newestPerName(pr.statusCheckRollup ?? []), reads.required).filter((c) => checksSettledGreen([c]) === false);
  if (red.length === 0 || !red.every((c) => neverStarted(reads.job(c.detailsUrl)))) return null;
  return `${red.map((c) => `\`${c.name}\``).join(", ")}: no step ran and no runner was assigned`;
}

function queuedPastItsBound(pr: any, { required, nowMs }: { required: string[] | null; nowMs: number; }): string | null {
  const hung = hungCheckOf(pr, required, nowMs);
  const named: any = hung && newestPerName(pr.statusCheckRollup ?? []).find((c: any) => String(c.name) === hung.name);
  return hung && String(named?.status).toUpperCase() === "QUEUED" ? `\`${hung.name}\` has been QUEUED ${hung.runningMinutes} minutes with no runner` : null;
}

/**
 * The ejection's `merge_group` run is found by its branch as `readEjectionRun` finds it, but by ANY conclusion and not `failure` only, and its jobs are read for
 * steps and runner. A11ign/toolchain#3's run was `failure` overall with its one job `cancelled`, zero steps, 18 min 53 s queued.
 */
function ejectionNeverStarted(order: any, pr: any, ghJson: (args: string[]) => any): string | null {
  const removedAt = /\/ejected\/(.+)$/.exec(String(order.causeKey))?.[1];
  const repo = pr.repo ?? repoNow();
  const runs = removedAt === undefined ? null : ghJson(["api", `repos/${repo}/actions/runs?event=merge_group&per_page=50`, "--jq", "[.workflow_runs[] | {id, head_branch, created_at}]"]);
  const ejected = (Array.isArray(runs) ? runs : []).filter((r) => String(r.head_branch).includes(`/pr-${pr.number}-`) && String(r.created_at) <= String(removedAt))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const jobs = ejected === undefined ? null : ghJson(["api", `repos/${repo}/actions/runs/${ejected.id}/jobs?per_page=100`, "--jq", `[.jobs[] | ${JOB_FIELDS}]`]);
  const failing = (Array.isArray(jobs) ? jobs : []).filter((j) => !NOT_FAILING_JOB_CONCLUSIONS.includes(String(j.conclusion)));
  return failing.length > 0 && failing.every(neverStarted) ? `the queue's run ${ejected.id} failed only in jobs that never got a runner` : null;
}

/**
 * HOLD, DO NOT WAKE: while GitHub reports an incident, the `pr-checks-failing` orders -- a red, a hung check, a merge-queue ejection -- whose failure is a RUNNER START
 * are withheld, and everything else goes out unchanged. NOTHING IS WRITTEN: a held order is simply not printed, so the tick after the incident clears sees the same
 * PR in the same state and delivers the order whole, through the ledger as any new one. The reading that clears the hold is the next tick's own status read; no call,
 * label or file stands between. A red that RAN, an order the gate cannot classify, and every other cause are untouched, and so is every order when the reading is not `incident`.
 *
 * @param facts `prs` of every repository, to find the pull request an order names
 */
export function holdForGithubIncident(orders: any[], incident: GithubIncident, { prs, required = null, run = defaultRun, nowMs = Date.now() }: { prs: any[]; required?: string[] | null; run?: (args: string[]) => string; nowMs?: number; }): { orders: any[]; held: { subject: string; session: string; why: string; }[]; } {
  if (incident?.state !== "incident") return { orders, held: [] };
  const byRef = new Map(prs.map((pr) => [`pr-${subjectRef(pr.repoKey, pr.number)}`, pr]));
  const jobs: Map<string, any> = new Map(); // one read per job per tick, however many orders name it
  const ghJson = (args: string[]) => readGhJson(args, run);
  const job = (url: unknown) => {
    const found = ACTIONS_JOB_URL.exec(String(url ?? ""));
    if (found === null) return null; // not an Actions job (a status context, a third party): nothing to read steps from
    if (!jobs.has(found[0])) jobs.set(found[0], ghJson(["api", `repos/${found[1]}/actions/jobs/${found[2]}`, "--jq", JOB_FIELDS]));
    return jobs.get(found[0]);
  };
  const held: { subject: string; session: string; why: string; }[] = [];
  const kept = orders.filter((order) => {
    const pr = order.cause === "pr-checks-failing" ? byRef.get(order.subject) : undefined;
    const why = pr === undefined ? null : runnerStartOf(order, pr, { required: pr.repo === undefined ? required : null, nowMs, job, ghJson });
    if (why !== null) held.push({ subject: order.subject, session: order.session, why });
    return why === null;
  });
  return { orders: kept, held };
}

/**
 * THE ONE SIGNAL, as an `org-health` order to `ceo` (no new order kind: an existing cause carries it), keyed on the incident so it is raised once and not once per held
 * row. It NAMES the incident and what is held and why, which is how a hold is never silent. `[]` unless the reading is an incident.
 */
export function githubIncidentOrder(incident: GithubIncident, held: { subject: string; session: string; why: string; }[]): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  if (incident?.state !== "incident") return [];
  const key = incident.id ?? incident.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return [{
    session: "ceo",
    cause: "org-health",
    subject: "github-incident",
    discriminator: key,
    prompt: `GITHUB REPORTS AN INCIDENT: "${incident.name}" (${incident.components.map((c) => `${c.name} ${c.status}`).join(", ")}; githubstatus.com). `
      + `This is the gate's one signal for it, raised once. WHILE IT STANDS the gate withholds the orders whose failure is a runner start -- a job cancelled with no steps and `
      + `no runner, a check queued past its bound, a merge-queue ejection whose jobs never got a runner -- so owners are not woken to re-run something that failed to START, `
      + `which also deepens GitHub's queue. A red that RAN and failed a test still goes out. ${held.length === 0 ? "Nothing is held this tick." : `HELD THIS TICK (${held.length}): `
      + held.map((h) => `${h.subject} (${h.session}: ${h.why})`).join("; ")}. IT CLEARS ITSELF: the first tick after GitHub reports Actions, API Requests and Git `
      + "Operations operational delivers each held order to its owner, with no label to lift. Nothing is asked of you unless the incident outlasts the day.",
    causeKey: `ceo/org-health/github-incident/${key}`,
  }];
}

/** The open PRs with a red Actions check, in the shape `ci-failure-class.ts` reads: `ref` is the order's own subject. */
function redPrsOf(prs: any[]): RedPr[] {
  return prs.map((pr) => ({
    ref: `pr-${subjectRef(pr.repoKey, pr.number)}`, repo: pr.repo ?? repoNow(), number: pr.number,
    checks: newestPerName(pr.statusCheckRollup ?? []).filter((c: any) => ["FAILURE", "TIMED_OUT"].includes(String(c.conclusion).toUpperCase()) && ACTIONS_JOB_URL.test(String(c.detailsUrl ?? "")))
      .map((c: any) => ({ name: String(c.name), detailsUrl: String(c.detailsUrl), completedAt: c.completedAt })),
  })).filter((pr) => pr.checks.length > 0);
}

/**
 * `ci-failure-class.ts`'s `sharedFailureTick`, on this tick's open PRs. Never throws. #5098: exported with `run` and `nowMs` so a test reaches it from its real caller (a held order
 * is released by a row's age and its closing, and neither can be driven without a clock).
 */
export function sharedFailuresNow(orders: any[], prs: any[], { run = defaultRun, nowMs }: { run?: typeof defaultRun; nowMs?: number } = {}): any[] {
  return sharedFailureTick(orders, { prs: redPrsOf(prs), run, nowMs }).orders;
}

/**
 * The tick's end of it: collect the reading, say it on stderr (its wall is the cost of the call, per tick), hold what a runner outage holds, and return the
 * signal beside what remains. `required` is the primary's, so only a pull request of the primary's repository is read against it.
 */
export function holdForIncidentNow(status: { settle: () => GithubIncident; }, orders: any[], facts: { prs: any[]; required: string[] | null; }) {
  const incident = status.settle();
  const wall = incident.wallMs === undefined ? "wall not read" : `${incident.wallMs} ms`;
  const { orders: runnerKept, held } = holdForGithubIncident(orders, incident, facts);
  const kept = sharedFailuresNow(runnerKept, facts.prs); // a11ign#5008: a failure SHARED by open PRs is one incident row and no wake each; a merged fix refreshes them
  if (incident.state === "unknown") process.stderr.write(`github-status: UNKNOWN (${incident.why}; ${wall}) -- nothing is held, the gate reads as it always did.\n`);
  else if (incident.state === "clear") process.stderr.write(`github-status: operational (call ${wall}).\n`);
  else process.stderr.write(`GITHUB INCIDENT: ${incident.name} (call ${wall}); holding ${held.length} runner-start order(s)${held.map((h) => ` ${h.subject}`).join("")}.\n`);
  return { orders: kept, held, suppressions: incidentSuppressions(held, orders), signal: githubIncidentOrder(incident, held) };
}

/**
 * a11ign#5100: THE RUNNER-OUTAGE HOLD, AS THE SUPPRESSION IT IS. `holdForGithubIncident` keeps a red PR's order from its owner while GitHub reports an incident and the failure is a runner that never started;
 * the canary's expiry hands that order back after `suppressionMinutes` (15), because an outage that outlasts the hold must not leave a PR unowned. No row can be "working" a GitHub incident, so none excuses it.
 */
export function incidentSuppressions(held: { subject: string; session: string; why: string; }[], orders: any[]): Suppression[] {
  return held.map((entry) => {
    const order = orders.find((candidate) => candidate.session === entry.session && candidate.subject === entry.subject && candidate.cause === "pr-checks-failing") ?? null;
    return { key: String(order?.causeKey ?? `${entry.session}/${entry.subject}`), kind: "hold", holder: entry.session, reason: `GitHub reports an incident and the failure is a runner that never started (${entry.why})`, order, claimedRow: null };
  });
}

/** The deferred wakes the waker left in `wake-deferred` (`<causeKey>\t<first deferred, ms>` a line); `null` is a file that is not there, which is not "none deferred". */
export function deferredWakeCount(dir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  try {
    return read(`${dir}/wake-deferred`).split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return null; // not written yet (or unreadable): the sample records the signal as unread, never as zero
  }
}

/**
 * a11ign#5100: THE MACHINERY CANARY'S ONE CALL IN THE TICK -- sample the standard signals, watch every flag turned on in the last hour, file the incident of a revert, and hand back what a suppression has
 * kept from its holder for 15 minutes. `org-health.ts`'s `machineryCanaryTick` is the logic; this is the facts it is given and the incident it files (`incident` label, as the fleet-build one is).
 * Reads NO new GitHub list: the signals are the lists this tick already read, the local failure ledger and the waker's own file. Never throws.
 */
/**
 * agent-org#1666: the account's authoring calls (`pr create`, `pr merge`, `pr review` sent as the account, not an app) in the three `gh` ledgers: the workers',
 * the managers', and the reviewer's, for the roles `host.json` declares `github-apps` only (a `user-accounts` role's account is its own, not a fallback). A ledger that
 * does not exist has no calls; one that exists and cannot be read makes the reading `null` (unread), never a zero.
 */
export function authorFallbackTimes({ host = homeHostConfig(), reviewerDir = REVIEWER_GH_CONFIG_DIR, read = readFileSync }: { host?: HostConfig; reviewerDir?: string; read?: typeof readFileSync; } = {}): number[] | null {
  const files: { home: GithubRole; path: string; }[] = [
    { home: "workers", path: join(host.gh.workers, "gh", "gh-calls.tsv") },
    { home: "managers", path: join(host.gh.leads, "gh", "gh-calls.tsv") },
    { home: "reviewer", path: join(reviewerDir, "gh-calls.tsv") },
  ];
  const ledgers: AuthorLedger[] = [];
  for (const { home, path } of files) {
    try {
      ledgers.push({ home, lines: String(read(path, "utf8")).split("\n") });
    } catch (cause) {
      if ((cause as { code?: string }).code !== "ENOENT") return null;
    }
  }
  const declared = GITHUB_ROLES.filter((role) => roleIdentity(host, role).mode === "github-apps");
  return accountAuthoringTimes(ledgers, declared);
}

export function machineryCanaryNow({ unread, unarmed, releaseRuns, suppressions, stranded = [], ownerless, authorFallbacks, ejectedNetwork, conflictingIdle = null, now = Date.now(), dir = REVIEWER_STATE_DIR, run = defaultRun, repo = repoNow(), io }: {
  unread: string[] | null; unarmed: number[] | UnarmedFacts | null; releaseRuns: ReleaseRuns | null; suppressions?: Suppression[]; stranded?: number[]; ownerless?: number[] | null; authorFallbacks?: number[] | null; ejectedNetwork?: number[] | null;
  /** agent-org#1649: the conflicting pull requests whose owner is idle this tick (`conflictingIdlePrs`); `null` is not read */
  conflictingIdle?: number[] | null; now?: number; dir?: string; run?: typeof defaultRun; repo?: string; io?: CanaryIo;
}): any[] {
  const { options, problem } = readCanaryOptions();
  if (problem !== null) process.stderr.write(`machinery-canary: ${problem}; the defaults stand.\n`);
  const unarmedNumbers = unarmed === null ? null : Array.isArray(unarmed) ? unarmed : unarmed.numbers; // the gate's bare list or the counted facts: either way, the numbers
  const numbers = unarmedNumbers === null ? null : [...unarmedNumbers, ...stranded]; // a11ign#5125: an ejection that was not the PR's own and left it out of the queue is approved-and-unqueued too
  const fileIncident = (title: string, body: string) => run(["issue", "create", "--title", title, "--label", "incident", "--body", body]);
  // agent-org#1649: the verdicts an outside reviewer wrote and that have not reached their pull request, reconciled against GitHub (a refused read is unread)
  let verdictUndelivered: number[] | null = null;
  try {
    verdictUndelivered = verdictUndeliveredNow({ on: machineryFlagOn(readReenqueueState(dir), VERDICT_DELIVERY_FLAG), dir, pull: pullReadOf(run, repo) });
  } catch {
    verdictUndelivered = null;
  }
  return machineryCanaryTick({ now, dir, options, suppressed: suppressions, io: io ?? realCanaryIo({ fileIncident }),
    facts: { claimRefusals: readClaimRefusals(), unread, deferredWakes: deferredWakeCount(dir), unarmed: numbers, releaseRuns, ownerless: ownerless ?? null, authorFallbacks: authorFallbacks ?? null, ejectedNetwork: ejectedNetwork ?? null, verdictUndelivered, conflictingIdle } }); // agent-org#1648: a red chairman pull request no order reaches; agent-org#1666: the account's authoring calls
}
