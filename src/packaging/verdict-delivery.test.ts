// no-token: gh -- the pull request reads are fakes, the door is a fake, the canary state is a throwaway file; nothing reaches GitHub, herdr or a pane
/**
 * agent-org#1649: A WRITTEN REVIEWER VERDICT THAT NEVER REACHES ITS PULL REQUEST, AND A CONFLICTING PULL REQUEST WHOSE WORKER IS IDLE, ARE HEALTH SIGNALS WITHIN FIFTEEN MINUTES.
 *
 * THE DROP (a11ign#1615): the outside reviewer wrote `• BEGIN REVIEW VERDICT #1615 at ...` and the strict reader rejected the bullet, so the door was never
 * called. The row's tests, each reached from the function the gate or wake calls and not from a helper:
 *   (1) the strict reader drops the bulleted block, and `reviews.verdictDelivery`'s reader reads it, with the body's own bullets kept;
 *   (2) with the flag OFF a bulleted block is not posted; ON it is posted once, through the door;
 *   (3) the record keeps a written verdict until GitHub shows it delivered, and reports it undelivered once it has stood fifteen minutes;
 *   (4) a conflicting pull request whose owner is idle is named, and one whose owner is working, or not listed, is not;
 *   (5) the canary tick reads both signals as samples, and a refused read is `null`, never zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { FLAG_REGISTRY } from "../machinery-flag.ts";
import { CANARY_STATE_FILE, DEFAULT_CANARY_OPTIONS, MACHINERY_SIGNALS, STANDARD_MACHINERY_SIGNALS, emptyCanaryState, machineryCanaryTick, machineryFlagOn, parseCanaryState, withMachineryFlag, type CanaryIo } from "../org-health.ts";
import { OUTSIDE, outsideVerdictBlock, postOutsideVerdicts, VERDICT_DELIVERY_FLAG, type DoorRun } from "../review-trust.ts";
import { postOutsideVerdictsOf } from "../wake.ts";
import { conflictingIdleNow, conflictingIdlePrs, parseVerdictLedger, pullReadOf, reconcileLedgerNow, recordWrittenVerdicts, verdictUndeliveredNow, VERDICT_LEDGER_FILE, type PullRead } from "../verdict-delivery.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-16T12:00:00Z");
const HEAD = "5b1615ab".repeat(5);
const HEAD8 = HEAD.slice(0, 8);
const OTHER_HEAD = "c0ffee12".repeat(5);
const OPTIONS = { ...DEFAULT_CANARY_OPTIONS };

/** A verdict block the way a reviewer writes it in its pane; `bullet` is the mark Codex puts before the first line of its final message. */
function pane(pr: number, head: string, verdict: string, { bullet = false, body = "**Review body**" }: { bullet?: boolean; body?: string } = {}): string {
  return ["some review output", `${bullet ? "• " : ""}BEGIN REVIEW VERDICT #${pr} at ${head}`, `verdict: ${verdict}`, body, `END REVIEW VERDICT #${pr}`].join("\n");
}

/** A verdict comment on the pull request, in the reviewer's own opener, which `verdictAtHead` reads. */
function verdictComment(pr: number, head8: string, verdict: string) {
  return { body: `**Review of #${pr} at \`${head8}\`, by reviewer-${pr}: ${verdict}.**`, author: { login: `reviewer-${pr}` }, createdAt: "2026-10-16T12:00:00Z" };
}

test("#1649 (1) THE DROP: the strict reader rejects a bulleted block; the delivery reader reads it, and the body keeps its own bullet", () => {
  const block = pane(1615, HEAD, "convinced", { bullet: true, body: "• a bullet in the body" });
  assert.equal(outsideVerdictBlock(block, 1615), null, "the strict reader is what dropped #1615's verdict");
  assert.deepEqual(outsideVerdictBlock(block, 1615, { bulleted: true }), { head: HEAD, verdict: "convinced", body: "• a bullet in the body" });
  assert.equal(outsideVerdictBlock(pane(1615, HEAD, "convinced"), 1615, { bulleted: true })?.verdict, "convinced", "an unbulleted block reads the same");
});

test("#1649 (2) THE FLAG: OFF does not post a bulleted block; ON posts it once, through the door, as the reviewer", () => {
  const calls: string[][] = [];
  const door: DoorRun = (_file, args) => { calls.push(args); };
  const outside = [{ session: "reviewer-1650", pr: 1650 }];
  const read = () => pane(1650, HEAD, "not-convinced", { bullet: true });
  assert.deepEqual(postOutsideVerdicts({ outside, read, env: () => ({}), door: "door", run: door }), [], "the flag is OFF by default: the strict reader");
  assert.equal(calls.length, 0);
  const posted = postOutsideVerdicts({ outside, read, env: () => ({}), door: "door", run: door, delivery: true });
  assert.deepEqual(posted, [`posted the not-convinced verdict for #1650 at ${HEAD8} from outside reviewer reviewer-1650`]);
  assert.equal(calls.length, 1);
  assert.deepEqual(postOutsideVerdicts({ outside, read, env: () => ({}), door: "door", run: door, delivery: true }), [], "the same block in the scrollback is not posted again");
  assert.equal(calls.length, 1);
});

test("#1649 (3) THE RECORD: a written verdict keeps its first time, is undelivered while GitHub shows no verdict at its head, and leaves when delivered or done with", () => {
  const dir = tmpDir("verdict-delivery-");
  const file = join(dir, VERDICT_LEDGER_FILE);
  const written = [{ session: "reviewer-1651", pr: 1651, head: HEAD, verdict: "convinced" as const }];
  assert.equal(recordWrittenVerdicts({ dir, written, now: T0 }), null);
  assert.equal(recordWrittenVerdicts({ dir, written, now: T0 + 5 * MINUTE }), null, "a verdict seen again is not written again");
  assert.equal(parseVerdictLedger(readFileSync(file, "utf8"))[`reviewer-1651@${HEAD}`]?.seenAt, T0, "the clock starts when it was first written");

  const open = (comments: any[] = []): PullRead => ({ open: true, head: HEAD, comments, reviews: [] });
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => open() }), [T0], "no verdict at the head: undelivered, since its first time");
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => open([verdictComment(1651, HEAD8, "not convinced")]) }), [T0], "a verdict of the other word is not delivery");
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => open([verdictComment(1651, HEAD8, "convinced")]) }), [], "the verdict of the same word at the head is delivered");
  assert.deepEqual(parseVerdictLedger(readFileSync(file, "utf8")), {}, "a delivered verdict leaves the record");

  recordWrittenVerdicts({ dir, written: [{ ...written[0], pr: 1652 }], now: T0 });
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => ({ open: false, head: HEAD, comments: [], reviews: [] }) }), [], "a pull request no longer open is done with");
  assert.deepEqual(parseVerdictLedger(readFileSync(file, "utf8")), {});

  recordWrittenVerdicts({ dir, written: [{ ...written[0], pr: 1653 }], now: T0 });
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => open() }), [T0]);
  assert.equal(reconcileLedgerNow({ dir, pull: () => null }), null, "a refused read says nothing: unread, not zero");
  assert.deepEqual(reconcileLedgerNow({ dir, pull: () => ({ open: true, head: OTHER_HEAD, comments: [], reviews: [] }) }), [], "a head that moved on is done with");
});

test("#1649 (3) THE RECORD refuses a file that does not parse: THROWS, and the gate reads it as unread", () => {
  const dir = tmpDir("verdict-ledger-bad-");
  writeFileSync(join(dir, VERDICT_LEDGER_FILE), "[]");
  assert.throws(() => parseVerdictLedger("[]"), /not an object of written verdicts/);
  assert.equal(reconcileLedgerNow({ dir, pull: () => ({ open: true, head: HEAD, comments: [], reviews: [] }) }), null);
  writeFileSync(join(dir, VERDICT_LEDGER_FILE), "{ not json");
  assert.equal(reconcileLedgerNow({ dir, pull: () => ({ open: true, head: HEAD, comments: [], reviews: [] }) }), null);
  assert.match(recordWrittenVerdicts({ dir, written: [{ session: "reviewer-1654", pr: 1654, head: HEAD, verdict: "convinced" }], now: T0 }) ?? "", /verdict-written not recorded/);
});

test("#1649 (3) THE READ of GitHub asks for the state, the head and the verdict-bearing fields, and a refused read is null", () => {
  const asked: string[][] = [];
  const read = pullReadOf((args) => { asked.push(args); return JSON.stringify({ state: "OPEN", headRefOid: HEAD, comments: [], reviews: [] }); }, "a11ign/a11ign");
  assert.deepEqual(read(1655), { open: true, head: HEAD, comments: [], reviews: [] });
  assert.deepEqual(asked[0], ["pr", "view", "1655", "--repo", "a11ign/a11ign", "--json", "state,headRefOid,comments,reviews"]);
  assert.equal(pullReadOf(() => { throw new Error("HTTP 502"); }, "a11ign/a11ign")(1655), null);
});

test("#1649 (4) THE CONFLICT: a conflicting pull request whose owner is idle is named; a working owner, an unlisted owner, or a clean pull request is not", () => {
  const prs = [
    { number: 1, mergeStateStatus: "DIRTY" },
    { number: 2, mergeStateStatus: "DIRTY" },
    { number: 3, mergeable: "CONFLICTING" },
    { number: 4, mergeStateStatus: "CLEAN" },
    { number: 5, mergeStateStatus: "DIRTY" },
  ];
  const owners: Record<number, string | null> = { 1: "worker-idle", 2: "worker-busy", 3: "worker-done", 4: "worker-idle", 5: "worker-gone" };
  const ownerOf = (pr: any) => ({ session: owners[pr.number] });
  const agents = [{ label: "worker-idle", status: "idle" }, { label: "worker-busy", status: "working" }, { label: "worker-done", status: "done" }];
  assert.deepEqual(conflictingIdlePrs({ prs, agents, ownerOf }), [1, 3], "idle and done are both idle; working and unlisted are not counted");
  assert.equal(conflictingIdlePrs({ prs, agents: null, ownerOf }), null, "herdr not asked: unread, not none");
});

test("#1649 (5) THE SIGNALS: both are standard machinery signals, and the canary tick reads each as a count that starts its clock when first seen", () => {
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes(MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED));
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes(MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE));
  assert.ok(FLAG_REGISTRY.includes(VERDICT_DELIVERY_FLAG), "the flag is one a module reads");

  let text: string | null = null;
  const logs: string[] = [];
  const io: CanaryIo = { read: () => text, write: (_path, next) => { text = next; }, fileIncident: () => "https://example.test/issue/1", log: (line) => logs.push(line) };
  const facts = (at: number, extra: Record<string, unknown>) => ({
    now: T0 + at * MINUTE,
    facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, ...extra },
    dir: "/state", options: OPTIONS, io,
  });
  const last = () => parseCanaryState(text).samples.at(-1)!.values;

  machineryCanaryTick(facts(0, { verdictUndelivered: [T0 - 20 * MINUTE], conflictingIdle: [7] }) as any);
  assert.equal(last()[MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED], 1, "a verdict written twenty minutes ago is undelivered");
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], 0, "the conflict's clock starts this tick");

  machineryCanaryTick(facts(10, { verdictUndelivered: [T0 - 4 * MINUTE], conflictingIdle: [7] }) as any);
  assert.equal(last()[MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED], 0, "one written four minutes ago has not stood fifteen");
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], 0, "ten minutes is not fifteen");

  machineryCanaryTick(facts(20, { verdictUndelivered: [T0 - 4 * MINUTE], conflictingIdle: [7] }) as any);
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], 1, "the same pull request idle fifteen minutes counts");

  machineryCanaryTick(facts(30, { verdictUndelivered: null, conflictingIdle: null }) as any);
  assert.equal(last()[MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED], null, "a refused record is unread, not zero");
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], null, "a refused listing is unread, not zero");
  assert.equal(machineryFlagOn(parseCanaryState(text), VERDICT_DELIVERY_FLAG), false, "the flag is OFF by default");
  assert.deepEqual(logs, []);
});

/** Turns `reviews.verdictDelivery` ON in a state directory, as `machinery:flag` does. */
function switchDeliveryOn(dir: string): void {
  writeFileSync(join(dir, CANARY_STATE_FILE), `${JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: VERDICT_DELIVERY_FLAG, on: true }), null, 1)}\n`);
}

test("#1649 (6) THE WAKE SIDE: with the flag OFF a tick records nothing and posts nothing; ON it records the bulleted verdict and posts it once", () => {
  const dir = tmpDir("verdict-wake-");
  const registry = { "reviewer-1654": { spawnedAt: T0, trust: OUTSIDE } };
  const calls: string[][] = [];
  const door: DoorRun = (_file, args) => { calls.push(args); };
  const run = (args: string[]) => {
    if (args.includes("read")) return pane(1654, HEAD, "convinced", { bullet: true });
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  assert.deepEqual(postOutsideVerdictsOf(registry, run, door, dir), [], "the flag is OFF: the strict reader posts nothing, and says nothing");
  assert.equal(calls.length, 0);
  assert.throws(() => readFileSync(join(dir, VERDICT_LEDGER_FILE), "utf8"), "the flag is OFF: no record is written");

  switchDeliveryOn(dir);
  assert.deepEqual(postOutsideVerdictsOf(registry, run, door, dir), [`posted the convinced verdict for #1654 at ${HEAD8} from outside reviewer reviewer-1654`]);
  assert.equal(calls.length, 1, "ON: the bulleted block is posted through the door");
  const ledger = parseVerdictLedger(readFileSync(join(dir, VERDICT_LEDGER_FILE), "utf8"));
  assert.deepEqual(Object.keys(ledger), [`reviewer-1654@${HEAD}`], "ON: the bulleted block is recorded");
  assert.equal(ledger[`reviewer-1654@${HEAD}`]?.verdict, "convinced");
  assert.equal(ledger[`reviewer-1654@${HEAD}`]?.pr, 1654);

  const quiet = tmpDir("verdict-wake-quiet-");
  switchDeliveryOn(quiet);
  assert.deepEqual(postOutsideVerdictsOf(registry, () => "no verdict in this pane", door, quiet), []);
  assert.throws(() => readFileSync(join(quiet, VERDICT_LEDGER_FILE), "utf8"), "a pane with no block writes no record");
});

test("#1649 (7) THE FLAG GATE: with the flag OFF neither signal reads anything (the pull requests are never asked); ON, each answers from its read", () => {
  const dir = tmpDir("verdict-gate-");
  const prs = [{ number: 3, mergeable: "CONFLICTING" }];
  const agents = [{ label: "worker-idle", status: "idle" }];
  const ownerOf = () => ({ session: "worker-idle" });
  const unread = (): never => { throw new Error("read while OFF"); };
  assert.equal(verdictUndeliveredNow({ on: false, dir, pull: unread }), null, "OFF: the record is not read");
  assert.equal(conflictingIdleNow({ on: false, prs, agents, ownerOf }), null, "OFF: the pull requests are not counted");

  recordWrittenVerdicts({ dir, written: [{ session: "reviewer-1654", pr: 1654, head: HEAD, verdict: "convinced" }], now: T0 });
  const openNoVerdict: PullRead = { open: true, head: HEAD, comments: [], reviews: [] };
  assert.deepEqual(verdictUndeliveredNow({ on: true, dir, pull: () => openNoVerdict }), [T0], "ON: the undelivered verdict's first time");
  assert.deepEqual(conflictingIdleNow({ on: true, prs, agents, ownerOf }), [3], "ON: the conflicting pull request with an idle owner");
});

test("#1649 (8) THE EDGE: neither signal trips at fourteen minutes, and both trip at fifteen", () => {
  let text: string | null = null;
  const io: CanaryIo = { read: () => text, write: (_path, next) => { text = next; }, fileIncident: () => "https://example.test/issue/1", log: () => {} };
  const tick = (at: number) => machineryCanaryTick({
    now: T0 + at * MINUTE,
    facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, verdictUndelivered: [T0], conflictingIdle: [7] },
    dir: "/state", options: OPTIONS, io,
  } as any);
  const last = () => parseCanaryState(text).samples.at(-1)!.values;

  tick(0);
  tick(14);
  assert.equal(last()[MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED], 0, "a verdict fourteen minutes old has not tripped");
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], 0, "a conflict fourteen minutes idle has not tripped");
  tick(15);
  assert.equal(last()[MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED], 1, "a verdict fifteen minutes old trips");
  assert.equal(last()[MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE], 1, "a conflict fifteen minutes idle trips");
});
