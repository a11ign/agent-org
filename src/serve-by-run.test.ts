// no-token: none -- every `gh`, `claude` and herdr call is an injected stub; nothing here reaches a tracker, a model or a pane.
/**
 * agent-org#904 (Move 3 cutover seam of a11ign/a11ign#4505): AN ORDER WHOSE CLASS IS `run` IS SERVED BY A RUN, AND EVERY FAILURE FALLS BACK TO THE SEAT.
 *
 * POSITIVE CONTROL: a fixture class set to `run`, with a stub executor and port, is `served`, the seat is NOT prompted through `deliver`, the delivery is recorded, and the
 * `served-by-run` line the trace reads carries `servedBy: "run"` and the run's id (and becomes a wake event that says so).
 * NEGATIVE CONTROL, each its own case: the same class on `seat`, with no seats file and with a malformed one is byte-identical to `deliver` called without the seam (the order is
 * a literal longer than 100 bytes); a `runDecision` failure, a `stale` apply, a `held` lease and a class absent from the registry each FALL BACK, write nothing, and the seat IS
 * prompted with the original order.
 */
import { moduleSource } from "./lib/source-text-reads.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver as settlingDeliver } from "./wake/fyi-queue.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { leaseItem, leasePath } from "./decision-run/apply.ts";
import { loadClasses, type DecisionClass } from "./decision-run/registry.ts";
import { causeOfOrder, itemOfKey, serveByRun, serveOrdersByRun, servedByRunPathFrom, type ServeByRunDeps, type ServeOrder } from "./serve-by-run.ts";
import { servedWakeEvents } from "./trace/trace.ts";
import type { ItemRef, TicketItem, TicketPort } from "./ticket-port/port.ts";

const ROOT = mkdtempSync(join(tmpdir(), "serve-by-run-904-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let made = 0;
const fresh = (): string => { const dir = join(ROOT, `case-${made += 1}`); mkdirSync(dir, { recursive: true }); return dir; };

// --- the fixture: one class, one item, one order ------------------------------------------------------------------------------------------------

const REF: ItemRef = { tracker: "github", scope: "a11ign/agent-org", id: 904 };
const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const ITEM: TicketItem = {
  ref: REF, title: "A row", body: "What it is.", state: "ready", flags: [],
  relations: { blockedBy: [], parent: null, children: [], linkedChanges: [], notBefore: null, waitingFor: [] },
  events: [{ at: "2026-10-12T09:00:00.000Z", actor: "someone", kind: "item-opened" }],
};
/** An order longer than 100 bytes, so a delivery that dropped or reordered a part of it cannot go unseen. */
const ORDER_TEXT = "agent-org#904 is `ready` and carries an `answer-owed:ceo` flag: decide whether it may start, and say which of the two answers you chose and why in one sentence.";
const ORDER: ServeOrder = { session: "ceo", cause: "answer-owed", causeKey: "ceo/answer-owed/agent-org#904", prompt: ORDER_TEXT };

/** The class module's source: plain JS, which a `.ts` file may be (`registry.test.ts` does the same). */
const CLASS_SOURCE = `export default {
  cause: "answer-owed",
  schema: { type: "object", required: ["answer", "text"], properties: { answer: { type: "string" }, text: { type: "string" } } },
  allowed: ["approve", "hold"],
  buildQuestion: () => ({ text: "May it start?", default: "hold", allowed: ["approve", "hold"] }),
  actionsFor: (decision) => [
    { type: "post", item: { tracker: "github", scope: "a11ign/agent-org", id: 904 }, kind: "decision", text: decision.text },
    { type: "change", item: { tracker: "github", scope: "a11ign/agent-org", id: 904 }, change: { state: "ready" } },
  ],
};\n`;
const classesDir = (source = CLASS_SOURCE): string => {
  const dir = fresh();
  writeFileSync(join(dir, "answer-owed.ts"), source);
  return dir;
};

type PortLog = { posts: unknown[]; changes: unknown[] };
function stubPort(item: TicketItem | null = ITEM): { port: TicketPort; log: PortLog } {
  const log: PortLog = { posts: [], changes: [] };
  const port = {
    readItem: () => item,
    postDecision: (_ref: ItemRef, decision: unknown) => { log.posts.push(decision); return "comment-1"; },
    changeState: (_ref: ItemRef, change: unknown) => { log.changes.push(change); return true; },
  } as unknown as TicketPort;
  return { port, log };
}

const RUN_REPLY = JSON.stringify({ structured_output: { answer: "approve", text: "It may start." }, session_id: "run-abc", total_cost_usd: 0.01,
  usage: { cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } });
type Exec = NonNullable<Parameters<typeof serveOrdersByRun>[1]["exec"]>;
const execReplying = (stdout: string, exitCode = 0): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, exec: async (argv) => { calls.push([...argv]); return { exitCode, stdout, timedOut: false }; } };
};

type Scenario = {
  seats?: string | null; apply?: ServeByRunDeps["apply"]; item?: TicketItem | null; exec?: Exec; classes?: string; heldBy?: string;
};
/** One tick: the seats file, the registry, the stubs, `serveOrdersByRun`, and then `deliver` with the map it returned. */
async function tick(scenario: Scenario = {}, orders: ServeOrder[] = [ORDER]) {
  const projectDir = fresh();
  const stateDir = fresh();
  if (scenario.seats !== null) {
    mkdirSync(join(projectDir, ".agent-org"));
    writeFileSync(join(projectDir, ".agent-org", "seats.json"), scenario.seats ?? JSON.stringify({ "answer-owed": "run" }));
  }
  if (scenario.heldBy !== undefined) leaseItem(stateDir, REF, scenario.heldBy, NOW);
  const { port, log } = stubPort(scenario.item === undefined ? ITEM : scenario.item);
  const replying = execReplying(RUN_REPLY);
  const said: string[] = [];
  const ledgerPath = join(stateDir, "wake-ledger");
  const served = await serveOrdersByRun(orders, {
    ledgerPath, projectDir, gh: () => { throw new Error("no gh in this test"); }, scopeOf: () => "a11ign/agent-org", roleBrief: () => "# ceo\nYou decide.",
    classesDir: scenario.classes ?? classesDir(), port: () => port, exec: scenario.exec ?? replying.exec, apply: scenario.apply, now: () => NOW,
    decisionDeps: { host: {} }, diagnostic: (line) => said.push(line),
  });
  const rec = recorder();
  const recorded: string[] = [];
  const result = deliverWith(orders, { run: rec.run, record: (key) => recorded.push(key), serve: (order) => served.get(order.causeKey) ?? null });
  return { served, said, log, exec: replying, rec, recorded, result, stateDir, ledgerPath };
}

// --- `deliver`, driven the way `wake-followup-header.test.ts` drives it ----------------------------------------------------------------------------

const noSettle = () => {};
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-904-no-transcripts");
const FAKE_HEAD = "d".repeat(40);
const FAKE_CHECKOUT = { git: () => `${FAKE_HEAD}\n`, exists: () => true, link: () => null, root: "/fake-reviews", repoRoot: "/fake-primary" };
const DELIVERED_AT = 1_791_000_000_000;
function deliverWith(orders: ServeOrder[], deps: Partial<Parameters<typeof settlingDeliver>[3]>) {
  return settlingDeliver(orders as never, [{ label: "ceo", status: "idle" }], ["ceo"],
    { contextRoot: NO_TRANSCRIPTS, checkout: FAKE_CHECKOUT, now: () => DELIVERED_AT, ...deps, sleep: noSettle });
}
function recorder() {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    return pane(args) ?? "{}";
  };
  const prompts = () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt");
  return { run, calls, ordered: (label: string) => prompts().filter((c) => c[4] === label && c[5] !== "/clear").map((c) => c[5]) };
}

// --- POSITIVE CONTROL ----------------------------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: a class set to `run` is served, the seat is NOT prompted, and the trace line carries servedBy run and the run id", async () => {
  const t = await tick();
  const record = t.served.get(ORDER.causeKey);
  assert.ok(record, `the order is served: ${t.said.join(" | ")}`);
  assert.deepEqual({ ...record }, { servedBy: "run", at: NOW, session: "ceo", cause: "answer-owed", causeKey: ORDER.causeKey, runId: "run-abc", tier: "haiku", outcome: "wrote" });
  // The run was asked once, at the default tier, and its decision was written once under the run's own id.
  assert.equal(t.exec.calls.length, 1, "the run was started once");
  assert.equal(t.exec.calls[0][t.exec.calls[0].indexOf("--model") + 1], "haiku", "at the default tier: the class has no tier question");
  assert.deepEqual(t.log.posts, [{ role: "ceo", runId: "run-abc", kind: "decision", text: "It may start." }]);
  assert.deepEqual(t.log.changes, [{ state: "ready" }]);
  // THE SEAT IS NOT PROMPTED, and the delivery is recorded so the gate does not derive the cause again for the wake window.
  assert.deepEqual(t.rec.ordered("ceo"), []);
  assert.deepEqual(t.recorded, [ORDER.causeKey]);
  assert.ok(t.result.sent.some((line) => line.includes("SERVED BY RUN run-abc")), t.result.sent.join("\n"));
  // The lease the run held is gone, and the `served-by-run` line is what the trace reads.
  assert.equal(existsSync(leasePath(t.stateDir, REF)), false, "the lease is released");
  const lines = readFileSync(servedByRunPathFrom(t.ledgerPath), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [record]);
  const events = servedWakeEvents({ files: [servedByRunPathFrom(t.ledgerPath)], held: new Map() });
  assert.deepEqual(events.failed, []);
  assert.equal(events.events.length, 1);
  assert.deepEqual({ kind: events.events[0].kind, session: events.events[0].session, outcome: events.events[0].outcome, runId: events.events[0].runId, causeKey: events.events[0].causeKey, servedBy: (events.events[0] as { servedBy?: string }).servedBy },
    { kind: "wake", session: "ceo", outcome: "wrote", runId: "run-abc", causeKey: ORDER.causeKey, servedBy: "run" });
  // A line the store already holds is not built twice, and a second read of the file adds nothing new.
  const held = new Map([[events.events[0].id, 0]]);
  assert.deepEqual(servedWakeEvents({ files: [servedByRunPathFrom(t.ledgerPath)], held }).events, []);
});

test("POSITIVE CONTROL: the executor is called once with the brief on stdin and the tier question's pick starts the run at Sonnet", async () => {
  const stateDir = fresh();
  const projectDir = fresh();
  mkdirSync(join(projectDir, ".agent-org"));
  writeFileSync(join(projectDir, ".agent-org", "seats.json"), JSON.stringify({ "answer-owed": "run" }));
  const withTier = CLASS_SOURCE.replace("actionsFor:", "tierQuestion: () => ({ text: \"Which tier?\", default: \"haiku\", allowed: [\"haiku\", \"sonnet\"] }),\n  actionsFor:");
  const seen: { argv: readonly string[]; stdin: string }[] = [];
  const { port } = stubPort();
  const asked: string[] = [];
  const served = await serveOrdersByRun([ORDER], {
    ledgerPath: join(stateDir, "wake-ledger"), projectDir, gh: () => "", scopeOf: () => "a11ign/agent-org", roleBrief: () => "# ceo",
    classesDir: classesDir(withTier), port: () => port, now: () => NOW, decisionDeps: { host: {} },
    exec: async (argv, options) => { seen.push({ argv, stdin: options.stdin }); return { exitCode: 0, stdout: RUN_REPLY, timedOut: false }; },
    decide: async (_use, _state, questions) => {
      asked.push(Object.keys(questions).join(","));
      return { use: "model-routing", via: "jev", fellBack: false, answers: { tier: { value: "sonnet", confidence: 0.99, fellBack: false } } };
    },
  });
  assert.equal(served.get(ORDER.causeKey)?.tier, "sonnet");
  assert.deepEqual(asked, ["tier"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].argv[seen[0].argv.indexOf("--model") + 1], "sonnet");
  assert.match(seen[0].stdin, /May it start\?/);
});

test("a tier answer under the provider's floor starts the run at Sonnet and a provider that was never reached starts it at Haiku", async () => {
  const run = async (answer: { value: string; fellBack: boolean; asked?: string }) => {
    const projectDir = fresh();
    mkdirSync(join(projectDir, ".agent-org"));
    writeFileSync(join(projectDir, ".agent-org", "seats.json"), JSON.stringify({ "answer-owed": "run" }));
    const { port } = stubPort();
    const withTier = CLASS_SOURCE.replace("actionsFor:", "tierQuestion: () => ({ text: \"t\", default: \"haiku\", allowed: [\"haiku\", \"sonnet\"] }),\n  actionsFor:");
    const served = await serveOrdersByRun([ORDER], {
      ledgerPath: join(fresh(), "wake-ledger"), projectDir, gh: () => "", scopeOf: () => "a11ign/agent-org", roleBrief: () => "# ceo", classesDir: classesDir(withTier),
      port: () => port, now: () => NOW, decisionDeps: { host: {} }, exec: execReplying(RUN_REPLY).exec,
      decide: async () => ({ use: "model-routing", via: "jev", fellBack: answer.fellBack, answers: { tier: answer } }),
    });
    return served.get(ORDER.causeKey)?.tier;
  };
  assert.equal(await run({ value: "haiku", fellBack: true, asked: "sonnet" }), "sonnet", "answered under the floor: low confidence asks the larger model");
  assert.equal(await run({ value: "haiku", fellBack: true }), "haiku", "never asked: the class's default");
  assert.equal(await run({ value: "haiku", fellBack: false }), "haiku");
});

// --- NEGATIVE CONTROLS ---------------------------------------------------------------------------------------------------------------------------

/** What the seat is sent when nothing is served: the order, through `deliver`, with no seam at all. */
function baseline() {
  const rec = recorder();
  const recorded: string[] = [];
  const result = deliverWith([ORDER], { run: rec.run, record: (key) => recorded.push(key) });
  return { typed: rec.ordered("ceo"), calls: rec.calls, recorded, sent: result.sent };
}

test("NEGATIVE CONTROL: the class on `seat` is byte-identical to the delivery with no seam, and the run is never started", async () => {
  const before = baseline();
  assert.equal(before.typed.length, 1);
  assert.ok(Buffer.byteLength(ORDER_TEXT, "utf8") > 100, "the pinned order is longer than 100 bytes");
  assert.ok(before.typed[0].includes(ORDER_TEXT), "the order text is typed whole");
  for (const [name, seats] of [["seat", JSON.stringify({ "answer-owed": "seat" })], ["no file", null], ["malformed", "{ not json"], ["empty", "{}"]] as const) {
    const t = await tick({ seats });
    assert.equal(t.served.size, 0, name);
    assert.equal(t.log.posts.length + t.log.changes.length, 0, `${name}: nothing was written`);
    assert.deepEqual(t.rec.calls, before.calls, `${name}: every herdr call is the one the seam-less delivery makes`);
    assert.deepEqual(t.rec.ordered("ceo"), before.typed, name);
    assert.deepEqual(t.recorded, before.recorded, name);
    assert.deepEqual(t.result.sent, before.sent, name);
    assert.equal(Buffer.byteLength(t.rec.ordered("ceo")[0], "utf8"), Buffer.byteLength(before.typed[0], "utf8"), `${name}: the flag-off order's byte length`);
    assert.equal(existsSync(servedByRunPathFrom(t.ledgerPath)), false, `${name}: no served-by-run line`);
  }
});

test("NEGATIVE CONTROL: serveByRun itself reads `seat` for a class the file does not set to `run`, before it leases, reads or runs anything", async () => {
  const classes = await loadClasses(classesDir());
  for (const [name, seats] of [["seat", JSON.stringify({ "answer-owed": "seat" })], ["other value", JSON.stringify({ "answer-owed": "sometimes" })], ["not named", "{}"]] as const) {
    const dir = fresh();
    const stateDir = fresh();
    writeFileSync(join(dir, "seats.json"), seats);
    const { port, log } = stubPort();
    const replying = execReplying(RUN_REPLY);
    const result = await serveByRun(ORDER, {
      classes, seats: { path: join(dir, "seats.json"), diagnostic: () => {} }, itemOf: () => REF, port: () => port, run: { exec: replying.exec, cwd: dir },
      stateDir, roleExcerpt: () => "# ceo", now: () => NOW,
    });
    assert.deepEqual(result, { outcome: "fallback", reason: "seat-mode" }, name);
    assert.equal(replying.calls.length, 0, `${name}: no run was started`);
    assert.equal(existsSync(leasePath(stateDir, REF)), false, `${name}: no lease was taken`);
    assert.deepEqual(log, { posts: [], changes: [] }, name);
  }
});

test("NEGATIVE CONTROL: a `serve` that is absent and one that answers null are the same delivery", () => {
  const without = recorder();
  const withNull = recorder();
  const a = deliverWith([ORDER], { run: without.run });
  const b = deliverWith([ORDER], { run: withNull.run, serve: () => null });
  assert.deepEqual(withNull.calls, without.calls);
  assert.deepEqual(b, a);
});

/** A fallback: the reason it names, nothing written, and the seat IS prompted with the original order, exactly as the seam-less delivery prompts it. */
async function assertFalls(name: string, scenario: Scenario, reason: RegExp) {
  const before = baseline();
  const t = await tick(scenario);
  assert.equal(t.served.size, 0, `${name}: not served`);
  assert.ok(t.said.some((line) => reason.test(line)), `${name}: the fallback says why (${reason}): ${t.said.join(" | ")}`);
  assert.deepEqual(t.log.posts, [], `${name}: no decision was posted`);
  assert.deepEqual(t.log.changes, [], `${name}: nothing was changed`);
  assert.deepEqual(t.rec.ordered("ceo"), before.typed, `${name}: the seat is prompted with the original order`);
  assert.ok(t.rec.ordered("ceo")[0].includes(ORDER_TEXT), `${name}: the order text is typed whole`);
  assert.deepEqual(t.recorded, before.recorded, name);
  assert.equal(existsSync(servedByRunPathFrom(t.ledgerPath)), false, `${name}: no served-by-run line`);
  return t;
}

test("NEGATIVE CONTROL: a runDecision failure falls back and the seat is prompted", async () => {
  await assertFalls("exit-nonzero", { exec: execReplying("", 1).exec }, /run:exit-nonzero/);
  await assertFalls("unparseable", { exec: execReplying("not json").exec }, /run:unparseable/);
  await assertFalls("schema-mismatch", { exec: execReplying(JSON.stringify({ structured_output: { answer: 3 }, session_id: "r" })).exec }, /run:schema-mismatch/);
  await assertFalls("timeout", { exec: async () => ({ exitCode: 0, stdout: "", timedOut: true }) }, /run:timeout/);
  await assertFalls("exec rejects", { exec: async () => { throw new Error("spawn claude ENOENT"); } }, /run:exit-nonzero/);
});

test("NEGATIVE CONTROL: a stale apply falls back and the seat is prompted", async () => {
  // The REAL apply: the item gained an event after the brief was read (`NOW`), so it is `stale` and nothing is written.
  const moved: TicketItem = { ...ITEM, events: [...ITEM.events, { at: "2026-10-12T10:00:01.000Z", actor: "someone", kind: "flag-added" }] };
  const t = await assertFalls("stale (real apply)", { item: moved, apply: undefined }, /apply:stale/);
  assert.equal(t.exec.calls.length, 1, "the run answered, and the apply's re-read is what found the item had moved");
  // An injected apply that says `stale`, as a port that changed between the read and the write would.
  await assertFalls("stale (injected apply)", { apply: () => ({ outcome: "stale", newestAt: "2026-10-12T10:00:01.000Z" }) }, /apply:stale/);
  await assertFalls("unreadable apply", { apply: () => ({ outcome: "unreadable" }) }, /apply:unreadable/);
  await assertFalls("refused apply", { apply: () => ({ outcome: "refused", answer: "x", allowed: ["approve"] }) }, /apply:refused/);
});

test("NEGATIVE CONTROL: a held lease falls back and the seat is prompted, and the holder's lease is left alone", async () => {
  const t = await assertFalls("held", { heldBy: "another-run" }, /lease-held/);
  assert.equal(existsSync(leasePath(t.stateDir, REF)), true, "another run's lease is not released by this one");
  assert.equal(JSON.parse(readFileSync(leasePath(t.stateDir, REF), "utf8")).runId, "another-run");
});

test("NEGATIVE CONTROL: a class absent from the registry falls back and the seat is prompted", async () => {
  // The file says `run` for a cause nothing registers: the registry is the authority, and an empty directory is no classes.
  const t = await tick({ classes: fresh() });
  assert.equal(t.served.size, 0);
  assert.deepEqual(t.rec.ordered("ceo"), baseline().typed);
  // And at the single-order level the reason is named.
  const { port } = stubPort();
  const result = await serveByRun(ORDER, {
    classes: new Map(), seats: { path: join(fresh(), "seats.json") }, itemOf: () => REF, port: () => port, run: { exec: execReplying(RUN_REPLY).exec, cwd: fresh() },
    stateDir: fresh(), roleExcerpt: () => "x",
  });
  assert.deepEqual(result, { outcome: "fallback", reason: "no-class" });
});

test("NEGATIVE CONTROL: an item that cannot be read, a role brief that cannot be read and an order that names no item each fall back", async () => {
  await assertFalls("unreadable item", { item: null }, /unreadable/);
  const base = await tick();
  assert.ok(base.served.has(ORDER.causeKey), "the same fixture IS served when each of those is readable");
  const { port } = stubPort();
  const classes = await loadClasses(classesDir());
  const dir = fresh();
  writeFileSync(join(dir, "seats.json"), JSON.stringify({ "answer-owed": "run" }));
  const deps = (over: Partial<ServeByRunDeps>): ServeByRunDeps => ({
    classes, seats: { path: join(dir, "seats.json") }, itemOf: () => REF, port: () => port, run: { exec: execReplying(RUN_REPLY).exec, cwd: dir },
    stateDir: fresh(), roleExcerpt: () => "# ceo", now: () => NOW, ...over,
  });
  assert.deepEqual(await serveByRun(ORDER, deps({ roleExcerpt: () => null })), { outcome: "fallback", reason: "no-brief-parts" });
  assert.deepEqual(await serveByRun(ORDER, deps({ itemOf: () => null })), { outcome: "fallback", reason: "no-item" });
  assert.equal((await serveByRun(ORDER, deps({}))).outcome, "served", "the positive control of this case");
});

test("NEGATIVE CONTROL: an answer the class turns into no post, or into several, is the seat's", async () => {
  const noPost = CLASS_SOURCE.replace(/actionsFor: [\s\S]*\],\n\};/, "actionsFor: () => [],\n};");
  await assertFalls("no action", { classes: classesDir(noPost) }, /no-action/);
  const elsewhere = CLASS_SOURCE.replace('id: 904 }, kind', 'id: 7 }, kind');
  await assertFalls("another item", { classes: classesDir(elsewhere) }, /no-action/);
  const noAnswer = CLASS_SOURCE.replace('required: ["answer", "text"]', 'required: ["text"]');
  const { port } = stubPort();
  const classes = await loadClasses(classesDir(noAnswer));
  const dir = fresh();
  writeFileSync(join(dir, "seats.json"), JSON.stringify({ "answer-owed": "run" }));
  const result = await serveByRun(ORDER, {
    classes, seats: { path: join(dir, "seats.json") }, itemOf: () => REF, port: () => port, stateDir: fresh(), roleExcerpt: () => "x", now: () => NOW,
    run: { exec: execReplying(JSON.stringify({ structured_output: { text: "no answer given" }, session_id: "r" })).exec, cwd: dir },
  });
  assert.deepEqual(result, { outcome: "fallback", reason: "no-answer" });
});

test("NEGATIVE CONTROL: a tick starts at most `maxRuns` runs and the rest fall back to their seats", async () => {
  const projectDir = fresh();
  mkdirSync(join(projectDir, ".agent-org"));
  writeFileSync(join(projectDir, ".agent-org", "seats.json"), JSON.stringify({ "answer-owed": "run" }));
  const orders: ServeOrder[] = [904, 905, 906].map((n) => ({ ...ORDER, causeKey: `ceo/answer-owed/agent-org#${n}` }));
  const said: string[] = [];
  const { port } = stubPort();
  const served = await serveOrdersByRun(orders, {
    ledgerPath: join(fresh(), "wake-ledger"), projectDir, gh: () => "", scopeOf: () => "a11ign/agent-org", roleBrief: () => "# ceo", classesDir: classesDir(), port: () => port,
    exec: execReplying(RUN_REPLY).exec, now: () => NOW, decisionDeps: { host: {} }, maxRuns: 2, diagnostic: (line) => said.push(line),
  });
  // The fixture class's actions name item 904, so 905 and 906 are `no-action` here; the cap is what is asserted: the third is never started.
  assert.ok(said.some((line) => /agent-org#906.*run-cap/.test(line)), said.join("\n"));
  assert.ok(!said.some((line) => /agent-org#904.*falls back/.test(line)));
  assert.deepEqual([...served.keys()], ["ceo/answer-owed/agent-org#904"]);
});

test("the order's cause and item are read from its key, and a tracker the project does not declare names no item", () => {
  assert.equal(causeOfOrder({ causeKey: "ceo/answer-owed/904" }), "answer-owed");
  assert.equal(causeOfOrder({ causeKey: "ceo/answer-owed/904", cause: "other" }), "other");
  const scopes = (key: string): string | null => (key === "" ? "a11ign/a11ign" : key === "agent-org" ? "a11ign/agent-org" : null);
  assert.deepEqual(itemOfKey({ causeKey: "ceo/answer-owed/904" }, scopes), { tracker: "github", scope: "a11ign/a11ign", id: 904 });
  assert.deepEqual(itemOfKey({ causeKey: "ceo/answer-owed/agent-org#904" }, scopes), { tracker: "github", scope: "a11ign/agent-org", id: 904 });
  assert.equal(itemOfKey({ causeKey: "ceo/answer-owed/elsewhere#904" }, scopes), null);
  assert.equal(itemOfKey({ causeKey: "ceo/answer-owed/chairman" }, scopes), null);
});

// --- the rules `ceo` kept out of this row's reach: their text is what it was ----------------------------------------------------------------------

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

/** The text of each rule this row was told not to touch, as source text: a function from its signature to its closing brace, a binding or a constant as its line. */
function untouched(sources: { wake: string; runnerRule: string; workGate: string; acceptance: string }): Record<string, string> {
  const start = sources.runnerRule.indexOf("export function laneReason(");
  const fn = start === -1 ? "" : sources.runnerRule.slice(start, sources.runnerRule.indexOf("\n}\n", start) + 3);
  return {
    laneReason: sha(fn),
    ROUTED_TO: sha(/^export const ROUTED_TO = .*;$/m.exec(sources.workGate)?.[0] ?? ""),
    "FLEET_LAB_PATTERNS binding": sha(/^(?:export )?const \{ patterns: FLEET_LAB_PATTERNS.*$/m.exec(sources.acceptance)?.[0] ?? ""),
    SPAWN_CAUSES: sha(/^export const SPAWN_CAUSES = .*;$/m.exec(sources.wake)?.[0] ?? ""),
  };
}
/** Read from `origin/main` at `8df83ce3` (the base of this row), by `sha256` of the text each regex or slice names. */
const PINNED = {
  laneReason: "7e7decce20a2a2cc4c97421078733465dd9bcce96895f8dae67ba09e84cd7b2c",
  ROUTED_TO: "753541140a11e726955715640e10f9a0f987469424f4b5bd2b9ce5fbd60f5293",
  "FLEET_LAB_PATTERNS binding": "b948efc4ede89a2f8cf88d209aceeef1379f062b278d7a2e79143f85b7953904",
  SPAWN_CAUSES: "4969388bde3d614cbe4374d220ac2a9d62a30b84916dea2b1bc9cc2901f04e48",
};

test("laneReason, ROUTED_TO, FLEET_LAB_PATTERNS and SPAWN_CAUSES are byte-identical to origin/main; an edited fixture fails each check", () => {
  const sources = { wake: moduleSource("wake.ts"), runnerRule: read("./row-claim/runner-rule.ts"), workGate: read("./work-gate/vocabulary.ts"), acceptance: moduleSource("acceptance-commands.ts") };
  assert.deepEqual(untouched(sources), PINNED);
  // THE NEGATIVE CONTROLS: an edit to each source text moves its own digest and no other, so a marker that did not read its text would be caught here.
  const lane = untouched({ ...sources, runnerRule: sources.runnerRule.replace("export function laneReason(", "export function laneReason(/* edited */ ") });
  assert.notEqual(lane.laneReason, PINNED.laneReason);
  assert.equal(lane.ROUTED_TO, PINNED.ROUTED_TO);
  const routed = untouched({ ...sources, workGate: sources.workGate.replace('Object.freeze(["orchestrator"])', 'Object.freeze(["orchestrator", "ceo"])') });
  assert.notEqual(routed.ROUTED_TO, PINNED.ROUTED_TO);
  assert.equal(routed.laneReason, PINNED.laneReason);
  const rebound = untouched({ ...sources, acceptance: sources.acceptance.replace("resourcePatternsFrom(RESOURCES);", "resourcePatternsFrom([]);") });
  assert.notEqual(rebound["FLEET_LAB_PATTERNS binding"], PINNED["FLEET_LAB_PATTERNS binding"]);
  const spawn = untouched({ ...sources, wake: sources.wake.replace('Object.freeze(["ready-row-unclaimed"])', 'Object.freeze(["ready-row-unclaimed", "answer-owed"])') });
  assert.notEqual(spawn.SPAWN_CAUSES, PINNED.SPAWN_CAUSES);
  // And the new module names none of them as something to change: it does not declare or assign any.
  const mine = read("./serve-by-run.ts");
  assert.ok(!/(?:const|function|let|var)\s+(?:laneReason|ROUTED_TO|FLEET_LAB_PATTERNS|SPAWN_CAUSES)\b/.test(mine));
  assert.ok(/(?:const|function)\s+ROUTED_TO\b/.test("const ROUTED_TO = 1;"), "the marker recognises a declaration it is looking for");
});

test("the default class registry holds the classes that ship as files (agent-org#905, #907, #909, #910, #911), and a class is switched on by the seats file, never by existing", async () => {
  const { CLASSES_DIR } = await import("./serve-by-run.ts");
  const causes = [...(await loadClasses(CLASSES_DIR)).keys()];
  // Each class is its own row, so the test names the classes it knows and does not pin the whole set: pinning it made every new class edit this line.
  for (const known of ["answer-owed", "ready-queue-empty", "ready-rows-untiered", "row-off-board", "unclaimed-blocker-cleared"]) assert.ok(causes.includes(known), `${known} ships as a file`);
});

