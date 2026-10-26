// no-token: gh -- the pool over the fake code host, and real git in repositories this file builds in its own temporary directories; nothing reaches a network remote
// module: every open pull request of a ticket is watched in any phase, brought up to date with its base, or handed to a conflict round (A11-286)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost, fakePullUrl, type FakePull } from "../plugins/fakes/code-host.ts";
import { poolFixture } from "./pool-fixture.ts";
import { finishedWith, nextStepQueued } from "./kept-pulls-fixture.ts";
import type { Git } from "./worktree.ts";
import { find, replace, type Entry, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { finish, markRunning, markStarting, respond } from "./queue/queue-transitions.ts";
import { conflictNote } from "./board-view/pull-conflict.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { logOf } from "./queue/run-log.ts";

const NOW = 1_000_000;
const REPOSITORY = "a11ign/agent-org";
const URL = fakePullUrl(REPOSITORY, 7);
const KEY = "A11-1";
const MERGE_WITH = "Merge it with: git fetch origin main && git merge origin/main, resolve the files above, run the tests and push.";

/** Real git with every `GIT_*` scrubbed, synchronous for the test's own setup. */
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, ["add", file]);
  git(cwd, [...IDENTITY, "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

/**
 * A bare origin whose `main` moved to `a.txt: theirs` after a pull request (#7, at `refs/pull/7/head`, as the host keeps it) branched from it and changed the same line to `ours`, and a clone of it: merging `main` into the pull request conflicts in `a.txt`.
 * Returns the clone and the pull request's head.
 */
function conflictingRepository(): Readonly<{ clone: string; head: string }> {
  const root = tmpDir("base-merge-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["init", "-q", "-b", "main", seed]);
  commit(seed, "a.txt", "base\n", "base");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", "feature"]);
  const head = commit(seed, "a.txt", "ours\n", "the pull request's change");
  git(seed, ["push", "-q", "origin", `${head}:refs/pull/7/head`]);
  git(seed, ["checkout", "-q", "main"]);
  commit(seed, "a.txt", "theirs\n", "main moved");
  git(seed, ["push", "-q", "origin", "main"]);
  const clone = join(root, "clone");
  git(root, ["clone", "-q", origin, clone]);
  return { clone, head };
}

/** The ticket queued for its next plan step, step 1's pull request #7 open and in no entry: what happened to a11ign/agent-org#1921. Paused, so no run starts. */
const nextStepQueue = (more: Partial<Entry> = {}): Queue => nextStepQueued(KEY, URL, NOW, more);

/** The ticket finished on its own pull request #7. */
const finishedOnPull = (): Queue => finishedWith(KEY, { kind: "ready-pr", prs: [{ repo: "agent-org", url: URL }] }, NOW - 10);

/** The pool over a world with pull request #7 (`pull` is what the host says of it), the queue `queue`, and the real repository when `listable`; sweeps wait for the kept pull requests' sweep. */
function world({ queue = nextStepQueue(), pull = { conflicting: true }, listable = true, git: listing, listingMs }: { queue?: Queue | ((head: string) => Queue); pull?: FakePull["feedback"]; listable?: boolean; git?: Git; listingMs?: number } = {}) {
  const repository = conflictingRepository();
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPOSITORY, 7, { head: repository.head, feedback: pull });
  const clock = { at: NOW };
  const fixture = poolFixture({ keys: [KEY], now: () => clock.at, ...(listable ? { clones: { "agent-org": repository.clone } } : {}) });
  fixture.store.set(typeof queue === "function" ? queue(repository.head) : queue);
  const pool = fixture.restart({ codeHost: host, ...(listing === undefined ? {} : { git: listing }), ...(listingMs === undefined ? {} : { listingMs }) });
  const sweep = async () => {
    pool.watchFeedback();
    await pool.keptWatchDone();
  };
  const entry = (): Entry => find(fixture.store.get(), KEY)!;
  const events = () => logOf(fixture.store.get(), KEY).filter((event) => event.kind === "base-merge").map((event) => (event.kind === "base-merge" ? event.step : ""));
  const asked = () => host.branchUpdates.asked.length;
  return { host, fixture, pool, sweep, entry, events, asked, clock, head: repository.head };
}

/** The wait for something the board does after an await (the files of a conflict being listed), bounded. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 500 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), what);
}

/** What the board said to the log while `run` ran. */
async function logged(run: () => Promise<void>): Promise<string> {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return said.join("");
}

test("A11-286: a conflicting pull request of a ticket queued for its next step starts a conflict round that names the files, the base and the merge command, and the step waits until it has pushed", async () => {
  const { host, fixture, sweep, entry, events, asked } = world();
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  const nextStep = entry();
  await sweep();
  assert.equal(asked(), 1, "the host was asked to merge the base in first");
  assert.deepEqual([entry().phase, entry().rounds, entry().review], ["queued", 1, [{ repo: "agent-org", url: URL }]], "a round over the conflicting pull request");
  assert.equal(entry().feedback, [`${URL} conflicts with its base branch main.`, "Merging main into it conflicted in a.txt.", MERGE_WITH].join("\n"));
  assert.deepEqual(entry().afterRound, nextStep, "the step it was queued for, as it was, waits behind the round");
  assert.deepEqual(events(), ["round"]);
  assert.deepEqual(logOf(fixture.store.get(), KEY).filter((event) => event.kind === "round").map((event) => (event.kind === "round" ? event.cause : "")), ["conflict"]);

  const before = fixture.store.get();
  await sweep();
  assert.equal(asked(), 1, "a second sweep at the same head asks nothing");
  assert.equal(fixture.store.get(), before, "and starts no second round");

  // The round runs and pushes: the step is queued again, ahead of nothing else, at the time of the push.
  const pushed = finish(markRunning(markStarting(before, KEY, NOW + 1), KEY, "w2", "w2:p1"), KEY, { kind: "ready-pr", prs: [{ repo: "agent-org", url: URL }] }, NOW + 2);
  fixture.store.set(pushed);
  host.pullAt(URL)!.feedback = {};
  await sweep();
  assert.deepEqual([entry().phase, entry().queuedAt, entry().steps, entry().review, entry().afterRound], ["queued", NOW, nextStep.steps, undefined, undefined], "the next step is back, and no longer waits");
  assert.equal(entry().rounds, 1, "the round it took still counts toward the board's cap");
  assert.deepEqual(logOf(fixture.store.get(), KEY).at(-1), { kind: "requeued", why: "conflict-round", at: NOW });
});

test("A11-286: a round that ends asking a person keeps the next step waiting", async () => {
  const { host, fixture, sweep, entry } = world();
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  const stash = entry().afterRound;
  assert.ok(stash !== undefined);
  const asking = finish(markRunning(markStarting(fixture.store.get(), KEY, NOW + 1), KEY, "w2", "w2:p1"), KEY, { kind: "needs-human", reason: "which side wins?", escalation: "reserved" }, NOW + 2);
  fixture.store.set(asking);
  host.pullAt(URL)!.feedback = {};
  await sweep();
  assert.deepEqual([entry().phase, entry().afterRound], ["finished", stash], "it still waits");
});

test("A11-286: update-branch clears a behind pull request, and a conflicting one it merges, with no round, once for each head", async () => {
  const behind = world({ pull: { behind: true } });
  await behind.sweep();
  await behind.sweep();
  assert.deepEqual(behind.host.branchUpdates.asked, [{ url: URL, expectedHead: behind.head }], "asked once, for the head it was read at, however many sweeps read it");
  assert.deepEqual([behind.entry().phase, behind.entry().review, behind.entry().afterRound], ["queued", undefined, undefined], "no round");
  assert.deepEqual(behind.events(), ["behind"], "the card says so, once");

  const trivial = world({ pull: { conflicting: true } });
  await trivial.sweep();
  await trivial.sweep();
  assert.equal(trivial.asked(), 1);
  assert.deepEqual([trivial.entry().phase, trivial.entry().review, trivial.entry().afterRound], ["queued", undefined, undefined]);
  assert.deepEqual(trivial.events(), ["merging"]);
});

test("A11-286: a pull request that is neither behind nor conflicting is left alone, and so is one the host cannot update", async () => {
  const clean = world({ pull: {} });
  await clean.sweep();
  assert.deepEqual([clean.asked(), clean.events()], [0, []]);
  const noUpdate = world({ pull: { conflicting: true } });
  const pool = noUpdate.fixture.restart({ codeHost: { ...noUpdate.host, updateBranch: undefined } });
  pool.watchFeedback();
  await pool.keptWatchDone();
  assert.deepEqual([noUpdate.asked(), noUpdate.events(), noUpdate.entry().review], [0, [], undefined]);
});

test("A11-286: a pull request that is behind or conflicts again at a new head is tried again", async () => {
  const { host, sweep, asked, events } = world({ pull: { behind: true } });
  await sweep();
  host.pullAt(URL)!.head = "the-merge-commit";
  await sweep();
  host.pullAt(URL)!.head = "main-moved-again";
  await sweep();
  assert.deepEqual([asked(), events()], [3, ["behind", "behind", "behind"]], "asked for each head, and the card says the step once for each");
  assert.deepEqual(host.branchUpdates.asked.map(({ expectedHead }) => expectedHead).slice(1), ["the-merge-commit", "main-moved-again"]);
});

test("A11-286: a running run's kept pull request waits and is never pushed to, and is answered once the run has ended", async () => {
  const running = (): Queue => markRunning(markStarting(nextStepQueue(), KEY, NOW - 3), KEY, "w1", "w1:p1");
  const { fixture, sweep, entry, events, asked } = world({ queue: running() });
  await sweep();
  await sweep();
  assert.deepEqual([asked(), events()], [0, ["waiting"]], "no update asked of a branch whose worker holds a workspace, and the card says so once");
  fixture.store.set(finish(fixture.store.get(), KEY, { kind: "needs-human", reason: "which side wins?", escalation: "reserved" }, NOW));
  const parked = replace(fixture.store.get(), KEY, (e) => ({ ...e, workspace: "w1" }));
  fixture.store.set(parked);
  await sweep();
  assert.deepEqual([asked(), events()], [0, ["waiting"]], "a parked run still holds its workspace");
  fixture.store.set(replace(fixture.store.get(), KEY, ({ workspace: _closed, pane: _pane, ...e }) => e));
  await sweep();
  assert.deepEqual([asked(), events()], [1, ["waiting", "merging"]], "the run ended, and the pull request is answered at the same head");
});

test("A11-286: a stacked run's pull request and one in the merge queue are left to their own owners", async () => {
  const stacked = world({ queue: nextStepQueue({ stackBase: { key: "A11-0", repo: "agent-org", branch: "a11-0-below", sha: "a".repeat(40) } }) });
  await stacked.sweep();
  assert.deepEqual([stacked.asked(), stacked.events()], [0, []]);
  const queued = world({ pull: { conflicting: true, queue: { queued: true, removals: [] } } });
  await queued.sweep();
  assert.deepEqual([queued.asked(), queued.events()], [0, []]);
});

test("A11-286: a refused update is said once and tried again on the next sweep, and starts no round", async () => {
  const { host, sweep, entry, events, asked } = world();
  host.branchUpdates.answers.set(URL, { kind: "refused", reason: "Head branch was modified. Review and try the merge again." });
  const said = await logged(async () => { await sweep(); await sweep(); });
  assert.equal(asked(), 2, "asked again on the next sweep");
  assert.deepEqual([entry().review, entry().afterRound, events()], [undefined, undefined, []], "no round and nothing on the card");
  assert.equal(said.split("Head branch was modified").length - 1, 1, "and GitHub's line said once");
  host.branchUpdates.answers.delete(URL);
  await sweep();
  assert.deepEqual([asked(), events()], [3, ["merging"]], "once it merges, the card says so");
});

test("A11-286: at the cap no round is queued, and the card says the board's rounds are used up, once for the head", async () => {
  const { host, sweep, entry, events, asked } = world({ queue: nextStepQueue({ rounds: 3 }) });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  await sweep();
  assert.deepEqual([entry().phase, entry().review, entry().afterRound, asked(), events()], ["queued", undefined, undefined, 1, ["capped"]]);
});

test("A11-286: a conflict whose files cannot be listed still starts the round, and says so", async () => {
  const { host, sweep, entry } = world({ listable: false });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  assert.equal(entry().feedback, [`${URL} conflicts with its base branch main.`, "Merging main into it conflicted, and the board could not list the files.", MERGE_WITH].join("\n"));
});

test("A11-286: a run that ended asking a person, whose outcome names no pull request, is handed the round over the pull request an earlier outcome opened", async () => {
  const asking = finish(nextStepQueue(), KEY, { kind: "needs-human", reason: "which side wins?", escalation: "reserved" }, NOW);
  const { host, sweep, entry } = world({ queue: asking });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  assert.deepEqual([entry().phase, entry().rounds, entry().review, entry().afterRound], ["queued", 1, [{ repo: "agent-org", url: URL }], undefined], "a round on the pull request, and no step to hold back");
  assert.match(entry().feedback ?? "", /^https:\/\/github\.com\/a11ign\/agent-org\/pull\/7 conflicts with its base branch main\.\nMerging main into it conflicted in a\.txt\./);
});

test("A11-286: a finished run's own conflicting pull request is merged up to date first, and its round names the files once they are listed", async () => {
  const { host, pool, entry, events, asked } = world({ queue: finishedOnPull() });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  pool.watchFeedback();
  assert.equal(asked(), 1, "the base merge is asked for before any round");
  assert.equal(entry().phase, "finished", "and the round waits for the files of the conflict");
  await until(() => entry().phase === "queued", "the round starts once the files are listed");
  assert.equal(entry().feedback, [`${URL} conflicts with its base branch main.`, "Merging main into it conflicted in a.txt.", MERGE_WITH].join("\n"));
  assert.deepEqual([entry().rounds, entry().afterRound, events()], [1, undefined, ["round"]]);
});

test("A11-286: a finished run's conflicting pull request that merges up to date starts no round, and the merge is no person's answer to a run that asked one", async () => {
  const queue = replace(finishedOnPull(), KEY, (entry) => ({ ...entry, outcomeHeads: { [URL]: "the-head-it-ended-on" } }));
  const { host, pool, entry, events, asked } = world({ queue });
  host.pullAt(URL)!.head = "the-head-it-ended-on";
  pool.watchFeedback();
  assert.deepEqual([asked(), entry().phase, entry().rounds, events()], [1, "finished", undefined, ["merging"]], "merged up to date, and no round");
  host.pullAt(URL)!.head = "the-merge-commit";
  host.pullAt(URL)!.feedback = {};
  pool.watchFeedback();
  assert.equal(entry().outcomeHeads?.[URL], "the-merge-commit", "the run's outcome head follows the board's own push");
});

test("A11-286: a merge the host accepted that never moved the head is taken as a real conflict after ten minutes, and the round starts", async () => {
  const { host, sweep, entry, events, asked, clock } = world();
  await sweep();
  assert.deepEqual([asked(), events(), entry().review], [1, ["merging"], undefined], "the host said updated, and the pull request is read at the same head");
  clock.at += 9 * 60_000;
  await sweep();
  assert.deepEqual([asked(), events()], [1, ["merging"]], "inside the grace it waits");
  clock.at += 2 * 60_000;
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  assert.deepEqual([asked(), events(), entry().rounds], [1, ["merging", "round"], 1], "past it the conflict is real, with no second ask of the host");
  assert.match(entry().feedback ?? "", /conflicted in a\.txt/);
});

test("A11-286: a refusal that lasts ten minutes on a conflicting pull request starts the round too", async () => {
  const { host, sweep, entry, asked, clock } = world();
  host.branchUpdates.answers.set(URL, { kind: "refused", reason: "Resource not accessible by integration" });
  await sweep();
  clock.at += 11 * 60_000;
  await sweep();
  assert.deepEqual([asked(), entry().phase, entry().rounds], [1, "queued", 1], "asked until the grace ran out, and then a round");
  assert.deepEqual(entry().review, [{ repo: "agent-org", url: URL }]);
});

test("A11-286: files that cannot be listed in a minute do not hold the round back", async () => {
  const hung: Git = () => new Promise(() => {});
  const { host, sweep, entry } = world({ git: hung, listingMs: 20 });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  assert.match(entry().feedback ?? "", /could not list the files/);
  assert.equal(entry().phase, "queued");
});

test("A11-286: a failure of the watch that runs again once the files are listed is said, and is no unhandled rejection", async () => {
  const queue = finishedOnPull();
  const { host, fixture, entry, head } = world({ queue });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  let reads = 0;
  const failing = fixture.restart({ codeHost: { ...host, readPullFeedback: (...args: Parameters<typeof host.readPullFeedback>) => { reads += 1; if (reads > 1) throw new Error("gh exploded\nsecond line"); return host.readPullFeedback(...args); } } });
  const said = await logged(async () => {
    failing.watchFeedback();
    await until(() => reads > 1, "the second watch ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.match(said, /could not be answered once its conflict was listed: gh exploded\n/);
  assert.ok(head.length > 0 && entry().phase === "finished");
});

test("A11-286: a finished run that starts a round for new review feedback is not pushed to first, and its worker is told of the conflict", async () => {
  const { host, pool, entry, asked } = world({ queue: finishedOnPull(), pull: { conflicting: true, feedbackAt: NOW, authors: ["carol"] } });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  pool.watchFeedback();
  assert.equal(asked(), 0, "the board did not merge the base under the round it starts");
  assert.equal(entry().feedback, [`${URL} conflicts with its base branch main.`, `New review feedback on ${URL}, the newest from carol.`].join("\n"));
});

test("A11-286: a behind pull request held red on main is not updated, and a parked run's own pull request waits for its wake, not for a worker", async () => {
  const held = world({ queue: (head) => replace(finishedOnPull(), KEY, (e) => ({ ...e, checkHeads: { [URL]: { head, step: "not-ours" } } })), pull: { behind: true } });
  await held.sweep();
  assert.deepEqual([held.asked(), held.events()], [0, []], "A11-215 updates it once main is green");
  const parked = world({ queue: replace(finishedOnPull(), KEY, (e) => ({ ...e, workspace: "w1" })) });
  await parked.sweep();
  assert.deepEqual([parked.asked(), parked.events()], [0, []], "no push, and no row that says it waits for a worker");
});

test("A11-286: a ticket the tracker settled while its round ran does not get its next step back", async () => {
  const { host, fixture, sweep, entry } = world();
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  await sweep();
  const pushed = finish(markRunning(markStarting(fixture.store.get(), KEY, NOW + 1), KEY, "w2", "w2:p1"), KEY, { kind: "ready-pr", prs: [{ repo: "agent-org", url: URL }] }, NOW + 2);
  fixture.store.set(replace(pushed, KEY, (e) => ({ ...e, trackerState: "completed" })));
  host.pullAt(URL)!.feedback = {};
  await sweep();
  assert.deepEqual([entry().phase, entry().afterRound !== undefined], ["finished", true]);
});

// A11-293: a run handed to a person is watched for its base as every finished run is.
const HANDED = "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped. Respond to review starts another. The latest: New review feedback on the pull request.";

/** The ticket finished on a `reviewed` outcome for pull request #7, which the A11-213 stall flag then handed to a person (`handedBack`): the case of a11ign/agent-org#1933. */
const reviewedHandedToAPerson = (more: Partial<Entry> = {}): Queue =>
  replace(finishedWith(KEY, { kind: "reviewed", prs: [{ repo: "agent-org", url: URL }] }, NOW - 10), KEY, (entry) => ({ ...entry, handedBack: HANDED, ...more }));

test("A11-293: a run handed to a person has the base merged into its conflicting pull request, with no round", async () => {
  const { pool, entry, events, asked } = world({ queue: reviewedHandedToAPerson() });
  assert.equal(runStatus(entry()), "needs-you", "the case: a reviewed outcome, handed to a person");
  pool.watchFeedback();
  assert.deepEqual([asked(), entry().phase, entry().rounds, events()], [1, "finished", undefined, ["merging"]], "update-branch was asked, and no worker was woken");
});

test("A11-293: a run handed to a person has a behind pull request brought up to date, once for the head", async () => {
  const { pool, asked, events } = world({ queue: reviewedHandedToAPerson(), pull: { behind: true } });
  pool.watchFeedback();
  pool.watchFeedback();
  assert.deepEqual([asked(), events()], [1, ["behind"]]);
});

/** The world of a run handed to a person whose pull request has a real conflict, watched until the board has decided it (`held`, once the files are listed). */
async function heldConflict() {
  const held = world({ queue: reviewedHandedToAPerson() });
  held.host.branchUpdates.answers.set(URL, { kind: "conflict" });
  held.pool.watchFeedback();
  await until(() => held.events().includes("held"), "the conflict is decided once its files are listed");
  return held;
}

test("A11-293: a real conflict on a run handed to a person is held for it: the card says it, the log says it, and Respond carries it into the round", async () => {
  const { fixture, entry, events, asked } = await heldConflict();
  assert.deepEqual([asked(), entry().phase, entry().rounds, events()], [1, "finished", undefined, ["held"]], "no round was started for a run a person holds");
  assert.deepEqual(entry().pullHeads?.[URL]?.conflict, { base: "main" }, "the watch recorded the conflict");
  assert.equal(conflictNote(entry()), "a11ign/agent-org #7 conflicts with main", "the card says it");
  const answered = find(respond(fixture.store.get(), KEY, NOW + 1), KEY)!;
  assert.equal(answered.conflict, `${URL} conflicts with its base branch main.`, "Respond starts the round with the conflict");
  assert.equal(answered.phase, "queued");
});

test("A11-293: a conflict on a run that asked a person, at the board's cap, is not dropped: the card says it and Respond carries it", async () => {
  // A needs-human outcome names no pull request: the run's review round does.
  const asking = replace(finishedWith(KEY, { kind: "needs-human", reason: "which side wins?", escalation: "reserved" }, NOW - 10), KEY, (entry) => ({ ...entry, rounds: 3, review: [{ repo: "agent-org", url: URL }] }));
  const { host, pool, fixture, entry, events } = world({ queue: asking });
  host.branchUpdates.answers.set(URL, { kind: "conflict" });
  pool.watchFeedback();
  await until(() => events().includes("capped"), "the conflict is decided");
  assert.equal(entry().phase, "finished", "no round is left to queue");
  assert.equal(conflictNote(entry()), "a11ign/agent-org #7 conflicts with main");
  assert.equal(find(respond(fixture.store.get(), KEY, NOW + 1), KEY)!.conflict, `${URL} conflicts with its base branch main.`);
});

test("A11-293: a run the tracker completed or a person stopped is left alone, and so is one whose pull request needs nothing", async () => {
  const settled = world({ queue: reviewedHandedToAPerson({ trackerState: "completed" }) });
  settled.pool.watchFeedback();
  const stopped = world({ queue: replace(finishedWith(KEY, { kind: "stopped" } as never, NOW - 10), KEY, (entry) => ({ ...entry, review: [{ repo: "agent-org", url: URL }] })) });
  stopped.pool.watchFeedback();
  const clear = world({ queue: reviewedHandedToAPerson(), pull: {} });
  clear.pool.watchFeedback();
  // A run that concluded with nothing to do, as `resumesOnConflict` leaves it, and a ticket the tracker completed while a later step is open (Needs you, not Completed).
  const concluded = world({ queue: replace(finishedWith(KEY, { kind: "checked", reason: "nothing to change" }, NOW - 10), KEY, (entry) => ({ ...entry, review: [{ repo: "agent-org", url: URL }] })) });
  concluded.pool.watchFeedback();
  const doneEarly = world({ queue: reviewedHandedToAPerson({ trackerState: "completed", steps: [{ step: 1, of: 2, prs: [] }] as never }) });
  assert.equal(runStatus(doneEarly.entry()), "needs-you", "the case: the tracker completed it, yet it reads Needs you");
  doneEarly.pool.watchFeedback();
  assert.deepEqual([settled.asked(), stopped.asked(), clear.asked(), concluded.asked(), doneEarly.asked()], [0, 0, 0, 0, 0]);
  assert.equal(conflictNote(clear.entry()), null, "a pull request that does not conflict says nothing");
});

/** The world of a run handed to a person, watched once. */
function handedAndWatched() {
  const watched = world({ queue: reviewedHandedToAPerson() });
  watched.pool.watchFeedback();
  return watched;
}

test("A11-293: the conflict leaves the card once the pull request reads clear", async () => {
  const { host, pool, entry } = handedAndWatched();
  assert.equal(conflictNote(entry()), "a11ign/agent-org #7 conflicts with main");
  host.pullAt(URL)!.feedback = {};
  pool.watchFeedback();
  assert.equal(conflictNote(entry()), null);
});

test("A11-293: a conflict held for a person is decided again, with its files, once the run is one the board answers", async () => {
  const { pool, fixture, entry, events, asked } = await heldConflict();
  pool.watchFeedback();
  assert.equal(asked(), 1, "held for the same head, nothing is asked again");
  fixture.store.set(replace(fixture.store.get(), KEY, (e) => ({ ...e, handedBack: undefined })));
  pool.watchFeedback();
  await until(() => entry().phase === "queued", "a watched run gets its round");
  assert.deepEqual([asked(), events()], [2, ["held", "round"]]);
  assert.match(entry().feedback ?? "", /Merging main into it conflicted in a\.txt\./, "the round names the files");
});

test("A11-293: a pull request closed unmerged that the host still reads conflicting is not recorded as a conflict", async () => {
  const { host, pool, entry } = world({ queue: reviewedHandedToAPerson() });
  host.pullAt(URL)!.state = "closed";
  pool.watchFeedback();
  assert.equal(entry().pullHeads?.[URL]?.conflict, undefined);
});
