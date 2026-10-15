// no-token: gh -- no `gh` is reached; the referenced item's state is a fixture
// #1281 (class `row-not-finishable`): `unmetWaitingFor` is the reading a CLAIM asks of a row's `Waiting-for:` line, the one the gate's release acts on.
// Each refusal has its control with one fact changed: the same line with its condition met, and the same line read as unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unmetWaitingFor } from "./claim-stall.ts";
import { closedClaimsNow } from "./work-gate/claim-stall-tick.ts";
import type { RefFact } from "./wait-condition.ts";

const fact = (state: RefFact["state"]): RefFact => ({ state, labels: [], resolvedAt: null, changedAt: null });
const body = (line: string) => `## What\n\nx\n\n${line}\n`;

test("an open referenced item makes the line unmet, and the same line is met once it merged or closed", () => {
  assert.equal(unmetWaitingFor(body("Waiting-for: merged #1055"), "a11ign/agent-org", () => fact("open")), "merged #1055");
  assert.equal(unmetWaitingFor(body("Waiting-for: merged #1055"), "a11ign/agent-org", () => fact("merged")), null);
  assert.equal(unmetWaitingFor(body("Waiting-for: closed #1055"), "a11ign/agent-org", () => fact("closed")), null);
});

test("an unknown condition is not unmet: an unread reference, `manual`, a line outside the grammar and no line at all", () => {
  assert.equal(unmetWaitingFor(body("Waiting-for: merged #1055"), "a11ign/agent-org", () => null), null);
  assert.equal(unmetWaitingFor(body("Waiting-for: manual"), "a11ign/agent-org", () => fact("open")), null);
  assert.equal(unmetWaitingFor(body("Waiting-for: soon"), "a11ign/agent-org", () => fact("open")), null);
  assert.equal(unmetWaitingFor(body("nothing here"), "a11ign/agent-org", () => fact("open")), null);
  assert.equal(unmetWaitingFor(null, "a11ign/agent-org", () => fact("open")), null);
});

test("a bare `#n` is read in the row's tracker and a qualified one in its own repository", () => {
  const seen: string[] = [];
  unmetWaitingFor(body("Waiting-for: merged #1055\nWaiting-for: closed a11ign/a11ign#5156"), "a11ign/agent-org", (ref) => { seen.push(`${ref.repo}#${ref.number}`); return fact("merged"); });
  assert.deepEqual(seen, ["a11ign/agent-org#1055", "a11ign/a11ign#5156"]);
});

test("#1463 a closed row whose OWN pull request closed it is released, and the line is said ONCE per stand: three ticks with the same memory", () => {
  const memory = new Map<string, Record<string, string>>();
  const read = (path: string): Record<string, string> => memory.get(path) ?? {};
  const write = (path: string, lines: Record<string, string>) => { memory.set(path, lines); };
  const lines: string[] = [];
  const row = { number: 1325, labels: ["in-progress", "started", "session:worker-agent-org-1325"].map((name) => ({ name })), comments: [],
    closedByPullRequestsReferences: [{ number: 1378, headRefName: "agent/pr-follow-ups-go-agent-org-1325", title: "x" }] };
  const tick = () => closedClaimsNow({ rows: [row], agents: [{ label: "worker-agent-org-1325", status: "unknown" }] },
    { repo: "/repo", trackerRepo: "a11ign/agent-org", isInstance: (session) => session.startsWith("worker-"), log: (line) => { lines.push(line); },
      stateDir: "/state", read, write });
  const orders = [tick(), tick(), tick()];
  assert.deepEqual(orders.map((o) => o.map((order) => order.release?.why)), [["closed"], ["closed"], ["closed"]], "the claim is released on every tick it is still on the row");
  const said = lines.filter((line) => /closed by its own pull request \(#1378\)/.test(line));
  assert.equal(said.length, 1, "the own-pull-request line is said once, not once per tick");
});
