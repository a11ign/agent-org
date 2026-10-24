// no-token: gh -- every GitHub read this file makes is the fake code host's (A11-160, step 9): its world holds the rows of each repository, a repository marked `fail` is refused, and anything it holds nothing for is loud. Nothing here reaches GitHub.
// #4080 (row 2 of #4056): THE READY-QUEUE AUDIT READS EVERY DECLARED TRACKER, not the one `REPO` constant. Each test drives `auditTrackers` over TWO declared trackers (the home one,
// key "", and `agent-org`) with a fixture per repository, and its twin differs by ONE fact:
//   - a row that exists ONLY in the second tracker is reported (unfixed, the audit never asks that repository);
//   - the same number in both trackers stays TWO findings, named `#7` and `agent-org#7`;
//   - a read that fails on the second tracker is named, and the first tracker's findings are still counted;
//   - with ONE declared tracker the output is today's (a recorded snapshot), so the change is inert until a second is declared.
// POSITIVE CONTROL for every "not reported" assertion: the same fixture, audited as the tracker that owns the row, DOES report it (the `labelless` pair below).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as audit from "./ready-label-audit.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { holdRepository } from "./plugins/fakes/code-host-health.ts";

const HOME = "a11ign/a11ign";
const ORG = "a11ign/agent-org";

afterEach(() => forgetActivation());

/**
 * The fake code host holding `fixture`: the open rows of each repository (the home one is the world's own, the others are held beside it), and a repository marked `fail` refused (its list and its search count), as
 * `gh` refused it. The audit's stdout and stderr are captured while `body` runs.
 * @param {Record<string, { open: { number: number, title: string, labels: string[] }[], fail?: boolean }>} fixture
 */
function withFakeHost(fixture: Record<string, { open: { number: number; title: string; labels: string[]; }[]; fail?: boolean; }>, body: any) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = HOME;
  for (const [repo, held] of Object.entries(fixture)) {
    const rows = held.open.map((r) => fakeRow(world, r.number, { title: r.title, labels: [...r.labels] }));
    if (repo === HOME) rows.forEach((row) => world.rows.set(row.number, row));
    else holdRepository(world, repo, { rows });
    if (held.fail) for (const operation of ["issueListingOf", "reportedOpenIssueNumbersOf"]) world.failures.set(`${operation} ${repo}`, new Error(`HTTP 502 reading ${repo}`));
  }
  substituteCodeHost(host);
  const saved = { out: process.stdout.write, err: process.stderr.write };
  const captured = { out: "", err: "" };
  process.stdout.write = (((text: string) => { captured.out += text; return true; }) as any);
  process.stderr.write = (((text: string) => { captured.err += text; return true; }) as any);
  try {
    return { result: body(), ...captured };
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
  }
}

const TWO = { tracker: [{ key: "", repo: HOME, board: { owner: "a11ign", number: 1 } }, { key: "agent-org", repo: ORG, board: { owner: "a11ign", number: 3 } }],
  code: [{ key: "", repo: HOME }, { key: "agent-org", repo: ORG }] };
const ONE = { tracker: [TWO.tracker[0]], code: [TWO.code[0]] };

/** The two cheap checks: the open-issue mutex and the labelless-row check. Both read only the open list and the search index, which is all the fake answers. */
const CHEAP = audit.CHECKS.filter(([what]) => what === "open issues" || what === "labelless rows");

const row = (number: number, labels: string[], title = `row ${number}`) => ({ number, title, labels });

test("the control: the CHEAP population is two checks, so a test that selects it is not asserting over nothing", () => {
  assert.deepEqual(CHEAP.map(([what]) => what), ["open issues", "labelless rows"]);
});

test("a row that exists ONLY in the second tracker is reported, named in the key form", () => {
  const fixture = { [HOME]: { open: [row(1, ["ready"])] }, [ORG]: { open: [row(9, [], "only in agent-org")] } };
  const { result, out } = withFakeHost(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  agent-org#9 "only in agent-org"/);
  assert.equal(result.findings, 1);
  // The twin: the same row, audited as the home tracker's own, is found by the same check -- so the line above is the second tracker being READ, not a check that always fires.
  const own = withFakeHost({ [HOME]: { open: [row(9, [], "only in agent-org")] } }, () => audit.auditTrackers(audit.trackersOf(ONE), { checks: CHEAP }));
  assert.match(own.out, /NO LABELS  #9 "only in agent-org"/);
});

test("the same number in both trackers stays TWO findings, `#7` and `agent-org#7`", () => {
  const fixture = { [HOME]: { open: [row(7, [], "home seven")] }, [ORG]: { open: [row(7, [], "org seven")] } };
  const { result, out } = withFakeHost(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  #7 "home seven"/);
  assert.match(out, /NO LABELS  agent-org#7 "org seven"/);
  assert.equal(result.findings, 2);
});

test("a read that fails on the second tracker names that tracker, and the first tracker's findings are still counted", () => {
  const fixture = { [HOME]: { open: [row(7, [], "home seven")] }, [ORG]: { open: [], fail: true } };
  const { result, out, err } = withFakeHost(fixture, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.match(out, /NO LABELS  #7 "home seven"/);
  assert.equal(result.findings, 1);
  assert.match(err, /COULD NOT AUDIT open issues \(agent-org\)/);
  assert.match(err, /COULD NOT AUDIT labelless rows \(agent-org\)/);
  assert.deepEqual(result.refused, ["open issues (agent-org)", "labelless rows (agent-org)"]);
  // The twin: the same fixture with the second tracker healthy refuses nothing, so `refused` is the failure and not a standing value.
  const healthy = withFakeHost({ ...fixture, [ORG]: { open: [] } }, () => audit.auditTrackers(audit.trackersOf(TWO), { checks: CHEAP }));
  assert.deepEqual(healthy.result.refused, []);
});

test("a check only the primary project can answer is SAID to be skipped for the second tracker, never counted as agreeing", () => {
  const board = audit.CHECKS.filter(([what]) => what === "board membership");
  assert.equal(board.length, 1, "positive control: the check exists");
  const fixture = { [HOME]: { open: [] }, [ORG]: { open: [] } };
  const { result, out } = withFakeHost(fixture, () => audit.auditTrackers(audit.trackersOf(TWO).slice(1), { checks: board }));
  assert.match(out, /NOT RUN  board membership \(agent-org\)/);
  assert.deepEqual(result.skipped, ["board membership (agent-org)"]);
  assert.equal(result.findings, 0);
});

const SNAPSHOT = {
  out: "OK  1 of 1 open issue(s) checked, none carry `ready` with a not-pickable label\n"
    + "\n"
    + "NO LABELS  #3 \"bare\" -- carries no label at all, so it is absent from every other check in this audit, and from the Ready lane, the backlog view, the WIP count, "
    + "the dead-claim check, the hourly table and the section-backfill sweep, all of which enumerate by label\n",
  err: "\n1 row(s) carry no label at all. Add at least one -- `backlog` is the safe default, and which is right is a human judgement -- so they become visible to every check that reads this tracker.\n",
};

test("with ONE declared tracker the output is today's: no header, no key form, the same lines in the same order", () => {
  const one = withFakeHost({ [HOME]: { open: [row(3, [], "bare")] } }, () => audit.auditTrackers(audit.trackersOf(ONE), { checks: CHEAP }));
  assert.equal(one.out, SNAPSHOT.out);
  assert.equal(one.err, SNAPSHOT.err);
  assert.equal(one.result.findings, 1);
  assert.deepEqual(one.result.refused, []);
});

// --- #5076: `fetchReadyRowsWithBodies` LISTS BY A CONNECTION, NOT BY `gh issue list --label` (a GitHub SEARCH) ----------------------------------------------------------
// That the read is a connection and never a search (no `--label`, no `--search` in the argument list) is the plugin's: `plugins/github/rows/rows-by-label.ts` builds it and its tests hold it. What is held here is
// what the audit makes of the rows the code host gives it, and what it refuses.

/** The fake code host holding `rows` as the tracker's open rows (the audit reads the tracker by label). */
function holdingReadyRows(rows: { number: number; title: string; body: string | undefined; labels: string[] }[]) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  for (const row of rows) world.rows.set(row.number, fakeRow(world, row.number, { title: row.title, body: row.body as string, labels: row.labels }));
  substituteCodeHost(host);
  return world;
}

test("#5076 POSITIVE CONTROL: the ready rows with bodies come back in the `gh issue list` shape through a connection", () => {
  holdingReadyRows([
    { number: 7, title: "a row", body: "## Region\n\nsrc/a.ts\n", labels: ["ready", "lane:any"] },
    { number: 8, title: "empty body", body: "", labels: ["ready"] },
    { number: 9, title: "not ready", body: "x", labels: ["backlog"] },
  ]);
  const rows = audit.fetchReadyRowsWithBodies().sort((a, b) => a.number - b.number);
  assert.deepEqual(rows, [
    { number: 7, title: "a row", labels: ["ready", "lane:any"], body: "## Region\n\nsrc/a.ts\n" },
    { number: 8, title: "empty body", labels: ["ready"], body: "" },
  ]);
});

test("#5076 NEGATIVE CONTROL: a failed read throws the audit's own refusal, an entry with no body STRING is refused, and neither is an empty list", () => {
  const world = holdingReadyRows([]);
  world.failures.set("readRowsByLabel", new Error("HTTP 502"));
  assert.throws(() => audit.fetchReadyRowsWithBodies(), /ready-label-audit: could not list open ready rows with bodies from .* -- refusing to guess\. HTTP 502/);
  world.failures.clear();
  world.rows.set(9, fakeRow(world, 9, { title: "no body key", body: undefined as never, labels: ["ready"] }));
  assert.throws(() => audit.fetchReadyRowsWithBodies(), /missing number\/title\/labels\/body/);
  world.rows.clear();
  assert.deepEqual(audit.fetchReadyRowsWithBodies(), [], "control: a tracker with no ready row IS the empty list");
});
