// no-token: gh -- the tracker, the code host and the clock are all injected; nothing is spawned
//
// A11-249: a pull request the board holds is closed without merging (A11-229's announcement-emulator#14 was, with two commits that were not on main). The board lists what it still held against its base, keeps the list in the
// ticket's folder, keeps the branch, and posts the list on the ticket. A pull request that held nothing unique is recorded as such. Every test runs the real pool over the contract's in-memory tracker and code host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullState, TicketSource } from "./source.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import { CLOSED_PULLS_DIR, COMMENT_FILES, closedWorkComment, closedWorkMarkdown, recordName, type ClosedWorkRecord } from "./closed-work.ts";

const REPOSITORY = "a11ign/announcement-emulator";
const PULL = `https://github.com/${REPOSITORY}/pull/14`;
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const BRANCH = "admin/a11-229-check-the-announcements";
const COMMITS = [{ sha: FIRST, subject: "feat(check-report): refuse unknown options" }, { sha: SECOND, subject: "test: a browser.newContext() suite and per-source rates" }];
const FILES = ["src/check-report.ts", "test/context.test.ts", "src/rates.ts"];

/** NBF-1 over the in-memory tracker and code host, with what the sweep reads. */
function world(over: Partial<TicketSource> = {}, hostOver: Partial<CodeHost> = {}) {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source: TicketSource = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState, ...over };
  const made = poolFixture({ keys: ["NBF-1"] });
  const codeHost = createFakeCodeHost();
  return { ...made, tracker, codeHost, pool: made.restart({ source, codeHost: Object.assign(codeHost, hostOver) }) };
}

type World = ReturnType<typeof world>;

/** NBF-1's run, in `phase`, holding the pull request at `PULL`, which the tracker says is `state`; the code host holds it closed with `closedWork` (none: nothing unique). */
function holding({ store, tracker, codeHost }: World, { phase = "finished", state = "closed", closedWork, fields = {} }: { phase?: Entry["phase"]; state?: PullState; closedWork?: { commits: typeof COMMITS; files: string[] }; fields?: Partial<Entry> } = {}): void {
  codeHost.seedPull(REPOSITORY, 14, { state: state === "closed" ? "closed" : state, base: "main", head: SECOND, ...(closedWork === undefined ? {} : { closedWork: { branch: BRANCH, ...closedWork } }) });
  const [entry] = store.get().entries;
  const pulls = [{ repo: "announcement-emulator", url: PULL }];
  // A run still running holds its pull request through a review round's list; a finished one through its outcome.
  store.set({ ...store.get(), entries: [{ ...entry, phase, ...(phase === "finished" ? { outcome: { kind: "ready-pr" as const, prs: pulls }, finishedAt: 100 } : { review: pulls }), ...fields }] });
  tracker.linkPull("NBF-1", PULL, state);
}

const folderOf = ({ settings }: World): string => join(settings.stateDir, "tickets", "NBF-1", CLOSED_PULLS_DIR);
/** The comments the sweep posted: the board posts others on a merge. */
const listed = ({ tracker }: World) => tracker.comments.filter(({ text }) => text.startsWith("Closed pull request"));
const recordOf = (made: World): ClosedWorkRecord => JSON.parse(readFileSync(join(folderOf(made), "a11ign-announcement-emulator-14.json"), "utf8"));

test("A11-249: a pull request closed without merging, with two commits not on its base, is listed in the ticket's folder, posted on the ticket with its branch and both SHAs, and its branch is kept", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  await made.pool.refreshTracker();
  const record = recordOf(made);
  assert.deepEqual([record.kind, record.posted, record.number, record.base, record.branch, record.head], ["unique", true, 14, "main", BRANCH, SECOND]);
  assert.deepEqual(record.kind === "unique" ? [record.commits, record.files, record.filesComplete] : null, [COMMITS, FILES, true]);
  const list = readFileSync(join(folderOf(made), "a11ign-announcement-emulator-14.md"), "utf8");
  for (const named of [FIRST, SECOND, BRANCH, ...FILES, "pull/14/head"]) assert.ok(list.includes(named), `the list names ${named}`);
  assert.equal(made.tracker.comments.length, 1);
  const [{ key, text }] = made.tracker.comments;
  assert.equal(key, "NBF-1");
  assert.ok(text.startsWith("Closed pull request #14: work not on main\n"), text);
  for (const named of [PULL, BRANCH, SECOND, FIRST, "refuse unknown options", "git fetch origin pull/14/head", ...FILES]) assert.ok(text.includes(named), `the comment names ${named}: ${text}`);
  // The branch is kept: the sweep asks the code host to read, and never to delete anything, and the code host holds no deleted branch.
  assert.deepEqual(made.codeHost.calls.filter((call) => !call.startsWith("readClosedWork")), []);
  assert.deepEqual(made.codeHost.rowsWorld.deletedBranches, []);
});

test("A11-249: a second refresh posts nothing more and writes no second record", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  await made.pool.refreshTracker();
  await made.pool.refreshTracker();
  assert.equal(made.tracker.comments.length, 1);
  assert.deepEqual(readdirSync(folderOf(made)).sort(), ["a11ign-announcement-emulator-14.json", "a11ign-announcement-emulator-14.md"]);
  assert.equal(made.codeHost.calls.filter((call) => call.startsWith("readClosedWork")).length, 1, "a pull request with a posted record is not read again");
});

test("A11-249: a run still running when its pull request is closed is noticed too, which is how A11-229's was closed", async () => {
  const made = world();
  holding(made, { phase: "running", closedWork: { commits: COMMITS, files: FILES } });
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.comments.length, recordOf(made).kind], [1, "unique"]);
});

test("A11-249: a pull request with nothing unique records no unique work, says so on the ticket, and needs no account", async () => {
  const made = world();
  holding(made);
  await made.pool.refreshTracker();
  const record = recordOf(made);
  assert.deepEqual([record.kind, record.posted, record.branch, record.head, record.base], ["none", true, `branch-14`, SECOND, "main"]);
  assert.equal("commits" in record, false);
  const [{ text }] = made.tracker.comments;
  assert.ok(text.startsWith("Closed pull request #14: no unique work, everything it held is on main"), text);
  assert.equal(made.tracker.comments.length, 1);
});

test("A11-249: a pull request that is open or merged is not read, and nothing is written", async () => {
  for (const state of ["open", "merged"] as const) {
    const made = world();
    holding(made, { state });
    await made.pool.refreshTracker();
    assert.deepEqual([listed(made), existsSync(folderOf(made)), made.codeHost.calls.filter((call) => call.startsWith("readClosedWork"))], [[], false, []], state);
  }
});

test("A11-249: a pull request the code host cannot read writes nothing, and is asked again at the next refresh", async () => {
  let readable = false;
  const made = world({}, {});
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  const reads = made.codeHost.readClosedWork!;
  made.codeHost.readClosedWork = async (url) => (readable ? reads(url) : null);
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.comments, existsSync(folderOf(made))], [[], false]);
  readable = true;
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.comments.length, recordOf(made).kind], [1, "unique"]);
});

test("A11-249: a comment that fails to post is posted at the next refresh, with no second record and no second read", async () => {
  let refusing = true;
  const made = world();
  const post = made.tracker.comment!;
  const source: TicketSource = { ...made.tracker, comment: async (key, body) => { if (refusing) throw new Error("the tracker refused"); return post(key, body); } };
  const pool = made.restart({ source, codeHost: made.codeHost });
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  await pool.refreshTracker();
  assert.deepEqual([made.tracker.comments.length, recordOf(made).posted, recordOf(made).kind], [0, undefined, "unique"], "the record is kept though the comment was refused");
  refusing = false;
  await pool.refreshTracker();
  assert.deepEqual([made.tracker.comments.length, recordOf(made).posted], [1, true]);
  assert.deepEqual(readdirSync(folderOf(made)).length, 2, "one record, not two");
  assert.equal(made.codeHost.calls.filter((call) => call.startsWith("readClosedWork")).length, 1, "the pull request was read once");
});

test("A11-249: a tracker that cannot comment still gets the record in the ticket's folder, and a tracker that cannot be asked about pull requests records nothing", async () => {
  const quiet = world({ comment: undefined });
  holding(quiet, { closedWork: { commits: COMMITS, files: FILES } });
  await quiet.pool.refreshTracker();
  assert.deepEqual([quiet.tracker.comments, recordOf(quiet).kind, recordOf(quiet).posted], [[], "unique", undefined]);
  const deaf = world({ pullStates: async () => { throw new Error("the tracker is down"); } });
  holding(deaf, { closedWork: { commits: COMMITS, files: FILES } });
  await deaf.pool.refreshTracker();
  assert.deepEqual([deaf.tracker.comments, existsSync(folderOf(deaf))], [[], false]);
});

test("A11-249: a code host that reads no closed work lists nothing, and asks the tracker nothing for it", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  const older = createFakeCodeHost();
  delete (older as Partial<CodeHost>).readClosedWork;
  const asked: string[] = [];
  const pool = made.restart({ source: { ...made.tracker, pullStates: async (keys) => { asked.push(...keys); return made.tracker.pullStates!(keys); } }, codeHost: older });
  await pool.refreshTracker();
  assert.deepEqual([made.tracker.comments, existsSync(folderOf(made)), asked.length], [[], false, 1], "the finished run's ordinary state read is the only ask");
});

test("A11-249: a run whose pull request merged, or whose ticket completed, is not asked about", async () => {
  const merged = world();
  holding(merged, { state: "merged", fields: { pullStates: { [PULL]: "merged" } } });
  const done = world();
  holding(done, { closedWork: { commits: COMMITS, files: FILES }, fields: { trackerState: "completed" } });
  for (const made of [merged, done]) {
    await made.pool.refreshTracker();
    assert.deepEqual([listed(made), existsSync(folderOf(made))], [[], false]);
  }
});

const work = (over: Partial<Parameters<typeof closedWorkComment>[0]> = {}) => ({ number: 14, url: PULL, base: "main", branch: BRANCH, head: SECOND, commits: COMMITS, files: FILES, filesComplete: true, ...over });

test("A11-249: the comment lists at most 300 files and says how many more, the list file holds them all, and a compare that stopped at its file cap says so", () => {
  const files = Array.from({ length: COMMENT_FILES + 5 }, (_, at) => `results/f${at}.json`);
  const comment = closedWorkComment(work({ files }));
  assert.ok(comment.includes("`results/f299.json`") && !comment.includes("`results/f300.json`") && comment.includes("- and 5 more"), "300 files, then the rest counted");
  assert.ok(closedWorkMarkdown({ kind: "unique", ...work({ files }) }).includes("`results/f304.json`"), "the record's own list is whole");
  assert.ok(!closedWorkComment(work()).includes("file cap"), "a complete list says nothing of a cap");
  assert.ok(closedWorkComment(work({ filesComplete: false })).includes("compare stopped at its file cap"));
});

test("A11-249: a record is named by its repository and number, and an address that is no pull request makes a safe name", () => {
  assert.equal(recordName(PULL), "a11ign-announcement-emulator-14");
  assert.equal(recordName("https://example.com/a/b?c=../d"), "https-example.com-a-b-c-..-d");
});

test("A11-249: a finished run's pull request is read from the state the refresh already recorded: the tracker is asked about pull requests once for it, not twice", async () => {
  const made = world();
  const asked: string[][] = [];
  const reads = made.tracker.pullStates!;
  const pool = made.restart({ source: { ...made.tracker, pullStates: async (keys) => { asked.push([...keys]); return reads(keys); } }, codeHost: made.codeHost });
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  await pool.refreshTracker();
  assert.deepEqual([asked, listed(made).length], [[["NBF-1"]], 1]);
});

test("A11-249: a ticket the tracker finished (canceled) is not listed: no next run is made for it", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES }, fields: { trackerState: "canceled" } });
  await made.pool.refreshTracker();
  assert.deepEqual([listed(made), existsSync(folderOf(made))], [[], false]);
});

test("A11-249: at most ten closed pull requests are read and posted in one refresh, and the rest at the next", async () => {
  const made = world();
  const urls = Array.from({ length: 12 }, (_, at) => `https://github.com/${REPOSITORY}/pull/${100 + at}`);
  urls.forEach((url, at) => { made.codeHost.seedPull(REPOSITORY, 100 + at, { state: "closed", closedWork: { commits: COMMITS, files: FILES } }); made.tracker.linkPull("NBF-1", url, "closed"); });
  const [entry] = made.store.get().entries;
  made.store.set({ ...made.store.get(), entries: [{ ...entry, phase: "running", review: urls.map((url) => ({ repo: "announcement-emulator", url })) }] });
  await made.pool.refreshTracker();
  assert.equal(listed(made).length, 10);
  await made.pool.refreshTracker();
  assert.equal(listed(made).length, 12);
});

test("A11-249: a record file that is not a record is read again from the code host and rewritten, never posted as one", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  mkdirSync(folderOf(made), { recursive: true });
  writeFileSync(join(folderOf(made), "a11ign-announcement-emulator-14.json"), "{}\n");
  await made.pool.refreshTracker();
  assert.deepEqual([listed(made).length, recordOf(made).kind, recordOf(made).posted], [1, "unique", true]);
  assert.ok(!listed(made)[0]!.text.includes("undefined"));
});

test("A11-249: a pull request that cannot be read is said once, not at every refresh, and is still asked again", async () => {
  const made = world();
  holding(made, { closedWork: { commits: COMMITS, files: FILES } });
  made.codeHost.readClosedWork = async () => null;
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => { said.push(String(text)); return true; }) as typeof process.stderr.write;
  try {
    await made.pool.refreshTracker();
    await made.pool.refreshTracker();
  } finally {
    process.stderr.write = write;
  }
  assert.equal(said.filter((line) => line.includes("could not be read")).length, 1);
});
