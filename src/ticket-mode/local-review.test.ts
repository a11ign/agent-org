// no-token: none -- git, the reviewer and the clock are injected fakes, the pool's herdr and code host are the fixture's; nothing is spawned and nothing reaches GitHub
// A11-440: on a machine with `tickets.localReview: true`, a worker runs the reviewer on its local diff before its pull request opens, `pr:open` refuses a create until a review ran at the
// worker's current commit, and the board's own review of each new head still runs. Off, the default, changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { LOCAL_REVIEW_FILE, LOCAL_REVIEW_RECORD_FILE, localReviewCheck, localReviewStep, readLocalReviews, type LocalReviewRecord } from "./local-review-record.ts";
import { LOCAL_REVIEW_DIR, localBaseOf, localReviewPrompt, runLocalReview, type LocalReviewDeps } from "./local-review.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { loadReviewerGate } from "./reviewer-port.ts";
import { parseTicketSettings, TicketSettingsRefusal } from "./settings.ts";
import { ticketDir } from "./ticket-paths.ts";
import { BRIEF_FILE } from "./worker-files.ts";
import { SCHEMA } from "./config-schema.ts";

const HEAD = "c0ffee12".padEnd(40, "0");
const LATER = "deadbeef".padEnd(40, "0");
const TREE = "/work/.tickets/A11-440/agent-org";
const BASE = "origin/main";
const KEY = "A11-440";
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

const record = (over: Partial<LocalReviewRecord> = {}): LocalReviewRecord => ({ head: HEAD, base: BASE, verdict: "convinced", at: "2026-11-14T00:00:00.000Z", review: "/r.md", ...over });

test("A11-440: tickets.localReview is off unless it is true, any other value is refused by name, and the schema documents it as off by default", () => {
  const clones = { "agent-org": TREE };
  assert.equal(parseTicketSettings({ clones }).localReview, false);
  assert.equal(parseTicketSettings({ clones, tickets: { localReview: true } }).localReview, true);
  assert.throws(() => parseTicketSettings({ clones, tickets: { localReview: "yes" } }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.localReview");
  const entry = SCHEMA.find(({ key }) => key === "tickets.localReview");
  assert.equal(entry?.default, "false");
});

test("A11-440: pr:open's check refuses a create with no review or a review of an earlier commit, and passes a convinced one at this commit", () => {
  const facts = { head: HEAD, base: BASE, body: "Closes A11-440\n", key: KEY };
  assert.match(localReviewCheck({ ...facts, record: null }).refusal ?? "", /no review of this tree ran for A11-440\. Run `agent-org ticket:review-local`.*Nothing was sent to GitHub/);
  assert.match(localReviewCheck({ ...facts, record: record({ head: LATER }) }).refusal ?? "", /last local review of this tree was at deadbeef, and it is now at c0ffee12/);
  assert.deepEqual(localReviewCheck({ ...facts, record: record() }), { refusal: null, note: "LOCAL-REVIEW: convinced at c0ffee12" });
  assert.match(localReviewCheck({ ...facts, record: record(), head: null }).refusal ?? "", /commit could not be read/);
  assert.match(localReviewCheck({ ...facts, record: record({ base: "origin/feature" }) }).refusal ?? "", /read the diff against origin\/feature, and this pull request's diff is against origin\/main/,
    "a review against another base read another diff");
});

test("A11-440: a review that was not convinced refuses the create whatever the body says; one with no verdict passes only when the body says so under ## Local review", () => {
  const facts = { head: HEAD, base: BASE, key: KEY };
  const blocked = record({ verdict: "not convinced" });
  assert.match(localReviewCheck({ ...facts, record: blocked, body: "Closes A11-440\n" }).refusal ?? "", /was not convinced \(its findings: \/r\.md\)\. Fix each blocking finding/);
  assert.match(localReviewCheck({ ...facts, record: blocked, body: "Closes A11-440\n\n## Local review\n\nFinding 2 is wrong: the test exists.\n" }).refusal ?? "", /was not convinced/,
    "a section in the body does not lift a blocking finding: it is fixed before the pull request opens");
  const failed = record({ verdict: null, review: null, problem: "the reviewer could not run: codex: not found" });
  assert.match(localReviewCheck({ ...facts, record: failed, body: "Closes A11-440\n" }).refusal ?? "", /gave no verdict \(the reviewer could not run: codex: not found\).*say there that the reviewer could not run/);
  assert.match(localReviewCheck({ ...facts, record: failed, body: "## Local review\n\nCodex was not on this host.\n" }).note ?? "", /no verdict at c0ffee12 \(the reviewer could not run: codex: not found\); the body's `## Local review` section says so/);
});

/** A worktree's `git`, at `head`, with `status` its uncommitted tracked changes and `diff` its diff against the base, and the calls it was asked. */
function fakeGit({ head = HEAD, status = "", diff = DIFF }: { head?: string; status?: string; diff?: string } = {}) {
  const asked: string[][] = [];
  const git = async (args: string[]): Promise<string> => {
    asked.push(args);
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args.includes("--show-toplevel")) return `${TREE}\n`;
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "status") return status;
    if (args[0] === "diff") return diff;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { git, asked };
}

/** `runLocalReview` in a fresh ticket folder, with the reviewer answering `reply` (or throwing it), and what it was asked. */
async function reviewWith(reply: string | Error, gitOver: Parameters<typeof fakeGit>[0] = {}) {
  const ticketDir = mkdtempSync(join(tmpdir(), "local-review-"));
  const { git, asked } = fakeGit(gitOver);
  const reviews: { cwd: string; prompt: string; model: string; effort: string }[] = [];
  const deps: LocalReviewDeps = {
    git, model: "m", effort: "e", skill: "/tool/src/skills/row-review/SKILL.md", ticketDir, baseBranch: null, now: () => Date.UTC(2026, 10, 14),
    review: async (opts) => { reviews.push(opts); if (reply instanceof Error) throw reply; return reply; },
    verdictOf: (text) => (/VERDICT: not convinced\s*$/.test(text) ? "not convinced" : /VERDICT: convinced\s*$/.test(text) ? "convinced" : null),
  };
  try {
    const result = await runLocalReview(deps);
    const records = readLocalReviews(join(ticketDir, LOCAL_REVIEW_RECORD_FILE));
    const kept = (name: string) => (existsSync(join(ticketDir, LOCAL_REVIEW_DIR, name)) ? readFileSync(join(ticketDir, LOCAL_REVIEW_DIR, name), "utf8") : null);
    return { result, records, reviews, asked, diff: kept(`${HEAD}.diff`), reply: kept(`${HEAD}.md`) };
  } finally {
    rmSync(ticketDir, { recursive: true, force: true });
  }
}

test("A11-440: the review of a blocking finding exits 1, records not convinced at this commit for this tree, and the reviewer read the diff against the base in the worktree", async () => {
  const r = await reviewWith("1. Blocking: the new branch has no test.\n\nVERDICT: not convinced\n");
  assert.equal(r.result.code, 1);
  assert.match(r.result.out, /1\. Blocking: the new branch has no test\.[\s\S]*ticket:review-local: not convinced at c0ffee12 \(origin\/main\.\.\.HEAD\)/);
  assert.equal(r.records[TREE]?.head, HEAD);
  assert.equal(r.records[TREE]?.verdict, "not convinced");
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].cwd, TREE, "the reviewer works in the worker's tree");
  assert.ok(r.asked.some((args) => args.join(" ") === `diff ${BASE}...HEAD`), "the diff is three-dot against the base");
  assert.equal(r.diff, DIFF, "the diff the reviewer read is kept beside the outcome file");
  assert.match(r.reply ?? "", /VERDICT: not convinced/, "and so is its reply");
});

test("A11-440: a convinced review exits 0; a reviewer that cannot run, or gives no verdict line, exits 2 and is recorded with the reason", async () => {
  const convinced = await reviewWith("No findings.\n\nVERDICT: convinced\n");
  assert.deepEqual([convinced.result.code, convinced.records[TREE]?.verdict], [0, "convinced"]);
  const failed = await reviewWith(new Error("spawn codex ENOENT"));
  assert.equal(failed.result.code, 2);
  assert.deepEqual([failed.records[TREE]?.verdict, failed.records[TREE]?.problem], [null, "the reviewer could not run: spawn codex ENOENT"]);
  assert.match(failed.result.out, /Say so under `## Local review`/);
  const mute = await reviewWith("I looked at it.\n");
  assert.deepEqual([mute.result.code, mute.records[TREE]?.verdict, mute.records[TREE]?.problem], [2, null, "the reply has no verdict line"]);
});

test("A11-440: a tree with uncommitted tracked changes, or an empty diff, is not reviewed and records nothing", async () => {
  const dirty = await reviewWith("VERDICT: convinced\n", { status: " M src/x.ts\n" });
  assert.equal(dirty.result.code, 2);
  assert.match(dirty.result.out, /uncommitted changes to tracked files\. Commit them first/);
  assert.deepEqual([dirty.reviews.length, dirty.records], [0, {}]);
  const empty = await reviewWith("VERDICT: convinced\n", { diff: "" });
  assert.match(empty.result.out, /nothing to review: origin\/main\.\.\.HEAD is empty/);
  assert.deepEqual([empty.reviews.length, empty.records], [0, {}]);
});

test("A11-440: the reviewer is given the review method, the ticket as the spec, the diff and its base, posts nothing, and ends on a verdict line", () => {
  const prompt = localReviewPrompt({ skill: "/s/SKILL.md", brief: "/t/brief.md", diff: "/t/d.diff", base: BASE, head: HEAD });
  assert.match(prompt, /review method in \/s\/SKILL\.md \(the `row-review` skill\)/);
  assert.match(prompt, /post nothing, run no `gh` command and change nothing/);
  assert.match(prompt, /`## The ticket` section of \/t\/brief\.md/);
  assert.match(prompt, /The diff, origin\/main to the worker's commit c0ffee12[0-9]*: \/t\/d\.diff/);
  assert.match(prompt, /exactly `VERDICT: convinced` or `VERDICT: not convinced`, and nothing after it\.$/);
});

test("A11-440: a run on a machine with the review on is briefed to run it before it opens a pull request and is given the mark pr:open reads; a machine with it off gets neither", async () => {
  const start = async (tickets: Record<string, unknown>) => {
    const made = poolFixture({ keys: ["NBF-1"], tickets });
    await made.pool.tick();
    const dir = ticketDir(made.settings, "NBF-1");
    return { brief: readFileSync(join(dir, BRIEF_FILE), "utf8"), marked: existsSync(join(dir, LOCAL_REVIEW_FILE)) };
  };
  const on = await start({ localReview: true });
  assert.ok(on.brief.includes(localReviewStep("/node /tool/versions/v0.273.0/src/bin.ts ticket:review-local")), "the brief carries step 5b with the board's own command");
  assert.ok(on.brief.indexOf("5b. Before you open a pull request") < on.brief.indexOf("6. Push the branch"), "before the pull request step");
  assert.equal(on.marked, true);
  const off = await start({});
  assert.equal(off.brief.includes("ticket:review-local"), false, "POSITIVE CONTROL: off, the brief does not mention it");
  assert.equal(off.marked, false);
});

test("A11-440: a pull request opened after a local review still gets the board's own review when its head is pushed", async () => {
  await loadReviewerGate();
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false, localReview: true } });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull("a11ign/nbl-ui-netbox", 1, { head: "h1", settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 0, outcome: { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome, pullStates: { [url]: "open" } }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  await pool.reviewNewHeads();
  assert.deepEqual(reviewer.started, [{ pr: url, head: "h1" }], "the reviewer starts on the opened head");
  host.pullAt(url)!.head = "h2";
  await pool.reviewNewHeads();
  assert.deepEqual(reviewer.started.map(({ head }) => head), ["h1", "h2"], "and again on the pushed head");
});

test("A11-440: the record keeps each worktree's review, so a run that changes two repositories reviews each", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-review-record-"));
  try {
    const path = join(dir, LOCAL_REVIEW_RECORD_FILE);
    assert.deepEqual(readLocalReviews(path), {}, "no file is no review");
    writeFileSync(path, "not json");
    assert.deepEqual(readLocalReviews(path), {}, "an unreadable file is no review");
    writeFileSync(path, JSON.stringify({ "/a": record(), "/b": record({ verdict: "not convinced" }) }));
    assert.deepEqual(Object.keys(readLocalReviews(path)), ["/a", "/b"]);
    writeFileSync(path, JSON.stringify({ "/a": record(), "/tree": {}, "/odd": { ...record(), verdict: "maybe" }, "/bare": "x" }));
    assert.deepEqual(Object.keys(readLocalReviews(path)), ["/a"], "a record of another shape is no review, and the check asks for one rather than crashing on it");
    assert.match(localReviewCheck({ record: readLocalReviews(path)["/tree"] ?? null, head: HEAD, base: BASE, body: "", key: KEY }).refusal ?? "", /no review of this tree ran/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A11-440: a feedback round, whose brief does not ask for the local review, is not given the mark, so pr:open does not hold it to one", async () => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 10, 14, 10, 0, 0);
  const clock = { ms: T0 };
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { localReview: true, drafts: false }, now: () => clock.ms });
  const host = createFakeCodeHost();
  const { url } = host.seedPull("a11ign/toolchain", 60, { feedback: { feedbackAt: T0 + MIN, authors: ["alice"] } });
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: T0, outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/toolchain", url }] } as Outcome, pullStates: { [url]: "open" } }] });
  const dir = ticketDir(fixture.settings, "NBF-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCAL_REVIEW_FILE), "\n");
  const pool = fixture.restart({ codeHost: host });
  clock.ms += 5 * MIN;
  pool.watchFeedback();
  await pool.tick();
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const entry = fixture.store.get().entries[0];
  assert.ok(entry.review !== undefined && entry.rounds === 1, "the round is a review round");
  assert.equal(existsSync(join(dir, LOCAL_REVIEW_FILE)), false, "the first start's mark is removed for the round");
  assert.equal(readFileSync(join(dir, BRIEF_FILE), "utf8").includes("ticket:review-local"), false);
});

test("A11-440: the base is the branch --base names, else origin/HEAD, else origin/main, as pr:open reads it", async () => {
  assert.equal(await localBaseOf(async () => "origin/trunk\n", "admin/a11-432-x"), "origin/admin/a11-432-x");
  assert.equal(await localBaseOf(async () => "origin/trunk\n", null), "origin/trunk");
  assert.equal(await localBaseOf(async () => { throw new Error("not a symbolic ref"); }, null), "origin/main");
});
