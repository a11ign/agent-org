// no-token: gh -- `decide` is pure, and the tracker's history is a stub handed to the reader in place of `gh`
/**
 * #4800: a CLAIMED chairman row is in the gate's chairman set, so a Ready chairman row over its file is shelved naming it (#4793's claim refuses it anyway).
 * Each "not offered" has a sibling that differs in the one thing that offers it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, readChairmanPriorityOfOffer, CHAIRMAN_PRIORITY_LABEL as LABEL } from "./work-gate.ts";

const REGION = ["packages/guards/src/shared.ts"];
const DECLARATION = { code: [{ key: "", repo: "a11ign/a11ign" }], dora: [{ repo: "a11ign/a11ign", releasablePaths: ["packages/"] }] };
const row = (number: number, labels: string[]) => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })),
  body: `## Region\n\n\`\`\`\n${REGION.join("\n")}\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`,
});
const candidate = row(20, ["ready", LABEL]);
const holder = (labels: string[] = []) => row(40, ["in-progress", "session:worker-40", ...labels]);
/** The history: `labeller(n)` is who added the label to row n. */
const history = (labeller: (n: number) => string) => (args: string[]) => `${labeller(Number(/issues\/(\d+)\//.exec(args[1])?.[1]))}\n`;
const CHAIRMAN = "DanBeckDev";

function offeredOver(claimedHolder: ReturnType<typeof holder>, labeller: (n: number) => string) {
  const read = readChairmanPriorityOfOffer([candidate], [candidate, claimedHolder], history(labeller));
  const orders = decide({ prs: [], readyRows: [candidate], openRows: [claimedHolder], engineerStarts: [], projectDeclaration: DECLARATION, shareLog: () => {}, offerHierarchy: { chairmanRows: read.chairmanRows, ignored: read.ignored } } as Parameters<typeof decide>[0]);
  return { read, orders, subjects: orders.filter((o) => o.cause === "ready-row-unclaimed").map((o) => o.subject) };
}

test("a Ready chairman row over a claimed chairman row is shelved, naming the holder", () => {
  const { read, orders, subjects } = offeredOver(holder([LABEL]), () => CHAIRMAN);
  assert.deepEqual([...read.chairmanRows].sort(), [20, 40], "the claimed holder is in the verified set");
  assert.deepEqual(subjects, []);
  assert.match(orders.find((o) => o.causeKey.startsWith("ceo/chairman-row-refused/"))?.prompt ?? "", /#40/);
});

test("control: the same over a claimed PLAIN row is offered", () => {
  const { read, subjects } = offeredOver(holder(), () => CHAIRMAN);
  assert.deepEqual([...read.chairmanRows], [20]);
  assert.deepEqual(subjects, ["row-20"]);
});

test("a claimed holder's label added by another login is ignored, and the row is offered", () => {
  const quiet = process.stderr.write; process.stderr.write = (() => true) as typeof quiet;
  try {
    const { read, subjects } = offeredOver(holder([LABEL]), (n) => (n === 40 ? "somebody-else" : CHAIRMAN));
    assert.deepEqual([...read.chairmanRows], [20]);
    assert.deepEqual(read.ignored, [{ number: 40, actor: "somebody-else" }]);
    assert.deepEqual(subjects, ["row-20"]);
  } finally { process.stderr.write = quiet; }
});

test("an unreadable history of the claimed holder fails closed, and a Ready row also carrying in-progress is read once", () => {
  const quiet = process.stderr.write; process.stderr.write = (() => true) as typeof quiet;
  try {
    const read = readChairmanPriorityOfOffer([candidate], [holder([LABEL])], (args) => { if (args[1].includes("/40/")) throw new Error("rate limited"); return `${CHAIRMAN}\n`; });
    assert.deepEqual(read.unread, [40]);
    assert.deepEqual([...read.chairmanRows], [20]);
    let calls = 0;
    readChairmanPriorityOfOffer([candidate], [{ ...candidate, labels: [...candidate.labels, { name: "in-progress" }] }], () => { calls += 1; return `${CHAIRMAN}\n`; });
    assert.equal(calls, 1);
  } finally { process.stderr.write = quiet; }
});
