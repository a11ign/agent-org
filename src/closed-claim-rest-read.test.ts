// no-token: none -- the fake code host's rows answer from a world held in memory; nothing here reaches `gh` or the network (A11-160, step 6)
/**
 * agent-org#1113: THE CLOSED-CLAIM READ GOES OVER REST, SO AN EXHAUSTED GRAPHQL POOL NO LONGER LEAVES A CLOSED ROW'S CLAIM UNREAD.
 *
 * The read was one `gh api graphql` call per tracker per tick, and the GraphQL pool of the account that runs the tick ran dry (measured 2026-10-12: 0 to 30 of 5000, the line repeating for 30+ ticks). REST is another pool
 * (`core`) on the same token. EVERY CASE CALLS `readClosedClaimedRows` ITSELF. Since A11-160 (step 6) the read is the code host's operation (`closedClaimedRowsOf`) and these cases run on the fake code host's rows: what the
 * gate DECIDES of the rows it gets back (which are dropped, what a refusal says, how a keyed tracker's are tagged) is held here, and the REST paths the GitHub plugin asks, how it pages the comments and the timeline and what it
 * does with a 404 are held beside the operation (`plugins/github/rows/closed-claim-reads.test.ts`, moved from this file).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow, type FakeRow } from "./plugins/fakes/code-host-rows.ts";
import { readClosedClaimedRows } from "./work-gate/causes/rows-claims-closed.ts";

const CLAIM = ["in-progress", "started", "session:worker-5011"];

afterEach(() => forgetActivation());

/** The fake code host in place, and its world; `request` records what each closed-claim read was asked. */
function world() {
  const host = createFakeCodeHost();
  const asked: { repo: string; aim: string | undefined; numbers: number[] }[] = [];
  const read = host.rows!.closedClaimedRowsOf;
  host.rows!.closedClaimedRowsOf = (request) => { asked.push({ repo: request.repo, aim: request.aim, numbers: request.numbers }); return read(request); };
  substituteCodeHost(host);
  return { world: host.rowsWorld, asked };
}
const row = (w: ReturnType<typeof world>["world"], number: number, state: FakeRow["state"], labels: string[], comments: string[] = []) => {
  w.rows.set(number, fakeRow(w, number, { state, labels, closedAt: state === "CLOSED" ? "2026-10-12T19:00:00Z" : null,
    comments: comments.map((body, at) => ({ id: at + 1, body, createdAt: "2026-10-12T19:30:00Z", author: "a11ign-ai-workers" })) }));
};
const refusal = (stderr: string) => Object.assign(new Error("Command failed: gh api"), { status: 1, stderr });

test("#1113 (1) a closed claimed row comes back with its labels, its last comments and the pull request that cross-referenced it", () => {
  const { world: w } = world();
  row(w, 5011, "CLOSED", CLAIM, ["the claim record"]);
  w.gate.crossReferences.set(5011, [{ number: 412, headRefName: "agent/a-fix-5011", title: "the fix" }]);
  assert.deepEqual(readClosedClaimedRows([5011], undefined, undefined, () => assert.fail("nothing is refused")), [{ number: 5011, labels: CLAIM.map((name) => ({ name })),
    comments: [{ body: "the claim record", createdAt: "2026-10-12T19:30:00Z", author: { login: "a11ign-ai-workers" } }],
    closedByPullRequestsReferences: [{ number: 412, headRefName: "agent/a-fix-5011", title: "the fix" }] }]);
});

test("#1113 (2) an open row, a closed row without the claim and an absent row are dropped, and an absent row is no claim, not a refusal", () => {
  const { world: w } = world();
  row(w, 5011, "OPEN", CLAIM);
  row(w, 5012, "CLOSED", ["started"]);
  const log: string[] = [];
  assert.deepEqual(readClosedClaimedRows([5011, 5012, 5013], undefined, undefined, (line) => log.push(line)), []);
  assert.deepEqual(log, [], "an absent row (HTTP 404) is no claim, not a refusal");
});

test("#1113 (3, 4) a refused read answers null and says why on the log, whichever of its reads GitHub refused: a closed claimed row whose record cannot be read is not returned without it", () => {
  const { world: w } = world();
  row(w, 5011, "CLOSED", CLAIM, ["the claim record"]);
  for (const why of ["HTTP 502: Bad Gateway", "HTTP 503: comments"]) {
    w.failures.set("closedClaimedRowsOf", refusal(why));
    const log: string[] = [];
    assert.equal(readClosedClaimedRows([5011], undefined, undefined, (line) => log.push(line)), null, "a refusal is UNREAD, not an empty list");
    assert.ok(log.some((line) => new RegExp(`^closed-claim: the read of \\S+ was refused: ${why}\\n$`).test(line)), JSON.stringify(log));
  }
  w.failures.clear();
  assert.equal(readClosedClaimedRows([5011], undefined, undefined, () => assert.fail("nothing is refused"))?.length, 1, "CONTROL: the same world unrefused is read");
});

test("#1113 (5) CONTROL: every listed row open returns [], not null, and logs nothing", () => {
  const { world: w } = world();
  row(w, 5011, "OPEN", CLAIM);
  row(w, 5012, "OPEN", CLAIM);
  const log: string[] = [];
  assert.deepEqual(readClosedClaimedRows([5011, 5012], undefined, undefined, (line) => log.push(line)), []);
  assert.deepEqual(log, []);
});

test("#1113 (6) a keyed tracker's rows are read in that tracker's repository (the read is aimed at it) and tagged with it", () => {
  const { world: w, asked } = world();
  row(w, 730, "CLOSED", ["in-progress", "session:worker-agent-org-730"], ["the claim record"]);
  const tracker = { key: "agent-org", repo: "a11ign/agent-org" };
  const rows = readClosedClaimedRows([730], undefined, tracker, () => assert.fail("nothing is refused"));
  assert.deepEqual(rows?.map((claimed) => [claimed.number, claimed.tracker]), [[730, tracker]]);
  assert.deepEqual(asked, [{ repo: tracker.repo, aim: tracker.repo, numbers: [730] }], "asked of the tracker's repository and aimed at it");
  readClosedClaimedRows([730], undefined, undefined, () => assert.fail("nothing is refused"));
  assert.equal(asked[1].aim, undefined, "CONTROL: the home tracker's read is aimed nowhere, as it always was");
});
