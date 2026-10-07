// no-token: gh -- importing `work-gate.mjs` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it run: `orgHealthNow` is handed the clock, the last merge, the fleet reading, the lab-job read and the log.
/**
 * #3007 (found by #2980): `waiting.labJobs` IS READ, so a fleet idle with only a lab job waiting trips.
 *
 * `labJobRecordsOrSay` reads the jobs that ENDED, so `labJobs` was always `[]` and "nothing waits" and "not asked" looked the same. The read
 * under test is `readDispatchedLabJobs`: the `ansible-playbook ... lab-job.yml` processes on this host, which live exactly as long as a
 * dispatch does. The tests here run `orgHealthNow` itself, the only place the omission could be caught.
 *
 * THE POSITIVE CONTROL is the first test: zero captures for 24 h, nothing else waiting, ONE job dispatched and not ended, and it offers an
 * order. Every "offers nothing" below is only worth something because that one does.
 *
 * MUTATION, run by hand on 2026-10-02 and recorded on the row (each restored byte-identical from a copy): `readDispatchedLabJobs` returning `[]`
 * turns ONLY the first test red (1 of 10); `dispatchedJobNames` taking every non-empty line as a job turns 4 red (the two parsing tests, the
 * "ended" tick and the "not a dispatch" test); `dispatchedJobNames` never matching turns 3 red; `fleetWaitingFacts` reading a refused job read
 * as `[]` turns 2 red (the refused-read tick and the facts test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgHealthNow, fleetWaitingFacts, dispatchedLabJobsOrSay } from "../work-gate.mjs";
import { dispatchedJobNames, readDispatchedLabJobs } from "../work-gate/lab-job-orders.mjs";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
/** The fleet reading `readFleetCaptures` gives for a ledger watched five days with nothing captured in the last 24 h. */
const IDLE_FLEET = { captures24h: 0, lastCaptureAt: NOW - 118 * HOUR_MS };

const DISPATCH = "node packages/control/src/lab-job.mjs -e job=corpus-recapture";
const PLAYBOOK = "/usr/bin/python3 /usr/bin/ansible-playbook packages/control/ansible/lab-job.yml -e job=corpus-recapture -e row=3007";
const PS_WITH_THE_JOB = ["/sbin/init", "-zsh", DISPATCH, PLAYBOOK, PLAYBOOK, "ps -eo args="].join("\n");
const PS_AFTER_IT_ENDED = ["/sbin/init", "-zsh", "ps -eo args="].join("\n");

const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };

/** One org-health tick as `main` runs it, the lab-job read going through the REAL `readDispatchedLabJobs` over a given `ps` listing. */
function tickOver(ps: () => string, openRowsRead: unknown[] | null = []) {
  const said: string[] = [];
  const orders = orgHealthNow(
    { prsRead: [], readyRead: [], openRowsRead, decideArgs, decided: [] } as never,
    {
      now: NOW, lastMergedAt: () => NOW - HOUR_MS, log: (line: string) => said.push(line), readCopies: () => [] as never,
      readCaptures: (() => IDLE_FLEET) as never,
      readLabJobs: () => dispatchedLabJobsOrSay(() => readDispatchedLabJobs({ run: ps })),
      // #3672: no remote: a project that declares `teamAccess` would otherwise make the live `gh api` read here, and this file asserts nothing about it
      teamAccess: () => undefined,
    },
  );
  return { orders, said };
}

// --- the gate tick ---------------------------------------------------------------------------------------------------------

test("a fleet idle for 24 h with ONE dispatched, un-ended lab job offers org-health / fleet-idle-while-work-waits to ceo", () => {
  const { orders } = tickOver(() => PS_WITH_THE_JOB);
  assert.equal(orders.length, 1, "exactly the fleet signal: every other reading is clear");
  assert.equal(orders[0].session, "ceo");
  assert.equal(orders[0].cause, "org-health");
  assert.equal(orders[0].subject, "fleet-idle-while-work-waits");
  assert.match(orders[0].prompt, /corpus-recapture/, "what waits");
});

test("the same tick once the job has ended offers nothing", () => {
  assert.deepEqual(tickOver(() => PS_AFTER_IT_ENDED).orders, []);
});

test("a REFUSED queued-job read says UNKNOWN on stderr and offers nothing", () => {
  const stderr: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as never;
  let result;
  try {
    result = tickOver(() => { throw new Error("ps: cannot read /proc"); });
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(result.orders, []);
  assert.ok(result.said.some((line) => /fleet-idle-while-work-waits UNKNOWN -- .*what waits for it was not read/.test(line)), result.said.join(""));
  assert.ok(stderr.some((line) => /COULD NOT READ dispatched lab jobs: ps: cannot read \/proc/.test(line)), stderr.join(""));
});

test("a refused job read does not hide a fleet-gated row that is waiting: the rows trip alone", () => {
  const gated = { number: 2870, title: "row", labels: [{ name: "backlog" }, { name: "fleet-gated" }] /* #3942: a row in a state, or the state-label signal trips beside it */, body: "", blockedBy: { nodes: [] } };
  const { orders } = tickOver(() => { throw new Error("denied"); }, [gated]);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /#2870/);
});

// --- the facts -------------------------------------------------------------------------------------------------------------

test("fleetWaitingFacts: a refused job read is `null`, never an empty list; a read that found none is `[]`", () => {
  assert.equal(fleetWaitingFacts([], null), null, "rows empty and jobs unknown is unknown");
  assert.deepEqual(fleetWaitingFacts([], []), { rows: [], labJobs: [] });
  assert.deepEqual(fleetWaitingFacts([], ["corpus-recapture"]), { rows: [], labJobs: ["corpus-recapture"] });
  assert.equal(fleetWaitingFacts(null, ["corpus-recapture"]), null, "a refused rows read is still unknown");
});

// --- the read itself -------------------------------------------------------------------------------------------------------

test("dispatchedJobNames: the forked children of one dispatch are one job, and names come out sorted", () => {
  assert.deepEqual(dispatchedJobNames(PS_WITH_THE_JOB), ["corpus-recapture"]);
  const two = `${PLAYBOOK}\nansible-playbook packages/control/ansible/lab-job.yml -e job=capture-acceptance`;
  assert.deepEqual(dispatchedJobNames(two), ["capture-acceptance", "corpus-recapture"]);
});

test("dispatchedJobNames: the JSON extra-vars form `lab-job.mjs` forwards is read too, and an unreadable job name is `unnamed`, not dropped", () => {
  assert.deepEqual(dispatchedJobNames(`ansible-playbook packages/control/ansible/lab-job.yml -e {"job":"train","row":"1"}`), ["train"]);
  assert.deepEqual(dispatchedJobNames("ansible-playbook packages/control/ansible/lab-job.yml"), ["unnamed"]);
});

test("dispatchedJobNames: what is NOT a dispatch is not a job -- another playbook, a describe-only call, a grep for the name", () => {
  const notDispatches = [
    "ansible-playbook packages/control/ansible/lab-status.yml",
    "ansible-playbook packages/control/ansible/lab-job.yml -e job=train -e describe=1",
    "grep ansible-playbook lab-job.yml",
    "node packages/control/src/lab-job.mjs -e job=train",
    "",
  ];
  assert.deepEqual(dispatchedJobNames(notDispatches.join("\n")), []);
});

test("dispatchedLabJobsOrSay: a listing with no dispatch is `[]` (the refusal being `null` is the third test above)", () => {
  assert.deepEqual(dispatchedLabJobsOrSay(() => readDispatchedLabJobs({ run: () => PS_AFTER_IT_ENDED })), []);
});

test("the real `ps` read runs on this host and answers a list", () => {
  assert.ok(Array.isArray(readDispatchedLabJobs()), "a refused ps would throw, not return something that is not a list");
});
