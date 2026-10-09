// no-token: nothing here reaches a remote -- every `node` asked is a stand-in script in a scratch directory, and the units are fixture text or the shipped templates read from disk.
/**
 * `src/node-strips-types.ts` and `org-health`'s `node-cannot-strip` (a11ign/a11ign#4390, ADR 0043 Decision 8): A `node` THE HOST RUNS THAT CANNOT STRIP TYPES IS RAISED, NAMING THE BINARY AND ITS CALLER.
 *
 * THE FIXTURE IS THE DISTRO BUILD'S OWN READING: a stand-in `node` whose `-p process.features.typescript` prints `false` (Ubuntu's `nodejs 22.22.1+dfsg`) against ones printing `strip` and
 * `transform` (upstream Node 24). The stand-ins are real executables that `execFileSync` runs, so the read is exercised and not only its parser. POSITIVE CONTROLS: the emptiness of "nothing raised"
 * is read against the same run with ONE bad binary among the good ones, which raises exactly one signal naming only the bad one. MUTATIONS, each run by hand and recorded on the row: accept every
 * reading (the `false` and unreadable tests go red), reject `transform` (the transform test goes red), read an unreadable binary as clear (the missing and non-zero tests go red), and leave the
 * signal out of `orgHealthReadings` (the wiring tests go red, and only they).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `host-units.ts` resolves the project it serves at import, so the host file is set FIRST and the tool imported AFTER it (the recorded fixture project `org-health.test.ts` explains, #3233).
const SCRATCH = mkdtempSync(join(tmpdir(), "node-strips-types-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/host-project-paths/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { readNodeStrips, renderedUnits, unitNodeBinaries, nodeOnPath, SESSION_PATH_CALLER } = await import("./node-strips-types.ts");
const { SIGNALS, nodeCannotStripReading, orgHealthReadings, orgHealthOrders } = await import("./org-health.ts");
const { orgHealthNow } = await import("./work-gate/org-health.mjs");

const SIGNAL = "node-cannot-strip";
const NOW = Date.parse("2026-10-09T12:00:00Z");

/** A `node` that prints `printed` for any argument and exits with `status`, in its own directory so it can also be the only entry of a PATH. */
function standIn(name: string, printed: string, status = 0): string {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "node");
  writeFileSync(path, `#!/bin/sh\necho ${printed}\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return path;
}

const pathOf = (binary: string) => ({ PATH: binary.slice(0, binary.lastIndexOf("/")) });
const unit = (name: string, binary: string) => ({ name, text: `[Service]\nExecStart=${binary} --import tsx src/work-tick.ts\n` });
const tripped = <T extends { signal: string; status: string }>(readings: T[]) => readings.filter((r) => r.signal === SIGNAL && r.status === "tripped");

test("a stand-in node printing `false`, the distro build's reading, raises node-cannot-strip naming its path", () => {
  const distro = standIn("distro", "false");
  const reading = nodeCannotStripReading({ fact: readNodeStrips({ units: [], env: pathOf(distro) }) });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.signal, SIGNALS.NODE_CANNOT_STRIP);
  assert.match(reading.detail, new RegExp(distro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(reading.detail, /prints `false`/);
  assert.match(reading.detail, new RegExp(SESSION_PATH_CALLER));
});

test("one printing `strip` raises nothing, and neither does one printing `transform`", () => {
  for (const printed of ["strip", "transform"]) {
    const upstream = standIn(`upstream-${printed}`, printed);
    assert.equal(nodeCannotStripReading({ fact: readNodeStrips({ units: [], env: pathOf(upstream) }) }).status, "clear", printed);
  }
});

test("`true` is not a reading Node prints for this property, so it is not trusted as one (#4388: the property is a string)", () => {
  const odd = standIn("odd", "true");
  assert.equal(nodeCannotStripReading({ fact: readNodeStrips({ units: [], env: pathOf(odd) }) }).status, "tripped");
});

test("a binary that does not exist, or exits non-zero, raises it too: absence is not a pass", () => {
  const missing = join(SCRATCH, "nowhere", "node");
  const failing = standIn("failing", "strip", 3);
  const upstream = standIn("upstream-for-missing", "strip");
  const fact = readNodeStrips({ units: [unit("a.service", missing), unit("b.service", failing)], env: pathOf(upstream) });
  const reading = nodeCannotStripReading({ fact });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /2 of 3/);
  assert.ok(reading.detail.includes(missing) && reading.detail.includes(failing));
  assert.match(reading.detail, /could not be run/);
});

test("a PATH with no node at all is a finding, not a pass", () => {
  const empty = join(SCRATCH, "empty-path");
  mkdirSync(empty, { recursive: true });
  assert.equal(nodeOnPath({ env: { PATH: empty } }), null);
  const reading = nodeCannotStripReading({ fact: readNodeStrips({ units: [], env: { PATH: empty } }) });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /could not be run/);
});

test("CONTROL for the emptiness: ONE good and ONE bad binary raise exactly one signal, naming the bad one", () => {
  const good = standIn("good", "strip");
  const bad = standIn("bad", "false");
  const readings = orgHealthReadings({ ...QUIET, nodeStrips: readNodeStrips({ units: [unit("work-tick.service", bad)], env: pathOf(good) }) } as never);
  const raised = tripped(readings);
  assert.equal(raised.length, 1);
  assert.ok(raised[0].detail.includes(bad));
  assert.ok(!raised[0].detail.includes(good), "the good binary is not named");
  assert.match(raised[0].detail, /work-tick\.service/);
  assert.match(raised[0].detail, /1 of 2/);
  assert.equal(raised[0].discriminator, `${SIGNAL}@${bad}`);
});

test("a binary several callers share is asked once and names every caller", () => {
  const good = standIn("shared-path", "strip");
  const shared = standIn("shared", "false");
  let asked = 0;
  const fact = readNodeStrips({ units: [unit("b.service", shared), unit("a.service", shared)], env: pathOf(good), run: (binary) => { if (binary === shared) asked += 1; return binary === shared ? "false" : "strip"; } });
  assert.equal(asked, 1);
  assert.deepEqual(fact.readings.find((r) => r.binary === shared)?.callers, ["a.service", "b.service"]);
});

test("the ExecStart binaries come from the rendered units: a unit naming /usr/bin/node on a host where that prints `false` is the fixture", () => {
  const good = standIn("path-good", "strip");
  const run = (binary: string) => (binary === "/usr/bin/node" ? "false" : "strip");
  const fact = readNodeStrips({ units: [unit("a11ign-work-tick.service", "/usr/bin/node")], env: pathOf(good), run });
  const reading = nodeCannotStripReading({ fact });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /\/usr\/bin\/node \(a11ign-work-tick\.service\) prints `false`/);
  assert.equal(nodeCannotStripReading({ fact: readNodeStrips({ units: [unit("a11ign-work-tick.service", "/usr/bin/node")], env: pathOf(good), run: () => "strip" }) }).status, "clear", "CONTROL: the same unit on a host that strips");
});

test("unitNodeBinaries reads node from any Exec line, expands %h, and leaves bash and pnpm to the PATH node", () => {
  const found = unitNodeBinaries([{ name: "x.service", text: [
    "[Service]", "ExecStartPre=-%h/.local/bin/node src/update.ts", "ExecStart=/usr/bin/bash host/run.sh", "ExecStart=%h/.local/bin/pnpm run messaging:listen", "ExecStart=/usr/bin/node --import tsx src/x.ts"].join("\n") }], "/home/agent");
  assert.deepEqual(found.map((f) => f.binary).sort(), ["/home/agent/.local/bin/node", "/usr/bin/node"]);
});

test("POSITIVE CONTROL for the discovery: the shipped templates are rendered and do name /usr/bin/node", () => {
  const units = renderedUnits();
  assert.ok(units.length > 0, "the shipped units were found");
  const named = unitNodeBinaries(units);
  assert.ok(named.some((n) => n.binary === "/usr/bin/node" && n.callers.some((c) => c.endsWith("work-tick.service"))), `work-tick names /usr/bin/node; found ${JSON.stringify(named)}`);
});

test("an unread fact is unknown and never clear", () => {
  assert.equal(nodeCannotStripReading({ fact: null }).status, "unknown");
});

// ---- the wiring: proved through org-health, not the new module alone --------------------------------------------------------------------------------------------------------------------

const QUIET = { now: NOW, lastMergedAt: NOW - 60 * 60_000, work: { greenPrs: 0, claimableRows: 0 }, redPrs: [], refusals: {}, drift: { behind: 0, ahead: 0, dirty: [] }, primarySince: null };

test("orgHealthReadings carries the signal only when the fact is given, and the order goes to ceo with the remedy", () => {
  const bad = standIn("wired-bad", "false");
  const fact = readNodeStrips({ units: [], env: pathOf(bad) });
  assert.equal(orgHealthReadings(QUIET as never).some((r) => r.signal === SIGNAL), false, "an omitted fact is silent");
  const orders = orgHealthOrders(orgHealthReadings({ ...QUIET, nodeStrips: fact } as never));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].subject, SIGNAL);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /Node 24/);
  assert.deepEqual(orgHealthOrders(orgHealthReadings({ ...QUIET, nodeStrips: readNodeStrips({ units: [], env: pathOf(standIn("wired-good", "strip")) }) } as never)), []);
});

test("orgHealthNow offers the order from the reader it is given, and nothing when the reader is not asked or every node strips", () => {
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const tick = (readNodeStrips?: () => unknown) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }), ...(readNodeStrips && { readNodeStrips }) } as never) as { subject: string; prompt: string }[];
  const ofSignal = (orders: { subject: string }[]) => orders.filter((o) => o.subject === SIGNAL);
  const bad = standIn("tick-bad", "false");
  assert.equal(ofSignal(tick(() => readNodeStrips({ units: [], env: pathOf(bad) }))).length, 1, "a node that cannot strip is offered by the tick");
  assert.deepEqual(ofSignal(tick()), [], "a caller that does not ask is silent");
  assert.deepEqual(ofSignal(tick(() => readNodeStrips({ units: [], env: pathOf(standIn("tick-good", "strip")) }))), []);
});

test("units that cannot be listed leave a clear PATH node UNKNOWN, never clear, and a bad one still trips", () => {
  const good = standIn("unlisted-good", "strip");
  const fact = { ...readNodeStrips({ units: [], env: pathOf(good) }), unlisted: "the project declares no `units`" };
  const reading = nodeCannotStripReading({ fact });
  assert.equal(reading.status, "unknown");
  assert.match(reading.detail, /declares no `units`/);
  const bad = { ...readNodeStrips({ units: [], env: pathOf(standIn("unlisted-bad", "false")) }), unlisted: "x" };
  assert.equal(nodeCannotStripReading({ fact: bad }).status, "tripped");
});

test("readNodeStrips with no units given reads the real ones, or says why it could not, and never throws", () => {
  const fact = readNodeStrips({ env: pathOf(standIn("real-units", "strip")) });
  assert.ok(fact.readings.length >= 2, "the PATH node and at least one unit's node");
  assert.equal(fact.unlisted, undefined);
});
