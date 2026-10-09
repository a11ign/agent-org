// no-token: gh -- every `gh` call is a fake `run` or a seam; the host is a recorded fixture project, and nothing here reaches GitHub, a runner or the fleet.
/**
 * a11ign/a11ign#3943: IDLE IS A SIGNAL. No engineer holds a row and open rows exist that are not date-held: the tick says so to `ceo`, naming each row and why it is not being built.
 *
 * WHAT HAPPENED (the chairman's reading, 2026-10-07): every agent sat idle while 31 open rows went unoffered and nothing said so. Each fact was a correct answer (15 `ready`, 8 of them
 * date-held, 7 behind named rows; 16 `backlog`; 5 `parked`) and the sum was visible to nobody.
 *
 * POSITIVE CONTROLS: every "no finding" below has beside it a case in the same builder that DOES find, and the file ends with a count that at least two cases produce a non-empty list, so an
 * empty-population pass cannot satisfy it. MUTATIONS, each run by hand and recorded on the row: `heldByEngineer` never true (the engineer-holds and unnamed-claim cases go red), always
 * true (every finding case goes red), `isDateHeld` never true (the 8-date-held case goes red), the gate's `shelved` ignored (the B4 case goes red and `READY_UNOFFERED` swallows it).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "./lib/git-env.ts";

// The project is a recorded one, as `state-label-exactly-one.test.ts`: the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "idle-with-open-rows-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
// A row with a Region is compared against the checkout's own files (`git ls-files`), so the recorded project is a repository.
execFileSync("git", ["init", "-q", PROJECT], { env: sandboxGitEnv() });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
// A RECORDING `gh`: first on PATH, it logs every call and fails it, so a call the tick makes is COUNTED whatever seam it goes through (`defaultRun` is `execFileSync("gh", ...)`).
const GH_LOG = join(SCRATCH, "gh-calls.log");
mkdirSync(join(SCRATCH, "fakebin"));
writeFileSync(join(SCRATCH, "fakebin", "gh"), `#!/bin/sh\necho "$@" >> "${GH_LOG}"\nexit 1\n`);
chmodSync(join(SCRATCH, "fakebin", "gh"), 0o755);
process.env.PATH = `${join(SCRATCH, "fakebin")}:${process.env.PATH}`;

const { idleWithOpenRowsReading, idleLine, IDLE_REASONS } = await import("./idle-with-open-rows.ts");
const { SIGNALS, idleWithOpenRowsSignal, orgHealthReadings, orgHealthOrders } = await import("./org-health.ts");
const { orgHealthNow, engineerSeats } = await import("./work-gate/org-health.ts");

const NOW = Date.parse("2026-10-07T07:00:00Z");
const ENGINEERS = ["worker-3905", "worker-3943"];
const FUTURE = "Not-before: 2026-10-20";
const TEMPLATE = "## Region\n```\nsrc/x.mjs\n```\n## Acceptance\nrun it\n## Open-check\ndone\n"; // the sections the gate requires before it offers a row
const row = (number: number, labels: string[], more: Record<string, unknown> = {}) => ({ number, labels: labels.map((name) => ({ name })), body: "", ...more });
const read = (openRows: unknown[], extra: Record<string, unknown> = {}) => idleWithOpenRowsReading({ now: NOW, engineers: ENGINEERS, openRows: openRows as never, ...extra });
const findings = (openRows: unknown[], extra: Record<string, unknown> = {}) => {
  const result = read(openRows, extra);
  assert.ok(result !== null && result.kind === "idle", JSON.stringify(result));
  return result.findings.map((f) => `${f.number}:${f.reason}`);
};

let nonEmpty = 0;
const counted = (list: string[]) => { if (list.length > 0) nonEmpty += 1; return list; };

test("all engineers idle with only backlog rows: one BACKLOG finding per row", () => {
  assert.deepEqual(counted(findings([row(1, ["backlog"]), row(2, ["backlog"]), row(3, ["parked"])])), ["1:BACKLOG", "2:BACKLOG", "3:PARKED"]);
});

test("idle with 8 date-held ready rows: NO finding, dateHeld 8, and the signal is clear (the rows are waiting correctly)", () => {
  const held = Array.from({ length: 8 }, (_, i) => row(100 + i, ["ready"], { body: i % 2 === 0 ? FUTURE : "Not-before: 2026-10-07T20:00:00Z" }));
  const result = read(held);
  assert.deepEqual(result, { kind: "idle", findings: [], dateHeld: 8 });
  assert.equal(idleWithOpenRowsSignal({ idle: result }).status, "clear");
  // the control: the same rows with the dates in the PAST are findings, so the exclusion is the date's and not the shape's
  const lapsed = held.map((r) => ({ ...r, body: "Not-before: 2026-10-01" }));
  assert.equal(counted(findings(lapsed)).length, 8);
  assert.deepEqual(findings(lapsed).map((f) => f.split(":")[1]), Array(8).fill("READY_UNOFFERED"));
});

test("a ready row blocked by a named OPEN row says BLOCKED_BY, and a CLOSED blocker is no reason (READY_UNOFFERED)", () => {
  const open = row(7, ["ready"], { blockedBy: { nodes: [{ number: 3920, state: "OPEN" }] } });
  const closed = row(8, ["ready"], { blockedBy: { nodes: [{ number: 3000, state: "CLOSED" }] } });
  assert.deepEqual(counted(findings([open, closed])), ["7:BLOCKED_BY #3920", "8:READY_UNOFFERED"]);
});

test("a ready row nothing explains is READY_UNOFFERED, named, and trips as the one defect first in the line", () => {
  const result = read([row(5, ["ready"]), row(6, ["backlog"]), row(9, ["backlog"])]);
  assert.ok(result?.kind === "idle");
  assert.deepEqual(counted(result.findings.map((f) => `${f.number}:${f.kind}`)), ["5:READY_UNOFFERED", "6:BACKLOG", "9:BACKLOG"]);
  const reading = idleWithOpenRowsSignal({ idle: result });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.discriminator, "idle-with-open-rows@BACKLOG,READY_UNOFFERED:5");
  assert.match(reading.detail, /^no engineer holds a row, and 3 unoffered: 1 READY_UNOFFERED, 2 BACKLOG \| READY_UNOFFERED #5; BACKLOG #6; BACKLOG #9$/);
});

test("one engineer holding a row is null, and so is a claim naming NO session (absence is not proof); a lead's claim does not count", () => {
  const stock = [row(1, ["backlog"]), row(2, ["ready"])];
  assert.equal(read([...stock, row(3, ["in-progress", "session:worker-3905"])]), null);
  assert.equal(read([...stock, row(4, ["session:worker-3943"])]), null);
  assert.equal(read([...stock, row(5, ["in-progress"])]), null, "an unnamed holder is not an idle org");
  assert.equal(idleWithOpenRowsSignal({ idle: read([...stock, row(3, ["in-progress", "session:worker-3905"])]) }).status, "clear");
  // the control: `orchestrator` holding a lab row is a lead, so the org is still idle, and the claimed row is not stock
  assert.deepEqual(counted(findings([...stock, row(6, ["in-progress", "session:orchestrator"])])), ["1:BACKLOG", "2:READY_UNOFFERED"]);
});

test("an answer: row, a Waiting-for: row, a lane, no state, two states, epic and the blocked label each say their own reason", () => {
  assert.deepEqual(counted(findings([
    row(10, ["ready", "answer:ceo"]),
    row(11, ["ready"], { body: "Waiting-for: closed #3920" }),
    row(12, ["ready", "lane:ceo"]),
    row(13, ["out-of-release"]),
    row(14, ["backlog", "parked"]),
    row(15, ["epic"]),
    row(16, ["blocked"]),
    row(17, ["ready", "lane:any"]),
  ])), ["10:ANSWER_OWED ceo", "11:WAITING_FOR closed #3920", "12:LANE ceo", "13:NO_STATE_LABEL", "14:TWO_STATE_LABELS backlog+parked", "15:EPIC", "16:BLOCKED_LABEL",
    "17:READY_UNOFFERED"]);
});

test("the gate's own shelving is named: a B4 overlap says which, any other shelving says SHELVED, and neither is READY_UNOFFERED", () => {
  const shelved = new Map([[20, "overlaps #3920, which already touches: src/a.mjs. B4: no two open"], [21, "overlaps the Region of #3905, a row already claimed"],
    [22, "has no `## Open-check` section -- `row-claim` refuses it"]]);
  assert.deepEqual(counted(findings([row(20, ["ready"]), row(21, ["ready"]), row(22, ["ready"]), row(23, ["ready"])], { shelved })),
    ["20:B4 overlaps #3920", "21:B4 overlaps #3905", "22:SHELVED has no `## Open-check` section", "23:READY_UNOFFERED"]);
});

test("a refused read is UNREAD and never an idle org: the signal says unknown and the tick names it", () => {
  const rows = idleWithOpenRowsReading({ now: NOW, engineers: ENGINEERS, openRows: null });
  assert.equal(rows?.kind, "unread");
  assert.equal(idleWithOpenRowsSignal({ idle: rows }).status, "unknown");
  const roster = idleWithOpenRowsReading({ now: NOW, engineers: null, openRows: [row(1, ["backlog"])] as never });
  assert.equal(roster?.kind, "unread");
  assert.equal(idleWithOpenRowsSignal({ idle: roster }).status, "unknown");
  // the control: the same open rows with a readable roster DO find, so "unread" is the refusal's and not the rows'
  assert.equal(counted(findings([row(1, ["backlog"])])).length, 1);
});

test("an idle org with nothing open is finished, not stalled, and the signal is OMITTED when the caller does not ask", () => {
  assert.equal(idleWithOpenRowsSignal({ idle: read([]) }).status, "clear");
  const facts = { now: NOW, lastMergedAt: NOW, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null };
  assert.equal(orgHealthReadings(facts as never).some((r) => r.signal === SIGNALS.IDLE_WITH_OPEN_ROWS), false);
  assert.equal(orgHealthReadings({ ...facts, idle: read([row(1, ["backlog"])]) } as never).find((r) => r.signal === SIGNALS.IDLE_WITH_OPEN_ROWS)?.status, "tripped");
});

test("the line groups by reason with counts first, and a standing set is ONE order however many backlog rows are filed", () => {
  const line = idleLine(findings([row(1, ["backlog"])]).map((f) => ({ number: Number(f.split(":")[0]), reason: f.split(":")[1], kind: f.split(":")[1] })), 8);
  assert.equal(line, "1 unoffered (8 date-held, not counted): 1 BACKLOG | BACKLOG #1");
  const a = idleWithOpenRowsSignal({ idle: read([row(1, ["backlog"])]) });
  const b = idleWithOpenRowsSignal({ idle: read([row(1, ["backlog"]), row(2, ["backlog"]), row(3, ["backlog"])]) });
  assert.equal(a.discriminator, b.discriminator);
  assert.notEqual(a.discriminator, idleWithOpenRowsSignal({ idle: read([row(1, ["backlog"]), row(4, ["parked"])]) }).discriminator, "a new KIND of reason is a new order");
});

// --- the tick: the same SIGNALS table and escalation, and no call of its own ---------------------------------------------------------

const decideArgs = (readyRows: unknown[], openRows: unknown[]) => ({ prs: [], required: [], readyRows, prFiles: new Map(), rowBranches: [], openRows, primaryDrift: null, claimRefusals: [] });
function tick(openRowsRead: unknown[] | null, { readyRows = [] as unknown[], prsRead = [] as unknown[] | null } = {}) {
  rmSync(GH_LOG, { force: true });
  const orders = orgHealthNow({ prsRead, readyRead: readyRows, openRowsRead, decideArgs: decideArgs(readyRows, openRowsRead ?? []), decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined } as never) as { subject: string; session: string; prompt: string }[];
  const calls = existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean) : [];
  return { orders: orders.filter((o) => o.subject === SIGNALS.IDLE_WITH_OPEN_ROWS), calls };
}

test("the tick raises it to ceo in the same tick the condition holds, with the reasons grouped, and clears it the tick an engineer holds a row", () => {
  const idle = [row(1, ["backlog"]), row(2, ["backlog"]), row(3, ["parked"]), row(4, ["ready"], { body: FUTURE }), row(5, ["ready"], { body: TEMPLATE })];
  const { orders } = tick(idle, { readyRows: [idle[3], idle[4]] });
  assert.deepEqual(orders.map((o) => o.session), ["ceo"]);
  assert.match(orders[0].prompt, /4 unoffered \(1 date-held, not counted\): 1 READY_UNOFFERED, 2 BACKLOG, 1 PARKED \| READY_UNOFFERED #5; BACKLOG #1; BACKLOG #2; PARKED #3/);
  assert.match(orders[0].prompt, /READY_UNOFFERED. IS A DEFECT/);
  assert.deepEqual(tick([...idle, row(6, ["in-progress", "session:worker-3943"])], { readyRows: [idle[3], idle[4]] }).orders, []);
});

test("the tick's gate shelving reaches the reading, and a refused pull-request read is UNREAD rather than a false READY_UNOFFERED", () => {
  const rows = [row(30, ["ready"], { body: TEMPLATE })];
  assert.equal(tick(rows, { readyRows: rows }).orders.length, 1, "the control: the same rows with the pull-request read present DO trip");
  assert.equal(tick(rows, { readyRows: rows, prsRead: null }).orders.length, 0, "no order from a read that did not return");
  assert.equal(tick(null).orders.length, 0, "a refused open-rows read is no idle org");
});

test("the signal makes no call of its own: the recorded calls are the same whether the org is idle or not, and the leaf imports no process module", () => {
  // the recorder's own control: a `Waiting-for:` on an item the lists do not hold IS read, so a call made by the tick shows in the log
  const waiting = row(2, ["ready"], { body: `${TEMPLATE}Waiting-for: closed #4999` });
  const rows = [row(1, ["backlog"]), waiting];
  const idle = tick(rows, { readyRows: [waiting] });
  const busy = tick([...rows, row(3, ["in-progress", "session:worker-3905"])], { readyRows: [waiting] });
  assert.ok(idle.calls.length > 0, "the recorder sees a call the tick makes (the control for the equality below)");
  assert.equal(idle.orders.length, 1);
  assert.equal(busy.orders.length, 0);
  assert.equal(idle.calls.length, busy.calls.length, "the same number of recorded `gh` calls");
  const source = readFileSync(fileURLToPath(new URL("./idle-with-open-rows.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /child_process|execFile|spawn|defaultRun/);
});

test("engineerSeats reads the roster's engineer entries and the spawned worker-<n> names the rows carry, and null for a roster it cannot read", () => {
  const seats = engineerSeats([row(1, ["in-progress", "session:worker-3905"]), row(2, ["session:orchestrator"]), row(3, ["session:worker-3"])]);
  assert.deepEqual(seats, ["worker-3905"], "the family entry is a rule, `orchestrator` is a lead, and worker-3 is below the family's start");
  assert.equal(engineerSeats([], join(SCRATCH, "no-such-file.json")), null);
});

test("positive control: more than one case above produced a non-empty finding list", () => {
  assert.ok(nonEmpty >= 2, `only ${nonEmpty} case(s) produced findings, so an empty population could satisfy this file`);
  assert.ok(Object.values(IDLE_REASONS).includes("READY_UNOFFERED"));
});
