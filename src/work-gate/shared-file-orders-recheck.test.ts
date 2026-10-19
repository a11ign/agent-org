// no-token: gh -- pure: `sharedFileOrders` over in-memory pull requests with `recheck` on and off; nothing reaches `gh`, `git` or herdr
/**
 * #1165: A HOLD IS RE-CHECKED AGAINST THE CURRENT FILES, AND THE APPROVED GREEN PULL REQUEST GOES FIRST. Behind `RECHECK_FLAG`, shipped OFF.
 *
 * THE FIXTURES ARE THE TWO INCIDENTS THE ROW NAMES: agent-org#1131 held behind #1130 on a file #1130 later dropped (the hold outlived its
 * overlap), and an approved, green #1131 that waited on #1130 only because #1130 had the lower number. Each fixture is the one fact that
 * the row changes, against the same call with the flag off.
 *
 * POSITIVE CONTROLS: every "nothing" below is read against the same call that orders something. The OFF cases are pinned to what the
 * ordering said before this row, so a change to the default is a failure here and not a silent drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sharedFileOrders, RECHECK_FLAG } from "./shared-file-orders.ts";
import { testEach } from "../lib/test-each.ts";

type Order = { session: string, fallback?: string, cause: string, causeKey: string, prompt: string, subject: string, discriminator: string };
type Pr = { number: number, files: { path: string }[], changedFiles: number, labels: { name: string }[], body: string, comments: unknown[],
  headRefName: string, reviewDecision?: string | null, isDraft?: boolean, mergeStateStatus?: string, statusCheckRollup?: unknown[] };

const GREEN = [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED = [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }];
const APPROVED = { reviewDecision: "APPROVED", statusCheckRollup: GREEN };
const HOLD = { name: "hold:worker-149" };
const WAIT = "Waiting-for: merged #148";

const prOf = (number: number, paths: string[], over: Partial<Pr> & { session?: string | null } = {}): Pr => {
  const { session = `worker-${number}`, ...rest } = over;
  return { number, files: paths.map((path) => ({ path })), changedFiles: paths.length, headRefName: `agent/some-slug-${number}`,
    labels: session === null ? [] : [{ name: `session:${session}` }], body: "", comments: [], mergeStateStatus: "CLEAN", statusCheckRollup: [], reviewDecision: null,
    isDraft: false, ...rest };
};
const ordersOf = (prs: Pr[], recheck: boolean): Order[] => sharedFileOrders(prs, () => undefined, { recheck }) as Order[];
const quiet = () => undefined;

const OFF = false;
const ON = true;

test(`(1) ${RECHECK_FLAG}: a hold whose overlap has gone is released -- #148 dropped the shared file, #149 still holds behind it`, () => {
  // #149 was held behind #148 on `src/shared.ts`; #148 has since dropped that file, so the two share nothing and the hold is not a sequence
  const prs = () => [prOf(148, ["src/a.ts"]), prOf(149, ["src/shared.ts"], { labels: [{ name: "session:worker-149" }, HOLD], body: WAIT })];
  assert.deepEqual(ordersOf(prs(), OFF), [], "off: today's ordering, which reads the hold and says nothing");
  const [release, ...rest] = ordersOf(prs(), ON);
  assert.equal(rest.length, 0, "one order, to the owner of the held pull request");
  assert.equal(release.session, "worker-149");
  assert.equal(release.subject, "pr-149");
  assert.match(release.prompt, /#149 is held behind #148 \(`Waiting-for: merged`\), but it no longer shares an open file with it/);
  assert.match(release.prompt, /`pnpm run pr:release 149 --session=worker-149`/, "the release is the owner's, with the command that lifts it");
  assert.doesNotMatch(release.prompt, /pr:hold/, "a released hold is not taken again");
  assert.equal(release.cause, "pr-merge-conflict", "filed under the existing cause");
});

test(`(1) the CONTROL: the same hold with the overlap still there is still a sequence, and is not released`, () => {
  const prs = [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], { labels: [{ name: "session:worker-149" }, HOLD], body: WAIT })];
  assert.deepEqual(ordersOf(prs, ON), [], "sequenced and overlapping: nothing to say, the hold is doing its job");
});

test("(1) the CONTROL: a hold with no wait on the pull request ahead is nobody's sequence, so it is not released", () => {
  const prs = [prOf(148, ["src/a.ts"]), prOf(149, ["src/shared.ts"], { labels: [{ name: "session:worker-149" }, HOLD], body: "Waiting-for: merged #999" })];
  assert.deepEqual(ordersOf(prs, ON), [], "a wait for some OTHER pull request is not the one that held it");
});

test(`(2) ${RECHECK_FLAG}: the approved, green pull request goes first, although it was opened later`, () => {
  // #148 is not approved; #149 (opened later) is approved and green and changes the same file, so #148 is the one told to hold
  const prs = () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], APPROVED)];
  const [off] = ordersOf(prs(), OFF);
  assert.equal(off.session, "worker-149", "off: the later number is told to hold, whatever its approval");
  assert.match(off.prompt, /#148, which is ahead of it \(opened first\)/);
  const orders = ordersOf(prs(), ON);
  assert.equal(orders.length, 1, "one order, to the pull request that is NOT approved");
  assert.equal(orders[0].session, "worker-148");
  assert.equal(orders[0].subject, "pr-148");
  assert.match(orders[0].prompt, /#149, which is ahead of it \(approved and green, so it goes first\), on `src\/shared\.ts`/);
  assert.match(orders[0].prompt, /hold behind it \(`Waiting-for: merged #149`\)/);
  assert.match(orders[0].prompt, /`pnpm run pr:hold 148 --session=worker-148 --until="merged #149"`/);
});

test("(2) the CONTROL: an approval on RED checks is not approved and green, so the number still decides", () => {
  const prs = [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], { reviewDecision: "APPROVED", statusCheckRollup: RED })];
  const orders = ordersOf(prs, ON);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "worker-149", "the later number still holds: nothing about #149 is green");
  assert.match(orders[0].prompt, /\(opened first\)/);
});

test("(2) the CONTROL: two approved pull requests overlapping keep the number order, since neither is ahead by approval", () => {
  const prs = () => [prOf(148, ["src/shared.ts"], APPROVED), prOf(149, ["src/shared.ts"], APPROVED)];
  assert.deepEqual(ordersOf(prs(), ON), ordersOf(prs(), OFF));
  assert.equal(ordersOf(prs(), ON)[0].session, "worker-149");
});

type DirtyOrders = { off: Order; on: Order };

const DIRTY_CHECKS: { name: string; check: (orders: DirtyOrders) => void }[] = [
  {
    name: "off: the hold, as it always was",
    check: ({ off }) => assert.match(off.prompt, /Do not rebase onto `main` yet and do not ask for a review; hold behind it/, "off: the hold, as it always was"),
  },
  {
    name: "the same pull request is still the one told",
    check: ({ on }) => assert.equal(on.session, "worker-149", "the same pull request is still the one told"),
  },
  {
    name: "told to rebase now",
    check: ({ on }) => assert.match(on.prompt, /Rebase onto `main` now and push: GitHub reports #149 `DIRTY` against `main`/),
  },
  { name: "told to resolve the shared file", check: ({ on }) => assert.match(on.prompt, /Resolve `src\/shared\.ts` as you go/) },
  {
    name: "not given a hold",
    check: ({ on }) => assert.doesNotMatch(on.prompt, /pr:hold|Waiting-for|Do not rebase onto/, "a DIRTY pull request is not given a hold (the text may still say a hold would not help)"),
  },
  {
    name: "no 'until DIRTY' sentence",
    check: ({ on }) => assert.doesNotMatch(on.prompt, /Whichever merges second conflicts/, "the 'until DIRTY' sentence is false once it is DIRTY"),
  },
];

testEach(`(3) ${RECHECK_FLAG}: a pull request GitHub reports DIRTY against main is told to rebase now, and is not held`, DIRTY_CHECKS, (c) => {
  const prs = () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], { mergeStateStatus: "DIRTY" })];
  const [off] = ordersOf(prs(), OFF);
  const [on] = ordersOf(prs(), ON);
  c.check({ off, on });
});

test("(3) the CONTROL: a pull request that is not DIRTY is still held, with the flag on", () => {
  const [on] = ordersOf([prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"])], ON);
  assert.match(on.prompt, /Do not rebase onto `main` yet and do not ask for a review; hold behind it/);
});

/**
 * The OFF output of the four fixtures above, serialised with `JSON.stringify`, as `HEAD` (before #1165) produced it: the digest was taken
 * from `sharedFileOrders` at that commit, run on the same fixtures. Any byte of the OFF ordering that moves moves this digest.
 */
const HEAD_OFF_SHA256 = "0b7906bd0cac15a5c9fc90272db670406037aa27422797ac7ad86120f8925eb6";

test(`(4) ${RECHECK_FLAG} OFF is today's ordering byte for byte, on every fixture above`, () => {
  const fixtures = [
    () => [prOf(148, ["src/a.ts"]), prOf(149, ["src/shared.ts"], { labels: [{ name: "session:worker-149" }, HOLD], body: WAIT })],
    () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], APPROVED)],
    () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"], { mergeStateStatus: "DIRTY" })],
    () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts"])],
  ];
  const off = fixtures.map((fixture) => sharedFileOrders(fixture(), quiet, { recheck: OFF }));
  assert.equal(createHash("sha256").update(JSON.stringify(off)).digest("hex"), HEAD_OFF_SHA256, "OFF is not today's ordering");
  assert.deepEqual(off, fixtures.map((fixture) => sharedFileOrders(fixture(), quiet)), "the default is OFF");
});

test(`(4) ${RECHECK_FLAG} ON changes nothing for an ordinary overlap that nobody holds, approves or marks DIRTY`, () => {
  const prs = () => [prOf(148, ["src/a.ts", "src/shared.ts"]), prOf(149, ["src/shared.ts", "src/b.ts"])];
  assert.deepEqual(ordersOf(prs(), ON), ordersOf(prs(), OFF));
  assert.equal(ordersOf(prs(), ON).length, 1);
});
