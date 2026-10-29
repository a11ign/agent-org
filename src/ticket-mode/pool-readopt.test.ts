// no-token: gh -- herdr, the tracker and the clock are injected; the pool is driven over fakes
// A11-240: what a pool that starts up does with the runs the queue file holds as live, and with a run it marked crashed whose worker is still there
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { readoptNote } from "./board-view/readopt-note.ts";
import { clockOf } from "./board-view/update-banner.ts";
import { replace, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { finish } from "./queue/queue-transitions.ts";
import { lostBeforeThisStart } from "./queue/queue-readopt.ts";
import { logOf } from "./queue/run-log.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { TicketSource } from "./source.ts";

const NAME = herdrName("NBF-1");
const RESTART_CRASH = { kind: "crashed", reason: "the pool restarted while it was running" } as const;
const LOST = { kind: "crashed", reason: "lost in a restart: its herdr workspace is gone" } as const;
const pr = { repo: "nbl-ui-netbox", url: "https://github.com/x/nbl-ui-netbox/pull/1" };
/** The verbs that would touch a pane: an adopted run is sent none of them (A11-78). */
const TOUCHES = ["send-keys", "prompt", "start", "create", "close"];

type Fixture = ReturnType<typeof poolFixture>;

/** `keys` started, then put back as a restart in their first moments leaves them: `starting`, with no workspace or pane on record. */
async function caughtStarting(options: Parameters<typeof poolFixture>[0] = {}): Promise<Fixture> {
  const made = poolFixture(options);
  await made.pool.tick();
  for (const { ticket } of made.store.get().entries) {
    made.store.set(replace(made.store.get(), ticket.key, (entry) => ({ ...entry, phase: "starting", workspace: undefined, pane: undefined })));
  }
  made.herdr.calls.length = 0;
  return made;
}

const touched = (made: Fixture) => made.herdr.calls.filter((args) => TOUCHES.some((verb) => args.includes(verb)));

test("a restart during `starting` with the pane alive re-adopts the run, sends its pane nothing, and reads its outcome", async () => {
  const made = await caughtStarting();
  made.status.set(NAME, "working");
  const next = made.restart({});
  await next.reconcile();
  const entry = made.entry("NBF-1");
  assert.deepEqual([entry.phase, entry.workspace, entry.pane, entry.readopted], ["running", "w1", "w1:p1", { at: 100, from: "starting" }]);
  await next.tick();
  assert.deepEqual(touched(made), [], "only listings and reads reach herdr: no key, no prompt, no second start, no new workspace, no close");
  made.status.set(NAME, "idle");
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  await next.tick();
  assert.equal(made.entry("NBF-1").outcome?.kind, "checked", "the watch took over: the worker's outcome is recorded");
});

test("a run caught `starting` whose workspace herdr lists with no agent yet is adopted too, and a restart is not what ends it", async () => {
  const made = await caughtStarting();
  made.status.set(NAME, "unknown");
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").workspace], ["running", "w1"], "`unknown` cannot tell a seat still starting from an ended one");
});

test("a batch caught `starting` with its run listed is adopted for every ticket, in the one workspace", async () => {
  const made = await caughtStarting({ keys: ["NBF-1", "NBF-2"] });
  for (const key of ["NBF-1", "NBF-2"]) made.store.set(replace(made.store.get(), key, (entry) => ({ ...entry, batch: "b1" })));
  made.status.set(herdrName("b1"), "working");
  await made.restart({}).reconcile();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [made.entry(key).phase, made.entry(key).workspace, made.entry(key).readopted?.from]), Array(2).fill(["running", "w1", "starting"]));
  assert.deepEqual(touched(made), []);
});

test("a run adopted from `starting` takes the steps its start was cut short of: the ticket is claimed", async () => {
  const claims: string[] = [];
  const fake = createFakeTracker();
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords, claim: async (key, claimant) => { claims.push(`${key} by ${claimant}`); } };
  const made = await caughtStarting({ source });
  claims.length = 0;
  made.status.set(NAME, "working");
  await made.restart({}).reconcile();
  await Promise.resolve();
  assert.equal(claims.length, 1, "the claim the start would have made after its agent opened");
});

// A11-294: a run whose agent never opened has no work to lose, so a restart starts it again instead of ending it crashed.
test("a restart in a run's `starting` with no agent listed queues it again with the same round, ends nothing, and the run then starts again", async () => {
  const made = await caughtStarting();
  const round = { review: [pr], feedback: "tighten the test", asked: true };
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, ...round, startedAt: 90 })));
  await made.restart({}).reconcile();
  const queued = made.entry("NBF-1");
  assert.deepEqual([queued.phase, queued.outcome, queued.lostInRestart, queued.startedAt, queued.finishedAt], ["queued", undefined, undefined, undefined, undefined], "queued, not crashed");
  assert.deepEqual({ review: queued.review, feedback: queued.feedback, asked: queued.asked }, round, "the same round");
  assert.equal(readoptNote(queued), null, "it lost nothing, so the card says nothing of a loss");
  assert.deepEqual(logOf(made.store.get(), "NBF-1").flatMap((event) => (event.kind === "requeued" ? [event.why] : [])), ["restart"], "the log says a restart queued it again");
  await made.restart({}).tick();
  const started = made.entry("NBF-1");
  assert.deepEqual([started.phase, started.workspace, started.outcome], ["running", "w2", undefined], "it starts again");
  assert.deepEqual({ review: started.review, feedback: started.feedback, asked: started.asked }, round, "and its round is the one it had");
});

test("a run caught `running` with no workspace on record, and no agent listed, is queued again the same way", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, phase: "running", workspace: undefined, pane: undefined })));
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").outcome, made.entry("NBF-1").lostInRestart], ["queued", undefined, undefined]);
});

test("a batch caught `starting` with nothing listed is queued again for every ticket", async () => {
  const made = await caughtStarting({ keys: ["NBF-1", "NBF-2"] });
  for (const key of ["NBF-1", "NBF-2"]) made.store.set(replace(made.store.get(), key, (entry) => ({ ...entry, batch: "b1" })));
  await made.restart({}).reconcile();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [made.entry(key).phase, made.entry(key).outcome, made.entry(key).lostInRestart, made.entry(key).batch]), Array(2).fill(["queued", undefined, undefined, "b1"]), "still one batch");
});

test("a talk session caught `starting` keeps its version-folder pin; a work run's start records go, with the stale marks of the start", async () => {
  const made = await caughtStarting();
  const pinned = { toolRoot: "/tool/versions/v0.1.0", toolVersion: "v0.1.0", readopted: { at: 5, from: "starting" } as const };
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, ...pinned, talk: true })));
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").toolRoot, made.entry("NBF-1").toolVersion, made.entry("NBF-1").readopted], ["/tool/versions/v0.1.0", "v0.1.0", undefined]);
  const work = await caughtStarting();
  work.store.set(replace(work.store.get(), "NBF-1", (entry) => ({ ...entry, ...pinned })));
  await work.restart({}).reconcile();
  assert.deepEqual([work.entry("NBF-1").toolRoot, work.entry("NBF-1").toolVersion], [undefined, undefined]);
});

test("a run lost in a restart once and caught `starting` by the next is queued again with its mark moved to this queueing, so its brief still says its worktree holds earlier work", async () => {
  const made = await caughtStarting();
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, lostInRestart: { at: 50 } })));
  await made.restart({}).reconcile();
  const queued = made.entry("NBF-1");
  assert.equal(queued.phase, "queued");
  assert.equal(lostBeforeThisStart(queued), queued.queuedAt);
});

test("a restart with the pane gone ends a run that had an agent `lost in a restart` and queues it again once; lost again, it ends", async () => {
  const made = poolFixture();
  await made.pool.tick();
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").lostInRestart], ["queued", { at: 100 }], "no pull request on record: queued again");
  await made.restart({}).tick();
  assert.equal(made.entry("NBF-1").phase, "running", "it starts again");
  assert.equal(made.entry("NBF-1").lostInRestart?.at, 100, "the mark rides the second start");
  await made.restart({}).reconcile();
  const entry = made.entry("NBF-1");
  assert.deepEqual([entry.phase, entry.outcome], ["finished", LOST], "lost a second time in the same chain: it ends, and is not queued");
});

test("a running run herdr no longer lists is lost the same way", async () => {
  const made = poolFixture();
  await made.pool.tick();
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").lostInRestart], ["queued", { at: 100 }]);
});

test("a lost review round has its pull requests on record: it ends and is not queued again", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, review: [pr] })));
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").outcome, made.entry("NBF-1").lostInRestart], ["finished", LOST, undefined]);
});

test("a talk session a restart loses ends and is not queued again: it is a person's", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.store.set(replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, talk: true })));
  await made.restart({}).reconcile();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").outcome?.kind], ["finished", "crashed"]);
});

test("a listed workspace whose pane herdr no longer has is lost, and its leftover workspace is closed so the run queued again opens none beside it", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.status.set(NAME, "unknown");
  made.herdr.calls.length = 0;
  const gone = (args: string[]) => {
    if (args.includes("pane") && args.includes("read")) throw Object.assign(new Error("herdr exited 1"), { stderr: JSON.stringify({ error: { code: "pane_not_found" } }) });
    return made.herdr.run(args);
  };
  await made.restart({ herdr: gone }).reconcile();
  assert.equal(made.entry("NBF-1").phase, "queued");
  assert.equal(made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("close") && args.includes("w1")).length, 1);
});

test("a run already crashed with a live pane is re-adopted on the next watch pass, and the card says so", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.store.set(replace(finish(made.store.get(), "NBF-1", RESTART_CRASH, 50), "NBF-1", (entry) => ({ ...entry, trackerState: "started", handedBack: "h" })));
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").workspace], ["finished", undefined]);
  made.status.set(NAME, "working");
  made.herdr.calls.length = 0;
  await made.pool.tick();
  const entry = made.entry("NBF-1");
  assert.deepEqual([entry.phase, entry.workspace, entry.pane, entry.outcome, entry.finishedAt], ["running", "w1", "w1:p1", undefined, undefined]);
  assert.deepEqual(entry.readopted, { at: 100, from: "crashed", reason: RESTART_CRASH.reason });
  assert.deepEqual([entry.trackerState, entry.handedBack, entry.seenWorking], [undefined, undefined, true], "what the end recorded goes with it");
  assert.equal(readoptNote(entry), `re-adopted at ${clockOf(100)}: it was marked crashed (the pool restarted while it was running), but its worker carried on`);
  assert.deepEqual(touched(made), [], "its pane is sent nothing, and no second agent is started");
});

test("a crashed run whose pane is idle or done is left crashed: that worker may have finished", async () => {
  for (const seen of ["idle", "done", "unknown", "blocked"]) {
    const made = poolFixture();
    await made.pool.tick();
    made.store.set(finish(made.store.get(), "NBF-1", RESTART_CRASH, 50));
    made.status.set(NAME, seen);
    await made.pool.tick();
    assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").outcome?.kind], ["finished", "crashed"], `a pane ${seen}`);
  }
});

test("a crashed batch whose run is working is re-adopted for every ticket", async () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"] });
  await made.pool.tick();
  for (const key of ["NBF-1", "NBF-2"]) made.store.set(finish(replace(made.store.get(), key, (entry) => ({ ...entry, batch: "b1" })), key, RESTART_CRASH, 50));
  made.status.set(herdrName("b1"), "working");
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [made.entry(key).phase, made.entry(key).readopted?.from]), Array(2).fill(["running", "crashed"]));
});

test("a run re-adopted from crashed is lost for good if its worker goes: it ends crashed again, and nothing re-adopts an ended pane", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.store.set(finish(made.store.get(), "NBF-1", RESTART_CRASH, 50));
  made.status.set(NAME, "working");
  await made.pool.tick();
  made.status.delete(NAME);
  await made.pool.tick();
  await made.pool.tick();
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").outcome?.kind], ["finished", "crashed"]);
});

test("a publish run and a new-ticket run caught `starting` are adopted when herdr lists them, and fail when it does not", async () => {
  const made = poolFixture({ keys: [] });
  const publish = (phase: "starting" | "running") => ({ id: "p1", keys: ["NBF-1"], prs: [pr], phase, queuedAt: 0, startedAt: 1 });
  made.store.set({ ...made.store.get(), publish: publish("starting") });
  made.status.set(herdrName("publish-p1"), "working");
  await made.restart({}).reconcile();
  assert.deepEqual([made.store.get().publish?.phase, made.store.get().publish?.workspace], ["running", "w1"]);
  made.store.set({ ...made.store.get(), publish: publish("starting") });
  made.status.delete(herdrName("publish-p1"));
  await made.restart({}).reconcile();
  assert.deepEqual([made.store.get().publish?.phase, made.store.get().publish?.failure], ["finished", "the pool restarted while it was running"]);

  const writer = (phase: "starting") => ({ id: "w5", request: "r", mode: "quick" as const, placement: "auto" as const, form: {}, phase, queuedAt: 0, startedAt: 1, tickets: [] });
  made.store.set({ ...made.store.get(), writers: [writer("starting")] });
  made.status.set(herdrName("writer-w5"), "working");
  await made.restart({}).reconcile();
  assert.deepEqual([made.store.get().writers?.[0]?.phase, made.store.get().writers?.[0]?.workspace], ["running", "w5"]);
  made.store.set({ ...made.store.get(), writers: [writer("starting")] });
  made.status.delete(herdrName("writer-w5"));
  await made.restart({}).reconcile();
  assert.deepEqual([made.store.get().writers?.[0]?.phase, made.store.get().writers?.[0]?.failure], ["finished", "the pool restarted while it was running"]);
});

test("the card says what a restart did: each line for its case, and nothing for a run it did not touch", () => {
  const base = { phase: "running" } as Pick<Entry, "phase">;
  assert.equal(readoptNote({ ...base, readopted: { at: 100, from: "starting" } }), `re-adopted after a restart at ${clockOf(100)}: its worker carried on`);
  assert.equal(readoptNote({ ...base, readopted: { at: 100, from: "crashed", reason: "r" } }), `re-adopted at ${clockOf(100)}: it was marked crashed (r), but its worker carried on`);
  assert.equal(readoptNote({ phase: "queued", lostInRestart: { at: 100 } }), `lost in a restart at ${clockOf(100)} and re-queued`);
  assert.equal(readoptNote({ phase: "running", lostInRestart: { at: 100 } }), null, "once it runs again the line is gone");
  assert.equal(readoptNote(base), null);
});

test("A11-363: a restart keeps a RUNNING run running -- its agent is listed, so the board re-attaches to it and queues nothing, with no requeue in its log", async () => {
  const made = poolFixture();
  await made.pool.tick();
  made.status.set(NAME, "working");
  const before = made.entry("NBF-1");
  assert.deepEqual([before.phase, before.workspace], ["running", "w1"]);
  made.herdr.calls.length = 0;
  const next = made.restart({});
  await next.reconcile();
  await next.tick();
  const after = made.entry("NBF-1");
  assert.deepEqual([after.phase, after.workspace, after.pane, after.outcome, after.lostInRestart], ["running", "w1", "w1:p1", undefined, undefined], "still the same run in the same workspace, ended nothing");
  assert.deepEqual(logOf(made.store.get(), "NBF-1").flatMap((event) => (event.kind === "requeued" ? [event.why] : [])), [], "no requeue of any kind, `why: restart` included");
  assert.deepEqual(touched(made), [], "only listings and reads reach herdr: no key, no prompt, no second start, no close");
  assert.equal(readoptNote(after), null, "and the card has nothing to say of a restart");
});

test("A11-363: every live run is kept by one restart, whatever the pool's other runs are doing: a working run and an idle one are both still running", async () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"] });
  await made.pool.tick();
  made.status.set(herdrName("NBF-1"), "working");
  made.status.set(herdrName("NBF-2"), "idle");
  await made.restart({}).reconcile();
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => made.entry(key).phase), ["running", "running"]);
  assert.deepEqual(["NBF-1", "NBF-2"].flatMap((key) => logOf(made.store.get(), key).filter((event) => event.kind === "requeued")), []);
});
