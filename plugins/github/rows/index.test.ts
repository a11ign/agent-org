// no-token: gh -- a source test over this folder, and `createRows` handed a helpers function that is never reached or throws; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 4): THE GITHUB PLUGIN'S `rows`, the operations `src/ticket-port/` held before row mode's GitHub calls moved here.
 *
 * Three claims, each with a case that can fail:
 *   1. no file of this folder spawns anything or imports `child_process`: every operation runs the `run` its caller hands it, and the source test that says so SEES a fixture that does (its positive control);
 *   2. the rows ask core for what it owns of row mode when an operation needs it, never when they are built, and an operation that needs none never asks;
 *   3. the rows are the operations the contract names, no more and no fewer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { CodeHostRows } from "../../../src/plugins/contracts/code-host-rows.ts";
import { createRows } from "./index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- 1. the source test --------------------------------------------------------------------------------------------------------------

const SPAWNERS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
/** `exec` is also what a regular expression is run with (`/x/.exec(s)`), so it counts only as a bare call, which is how it is imported from `child_process`. */
const BARE_ONLY = new Set(["exec"]);
const CHILD_PROCESS = /^(node:)?child_process$/;

/** What in `source` starts a process: the child-process module, or a call to a spawner. Comments are prose, and are not read. */
function spawnFindings(source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const isModuleSpecifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier);
    if (isModuleSpecifier && CHILD_PROCESS.test(node.moduleSpecifier.text)) found.push(`imports ${node.moduleSpecifier.text}`);
    if (ts.isCallExpression(node)) {
      const bare = ts.isIdentifier(node.expression) ? node.expression.text : "";
      const member = ts.isPropertyAccessExpression(node.expression) && !BARE_ONLY.has(node.expression.name.text) ? node.expression.name.text : "";
      const callee = bare || member;
      if (SPAWNERS.has(callee)) found.push(`calls ${callee}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}

test("no file of the rows folder starts a process: every operation runs the `run` its caller hands it", () => {
  const files = readdirSync(HERE).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  assert.ok(files.includes("adapter.ts") && files.includes("rows-by-label.ts"), "the walk sees the adapter and the reads by label: an empty walk would pass for the wrong reason");
  for (const file of files) assert.deepEqual(spawnFindings(readFileSync(join(HERE, file), "utf8")), [], `${file} starts a process`);
});

test("NEGATIVE CONTROL: the source test reports a file that spawns, however it spells it, and not one that only runs a regular expression", () => {
  assert.deepEqual(spawnFindings(`import { execFileSync } from "node:child_process";\nexport const read = () => execFileSync("x", []);\n`), ["imports node:child_process", "calls execFileSync()"]);
  assert.deepEqual(spawnFindings(`import cp from "child_process";\nexport const go = () => cp.spawnSync("sh", ["-c", "x"]);\n`), ["imports child_process", "calls spawnSync()"]);
  assert.deepEqual(spawnFindings("export const id = (s: string) => /#(\\d+)/.exec(s)?.[1];\n"), [], "a regular expression's `exec` is not a spawn");
});

// --- 2. what core owns is asked when it is needed -------------------------------------------------------------------------------------

test("the rows ask core's helpers when an operation needs them, and the operations that need none never ask", () => {
  let asked = 0;
  const rows = createRows(() => {
    asked += 1;
    throw new Error("core's helpers are not registered");
  });
  assert.equal(asked, 0, "building the rows asks nothing: a host with no project declaration builds a code host that is never asked for a row");
  const refused = () => {
    throw new Error("HTTP 502");
  };
  assert.deepEqual(rows.readOpenPullHeads("o/r", refused, 100).read, false);
  assert.equal(rows.openIncidentsOf("o/r", refused), null);
  assert.deepEqual(rows.repoViewArgs("o/r"), ["repo", "view", "o/r"]);
  assert.equal(asked, 0, "none of those reads the project");
  assert.throws(() => rows.readRowsByLabel({ label: "x", state: "OPEN", select: "number", run: refused }), /HTTP 502|not registered/);
  assert.throws(() => rows.ticketAdapter({ run: refused, scope: "o/r" }), /core's helpers are not registered/);
  assert.ok(asked >= 2, "the operations that read the project asked for it, each when it was called");
});

// --- 3. the operations --------------------------------------------------------------------------------------------------------------

test("the rows hold the contract's operations and values, and the values are the ones a caller sizes its reads by", () => {
  const rows: CodeHostRows = createRows(() => { throw new Error("not asked"); });
  assert.equal(rows.tracker, "github");
  assert.equal(rows.sincePageSize, 100, "a connection page is 100 rows at most, which a caller sizing a window by pages divides by");
  assert.equal(rows.projectItemsPage, 100);
  assert.deepEqual(rows.corePoolProbe, ["api", "user", "-i"]);
  assert.match(rows.openItemsQuery, /rateLimit \{ limit remaining resetAt \}/);
  assert.deepEqual(Object.entries(rows).filter(([, value]) => typeof value !== "function").map(([name]) => name).sort(), ["corePoolProbe", "openItemsQuery", "projectItemsPage", "sincePageSize", "tracker"]);
});
