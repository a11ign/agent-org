// no-token: none -- the rows `escalateStuck` reads and writes are the fake code host's (A11-160, step 7), and the repository declaration is injected as `repoOf`; nothing imported reaches `gh`
/**
 * #656: A FILED STUCK-CAUSE ROW IS ASKED ONCE MORE AN HOUR AFTER IT IS ANSWERED, AS A LABEL ROW IS.
 *
 * #622 closes the row `fileRepositoryRow` filed when its `answer:ceo` is removed, and says the existing re-ask files a new one an hour
 * later. It did not: `reaskCleared` is called for a label row only, and a filed row's key stays in the ledger's `escalated` set, so a cause
 * still true after the close was silent until its causeKey changed. The once-rule's memory is the closed rows of the title, read back.
 *
 * THE CLAIMS, each with its control in the same fixture: a row closed an hour ago whose cause is still emitted is filed once more; one
 * closed less than an hour ago is not; a second closed row of the title is not followed by a third; an open row of the title is not
 * doubled. Make `reaskFiledRow` never file and the first goes red; make it file whatever it finds and the other three do.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL, REASK_AFTER_MS } from "./wake/merge-queue-wait.ts";
import { MAX_DELIVERIES } from "./wake/fyi-delivery-and-limits.ts";
import { PARKED_LABEL } from "./wait-condition.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());
/** The `run` the tick is handed: the rows are the fake's, so nothing may reach it. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host answers every read; nothing may run ${args.join(" ")}`); };
const FIRST_FILED = 3200;
/** The numbers of the rows a world was given, by world: the rows past them are the ones the tick filed. */
const given = new WeakMap<object, Set<number>>();

const SHA = "0123abcd";
const MERGED = `worker-3075/trunk-red/pr-agent-org#56/${SHA}`;
const PRIMARY = `worker-3075/trunk-red/pr-56/${SHA}`;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

type Hit = { number: number; title: string; state: "OPEN" | "CLOSED"; closedAt: string | null };

/** A fake code host whose next filed row is #3200 and which holds `hits` as the rows of the parked label, closed or open. */
function hostHolding(hits: Hit[] = []) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.nextNumber = FIRST_FILED;
  world.now = () => NOW;
  for (const hit of hits) world.rows.set(hit.number, fakeRow(world, hit.number, { title: hit.title, labels: [PARKED_LABEL], state: hit.state, closedAt: hit.closedAt }));
  given.set(world, new Set(hits.map((hit) => hit.number)));
  substituteCodeHost(host);
  return world;
}

/** The rows the tick filed: the ones past the rows it was given. */
const filedRows = (world: ReturnType<typeof hostHolding>) => [...world.rows.values()].filter((row) => !given.get(world)!.has(row.number));

/** The title the tick files for `MERGED`, read off a first escalation so the fixture does not restate its wording. */
const filedTitle = (() => {
  const world = hostHolding();
  escalateStuck([`${MERGED}: x`], noRun, () => {}, { repoOf: declared });
  forgetActivation();
  return filedRows(world)[0].title;
})();

const closedAgo = (ms: number, number = 3101, title = filedTitle): Hit => ({ number, title, state: "CLOSED", closedAt: new Date(NOW - ms).toISOString() });
const opened = (number = 3102, title = filedTitle): Hit => ({ number, title, state: "OPEN", closedAt: null });

/**
 * One tick over a key already escalated whose cause is still emitted; `hits` is what the title's rows are: the closed ones are the CLOSED rows of the parked label, the open ones its OPEN rows.
 * The fake holds them, and a `run` that throws is handed to the tick so a read that reached for `gh` fails the fixture.
 */
function tick(key: string, hits: Hit[], { refuse }: { refuse?: string } = {}) {
  const world = hostHolding(hits);
  if (refuse !== undefined) world.failures.set(refuse, new Error("HTTP 502"));
  const log: string[] = [];
  const posts: { row: number; body: string }[] = [];
  const ask = { post: (row: number, body: string) => { posts.push({ row, body }); }, stateOf: () => "idle", now: () => NOW };
  const labelled = escalateStuck([`${key}: delivered ${MAX_DELIVERIES} times`], noRun, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([key]), ask });
  const creates = filedRows(world);
  return { world, creates, posts, labelled, log: log.join("") };
}

test("a filed row closed an hour ago whose cause is still emitted is filed once more", () => {
  const { creates, labelled, log, posts } = tick(MERGED, [closedAgo(REASK_AFTER_MS)]);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].title, filedTitle, "the same title: it is the dedupe key");
  assert.ok(creates[0].labels.includes(ESCALATION_LABEL), "born waiting on ceo");
  assert.deepEqual(labelled, [3200]);
  assert.match(log, /ASKED AGAIN #3200 -> answer:ceo \(.*#3101 closed 60 minutes ago, cause still true\)/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].row, 3200);
  assert.ok(posts[0].body.includes(MERGED) && posts[0].body.includes("#3101"), "the comment names the cause and the row that asked before");
});

test("a row closed less than an hour ago is not filed again", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(REASK_AFTER_MS - 60_000)]).creates, []);
  // CONTROL: the same row one minute older is the one filed.
  assert.equal(tick(MERGED, [closedAgo(REASK_AFTER_MS + 60_000)]).creates.length, 1);
});

test("a second closed row of the title is not followed by a third", () => {
  const { creates, log } = tick(MERGED, [closedAgo(3 * REASK_AFTER_MS, 3101), closedAgo(2 * REASK_AFTER_MS, 3201)]);
  assert.deepEqual(creates, []);
  assert.doesNotMatch(log, /ASKED AGAIN/);
  // CONTROL: the first of them alone is filed from.
  assert.equal(tick(MERGED, [closedAgo(3 * REASK_AFTER_MS, 3101)]).creates.length, 1);
});

test("an open row of the title is the question already asked, and is not doubled", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(2 * REASK_AFTER_MS), opened()]).creates, []);
});

test("a row of another title is not the row, and a title never filed has nothing to ask again", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(2 * REASK_AFTER_MS, 3101, "Stuck trunk-red: another -- a different cause")]).creates, []);
  assert.deepEqual(tick(MERGED, []).creates, [], "no closed row: the cause was never asked, so there is no 'once more'");
});

test("a label row of the primary is not read here: its re-ask is `reaskCleared`", () => {
  const { creates, log } = tick(PRIMARY, [closedAgo(2 * REASK_AFTER_MS)], { refuse: "readRowsByLabel" });
  assert.deepEqual(creates, []);
  assert.doesNotMatch(log, /COULD NOT ASK AGAIN/, "the closed rows of the title were not read for it: a refused read would have been said");
});

test("a caller with no asker files nothing, as the label row's re-ask does", () => {
  const world = hostHolding([closedAgo(2 * REASK_AFTER_MS)]);
  escalateStuck([`${MERGED}: x`], noRun, () => {}, { repoOf: declared, escalated: new Set([MERGED]) });
  assert.deepEqual(filedRows(world), []);
});

test("a refused read is reported, not thrown, and files nothing", () => {
  const { creates, log } = tick(MERGED, [], { refuse: "readRowsByLabel" });
  assert.deepEqual(creates, []);
  assert.match(log, /COULD NOT ASK AGAIN \(.*\): HTTP 502/);
});
