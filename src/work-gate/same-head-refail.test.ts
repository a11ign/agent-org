// no-token: none -- `perPullRequestOrders` and `decide` over in-memory pull requests, and the flag's reader over a throwaway state directory; nothing reaches `gh`, `git`, herdr or the fleet
/**
 * agent-org#1185 (half 2 of #1166): A SAME-HEAD RE-FAIL REACHES THE OWNER A SECOND TIME, BEHIND `checks.sameHeadRefail`.
 *
 * THE DEFECT: agent-org#1130's `suite` failed, the rerun at the SAME head failed identically, and nobody was told. A settled-red order's key is
 * `<session>/pr-checks-failing/pr-<ref>/<head8>`: it names the head and not the run, so the second failure is the first one's key and `undelivered`
 * (the delivered ledger, keyed on `causeKey`) drops it. The layer that dedupes is the LEDGER; the layer that decides what it is keyed on is
 * `failingChecksOrder`, which is where this changes.
 *
 * WHAT EACH TEST SEES:
 *   (1) the dedupe, with the flag OFF (today): the re-fail's key IS the first failure's, which the ledger drops. This is the "old code dedupes it" control;
 *   (2) ON: the re-fail has its own key, to the same owner, and its text says it is the same head failing again. The ledger itself, and the failing assertion the
 *       tick adds to the order, are `wake-same-head-refail.test.ts`'s, which imports `wake.ts` under the recorded-project prelude that file needs;
 *   (3) ON, and the first failure's key is byte for byte today's, so a head that failed once is not re-ordered when the flag is switched on;
 *   (4) a run that was CANCELLED and then failed is a first failure, not a re-fail (a cancelled run is not a failure that was reported);
 *   (5) the switch: `machinery:flag on|off checks.sameHeadRefail` is what `sameHeadRefailFlagOn` reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { main as machineryFlag } from "../machinery-flag.ts";
import { perPullRequestOrders, SAME_HEAD_REFAIL_FLAG } from "./pr-orders.ts";
import { readReenqueueState } from "./causes/pr-ejected.ts";
import { decide, sameHeadRefailFlagOn } from "./tick.ts";

type Order = { session: string; cause: string; causeKey: string; prompt: string };

const NOW = Date.parse("2026-10-13T12:00:00Z");
const SESSION = "worker-agent-org-1185";
const quiet = () => undefined;
const HEAD = "24b0e94f00000000";
const KEY = "worker-7/pr-checks-failing/pr-1130/24b0e94f";

const run = (job: number, conclusion: string, minute: number, name = "suite") => ({
  name, status: "COMPLETED", conclusion, startedAt: `2026-10-13T11:${String(minute).padStart(2, "0")}:00Z`,
  completedAt: `2026-10-13T11:${String(minute + 5).padStart(2, "0")}:30Z`, detailsUrl: `https://github.com/o/r/actions/runs/555/job/${job}`,
});
const prOf = (statusCheckRollup: unknown[]) => ({
  number: 1130, headRefOid: HEAD, isDraft: false, headRefName: "agent/some-slug-1130", labels: [{ name: "session:worker-7" }], closingIssuesReferences: [], statusCheckRollup,
});
const FIRST = [run(666, "FAILURE", 10)];
const SECOND = [run(666, "FAILURE", 10), run(667, "FAILURE", 20)];
const THIRD = [...SECOND, run(668, "TIMED_OUT", 30)];

const ordersOf = (rollup: unknown[], sameHeadRefail?: boolean) => perPullRequestOrders([prOf(rollup)], null, null,
  { nowMs: NOW, identities: {} as never, ...(sameHeadRefail === undefined ? {} : { sameHeadRefail }) }) as Order[];
const red = (orders: Order[]) => orders.filter((order) => order.cause === "pr-checks-failing");

test("(1) FLAG OFF, today's code: the re-fail at the same head has the first failure's key, and the delivered ledger drops it", () => {
  const [first] = red(ordersOf(FIRST));
  assert.equal(first.causeKey, KEY, "POSITIVE CONTROL: the first failure is ordered, under the documented key");
  for (const off of [undefined, false]) {
    const [again] = red(ordersOf(SECOND, off));
    assert.equal(again.causeKey, first.causeKey, "so the delivered ledger, which is keyed on it, has already delivered it: `wake-same-head-refail.test.ts` runs that ledger");
  }
});

test("(2) FLAG ON: the re-fail is its own key, reaches the same owner through the ledger, and says it is the same head failing again", () => {
  const [first] = red(ordersOf(FIRST, true));
  const [again] = red(ordersOf(SECOND, true));
  assert.equal(again.causeKey, `${KEY}/refail-1`);
  assert.equal(again.session, first.session, "the same owner");
  assert.notEqual(again.causeKey, first.causeKey, "a key the ledger does not have (`wake-same-head-refail.test.ts` runs the ledger itself)");
  assert.match(again.prompt, /FAILED AGAIN at this same head: 1 earlier run of `suite` failed here/);
  assert.match(again.prompt, /`suite`/, "names the check that failed twice");
  assert.doesNotMatch(first.prompt, /FAILED AGAIN/, "the first failure's words are today's");
  const [third] = red(ordersOf(THIRD, true));
  assert.equal(third.causeKey, `${KEY}/refail-2`, "a third failure is a third order, and a TIMED_OUT run counts as a failure");
});

test("(3) FLAG ON: the first failure's order is today's byte for byte, and so is every key of a head that has not failed twice", () => {
  assert.deepEqual(ordersOf(FIRST, true), ordersOf(FIRST, false));
  const pending = [run(666, "FAILURE", 10), { ...run(667, "SUCCESS", 20), conclusion: "", status: "IN_PROGRESS" }];
  assert.deepEqual(ordersOf(pending, true), ordersOf(pending, false), "an earlier failure and a rerun still running: nothing is settled red, nothing is ordered either way");
});

test("(4) FLAG ON: a CANCELLED earlier run is not a failure that was reported, so the first red after it is a first failure", () => {
  const [order] = red(ordersOf([run(666, "CANCELLED", 10), run(667, "FAILURE", 20)], true));
  assert.equal(order.causeKey, KEY);
  const [other] = red(ordersOf([run(666, "FAILURE", 10, "lint"), run(667, "FAILURE", 20)], true));
  assert.equal(other.causeKey, KEY, "an earlier failure of ANOTHER check is not this check failing again");
});

test("(5) decide passes the reading through, and the flag's reader follows `machinery:flag`", () => {
  // prOwnerRouting pinned OFF: an omitted reading is the host's `prs.ownerRouting` (#1325), ON here, and the fixture PR has no `isCrossRepository: false`, so it reads as outside and its red is withheld.
  const keyOf = (sameHeadRefail: boolean) => red(decide({ prs: [prOf(SECOND)], readyRows: [], nowMs: NOW, sameHeadRefail, prOwnerRouting: false }) as Order[])[0].causeKey;
  assert.equal(keyOf(true), `${KEY}/refail-1`, "on");
  assert.equal(keyOf(false), KEY, "off");
  const dir = tmpDir("same-head-refail-flag-");
  const read = () => readReenqueueState(dir, quiet);
  assert.equal(sameHeadRefailFlagOn({ asked: undefined }, read), false, "POSITIVE CONTROL: no state file reads OFF");
  assert.equal(machineryFlag(["on", SAME_HEAD_REFAIL_FLAG, `--session=${SESSION}`], { dir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(sameHeadRefailFlagOn({ asked: undefined }, read), true, "after `machinery:flag on`, the reader says ON");
  assert.equal(sameHeadRefailFlagOn({ asked: false }, read), false, "a caller's own reading is not overridden by the file");
  assert.equal(machineryFlag(["off", SAME_HEAD_REFAIL_FLAG, `--session=${SESSION}`], { dir, now: NOW, out: quiet, err: quiet }), 0);
  assert.equal(sameHeadRefailFlagOn({ asked: undefined }, read), false, "after `off`, OFF again");
});
