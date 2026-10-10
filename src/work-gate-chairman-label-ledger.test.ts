// no-token: gh -- no `gh` is run: the tracker's history is a stub in place of `gh api .../events`, the rows are fixtures and the only files written are in a temporary directory
// #730 (a11ign#4885, #4879, epic #4437): A `priority:chairman` LABEL THE CHAIRMAN DID NOT ADD RECORDS ITS OWN LEDGER INCIDENT, ONCE PER ROW AND ACTOR.
//
// The gate already ignored the label and woke `ceo` with "record it as one"; nothing recorded it, so the incident existed only as a line `ceo` typed by hand and
// the class-repeat counter never saw it. THE DETECTOR runs the REAL tick path (`offerHierarchyNow` over a temporary state directory, then `decide`) and reads the
// file back through `parseFailureLedger` and `repeatsIn`, the pair `class-repeat` itself reads. Every "no line" test has a sibling that differs in the one thing
// that writes one.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decide, offerHierarchyNow, CHAIRMAN_PRIORITY_LABEL as LABEL } from "./work-gate.ts";
import { CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, FAILURE_LEDGER_FILE, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import { REPO } from "./project-identity.ts";

const CHAIRMAN = "DanBeckDev";
const T0 = Date.parse("2026-10-10T19:00:00Z");
const MIN = 60_000;
const DECLARATION = { code: [{ key: "", repo: REPO }], dora: [{ repo: REPO, releasablePaths: ["src/"] }] };

type Row = { number: number; title: string; labels: { name: string }[]; body: string };
const ready = (number: number): Row => ({ number, title: `row ${number}`, labels: [{ name: "ready" }, { name: LABEL }],
  body: `## Region\n\n\`\`\`\nsrc/row-${number}.ts\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n` });

/** The tracker's history: `who(n)` is what `gh api .../issues/<n>/events` prints for row n (a login per line, oldest first) or throws. */
const history = (who: (n: number) => string) => (args: string[]) => who(Number(/issues\/(\d+)\//.exec(args[1])?.[1]));

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "work-gate-chairman-label-ledger-"));
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write; // the gate says IGNORED on stderr every tick, and that is not what is under test
  try { return body(dir); } finally { process.stderr.write = write; rmSync(dir, { recursive: true, force: true }); }
}

/** One tick through the real path: the hierarchy read and recorded, then the orders `decide` makes of it. */
function tick(rows: Row[], { dir, run, minutes }: { dir: string; run: (args: string[]) => string; minutes: number }) {
  const hierarchy = offerHierarchyNow(rows, rows, { run, stateDir: dir, now: T0 + minutes * MIN });
  const orders = decide({ prs: [], readyRows: rows, engineerStarts: [], projectDeclaration: DECLARATION, shareLog: () => {}, offerHierarchy: hierarchy } as Parameters<typeof decide>[0]);
  return { hierarchy, ignoredOrders: orders.filter((order) => order.causeKey.startsWith("ceo/chairman-label-ignored/")) };
}

const entriesIn = (dir: string) => existsSync(join(dir, FAILURE_LEDGER_FILE)) ? parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8")) : [];

test("a label somebody else added is ONE ledger line across three ticks, and ceo is told every tick that it is already written", () => withDir((dir) => {
  const rows = [ready(4885)];
  const run = history(() => "a11ign-ai-leads\n");
  const ticks = [0, 5, 10].map((minutes) => tick(rows, { dir, run, minutes }));
  assert.deepEqual(entriesIn(dir), [{ classKey: CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, at: T0, ref: `${REPO}#4885:a11ign-ai-leads` }],
    "one line, dated by the tick that first saw it, whose ref is <repo>#<number>:<actor>");
  assert.equal(CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, "chairman-label-not-chairman");
  for (const { ignoredOrders } of ticks) {
    assert.deepEqual(ignoredOrders.map((order) => [order.session, order.causeKey]), [["ceo", "ceo/chairman-label-ignored/4885-a11ign-ai-leads"]],
      "the order still goes to ceo each tick: the recording replaces the hand-typed line and not the order");
    const prompt = ignoredOrders[0].prompt;
    assert.match(prompt, /already (been )?recorded/i);
    assert.doesNotMatch(prompt, /record it as one/, "the order no longer asks ceo to type the line");
    assert.match(prompt, /take the label off/i);
  }
}));

test("the chairman's own label records nothing and orders nothing (the negative control of the test above)", () => withDir((dir) => {
  const ticks = [0, 5].map((minutes) => tick([ready(4885)], { dir, run: history(() => `${CHAIRMAN}\n`), minutes }));
  assert.deepEqual([...ticks[0].hierarchy.chairmanRows ?? []], [4885], "control: the label WAS read, and it is the chairman's");
  assert.deepEqual(entriesIn(dir), []);
  assert.equal(existsSync(join(dir, FAILURE_LEDGER_FILE)), false, "not even an empty file: nothing was written");
  assert.deepEqual(ticks.flatMap((t) => t.ignoredOrders), []);
}));

test("a history that names no actor records the actor `unknown`, and still yields the order", () => {
  for (const [what, printed] of [["no labeled event at all", ""], ["a labeled event whose actor is gone (jq prints null)", "null\n"]] as const) {
    withDir((dir) => {
      const { ignoredOrders } = tick([ready(4879)], { dir, run: history(() => printed), minutes: 0 });
      assert.deepEqual(entriesIn(dir).map((entry) => entry.ref), [`${REPO}#4879:unknown`], what);
      assert.deepEqual(ignoredOrders.map((order) => order.causeKey), ["ceo/chairman-label-ignored/4879-unknown"], what);
    });
  }
});

test("the same row labelled by ANOTHER actor later is a new incident (a new ref); rows by one actor are a repeat of the class", () => withDir((dir) => {
  let who = "a11ign-ai-leads";
  tick([ready(4885)], { dir, run: history(() => `${who}\n`), minutes: 0 });
  tick([ready(4885)], { dir, run: history(() => `${who}\n`), minutes: 5 });
  who = "somebody-else";
  tick([ready(4885)], { dir, run: history(() => `a11ign-ai-leads\n${who}\n`), minutes: 10 });
  tick([ready(4885)], { dir, run: history(() => `a11ign-ai-leads\n${who}\n`), minutes: 15 });
  assert.deepEqual(entriesIn(dir).map((entry) => entry.ref), [`${REPO}#4885:a11ign-ai-leads`, `${REPO}#4885:somebody-else`]);
  tick([ready(4879), ready(4877)], { dir, run: history(() => "a11ign-ai-leads\n"), minutes: 20 });
  assert.deepEqual(repeatsIn(entriesIn(dir), { windowMs: 24 * 60 * MIN, now: T0 + 20 * MIN }).map((repeat) => [repeat.classKey, repeat.refs.length]),
    [[CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND, 4]], "the counter sees every distinct ref, which is what the hand-typed lines never gave it");
}));

test("a history that cannot be READ is not an incident: nothing is recorded and no order is made (an outage must not forge a ledger line)", () => withDir((dir) => {
  const { hierarchy, ignoredOrders } = tick([ready(4885)], { dir, run: () => { throw new Error("rate limited"); }, minutes: 0 });
  assert.deepEqual(entriesIn(dir), []);
  assert.deepEqual(ignoredOrders, []);
  assert.deepEqual([...hierarchy.chairmanRows ?? []], [], "and the label is not honoured either: it fails closed, as before");
}));

test("a ledger that cannot be written does not stop the tick, and the order then asks ceo to record it by hand", () => withDir((dir) => {
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const { ignoredOrders } = tick([ready(4885)], { dir: blocker, run: history(() => "a11ign-ai-leads\n"), minutes: 0 });
  assert.equal(ignoredOrders.length, 1, "the order is made");
  assert.match(ignoredOrders[0].prompt, /record it as one/, "and it does not claim a line that was never written");
  assert.doesNotMatch(ignoredOrders[0].prompt, /already (been )?recorded/i);
}));
