// no-token: gh -- pure readings over fixtures; nothing here reaches GitHub, a runner or the fleet.
/**
 * a11ign/a11ign#4401: A ROW SHELVED BY B4 AGAINST THE PR THAT WAITS ON IT IS A CIRCLE, and org-health says so.
 *
 * WHAT HAPPENED (2026-10-09): #4372 was shelved on 71 ticks, `overlaps #39 in a11ign/lab`, while lab#39 was held (`hold:ceo`, `Waiting-for: closed #4372`) and declared `Closes: none`.
 * The shelved reasons below are written by the REAL `fileOverlapReason`, so a change to B4's wording that the reading matches on turns this file red instead of silently emptying it.
 *
 * POSITIVE CONTROLS: every "no finding" case has beside it, in the same builder, a case that DOES find, and the file ends with a count that at least four cases produced a non-empty list.
 * MUTATIONS, each run by hand and recorded on the pull request: the `Waiting-for` match disabled (the finding cases go red), the held/parked/red gate always true (the unheld case goes red),
 * the own-PR skip removed (the `Closes` case goes red), the reason match removed (the unrelated-PR case goes red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "./lib/git-env.ts";

// The project is a recorded one, as `idle-with-open-rows.test.ts`: the host file is set FIRST and the tool imported AFTER it, dynamically.
const SCRATCH = mkdtempSync(join(tmpdir(), "shelved-circle-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
execFileSync("git", ["init", "-q", PROJECT], { env: sandboxGitEnv() });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
// A RECORDING `gh`: first on PATH, it logs every call and fails it, so a call the tick makes is COUNTED whatever seam it goes through.
const GH_LOG = join(SCRATCH, "gh-calls.log");
mkdirSync(join(SCRATCH, "fakebin"));
writeFileSync(join(SCRATCH, "fakebin", "gh"), `#!/bin/sh\necho "$@" >> "${GH_LOG}"\nexit 1\n`);
chmodSync(join(SCRATCH, "fakebin", "gh"), 0o755);
process.env.PATH = `${join(SCRATCH, "fakebin")}:${process.env.PATH}`;

const { fileOverlapReason, declaredClosedRows } = await import("./row-claim/file-overlap-rule.ts");
const { orgHealthNow } = await import("./work-gate/org-health.ts");
const { SIGNALS, shelvedCircles, shelvedCircleReading, orgHealthReadings, orgHealthOrders } = await import("./org-health.ts");

const TRACKER = "a11ign/a11ign";
const LAB = "a11ign/lab";
const REGION = ["lab:tests/a.test.ts"];

type Pr = import("./org-health.ts").CirclePr;
type Rows = import("./org-health.ts").CircleRow[];
const lab39 = (more: Partial<Pr> = {}): Pr => ({ number: 39, repo: LAB, labels: ["hold:ceo"], body: "Closes: none -- first slice\n\nWaiting-for: closed #4372\n", ...more });

/** B4's own refusal for row `number` against `prs`, exactly as the gate would shelve it: the PR's `closes` and `held` as `comparablePrFiles` reads them. */
function shelvedBy(number: number, prs: Pr[], blockedBy: Record<number, number[]> = {}): Map<number, string> {
  const others = prs.map((pr) => ({ number: pr.number, repo: pr.repo as string, repoKey: "lab", files: ["tests/a.test.ts"], changedFiles: 1,
    closes: declaredClosedRows(pr.body, { prRepo: pr.repo as string, trackerRepo: TRACKER }), held: (pr.labels as string[]).some((l) => l.startsWith("hold:")) }));
  const { reason } = fileOverlapReason(REGION, others, { rowNumber: number, blockersOf: (row) => blockedBy[row] ?? [] });
  return reason === null ? new Map() : new Map([[number, reason]]);
}
const circlesOf = (prs: Pr[], rows: Rows = [], shelved = shelvedBy(4372, prs)) =>
  shelvedCircles({ shelved, prs, rows, trackerRepo: TRACKER });

let nonEmpty = 0;
const counted = <T>(list: T[]): T[] => { if (list.length > 0) nonEmpty += 1; return list; };

test("the 2026-10-09 shape: #4372 shelved against lab#39, held, `Waiting-for: closed #4372`, `Closes: none` -> a finding naming both", () => {
  const found = counted(circlesOf([lab39()]));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].row, 4372);
  assert.equal(found[0].pr, "#39 in a11ign/lab");
  assert.match(found[0].waits, /Waiting-for: closed #4372/);
  assert.match(found[0].declared, /Closes: none/);
  const reading = shelvedCircleReading({ circles: found });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#4372.*#39 in a11ign\/lab/);
});

test("the same row shelved against an UNHELD, green PR is a real collision and not a circle", () => {
  const unheld = lab39({ labels: [] });
  assert.ok(shelvedBy(4372, [unheld]).has(4372), "B4 still shelves it: the collision is real");
  assert.deepEqual(circlesOf([unheld]), []);
  assert.equal(counted(circlesOf([lab39()])).length, 1); // the control: held, same body
});

test("a PR that declares `Closes: a11ign/a11ign#4372` is the row's own PR: B4 does not shelve the row, so there is no finding", () => {
  const own = lab39({ body: "Closes: a11ign/a11ign#4305, a11ign/a11ign#4372\n\nWaiting-for: closed #4372\n" });
  assert.equal(shelvedBy(4372, [own]).size, 0, "B4 exempts the row's own PR");
  assert.deepEqual(circlesOf([own]), []);
  assert.deepEqual(circlesOf([own], [], new Map([[4372, `overlaps #39 in ${LAB}, which already touches: x`]])), [], "and even a stale shelving line is not named");
  assert.equal(counted(circlesOf([lab39()])).length, 1);
});

test("the bare `Closes: #4305, #4372` in a layer repository's PR keeps the exemption off, and the finding says to qualify the number", () => {
  const bare = lab39({ body: "Closes: #4305, #4372\n\nWaiting-for: closed #4372\n" });
  const found = counted(circlesOf([bare]));
  assert.equal(found.length, 1);
  assert.match(found[0].declared, /bare `#4372` names a11ign\/lab's own issue.*a11ign\/a11ign#4372/);
});

test("the other routes back: a closed row's `blockedBy` edge and its `Waits-on-done-when` (a PR that is parked, not held, which B4's held-PR exemption does not cover)", () => {
  const quiet = lab39({ labels: ["parked"], body: "Closes: a11ign/a11ign#4305\n" });
  const shelved = shelvedBy(4372, [quiet], { 4305: [4372] });
  assert.ok(shelved.has(4372), "B4 shelves it: only a HELD PR is exempt");
  assert.deepEqual(circlesOf([quiet], [], shelved), [], "no route leads back, so a parked PR on the file with no wait on the row is not named");
  const edge = counted(circlesOf([quiet], [{ number: 4305, body: "", blockedBy: { nodes: [{ number: 4372 }] } }], shelved));
  assert.match(edge[0].waits, /#4305, is blockedBy #4372/);
  const done = counted(circlesOf([quiet], [{ number: 4305, body: "Waits-on-done-when: 4372.2\n" }], shelved));
  assert.match(done[0].waits, /#4305, `Waits-on-done-when: 4372\.\*`/);
});

test("parked and red PRs count as unable to merge; a shelving against another PR is not this PR's", () => {
  assert.equal(counted(circlesOf([lab39({ labels: ["parked"] })])).length, 1);
  const red = lab39({ labels: [], statusCheckRollup: [{ __typename: "CheckRun", name: "ts", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-10-09T01:00:00Z" }] });
  assert.equal(counted(circlesOf([red])).length, 1);
  assert.deepEqual(circlesOf([lab39()], [], new Map([[4372, `overlaps #390 in ${LAB}, which already touches: x`]])), [], "#390 is not #39");
});

test("the reading: a refused read is unknown, an empty list is clear, a circle is ordered to product-manager and ceo, keyed on the pair", () => {
  assert.equal(shelvedCircleReading({ circles: null }).status, "unknown");
  assert.equal(shelvedCircleReading({ circles: [] }).status, "clear");
  const circles = counted(circlesOf([lab39()]));
  const readings = orgHealthReadings({ now: Date.parse("2026-10-09T07:00:00Z"), lastMergedAt: null, work: null, redPrs: null, refusals: null, drift: null, primarySince: null, shelvedCircle: circles });
  assert.ok(readings.some((r) => r.signal === SIGNALS.SHELVED_CIRCLE && r.status === "tripped"));
  const orders = orgHealthOrders(readings).filter((o) => o.subject === SIGNALS.SHELVED_CIRCLE);
  assert.deepEqual(orders.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(orders[0].discriminator, /@4372:#39 in a11ign\/lab$/);
  assert.match(orders[0].prompt, /QUALIFIED/);
});

// --- the tick: the gate's own shelving list, read by `orgHealthNow` against the 2026-10-09 shape, and no call of its own ------------------

const NOW = Date.parse("2026-10-09T07:00:00Z");
const ROW_4372 = { number: 4372, labels: [{ name: "ready" }], blockedBy: { nodes: [] }, body: "## Region\n```\nlab:tests/a.test.ts\n```\n## Acceptance\nrun it\n## Open-check\ndone\n" };
function gateTick(pr: Pr) {
  rmSync(GH_LOG, { force: true });
  const prFile = { number: pr.number, repo: LAB, repoKey: "lab", files: ["tests/a.test.ts"], changedFiles: 1,
    closes: declaredClosedRows(pr.body, { prRepo: LAB, trackerRepo: TRACKER }), held: (pr.labels as string[]).some((l) => l.startsWith("hold:")) };
  const decideArgs = { prs: [], required: [], readyRows: [ROW_4372], prFiles: [prFile], rowBranches: [], openRows: [ROW_4372], primaryDrift: null, claimRefusals: [] };
  const orders = orgHealthNow({ prsRead: [], keyedPrsRead: [pr], readyRead: [ROW_4372], openRowsRead: [ROW_4372], decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], log: () => {}, teamAccess: () => undefined } as never) as { subject: string; session: string; prompt: string }[];
  const calls = existsSync(GH_LOG) ? readFileSync(GH_LOG, "utf8").split("\n").filter(Boolean) : [];
  return { orders: orders.filter((o) => o.subject === SIGNALS.SHELVED_CIRCLE), calls };
}

test("the gate's tick against the 2026-10-09 shape (row #4372 shelved against lab#39, `Closes: none`) orders product-manager and ceo, and the unheld PR orders nobody", () => {
  const { orders } = gateTick(lab39());
  nonEmpty += orders.length > 0 ? 1 : 0;
  assert.deepEqual(orders.map((o) => o.session).sort(), ["ceo", "product-manager"]);
  assert.match(orders[0].prompt, /row #4372 is shelved by B4 against #39 in a11ign\/lab/);
  assert.deepEqual(gateTick(lab39({ labels: [] })).orders, [], "CONTROL: the same PR unheld is a real collision");
  assert.deepEqual(gateTick(lab39({ body: "Closes: a11ign/a11ign#4372\n\nWaiting-for: closed #4372\n" })).orders, [], "CONTROL: its own PR is not shelved at all");
});

test("the gate's tick makes no `gh` call of its own for the circle", () => {
  assert.deepEqual(gateTick(lab39()).calls, []);
});

test("positive control: at least six cases above produced a non-empty list", () => {
  assert.ok(nonEmpty >= 6, `only ${nonEmpty} cases found a circle`);
});
