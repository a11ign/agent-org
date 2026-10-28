// no-token: gh -- herdr, git, the tracker, the code host and the clock are all injected; the checkouts are scratch folders each holding a `.git/config`; nothing is spawned
// A11-355: a repository of the organisation that the host has not cloned is cloned on demand -- for a plan, for a worker's `wrong-repo`, for Retry, and by the board's own sweep
import { createSettledPool } from "./pool-settled-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { batchDir, herdrName, ticketDir, type QueueStore } from "./pool.ts";
import { fakeHerdr, poolFixture } from "./pool-fixture.ts";
import { REROUTE_LIMIT } from "./pool-org-repos.ts";
import { enqueue, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { logOf } from "./queue/run-log.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Git } from "./worktree.ts";
import { BRIEF_FILE } from "./worker-files.ts";

const KEY = "NBF-1";
const OTHER = "NBF-2";
const settled = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A checkout of `fullName` at `path`: a folder whose `.git/config` names its origin, which is all the board reads of a clone. */
function checkout(path: string, fullName: string): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${fullName}.git\n`);
  return path;
}

/**
 * A machine whose clones are acme/web (held as `main-app`) and acme/tools, in an organisation that also holds acme/corpus and acme/.github. `git` is a recorder whose `clone` makes the checkout the board then reads,
 * and fails for a repository named in `refuses`. The host file is a real file in the scratch folder, so what the board records in it is read back.
 */
function machine() {
  const root = tmpDir("pool-org-repos-");
  const clones = { "main-app": checkout(join(root, "repos", "web"), "acme/web"), tools: checkout(join(root, "repos", "tools"), "acme/tools") };
  const codeHost = createFakeCodeHost("worker");
  codeHost.seedRepositories("acme", ["acme/web", "acme/tools", "acme/corpus", "acme/.github"]);
  const hostFile = join(root, "host.json");
  writeFileSync(hostFile, `${JSON.stringify({ clones }, null, 2)}\n`);
  const calls: string[][] = [];
  const refuses = new Set<string>();
  const git: Git = async (cwd, args) => {
    if (args[0] !== "clone") return "";
    const fullName = /github\.com\/(.+?)\.git$/.exec(args[args.length - 2])![1];
    calls.push([cwd, ...args]);
    if (refuses.has(fullName)) throw new Error(`fatal: repository 'https://github.com/${fullName}.git/' not found`);
    checkout(args[args.length - 1], fullName);
    return "";
  };
  return { root, clones, codeHost, hostFile, git, calls, refuses, recorded: () => (JSON.parse(readFileSync(hostFile, "utf8")) as { clones: Record<string, string> }).clones };
}

/** A pool over the machine, with NBF-1 queued and started, and `write(outcome)` to have its worker end on `outcome`. */
async function working(max = 1) {
  const m = machine();
  const made = poolFixture({ keys: [KEY], max, clones: m.clones });
  const pool = made.restart({ codeHost: m.codeHost, git: m.git, hostFile: m.hostFile });
  await pool.tick();
  made.status.set(herdrName(KEY), "working");
  await pool.tick();
  const dir = ticketDir(made.settings, KEY);
  let written = Date.now() + 1000;
  /** The worker ends on `outcome` (its file dated after every earlier one) and the board settles it. */
  const ends = async (outcome: Outcome) => {
    const file = join(dir, "outcome.json");
    writeFileSync(file, JSON.stringify(outcome));
    written += 1000;
    utimesSync(file, new Date(written), new Date(written));
    made.status.set(herdrName(KEY), "idle");
    await pool.tick();
    await settled();
  };
  /** The queued run starts again, and its worker is up. */
  const starts = async () => {
    await pool.tick();
    await settled();
    made.status.set(herdrName(KEY), "working");
    await pool.tick();
  };
  const closes = () => made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("close")).length;
  const log = () => logOf(made.store.get(), KEY);
  return { ...made, ...m, pool, dir, ends, starts, closes, log };
}

const wrongRepo = (where: string): Outcome => ({ kind: "wrong-repo", where });
const needsYou = (run: { log: () => ReturnType<typeof logOf> }) => run.log().filter((event) => event.kind === "needs-you").length;

test("a worker's wrong-repo naming an organisation repository the host has not cloned: the board clones it, records it, moves the run there and starts it again, and no person is asked", async () => {
  const run = await working();
  await run.ends(wrongRepo("acme/corpus: the backups code lives there, not in this repository"));
  assert.deepEqual(run.calls, [[join(run.root, "repos"), "clone", "--quiet", "https://github.com/acme/corpus.git", join(run.root, "repos", ".corpus.cloning")]], "git cloned it, once");
  assert.equal(run.recorded().corpus, join(run.root, "repos", "corpus"), "the host file's clones hold it");
  assert.equal(run.settings.clones.corpus, join(run.root, "repos", "corpus"), "and so do the board's own settings, which need no restart");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo], ["running", "corpus"], "the run is queued again, planned for it, and started at once: the move asked for a pass");
  assert.equal(run.closes(), 1, "the first worker's workspace is closed");
  assert.deepEqual(run.log().filter((event) => event.kind === "finished" || event.kind === "requeued").map((event) => (event.kind === "requeued" ? `requeued ${event.why}` : `finished ${event.outcome}`)), ["finished wrong-repo", "requeued rerouted"]);
  assert.equal(needsYou(run), 0, "it is not on a person's card");
  await run.starts();
  assert.equal(run.entry(KEY).phase, "running", "the run starts again");
  const brief = readFileSync(join(run.dir, BRIEF_FILE), "utf8");
  assert.ok(brief.includes("names `corpus`, so its work lands there"), "the new worker is told the repository");
  assert.ok(brief.includes(`\`corpus\` at \`${join(run.root, "repos", "corpus")}\``), "and finds the clone among the repositories on the machine");
});

test("a wrong-repo naming an organisation repository the host already has is moved there with no clone, whichever key holds it", async () => {
  const run = await working();
  await run.ends(wrongRepo("acme/web"));
  assert.deepEqual(run.calls, [], "nothing was cloned");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo], ["running", "main-app"], "acme/web is held as main-app, which is the key the run is planned for");
});

test("a wrong-repo that names a repository outside the organisation, an archived one, or none in particular still reads Needs you, with the worker's words and its workspace kept", async () => {
  for (const where of ["other-org/service: a backend service", "acme/old-archive: archived, so not in the listing", "a backend service nobody here owns"]) {
    const run = await working();
    await run.ends(wrongRepo(where));
    assert.deepEqual(run.calls, [], `${JSON.stringify(where)}: nothing was cloned`);
    assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome, run.entry(KEY).workspace], ["finished", wrongRepo(where), "w1"], JSON.stringify(where));
    assert.equal(runStatus(run.entry(KEY)), "needs-you", JSON.stringify(where));
    assert.equal(run.closes(), 0, "the person can still answer the worker");
    assert.deepEqual(run.recorded(), run.clones, "the host file is as it was");
  }
});

test("a wrong-repo whose organisation cannot be listed reads Needs you: the board moves nothing on a guess", async () => {
  const run = await working();
  run.codeHost.repositoriesWorld.byOwner.clear();
  await run.ends(wrongRepo("acme/corpus"));
  assert.deepEqual(run.calls, []);
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome?.kind], ["finished", "wrong-repo"]);
});

test("a repository the clone of which git refuses stays a person's, with the worker's outcome and nothing recorded", async () => {
  const run = await working();
  run.refuses.add("acme/corpus");
  await run.ends(wrongRepo("acme/corpus"));
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome, run.entry(KEY).workspace], ["finished", wrongRepo("acme/corpus"), "w1"]);
  assert.equal(run.settings.clones.corpus, undefined);
  assert.deepEqual(run.recorded(), run.clones);
  await assert.rejects(run.pool.retry(KEY), /acme\/corpus is in the organisation but could not be cloned \(fatal: repository .* not found\), so NBF-1 was not retried/, "Retry says the clone failed, and does not queue the run where it was");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).workspace], ["finished", "w1"], "and the run is as it was");
  run.refuses.clear();
  await run.pool.retry(KEY);
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo], ["queued", "corpus"], "once the clone works, Retry moves it");
});

test("Retry on a run parked on a question, which an agent may still answer, is refused until Close has ended it; two presses at once retry a wrong-repo run once", async () => {
  const asked = await working();
  await asked.ends({ kind: "needs-human", reason: "which colour?", escalation: "reserved" });
  await assert.rejects(asked.pool.retry(KEY), /NBF-1 still holds its workspace: close it first, so it was not retried/);
  assert.deepEqual([asked.entry(KEY).phase, asked.entry(KEY).workspace], ["finished", "w1"], "its agent is still there to be answered");
  assert.equal(asked.closes(), 0);
  const twice = await working();
  twice.codeHost.repositoriesWorld.byOwner.clear();
  await twice.ends(wrongRepo("acme/corpus"));
  twice.codeHost.seedRepositories("acme", ["acme/web", "acme/tools", "acme/corpus"]);
  const [first, second] = await Promise.allSettled([twice.pool.retry(KEY), twice.pool.retry(KEY)]);
  assert.deepEqual([first.status, second.status], ["fulfilled", "fulfilled"]);
  assert.equal(twice.calls.length, 1, "one clone");
  assert.deepEqual(twice.log().filter((event) => event.kind === "requeued").map((event) => (event as { why: string }).why), ["retry"], "and one retry");
});

test("a worker sent back to the repository it was in is a person's, and the board moves a run at most twice", async () => {
  assert.equal(REROUTE_LIMIT, 2);
  const run = await working();
  await run.ends(wrongRepo("acme/corpus"));
  assert.equal(run.entry(KEY).plannedRepo, "corpus", "the first move");
  await run.starts();
  await run.ends(wrongRepo("acme/corpus"));
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome?.kind], ["finished", "wrong-repo"], "naming the repository it is already in moves nothing");
  await run.pool.retry(KEY);
  await run.starts();
  await run.ends(wrongRepo("acme/tools"));
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo], ["running", "tools"], "the second move");
  await run.starts();
  await run.ends(wrongRepo("acme/corpus"));
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).outcome?.kind], ["finished", "wrong-repo"], "a third is a person's");
  assert.deepEqual(run.log().filter((event) => event.kind === "requeued").map((event) => (event as { why: string }).why), ["rerouted", "retry", "rerouted"], "Retry is a person's and counts none of the board's moves");
});

test("Retry on a wrong-repo run closes its workspace, queues it in the organisation repository it named, and clones that first", async () => {
  const run = await working();
  run.codeHost.repositoriesWorld.byOwner.clear();
  await run.ends(wrongRepo("acme/corpus"));
  assert.equal(run.entry(KEY).phase, "finished", "the board could not list the organisation, so the run is parked");
  run.codeHost.seedRepositories("acme", ["acme/web", "acme/tools", "acme/corpus"]);
  await run.pool.retry(KEY);
  assert.equal(run.calls.length, 1, "cloned by Retry");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo, run.entry(KEY).workspace, run.entry(KEY).outcome], ["queued", "corpus", undefined, undefined]);
  assert.equal(run.closes(), 1, "the parked workspace was closed, as a second one would take its herdr name");
  assert.deepEqual(run.log().filter((event) => event.kind === "requeued").map((event) => (event as { why: string }).why), ["retry"]);
});

test("Retry on a wrong-repo run that names no organisation repository queues it as any retry does, and clones nothing", async () => {
  const run = await working();
  await run.ends(wrongRepo("other-org/service"));
  await run.pool.retry(KEY);
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo, run.entry(KEY).workspace], ["queued", undefined, undefined]);
  assert.deepEqual(run.calls, []);
});

test("Retry says why it cannot, and changes nothing, for a run that is not finished, ended on its result, concluded, or is unknown", async () => {
  const run = await working();
  await assert.rejects(run.pool.retry(KEY), /NBF-1 is still running, not finished, so it was not retried/);
  await assert.rejects(run.pool.retry("NBF-99"), /NBF-99 is not on the board/);
  await run.ends({ kind: "checked", reason: "nothing to change" });
  await assert.rejects(run.pool.retry(KEY), /concluded \(checked\) with nothing more to do, so it was not retried/);
  assert.equal(run.entry(KEY).phase, "finished", "and the entry is as it was");
  const ready = await working();
  await ready.ends({ kind: "ready-pr", prs: [{ repo: "tools", url: "https://github.com/acme/tools/pull/1" }] });
  await assert.rejects(ready.pool.retry(KEY), /ended with its result, ready-pr/);
});

test("the board's sweep clones every live repository of the organisation it has no clone of, once, and goes on past one that fails", async () => {
  const run = await working();
  run.refuses.add("acme/.github");
  assert.equal(await run.pool.cloneMissing(), 1, "corpus is cloned; .github is refused and said");
  assert.deepEqual(Object.keys(run.recorded()), ["main-app", "tools", "corpus"]);
  run.refuses.clear();
  assert.equal(await run.pool.cloneMissing(), 1, "the next sweep clones what failed");
  assert.equal(await run.pool.cloneMissing(), 0, "and then there is nothing to clone");
  assert.deepEqual(run.calls.map((call) => call[3]), ["https://github.com/acme/corpus.git", "https://github.com/acme/.github.git", "https://github.com/acme/.github.git"], "corpus once, and .github twice: refused, then cloned");
});

test("a sweep and a worker that name the same repository together clone it once", async () => {
  const run = await working();
  const sweep = run.pool.cloneMissing();
  await run.ends(wrongRepo("acme/corpus"));
  await sweep;
  assert.equal(run.calls.filter((call) => call[3].endsWith("acme/corpus.git")).length, 1);
});

// A PLANNER'S CHOICE

const DESCRIPTION = ["Fix it.", "", "## Done-when", "", "### Before merge", "", "* The tests pass.", ""].join("\n");
const START = Date.now() + 3_600_000;
const plan = `# Plan\n\n## Approach\n\nDo it.\n\n## Paths\n\n- \`corpus:src/a.ts\`\n`;

/** A batch planning run of NBF-1 and NBF-2 on the machine, whose planner writes a plan for each and an `order.json` placing them. */
async function planning() {
  const m = machine();
  const settings = parseTicketSettings({ clones: m.clones, stateDir: join(m.root, "state"), tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "plan {keys} into {dir}", state: "Planned" } } });
  const tracker = createFakeTracker([fakeTicket(KEY, { description: DESCRIPTION }), fakeTicket(OTHER, { description: DESCRIPTION })]);
  const keys = [KEY, OTHER];
  let queue: Queue = resumeQueue(enqueue(emptyQueue(2), keys.map((key) => tracker.ticketOf(key)!), { model: "sonnet", effort: "high" }, 0, { keys: new Set(keys), choice: { model: "opus", effort: "max" }, batch: true }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const clock = { now: START };
  const pool = createSettledPool(store, { settings, source: tracker, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: m.hostFile, now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(m.root, "transcripts"), wait: async () => {}, pluginRecord: join(m.root, "no-plugin-record.json"), codeHost: m.codeHost, git: m.git });
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const dir = batchDir(settings, "b0-0");
  let written = Date.now() + 1000;
  /** The planner writes a plan for each ticket and `order` (repository by key), and ends `planned`; the board settles it. */
  const writes = async (order: Record<string, string>) => {
    for (const key of keys) {
      mkdirSync(join(dir, "plan", key), { recursive: true });
      writeFileSync(join(dir, "plan", key, `${key}-0001-plan-fit.md`), plan);
    }
    writeFileSync(join(dir, "plan", "order.json"), JSON.stringify(Object.fromEntries(Object.entries(order).map(([key, repo]) => [key, { repo, after: [] }]))));
    const file = join(dir, "outcome.json");
    writeFileSync(file, JSON.stringify({ kind: "planned" }));
    written += 1000;
    utimesSync(file, new Date(written), new Date(written));
    status.set(herdrName("b0-0"), "idle");
    clock.now += 60_000;
    await pool.tick();
    await settled();
  };
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  return { ...m, settings, dir, writes, entry };
}

test("the planner's brief offers the organisation's repositories that have no clone beside the clones, and the board clones the one its plan names", async () => {
  const run = await planning();
  const brief = readFileSync(join(run.dir, BRIEF_FILE), "utf8");
  assert.match(brief, /These repositories of the organisation are not cloned on this machine yet/);
  assert.match(brief, /- `corpus`\n- `\.github`/, "the two with no clone, and neither web (held as main-app) nor tools");
  assert.match(brief, /or one of the repositories of the organisation that are not cloned yet, which the board clones for you: `corpus`, `\.github`/, "order.json may name one");
  await run.writes({ [KEY]: "corpus", [OTHER]: "tools" });
  assert.deepEqual(run.calls.map((call) => call[3]), ["https://github.com/acme/corpus.git"], "corpus was cloned for the plan; tools needed none");
  assert.deepEqual([run.entry(KEY).phase, run.entry(KEY).plannedRepo, run.entry(KEY).outcome], ["queued", "corpus", undefined], "the ticket keeps the repository its planner chose");
  assert.equal(run.entry(OTHER).plannedRepo, "tools");
  assert.equal(run.settings.clones.corpus, join(run.root, "repos", "corpus"));
});

test("a plan naming an organisation repository by the name of a clone held under another key is stored under that key", async () => {
  const run = await planning();
  await run.writes({ [KEY]: "web", [OTHER]: "tools" });
  assert.deepEqual(run.calls, [], "acme/web is cloned already, as main-app");
  assert.equal(run.entry(KEY).plannedRepo, "main-app");
  assert.equal(run.entry(KEY).phase, "queued");
});

test("a plan naming a repository outside the organisation, or one the board cannot clone, still hands that ticket to a person, saying why, and the other is planned", async () => {
  const outside = await planning();
  await outside.writes({ [KEY]: "elsewhere", [OTHER]: "tools" });
  const refused = outside.entry(KEY).outcome;
  assert.ok(refused?.kind === "needs-human" && /the repository `elsewhere`, which is not one of this machine's clones \(`main-app`, `tools`\)/.test(refused.reason), JSON.stringify(refused));
  assert.deepEqual([outside.entry(OTHER).phase, outside.entry(OTHER).plannedRepo], ["queued", "tools"]);
  assert.deepEqual(outside.calls, []);
  const failing = await planning();
  failing.refuses.add("acme/corpus");
  await failing.writes({ [KEY]: "corpus", [OTHER]: "tools" });
  const failed = failing.entry(KEY).outcome;
  assert.ok(failed?.kind === "needs-human" && /`acme\/corpus`, a repository of the organisation that this machine has not cloned, and the board could not clone it \(fatal: repository .* not found\), so it gave it none/.test(failed.reason), JSON.stringify(failed));
  assert.equal(failing.settings.clones.corpus, undefined);
  assert.ok(!existsSync(join(failing.root, "repos", "corpus")));
});
