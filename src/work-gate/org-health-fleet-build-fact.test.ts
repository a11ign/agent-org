// no-token: pure -- `orgHealthNow` is handed a fake `readFleetBuildIncident`, so nothing here calls `gh`, ssh or the fleet.
/**
 * `src/work-gate/org-health.ts`, #4405 (agent-org#960): THE GATE PASSES `orgHealthNow` ITS FLEET BUILD INCIDENT, so the 4-hour wake that agent-org#943 built can fire. The reading existed and was
 * tested on a hand-made fact; nothing in production set `facts.fleetBuildIncident`, so an incident open for a day woke nobody (`releaseRuns` is `undefined` in every test until the gate passes it).
 *
 * THE CLOCK is 2026-10-11T12:00Z. POSITIVE CONTROL: an incident opened 5 h ago yields a `fleet-build-mixed-over-4h` order to `ceo`. NEGATIVE CONTROLS: one opened 1 h ago, no incident at all, and a
 * caller that does not ask (`undefined`) yield none. A reader that returns `null` is a stated UNKNOWN in the log and never an order or a clear. MUTATIONS, each run by hand and recorded on the row: drop
 * the `fleetBuildIncidentFact` spread (the positive control goes red), spread the fact as `[]` always (the positive control goes red), read `null` as `[]` (the unknown test goes red), read
 * "does not ask" as a refused read (the negative controls' silence assertions go red), and drop the argument at the gate's call site (the wiring test goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workGateSource } from "../lib/work-gate-source.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-auto-off-refusal.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "org-health-fleet-build-fact-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("../packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { orgHealthNow } = await import("./org-health.ts");
const { GH_READS } = await import("./reads/exit.ts");

const SIGNAL = "fleet-build-mixed-over-4h";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const HOUR = 60 * 60_000;
const TITLE = "Mixed Windows build across the fleet: 3 boxes behind 26100.2033";
const incident = (number: number, hoursAgo: number) => ({ number, title: TITLE, createdAt: new Date(NOW - hoursAgo * HOUR).toISOString() });

type Order = { subject: string; session: string; prompt: string };
const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
/** One tick with every other read stubbed; `readFleetBuildIncident` is left OUT of the options when it is not given, which is a caller that does not ask. */
function tick(readFleetBuildIncident?: () => unknown) {
  const said: string[] = [];
  const orders = orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], log: (line: string) => said.push(line), teamAccess: () => undefined,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...(readFleetBuildIncident && { readFleetBuildIncident }) } as never) as Order[];
  return { orders: orders.filter((o) => o.subject === SIGNAL), said };
}

test("POSITIVE CONTROL: an incident open 5 hours is offered to ceo, naming it, its box count and its age", () => {
  const { orders } = tick(() => [incident(4450, 5)]);
  assert.equal(orders.length, 1, "the fact reached the reading and the reading reached an order");
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /#4450 \(3 boxes behind, open 5 h\)/);
});

test("NEGATIVE CONTROLS: no incident, an incident open 1 hour, and a caller that does not ask each offer nothing", () => {
  assert.deepEqual(tick(() => []).orders, [], "no incident is clear");
  assert.deepEqual(tick(() => [incident(4450, 1)]).orders, [], "an hour is inside the bound");
  const unasked = tick();
  assert.deepEqual(unasked.orders, [], "undefined is a caller that does not ask, which is every other test");
  assert.equal(unasked.said.some((line) => line.includes(`${SIGNAL} UNKNOWN`)), false, "and it is SILENT: not asking is not a refused read, or every unwired tick logs an unknown nobody can fix");
  const undefinedAnswer = tick(() => undefined);
  assert.deepEqual(undefinedAnswer.orders, [], "a reader that answers undefined adds no fact either");
  assert.equal(undefinedAnswer.said.some((line) => line.includes(`${SIGNAL} UNKNOWN`)), false);
});

test("a reader that returns null is a stated unknown in the log, and is neither an order nor a clear", () => {
  const { orders, said } = tick(() => null);
  assert.deepEqual(orders, []);
  assert.ok(said.some((line) => line.includes(`org-health: ${SIGNAL} UNKNOWN`)), `the unknown is said, not dropped: ${JSON.stringify(said)}`);
  const clear = tick(() => []);
  assert.equal(clear.said.some((line) => line.includes(`${SIGNAL} UNKNOWN`)), false, "and a clear list says no such thing, so the line above is the null's own");
});

test("the gate's call site passes the real reader and the read is counted, so the signal is not dead for want of a fact (#2980's lesson)", () => {
  assert.ok(GH_READS.unconditional.some((r: string) => r.includes("readFleetBuildIncidents") && r.includes("labels=incident")), "the read is counted where reads are counted");
  const gate = workGateSource();
  assert.match(gate, /readFleetBuildIncidents\(run, gh\.repo\)/);
  assert.match(gate, /readFleetBuildIncident: \(\) => reads\.fleetBuild/);
});
