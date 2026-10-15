// no-token: gh -- the order is built from the pull requests handed to `holderOrdersOf`; nothing here reads GitHub
/**
 * agent-org#1397: A HOLD-REMINDER ORDER QUOTES THE MANAGER DIRECTION POSTED ON THE HELD PULL REQUEST AFTER THE HOLD WAS TAKEN. An order that carries only the
 * hold's own facts tells the holder the old thing: a manager posts "drop your hold" after the hold, and the holder is woken with the hold and nothing of that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDER_IDLE_MINUTES, holderOrdersOf } from "./pr-hold-state.ts";
import { WAIT_MARKER } from "./wait-condition.ts";

const MINUTE = 60_000;
const HELD_AT = Date.parse("2026-10-13T18:00:00Z");
const HOLDER = "worker-9";
const LISTING = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: HOLDER, status: "idle" }];
const MANAGER = "a11ign-managers";
const WORKER = "a11ign-workers";

const comment = (login: string, at: number, body: string) => ({ author: { login }, body, createdAt: new Date(at).toISOString() });
const MARKER = comment("a11ign-ai-leads", HELD_AT, `${WAIT_MARKER}\nHeld by \`${HOLDER}\`.\nWaiting-for: closed #2867`);
const decided = (seat: string) => `\n<!-- decided-by: ${seat} run: 9001 -->`;

/** An open pull request carrying `hold:<holder>`, with these comments, as the gate's list reads it. */
const heldPr = (comments: unknown[]) => ({ number: 4971, labels: [{ name: `hold:${HOLDER}` }], comments, reviewDecision: "REVIEW_REQUIRED" });

/** The orders of the tick at which the holder is woken: idle at the hold, and still idle {@link HOLDER_IDLE_MINUTES} later. */
function wakeOf(prs: ReturnType<typeof heldPr>[]) {
  const first = holderOrdersOf({ prs, agents: LISTING, declarations: new Map(), memory: {}, now: HELD_AT });
  return holderOrdersOf({ prs, agents: LISTING, declarations: new Map(), memory: first.memory, now: HELD_AT + HOLDER_IDLE_MINUTES * MINUTE }).orders;
}

test("the wake quotes the manager direction posted after the hold, with its first line, its author and its seat", () => {
  const direction = comment(MANAGER, HELD_AT + 5 * MINUTE, `Orchestrator ruling: drop your hold, agent-org#1378 goes first.${decided("orchestrator")}`);
  const orders = wakeOf([heldPr([MARKER, direction])]);
  assert.equal(orders.length, 1, "the holder is woken once");
  const [wake] = orders;
  assert.equal(wake.session, HOLDER);
  assert.match(wake.prompt, /Orchestrator ruling: drop your hold, agent-org#1378 goes first\./, "quotes the direction's first line");
  assert.match(wake.prompt, /a11ign-managers/, "names the author");
  assert.match(wake.prompt, /`orchestrator`/, "names the seat that said it");
  assert.match(wake.prompt, /pr:release 4971 --session=worker-9/, "the way out is still a command");
});

test("a manager comment before the hold, a worker's comment, and a manager comment naming no seat are not quoted", () => {
  const earlier = comment(MANAGER, HELD_AT - 10 * MINUTE, `EARLIER_RULING_TEXT${decided("orchestrator")}`);
  const worker = comment(WORKER, HELD_AT + 5 * MINUTE, `WORKER_OWN_TEXT${decided(HOLDER)}`);
  const unnamed = comment(MANAGER, HELD_AT + 6 * MINUTE, "UNNAMED_SEAT_TEXT");
  const [wake] = wakeOf([heldPr([earlier, MARKER, worker, unnamed])]);
  assert.ok(wake, "the holder is still woken");
  assert.doesNotMatch(wake.prompt, /EARLIER_RULING_TEXT/);
  assert.doesNotMatch(wake.prompt, /WORKER_OWN_TEXT/);
  assert.doesNotMatch(wake.prompt, /UNNAMED_SEAT_TEXT/);
});

test("only the newest directions are quoted, oldest first, and the rest are named as not quoted", () => {
  const directions = [1, 2, 3, 4, 5].map((n) => comment(MANAGER, HELD_AT + n * MINUTE, `DIRECTION_${n}${decided("product-manager")}`));
  const [wake] = wakeOf([heldPr([MARKER, ...directions])]);
  for (const n of [3, 4, 5]) assert.match(wake.prompt, new RegExp(`DIRECTION_${n}\\b`), `direction ${n} is quoted`);
  for (const n of [1, 2]) assert.doesNotMatch(wake.prompt, new RegExp(`DIRECTION_${n}\\b`), `direction ${n} is not quoted`);
  assert.match(wake.prompt, /2 earlier manager directions? not quoted/);
  assert.ok(wake.prompt.indexOf("DIRECTION_3") < wake.prompt.indexOf("DIRECTION_5"), "newest last");
});

test("a direction longer than the bound is cut, not sent whole", () => {
  const long = comment(MANAGER, HELD_AT + 5 * MINUTE, `LONG ${"x".repeat(5000)}${decided("ceo")}`);
  const [wake] = wakeOf([heldPr([MARKER, long])]);
  assert.match(wake.prompt, /LONG x/);
  assert.ok(!wake.prompt.includes("x".repeat(2000)), "a body is cut well short of its length");
  assert.match(wake.prompt, /cut/);
});

test("a hold with no manager direction after it quotes none", () => {
  const [wake] = wakeOf([heldPr([MARKER, comment(WORKER, HELD_AT + 5 * MINUTE, "just a worker")])]);
  assert.doesNotMatch(wake.prompt, /manager direction/i);
});
