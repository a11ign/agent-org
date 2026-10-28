// no-token: gh -- herdr, git, the tracker, the code host and the clock are all injected; nothing is spawned and nothing reaches the network
//
// A11-359: `fill()` read the blockers, heads and plan paths of the queued runs inside `try { … } catch { return; }`. A read that threw started nothing and logged nothing, and a read that hung (a `fetch` with no timeout on a
// dead socket that never sends a reset) held every later pass: 6 tickets were queued and 8 of 10 slots free, and no run started until the board was restarted. Now each read has a time, a ticket whose read fails or times out
// is held with its reason, the others start, the last good read stands, and a pass that starts nothing says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { whyNothingStarts } from "./pool-start.ts";
import { nextStarts } from "./queue.ts";
import { waitNote } from "./board-view/pull-status-and-notes.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { Blocker, TicketSource } from "./source.ts";

const fake = createFakeTracker();
const base: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords };
const BLOCKED: Blocker = { key: "NBF-0", state: "started", status: "In Progress", branch: "nbf-0", pulls: {} };
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** What the board said to its log while `run` ran. */
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

/** A pool over `keys` whose tracker answers the blockers by `blockers`, with a read time short enough for a hang to be waited out. */
function world(keys: readonly string[], source: TicketSource, tickets: Record<string, unknown> = {}) {
  const fixture = poolFixture({ keys, max: 10, source, tickets });
  return { ...fixture, pool: fixture.restart({ readMs: 40 }) };
}

const none = (keys: readonly string[]): ReadonlyMap<string, readonly Blocker[]> => new Map(keys.map((key) => [key, []]));

test("A11-359: a ticket whose blockers cannot be read is held with the reason, and the other queued runs start in the same pass", async () => {
  const asked: string[][] = [];
  const unreadable = new Set(["NBF-2"]);
  const source: TicketSource = { ...base, blockers: async (keys) => {
    asked.push([...keys]);
    if (keys.some((key) => unreadable.has(key))) throw new Error("Linear answered 500: Internal Server Error");
    return none(keys);
  } };
  const { pool, entry, store } = world(["NBF-1", "NBF-2", "NBF-3"], source);
  const said = await logged(() => pool.tick());
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((key) => entry(key).phase), ["running", "queued", "running"], "only the ticket that cannot be read waits");
  assert.equal(entry("NBF-2").blockersFailure, "Linear answered 500: Internal Server Error");
  assert.equal(entry("NBF-2").blockers, undefined, "its blockers are unknown, so it does not start beside a blocker it may have");
  assert.equal(waitNote(entry("NBF-2"), store.get().entries), "Waits: the tracker could not say which tickets block it (Linear answered 500: Internal Server Error); the board asks again on every pass");
  assert.deepEqual(asked, [["NBF-1", "NBF-2", "NBF-3"], ["NBF-1"], ["NBF-2"], ["NBF-3"]], "one call for the three, and, as it failed, one for each ticket");
  assert.match(said, /NBF-2: the tracker could not say which tickets block it \(Linear answered 500: Internal Server Error\); it is held and asked again on the next pass, and the other runs go on/);
  unreadable.clear();
  await pool.tick();
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").blockersFailure], ["running", undefined], "asked again on the next pass, it is read and starts, and its hold is gone");
});

test("A11-359: a read that never answers holds only its ticket, for no longer than the read's time, and the others start", async () => {
  const source: TicketSource = { ...base, blockers: (keys) => (keys.includes("NBF-2") ? never() : Promise.resolve(none(keys))) };
  const { pool, entry } = world(["NBF-1", "NBF-2", "NBF-3"], source);
  const started = Date.now();
  await pool.tick();
  assert.equal(Date.now() - started < 2_000, true, "the pass was not held by the hung read");
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((key) => entry(key).phase), ["running", "queued", "running"]);
  assert.match(entry("NBF-2").blockersFailure ?? "", /`the tracker's read of the blockers of NBF-2` did not finish within 0\.04s/);
});

test("A11-359: a pass whose tracker is wholly down starts nothing that is unread, says why, and says it once, not on every pass", async () => {
  const source: TicketSource = { ...base, blockers: async () => { throw new Error("fetch failed (ECONNRESET)"); } };
  const { pool, entry } = world(["NBF-1", "NBF-2"], source);
  const first = await logged(() => pool.tick());
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["queued", "queued"]);
  assert.match(first, /fill: 2 queued with free slots, and none starts: NBF-1 \(its blockers could not be read: fetch failed \(ECONNRESET\)\); NBF-2 \(its blockers could not be read: fetch failed \(ECONNRESET\)\)/);
  const second = await logged(() => pool.tick());
  assert.equal(second.includes("fill:"), false, "the same reason is not said again");
  assert.equal(second.includes("could not say which tickets block"), false, "nor is the same failure of a ticket");
});

test("A11-359: a failed project read never stops a start, and says so", async () => {
  const source: TicketSource = { ...base, blockers: async (keys) => none(keys), projectSummaries: async () => { throw new Error("Linear answered 503"); } };
  const { pool, entry } = world(["NBF-1", "NBF-2"], source);
  const said = await logged(() => pool.tick());
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["running", "running"], "the runs start though the tracker could not say which projects they are in");
  assert.match(said, /the tracker could not say which projects the queued tickets are in: Linear answered 503/);
});

test("A11-359: a run keeps the repository the last good project read gave it when the tracker cannot say which project it is in", async () => {
  const source: TicketSource = { ...base, blockers: async (keys) => none(keys), projectSummaries: async () => { throw new Error("Linear answered 503"); } };
  const { pool, entry, store } = world(["NBF-1", "NBF-2"], source);
  store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, projectRepo: "nbl-ui-netbox" })) });
  await logged(() => pool.tick());
  assert.deepEqual([entry("NBF-1").projectRepo, entry("NBF-2").projectRepo], ["nbl-ui-netbox", "nbl-ui-netbox"], "the ticket's own summary names no repository, and does not clear the one that was read");
});

test("A11-359: a plan that never downloads holds only its run, within the read's time, and the other plans are read and their runs start", async () => {
  const source: TicketSource = { ...base, blockers: async (keys) => none(keys), download: async (ticket, dir) => {
    if (ticket.key === "NBF-1") return never();
    const file = join(dir, `${ticket.key}-plan-x.md`);
    writeFileSync(file, "## Paths\n- `nbl-ui-netbox:src/b.ts`\n");
    return [file];
  } };
  const { pool, entry } = world(["NBF-1", "NBF-2"], source, { plan: "-plan-[^/]*\\.md$" });
  const said = await logged(() => pool.tick());
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["queued", "running"]);
  assert.match(entry("NBF-1").pathsFailure ?? "", /`the download of NBF-1's plan` did not finish within 0\.04s/);
  assert.match(said, /NBF-1: its plan could not be read \(`the download of NBF-1's plan` did not finish within 0\.04s\); it is held and asked again on the next pass, and the other runs go on/);
});

test("A11-359: a read that throws in a way nothing expected is logged and the pass goes on, where it used to return without a word", async () => {
  const source: TicketSource = { ...base, blockers: async (keys) => none(keys) };
  const { pool, entry } = world(["NBF-1"], { ...source, download: () => { throw new Error("EACCES: the plan folder"); } }, { plan: "-plan-[^/]*\\.md$" });
  const said = await logged(() => pool.tick());
  assert.equal(entry("NBF-1").phase, "queued");
  assert.match(said, /NBF-1: its plan could not be read \(EACCES: the plan folder\)/);
});

test("A11-359: whyNothingStarts says what holds the queue: nothing queued or no free slot is nothing to say, a paused queue and a loaded host say so, and each held run says what holds it", () => {
  const { store } = poolFixture({ keys: ["NBF-1", "NBF-2", "NBF-3"], max: 3 });
  const queue = store.get();
  assert.equal(whyNothingStarts({ ...queue, entries: [] }, 1, 4), null, "nothing is queued");
  assert.equal(whyNothingStarts({ ...queue, max: 0 }, 1, 4), null, "a full board starts nothing and says nothing");
  assert.equal(whyNothingStarts({ ...queue, paused: true }, 1, 4), "3 queued, and the queue is paused");
  assert.equal(whyNothingStarts(queue, 5.25, 4), "3 queued, and the host's load is past its 4 cores", "the load is not in the line, which would then be new on every pass");
  const held = { ...queue, entries: queue.entries.map((entry, at) => (at === 0 ? { ...entry, blockers: [BLOCKED], paths: [] } : at === 1 ? { ...entry, blockersFailure: "Linear answered 500" } : { ...entry, blockers: [], paths: undefined })) };
  assert.equal(whyNothingStarts({ ...held, entries: held.entries.map((entry, at) => (at === 2 ? { ...entry, plan: undefined, review: undefined } : entry)) }, 1, 4),
    "3 queued with free slots, and none starts: NBF-1 (Waits for NBF-0: no repository is planned for this ticket, so it cannot stack); NBF-2 (its blockers could not be read: Linear answered 500); NBF-3 (its plan is not read yet)");
});

test("A11-359: a refresh that cannot reach the tracker keeps the blockers each queued run last had, and holds none of them", async () => {
  let down = false;
  const source: TicketSource = { ...base, blockers: async (keys) => {
    if (down) throw new Error("fetch failed (UND_ERR_SOCKET)");
    return new Map(keys.map((key) => [key, key === "NBF-1" ? [BLOCKED] : []]));
  } };
  const { pool, entry } = world(["NBF-1", "NBF-2"], source);
  await pool.tick();
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-2").phase], ["queued", "running"], "NBF-1 waits on its blocker, NBF-2 starts");
  down = true;
  await logged(() => pool.refreshTracker());
  assert.deepEqual(entry("NBF-1").blockers, [BLOCKED], "the last good read stands");
  assert.equal(entry("NBF-1").blockersFailure, undefined, "a run that has a read is not held by a failed refresh");
});

test("A11-359: a refresh that keeps failing is said once for its reason, not on every pass", async () => {
  let down = false;
  const source: TicketSource = { ...base, blockers: async (keys) => { if (down) throw new Error("fetch failed (UND_ERR_SOCKET)"); return new Map(keys.map((key) => [key, [BLOCKED]])); } };
  const { pool } = world(["NBF-1", "NBF-2"], source);
  await pool.tick();
  down = true;
  const first = await logged(() => pool.refreshTracker());
  assert.match(first, /the tracker could not refresh the blockers of 2 queued runs, so their last reads stand and the next refresh asks again \(NBF-1: fetch failed \(UND_ERR_SOCKET\); NBF-2: fetch failed \(UND_ERR_SOCKET\)\)/);
  assert.equal((await logged(() => pool.refreshTracker())).includes("could not refresh"), false, "the same failure is not said again");
});

test("A11-359: fill starts only runs whose blockers and plan are read: a run queued again while the pass read takes no slot from the ready run behind it", async () => {
  const holder: { store?: { get: () => Queue; set: (queue: Queue) => void } } = {};
  const source: TicketSource = { ...base, blockers: async (keys) => none(keys), download: async (ticket, dir) => {
    const file = join(dir, `${ticket.key}-plan-x.md`);
    writeFileSync(file, `## Paths\n- \`nbl-ui-netbox:src/${ticket.key}.ts\`\n`);
    // NBF-1 is queued again while this pass reads (a batch's ticket whose order was just recorded): its blockers are unread again, and nothing says why.
    if (ticket.key === "NBF-1") holder.store!.set({ ...holder.store!.get(), entries: holder.store!.get().entries.map((e) => (e.ticket.key === "NBF-1" ? { ...e, blockers: undefined } : e)) });
    return [file];
  } };
  const fixture = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 1, source, tickets: { plan: "-plan-[^/]*\\.md$" } });
  holder.store = fixture.store;
  await fixture.restart({ readMs: 40 }).tick();
  assert.deepEqual([fixture.entry("NBF-1").phase, fixture.entry("NBF-2").phase], ["queued", "running"], "the one slot goes to the run that can start, not to the one at the head of the queue that cannot");
});

test("A11-359: nextStarts leaves out the runs `ready` refuses, so they take no slot", () => {
  const { store } = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 1 });
  const queue = { ...store.get(), entries: store.get().entries.map((e) => (e.ticket.key === "NBF-2" ? { ...e, blockers: [] } : e)) };
  assert.deepEqual(nextStarts(queue, 1, 4, (entry) => entry.blockers !== undefined).map((e) => e.ticket.key), ["NBF-2"]);
  assert.deepEqual(nextStarts(queue, 1, 4).map((e) => e.ticket.key), ["NBF-1"], "without it the head of the queue takes the slot");
});

test("A11-359: fill() starts no run queued while the pass read the blockers, whose blockers are still unread, and starts the read one beside it", async () => {
  // The guard is fill()'s own (`nextStarts`' ready predicate): a run queued during the read has no blockers and no recorded failure, so nothing else holds it.
  let late: ReturnType<ReturnType<typeof poolFixture>["entry"]> | undefined;
  let fixture: ReturnType<typeof poolFixture> | undefined;
  const source: TicketSource = { ...base, blockers: async (keys) => {
    // NBF-2 is queued while this pass reads NBF-1's blockers, as a batch's ticket whose order was just recorded is.
    const store = fixture!.store;
    if (late !== undefined && !store.get().entries.some((e) => e.ticket.key === "NBF-2")) store.set({ ...store.get(), entries: [...store.get().entries, late] });
    return none(keys);
  } };
  fixture = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 10, source });
  const pool = fixture.restart({ readMs: 40 });
  late = { ...fixture.entry("NBF-2"), blockers: undefined };
  fixture.store.set({ ...fixture.store.get(), entries: fixture.store.get().entries.filter((e) => e.ticket.key !== "NBF-2") });
  await pool.tick();
  const now = (key: string) => fixture!.store.get().entries.find((e) => e.ticket.key === key)!;
  assert.equal(now("NBF-1").phase, "running", "the run whose blockers were read starts");
  assert.deepEqual([now("NBF-2").phase, now("NBF-2").blockers, now("NBF-2").blockersFailure], ["queued", undefined, undefined], "the run queued mid-pass waits for the next pass to read its blockers");
  await pool.tick();
  assert.equal(now("NBF-2").phase, "running", "read on the next pass, it starts");
});
