// no-token: none -- the board's dependency sweep over the fake code host, an in-memory queue, a stub tracker and a state directory that is temporary
// A11-428: the board's own sweep asks the writer for the fix of a check held as red on main, queues the one ticket it made, asks again after a run that made none, and asks nothing when the machine turned it off
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { emptyQueue, writerEnded } from "../queue.ts";
import type { Entry, Queue, RunChoice } from "../queue/queue-entries-and-outcomes.ts";
import type { TicketSettings } from "../settings.ts";
import type { Ticket } from "../source.ts";
import { boardDependencySweep, DEPENDENCY_TICKETS_FILE } from "../dependency-updates/board.ts";
import { RETRY_MS } from "../dependency-updates/sweep.ts";
import { loadState } from "../dependency-updates/filed.ts";
import { DEPENDENCY_EPIC } from "../dependency-updates/ticket-request.ts";
import { fixKey } from "./fix-record.ts";

const REPO = "a11ign/agent-org";
const CHECK = "checks (unit)";
const URL_1 = `https://github.com/${REPO}/pull/1800`;
const HEAD = "1a2b3c4d".padEnd(40, "0");

/** A run held on `checks (unit)` with no owner, as the watch records it (A11-428). */
const held = (): Entry => ({
  ticket: { key: "A11-500" }, phase: "finished", outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: URL_1 }] }, pullStates: { [URL_1]: "open" },
  checkHeads: { [URL_1]: { head: HEAD, step: "not-ours", note: `${CHECK} is red on main / not this run's`, notOurs: { [CHECK]: null }, unowned: { [CHECK]: ["not ok 3 - migrate-host collects no tests"] } } },
}) as unknown as Entry;

/** The board's sweep over a queue holding the held run, with `tickets.fixRedMain` as given. */
function board(fixRedMain: boolean) {
  const stateDir = tmpDir("main-red-sweep-");
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  const queuePath = join(stateDir, "tickets", "queue.json");
  let queue: Queue = { ...emptyQueue(2), paused: false, entries: [held()] };
  const store = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const queued: { keys: string[]; choice: RunChoice; plan: boolean }[] = [];
  const clock = { at: 1_700_000_000_000 };
  const read = async (key: string): Promise<Ticket | null> => (key === DEPENDENCY_EPIC ? ({ key, title: "Dependencies", team: "A11" } as Ticket) : ({ key, title: key } as Ticket));
  const settings = { clones: {}, stateDir, writer: { model: "opus", effort: "high" }, fixRedMain } as unknown as TicketSettings;
  const sweep = boardDependencySweep({
    settings, source: { read } as never, codeHost: createFakeCodeHost("fake-worker"), store, queuePath, repositories: () => [],
    choice: () => ({ model: "sonnet", effort: "medium" }), queueTickets: (tickets, choice, options) => void queued.push({ keys: tickets.map(({ key }) => key), choice, plan: options.plan }),
    wake: () => {}, now: () => clock.at,
  });
  const finish = (n: number, keys: readonly string[]) => {
    const id = store.get().writers![n]!.id;
    store.set(writerEnded(store.get(), id, { tickets: keys.map((key) => ({ key, url: `https://linear.app/x/${key}`, inPick: true })) }, clock.at));
  };
  return { sweep, store, queued, clock, finish, record: () => loadState(join(stateDir, "tickets", DEPENDENCY_TICKETS_FILE)).tickets };
}

test("A11-428: the sweep asks the writer once for the held check's fix, quoting its error lines, and queues the one ticket it made on the saved choice", async () => {
  const b = board(true);
  await b.sweep();
  await b.sweep();
  const writers = b.store.get().writers ?? [];
  assert.equal(writers.length, 1, "one request, however many sweeps");
  assert.match(writers[0]!.request, /^unattended: file one ticket to fix a check that is red on the default branch\./);
  assert.ok(writers[0]!.request.includes("not ok 3 - migrate-host collects no tests"), "the request quotes the check's error lines");
  assert.equal(b.record()[fixKey(REPO, CHECK)]?.state, "requested");
  b.finish(0, ["A11-600"]);
  await b.sweep();
  assert.deepEqual(b.queued, [{ keys: ["A11-600"], choice: { model: "sonnet", effort: "medium" }, plan: false }], "the ticket is queued on the saved choice, with no person");
  assert.deepEqual(b.record()[fixKey(REPO, CHECK)], { state: "filed", ticket: "A11-600", queue: true, queued: true });
});

test("A11-428: a writer run that made no ticket is asked again by a later sweep, once the sweep's wait has passed", async () => {
  const b = board(true);
  await b.sweep();
  b.finish(0, []);
  await b.sweep();
  assert.equal(b.record()[fixKey(REPO, CHECK)]?.state, "failed");
  assert.equal((b.store.get().writers ?? []).length, 1, "not asked again at once");
  b.clock.at += RETRY_MS;
  await b.sweep();
  assert.equal((b.store.get().writers ?? []).length, 2, "asked again later, as the Dependabot sweep asks a failed request again");
});

test("A11-428: with tickets.fixRedMain off, the sweep asks the writer for no fix", async () => {
  const b = board(false);
  await b.sweep();
  assert.deepEqual([b.store.get().writers ?? [], b.record()], [[], {}]);
});
