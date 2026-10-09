// no-token: gh -- a fake `run` stands for `gh` and `orgHealthNow` is handed the clock, the last merge, the fleet and the waits; nothing reaches GitHub, git or herdr
/**
 * #3731: `org-health`'s RED-PR SIGNAL DOES NOT COUNT A RED THE GATE IS HOLDING FOR A RUNNER START (found on #3723's path by worker-3723, 2026-10-05).
 *
 * THE DEFECT: #3723's `holdForGithubIncident` withholds a `pr-checks-failing` order whose failure is a runner start while GitHub reports an incident, but
 * `main` handed `orgHealthNow` the orders from BEFORE the hold, and `redPrFacts` reads an order as "asked". So the red the gate chose not to wake anyone
 * for still tripped `red-pr-unattended` after two hours: a second alarm for a failure the org had decided not to act on.
 *
 * THE FIXTURE IS A `TIMED_OUT` JOB WITH NO STEPS AND NO RUNNER, not a `CANCELLED` one: `red-pr.mjs`'s `RED_CONCLUSIONS` has no `CANCELLED`, so a cancelled check is no red
 * to the signal at all and a test built on it would pass on the unfixed code. (A hung check and an ejection are not rollup reds either; only a runner-start red the
 * rollup carries as `FAILURE`, `TIMED_OUT` or `STARTUP_FAILURE` could ever trip it.)
 *
 * THE CHAIN RUN HERE IS `main`'s: `decide` -> `holdForGithubIncident` -> `orgHealthNow` with the hold's own `held`. Every "no signal" below sits beside a control
 * that the SAME pull request raises it when the hold does not apply, so none passes because the fixture never made a red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, holdForGithubIncident, githubIncidentOf, orgHealthNow, withPrOwners } from "./work-gate.ts";

type Order = { session: string, cause: string, subject: string, causeKey: string };
type Incident = ReturnType<typeof githubIncidentOf>;

const NOW = Date.parse("2026-10-05T23:00:00Z");
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const RED_PR_SIGNAL = "red-pr-unattended";
const THREE_HOURS = 180; // past the signal's two hours, so a counted red trips it
const RUN = "https://github.com/a11ign/a11ign/actions/runs/900";

const check = (conclusion: string, jobId: number) => ({
  name: "gate", status: "COMPLETED", conclusion, startedAt: ago(THREE_HOURS + 10), completedAt: ago(THREE_HOURS), detailsUrl: `${RUN}/job/${jobId}`, workflowName: "ci",
});
const prOf = (rollup: object[]) => ({
  number: 3709, headRefOid: "0123abcd00000000", isDraft: false, headRefName: "agent/some-slug-3709", labels: [{ name: "session:worker-3709" }],
  author: { login: "a11ign-ai-workers" }, closingIssuesReferences: [], comments: [], reviews: [], reviewDecision: "APPROVED", statusCheckRollup: rollup,
});
const NEVER_STARTED = { conclusion: "cancelled", runner_name: "", steps: 0 };
const RAN = { conclusion: "failure", runner_name: "GitHub Actions 1000051907", steps: 12 };
const fakeGh = (answers: Record<string, unknown>) => (args: string[]): string => {
  const key = Object.keys(answers).find((k) => (args[1] ?? "").includes(k));
  if (key === undefined) throw new Error(`gh: not found ${args[1]}`);
  return JSON.stringify(answers[key]);
};

const summary = (actions: string) => JSON.stringify({
  components: [{ name: "Actions", status: actions }, { name: "API Requests", status: "operational" }, { name: "Git Operations", status: "operational" }],
  incidents: actions === "operational" ? [] : [{ id: "3q1yb5m7ltvb", name: "Incident with Actions", status: "investigating", components: [{ name: "Actions" }] }],
});
const INCIDENT = githubIncidentOf({ status: 200, body: summary("degraded_performance") });
const CLEAR = githubIncidentOf({ status: 200, body: summary("operational") });

/** `main`'s chain for one pull request: the orders `decide` makes, what the hold withholds of them, and `orgHealthNow`'s reading of the result. */
function redPrSignal(pr: ReturnType<typeof prOf>, incident: Incident, jobs: Record<string, unknown>) {
  const rows = [{ number: 3709, labels: [{ name: "in-progress" }, { name: "session:worker-3709" }] }];
  const prs = withPrOwners([pr] as never, rows as never, () => null);
  const decided = decide({ prs, readyRows: [], openRows: rows, nowMs: NOW } as never) as Order[];
  const { held } = holdForGithubIncident(decided, incident, { prs, run: fakeGh(jobs), nowMs: NOW });
  const decideArgs = { prs, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: rows, primaryDrift: null, claimRefusals: [] };
  const orders = orgHealthNow({ prsRead: [pr], readyRead: [], openRowsRead: rows, decideArgs, decided, held } as never,
    { now: NOW, lastMergedAt: () => NOW - MINUTE, log: () => {}, readCopies: (() => []) as never, readCaptures: (() => undefined) as never, readLabJobs: () => [],
      readWaits: (() => ({ facts: new Map(), stale: [], bare: [], manual: 0 })) as never, teamAccess: () => undefined }) as Order[];
  return { ordered: decided.filter((o) => o.cause === "pr-checks-failing").length, held: held.length, signals: orders.filter((o) => o.subject === RED_PR_SIGNAL) };
}

test("CONTROL: with no incident a red that never started is red-pr-unattended after three hours -- or every 'no signal' below is vacuous", () => {
  const seen = redPrSignal(prOf([check("TIMED_OUT", 111)]), CLEAR, { "actions/jobs/111": NEVER_STARTED });
  assert.equal(seen.ordered, 1, "the gate orders the red");
  assert.equal(seen.held, 0);
  assert.equal(seen.signals.length, 1, "and the signal counts it");
});

test("DONE-WHEN 1: under an incident a red whose only failure is a runner start is held, and raises NO red-pr-unattended signal at three hours", () => {
  const seen = redPrSignal(prOf([check("TIMED_OUT", 111)]), INCIDENT, { "actions/jobs/111": NEVER_STARTED });
  assert.equal(seen.ordered, 1, "control: it is an order without the hold");
  assert.equal(seen.held, 1, "the gate holds it");
  assert.deepEqual(seen.signals, []);
});

test("DONE-WHEN 2: under the SAME incident a PR whose check RAN and failed still raises the signal", () => {
  const seen = redPrSignal(prOf([check("FAILURE", 444)]), INCIDENT, { "actions/jobs/444": RAN });
  assert.equal(seen.held, 0, "the gate does not hold a red that ran");
  assert.equal(seen.signals.length, 1);
});

test("DONE-WHEN 3: it clears itself -- the same PR, the same jobs, the incident gone: the red counts again with nothing removed", () => {
  const pr = prOf([check("TIMED_OUT", 111)]);
  const jobs = { "actions/jobs/111": NEVER_STARTED };
  assert.deepEqual(redPrSignal(pr, INCIDENT, jobs).signals, [], "held while the incident stands");
  assert.equal(redPrSignal(pr, CLEAR, jobs).signals.length, 1, "counted the tick after it clears");
});

test("DONE-WHEN 4: a red the gate cannot classify is NOT excused -- an unreadable job under an incident still raises the signal", () => {
  const seen = redPrSignal(prOf([check("TIMED_OUT", 111)]), INCIDENT, {});
  assert.equal(seen.held, 0, "the job read was refused, so the gate does not hold it");
  assert.equal(seen.signals.length, 1);
});

test("the gate's `main` hands orgHealthNow the hold's own `held`, so the chain above is the one that runs", () => {
  const source = readFileSync(new URL("./work-gate.ts", import.meta.url), "utf8");
  const call = /orgHealthNow\(\{[^}]*\}/.exec(source)?.[0] ?? "";
  assert.match(call, /\bheld: incident\.held\b/, "main must pass the held orders; without it a held red trips the red-PR signal again");
});
