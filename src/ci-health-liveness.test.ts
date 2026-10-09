// no-token: GRACE_HOURS -- every `gh` call in this file is an injected fake or a thrown error; the live reads are run by hand and pasted on the pull request
// a11ign/a11ign#3659: did ci-health.yml's Monday comment arrive? Pure cases over injected run and comment lists, no network, and one
// read-only look at the project's own script.
//
// POSITIVE CONTROLS (the vacuity failure from both sides): every "no order" assertion has a twin that DOES order, so `ciHealthOrders` is
// not vacuous; `NO COMMENT` and `SILENT` each have a case a function returning `PRESENT` would turn RED on; and the project-script pin
// names its own skip and asserts it did not skip when the host names a checkout that has the script. Mutations, both directions, are
// pasted in the pull request.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GRACE_HOURS, VERDICT, ciHealthLiveness, ciHealthOrders, declarationFrom, headingForRun, latestSlot, readCiHealth, readingLine, slotFromWorkflow,
} from "./ci-health-liveness.ts";
import * as everyTracker from "./ci-health-liveness.ts"; // the readers #4080 adds, by namespace so a run without them fails each test and not the file's import
import { homeHostConfig } from "./host-config.ts";

const MONDAY_SLOT = { minute: 43, hour: 6, weekday: 1 };
const SLOT_AT = "2026-10-05T06:43:00.000Z";
const GRACE_ENDS = "2026-10-05T12:43:00.000Z";
const HEADING = "## CI health, week of 2026-09-28";
const SCHEDULE_RUN = { id: 37_200_000_001, event: "schedule", created_at: "2026-10-05T07:10:12Z", conclusion: "success" };
const DISPATCH_RUN = { id: 37_124_395_988, event: "workflow_dispatch", created_at: "2026-10-03T12:54:25Z", conclusion: "success" };
const COMMENT = `${HEADING}\n\nWindow: runs of \`ci.yml\` created from 2026-09-28T00:00:00Z to 2026-10-05T00:00:00Z`;
const AFTER_GRACE = new Date("2026-10-05T14:00:00Z");

/** @param {Partial<Parameters<typeof ciHealthLiveness>[0]>} over */
const read = (over: Partial<Parameters<typeof ciHealthLiveness>[0]>) => ciHealthLiveness({ now: AFTER_GRACE, slot: MONDAY_SLOT, runs: [], comments: [], workflowState: "active", ...over });

test("the grace is six hours, the row's floor from #965's five-hour lateness", () => {
  assert.equal(GRACE_HOURS, 6);
  assert.equal(read({}).graceEndsAt, GRACE_ENDS);
});

test("PRESENT: the week's schedule run and its comment both exist", () => {
  const reading = read({ runs: [DISPATCH_RUN, SCHEDULE_RUN], comments: [COMMENT] });
  assert.equal(reading.verdict, VERDICT.PRESENT);
  assert.equal(reading.runId, SCHEDULE_RUN.id);
  assert.equal(reading.heading, HEADING);
});

test("NOT YET: one minute before the grace ends, with nothing there yet", () => {
  const reading = read({ now: new Date("2026-10-05T12:42:00Z") });
  assert.equal(reading.verdict, VERDICT.NOT_YET);
  assert.equal(reading.slotAt, SLOT_AT);
});

test("the grace's own minute is SILENT: NOT YET ends AT the grace, not a minute after", () => {
  assert.equal(read({ now: new Date(GRACE_ENDS) }).verdict, VERDICT.SILENT);
});

test("NOT YET also covers a run whose comment is still on its way, and PRESENT does not wait for the grace", () => {
  const early = new Date("2026-10-05T07:30:00Z");
  assert.equal(read({ now: early, runs: [SCHEDULE_RUN] }).verdict, VERDICT.NOT_YET);
  assert.equal(read({ now: early, runs: [SCHEDULE_RUN], comments: [COMMENT] }).verdict, VERDICT.PRESENT);
});

test("SILENT: grace passed, no schedule run, and the workflow's state is printed beside it", () => {
  const reading = read({ runs: [DISPATCH_RUN], workflowState: "disabled_inactivity" });
  assert.equal(reading.verdict, VERDICT.SILENT);
  assert.notEqual(reading.verdict, VERDICT.PRESENT);
  assert.match(reading.detail, /workflow state: disabled_inactivity/);
});

test("SILENT, never PRESENT: a comment with the right heading but no schedule run behind it (a dispatch posted it)", () => {
  const reading = read({ runs: [DISPATCH_RUN], comments: [COMMENT] });
  assert.equal(reading.verdict, VERDICT.SILENT);
  assert.match(reading.detail, /a CI-health comment exists, but no `schedule` run produced one/);
});

test("a dispatch run INSIDE the slot's week is not a schedule run: the Monday comment must come from the schedule", () => {
  const dispatchedMonday = { ...DISPATCH_RUN, id: 2, created_at: "2026-10-05T08:00:00Z" };
  assert.equal(read({ runs: [dispatchedMonday], comments: [COMMENT] }).verdict, VERDICT.SILENT);
});

test("a schedule run of an EARLIER week is not this slot's run", () => {
  const lastWeek = { ...SCHEDULE_RUN, id: 1, created_at: "2026-09-28T07:00:00Z" };
  assert.equal(read({ runs: [lastWeek], comments: ["## CI health, week of 2026-09-21"] }).verdict, VERDICT.SILENT);
});

test("NO COMMENT: a schedule run and no comment (the positive control: a function returning PRESENT here is RED)", () => {
  const reading = read({ runs: [SCHEDULE_RUN], comments: [] });
  assert.equal(reading.verdict, VERDICT.NO_COMMENT);
  assert.notEqual(reading.verdict, VERDICT.PRESENT);
  assert.match(reading.detail, /37200000001/);
});

test("NO COMMENT, not PRESENT: another week's heading is not this week's comment", () => {
  const dispatchWeek = "## CI health, week of 2026-09-26\n\n...";
  assert.equal(read({ runs: [SCHEDULE_RUN], comments: [dispatchWeek] }).verdict, VERDICT.NO_COMMENT);
});

test("a run GitHub delayed past midnight is looked for under the heading its own day would write", () => {
  const lateRun = { ...SCHEDULE_RUN, created_at: "2026-10-06T01:00:00Z" };
  assert.equal(headingForRun(lateRun.created_at), "## CI health, week of 2026-09-29");
  const now = new Date("2026-10-06T03:00:00Z");
  assert.equal(read({ now, runs: [lateRun], comments: ["## CI health, week of 2026-09-29"] }).verdict, VERDICT.PRESENT);
  assert.equal(read({ now, runs: [lateRun], comments: [COMMENT] }).verdict, VERDICT.NO_COMMENT);
});

test("CANNOT TELL: a null list, whichever one, is never read as healthy", () => {
  for (const [name, over] of [["runs", { runs: null }], ["comments", { comments: null }], ["slot", { slot: null }]]) {
    const reading = read({ runs: [SCHEDULE_RUN], comments: [COMMENT], ...over });
    assert.equal(reading.verdict, VERDICT.CANNOT_TELL, name);
    assert.match(reading.detail, /INCONCLUSIVE, not healthy/, name);
  }
  assert.equal(read({ runs: null, comments: null }).verdict, VERDICT.CANNOT_TELL);
});

test("CANNOT TELL names the lookup that failed, and a null list inside the grace is still CANNOT TELL", () => {
  const reading = read({ now: new Date("2026-10-05T08:00:00Z"), runs: null, comments: [COMMENT] });
  assert.equal(reading.verdict, VERDICT.CANNOT_TELL);
  assert.match(reading.detail, /schedule` runs/);
});

test("a rate limit (every gh call throws) reads CANNOT TELL, end to end through the reads", () => {
  const limited = () => { throw new Error("HTTP 403: API rate limit exceeded"); };
  const reading = readCiHealth({ declared: { repo: "a11ign/a11ign", workflow: "ci-health.yml", issue: 928 } }, AFTER_GRACE, { gh: limited });
  assert.equal(reading.verdict, VERDICT.CANNOT_TELL);
  assert.match(reading.detail, /rate limit exceeded/);
  assert.deepEqual(ciHealthOrders(reading), []);
});

test("the reads ask GitHub for schedule runs and for comments since the slot, and the verdict follows their answers", () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const url = args.find((a) => a.startsWith("repos/")) ?? "";
    if (url.includes("/contents/")) return 'on:\n  schedule:\n    - cron: "43 6 * * 1"\n  workflow_dispatch:\n';
    if (url.endsWith("/actions/workflows/ci-health.yml")) return JSON.stringify({ state: "active", path: ".github/workflows/ci-health.yml" });
    if (url.includes("/runs?")) return JSON.stringify({ workflow_runs: [SCHEDULE_RUN] });
    if (url.includes("/comments?")) return JSON.stringify([[{ body: COMMENT }]]);
    throw new Error(`unexpected ${url}`);
  };
  const reading = readCiHealth({ declared: { repo: "a11ign/a11ign", workflow: "ci-health.yml", issue: 928 } }, AFTER_GRACE, { gh });
  assert.equal(reading.verdict, VERDICT.PRESENT);
  assert.ok(calls.some((a) => a.some((x) => x.includes("/runs?event=schedule"))));
  assert.ok(calls.some((a) => a.some((x) => x.includes("issues/928/comments") && x.includes("since=2026-10-05T06:43:00Z"))));
});

test("the cron is read from the workflow file: exactly one plain `m h * * d`, else no slot", () => {
  assert.deepEqual(slotFromWorkflow('on:\n  schedule:\n    # note\n    - cron: "43 6 * * 1"\n'), MONDAY_SLOT);
  assert.deepEqual(slotFromWorkflow("  - cron: '0 7 * * 0'"), { minute: 0, hour: 7, weekday: 0 });
  assert.equal((slotFromWorkflow("  - cron: '0 7 * * 7'").weekday as any), 0);
  for (const text of ["on:\n  workflow_dispatch:\n", '- cron: "17 6 * * *"', '- cron: "*/5 * * * 1"', '- cron: "43 6 * * 1"\n- cron: "13 7 * * 1"', '- cron: "61 6 * * 1"', '- cron: "43 6 * * 8"']) {
    assert.equal(slotFromWorkflow(text), null, text);
  }
});

test("the latest slot is the Monday 06:43 at or before now", () => {
  assert.equal(latestSlot(new Date("2026-10-05T14:00:00Z"), MONDAY_SLOT).toISOString(), SLOT_AT);
  assert.equal(latestSlot(new Date(SLOT_AT), MONDAY_SLOT).toISOString(), SLOT_AT);
  assert.equal(latestSlot(new Date("2026-10-05T06:42:00Z"), MONDAY_SLOT).toISOString(), "2026-09-28T06:43:00.000Z");
  assert.equal(latestSlot(new Date("2026-10-04T23:00:00Z"), MONDAY_SLOT).toISOString(), "2026-09-28T06:43:00.000Z");
});

test("the gate's offer: SILENT and NO COMMENT each order product-manager once, keyed on slot and verdict", () => {
  const silent = ciHealthOrders(read({ runs: [DISPATCH_RUN] }));
  const noComment = ciHealthOrders(read({ runs: [SCHEDULE_RUN] }));
  assert.equal(silent.length, 1);
  assert.equal(noComment.length, 1);
  assert.equal(silent[0].session, "product-manager");
  assert.equal(silent[0].causeKey, `product-manager/ci-health-missing/${SLOT_AT}/silent`);
  assert.equal(noComment[0].causeKey, `product-manager/ci-health-missing/${SLOT_AT}/no-comment`);
  assert.deepEqual(ciHealthOrders(read({ runs: [DISPATCH_RUN] })), silent);
  assert.match(silent[0].prompt, /the `schedule` run is missing \(SILENT\)/);
  assert.match(noComment[0].prompt, /the comment on the report issue is missing \(NO COMMENT\)/);
});

test("no order for PRESENT, NOT YET or CANNOT TELL", () => {
  assert.deepEqual(ciHealthOrders(read({ runs: [SCHEDULE_RUN], comments: [COMMENT] })), []);
  assert.deepEqual(ciHealthOrders(read({ now: new Date("2026-10-05T12:42:00Z") })), []);
  assert.deepEqual(ciHealthOrders(read({ runs: null })), []);
});

test("the line the gate prints for a SILENT week", () => {
  const line = readingLine(read({ runs: [DISPATCH_RUN] }));
  assert.equal(line, "ci-health liveness: SILENT -- slot 2026-10-05T06:43:00.000Z: no `schedule` run of the 2026-10-05T06:43:00.000Z slot, 6 h grace over (workflow state: active)");
});

test("the declaration names the workflow and the issue beside each tracker's repo, and refuses what is absent or malformed", () => {
  const good = { tracker: [{ repo: "a11ign/a11ign" }], units: { ciHealthWorkflow: "ci-health.yml", ciHealthIssue: 928 } };
  assert.deepEqual(declarationFrom(JSON.stringify(good)), { declared: [{ key: "", repo: "a11ign/a11ign", workflow: "ci-health.yml", issue: 928 }] });
  const refused = [
    [{ ...good, tracker: [] }, /`repo` for every entry of `tracker`/],
    [{ ...good, tracker: [{ repo: "a11ign/a11ign" }, { key: "agent-org" }] }, /`repo` for every entry of `tracker`/],
    [{ ...good, units: { ciHealthIssue: 928 } }, /units\.ciHealthWorkflow/],
    [{ ...good, units: { ciHealthWorkflow: "ci-health.yml" } }, /units\.ciHealthIssue/],
    [{ ...good, units: { ciHealthWorkflow: "ci-health.yml", ciHealthIssue: "928" } }, /units\.ciHealthIssue/],
    [{ ...good, units: { ciHealthWorkflow: "ci-health.yml", ciHealthIssue: 0 } }, /units\.ciHealthIssue/],
  ];
  for (const [declaration, why] of refused) {
    const result = declarationFrom(JSON.stringify(declaration));
    assert.ok("refusal" in result && (why as any).test(result.refusal), JSON.stringify(declaration));
  }
  assert.ok("refusal" in declarationFrom("{not json"));
  assert.equal(readCiHealth({ refusal: "the project declaration (it does not declare units.ciHealthIssue)" }, AFTER_GRACE).verdict, VERDICT.CANNOT_TELL);
});

// ---- the pin against the project's own script --------------------------------------------------------------------------------------
// The heading rule is DERIVED from `scripts/ci-health.mjs`, so a change to it there must not leave this module looking for a heading
// nobody writes. Read as TEXT (importing it would need that project's node_modules). A host naming no checkout with the script is a
// skip that says so; the second test asserts the skip is not the ordinary case.

const SCRIPT = (() => {
  try {
    const host = homeHostConfig();
    const checkout = host.projects.find((p) => p.id === host.primary)?.checkout;
    const path = checkout ? join(checkout, "scripts", "ci-health.mjs") : null;
    return path !== null && existsSync(path) ? { path, text: readFileSync(path, "utf8") } : null;
  } catch {
    return null;
  }
})();

test("the heading, the seven-day window and the already-posted rule are still the script's", { skip: SCRIPT === null ? "the host names no primary checkout with scripts/ci-health.mjs" : false }, () => {
  assert.ok(SCRIPT);
  assert.match(SCRIPT.text, /commentHeading = \(\{ date \}\) => `## CI health, week of \$\{date\}`/);
  assert.match(SCRIPT.text, /const WINDOW_DAYS = 7;/);
  assert.match(SCRIPT.text, /alreadyPosted = \(commentBodies, heading\) => commentBodies\.some\(\(body\) => body\.startsWith\(heading\)\)/);
  assert.match(SCRIPT.text, /const date = window\.since\.slice\(0, "YYYY-MM-DD"\.length\);/);
});

test("the script pin RAN: under the acceptance command's AGENT_ORG_HOST the project's script is found", { skip: process.env.AGENT_ORG_HOST ? false : "AGENT_ORG_HOST is unset, so the pin above may legitimately skip" }, () => {
  assert.ok(SCRIPT, "AGENT_ORG_HOST is set but its primary checkout has no scripts/ci-health.mjs: the pin above skipped");
});

// ---- #4080: every declared tracker is read, not the first -----------------------------------------------------------------------------------
const TWO_TRACKERS = { tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }], units: { ciHealthWorkflow: "ci-health.yml", ciHealthIssue: 928 } };

/** A `gh` that answers per repository: `answers[repo]` is `"present"`, `"silent"` (no run), or `"refused"` (every call throws). A repository not listed has no workflow, as a tracker without one does. */
const ghPerRepo = (answers: Record<string, string>) => (args: string[]) => {
  const url = args.find((a) => a.startsWith("repos/")) ?? "";
  const mode = answers[url.split("/").slice(1, 3).join("/")];
  if (mode === undefined) throw new Error(`HTTP 404: Not Found (${url})`);
  if (mode === "refused") throw new Error("HTTP 403: API rate limit exceeded");
  if (url.includes("/contents/")) return 'on:\n  schedule:\n    - cron: "43 6 * * 1"\n';
  if (url.endsWith("/actions/workflows/ci-health.yml")) return JSON.stringify({ state: "active", path: ".github/workflows/ci-health.yml" });
  if (url.includes("/runs?")) return JSON.stringify({ workflow_runs: mode === "present" ? [SCHEDULE_RUN] : [] });
  if (url.includes("/comments?")) return JSON.stringify([mode === "present" ? [{ body: COMMENT }] : []]);
  throw new Error(`unexpected ${url}`);
};

test("#4080: the declaration yields one lookup per tracker, the second tracker's repository among them", () => {
  const result = declarationFrom(JSON.stringify(TWO_TRACKERS));
  assert.ok("declared" in result);
  assert.deepEqual(result.declared.map((d) => [d.key, d.repo, d.issue]), [["", "a11ign/a11ign", 928], ["agent-org", "a11ign/agent-org", 928]]);
});

test("#4080: a report that exists ONLY in the second tracker's repository is found there", () => {
  const where = declarationFrom(JSON.stringify(TWO_TRACKERS));
  const readings = everyTracker.readCiHealthAll(where, AFTER_GRACE, { gh: ghPerRepo({ "a11ign/a11ign": "silent", "a11ign/agent-org": "present" }) });
  assert.deepEqual(readings.map((r) => [r.repo, r.reading.verdict]), [["a11ign/a11ign", VERDICT.SILENT], ["a11ign/agent-org", VERDICT.PRESENT]]);
});

test("#4080: the same issue number in both trackers stays two questions, told apart by repository in the line and in the order's key", () => {
  const where = declarationFrom(JSON.stringify(TWO_TRACKERS));
  const readings = everyTracker.readCiHealthAll(where, AFTER_GRACE, { gh: ghPerRepo({ "a11ign/a11ign": "silent", "a11ign/agent-org": "silent" }) });
  const lines = readings.map(({ repo, reading }) => readingLine(reading, repo));
  assert.match(lines[0], /^ci-health liveness \(a11ign\/a11ign\): SILENT/);
  assert.match(lines[1], /^ci-health liveness \(a11ign\/agent-org\): SILENT/);
  const keys = readings.flatMap(({ repo, reading }) => ciHealthOrders(reading, repo).map((o) => o.causeKey));
  assert.equal(new Set(keys).size, 2, "a miss in each tracker is its own order");
});

test("#4080: a lookup refused on the second tracker names that tracker, and the first tracker's reading is still reported", () => {
  const where = declarationFrom(JSON.stringify(TWO_TRACKERS));
  const readings = everyTracker.readCiHealthAll(where, AFTER_GRACE, { gh: ghPerRepo({ "a11ign/a11ign": "present", "a11ign/agent-org": "refused" }) });
  assert.equal(readings[0].reading.verdict, VERDICT.PRESENT);
  assert.equal(readings[1].repo, "a11ign/agent-org");
  assert.equal(readings[1].reading.verdict, VERDICT.CANNOT_TELL);
  assert.match(readings[1].reading.detail, /rate limit exceeded/);
  assert.equal(everyTracker.exitFor(readings.map((r) => r.reading)), 2, "one tracker PRESENT does not excuse the other's CANNOT TELL");
});

test("#4080: the exit is the most alarming reading: a finding, then CANNOT TELL, then NOT YET, and only all PRESENT is 0", () => {
  const exit = (...verdicts: string[]) => everyTracker.exitFor(verdicts.map((verdict) => ({ ...read({}), verdict })));
  assert.equal(exit(VERDICT.PRESENT), 0);
  assert.equal(exit(VERDICT.PRESENT, VERDICT.NOT_YET), 3);
  assert.equal(exit(VERDICT.NOT_YET, VERDICT.CANNOT_TELL), 2);
  assert.equal(exit(VERDICT.CANNOT_TELL, VERDICT.SILENT), 1);
  assert.equal(exit(VERDICT.PRESENT, VERDICT.NO_COMMENT), 1);
});

test("#4080: with ONE declared tracker the reading, the line and the order are the ones they were before", () => {
  const where = declarationFrom(JSON.stringify({ ...TWO_TRACKERS, tracker: [TWO_TRACKERS.tracker[0]] }));
  const gh = ghPerRepo({ "a11ign/a11ign": "silent" });
  const all = everyTracker.readCiHealthAll(where, AFTER_GRACE, { gh });
  assert.ok("declared" in where);
  assert.deepEqual(all.map((r) => r.reading), [readCiHealth({ declared: where.declared[0] }, AFTER_GRACE, { gh })]);
  const single = all[0].reading;
  assert.match(readingLine(single), /^ci-health liveness: SILENT -- slot /, "no repository in the line when there is nothing to tell apart");
  assert.equal(ciHealthOrders(single)[0].causeKey, "product-manager/ci-health-missing/2026-10-05T06:43:00.000Z/silent", "the key is unchanged");
  assert.equal(everyTracker.exitFor([single]), 1);
});
