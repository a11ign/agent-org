// no-token: clearContext -- every herdr call is the injected `run` or a shell stub on PATH; nothing here reaches gh
/**
 * #3562 (chairman, 2026-10-04): AN FYI NEVER WAKES OR CLEARS A LEAD SEAT.
 *
 * An order that asks nothing of `ceo`, `product-manager`, `orchestrator` or `liaison` used to be delivered the moment the seat was idle, and a
 * delivery clears the window first: a whole starting-context write (~30k tokens, measured by `trace -- --wake-cache`) to say nothing was asked.
 * Now it waits in the queue, rides in the seat's next REAL order (a declared decision, a gate cause) and is dropped if it is still waiting after
 * `FYI_STALE_MS`.
 *
 * THE POSITIVE CONTROLS ARE IN THIS FILE, NOT ASSUMED: a decision to an idle seat still wakes it at once (a hold applied to everything would pass
 * every "does not wake" test below), a `reviewer-<n>` still gets an undeclared re-review request at once, and the same FYI that is held with
 * nothing to ride DOES arrive when a real order comes.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FYI_STALE_MS, foldFyis, handoffQueuePath, holdsAsFyi, isLeadSeat, readHandoffs, retireRiddenFyis, ridingGateOrders, SETTLE_TEST_CLOCK_ENV } from "../wake.ts";
import { EXIT, STANCE, directRecordPath, promptOrQueue } from "../prompt-session.ts";
import { startedPanes } from "./started-pane.ts";

const WAKE_ENTRY = fileURLToPath(new URL("../wake.ts", import.meta.url));
const STUB_MODE = 0o755;
const HOUR = 3_600_000;
const FYI_TEXT = "the liaison cleared for ceo: no decision owed; I will say when it has merged";
const GATE_TEXT = "row #3562 is ready and unclaimed";

const noSettle = () => {};
/** An EMPTY transcript root: a seat's own live transcript on a shared host must not decide whether this test's delivery clears or keeps. */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-3562-no-transcripts");
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));

/** A `run` that records every herdr call; `prompts()` is what was TYPED into a session, `/clear` included. */
function recorder() {
  const calls: string[][] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args);
    return pane(args) ?? "{}";
  };
  const prompts = () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt");
  return { run, prompts, cleared: () => prompts().filter((c) => c[5] === "/clear").map((c) => c[4]),
    ordered: (label: string) => prompts().filter((c) => c[4] === label && c[5] !== "/clear").map((c) => c[5]) };
}

function inDir<T>(body: (dir: string, queue: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "a11y-3562-"));
  try {
    return body(dir, join(dir, "queue"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const quietly = <T>(body: () => T): T => {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as never;
  process.stderr.write = (() => true) as never;
  try {
    return body();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

const send = (label: string, stance: string, queue: string, run: (args: string[]) => string, labels = [label]) => quietly(() => promptOrQueue({
  run, label, text: FYI_TEXT, agents: agents(labels), path: queue, stance: stance as never, sender: "liaison", sleep: noSettle, contextRoot: NO_TRANSCRIPTS }));

// --- THE SENDER'S SIDE: `prompt:session` --------------------------------------------------------------------

test("#3562 (b) an UNDECLARED order to an IDLE lead seat is queued and nothing is typed: no wake, no /clear", () => {
  inDir((dir, queue) => {
    const r = recorder();
    assert.equal(send("ceo", STANCE.UNDECLARED, queue, r.run), EXIT.QUEUED);
    assert.deepEqual(r.prompts(), [], "not a single `agent prompt`: the seat was neither woken nor cleared");
    const held = readHandoffs(queue);
    assert.equal(held.length, 1, "the order is HELD, not lost");
    assert.equal(held[0].decision, false);
    assert.equal(held[0].fyi, true, "and MARKED as held, so the tick holds it and nothing queued before this shipped");
    assert.ok(existsSync(dir));
  });
});

test("#3562 (b) a DECLARED --fyi to an idle lead seat is held the same way", () => {
  inDir((_dir, queue) => {
    const r = recorder();
    assert.equal(send("product-manager", STANCE.FYI, queue, r.run), EXIT.QUEUED);
    assert.deepEqual(r.prompts(), []);
    assert.equal(readHandoffs(queue).length, 1);
  });
});

test("#3562 (d) the positive control: a --decision order to the same idle seat WAKES it at once, behind a /clear", () => {
  inDir((_dir, queue) => {
    const r = recorder();
    assert.equal(send("ceo", STANCE.DECISION, queue, r.run), EXIT.OK);
    assert.deepEqual(r.cleared(), ["ceo"], "a real order clears a seat that is not recent: this is what an FYI no longer pays for");
    assert.equal(r.ordered("ceo").length, 1);
    assert.deepEqual(readHandoffs(queue), [], "a delivered order leaves no queue entry");
    const [line] = readFileSync(directRecordPath(queue), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(line.decision, true, "the direct record carries the declaration, so a later reading can tell a wake an FYI caused from one a decision did");
  });
});

test("#3562 the chairman's path: STANCE.ORDER wakes an idle lead seat at once, and for a BUSY one queues a real order the tick delivers, never holds", () => {
  inDir((_dir, queue) => {
    const r = recorder();
    assert.equal(send("liaison", STANCE.ORDER, queue, r.run), EXIT.OK);
    assert.equal(r.ordered("liaison").length, 1, "the chairman's message is not an FYI");
    const busy = quietly(() => promptOrQueue({ run: r.run, label: "liaison", text: FYI_TEXT, agents: [{ label: "liaison", status: "working" }], path: queue,
      stance: STANCE.ORDER as never, sender: "chairman via Telegram", sleep: noSettle, contextRoot: NO_TRANSCRIPTS }));
    assert.equal(busy, EXIT.QUEUED);
    const [queued] = readHandoffs(queue);
    assert.equal(queued.fyi, false, "queued as a REAL order: the tick will deliver it when the seat is between tasks");
    assert.equal(holdsAsFyi(queued), false);
  });
});

test("#3562 a reviewer instance still gets an UNDECLARED order at once: it is the re-review request, not an FYI", () => {
  inDir((_dir, queue) => {
    const r = recorder();
    assert.equal(send("reviewer-4321", STANCE.UNDECLARED, queue, r.run), EXIT.OK);
    assert.equal(r.ordered("reviewer-4321").length, 1, "holding this would stall the one order that seat exists to receive");
    assert.deepEqual(readHandoffs(queue), []);
    assert.equal(JSON.parse(readFileSync(directRecordPath(queue), "utf8").trim()).decision, false, "and the record says it was NOT declared a decision");
  });
});

test("#3562 an unknown seat name is still refused, not held: a typo is not a seat that will have a next order", () => {
  inDir((_dir, queue) => {
    const r = recorder();
    // `ceo` is a lead seat the roster knows, but herdr lists no session by that name, so there is nothing for an FYI to ride to.
    assert.equal(send("ceo", STANCE.UNDECLARED, queue, r.run, ["liaison"]), EXIT.REFUSED);
    assert.deepEqual(readHandoffs(queue), []);
  });
});

// --- THE PREDICATES --------------------------------------------------------------------------------------------

test("#3562 only a lead seat holds an FYI, and only an order that declares no decision", () => {
  for (const seat of ["ceo", "product-manager", "orchestrator", "liaison"]) assert.equal(isLeadSeat(seat), true, seat);
  for (const other of ["reviewer-12", "worker-9", "engineers", "nobody"]) assert.equal(isLeadSeat(other), false, other);
  assert.equal(holdsAsFyi({ session: "ceo", decision: false, fyi: true }), true);
  assert.equal(holdsAsFyi({ session: "ceo", decision: false }), false, "an entry written before the field existed is delivered as it always was: shipping this holds and expires nothing already queued");
  assert.equal(holdsAsFyi({ session: "ceo", decision: false, fyi: false }), false, "a real order queued for a busy seat (the chairman's message, `STANCE.ORDER`) is never held");
  assert.equal(holdsAsFyi({ session: "ceo", decision: true, fyi: true }), false);
  assert.equal(holdsAsFyi({ session: "ceo", decision: false, fyi: true, resume: true }), false, "a re-send of an order a restart killed is already a delivery");
  assert.equal(holdsAsFyi({ session: "reviewer-12", decision: false, fyi: true }), false);
});

test("#3562 (c) foldFyis: held with nothing to ride, carried by a seat's real handoff, expired past the bound", () => {
  const now = Date.now();
  const fyi = (id: string, session: string, ageMs: number) => ({ id, session, prompt: id, queuedAt: now - ageMs, decision: false, fyi: true });
  const real = { id: "d1", session: "ceo", prompt: "d1", queuedAt: now - HOUR, decision: true };
  const alone = foldFyis([fyi("a", "ceo", HOUR), fyi("b", "product-manager", HOUR)], { now });
  assert.deepEqual([alone.deliver.length, alone.held.map((h) => h.id), alone.expired.length], [0, ["a", "b"], 0]);
  const riding = foldFyis([real, fyi("a", "ceo", HOUR), fyi("b", "product-manager", HOUR)], { now });
  assert.deepEqual(riding.deliver.map((h) => h.id).sort(), ["a", "d1"], "ceo's FYI rides ceo's decision; product-manager's has no order to ride");
  assert.deepEqual(riding.held.map((h) => h.id), ["b"]);
  const stale = foldFyis([real, fyi("old", "ceo", FYI_STALE_MS), fyi("fresh", "ceo", FYI_STALE_MS - 1)], { now });
  assert.deepEqual(stale.expired.map((h) => h.id), ["old"], "the bound is inclusive at FYI_STALE_MS exactly, as HANDOFF_STALE_MS is");
  assert.deepEqual(stale.deliver.map((h) => h.id).sort(), ["d1", "fresh"], "an expired FYI does not ride even when a real order is going");
});

test("#3562 ridingGateOrders: the FYI is added to the order for ITS seat only, and retired only when `deliver` records that order as sent", () => {
  const now = Date.now();
  const held = [{ id: "f1", session: "ceo", prompt: FYI_TEXT, queuedAt: now - HOUR }];
  const orders = [{ session: "ceo", causeKey: "ceo/k", prompt: GATE_TEXT }, { session: "orchestrator", causeKey: "orchestrator/k", prompt: "other" }];
  const { orders: carrying, rides } = ridingGateOrders(orders, held, now);
  assert.ok(carrying[0].prompt.startsWith(GATE_TEXT) && carrying[0].prompt.includes(FYI_TEXT), "the order's own text first, the FYI after it");
  assert.equal(carrying[1].prompt, "other", "another seat's order carries nothing");
  assert.deepEqual([...rides], [["ceo/k", ["f1"]]]);

  /** What `retireRiddenFyis` asked the queue to drop: one entry per `drop` call, so "nothing" is `[]`. */
  const retired = (ids: string[] | undefined, recipient: string | undefined): string[][] => {
    const calls: string[][] = [];
    retireRiddenFyis(ids, recipient, "q", (_path, dropping) => { calls.push([...dropping]); });
    return calls;
  };
  assert.deepEqual(retired(rides.get("ceo/k"), "worker-3"), [], "re-routed to ANOTHER seat: the addressed seat never received it, so it stays held");
  assert.deepEqual(retired(rides.get("ceo/k"), undefined), [["f1"]]);
  assert.deepEqual(retired(undefined, undefined), [], "an order that carried nothing retires nothing");
});

// --- THE TICK: the real entry point, herdr stubbed on PATH -------------------------------------------------------

/** herdr with `ceo` idle and ready; every call is appended to `$0.log` as its arguments joined by 0x1f and ended by 0x1e, so a MULTI-LINE order stays one record. */
const HERDR = "#!/bin/sh\n{ printf '%s\\037' \"$@\"; printf '\\036'; } >> \"$0.log\"\ncase \"$*\" in\n"
  + "  *'workspace list') printf '%s' '{\"result\":{\"workspaces\":[{\"label\":\"ceo\",\"agent_status\":\"idle\"}]}}' ;;\n"
  + "  *'agent get'*) printf '%s' '{\"result\":{\"agent\":{\"agent_status\":\"idle\",\"interactive_ready\":true,\"state_change_seq\":1}}}' ;;\n"
  + "  *) : ;;\nesac\n";

type Queued = { id: string; session: string; prompt: string; queuedAt: number; decision: boolean; fyi: boolean };
const entry = (id: string, decision: boolean, ageMs: number, prompt = FYI_TEXT): Queued =>
  ({ id: `handoff/ceo/${id}`, session: "ceo", prompt, queuedAt: Date.now() - ageMs, decision, fyi: !decision });

function tick({ queued, stdin = "" }: { queued: Queued[]; stdin?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "a11y-3562-tick-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const stub = join(dir, "herdr");
    writeFileSync(stub, HERDR);
    chmodSync(stub, STUB_MODE);
    writeFileSync(handoffQueuePath(ledger), queued.map((h) => JSON.stringify(h)).join("\n") + (queued.length ? "\n" : ""));
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, WAKE_ENTRY, `--ledger=${ledger}`], { input: stdin, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, [SETTLE_TEST_CLOCK_ENV]: "0" } });
    const log = existsSync(`${stub}.log`) ? readFileSync(`${stub}.log`, "utf8") : "";
    const calls = log.split("\x1e").filter(Boolean).map((record) => record.split("\x1f").filter((word, at, all) => at < all.length - 1 || word !== ""));
    const typed = calls.filter((c) => c[2] === "agent" && c[3] === "prompt").map((c) => c.slice(5).join(" "));
    return { ran, typed, left: readHandoffs(handoffQueuePath(ledger)).map((h: { id: string }) => h.id) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const gateOrder = JSON.stringify({ session: "ceo", cause: "pr-ready", causeKey: "ceo/pr-ready/1", prompt: GATE_TEXT });

test("#3562 (b) a tick over a held FYI and NOTHING ELSE delivers nothing and leaves the queue holding it", () => {
  const { ran, typed, left } = tick({ queued: [entry("0001", false, HOUR)] });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(typed, [], "no herdr prompt of any kind: not the order and not a /clear");
  assert.deepEqual(left, ["handoff/ceo/0001"], "the FYI is still in the queue after the tick");
});

test("#3562 (c) the SAME FYI rides the seat's next real order -- a gate cause -- and is retired by it", () => {
  const { ran, typed, left } = tick({ queued: [entry("0001", false, HOUR)], stdin: `${gateOrder}\n` });
  assert.equal(ran.status, 0, ran.stderr);
  const ordered = typed.filter((text) => text !== "/clear");
  assert.equal(ordered.length, 1, `one order was typed (got ${JSON.stringify(typed)})`);
  assert.ok(ordered[0].includes(GATE_TEXT) && ordered[0].includes(FYI_TEXT), "the gate's order and the FYI are in ONE delivery");
  assert.deepEqual(left, [], "delivered, so retired");
});

test("#3562 (c) the SAME FYI rides a declared decision handoff, in its batch, and both are retired", () => {
  const { ran, typed, left } = tick({ queued: [entry("0001", false, 2 * HOUR), entry("0002", true, HOUR, "a ruling is needed on the freeze")] });
  assert.equal(ran.status, 0, ran.stderr);
  const ordered = typed.filter((text) => text !== "/clear");
  assert.equal(ordered.length, 1);
  assert.ok(ordered[0].includes(FYI_TEXT) && ordered[0].includes("a ruling is needed on the freeze"));
  assert.deepEqual(left, []);
});

test("#3562 (d) the positive control at the tick: a queued DECISION alone wakes an idle seat", () => {
  const { typed, left } = tick({ queued: [entry("0002", true, HOUR, "a ruling is needed on the freeze")] });
  assert.equal(typed.filter((text) => text !== "/clear").length, 1, "so the held-FYI tests above are not a tick that never delivers anything");
  assert.deepEqual(left, []);
});

test("#3562 (c) an FYI older than the bound is DROPPED with a line, never delivered -- on a quiet tick and when a real order goes", () => {
  const old = entry("0003", false, FYI_STALE_MS + HOUR);
  const quiet = tick({ queued: [old] });
  assert.deepEqual(quiet.typed, []);
  assert.deepEqual(quiet.left, [], "expired and retired");
  assert.match(quiet.ran.stderr, /DROPPED FYI handoff\/ceo\/0003 to ceo: queued 5\.0h ago/);

  const busy = tick({ queued: [old, entry("0004", false, HOUR, "a fresh notice")], stdin: `${gateOrder}\n` });
  const ordered = busy.typed.filter((text) => text !== "/clear");
  assert.equal(ordered.length, 1);
  assert.ok(ordered[0].includes("a fresh notice") && !ordered[0].includes(FYI_TEXT), "the fresh one rides; the stale one does not");
  assert.match(busy.ran.stderr, /DROPPED FYI handoff\/ceo\/0003/);
  assert.deepEqual(busy.left, []);
});
