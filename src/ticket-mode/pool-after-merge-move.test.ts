// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
import { createSettledPool } from "./pool-settled-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { batchDir, herdrName, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { ATTACH_WAITS_MS } from "./attach-retry.ts";
import { MOVED_HEADING } from "./after-merge-move.ts";
import { afterMergeLines } from "./done-when.ts";
import { dateOf } from "./pool-answer.ts";
import { parseStamp } from "./plan-stamp.ts";
import { enqueue, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";
import { descriptionHash } from "./ticket-read.ts";

const KEY = "NBF-1";
const RELEASE_LINE = "A real macOS `agent-org update` installing the UI build is quoted.";
/** A11-266's Done-when as it was planned: a Before-merge line that only a published release can meet. */
const DESCRIPTION = ["Fix the update.", "", "## Done-when", "", "### Before merge", "", "* The tests above pass.", `* ${RELEASE_LINE}`, "", "### After merge", "", "* None.", ""].join("\n");
const OTHER = "NBF-2";
const NO_MOVE_PLAN = "# Fit\n\n## Paths\n\n- `agent-org:src/fit.ts`\n";
const planMoving = (bullet: string): string => `# Fit\n\n${MOVED_HEADING}\n\n${bullet}\n\n## Paths\n\n- \`agent-org:src/fit.ts\`\n`;
const RELEASE_MOVE = `- \`\`${RELEASE_LINE}\`\` — release — Chairman session`;
/** The pool's clock starts an hour ahead of the real one, so an outcome file the test writes now is older than a run that ends on it, as a worker's is on a real clock. */
const HOUR_MS = 3_600_000;
const START = Date.now() + HOUR_MS;
/** How many turns of the event loop a tick's attach is given to finish. */
const TURNS = 5;
const settled = async () => { for (let i = 0; i < TURNS; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const networkBlip = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");

/** How the tracker behaves: what it does with the nth attach (from 1) of ticket `key`, and whether it can edit a ticket's text. */
type Tracking = Readonly<{ attempt?: (n: number, key: string) => void; writable?: boolean }>;

/** A tracker that holds NBF-1, and OTHER beside it, wrapped to count its writes and attaches. */
function trackerOf({ attempt = () => {}, writable = true }: Tracking) {
  const tracker = createFakeTracker([fakeTicket(KEY, { description: DESCRIPTION }), fakeTicket(OTHER)]);
  const writes: string[] = [];
  const attached: string[][] = [];
  /** Set to refuse every read from then on, as a tracker that signed the board out would. */
  const reads = { refused: false };
  const { updateTicketText: _cannot, ...readOnly } = tracker;
  const source: TicketSource = { ...(writable ? tracker : readOnly),
    attachPlan: async (key, files, state) => { attached.push([...files]); attempt(attached.length, key); return tracker.attachPlan!(key, files, state); },
    read: async (key) => { if (reads.refused) throw Object.assign(new Error("Linear answered 401: not signed in"), { status: 401 }); return tracker.read(key); },
    ...(writable ? { updateTicketText: async (key: string, text: { description?: string }) => { writes.push(text.description ?? ""); return tracker.updateTicketText!(key, text); } } : {}) };
  return { tracker, source, writes, attached, reads };
}

/**
 * A pool over a planning run of NBF-1 that has written `plan` and `planned`, against a tracker that holds the ticket ({@link trackerOf}). With `batch`, the run plans NBF-1 and OTHER together, and OTHER's plan moves nothing.
 * Paused after its first tick, so a freed slot starts nothing.
 */
async function planned(plan: string, { batch = false, ...tracking }: Tracking & { batch?: boolean } = {}) {
  const root = tmpDir("ticket-after-merge-move-");
  const run = batch ? "plan {keys} into {dir}" : "plan {key} into {dir}";
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"), tickets: { plan: "-plan-[^/]*\\.md$", planner: { run, state: "Planned" } } });
  const { tracker, source, writes, attached, reads } = trackerOf(tracking);
  const keys = batch ? [KEY, OTHER] : [KEY];
  let queue: Queue = resumeQueue(enqueue(emptyQueue(2), keys.map((key) => tracker.ticketOf(key)!), { model: "sonnet", effort: "high" }, 0, { keys: new Set(keys), choice: { model: "opus", effort: "max" }, batch }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const clock = { now: START };
  const pool = createSettledPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost() });
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const dir = batch ? batchDir(settings, "b0-0") : ticketDir(settings, KEY);
  const planOf = (key: string): string => join(dir, "plan", ...(batch ? [key] : []), `${key}-0001-plan-fit.md`);
  for (const key of keys) {
    mkdirSync(join(planOf(key), ".."), { recursive: true });
    writeFileSync(planOf(key), key === KEY ? plan : NO_MOVE_PLAN);
  }
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(batch ? "b0-0" : KEY), "idle");
  const tick = async (after = 0) => { clock.now += after; await pool.tick(); await settled(); };
  const entry = (key = KEY) => queue.entries.find((e) => e.ticket.key === key)!;
  return { tick, entry, writes, attached, reads, planFile: planOf(KEY), held: () => tracker.ticketOf(KEY)!.description };
}

test("A11-275: a plan that moves a release-only line has the ticket rewritten before the plan is attached: the line is under After merge with who runs it, and the Decisions entry is there", async () => {
  const made = await planned(planMoving(RELEASE_MOVE));
  await made.tick();
  const held = made.held();
  assert.equal(made.writes.length, 1, "the board wrote the ticket once");
  assert.ok(!held.split("### After merge")[0].includes(RELEASE_LINE), "the line has left Before merge");
  assert.deepEqual(afterMergeLines(held).map(({ owner }) => owner), ["Chairman session"], "the After-merge checks list holds it, with who runs it");
  assert.ok(held.includes(`## Decisions (the planner, ${dateOf(START)})\n\n* **${RELEASE_LINE}** is an After-merge check, run by Chairman session: it needs a published release. Reviewers do not block a pull request on it.`));
  assert.deepEqual([made.entry().phase, made.entry().planned, made.entry().outcome], ["queued", true, undefined], "the plan is attached and the ticket queued to be worked");
  assert.equal(made.entry().ticket.description, held, "the run's copy of the ticket moved on with the write");
  const stamp = parseStamp(readFileSync(made.planFile, "utf8"));
  assert.equal(stamp?.hash, descriptionHash(held), "the plan is stamped with the rewritten text, so the board's own write does not read it as stale");
  assert.equal(made.entry().plannedAgainst?.hash, descriptionHash(held));
});

test("A11-275: an attach tried again after a network failure writes nothing twice, and stamps the plan with the same rewritten text", async () => {
  const made = await planned(planMoving(RELEASE_MOVE), { attempt: (n) => { if (n === 1) throw networkBlip(); } });
  await made.tick();
  assert.equal(made.attached.length, 1);
  assert.equal(made.entry().phase, "running", "waiting to try the attach again");
  const once = made.held();
  await made.tick(ATTACH_WAITS_MS[0]);
  assert.equal(made.attached.length, 2, "attached on the retry");
  assert.equal(made.writes.length, 1, "the ticket was not written again");
  assert.equal(made.held(), once);
  assert.equal(made.held().match(/^## Decisions/gm)?.length, 1, "one Decisions entry");
  assert.equal(parseStamp(readFileSync(made.planFile, "utf8"))?.hash, descriptionHash(once), "the retry's stamp is the rewritten text too");
  assert.deepEqual([made.entry().phase, made.entry().planned, made.entry().outcome], ["queued", true, undefined]);
});

test("A11-275: a plan quoting a line that is not under Before merge is refused: nothing is attached and the ticket is left as it is", async () => {
  const made = await planned(planMoving("- `A line the ticket never had.` — release — Chairman session"));
  await made.tick();
  assert.deepEqual([made.attached, made.writes], [[], []]);
  assert.equal(made.held(), DESCRIPTION);
  assert.match(reasonOf(made.entry().outcome), /^the plan moves "A line the ticket never had\." to After merge, but the ticket holds no such line under its `### Before merge` heading$/);
});

test("A11-275: a tracker that cannot edit a ticket's text still has the plan attached, stamped with the text the planner read", async () => {
  const made = await planned(planMoving(RELEASE_MOVE), { writable: false });
  await made.tick();
  assert.equal(made.attached.length, 1);
  assert.equal(made.held(), DESCRIPTION, "the ticket is left as it is");
  assert.deepEqual([made.entry().phase, made.entry().planned], ["queued", true]);
  assert.equal(parseStamp(readFileSync(made.planFile, "utf8"))?.hash, descriptionHash(DESCRIPTION));
});

test("A11-275: a plan that moves nothing leaves the ticket unwritten", async () => {
  const made = await planned(NO_MOVE_PLAN);
  await made.tick();
  assert.deepEqual([made.attached.length, made.writes], [1, []]);
  assert.equal(made.held(), DESCRIPTION);
});

test("A11-275: a batch whose attach is tried again after a network failure attaches the plan that moved a line again, rather than refusing it for the board's own Decisions entry", async () => {
  const made = await planned(planMoving(RELEASE_MOVE), { batch: true, attempt: (n, key) => { if (n === 2 && key === OTHER) throw networkBlip(); } });
  await made.tick();
  assert.equal(made.writes.length, 1, "NBF-1's ticket was rewritten as its plan was attached");
  await made.tick(ATTACH_WAITS_MS[0]);
  assert.equal(made.writes.length, 1, "and not again on the retry");
  for (const key of [KEY, OTHER]) assert.deepEqual([made.entry(key).planned, made.entry(key).outcome], [true, undefined], `${key} is planned, and not handed to a person`);
});

test("A11-275: a tracker that refuses to read the ticket still has the plan attached, and the ticket is left as it is", async () => {
  const made = await planned(planMoving(RELEASE_MOVE));
  made.reads.refused = true;
  await made.tick();
  assert.deepEqual([made.attached.length, made.writes], [1, []]);
  assert.deepEqual([made.entry().phase, made.entry().planned, made.entry().outcome], ["queued", true, undefined]);
});
