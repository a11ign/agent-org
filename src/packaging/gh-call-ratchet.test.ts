// no-token: none -- reads two JSON files and the source tree; nothing here reaches gh or herdr
/**
 * (agent-org#826, Phase 0b of a11ign/a11ign#4505) A FILE OUTSIDE `src/ticket-port/` MAY NOT GAIN A `gh` CALL, AND THE FILES THAT HOLD ONE TODAY ARE A BASELINE THAT ONLY GOES DOWN.
 *
 * THE RULE HELD IS THE LAST SENTENCE OF `ceo`'s ADR 0046 RULING (item 4, with decision 5's adapter): "the rule is new code only, held by agent-org#485's inventory and the detector
 * filed after #484". This is that detector. New GitHub-specific code goes through the ticket port or the code-host port, never into a file that is not the adapter.
 *
 * WHY A FAILING CHECK AND NOT A ROW FILED AFTERWARDS. The ruling words it "detector that files a row". A check on the pull request stops the call BEFORE it merges; a row filed
 * afterwards lets the call land and asks someone to undo it. It is also the shape `mjs-ratchet.test.ts` takes for "can only go down" (#4249). If `ceo` wants the row-filing form
 * as well, it is one further row on top of this one; this choice is reversed on #826.
 *
 * WHY `gh-call-inventory.test.ts` DOES NOT HOLD THIS. It holds the scanner (an independent reader must find no spawner the scan lacks), and the inventory it prints is not
 * committed (a11ign/a11ign#5126), so no copy of it can bless a new call. The inventory says what is there; `docs/gh-call-baseline.json` says what MAY be there.
 *
 * WHAT FAILS: a file of a fresh inventory that (a) is outside `src/ticket-port/` and has no baseline entry, or (b) holds more `spawns` or more `calls` than its entry. The message
 * names the file and both numbers.
 *
 * WHAT DOES NOT, AND WHY IT IS A DOOR ON PURPOSE: a count BELOW its entry, and a baselined file that is gone. If either failed, every pull request that removed a call would have to
 * edit the baseline, and that file would be a B4 overlap between all of them. So the baseline only ever needs editing to LOWER it, by hand or by anyone who notices, and a RISE HAS
 * NO DOOR: nothing here can be satisfied by raising a number except raising it in `docs/gh-call-baseline.json`, which a reviewer sees as a plain rise.
 *
 * NO SECOND SCANNER. The tree is read through `buildInventory` and `judgedRoot` from `gh-call-inventory.ts`, so this shares the inventory's tree rule (`AGENT_ORG_TOOL_REPO`, test
 * files and fixtures not counted) and the two cannot disagree about what a call is. `calls` is the sum of a file's shape counts.
 *
 * THE FIXTURE TREES NAME THE COMMAND THROUGH `COMMAND`, never as a literal call in this file's own source: `acceptance-commands.ts` reads a spawn of the quoted name as "this test
 * needs a token", and nothing here spawns anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildInventory, judgedRoot, type Inventory } from "./gh-call-inventory.ts";

const COMMAND = "gh";
const BASELINE_PATH = "docs/gh-call-baseline.json";
/** The adapter's directory: exempt by path (item 3 of the row), because it is where a `gh` call is meant to be. */
const PORT_DIRECTORY = "src/ticket-port/";

type Allowance = { spawns: number; calls: number };
type Baseline = { files: Record<string, Allowance> };

/** What the inventory says of a file, in the baseline's two numbers. `calls` is the sum of the shape counts. */
function allowanceOf(entry: Inventory["files"][string]): Allowance {
  return { spawns: entry.spawns, calls: Object.values(entry.calls).reduce((sum, count) => sum + count, 0) };
}

/** The baseline a tree would be written as: every inventory file outside the port. How `docs/gh-call-baseline.json` was first produced. */
function baselineOf(inventory: Inventory): Baseline {
  const files: Record<string, Allowance> = {};
  for (const [file, entry] of Object.entries(inventory.files)) {
    if (!file.startsWith(PORT_DIRECTORY)) files[file] = allowanceOf(entry);
  }
  return { files };
}

/** One line per offender, each naming the file and both numbers; empty when the tree holds no more than the baseline allows. */
function offenders(inventory: Inventory, baseline: Baseline): string[] {
  const found: string[] = [];
  for (const [file, entry] of Object.entries(inventory.files)) {
    if (file.startsWith(PORT_DIRECTORY)) continue;
    const have = allowanceOf(entry);
    const allowed = Object.hasOwn(baseline.files, file) ? baseline.files[file]! : undefined;
    if (allowed === undefined) {
      found.push(`${file}: a new file that calls the tracker's CLI (spawns ${have.spawns}, calls ${have.calls}) and has no entry in ${BASELINE_PATH}`);
    } else if (have.spawns > allowed.spawns || have.calls > allowed.calls) {
      found.push(`${file}: spawns ${have.spawns} (baseline ${allowed.spawns}), calls ${have.calls} (baseline ${allowed.calls})`);
    }
  }
  return found;
}

const WHERE_NEW_CODE_GOES = "Go through the ticket port (`src/ticket-port/`) or the code-host port (ADR 0046), not into a baselined file, and do not raise the baseline.";

const spawn = (callee: string, args: string[]): string => `${callee}("${COMMAND}", [${args.map((arg) => JSON.stringify(arg)).join(", ")}]);\n`;

/** A throwaway tree, `files` keyed by path under it, removed by the caller through the returned `done`. */
function tree(files: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gh-call-ratchet-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Judge `files` against the baseline `before` would be written as. Every control below goes through this, so none can touch the committed baseline. */
function judge(before: Record<string, string>, after: Record<string, string>): { baseline: Baseline; found: string[]; inventory: Inventory } {
  const old = tree(before);
  const next = tree(after);
  try {
    const baseline = baselineOf(buildInventory(old.root));
    const inventory = buildInventory(next.root);
    return { baseline, inventory, found: offenders(inventory, baseline) };
  } finally {
    old.done();
    next.done();
  }
}

const BASE = { "src/a.ts": spawn("execFileSync", ["issue", "list"]), "src/b.ts": "export const none = 1;\n" };

test("the committed baseline admits today's tree: the real inventory yields no offender, and the baseline is not empty", () => {
  const root = judgedRoot();
  const baseline: Baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  const inventory = buildInventory(root);
  const outside = Object.keys(inventory.files).filter((file) => !file.startsWith(PORT_DIRECTORY));
  // Positive controls: an empty baseline and an empty inventory would each make "no offenders" true of anything.
  assert.ok(Object.keys(baseline.files).length > 90, `the baseline has ${Object.keys(baseline.files).length} entries: an empty one would admit nothing and prove nothing`);
  assert.ok(outside.length > 90, `the inventory lists ${outside.length} files outside the port: a scan that finds none would also yield no offender`);
  const found = offenders(inventory, baseline);
  assert.deepEqual(found, [], `${found.join("\n")}\n${WHERE_NEW_CODE_GOES}`);
});

test("the adapter is in the real inventory and is not in the baseline: the port's exemption is by path and is exercised on the real tree", () => {
  const root = judgedRoot();
  const baseline: Baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  const inventory = buildInventory(root);
  const adapter = `${PORT_DIRECTORY}github-adapter.ts`;
  assert.ok(Object.hasOwn(inventory.files, adapter), `${adapter} is not in the inventory, so the exemption has nothing to exempt`);
  assert.deepEqual(Object.keys(baseline.files).filter((file) => file.startsWith(PORT_DIRECTORY)), [], "the baseline lists a file under the port, which the exemption makes unnecessary");
});

test("negative control: a new file that spawns the command outside the port is reported by its name", () => {
  const { found, baseline } = judge(BASE, { ...BASE, "src/extra.ts": spawn("spawnSync", ["pr", "view"]) });
  assert.deepEqual(Object.keys(baseline.files), ["src/a.ts"], "the baseline holds the base tree's one spawner and not the extra file");
  assert.equal(found.length, 1);
  for (const pattern of [/^src\/extra\.ts: /, /spawns 1/, /calls 1/]) assert.match(found[0]!, pattern);
  assert.deepEqual(judge(BASE, BASE).found, [], "CONTROL: the same tree with no extra file is not reported");
});

test("negative control: a baselined file that gains a call site is reported with both numbers", () => {
  const { found } = judge(BASE, { ...BASE, "src/a.ts": spawn("execFileSync", ["issue", "list"]) + spawn("execFileSync", ["issue", "view"]) });
  assert.equal(found.length, 1);
  for (const pattern of [/^src\/a\.ts: /, /spawns 2 \(baseline 1\)/, /calls 2 \(baseline 1\)/]) assert.match(found[0]!, pattern);
});

test("negative control: either number rising alone is enough: a shape written beside an existing spawn, and a spawn whose arguments are built elsewhere", () => {
  // A file that spawns through one wrapper and writes its arguments at the wrapper's call sites: a new call site raises `calls` and leaves `spawns` where it was.
  const wrapped = (shapes: string[][]): string => `const run = (args: string[]) => execFileSync("${COMMAND}", args);\n${shapes.map((shape) => `run(${JSON.stringify(shape)});\n`).join("")}`;
  const before = { "src/w.ts": wrapped([["issue", "list"]]) };
  const calls = judge(before, { "src/w.ts": wrapped([["issue", "list"], ["pr", "view"]]) });
  assert.equal(calls.found.length, 1);
  assert.match(calls.found[0]!, /spawns 1 \(baseline 1\)/);
  assert.match(calls.found[0]!, /calls 2 \(baseline 1\)/);
  // The other way: a second spawn site whose arguments come from another file raises `spawns` and no shape.
  const spawns = judge(before, { "src/w.ts": `${wrapped([["issue", "list"]])}execFileSync("${COMMAND}", somewhereElse);\n` });
  assert.equal(spawns.found.length, 1);
  assert.match(spawns.found[0]!, /spawns 2 \(baseline 1\)/);
  assert.match(spawns.found[0]!, /calls 1 \(baseline 1\)/);
});

test("the same new file placed under src/ticket-port/ is NOT reported", () => {
  const extra = spawn("spawnSync", ["pr", "view"]);
  const outside = judge(BASE, { ...BASE, "src/extra.ts": extra });
  const inside = judge(BASE, { ...BASE, [`${PORT_DIRECTORY}extra.ts`]: extra });
  assert.equal(outside.found.length, 1, "CONTROL: outside the port the same text is reported");
  assert.ok(Object.hasOwn(inside.inventory.files, `${PORT_DIRECTORY}extra.ts`), "the inventory lists the file in the port, so an empty report is the exemption and not a file nobody saw");
  assert.deepEqual(inside.found, []);
});

test("the shrink door: a file whose count has fallen, and a baselined file that is gone, are NOT reported", () => {
  const two = { "src/a.ts": spawn("execFileSync", ["issue", "list"]) + spawn("execFileSync", ["issue", "view"]), "src/gone.ts": spawn("execFileSync", ["pr", "list"]) };
  const fallen = judge(two, { "src/a.ts": spawn("execFileSync", ["issue", "list"]), "src/gone.ts": two["src/gone.ts"] });
  assert.deepEqual(fallen.baseline.files["src/a.ts"], { spawns: 2, calls: 2 }, "the baseline holds the larger count");
  assert.deepEqual(allowanceOf(fallen.inventory.files["src/a.ts"]!), { spawns: 1, calls: 1 }, "the tree holds the smaller one, so the empty report is a fall and not a file nobody read");
  assert.deepEqual(fallen.found, []);
  const gone = judge(two, { "src/a.ts": two["src/a.ts"] });
  assert.ok(Object.hasOwn(gone.baseline.files, "src/gone.ts"), "the baseline still names the file that is gone");
  assert.ok(!Object.hasOwn(gone.inventory.files, "src/gone.ts"));
  assert.deepEqual(gone.found, []);
});

test("test files are not counted: the inventory's own rule, asserted here too", () => {
  const withTest = { ...BASE, "src/extra.test.ts": spawn("spawnSync", ["pr", "view"]) };
  const { found, inventory } = judge(BASE, withTest);
  assert.ok(!Object.hasOwn(inventory.files, "src/extra.test.ts"), "the inventory lists a test file");
  assert.deepEqual(found, []);
  assert.equal(judge(BASE, { ...BASE, "src/extra.ts": withTest["src/extra.test.ts"] }).found.length, 1, "CONTROL: the same text in a non-test file is reported");
});
