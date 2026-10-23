// no-token: none -- reads two JSON files and the source tree; nothing here reaches gh or herdr
/**
 * (agent-org#826, Phase 0b of a11ign/a11ign#4505; A11-160) A FILE OUTSIDE `plugins/github/` MAY NOT GAIN A `gh` CALL, AND THE FILES THAT HOLD ONE TODAY ARE A BASELINE THAT ONLY GOES DOWN.
 *
 * A11-160 MOVES EVERY `gh` CALL INTO `plugins/github` (Decision 2 of A11-157: core depends only on the contracts), step by step, and this ratchet is how each step is held. `plugins/github/` is
 * exempt, by path, because it is where a `gh` call is meant to be. `src/ticket-port/` WAS EXEMPT while it held the row mode adapter and what only row mode imported; step 4 moved those into the plugin
 * (behind the code host's `rows`), so the directory is a port of types and delegates and holds no call, and a call there is refused like any other. The scan is WIDER than it was
 * (`gh-call-inventory.ts`): `src/`, `scripts/` and `plugins/`, and every shell script of `host/`, `src/` and `plugins/`. The files that scan newly sees are in the baseline at the count they hold,
 * which is not a new call and is held there: the last step of A11-160 empties `files`, and the rule becomes "no file outside `plugins/github/` calls gh".
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
 * WHAT FAILS: a file of a fresh inventory that (a) is outside `plugins/github/` and has no baseline entry, or (b) holds more `spawns` or more `calls` than its entry. The message
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
/** The ticket port's directory: it was exempt while it held row mode's calls, and holds none since A11-160's step 4 moved them into the plugin. */
const PORT_DIRECTORY = "src/ticket-port/";
/** The plugin's directory: exempt by path, because it is where a `gh` call is meant to be (A11-160). */
const PLUGIN_DIRECTORY = "plugins/github/";
/** What no baseline entry is needed for. */
const isExempt = (file: string): boolean => file.startsWith(PLUGIN_DIRECTORY);

type Allowance = { spawns: number; calls: number };
type Baseline = { files: Record<string, Allowance> };

/** What the inventory says of a file, in the baseline's two numbers. `calls` is the sum of the shape counts. */
function allowanceOf(entry: Inventory["files"][string]): Allowance {
  return { spawns: entry.spawns, calls: Object.values(entry.calls).reduce((sum, count) => sum + count, 0) };
}

/** The baseline a tree would be written as: every inventory file outside the exemptions. How `docs/gh-call-baseline.json` was first produced. */
function baselineOf(inventory: Inventory): Baseline {
  const files: Record<string, Allowance> = {};
  for (const [file, entry] of Object.entries(inventory.files)) {
    if (!isExempt(file)) files[file] = allowanceOf(entry);
  }
  return { files };
}

/** One line per offender, each naming the file and both numbers; empty when the tree holds no more than the baseline allows. */
function offenders(inventory: Inventory, baseline: Baseline): string[] {
  const found: string[] = [];
  for (const [file, entry] of Object.entries(inventory.files)) {
    if (isExempt(file)) continue;
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

const WHERE_NEW_CODE_GOES = "A call to GitHub belongs in `plugins/github/`, behind the codeHost contract (`src/plugins/contracts/code-host.ts`): not into a baselined file, and do not raise the baseline.";

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

test("the committed baseline admits today's tree: the real inventory yields no offender, and the scan is not vacuous", () => {
  const root = judgedRoot();
  const baseline: Baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  const inventory = buildInventory(root);
  const found = offenders(inventory, baseline);
  assert.deepEqual(found, [], `${found.join("\n")}\n${WHERE_NEW_CODE_GOES}`);
  // Positive controls: a scan that finds nothing would yield no offender for anything. It must see the plugin (which is exempt, so the exemption has something to exempt), and each place the
  // scan was widened to read: a script, and a shell script.
  const plugin = Object.keys(inventory.files).filter((file) => file.startsWith(PLUGIN_DIRECTORY));
  assert.ok(plugin.length > 0 && plugin.some((file) => inventory.files[file]!.spawns > 0), `${PLUGIN_DIRECTORY} is not in the inventory with a spawn: the scan does not see the plugin, so its exemption exempts nothing`);
  assert.ok(Object.keys(inventory.files).some((file) => file.startsWith("scripts/")), "no file of scripts/ is in the inventory: the scan does not read it");
  assert.ok(Object.keys(inventory.files).some((file) => /\.sh$/.test(file)), "no shell script is in the inventory: the scan does not read them");
  assert.ok((inventory.files["plugins/github/wrapper/gh"]?.spawns ?? 0) > 0, "the routing wrapper (a shell script with no extension, the GitHub plugin's since A11-160) is not in the inventory with a spawn: the scan does not read a plugin's shell scripts, so its exemption exempts nothing");
  for (const file of Object.keys(baseline.files)) assert.ok(!isExempt(file), `${file} is in the baseline though its directory is exempt`);
});

test("the plugin is in the real inventory with the adapter it moved there, and neither it nor the ticket port is in the baseline: the exemption is by path and the port holds no call", () => {
  const root = judgedRoot();
  const baseline: Baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  const inventory = buildInventory(root);
  const adapter = `${PLUGIN_DIRECTORY}rows/adapter.ts`;
  assert.ok(Object.hasOwn(inventory.files, adapter), `${adapter} is not in the inventory, so the exemption has nothing to exempt`);
  assert.ok(Object.hasOwn(inventory.files, `${PLUGIN_DIRECTORY}gh.ts`), `${PLUGIN_DIRECTORY}gh.ts, where the gh process is started, is not in the inventory`);
  assert.deepEqual(Object.keys(baseline.files).filter(isExempt), [], "the baseline lists a file under an exempt directory, which the exemption makes unnecessary");
  assert.deepEqual(Object.keys(inventory.files).filter((file) => file.startsWith(PORT_DIRECTORY)), [], "the ticket port holds a gh call: it belongs in the plugin, behind the code host's rows");
  assert.deepEqual(Object.keys(baseline.files).filter((file) => file.startsWith(PORT_DIRECTORY)), [], "the baseline lists a file of the ticket port, which holds no call");
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

test("a new file that spawns the command in plugins/ or scripts/ is reported by its name, unless it is the GitHub plugin's", () => {
  const extra = spawn("spawnSync", ["pr", "view"]);
  const other = judge(BASE, { ...BASE, "plugins/linear/extra.ts": extra });
  assert.equal(other.found.length, 1, "another plugin may not call gh");
  assert.match(other.found[0]!, /^plugins\/linear\/extra\.ts: /);
  const script = judge(BASE, { ...BASE, "scripts/extra.ts": extra });
  assert.equal(script.found.length, 1, "a script may not either");
  assert.match(script.found[0]!, /^scripts\/extra\.ts: /);
  const inPlugin = judge(BASE, { ...BASE, [`${PLUGIN_DIRECTORY}extra.ts`]: extra });
  assert.ok(Object.hasOwn(inPlugin.inventory.files, `${PLUGIN_DIRECTORY}extra.ts`), "the inventory lists the file in the plugin, so an empty report is the exemption and not a file nobody saw");
  assert.deepEqual(inPlugin.found, []);
});

test("a shell script that runs the command is reported by its name, and one that only mentions it is not", () => {
  const runs = `#!/bin/sh\n# posts the report\n${COMMAND} issue comment 1 --body "$BODY"\nout="$(${COMMAND} run list)"\n`;
  const mentions = `#!/bin/sh\n# ${COMMAND} issue list is how this was done\nbranch="agent/${COMMAND}-wrapper"\n${COMMAND}-real auth status\necho "${COMMAND}"\n`;
  const without = judge(BASE, { ...BASE, "host/post.sh": mentions });
  assert.ok(!Object.hasOwn(without.inventory.files, "host/post.sh"), "a comment, a branch name, a different binary and an echoed word are not a spawn");
  assert.deepEqual(without.found, []);
  const reported = judge(BASE, { ...BASE, "host/post.sh": runs });
  assert.equal(reported.found.length, 1);
  assert.match(reported.found[0]!, /^host\/post\.sh: a new file that calls the tracker's CLI \(spawns 2, calls 0\)/, "named, with both runs of the command word counted");
  const named = judge(BASE, { ...BASE, "host/wrapper": `#!/usr/bin/env bash\n${COMMAND} pr list\n` });
  assert.equal(named.found.length, 1, "a script with no extension is read by its shebang");
  assert.deepEqual(judge(BASE, { ...BASE, "host/notes.txt": `${COMMAND} pr list\n` }).found, [], "CONTROL: a file that is no script is not read");
  assert.deepEqual(judge(BASE, { ...BASE, [`${PLUGIN_DIRECTORY}install.sh`]: runs }).found, [], "a shell script in the plugin is the plugin's");
});

test("the same new file placed under src/ticket-port/ IS reported: the port's exemption is gone, and only the plugin's directory is exempt", () => {
  const extra = spawn("spawnSync", ["pr", "view"]);
  const outside = judge(BASE, { ...BASE, "src/extra.ts": extra });
  const inside = judge(BASE, { ...BASE, [`${PORT_DIRECTORY}extra.ts`]: extra });
  assert.equal(outside.found.length, 1, "CONTROL: outside the port the same text is reported");
  assert.ok(Object.hasOwn(inside.inventory.files, `${PORT_DIRECTORY}extra.ts`), "the inventory lists the file in the port");
  assert.equal(inside.found.length, 1, "and the port is no exception");
  assert.match(inside.found[0]!, /^src\/ticket-port\/extra\.ts: /);
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
