// no-token: gh -- every `gh` call is a fake `run`; the host is a recorded fixture project, and nothing here reaches GitHub, a runner or the fleet.
/**
 * a11ign/a11ign#3942: EVERY OPEN ROW CARRIES EXACTLY ONE STATE LABEL.
 *
 * WHAT HAPPENED (measured 2026-10-07 from each row's timeline): fifteen open rows carried no state label and `ready:audit`'s `labelless rows` passed every one, because
 * each still held `out-of-release` or `lane:any`. Fourteen were the decline-with-answer shape: a claim, then `declineRow --answer`, whose one edit removed `in-progress`,
 * `started`, `was-ready` and `session:*` and added `answer:<session>` and nothing else; `answer:` clears itself by being REMOVED, so the answerer's correct act left no
 * state at all. The fifteenth (#1740) was a bare `gh issue create`. Eight more rows held TWO states (`backlog` beside `parked` or `epic`).
 *
 * POSITIVE CONTROLS: every "finds nothing" below has, beside it, a row in the same builder that DOES violate, so `[]` is never the only assertion over an empty population.
 * MUTATIONS, each run by hand and recorded on the row: the answer branch adding no `backlog` (the 14-row test goes red), `stateLabelFindings` never finding (the leaf cases and the
 * signal go red), always finding (the single-state controls go red), `writeDeclineLabels` without its state re-read (the refusal test goes red and no other).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The project is a recorded one, as `org-health-auto-off-refusal.test.ts`: the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "state-label-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { STATE_LABELS, FILING_GRACE_MS, stateLabelFindings, rowsBeingFiled } = await import("./claim-labels.mjs");
const { declineRow, claimRecordComment } = await import("./row-claim.mjs");
const { BACKLOG_LABEL, BLOCKED_LABEL } = await import("./project-vocabulary.mjs");
const { PARKED_LABEL } = await import("./work-gate.mjs");
const { reportStateLabels, CHECKS, invisibleRows } = await import("./ready-label-audit.mjs");
const { SIGNALS, stateLabelReading, orgHealthReadings, orgHealthOrders } = await import("./org-health.mjs");
const { labelRefusal, boardingFor } = await import("./row-file.mjs");

const row = (number: number, labels: string[], state?: string) => ({ number, labels, ...(state ? { state } : {}) });

// --- the rule: one pure function over the six names ---------------------------------------------------------------------------------

test("STATE_LABELS is the six names, and the spellings the vocabulary and the gate declare agree with them", () => {
  assert.deepEqual([...STATE_LABELS].sort(), ["backlog", "blocked", "epic", "in-progress", "parked", "ready"]);
  assert.ok(STATE_LABELS.includes(BACKLOG_LABEL) && STATE_LABELS.includes(BLOCKED_LABEL) && STATE_LABELS.includes(PARKED_LABEL),
    "the leaf cannot read `.agent-org/project.json`, so it is pinned here that its literals are the declared ones");
});

test("each shape the timelines show is a finding, one case each, with the kind and the held states", () => {
  const found = stateLabelFindings([
    row(3643, ["out-of-release", "lane:any", "priority"]),           // the 14-row shape: the answer label removed, nothing left
    row(1740, ["meta"]),                                            // the bare create
    row(1520, ["backlog", "parked", "lane:any"]),
    row(69, ["backlog", "epic"]),
    row(2628, ["backlog", "parked", "epic"]),
    row(2151, ["ready", "in-progress", "session:worker-1"]),
  ]);
  assert.deepEqual(found, [
    { number: 3643, labels: [], kind: "NONE" },
    { number: 1740, labels: [], kind: "NONE" },
    { number: 1520, labels: ["backlog", "parked"], kind: "MANY" },
    { number: 69, labels: ["backlog", "epic"], kind: "MANY" },
    { number: 2628, labels: ["backlog", "parked", "epic"], kind: "MANY" },
    { number: 2151, labels: ["ready", "in-progress"], kind: "MANY" },
  ]);
});

test("POSITIVE CONTROL: a row in exactly one of the six is no finding, whichever it is, and `{ name }` labels read as names", () => {
  for (const state of STATE_LABELS) assert.deepEqual(stateLabelFindings([row(1, [state, "lane:any"])]), [], state);
  assert.deepEqual(stateLabelFindings([{ number: 2, labels: [{ name: "backlog" }, { name: "meta" }] }]), []);
  assert.equal(stateLabelFindings([{ number: 3, labels: [{ name: "meta" }] }]).length, 1, "and the same objects with no state ARE found");
});

test("a CLOSED row carrying none is NOT a finding (it has no lane to be in), and a row with no `state` is read as open", () => {
  assert.deepEqual(stateLabelFindings([row(5, ["out-of-release"], "CLOSED")]), []);
  assert.equal(stateLabelFindings([row(5, ["out-of-release"], "OPEN")]).length, 1, "CONTROL: the same labels on an open row are found");
  assert.equal(stateLabelFindings([row(5, ["out-of-release"])]).length, 1);
});

// --- a row being filed is not a row in no state (#4048) ------------------------------------------------------------------------------

// `row-file` adds the state label last, so a filing has a 12 to 13 s gap with none; the tick read in it three times on 2026-10-08 (#4043, #4044, #4047).
// MUTATIONS, run by hand and recorded on the row: the grace never excusing (the 13 s case goes red), always excusing (the 10-minute, MANY and malformed-`createdAt`
// controls go red), `MANY` excused too (the two-state case goes red), an unparseable `createdAt` read as new (the malformed case goes red).
const NOW = Date.parse("2026-10-08T06:03:46Z");
const created = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const dated = (number: number, labels: string[], createdAt?: string) => ({ number, labels, ...(createdAt === undefined ? {} : { createdAt }) });

test("a row with no state label created 13 seconds ago is not a finding; the same row 10 minutes old is NONE", () => {
  assert.deepEqual(stateLabelFindings([dated(4043, ["meta"], created(13))], { now: NOW }), []);
  assert.deepEqual(stateLabelFindings([dated(4043, ["meta"], created(600))], { now: NOW }), [{ number: 4043, labels: [], kind: "NONE" }], "CONTROL: only the age differs");
});

test("the grace is five minutes: just inside excuses, just outside judges", () => {
  assert.equal(FILING_GRACE_MS, 5 * 60 * 1000);
  assert.deepEqual(stateLabelFindings([dated(1, [], created(FILING_GRACE_MS / 1000 - 1))], { now: NOW }), []);
  assert.equal(stateLabelFindings([dated(1, [], created(FILING_GRACE_MS / 1000))], { now: NOW }).length, 1);
});

test("a row with two state labels created 13 seconds ago is still MANY", () => {
  assert.deepEqual(stateLabelFindings([dated(9, ["backlog", "parked"], created(13))], { now: NOW }), [{ number: 9, labels: ["backlog", "parked"], kind: "MANY" }]);
});

test("a row with no `createdAt`, or one that does not parse, is judged and never excused", () => {
  assert.equal(stateLabelFindings([dated(2, ["meta"])], { now: NOW }).length, 1, "absent");
  assert.equal(stateLabelFindings([dated(3, ["meta"], "yesterday-ish")], { now: NOW }).length, 1, "unparseable");
  assert.equal(stateLabelFindings([dated(4, ["meta"], "")], { now: NOW }).length, 1, "empty");
  assert.equal(stateLabelFindings([dated(5, ["meta"], created(13))], { now: NOW }).length, 0, "CONTROL: the same row with a good date is excused");
});

test("a caller that gives no `now` excuses nothing (row-claim's one-row re-read), and a clock a few seconds behind GitHub's still excuses a filing", () => {
  assert.equal(stateLabelFindings([dated(6, ["meta"], created(13))]).length, 1);
  assert.deepEqual(stateLabelFindings([dated(7, ["meta"], created(-8))], { now: NOW }), [], "createdAt 8 s AFTER now");
  assert.equal(stateLabelFindings([dated(8, ["meta"], created(-3600))], { now: NOW }).length, 1, "CONTROL: an hour in the future is a bad read, judged");
});

test("`rowsBeingFiled` names exactly the rows the grace excused, so a reader can count them", () => {
  const rows = [dated(10, ["meta"], created(13)), dated(11, ["meta"], created(600)), dated(12, ["ready"], created(13)), dated(13, ["backlog", "epic"], created(13)),
    { ...dated(14, ["meta"], created(13)), state: "CLOSED" }, dated(15, ["meta"])];
  assert.deepEqual(rowsBeingFiled(rows, { now: NOW }), [10], "no state AND young AND open: the old, the stated, the two-state, the closed and the undated are not");
  assert.deepEqual(stateLabelFindings(rows, { now: NOW }).map((f) => f.number), [11, 13, 15], "and the findings are the complement");
});

// --- the decline path never writes a row to no state --------------------------------------------------------------------------------

/** `releaseBoard` of `work-gate-claim-stalled.test.ts`: REACTIVE, because the decline re-reads the row after its edit. */
function board(labels: string[], state = "OPEN") {
  const held = { labels: [...labels], state };
  const edits: { removed: string[], added: string[] }[] = [];
  const run = (_cmd: string, args: string[]) => {
    if (args[1] === "edit") {
      const changed = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
      edits.push({ removed: changed("--remove-label"), added: changed("--add-label") });
      held.labels = [...held.labels.filter((l) => !changed("--remove-label").includes(l)), ...changed("--add-label")];
      return "";
    }
    return args[1] === "view" ? JSON.stringify({ number: 3643, title: "A row", state: held.state, labels: held.labels.map((name) => ({ name })) }) : "";
  };
  return { held, edits, run };
}
const CLAIMED = ["in-progress", "started", "was-ready", "session:worker-7", "out-of-release", "lane:any"];
const RECORD = [claimRecordComment({ session: "worker-7", nothing: "the claim named no branch and no worktree" })];
const decline = (b: ReturnType<typeof board>, options: Record<string, unknown> = {}) =>
  declineRow(3643, "worker-7", { run: b.run as never, fetchComments: () => RECORD, moveStatus: (() => ({ moved: true })) as never, recordGone: () => {}, ...options });

test("THE 14-ROW SHAPE: claim, decline with `answer`, the answer label removed -- the row ends in `backlog`, one state", () => {
  const b = board(CLAIMED);
  assert.equal(decline(b, { answer: "product-manager" }).declined, true);
  assert.deepEqual(b.edits[0].added, ["answer:product-manager", BACKLOG_LABEL], "`backlog` is written in the SAME edit, not left for the answerer to remember");
  assert.deepEqual(stateLabelFindings([{ number: 3643, labels: b.held.labels }]), [], "released, still waiting on the answer: one state");
  assert.ok(!b.held.labels.includes("ready"), "and not `ready`, which `answer:` does not keep out of the pool");
  b.held.labels = b.held.labels.filter((l) => l !== "answer:product-manager"); // the answerer's one correct act
  assert.deepEqual(stateLabelFindings([{ number: 3643, labels: b.held.labels }]), [], "answered: STILL one state, which is what #3643's timeline did not do");
  assert.deepEqual(b.held.labels.filter((l) => STATE_LABELS.includes(l)), ["backlog"]);
});

test("a state label the decline does not remove is KEPT as the one, never doubled (a row claimed from `parked`)", () => {
  const b = board(["in-progress", "started", "session:worker-7", "parked"]);
  assert.equal(decline(b, { answer: "ceo" }).declined, true);
  assert.deepEqual(b.edits[0].added, ["answer:ceo"]);
  assert.deepEqual(b.held.labels.filter((l) => STATE_LABELS.includes(l)), ["parked"]);
});

test("a blocked, a closed and a plain decline keep their present outcome", () => {
  const blocked = board(CLAIMED);
  assert.equal(decline(blocked, { blockedReason: "waits on a ruling" }).declined, true);
  assert.deepEqual(blocked.edits[0].added, ["blocked"]);

  const plain = board(CLAIMED);
  assert.equal(decline(plain).declined, true);
  assert.deepEqual(plain.edits[0].added, ["ready"], "a row that was `ready` goes back to it");

  const closed = board(CLAIMED, "CLOSED");
  assert.equal(decline(closed, { answer: "ceo" }).declined, true, "a closed row is released, and given no state: it has no lane");
  assert.deepEqual(closed.edits[0].added, []);
});

test("the re-read REFUSES to report DECLINED over an open row left with no state, and a closed one is let through", () => {
  const stateless = ["in-progress", "started", "session:worker-7", "lane:any"]; // never ready, no other state: the plain decline adds nothing
  const b = board(stateless);
  assert.throws(() => decline(b), /NO state label.*#3942/s);
  assert.equal(decline(board(stateless, "CLOSED")).declined, true, "CONTROL: the same labels on a closed row decline");
  assert.equal(decline(board([...stateless, "backlog"])).declined, true, "CONTROL: with a state beside the claim the same decline lands");
});

// --- the audit and the tick name the rows by number ---------------------------------------------------------------------------------

test("`ready:audit` prints NO STATE LABEL / TWO STATE LABELS by number, with the count examined against the count reported", () => {
  const open = [
    { number: 3643, title: "Answered", labels: [{ name: "lane:any" }], state: "OPEN" },
    { number: 1520, title: "Parked", labels: [{ name: "backlog" }, { name: "parked" }], state: "OPEN" },
    { number: 7, title: "Fine", labels: [{ name: "ready" }], state: "OPEN" },
  ];
  const run = (_cmd: string, args: string[]) => (args[0] === "issue" ? JSON.stringify(open) : "");
  const written: string[] = [];
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as never;
  process.stderr.write = (() => true) as never;
  let count: number;
  try { count = reportStateLabels({ run: run as never, fetchReportedNumbers: () => [3643, 1520, 7] }); } finally { process.stdout.write = out; process.stderr.write = err; }
  const text = written.join("");
  assert.equal(count, 2);
  assert.match(text, /NO STATE LABEL {2}#3643/);
  assert.match(text, /TWO STATE LABELS {2}#1520 {2}backlog, parked/);
  assert.doesNotMatch(text, /#7\b/, "the row in one state is not named");
  assert.ok(CHECKS.some(([name, fn]) => name === "state labels" && fn === reportStateLabels as unknown), "and it is one of the audit's checks");

  const lines: string[] = [];
  process.stdout.write = ((chunk: string) => { lines.push(chunk); return true; }) as never;
  process.stderr.write = (() => true) as never;
  try { assert.equal(reportStateLabels({ run: ((_c: string, a: string[]) => (a[0] === "issue" ? JSON.stringify([open[2]]) : "")) as never, fetchReportedNumbers: () => [7] }), 0); }
  finally { process.stdout.write = out; process.stderr.write = err; }
  assert.match(lines.join(""), /OK {2}1 of 1 open issue\(s\) checked, each carries exactly one of/, "POSITIVE CONTROL's other half: a clean population says what it examined");
});

test("the TICK trips the signal for rows in none or in two, naming each number, to `product-manager` and then `ceo`; a clean read is clear and a refused one unknown", () => {
  const rows = [{ number: 3643, labels: [{ name: "lane:any" }] }, { number: 69, labels: [{ name: "backlog" }, { name: "epic" }] }, { number: 7, labels: [{ name: "ready" }] }];
  const r = stateLabelReading({ rows });
  assert.equal(r.status, "tripped");
  assert.equal(r.signal, SIGNALS.STATE_LABEL);
  assert.match(r.detail, /NO state label: #3643/);
  assert.match(r.detail, /MORE THAN ONE: #69 \(backlog, epic\)/);
  assert.doesNotMatch(r.detail, /#7\b/);
  assert.notEqual(stateLabelReading({ rows: [rows[2]] }).status, "tripped", "CONTROL: the clean population does not trip");
  assert.equal(stateLabelReading({ rows: [rows[2]] }).status, "clear");
  assert.equal(stateLabelReading({ rows: null }).status, "unknown");
  assert.notEqual(stateLabelReading({ rows: rows.slice(0, 1) }).discriminator, stateLabelReading({ rows: rows.slice(0, 2) }).discriminator, "the set changing is a new order");

  const orders = orgHealthOrders(orgHealthReadings({ now: 0, lastMergedAt: 0, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null, stateRows: rows } as never)
    .filter((x) => x.signal === SIGNALS.STATE_LABEL));
  assert.deepEqual(orders.map((o) => o.session), ["product-manager", "ceo"]);
  assert.notEqual(orders[0].causeKey, orders[1].causeKey, "two readers are two orders, not one deduplicated");
  assert.match(orders[0].prompt, /#3643/);
  assert.equal(orgHealthReadings({ now: 0, lastMergedAt: 0, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null } as never).some((x) => x.signal === SIGNALS.STATE_LABEL), false,
    "a caller that does not ask is silent");
});

// --- the migration the row orders must not turn a legitimate state into a different finding ------------------------------------------------

test("a row in `parked` alone is reached (a state of its own, so migrating `backlog`+`parked` to `parked` is not UNREACHABLE); one with no cause label still is", () => {
  assert.deepEqual(invisibleRows([{ number: 1520, title: "parked", labels: ["parked", "lane:any"] }]), []);
  assert.deepEqual(invisibleRows([{ number: 1521, title: "none", labels: ["lane:any"] }]).map((r: { number: number }) => r.number), [1521], "CONTROL: a row with no cause label is found");
});

// --- row-file refuses a second state ------------------------------------------------------------------------------------------------

test("`row-file` refuses a `--label` that would give the row a second state label, and a plain filing still gets exactly one", () => {
  for (const second of ["parked", "epic", "blocked", "in-progress", "Parked"]) {
    assert.match(String(labelRefusal(["--label", second], [])), /SECOND state label/, second);
    assert.match(String(labelRefusal(["--ready", `--label=${second}`], [])), /SECOND state label/, `${second} beside ready`);
  }
  assert.equal(labelRefusal(["--title", "x"], []), null, "CONTROL: a plain filing is not refused");
  assert.equal(labelRefusal(["--label", "meta"], []), null, "CONTROL: a label that is no state is not refused");
  assert.equal(labelRefusal(["--ready", "--label", "ready"], []), null, "CONTROL: `--label ready` beside `--ready` is the one state, said twice");
  assert.equal(boardingFor(["--label", "meta"]).label, BACKLOG_LABEL, "and the filing writes exactly one itself");
});
