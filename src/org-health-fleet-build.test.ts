// no-token: pure -- the reading is a function of values handed in, and `readFleetBuildIncidents` is given a fake `run`; nothing here calls `gh`, ssh or the fleet.
/**
 * `src/org-health.ts`, #4405: AN OPEN BUILD INCIDENT THAT HAS STOOD `FLEET_BUILD_MIXED_HOURS` HOURS IS RAISED TO `ceo` WITHIN A TICK, NAMING THE INCIDENT, ITS BOX COUNT AND ITS AGE,
 * instead of the fleet staying on mixed Windows builds for a day while the incident sits open unread.
 *
 * THE FIXTURE IS ONE INCIDENT ISSUE, in the shape `readFleetBuildIncidents` projects it (number, title, createdAt; its body was read for the line and is not kept). The clock is
 * 2026-10-11T12:00Z. POSITIVE CONTROL: an incident opened 4 h 30 min ago trips, with `firstTrippedAt` at its creation plus 4 h. NEGATIVE CONTROL: an incident opened 3 h 50 min ago,
 * and no incident at all, both clear. MUTATIONS, each run by hand and recorded on the row: never trip (the positive control goes red), always trip (the negative controls go red, and only
 * they), a bound of 5 h (the 4 h 30 min case goes red), and read a refused list as clear (the unknown test goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-auto-off-refusal.test.ts`'s rule): the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "org-health-fleet-build-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { SIGNALS, FLEET_BUILD_MIXED_HOURS, FLEET_BUILD_INCIDENT_LINE } = await import("./org-health/no-merge-hours.ts");
const { fleetBuildMixedReading, readFleetBuildIncidents, orgHealthReadings, orgHealthOrders } = await import("./org-health/fleet-build-incident.ts");

const SIGNAL = "fleet-build-mixed-over-4h";
const REPO = "a11ign/a11ign";
const NOW = Date.parse("2026-10-11T12:00:00Z");
const HOUR = 60 * 60_000;

type Incident = { number: number; title: string; createdAt: string };
const TITLE = "Mixed Windows build across the fleet: 3 boxes behind 26100.2033";
const incident = (number: number, createdAt: string, title = TITLE): Incident => ({ number, title, createdAt });
const reading = (list: Incident[] | null) => fleetBuildMixedReading({ now: NOW, incident: list });

// --- the constants, pinned to the copy `fleet-watch` writes (the row's contract) ----------------------------------------------------------

test("the bound is four hours and the line is the one the control row files, verbatim", () => {
  assert.equal(FLEET_BUILD_MIXED_HOURS, 4);
  assert.equal(FLEET_BUILD_INCIDENT_LINE, "Incident: incident:fleet-build-mixed");
  assert.equal(SIGNALS.FLEET_BUILD_MIXED, SIGNAL);
});

// --- the reading -------------------------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: an incident open 4 h 30 min trips, names its number, box count and age, and first tripped four hours after it opened", () => {
  const opened = "2026-10-11T07:30:00Z";
  const r = reading([incident(4410, opened)]);
  assert.equal(r.status, "tripped");
  assert.equal(r.signal, SIGNAL);
  assert.equal(r.discriminator, `${SIGNAL}@4410`);
  assert.equal(r.firstTrippedAt, Date.parse(opened) + FLEET_BUILD_MIXED_HOURS * HOUR);
  assert.match(r.detail, /1 build incident\(s\) have stood open over 4 h/);
  assert.match(r.detail, /#4410 \(3 boxes behind, open 5 h\)/, "4 h 30 min rounds to 5 h, as every age in the tick does");
});

test("NEGATIVE CONTROL: an incident open 3 h 50 min is clear, and so is no incident at all", () => {
  assert.equal(reading([incident(4411, "2026-10-11T08:10:00Z")]).status, "clear");
  assert.equal(reading([]).status, "clear");
});

test("the bound is inclusive: an incident open exactly four hours trips", () => {
  assert.equal(reading([incident(4412, "2026-10-11T08:00:00Z")]).status, "tripped");
});

test("the discriminator is the OLDEST over-bound incident, and the detail names every one, capped", () => {
  const newer = incident(4420, "2026-10-11T06:00:00Z");
  const older = incident(4419, "2026-10-11T05:00:00Z");
  const fresh = incident(4421, "2026-10-11T11:00:00Z");
  const r = reading([newer, fresh, older]);
  assert.equal(r.status, "tripped");
  assert.equal(r.discriminator, `${SIGNAL}@4419`);
  assert.equal(r.firstTrippedAt, Date.parse("2026-10-11T05:00:00Z") + FLEET_BUILD_MIXED_HOURS * HOUR);
  assert.match(r.detail, /2 build incident\(s\) have stood open over 4 h/);
  assert.doesNotMatch(r.detail, /#4421/, "an incident under the bound is not named");

  const many = reading(Array.from({ length: 7 }, (_, i) => incident(4500 + i, "2026-10-11T05:00:00Z")));
  assert.match(many.detail, /7 build incident\(s\)/);
  assert.match(many.detail, /, and 2 more$/);
});

test("a box count the title does not name says so, and does not invent one", () => {
  const r = reading([incident(4430, "2026-10-11T05:00:00Z", "Mixed Windows build across the fleet")]);
  assert.match(r.detail, /#4430 \(box count not in its title, open 7 h\)/);
});

test("a read it cannot make is UNKNOWN, never clear: a refused list is null, and an incident with no creation time is unknown", () => {
  const refused = reading(null);
  assert.equal(refused.status, "unknown");
  assert.match(refused.detail, /could not be read/);
  const undated = reading([incident(4440, "not a date")]);
  assert.equal(undated.status, "unknown");
  assert.match(undated.detail, /1 open incident\(s\) carry no creation time/);
  assert.equal(reading([incident(4441, "not a date"), incident(4442, "2026-10-11T05:00:00Z")]).status, "tripped", "a tripped incident wins over an undated one");
});

// --- the reader ---------------------------------------------------------------------------------------------------------------------------

/** A fake `gh` that answers by URL and records every call; nothing here reaches GitHub. */
function fakeGh(answer: string | Error) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, calls };
}
const BODY_WITH_LINE = `The fleet is mixed.\n\n${FLEET_BUILD_INCIDENT_LINE}\n`;

test("the reader makes ONE call for the open incident issues, filtered to the label and the repository, and keeps those carrying the line", () => {
  const fake = fakeGh(JSON.stringify([
    { number: 4450, title: TITLE, createdAt: "2026-10-11T05:00:00Z", body: BODY_WITH_LINE },
    { number: 4451, title: "Unrelated outage", createdAt: "2026-10-11T05:00:00Z", body: "Incident: incident:something-else" },
    { number: 4452, title: "Prose mention", createdAt: "2026-10-11T05:00:00Z", body: `Do not confuse this with ${FLEET_BUILD_INCIDENT_LINE} in prose.` },
  ]));
  assert.deepEqual(readFleetBuildIncidents(fake.gh, REPO), [{ number: 4450, title: TITLE, createdAt: "2026-10-11T05:00:00Z" }]);
  assert.equal(fake.calls.length, 1);
  const [args] = fake.calls;
  assert.ok(args.includes(`repos/${REPO}/issues`) && args.includes("labels=incident") && args.includes("state=open"));
  assert.ok(args.some((a) => a.includes("select(.pull_request | not)")), "a pull request is not an incident");
});

test("the reader's refusals are nulls, never an empty answer: a failed call, text that is not JSON, and an object where a list was projected", () => {
  assert.equal(readFleetBuildIncidents(fakeGh(new Error("HTTP 403")).gh, REPO), null);
  assert.equal(readFleetBuildIncidents(fakeGh("not json").gh, REPO), null);
  assert.equal(readFleetBuildIncidents(fakeGh("{}").gh, REPO), null);
  assert.deepEqual(readFleetBuildIncidents(fakeGh("[]").gh, REPO), [], "an empty list is a true answer: no incident");
});

// --- the order ----------------------------------------------------------------------------------------------------------------------------

const QUIET = { now: NOW, lastMergedAt: NOW - HOUR, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {},
  drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };

test("the signal is in the readings only when the fact is given, and the order goes to ceo and says what clears it", () => {
  assert.equal(orgHealthReadings({ ...QUIET, autoOff: { refusal: null, readAt: NOW } } as never).some((r) => r.signal === SIGNAL), false, "an omitted fact is silent");
  const orders = orgHealthOrders(orgHealthReadings({ ...QUIET, fleetBuildIncident: [incident(4410, "2026-10-11T07:30:00Z")] } as never));
  const ours = orders.filter((o) => o.subject === SIGNAL);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].session, "ceo");
  assert.match(ours[0].prompt, /ORG HEALTH: `fleet-build-mixed-over-4h` HAS TRIPPED\. 1 build incident\(s\) have stood open over 4 h/);
  assert.match(ours[0].prompt, /#4410 \(3 boxes behind, open 5 h\)/);
  assert.match(ours[0].prompt, /Do not close the incident by hand/);
  assert.match(ours[0].prompt, /It first tripped at 2026-10-11T11:30:00Z/);
});

test("a clear fact offers nothing, and a refused read is a stated unknown, not a silent clear", () => {
  const clear = orgHealthOrders(orgHealthReadings({ ...QUIET, fleetBuildIncident: [] } as never));
  assert.deepEqual(clear.filter((o) => o.subject === SIGNAL), []);
  const unknown = orgHealthReadings({ ...QUIET, fleetBuildIncident: null } as never).find((r) => r.signal === SIGNAL);
  assert.equal(unknown?.status, "unknown");
});
