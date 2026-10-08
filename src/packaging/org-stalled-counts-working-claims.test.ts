// no-token: gh -- every read here is an injected seam; `deadMansSwitch` is handed its rows and herdr's listing, and reaches neither `gh` nor `herdr`
/**
 * #4205: AN ORG WHOSE CLAIMED ROWS HAVE WORKING SESSIONS IS NOT STALLED.
 *
 * On the stall wake of 2026-10-08T19:05:13Z `ceo` was paged "9 row(s) open and could move" while `worker-4184` and `worker-4189` were both `working`, and the nine
 * rows were claimed rows. `openRowState` counts every open row that declares no wait, and reads no claim, so a row carrying `session:worker-<n>` was reachable by that count
 * whatever its worker was doing.
 *
 * EVERY CASE CALLS `deadMansSwitch`, THE FUNCTION THE TICK CALLS, never a copy of its decision, and each "no order" is read against a control that DOES order: the same
 * rows with the sessions idle, absent or unreadable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deadMansSwitch } from "../work-gate.mjs";

type Agent = { label: string; status: string };
type Order = { cause: string; discriminator: string; prompt: string; causeKey: string };

const claimed = (number: number) => ({ number, labels: ["in-progress", "started", `session:worker-${number}`].map((name) => ({ name })) });
const unclaimed = (number: number) => ({ number, labels: [{ name: "ready" }] });
const blocked = (number: number) => ({ number, labels: [{ name: "blocked" }] });
const waiting = (number: number) => ({ number, labels: [{ name: "in-progress" }, { name: `session:worker-${number}` }], body: "Not-before: 2099-01-01" });

const NINE = Array.from({ length: 9 }, (_, i) => 100 + i);
const sessionsAre = (status: string, numbers: number[] = NINE): Agent[] => numbers.map((n) => ({ label: `worker-${n}`, status }));

function tick(openRows: unknown[] | null, agents?: Agent[] | null) {
  const log: string[] = [];
  const orders = deadMansSwitch({ orders: [], drain: false, openRows, ...(agents === undefined ? {} : { agents }),
    log: (line: string) => { log.push(line); } } as never) as Order[];
  return { orders, log };
}

test("nine claimed rows whose sessions are working are not a stall", () => {
  const { orders } = tick(NINE.map(claimed), sessionsAre("working"));
  assert.deepEqual(orders, [], "a claimed row with a working session IS moving");
});

test("POSITIVE CONTROL: the same nine rows, sessions idle or absent, still page with 9", () => {
  for (const [what, agents] of ([["idle", sessionsAre("idle")], ["blocked", sessionsAre("blocked")], ["absent", []], ["no listing given", undefined]] as [string, Agent[] | undefined][])) {
    const { orders } = tick(NINE.map(claimed), agents);
    assert.equal(orders.length, 1, `${what}: the stall under a claim nobody is working still pages`);
    assert.equal(orders[0].cause, "org-stalled");
    assert.equal(orders[0].discriminator, "9", what);
    assert.doesNotMatch(orders[0].prompt, /left out/, `${what}: nothing was left out, so the paragraph says nothing was`);
  }
});

test("seven working claims and two unclaimed rows: the order names 2, and says seven were left out", () => {
  const rows = [...NINE.slice(0, 7).map(claimed), unclaimed(200), unclaimed(201)];
  const { orders } = tick(rows, sessionsAre("working", NINE.slice(0, 7)));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].discriminator, "2", "the count is the rows that could move and are not moving");
  assert.match(orders[0].prompt, /2 row\(s\) are open and could move/);
  assert.match(orders[0].prompt, /7 claimed row\(s\) with a working session were left out/, "a reader can tell 'nothing moves' from 'everything that moves is claimed'");
  assert.equal(orders[0].causeKey, "ceo/org-stalled/2");
});

test("a claimed row whose liveness cannot be read is counted, not dropped", () => {
  const { orders } = tick(NINE.map(claimed), null);
  assert.equal(orders.length, 1, "an unreadable listing is not 'working'");
  assert.equal(orders[0].discriminator, "9");
});

test("only the sessions that read `working` are left out; the rest of the claims count", () => {
  const agents = [...sessionsAre("working", NINE.slice(0, 4)), ...sessionsAre("idle", NINE.slice(4))];
  const { orders } = tick(NINE.map(claimed), agents);
  assert.equal(orders[0].discriminator, "5");
  assert.match(orders[0].prompt, /4 claimed row\(s\) with a working session were left out/);
});

test("an unclaimed row, a `blocked` row and a waiting row are counted exactly as before", () => {
  // `blocked` carries a label, not a wait, so as before it is reachable by the count; a waiting row is not reachable and a working session does not change that.
  const agents = sessionsAre("working", [400, 301]);
  const { orders } = tick([unclaimed(500), blocked(300), waiting(400), claimed(301)], agents);
  assert.equal(orders[0].discriminator, "2", "unclaimed + blocked; the working claim is out, the waiting row was never in");
  assert.match(orders[0].prompt, /1 claimed row\(s\) with a working session were left out/, "the waiting row is not 'left out': it was never counted, so it is not subtracted");
  const control = tick([unclaimed(500), blocked(300), waiting(400), claimed(301)]);
  assert.equal(control.orders[0].discriminator, "3", "with no listing: unclaimed + blocked + the claimed row, exactly today's count");
});

test("when every reachable row is a working claim, the switch is silent", () => {
  const { orders } = tick([claimed(100)], sessionsAre("working", [100]));
  assert.deepEqual(orders, []);
});

test("a refused open-rows read stays refused whatever the listing says (#1286)", () => {
  const { orders, log } = tick(null, sessionsAre("working"));
  assert.deepEqual(orders, []);
  assert.match(log.join(""), /CANNOT ASK whether the org is stalled/);
});

/**
 * THE WIRING, PINNED -- `main` is not exported and exits the process, so this reads the source: the listing the switch is handed must be the one the follow-ups' wave
 * already read (`readOpenRowFollowUps`), so the fix adds no `herdr` spawn and no `gh` call per tick (#4205).
 */
test("main hands the switch the listing the follow-ups already read, and makes no new herdr call for it", () => {
  const source = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");
  const call = [...source.matchAll(/deadMansSwitch\(\{[^}]*\}\)/g)].map(([text]) => text).find((c) => /agents:/.test(c)) ?? "";
  const name = call.match(/agents:\s*(\w+)/)?.[1] ?? "";
  assert.ok(name, "main must pass the listing into the switch");
  assert.match(source, new RegExp(`const \\{[^}]*\\bagents: ${name}\\b[^}]*\\} = readOpenRowFollowUps\\(allOpen\\);`), `${name} must be the follow-ups' own listing`);
  assert.equal(source.match(/"workspace", "list"/g)?.length, 2, "the gate lists herdr's workspaces where it did before (`liveWorkspaceLabels` and the worker probe); the switch adds none");
});
