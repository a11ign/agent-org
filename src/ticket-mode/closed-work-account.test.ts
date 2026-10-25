// no-token: gh -- herdr, the tracker and the clock are all injected for the pool tests; the rest is pure text
//
// A11-249 step 2: a ticket whose pull request was closed unmerged with work not on its base is briefed with that work, and its plan must say for each commit and file carried over (where) or dropped (why). The check refuses a plan
// that does not, a closed pull request that held nothing asks for no account, and the planner's, the worker's and the reviewer's texts carry the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { herdrName } from "./pool.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { ACCOUNT_HEADING, accountRefusal, accountSection, closedWorkLines, closedWorkOf, closedWorkText, type KeptClosedWork } from "./closed-work-account.ts";
import { CLOSED_PULLS_DIR, type ClosedWorkRecord } from "./closed-work.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { batchPlanBriefText, briefText, planBriefText } from "./worker-files.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const FIRST = "1234567".padEnd(40, "a");
const SECOND = "7654321".padEnd(40, "b");
const COMMITS = [{ sha: FIRST, subject: "feat(check-report): refuse unknown options" }, { sha: SECOND, subject: "test: a browser.newContext() suite and per-source rates" }];
const FILES = ["src/check-report.ts", "test/context.test.ts", ".github/workflows/ci.yml", "middleware/results/a.json", "middleware/results/b.json"];
const UNIQUE: Extract<ClosedWorkRecord, { kind: "unique" }> = { kind: "unique", number: 14, url: "https://github.com/a11ign/announcement-emulator/pull/14", base: "main", branch: "admin/a11-229-check", head: SECOND, commits: COMMITS, files: FILES, filesComplete: true, posted: true };
const NONE: ClosedWorkRecord = { kind: "none", number: 15, url: "https://github.com/a11ign/announcement-emulator/pull/15", base: "main", branch: "admin/a11-230-x", head: FIRST, posted: true };
const kept = (record: Extract<ClosedWorkRecord, { kind: "unique" }> = UNIQUE): KeptClosedWork => ({ file: `/state/tickets/NBF-1/${CLOSED_PULLS_DIR}/a11ign-announcement-emulator-${record.number}.md`, record });

/** A plan whose account is `bullets`, before its Paths. */
const plan = (bullets: string | null): string => `# Plan\n\n## Approach\n\nFit it.\n\n${bullets === null ? "" : `${ACCOUNT_HEADING}\n\n${bullets}\n\n`}## Paths\n\n- \`agent-org:src/a.ts\`\n`;

/** The bullets that account for everything `UNIQUE` held. */
const FULL = [
  "- `1234567`: carried over (the check-report option check, in step 1)",
  "- 7654321: dropped (the newContext suite is replaced by the fixture in #1900)",
  "- `src/check-report.ts`: carried over (src/check-report.ts in this pull request)",
  "- `test/context.test.ts`, `.github/workflows/ci.yml`: dropped (the board's suite does not use them)",
  "- `middleware/results/`: dropped (generated results)",
].join("\n");

test("A11-249: a plan with no Work from closed pull requests section is refused, naming the section and what it misses", () => {
  const refusal = accountRefusal([plan(null)], [kept()]) ?? "";
  assert.match(refusal, /^the plan has no "## Work from closed pull requests" section, though pull request #14 of this ticket was closed with work not on its base: it must say, for each commit and file, carried over \(where\) or dropped \(why\)\./);
  assert.ok(refusal.includes("commit 1234567 (#14)") && refusal.includes("file src/check-report.ts (#14)"), refusal);
});

test("A11-249: a plan that leaves a commit or a file out of the account is refused, naming each item it leaves out", () => {
  const withoutCommit = accountRefusal([plan(FULL.replace(/^- 7654321.*\n/m, ""))], [kept()]) ?? "";
  assert.match(withoutCommit, /does not say carried over \(where\) or dropped \(why\) for commit 7654321 \(#14\)$/);
  const withoutFile = accountRefusal([plan(FULL.replace("`test/context.test.ts`, ", ""))], [kept()]) ?? "";
  assert.match(withoutFile, /for file test\/context\.test\.ts \(#14\)$/);
});

test("A11-249: a plan that accounts for every commit and file passes, through a directory bullet too, and a short SHA of seven characters names its commit", () => {
  assert.equal(accountRefusal([plan(FULL)], [kept()]), null);
  assert.equal(accountRefusal([plan(FULL.replace("`1234567`", "`1234567aaaa`"))], [kept()]), null, "any start of the SHA from seven characters");
  assert.match(accountRefusal([plan(FULL.replace("`1234567`", "`123456`"))], [kept()]) ?? "", /commit 1234567/, "six characters name nothing");
  assert.equal(accountRefusal([plan(FULL.replace("`middleware/results/`", "`middleware/`"))], [kept()]), null, "a directory above the files covers them");
  assert.match(accountRefusal([plan(FULL.replace("`middleware/results/`", "`middleware/res/`"))], [kept()]) ?? "", /file middleware\/results\/a\.json \(#14\), file middleware\/results\/b\.json \(#14\)$/, "a directory that is not above them covers none");
});

test("A11-249: a bullet counts only when it names the item before its verdict and says where or why after it", () => {
  const bare = accountRefusal([plan(FULL.replace("dropped (generated results)", "dropped"))], [kept()]) ?? "";
  assert.ok(bare.includes("file middleware/results/a.json"), "a verdict with nothing after it says nothing");
  const noVerdict = accountRefusal([plan(FULL.replace("- 7654321: dropped (the newContext suite is replaced by the fixture in #1900)", "- 7654321: the newContext suite"))], [kept()]) ?? "";
  assert.ok(noVerdict.includes("commit 7654321"), "a bullet with no verdict says nothing");
  const named = accountRefusal([plan(FULL.replace("- 7654321: dropped (the newContext suite is replaced by the fixture in #1900)", "- `1234567`: carried over (with 7654321 and src/check-report.ts)"))], [kept()]) ?? "";
  assert.ok(named.includes("commit 7654321"), "an item named only in the where is not accounted");
});

test("A11-249: the verdict may be bold, a bullet may wrap, a star is a bullet, and the section is read in any one of the plan's files and ends at the next heading", () => {
  const wrapped = ["* `1234567`: **carried over**\n  (the check-report option check, in step 1)", "* 7654321: **dropped** (replaced)", "* `src/check-report.ts`, `test/context.test.ts`, `.github/workflows/ci.yml`, `middleware/results/`: **dropped**\n  because the board's suite does not use them"].join("\n");
  assert.equal(accountRefusal(["# Notes\n", plan(wrapped)], [kept()]), null);
  const after = `${plan(FULL.replace(/^- 7654321.*\n/m, ""))}\n## Notes\n\n- 7654321: dropped (this note is not the account)\n`;
  assert.match(accountRefusal([after], [kept()]) ?? "", /commit 7654321/, "a bullet under another heading is not in the section");
  assert.equal(accountSection("## Approach\n\nx\n"), null);
});

test("A11-249: a ticket whose closed pull requests held nothing has no record to account for: the account is not asked for", () => {
  assert.equal(accountRefusal([plan(null)], []), null);
});

test("A11-249: a long list of items is named in part, with a count of the rest", () => {
  const many = { ...UNIQUE, files: Array.from({ length: 40 }, (_, i) => `results/f${i}.json`), commits: [] };
  const refusal = accountRefusal([plan(null)], [kept(many)]) ?? "";
  assert.ok(refusal.endsWith("file results/f11.json (#14) and 28 more"), refusal);
});

/** A ticket folder holding the records `files` (name to text) under `closed-pulls`. */
function folderWith(files: Record<string, string>): string {
  const dir = tmpDir("closed-account-");
  mkdirSync(join(dir, CLOSED_PULLS_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, CLOSED_PULLS_DIR, name), text);
  return dir;
}

test("A11-249: the ticket's records are read from its folder: unique ones only, oldest pull request first, each with its list file, and a record that cannot be read is skipped", () => {
  const dir = folderWith({ "a-b-15.json": JSON.stringify(NONE), "a-b-14.json": JSON.stringify(UNIQUE), "a-b-9.json": JSON.stringify({ ...UNIQUE, number: 9 }), "a-b-3.json": "{ not json", "a-b-4.json": JSON.stringify({ kind: "unique", number: 4 }), "a-b-14.md": "# list" });
  assert.deepEqual(closedWorkOf(dir).map(({ file, record }) => [file.slice(dir.length), record.number]), [[`/${CLOSED_PULLS_DIR}/a-b-9.md`, 9], [`/${CLOSED_PULLS_DIR}/a-b-14.md`, 14]]);
  assert.deepEqual(closedWorkOf(join(dir, "nowhere")), []);
});

test("A11-249: the planner's section names each list file, branch, fetch line and commit, and gives the form the check accepts; the pull request's says its body carries the section", () => {
  const planner = closedWorkText([kept()], "plan");
  for (const named of ["## Work from closed pull requests", "a11ign-announcement-emulator-14.md", "admin/a11-229-check", "git fetch origin pull/14/head", FIRST, "refuse unknown options", SECOND, "is refused", "```markdown\n## Work from closed pull requests\n\n- `1234567`: carried over"]) {
    assert.ok(planner.includes(named), `the planner's section names ${named}: ${planner}`);
  }
  const worker = closedWorkText([kept()], "pull request");
  assert.ok(worker.includes("a11ign-announcement-emulator-14.md") && worker.includes("Your pull request body carries the same section") && worker.includes("is a finding"), worker);
  assert.ok(!worker.includes("```markdown"), "the form is the planner's");
  assert.equal(closedWorkText([], "plan"), "");
});

test("A11-249: the reviewer's list has a line for each commit and file, says when the files are a part, and is null for a ticket with none", () => {
  const lines = closedWorkLines([kept({ ...UNIQUE, filesComplete: false })]) ?? "";
  assert.ok(lines.startsWith("Closed pull request #14 (https://github.com/a11ign/announcement-emulator/pull/14), branch admin/a11-229-check, work not on main:"), lines);
  for (const named of [`- commit ${FIRST} feat(check-report): refuse unknown options`, `- commit ${SECOND}`, "- file src/check-report.ts", "- file middleware/results/b.json", "stopped at its file cap"]) assert.ok(lines.includes(named), named);
  assert.equal(closedWorkLines([]), null);
});

const TICKET = { key: "NBF-1", title: "Fit it", url: "https://linear.app/x/NBF-1", description: "", branch: "b", labels: [] } as never;

test("A11-249: the planning briefs, single and batch, and the worker's brief carry the closed work section; one without closed work does not", () => {
  const plain = planBriefText({ ticket: TICKET, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}" });
  const given = planBriefText({ ticket: TICKET, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones: { a: "/a" }, run: "plan {key} into {dir}", closed: [kept()] });
  assert.ok(!plain.includes("Work from closed pull requests"));
  assert.ok(given.includes("## Work from closed pull requests") && given.includes("a11ign-announcement-emulator-14.md"));
  const batch = batchPlanBriefText({ tickets: [{ ticket: TICKET, attachments: [], parent: null, closed: [kept()] }], runDir: "/d", planDir: "/d/plan", clones: { a: "/a" }, run: "plan {keys} into {dir}" });
  assert.ok(batch.includes("### Work from closed pull requests") && batch.includes("a11ign-announcement-emulator-14.md"), "under the ticket's own heading");
  const work = briefText({ ticket: TICKET, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "pr:open", closed: [kept()] });
  assert.ok(work.includes("## Work from closed pull requests") && work.includes("Your pull request body carries the same section"));
  assert.ok(!briefText({ ticket: TICKET, folder: "/f", ticketDir: "/d", attachments: [], clones: { a: "/a" }, worktreeCommand: "wt", prOpenCommand: "pr:open" }).includes("Work from closed pull requests"));
});

// Through the pool: a planning run of NBF-1, whose folder holds the records the board kept, ends on a plan.
const fake = createFakeTracker();
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** Write a record the board's sweep would have, under the ticket's folder. */
function keep(dir: string, record: ClosedWorkRecord): void {
  mkdirSync(join(dir, CLOSED_PULLS_DIR), { recursive: true });
  writeFileSync(join(dir, CLOSED_PULLS_DIR, `a11ign-announcement-emulator-${record.number}.json`), JSON.stringify(record));
  writeFileSync(join(dir, CLOSED_PULLS_DIR, `a11ign-announcement-emulator-${record.number}.md`), `# Closed pull request #${record.number}\n`);
}

/** A pool with NBF-1 started as a planning run, `records` kept in its folder first, and a tracker that records what it is asked to attach. */
async function planning(...records: ClosedWorkRecord[]) {
  const attached: string[] = [];
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, keywords: fake.keywords, download: fake.download, attachPlan: async (key) => { attached.push(key); return null; } };
  const made = poolFixture({ keys: ["NBF-1"], max: 1, source, planFirst: ["NBF-1"], tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } } });
  const dir = ticketDir(made.settings, "NBF-1");
  for (const record of records) keep(dir, record);
  await made.pool.tick();
  const end = async (text: string) => {
    writeFileSync(join(dir, "plan", "NBF-1-0001-plan-answer.md"), text);
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
    made.status.set(herdrName("NBF-1"), "idle");
    await made.pool.tick();
    await settled();
    return { outcome: made.entry("NBF-1").outcome, reason: reasonOf(made.entry("NBF-1").outcome), attached };
  };
  return { made, dir, end, brief: () => readFileSync(join(dir, "brief.md"), "utf8") };
}

test("A11-249: a plan with no account for a closed pull request's work is refused needs-human with the refusal, and nothing is attached", async () => {
  const run = await planning(UNIQUE);
  const refused = await run.end(plan(null));
  assert.equal(refused.outcome?.kind, "needs-human");
  assert.match(refused.reason, /^the plan has no "## Work from closed pull requests" section, though pull request #14 of this ticket was closed with work not on its base/);
  assert.deepEqual(refused.attached, []);
  const partial = await (await planning(UNIQUE)).end(plan(FULL.replace(/^- 7654321.*\n/m, "")));
  assert.match(partial.reason, /does not say carried over \(where\) or dropped \(why\) for commit 7654321 \(#14\)$/);
  assert.deepEqual(partial.attached, []);
});

test("A11-249: a plan that accounts for every commit and file is attached, and so is any plan when the closed pull request held nothing", async () => {
  const accounted = await (await planning(UNIQUE)).end(plan(FULL));
  assert.deepEqual([accounted.outcome, accounted.attached], [undefined, ["NBF-1"]]);
  const none = await (await planning(NONE)).end(plan(null));
  assert.deepEqual([none.outcome, none.attached], [undefined, ["NBF-1"]]);
});

test("A11-249: the planner's brief names the record's list file, and a worker's brief for the same ticket does too", async () => {
  const run = await planning(UNIQUE, NONE);
  const brief = run.brief();
  assert.ok(brief.includes(join(run.dir, CLOSED_PULLS_DIR, "a11ign-announcement-emulator-14.md")) && brief.includes(FIRST), "the planner is given the list");
  assert.ok(!brief.includes("a11ign-announcement-emulator-15.md"), "a pull request that held nothing is not listed");
  const worked = poolFixture({ keys: ["NBF-1"], max: 1 });
  const folder = ticketDir(worked.settings, "NBF-1");
  keep(folder, UNIQUE);
  await worked.pool.tick();
  const workerBrief = readFileSync(join(folder, "brief.md"), "utf8");
  assert.ok(workerBrief.includes(join(folder, CLOSED_PULLS_DIR, "a11ign-announcement-emulator-14.md")) && workerBrief.includes("Your pull request body carries the same section"), "the worker is given the list and the rule for its body");
});
