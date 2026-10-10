// no-token: gh -- the ticket port is a fake and the state directory is a temporary one; nothing here spawns `gh`
/**
 * agent-org#491 (Phase 1 of a11ign/a11ign#4505): THE `overdue` LIST IS RECORDED AS DATA AND A MANAGER IS WOKEN ONLY FOR A STUCK-LINK NUMBER.
 *
 * The row's four named cases are the four tests whose names start with their sentence. The orders are the real ones: `overdueReading` through `orgHealthOrders`, the
 * entry the gate calls, so the key the list is judged unchanged by is the key the detector put on the order and not one this file invented.
 *
 * THE STANDING ROW IS WRITTEN OUT AS 928 HERE, never as `TABLE_ROW`, for the reason `work-gate-repeating-log-line-port.test.ts` writes its thresholds out: a test built
 * from the constant moves with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNALS, orgHealthOrders, overdueReading, type OverdueCandidate, type Reading } from "./org-health.ts";
import { OVERDUE_LAST_WRITTEN_FILE, OVERDUE_LIST_SWITCH_ENV, settleOverdueLists } from "./work-gate.ts";
import type { Decision, ItemRef, TicketPort } from "./ticket-port/port.ts";

const HOME = "a11ign/a11ign";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const MIN = 60_000;

// --- the orders ---------------------------------------------------------------------------------------------------------------------

/** An item open for `ageMinutes`, which is over the 100-minute bound of a PR. */
const pr = (number: number, reason = "red", ageMinutes = 240): OverdueCandidate =>
  ({ kind: "pr", number, reason, owner: "worker-1", since: NOW - ageMinutes * MIN });

/** The orders `org-health` makes for one tick whose overdue list is `items`: the real reading through the real order builder. */
const overdueOrders = (items: OverdueCandidate[], now = NOW) => orgHealthOrders([overdueReading({ now, items })]);

const STUCK_LINKS: Reading[] = [
  { signal: SIGNALS.NO_MERGE, status: "tripped", detail: "nothing has merged in 190 min while 6 rows wait", discriminator: `${SIGNALS.NO_MERGE}@2026-10-10T09`, firstTrippedAt: NOW - 190 * MIN },
  { signal: SIGNALS.RED_PR, status: "tripped", detail: "#4001 has been red for 130 min with nobody on it", discriminator: `${SIGNALS.RED_PR}@4001`, firstTrippedAt: NOW - 130 * MIN },
  { signal: SIGNALS.REFUSED_ROW, status: "tripped", detail: "#4002 has been refused for 160 min", discriminator: `${SIGNALS.REFUSED_ROW}@4002`, firstTrippedAt: NOW - 160 * MIN },
];

// --- the fake port and the state directory ---------------------------------------------------------------------------------------------

function fakePort({ failWrites = false }: { failWrites?: boolean } = {}) {
  const writes: { ref: ItemRef; decision: Decision; }[] = [];
  const scopesAsked: string[] = [];
  const portFor = (scope: string): TicketPort => {
    scopesAsked.push(scope);
    return {
      readItem() { throw new Error("recording the list must not read a row"); },
      postDecision(ref, decision) {
        if (failWrites) throw new Error("HTTP 502: the tracker could not be written");
        writes.push({ ref, decision });
        return "1";
      },
      changeState() { throw new Error("recording the list must not change a row's state"); },
      subscribe() { throw new Error("recording the list must not subscribe"); },
    };
  };
  return { portFor, writes, scopesAsked };
}

/** A fresh state directory per scenario; the one thing that survives between its ticks is the last key written, as in the gate. */
function scenario(env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "overdue-list-"));
  const said: string[] = [];
  return {
    dir, said,
    tick(orders: any[], { port = fakePort(), at = NOW }: { port?: ReturnType<typeof fakePort>; at?: number } = {}) {
      const delivered = settleOverdueLists(orders, { portFor: port.portFor, dir, env, log: (line) => said.push(line), now: at, scope: HOME });
      return { delivered, ...port };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// --- the row's Acceptance, one test per named case ---------------------------------------------------------------------------------------

test("an overdue list that has not changed since the last write produces no order and no write", () => {
  const s = scenario();
  try {
    const first = s.tick(overdueOrders([pr(4001), pr(4002, "no-owner")]));
    assert.equal(first.writes.length, 1, "the first sight of the list is a write");
    // the same items, an hour later: the clock ticked, the list did not change.
    const later = s.tick(overdueOrders([pr(4001, "red", 300), pr(4002, "no-owner", 300)], NOW + 60 * MIN), { at: NOW + 60 * MIN });
    assert.deepEqual(later.delivered, [], "no order");
    assert.equal(later.writes.length, 0, "and no write");
    // and the member order in the list is not a change: the detector sorts the key, and so does this reading of it.
    const reordered = s.tick(overdueOrders([pr(4002, "no-owner", 10_000), pr(4001, "red", 10_000)]));
    assert.deepEqual([reordered.delivered, reordered.writes.length], [[], 0]);
    assert.deepEqual(s.said.filter((line) => /overdue/.test(line)).length, 1, "only the change is said on stderr: a line written every tick is a repeating-log-line of its own");
  } finally { s.done(); }
});

test("a changed overdue list is written once through a fake port and produces no order", () => {
  const s = scenario();
  try {
    const a = s.tick(overdueOrders([pr(4001)]));
    assert.deepEqual(a.delivered, []);
    assert.equal(a.writes.length, 1);
    assert.deepEqual(a.writes[0].ref, { tracker: "github", scope: HOME, id: 928 }, "the standing row the org-health prompts name, of the gate's own repository");
    assert.equal(a.writes[0].decision.role, "work-gate");
    assert.equal(a.writes[0].decision.kind, "overdue-list");
    assert.match(a.writes[0].decision.text, /pr#4001:red/);
    assert.match(a.writes[0].decision.text, /#4001 \(PR, red, open 4 h, owner worker-1\)/, "the detector's own wording of the item rides the comment");
    assert.deepEqual(a.scopesAsked, [HOME]);

    // a merge takes #4001 out and a new item comes in: a different list, so a second write, and still no order.
    const b = s.tick(overdueOrders([pr(4003, "needs-review")]));
    assert.deepEqual(b.delivered, []);
    assert.equal(b.writes.length, 1);
    assert.match(b.writes[0].decision.text, /pr#4003:needs-review/);
    assert.doesNotMatch(b.writes[0].decision.text, /4001/);

    // a reason that moved is a change: who owes the next move has changed (`overdueReading`'s own rule).
    const c = s.tick(overdueOrders([pr(4003, "red")]));
    assert.equal(c.writes.length, 1);
    assert.deepEqual(c.delivered, []);
  } finally { s.done(); }
});

test("a stuck-link number produces the order as today", () => {
  const s = scenario();
  try {
    for (const reading of STUCK_LINKS) {
      const orders = orgHealthOrders([reading]);
      assert.equal(orders.length, 1);
      const { delivered, writes } = s.tick(orders);
      assert.deepEqual(delivered, orders, `${reading.signal}: the order is delivered untouched, text and key and session`);
      assert.equal(writes.length, 0, "and no row is written for it");
    }
    // all three tripped together with an overdue list: the three numbers wake, the list does not, and the numbers' prompts are byte-identical to what they were.
    const together = orgHealthOrders([...STUCK_LINKS, overdueReading({ now: NOW, items: [pr(4001)] })]);
    const { delivered, writes } = s.tick(together);
    assert.deepEqual(delivered, together.filter((order) => !/org-health\/overdue@/.test(order.causeKey)));
    assert.equal(delivered.length, 3);
    assert.equal(writes.length, 1, "the list is recorded in the same tick");
    for (const order of delivered) assert.match(order.prompt, /ALSO TRIPPED \(3\): .*overdue/, "the numbers still name the other signals tripped, as before");
  } finally { s.done(); }
});

test("negative control: with the switch off, the overdue list produces today's order", () => {
  const s = scenario({ [OVERDUE_LIST_SWITCH_ENV]: "off" });
  try {
    const orders = overdueOrders([pr(4001)]);
    const { delivered, writes, scopesAsked } = s.tick(orders);
    assert.equal(orders.length, 1, "the control is a tick that does make the order");
    assert.deepEqual(delivered, orders, "the order comes back untouched");
    assert.deepEqual([writes.length, scopesAsked.length], [0, 0], "with no write and no port asked");
    assert.equal(orders[0].session, "ceo");
    assert.equal(orders[0].cause, "org-health");
    // the control is real: the same tick with the switch unset records the list instead.
    const on = scenario();
    try { assert.deepEqual(on.tick(orders).delivered, []); } finally { on.done(); }
  } finally { s.done(); }
});

// --- what the four cases do not say -------------------------------------------------------------------------------------------------

test("a write that fails keeps the order and records nothing, so the next tick writes the list", () => {
  const s = scenario();
  try {
    const orders = overdueOrders([pr(4001)]);
    const failed = s.tick(orders, { port: fakePort({ failWrites: true }) });
    assert.deepEqual(failed.delivered, orders, "a list that could not be recorded still wakes: every doubt is a wake");
    assert.ok(s.said.some((line) => /COULD NOT WRITE the overdue list to #928 \(HTTP 502/.test(line)), s.said.join(""));
    assert.throws(() => readFileSync(join(s.dir, OVERDUE_LAST_WRITTEN_FILE), "utf8"), /ENOENT/, "no key was kept for a comment that did not land");
    const retried = s.tick(orders);
    assert.deepEqual(retried.delivered, []);
    assert.equal(retried.writes.length, 1, "and the retry is the one write");
  } finally { s.done(); }
});

test("an order that is not the overdue list is left alone, whoever it is for", () => {
  const s = scenario();
  try {
    const others = [
      ...orgHealthOrders([{ signal: SIGNALS.TOOL_VERSION, status: "tripped", detail: "a runner is behind", discriminator: `${SIGNALS.TOOL_VERSION}@node` }]),
      { session: "orchestrator", cause: "repeating-log-line", prompt: "a line", causeKey: "orchestrator/repeating-log-line/x" },
      // an order that merely names `overdue` in its key, but is not of that cause.
      { session: "ceo", cause: "claim-stall", prompt: "p", causeKey: "ceo/org-health/overdue@pr#1:red" },
    ];
    const { delivered, writes } = s.tick(others);
    assert.deepEqual(delivered, others);
    assert.equal(writes.length, 0);
  } finally { s.done(); }
});

test("the gate's `main` passes its orders through the settle, after the dead man's switch and before the suppression", () => {
  const source = readFileSync(fileURLToPath(new URL("./work-gate.ts", import.meta.url)), "utf8");
  const switchAt = source.indexOf("...deadMansSwitch({ orders,");
  const callAt = source.indexOf("quietOrgHealth(settleOverdueLists(orders, { portFor: portOf })");
  assert.ok(switchAt > 0 && callAt > switchAt, "the call site exists, and sits after the dead man's switch has read the orders");
});
