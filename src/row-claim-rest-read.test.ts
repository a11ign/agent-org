// no-token: none -- the fake code host's rows answer every read from a world held in memory; nothing here reaches `gh` or the network
/**
 * `src/row-claim.ts`, agent-org#1302 (a11ign/a11ign#5282, class `claim-refused`): THE CLAIM PATH'S ISSUE READS GO OVER REST. `fetchLabels` and `fetchClaimComments` were
 * `gh issue view`, which is GraphQL, so an exhausted GraphQL pool refused every claim it read. REST is another pool on the same token (#1113), and both reads now ask it.
 *
 * A11-160, step 7: THE READ AND THE READING OF GITHUB'S ANSWER ARE THE CODE HOST'S (`readRestRow`, `readRestComments`; the argument lists, the JSON and the shape of the answer are tested in
 * `plugins/github/rows/claim-ops.test.ts`). What stays here is the claim's: the IssueClaim it makes of a row, and the refusal it says when the read failed or the answer was not a row, naming what `gh` said.
 *
 * MUTATIONS, each run by hand with the file copied to the scratchpad and restored byte-identical after: the state dropped from the IssueClaim (case 2 goes red); the comments window widened past the
 * last 100 (case 6, in the fake and in the plugin's test).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fetchClaimComments, fetchLabels } from "./row-claim.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

const REPO = "a11ign/agent-org";
const ROW = 1302;

afterEach(() => forgetActivation());

/** The fake code host holding row #1302 of `REPO` with `over`, active for the case. */
function held(over: Parameters<typeof fakeRow>[2] = {}) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  host.rowsWorld.rows.set(ROW, fakeRow(host.rowsWorld, ROW, { title: "A row", ...over }));
  substituteCodeHost(host);
  return host.rowsWorld;
}

/** The refusal `gh` gave, in the shape `execFileSync` threw it. */
const refusal = (stderr: string) => Object.assign(new Error("Command failed: gh api"), { status: 1, stderr });

test("#1302 (2) a REST row maps to the IssueClaim: labels, title, number, and the state in the upper case callers read", () => {
  held({ state: "CLOSED", labels: ["in-progress", "started"] });
  assert.deepEqual(fetchLabels(ROW, { repo: REPO }), { number: ROW, title: "A row", labels: ["in-progress", "started"], state: "CLOSED" });
  held({ state: "OPEN", labels: [] });
  assert.equal(fetchLabels(ROW, { repo: REPO }).state, "OPEN");
});

test("#1302 (4) a failed REST read refuses to guess: it throws `could not read issue`, and says what gh said", () => {
  const world = held();
  world.failures.set("readRestRow", refusal("gh: API rate limit exceeded for user ID 328832207."));
  assert.throws(() => fetchLabels(ROW, { repo: REPO }), (error: Error) => {
    assert.match(error.message, /could not read issue #1302 from a11ign\/agent-org -- refusing to guess/);
    assert.match(error.message, /\(api-pool-exhausted; gh said: gh: API rate limit exceeded/);
    return true;
  });
});

test("#1302 (5) a non-JSON or shapeless REST answer refuses to guess and throws, and names no empty label list", () => {
  const world = held();
  world.claim.unreadable.set(ROW, "row-claim: gh's response for issue #1302 was not JSON -- refusing to guess. First 200 chars: <html>502</html>");
  assert.throws(() => fetchLabels(ROW, { repo: REPO }), /was not JSON -- refusing to guess/);
  world.claim.unreadable.set(ROW, "row-claim: gh's response for issue #1302 is missing number/title/labels -- refusing to guess. Got: {}");
  assert.throws(() => fetchLabels(ROW, { repo: REPO }), /is missing number\/title\/labels/);
});

test("#1302 (6) the comments are the last 100 bodies, oldest first, as GraphQL's comments(last: 100) gave them", () => {
  const world = held({ comments: Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}`, createdAt: "2026-10-04T10:00:00Z" })) });
  const bodies = fetchClaimComments(ROW, { repo: REPO });
  assert.equal(bodies.length, 100);
  assert.equal(bodies[0], "comment 51");
  assert.equal(bodies.at(-1), "comment 150");
  assert.ok(world.calls.includes(`readRestComments ${REPO}#${ROW}`), "one read of the comments");
});

test("#1302 (7) a comments answer that is not a list of pages refuses to guess, and a failed read names what gh said", () => {
  const world = held();
  world.claim.commentsUnreadable.set(ROW, "row-claim: gh's response for issue #1302's comments was not a list of pages -- refusing to guess. Got: {\"comments\":[]}");
  assert.throws(() => fetchClaimComments(ROW, { repo: REPO }), /was not a list of pages -- refusing to guess/);
  world.claim.commentsUnreadable.delete(ROW);
  world.failures.set("readRestComments", refusal("HTTP 403: API rate limit exceeded"));
  assert.throws(() => fetchClaimComments(ROW, { repo: REPO }), /could not read issue #1302's comments .*api-pool-exhausted; gh said: HTTP 403/);
});

test("#1302 (8) CONTROL: a row with no comments reads as none", () => {
  held();
  assert.deepEqual(fetchClaimComments(ROW, { repo: REPO }), []);
});
