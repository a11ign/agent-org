// no-token: none -- the fake code host's rows answer from a world held in memory; `log` is an injected seam; nothing here reaches `gh` or the network (A11-160, step 6)
/**
 * #948: A REFUSED CLOSED-CLAIM READ SAYS WHY.
 *
 * `readClosedClaimedRows` returned `null` from a bare `catch`, so the tick printed "UNREAD" on 31 consecutive ticks and nothing said what refused. Each case calls the gate's own read (`closedClaimsWhenWorkerListed`), never a copy
 * of it, and the log is the only thing asserted on a refusal: the answer is `null` before and after the change. THE CONTROL is a closed claimed row read successfully, which must log NOTHING. The read is the code host's
 * operation since A11-160 (step 6), so the refusal is the fake code host's (`world.failures`); the two cases about an answer that is not JSON are the operation's, and are held beside it
 * (`plugins/github/rows/closed-claim-reads.test.ts`, #948 (2, 3)).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import { closedClaimsWhenWorkerListed } from "./work-gate/tick.ts";

const agents = [{ label: "worker-5011", status: "working" }];
const CLAIM = ["in-progress", "session:worker-5011"];

afterEach(() => forgetActivation());

/** The fake code host in place, holding row 5011 closed and still carrying the claim. */
function closedClaim() {
  const host = createFakeCodeHost();
  host.rowsWorld.rows.set(5011, fakeRow(host.rowsWorld, 5011, { state: "CLOSED", labels: CLAIM, closedAt: "2026-10-12T19:00:00Z" }));
  substituteCodeHost(host);
  return host.rowsWorld;
}

test("#948 (1) a refused call names gh's own first stderr line on the log", () => {
  const log: string[] = [];
  closedClaim().failures.set("closedClaimedRowsOf", Object.assign(new Error("Command failed: gh api repos/a11ign/agent-org/issues/5011"), { status: 1,
    stderr: "gh: Could not resolve to an Issue with the number 5011.\nmore detail\n" }));
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, undefined, (line) => log.push(line)), { rows: null, agents }, "a refusal is still UNREAD, not an empty list");
  assert.ok(log.some((line) => /^closed-claim: the read of \S+ was refused: gh: Could not resolve to an Issue with the number 5011\.\n$/.test(line)), `the cause is on the log: ${JSON.stringify(log)}`);
});

test("#948 (4) CONTROL: a closed claimed row read successfully logs NOTHING", () => {
  const log: string[] = [];
  closedClaim();
  const read = closedClaimsWhenWorkerListed(agents, undefined, (line) => log.push(line));
  assert.deepEqual(read?.rows?.map((row) => row.number), [5011], "the closed claim is read");
  assert.deepEqual(log, [], "no cause is printed for a read that succeeded");
});
