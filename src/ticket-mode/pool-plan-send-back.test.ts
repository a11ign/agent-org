// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// A11-288: a plan whose `## After-merge checks` section the board refuses goes back to its planner, twice, and then to the person's session, never to the chairman
import { createSettledPool } from "./pool-settled-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { batchDir, herdrName, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { MAX_ASK_CHARS } from "./wait-on/wait-parse.ts";
import { AFTER_MERGE_CHECKS_FORMAT, AFTER_MERGE_CHECKS_HEADING } from "./after-merge/plan-section.ts";
import { MAX_SEND_BACKS, SENT_BACK_FILE } from "./pool-plan-send-back.ts";
import { clearRunDir } from "./pool-prepare.ts";
import { waitingRuns } from "./session-answers.ts";
import { enqueue, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const KEY = "NBF-1";
const OTHER = "NBF-2";
const LINE = "Chairman session: the next release reaches every machine with its UI build.";
const DESCRIPTION = ["Fix it.", "", "## Done-when", "", "### Before merge", "", "* The tests pass.", "", "### After merge", "", `* ${LINE}`, ""].join("\n");
/** The pool's clock starts an hour ahead of the real one, so a file the test writes now is older than a run that ends on it, as a worker's is on a real clock. */
const START = Date.now() + 3_600_000;
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");

const planWith = (evidence: string): string => `# Plan\n\n## Approach\n\nDo it.\n\n${AFTER_MERGE_CHECKS_HEADING}\n\n- \`${LINE}\`\n  - Runner: agent\n  - Evidence: ${evidence}\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n`;
const GOOD = planWith("each machine's update log");
const TOO_LONG = planWith("x".repeat(250));

/** A pool over a planning run of NBF-1 (and NBF-2 with `batch`) over a tracker that holds both with a ticket whose After-merge line is {@link LINE}; herdr refuses every prompt while `herdrRefuses.on`. */
async function planning({ batch = false }: { batch?: boolean } = {}) {
  const root = tmpDir("ticket-plan-send-back-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"),
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: batch ? "plan {keys} into {dir}" : "plan {key} into {dir}", state: "Planned" } } });
  const tracker = createFakeTracker([fakeTicket(KEY, { description: DESCRIPTION }), fakeTicket(OTHER, { description: DESCRIPTION })]);
  const attached: string[] = [];
  const source: TicketSource = { ...tracker, attachPlan: async (key, files, state) => { attached.push(key); return tracker.attachPlan!(key, files, state); } };
  const keys = batch ? [KEY, OTHER] : [KEY];
  let queue: Queue = resumeQueue(enqueue(emptyQueue(2), keys.map((key) => tracker.ticketOf(key)!), { model: "sonnet", effort: "high" }, 0, { keys: new Set(keys), choice: { model: "opus", effort: "max" }, batch }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const herdrRefuses = { on: false };
  const run = (args: string[]): string => {
    if (herdrRefuses.on && args.includes("agent") && args.includes("prompt")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: "agent_blocked" } }) });
    return herdr.run(args);
  };
  const clock = { now: START };
  const pool = createSettledPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: run, hostFile: "/work/.agent-org/host.json", now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost() });
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const dir = batch ? batchDir(settings, "b0-0") : ticketDir(settings, KEY);
  const planOf = (key: string): string => join(dir, "plan", ...(batch ? [key] : []), `${key}-0001-plan-fit.md`);
  let written = Date.now() + 1000;
  /** The planner writes `plans` (by key) and `planned`; the board settles it. The outcome file is dated after every earlier one, as a worker's later write is. */
  const writes = async (plans: Readonly<Record<string, string>>) => {
    for (const [key, text] of Object.entries(plans)) {
      mkdirSync(join(planOf(key), ".."), { recursive: true });
      writeFileSync(planOf(key), text);
    }
    const file = join(dir, "outcome.json");
    writeFileSync(file, JSON.stringify({ kind: "planned" }));
    written += 1000;
    utimesSync(file, new Date(written), new Date(written));
    status.set(herdrName(batch ? "b0-0" : KEY), "idle");
    clock.now += 60_000;
    await pool.tick();
    await settled();
  };
  const tick = async () => { clock.now += 60_000; await pool.tick(); await settled(); };
  const prompts = () => herdr.calls.filter((args) => args.includes("agent") && args.includes("prompt")).map((args) => String(args.at(-1)));
  const entry = (key = KEY) => queue.entries.find((e) => e.ticket.key === key)!;
  return { root, dir, settings, tick, herdrRefuses, writes, prompts, entry, attached, store, ctxFolder: ticketDir(settings, KEY), sent: () => JSON.parse(readFileSync(join(dir, SENT_BACK_FILE), "utf8")) as { count: number; refusals: string[] } };
}

test("A11-288: an over-long Evidence line is sent back to the planner, which fixes it and has the plan attached, with no Needs you", async () => {
  const run = await planning();
  await run.writes({ [KEY]: TOO_LONG });
  assert.equal(run.entry().phase, "running", "the run goes on");
  assert.equal(run.entry().outcome, undefined, "it is not Needs you");
  assert.deepEqual(run.attached, [], "nothing is attached");
  const prompts = run.prompts();
  assert.equal(prompts.length, 1, "one prompt to the planner's pane");
  assert.match(prompts[0], /gives evidence of 250 characters, more than 200: shorten it to one line of at most 200/);
  assert.match(prompts[0], /send-back 1 of 2/);
  const file = join(run.dir, "after-merge-refused-1.md");
  assert.ok(prompts[0].includes(file), "the prompt names the file");
  assert.ok(!prompts[0].includes("\n"), "one line, as every board prompt is");
  assert.match(prompts[0], /wakes you with the person's session's answer to this refusal, apply the section it gives/, "and says what to do if the session's answer wakes it");
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(AFTER_MERGE_CHECKS_FORMAT), "the file holds the exact format");
  assert.ok(text.includes(`${KEY}`) && text.includes(`- ${LINE}`), "and the ticket's After-merge line, with the ticket's key");
  assert.equal(run.sent().count, 1);
  await run.writes({ [KEY]: GOOD });
  assert.deepEqual(run.attached, [KEY], "the fixed plan is attached");
  assert.deepEqual([run.entry().phase, run.entry().planned, run.entry().outcome], ["queued", true, undefined]);
  assert.equal(run.prompts().length, 1, "and the planner is not prompted again");
});

test("A11-288: the same planned outcome is not settled again while the planner works on the send-back", async () => {
  const run = await planning();
  await run.writes({ [KEY]: TOO_LONG });
  for (let i = 0; i < 3; i += 1) await run.tick();
  assert.equal(run.prompts().length, 1);
  assert.equal(run.sent().count, 1);
});

test("A11-288: after two send-backs the third refusal goes to the person's session as a wait, never to the chairman", async () => {
  const run = await planning();
  for (let n = 1; n <= MAX_SEND_BACKS; n += 1) {
    await run.writes({ [KEY]: TOO_LONG });
    assert.equal(run.prompts().length, n);
  }
  assert.equal(waitingRuns(run.store.get()).length, 0, "not yet");
  await run.writes({ [KEY]: TOO_LONG });
  assert.equal(run.prompts().length, MAX_SEND_BACKS, "no third prompt to the planner");
  assert.equal(run.entry().outcome, undefined, "no needs-human");
  assert.equal(run.entry().phase, "running");
  const waiting = waitingRuns(run.store.get());
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].key, KEY);
  assert.match(waiting[0].ask, /^NBF-1's plan: the board refused its ## After-merge checks section 3 times \(.*gives evidence of 250 characters/);
  assert.ok(waiting[0].ask.includes(join(run.dir, "after-merge-refused-3.md")));
  assert.ok(waiting[0].ask.length <= MAX_ASK_CHARS);
  assert.match(run.entry().working?.reason ?? "", /^the board refused the plan's ## After-merge checks section 3 times$/);
  assert.equal(run.entry().working?.until, run.entry().working!.at + 24 * 60 * 60 * 1000, "24 hours from the hand-off");
  assert.equal(run.sent().count, 3);
});

test("A11-288: a prompt herdr refuses counts no send, and the next pass sends it", async () => {
  const run = await planning();
  run.herdrRefuses.on = true;
  await run.writes({ [KEY]: TOO_LONG });
  assert.equal(existsSync(join(run.dir, SENT_BACK_FILE)), false, "no send was counted");
  assert.equal(run.entry().outcome, undefined);
  run.herdrRefuses.on = false;
  await run.writes({ [KEY]: TOO_LONG });
  assert.equal(run.sent().count, 1);
  assert.equal(run.prompts().length, 1);
});

test("A11-288: a refusal that is not about the After-merge section still ends the run for a person", async () => {
  const run = await planning();
  await run.writes({ [KEY]: `# Plan\n\n## Moved to After merge\n\n- \`A line the ticket never had.\` — release — Chairman session\n\n## Paths\n\n- \`agent-org:src/a.ts\`\n` });
  assert.equal(run.entry().outcome?.kind, "needs-human");
  assert.match(reasonOf(run.entry().outcome), /^the plan moves "A line the ticket never had\."/);
  assert.deepEqual(run.prompts(), []);
});

test("A11-288: a batch with one member's section refused attaches neither member in that pass, and attaches both once it is fixed", async () => {
  const run = await planning({ batch: true });
  await run.writes({ [KEY]: GOOD, [OTHER]: TOO_LONG });
  assert.deepEqual(run.attached, [], "NBF-1's good plan is not attached alone");
  assert.equal(run.prompts().length, 1, "one prompt for the run");
  assert.match(run.prompts()[0], /NBF-2: .*gives evidence of 250 characters/);
  assert.ok(!run.prompts()[0].includes("NBF-1:"), "only the refused member is named");
  assert.deepEqual([run.entry(KEY).outcome, run.entry(OTHER).outcome], [undefined, undefined]);
  await run.writes({ [KEY]: GOOD, [OTHER]: GOOD });
  assert.deepEqual([...run.attached].sort(), [KEY, OTHER]);
  assert.deepEqual([run.entry(KEY).planned, run.entry(OTHER).planned, run.entry(KEY).outcome, run.entry(OTHER).outcome], [true, true, undefined, undefined]);
});

test("A11-288: a batch whose refusals pass the limit is handed to the session on every ticket of the run", async () => {
  const run = await planning({ batch: true });
  for (let n = 0; n <= MAX_SEND_BACKS; n += 1) await run.writes({ [KEY]: TOO_LONG, [OTHER]: TOO_LONG });
  assert.equal(run.prompts().length, MAX_SEND_BACKS);
  assert.deepEqual([run.entry(KEY).outcome, run.entry(OTHER).outcome], [undefined, undefined]);
  const waiting = waitingRuns(run.store.get());
  assert.deepEqual(waiting.map(({ keys }) => keys), [[KEY, OTHER]], "one ask for the run");
  assert.ok(waiting[0].ask.length <= MAX_ASK_CHARS);
  assert.ok(run.entry(OTHER).working?.waits !== undefined, "every ticket of the run carries the wait");
});

test("A11-288: a new run starts again at no send-backs: its folder is cleared of the count", async () => {
  const run = await planning();
  await run.writes({ [KEY]: TOO_LONG });
  assert.equal(existsSync(join(run.dir, SENT_BACK_FILE)), true);
  const ctx = { settings: run.settings, deps: { pluginRecord: join(run.root, "no-plugin-record.json") } } as Parameters<typeof clearRunDir>[0];
  clearRunDir(ctx, run.ctxFolder, run.dir);
  assert.equal(existsSync(join(run.dir, SENT_BACK_FILE)), false);
});
