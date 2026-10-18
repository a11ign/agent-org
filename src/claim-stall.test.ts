// no-token: gh -- no `gh` is reached; the referenced item's state is a fixture
// #1281 (class `row-not-finishable`): `unmetWaitingFor` is the reading a CLAIM asks of a row's `Waiting-for:` line, the one the gate's release acts on.
// Each refusal has its control with one fact changed: the same line with its condition met, and the same line read as unknown.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "./host-config.ts";
import type { RefFact } from "./wait-condition.ts";

// #1463: the composed control reads the gate's own tick, whose state directory is `REVIEWER_STATE_DIR`, bound when the module that declares it is first
// imported. So EVERY module of the gate is imported below, AFTER the state directory is set: a static import here would bind the real one first (imports
// are hoisted above this code). The state directory is a temporary copy, marked as the shadow-window runner's copy, the only thing `stateEntryPath` stands in for.
const STATE = mkdtempSync(join(tmpdir(), "claim-stall-1463-"));
after(() => rmSync(STATE, { recursive: true, force: true }));
writeFileSync(join(STATE, SHADOW_COPY_MARKER), "");
process.env[SHADOW_STATE_DIR_ENV] = STATE;
const { unmetWaitingFor } = await import("./claim-stall/claim-stalled.ts");
const { closedClaimsNow } = await import("./work-gate/claim-stall-tick.ts");
const { claimStallsWithFacts, withClosedClaims } = await import("./work-gate/tick.ts");

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

test("#1463 POSITIVE CONTROL, through the gate's own tick: a closed row whose OWN pull request closed it is released on each of three ticks, and said ONCE", () => {
  const row = { number: 1325, labels: ["in-progress", "started", "session:worker-agent-org-1325"].map((name) => ({ name })), comments: [],
    closedByPullRequestsReferences: [{ number: 1378, headRefName: "agent/pr-follow-ups-go-agent-org-1325", title: "x" }] };
  const closed = { rows: [row], agents: [{ label: "worker-agent-org-1325", status: "unknown" }] };
  // The tick's composition (`work-gate.ts`): `claimStallsWithFacts` runs `claimStallTick` over the OPEN rows (none here), and `withClosedClaims` adds the closed row's
  // release beside them. Both say on stderr, so that is captured: the once-line is counted there.
  const said: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let releases: (string | undefined)[][];
  try {
    releases = [1, 2, 3].map(() => withClosedClaims(claimStallsWithFacts([], [], [], [] as never), closed as never).claimStalls.map((order) => order.release?.why));
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(releases, [["closed"], ["closed"], ["closed"]], "the claim is released on every tick it is still on the row");
  assert.equal(said.filter((line) => /closed by its own pull request \(#1378\)/.test(line)).length, 1, "the own-pull-request line is said once, not once per tick");
});

test("#1463 the once-memory alone: a closed row whose OWN pull request closed it is released, and the line is said ONCE per stand: three ticks with the same memory", () => {
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
