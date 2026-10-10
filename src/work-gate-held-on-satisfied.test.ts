// no-token: gh -- importing `work-gate.ts` reaches `defaultRun`, and this file never lets it run: `waitTickFacts` is handed a fake `run` AND fake release readers, `orgHealthNow` the clock, the last merge and the log
/**
 * #4005: A ROW HELD ON A CONDITION THAT IS ALREADY TRUE, OR ON AN UMBRELLA ROW THAT NAMES NO CONDITION. The fixtures are the rows of 2026-10-07, built from the shapes the
 * issue timeline recorded (`blocked_by_added` onto #3778): #2568, #3202, #3361 and #3950 needed only that a version EXISTS on the registry and sat from 17:13Z until `ceo` lifted
 * the edges by hand at 17:35Z; #3224, #3298 and #3299 needed the Action's tag, which did not exist, and were RIGHT to wait.
 *
 * THE REGISTRY FACT IS `{"latest":"0.1.0","next":"0.3.0"}` and the clock is after 17:15Z, when `next` became visible (measured 2026-10-07).
 *
 * MUTATION, run by hand 2026-10-07 and recorded on the row, each restored byte-identical (`diff` of a copy), over this file and `wait-release-states.test.ts`:
 * `releaseHolds` ALWAYS TRUE turns 7 red (the three controls, the failed read, the unpublished `next`, `latest = next`, and the truth tables); ALWAYS FALSE 6 (the four of (c)(i), the tag
 * rows once the tag exists, and the truth tables); `umbrellaEdge` ALWAYS NULL 4 (the four of (c)(ii), the row-file and audit cases, its own table); ALWAYS A HIT 10 (the one-done-when
 * control among them, and every control that expects silence).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, withPrOwners, waitTickFacts, orgHealthNow } from "./work-gate.ts";

const NOW = Date.parse("2026-10-07T17:20:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();
const REGISTRY = { latest: "0.1.0", next: "0.3.0" };
const FIVE_DONE_WHENS = ["## Done-when", ...[1, 2, 3, 4, 5].map((n) => `${n}. done-when ${n}`), "", "## Fleet", "No."].join("\n");
const umbrella = { number: 3778, labels: [{ name: "in-progress" }, { name: "session:worker-3778" }], body: FIVE_DONE_WHENS, updatedAt: ISO(NOW - 3_600_000), blockedBy: { nodes: [] } };
const oneDoneWhen = { ...umbrella, number: 3779, body: "## Done-when\n\n1. the only one\n" };

/** A `ready` row with the native edge `blocked_by_added` recorded, 5 done-whens on the other end. */
const held = (number: number, body = "", blocker = 3778) => ({
  number, labels: [{ name: "ready" }, { name: "lane:any" }], body, updatedAt: ISO(NOW - 3_000_000),
  blockedBy: { nodes: [{ number: blocker, state: "OPEN" }] },
});

type Readers = { distTags: (pkg: string) => Record<string, string> | null; tagExists: (tag: string) => boolean | null };
const readers = (over: Partial<Readers> = {}): Readers => ({ distTags: () => REGISTRY, tagExists: () => false, ...over });

function tick(rows: unknown[], via: Readers) {
  const prs = withPrOwners([] as never, rows as never, () => null);
  const decideArgs = { prs, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: rows, primaryDrift: null, claimRefusals: [] };
  const decided = decide({ prs, readyRows: [], openRows: rows } as never);
  const orders = orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: rows, decideArgs, decided } as never,
    { now: NOW, lastMergedAt: () => NOW - 3_600_000, log: () => {}, readCaptures: (() => undefined) as never,
      readWaits: ((args: never) => waitTickFacts({ ...(args as Parameters<typeof waitTickFacts>[0]), run: () => { throw new Error("refused"); }, readers: via })) as never,
      release: (() => false) as never, teamAccess: () => undefined });
  return (orders as { session: string; subject: string; prompt: string }[]).filter((o) => o.session === "product-manager");
}
const subjects = (orders: { subject: string }[]) => orders.map((o) => o.subject).sort();

const FOUR = [2568, 3202, 3361, 3950];

test("(c)(ii): the four of 2026-10-07, each `ready` behind #3778 with no condition, are reported as `umbrella edge`, to product-manager", () => {
  const orders = tick([umbrella, ...FOUR.map((n) => held(n))], readers());
  assert.deepEqual(subjects(orders), FOUR.map((n) => `umbrella-edge-${n}`));
  assert.match(orders[0].prompt, /#3778, a row of 5 done-whens/);
});

test("(c)(i): the same four, each expressed as `Waiting-for: published a11ign@next`, are reported as HELD ON A SATISFIED CONDITION", () => {
  const rows = [umbrella, ...FOUR.map((n) => held(n, "Waiting-for: published a11ign@next"))];
  const orders = tick(rows, readers());
  assert.deepEqual(subjects(orders), FOUR.map((n) => `held-on-satisfied-${n}`), "and no umbrella order: a row that names its condition is not an umbrella edge");
  assert.match(orders[0].prompt, /HELD ON A SATISFIED CONDITION/);
  assert.match(orders[0].prompt, /Waiting-for: published a11ign@next/);
});

test("CONTROL: #3224, #3298 and #3299 with `Waiting-for: tagged v0` and NO tag on the remote raise nothing -- they are right to wait", () => {
  const rows = [umbrella, ...[3224, 3298, 3299].map((n) => held(n, "Waiting-for: tagged v0"))];
  assert.deepEqual(tick(rows, readers({ tagExists: () => false })), []);
});

test("the same rows once the tag exists ARE held on a satisfied condition (the control is not vacuous)", () => {
  const rows = [umbrella, ...[3224, 3298, 3299].map((n) => held(n, "Waiting-for: tagged v0"))];
  assert.deepEqual(subjects(tick(rows, readers({ tagExists: () => true }))), [3224, 3298, 3299].map((n) => `held-on-satisfied-${n}`));
});

test("CONTROL: a registry read that FAILS raises nothing for a published wait -- unknown, never true", () => {
  const rows = [umbrella, ...FOUR.map((n) => held(n, "Waiting-for: published a11ign@next"))];
  assert.deepEqual(tick(rows, readers({ distTags: () => null })), []);
});

test("CONTROL: `next` not yet published (the registry says only `latest`) raises nothing", () => {
  const rows = [umbrella, held(2568, "Waiting-for: published a11ign@next")];
  assert.deepEqual(tick(rows, readers({ distTags: () => ({ latest: "0.1.0" }) })), []);
});

test("CONTROL: a `ready` row with a native edge onto a ONE-done-when row raises nothing", () => {
  assert.deepEqual(tick([oneDoneWhen, held(2568, "", 3779)], readers()), []);
});

test("a blocker that is not among the open rows read is NOT judged: its done-whens are unknown", () => {
  assert.deepEqual(tick([held(2568, "", 9999)], readers()), []);
});

test("a row that is not `ready` is not reported: the umbrella edge is a ready row's defect", () => {
  assert.deepEqual(tick([umbrella, { ...held(2568), labels: [{ name: "backlog" }] }], readers()), []);
});

test("`a11ign latest = next` is held-on-satisfied only once the two dist-tags name the same version", () => {
  const row = held(2568, "Waiting-for: a11ign latest = next");
  assert.deepEqual(tick([umbrella, row], readers()), [], "next is ahead of latest");
  assert.deepEqual(subjects(tick([umbrella, row], readers({ distTags: () => ({ latest: "0.3.0", next: "0.3.0" }) }))), ["held-on-satisfied-2568"]);
});

test("the registry is read ONCE for four waits naming the same package (the read is per distinct fact)", () => {
  let reads = 0;
  tick([umbrella, ...FOUR.map((n) => held(n, "Waiting-for: published a11ign@next"))], readers({ distTags: () => { reads += 1; return REGISTRY; } }));
  assert.equal(reads, 1);
});
