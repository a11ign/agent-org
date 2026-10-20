// no-token: gh -- imports `work-gate.ts`, whose default readers spawn `gh`; the keyed scope's tracker history is a stub handed to the reader in place of `gh`, and every other per-tick read is a stub (#1085)
/**
 * #1085: A `priority:chairman` ROW OF A KEYED TRACKER TAKES THE SPAWN SLOT AHEAD OF PLAIN ROWS, AS A HOME ROW DOES.
 *
 * `main`'s `decide` is handed the chairman's rows (`offerHierarchy`, #4524); `scopeTick`, the path every keyed scope takes, was not, so an
 * absent hierarchy ranked a plain row with a lower number first and gave the chairman's order no `startFresh`. This drives `scopeTick` on a
 * keyed scope with a plain row numbered BELOW the chairman's, and reads the order `deliver` will start first.
 *
 * POSITIVE CONTROL: the second test is the same row labelled by a bot, which the gate ignores (#730), so it is NOT first. Without it the
 * first test could pass on a gate that offered the chairman's row first for any reason at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAIRMAN_PRIORITY_LABEL as LABEL, scopesOf } from "../work-gate/vocabulary.ts";
import { readChairmanPriorityOfOffer } from "../work-gate/tick.ts";
import { readLanes, scopeTick } from "../work-gate/tick/tick-decisions-and-flags.ts";

const CHAIRMAN = "DanBeckDev";
const BOT = "a11ign-workers[bot]";
const REGION = ["src/work-gate/tick.ts"];

const row = (number: number, labels: string[]) => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })),
  body: `## Region\n\n\`\`\`\n${REGION.join("\n")}\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`,
});
const plain = row(10, ["ready"]);
const chairman = row(20, ["ready", LABEL]);

/** The tracker's history: `labeller(n)` is who added the label to row n, as the events read answers it. */
const history = (labeller: (n: number) => string) => (args: string[]) => `${labeller(Number(/issues\/(\d+)\//.exec(args[1])?.[1]))}\n`;

const scopes = scopesOf([{
  tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }],
  code: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }],
}]);
const keyed = scopes.find((scope) => scope.key === "agent-org")!;

/** The keyed scope's order for `#n` read on one tick, where the tracker's history is `labeller`. */
function offeredBy(labeller: (n: number) => string) {
  const rows = [plain, chairman];
  const read = { ...readLanes(keyed, () => "[]"), readyRows: rows, openRows: rows };
  const readings = {
    code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null, trunkRed: undefined }),
    // The tracker's own reading of its chairman rows, as it runs inside the tracker's repository.
    tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null,
      chairmanRows: readChairmanPriorityOfOffer(rows, rows, history(labeller)).chairmanRows }),
  } as unknown as Parameters<typeof scopeTick>[3];
  const orders = scopeTick(keyed, { drain: false }, read, readings).orders as { cause: string; startFresh?: boolean; prompt: string; }[];
  return orders.filter((order) => order.cause === "ready-row-unclaimed");
}

test("a keyed tracker's chairman row is offered FIRST, and its order carries startFresh", () => {
  const offered = offeredBy(() => CHAIRMAN);
  assert.equal(offered.length, 2, "both Ready rows are offered");
  assert.match(offered[0].prompt, /#?20\b/, "the chairman's row 20 is ahead of the plain row 10 with the lower number");
  assert.equal(offered[0].startFresh, true, "the spawn slot is given to it");
  assert.notEqual(offered[1].startFresh, true, "the plain row is not started fresh");
});

test("control: the same row labelled by a bot is NOT the chairman's, so the plain row 10 is first and nothing starts fresh", () => {
  const quiet = process.stderr.write; process.stderr.write = (() => true) as typeof quiet;
  try {
    const offered = offeredBy(() => BOT);
    assert.equal(offered.length, 2);
    assert.match(offered[0].prompt, /#?10\b/, "the plain row with the lower number is first");
    assert.equal(offered.some((order) => order.startFresh === true), false);
  } finally { process.stderr.write = quiet; }
});
