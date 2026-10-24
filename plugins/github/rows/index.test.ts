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
import { GhFailure, ghRunner } from "../gh.ts";
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
  assert.equal(asked, 0, "none of those reads the project");
  assert.throws(() => rows.readRowsByLabel({ label: "x", state: "OPEN", select: "number", run: refused }), /HTTP 502|not registered/);
  assert.throws(() => rows.ticketAdapter({ run: refused, scope: "o/r" }), /core's helpers are not registered/);
  assert.ok(asked >= 2, "the operations that read the project asked for it, each when it was called");
});

// --- 3. the operations --------------------------------------------------------------------------------------------------------------

test("the rows hold the contract's operations and values, and the values are the ones a caller sizes its reads by", () => {
  const rows: CodeHostRows = createRows(() => { throw new Error("not asked"); });
  assert.equal(rows.tracker, "github");
  assert.equal(rows.acts, "through-run", "the GitHub plugin's operations act on the run their caller hands them");
  assert.equal(rows.sincePageSize, 100, "a connection page is 100 rows at most, which a caller sizing a window by pages divides by");
  assert.equal(rows.projectItemsPage, 100);
  assert.deepEqual(rows.corePoolProbe, ["api", "user", "-i"]);
  assert.match(rows.openItemsQuery, /rateLimit \{ limit remaining resetAt \}/);
  assert.deepEqual(Object.entries(rows).filter(([, value]) => typeof value !== "function").map(([name]) => name).sort(), ["acts", "command", "corePoolProbe", "openItemsQuery", "projectItemsPage", "sincePageSize", "tracker"]);
});

// --- 4. the runners the plugin gives an operation whose caller hands none (A11-160, step 5) -----------------------------------------------------------


test("an operation whose caller hands no `run` runs the plugin's own, and a caller's `run` is used instead when it hands one", () => {
  const seen: string[] = [];
  const own = (args: string[]) => { seen.push(`own ${args[0]}`); return JSON.stringify({ merged: true }); };
  const rows = createRows(() => { throw new Error("not asked"); }, { own, queue: () => { throw new Error("the queue runner is not this operation's"); } });
  assert.equal(rows.isMergedPull({ repo: "o/r", number: "7" }), true);
  assert.equal(rows.isMergedPull({ repo: "o/r", number: "7", run: (args) => { seen.push(`caller ${args[0]}`); return JSON.stringify({ merged: false }); } }), false);
  assert.deepEqual(seen, ["own api", "caller api"]);
  assert.equal(rows.ownRun(["x"]), JSON.stringify({ merged: true }), "ownRun is the plugin's own runner, for the callers that have not moved");
  assert.throws(() => createRows(() => { throw new Error("not asked"); }).isMergedPull({ repo: "o/r", number: "7" }), /built with no runner of their own/);
});

test("the merge queue's operations run the queue runner, which is the one that takes the git variables off", () => {
  const seen: string[] = [];
  const rows = createRows(() => { throw new Error("not asked"); }, { own: () => { seen.push("own"); return "[]"; }, queue: () => { seen.push("queue"); return "[]"; } });
  rows.openPullsForQueue();
  rows.compareWithMain({ repo: "o/r", branch: "b" });
  rows.mergeQueuedPull({ number: 1 });
  rows.deleteBranchOf({ repo: "o/r", branch: "b" });
  rows.openPullsOfBranch({ repo: "o/r", branch: "b" });
  assert.deepEqual(seen, ["queue", "queue", "queue", "queue", "own"], "the dispatcher's four are the queue's; a read of a branch's pull request is any other caller's");
});

test("the pool a refused read names is read off the headers a refused `gh api -i` still prints, through the plugin's own runner when the caller hands none", () => {
  const headers = "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Reset: 1790000000\n";
  const exec = () => ({ status: 1, stdout: headers, stderr: "gh: API rate limit exceeded" });
  const pool = {
    rawResponse: (args: readonly string[], run: (args: string[]) => string) => { try { return run([...args]) || null; } catch (error) { return (error as { stdout?: string }).stdout || null; } },
    fromResponse: (raw: string | null) => (raw === null ? null : { remaining: Number(/Remaining: (\d+)/.exec(raw)?.[1]), limit: 5000, used: 5000, resetInMinutes: null }),
    fromRateLimitField: () => null,
  };
  const rows = createRows(() => ({ pool }) as never, { own: ghRunner({ exec }), queue: () => "" });
  assert.deepEqual(rows.graphqlPoolOf(), { remaining: 0, limit: 5000, used: 5000, resetInMinutes: null }, "the headers survive the failure, as they did on execFileSync's error");
  assert.ok(new GhFailure(["x"], { status: 1, stdout: headers, stderr: "" }).stdout.includes("X-Ratelimit"));
  assert.equal(rows.graphqlPoolOf(() => ""), null, "a caller's own run that answers nothing reads no pool");
});
