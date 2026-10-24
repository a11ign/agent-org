// no-token: gh -- agent-org#484. The delegates are handed a stub for `gh` and the source tests read files; nothing here spends a point or needs a token.
/**
 * agent-org#484 (Phase 0 of a11ign/a11ign#4505, ADR 0046), as A11-160 left it: THE TICKET PORT'S DIRECTORY HOLDS NO `gh` CALL. The GitHub adapter and the reads and writes of rows moved into the GitHub plugin
 * (`plugins/github/rows/`, behind the code host's `rows`), and each file here that a caller imports is a delegate to it. The adapter's own tests moved with it (`plugins/github/rows/adapter.test.ts`).
 *
 * Four claims, each with a case that can fail:
 *   1. `port.ts` imports no adapter and names no `gh` call, and the source test that says so SEES a fixture that does (its positive control);
 *   2. no file of this directory spawns `gh` or imports an adapter: not even the delegate that keeps the adapter's old path;
 *   3. a delegate calls the code host's `rows`, and every operation of `rows` has one: a drift in either direction fails;
 *   4. `readRowsOffBoard` reads the tracker only through the port, and its facts are the ones it always returned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TRACKER } from "./github-adapter.ts";
import { PROJECT_NUMBER } from "../board-snapshot-scope.ts";
import { loadedCodeHost, forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { rows } from "../plugins/rows.ts";
import { readRowsOffBoard } from "../work-gate/causes/rows-off-board.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The board a node says it is an item of, by number: the gate's own `PROJECT_NUMBER`, never a copy of it. */
const BOARD = PROJECT_NUMBER;

// --- 1. the source test -------------------------------------------------------------------------------------------------------------

const SPAWNERS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
/** `exec` is also what a regular expression is run with (`/x/.exec(s)`), so it counts only as a bare call, which is how it is imported from `child_process`. */
const BARE_ONLY = new Set(["exec"]);
const CHILD_PROCESS = /^(node:)?child_process$/;

/** Every place `source` imports a module, as the specifier. Static, re-exported and dynamic. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    const isModuleSpecifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier);
    if (isModuleSpecifier) out.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const isRequireCall = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (isRequireCall) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return out;
}

/** What in `source` is a `gh` call: the child-process module, a call to a spawner, or the string `gh` as a command. Comments are prose, and are not read. */
function ghFindings(source: string): string[] {
  const found: string[] = [];
  for (const spec of importsOf(source)) if (CHILD_PROCESS.test(spec)) found.push(`imports ${spec}`);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const bare = ts.isIdentifier(node.expression) ? node.expression.text : "";
      const member = ts.isPropertyAccessExpression(node.expression) && !BARE_ONLY.has(node.expression.name.text) ? node.expression.name.text : "";
      const callee = bare || member;
      if (SPAWNERS.has(callee)) found.push(`calls ${callee}()`);
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /^gh$|^gh\s/.test(node.text)) found.push(`names the command ${JSON.stringify(node.text)}`);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}

const adapterImportsOf = (source: string) => importsOf(source).filter((spec) => /(^|\/)[a-z-]*adapter(\.ts)?$/.test(spec));

const portSource = readFileSync(join(HERE, "port.ts"), "utf8");

test("#484 port.ts names no `gh` call and imports no adapter", () => {
  assert.deepEqual(ghFindings(portSource), []);
  assert.deepEqual(adapterImportsOf(portSource), []);
  assert.deepEqual(importsOf(portSource), [], "it imports nothing at all: a type file with a dependency is a type file with a coupling");
});

test("#484 no file under src/ticket-port spawns `gh` or imports an adapter: the adapter is the GitHub plugin's, and the delegate that keeps its path takes it from the code host", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.includes("port.ts") && files.includes("github-adapter.ts"), "the walk sees port.ts and the adapter's delegate: an empty walk would pass for the wrong reason");
  for (const file of files) {
    const source = readFileSync(join(HERE, file), "utf8");
    assert.deepEqual(ghFindings(source), [], `${file} spawns gh`);
    assert.deepEqual(adapterImportsOf(source), [], `${file} imports an adapter`);
  }
});

/** The tracker's CLI, kept out of a call-shaped literal so this file is not itself charged for spawning it (the fixtures below are the only place it is named). */
const GH = "gh";

test("#484 NEGATIVE CONTROL: the source test reports a port file that spawns `gh` or imports its adapter", () => {
  const spawning = [
    ["execFileSync of gh", `import { execFileSync } from "node:child_process";\nexport const read = () => execFileSync(${JSON.stringify(GH)}, ["issue", "list"]);\n`, ["imports node:child_process", "calls execFileSync()", 'names the command "gh"']],
    ["a bare spawn", `import cp from "child_process";\nexport const go = () => cp.spawnSync("sh", ["-c", "x"]);\n`, ["imports child_process", "calls spawnSync()"]],
    ["the command as a template", "export const cmd = (n: number) => `gh issue view ${n}`;\n", ['names the command "gh issue view "']],
  ] as const;
  for (const [name, source, expected] of spawning) {
    assert.deepEqual(ghFindings(source), expected, `${name} is reported`);
  }
  assert.deepEqual(adapterImportsOf(`import { githubTicketAdapter } from "./github-adapter.ts";\nexport const x = githubTicketAdapter;\n`), ["./github-adapter.ts"]);
  assert.deepEqual(adapterImportsOf(`export * from "./other-adapter.ts";\n`), ["./other-adapter.ts"], "a re-export is an import");
  assert.deepEqual(adapterImportsOf(`const a = await import("./github-adapter.ts");\n`), ["./github-adapter.ts"], "a dynamic import is one");
  // And the marker is not a blanket: prose about `gh` and a clean port are not reported.
  assert.deepEqual(ghFindings(`// gh is what the adapter runs\nexport interface P { readItem(ref: string): string | null }\n`), []);
  assert.deepEqual(ghFindings("export const id = (s: string) => /#(\\d+)/.exec(s)?.[1];\n"), [], "a regular expression's `exec` is not a spawn");
  assert.deepEqual(ghFindings(`import { exec } from "node:child_process";\nexec("gh issue list");\n`), ["imports node:child_process", "calls exec()", 'names the command "gh issue list"'], "and the imported one is");
});

// --- 3. the delegates ----------------------------------------------------------------------------------------------------------------

/**
 * The members of the rows a core file reaches: `delegates("<operation>", ...)` for operations, and `rows().<member>` for a value or a call made by hand, `const { <member>, ... } = rows()` for several, and `<name>.<member>` where `const <name> = rows()`. The files are this directory's (the ticket port's
 * own delegates) and, since step 5 of A11-160 moved the callers that arm, guard and queue a merge, the files of `src/` that ask the code host for what those callers need (`arm-pr.ts`, `merge-guard.ts`, ...):
 * every non-test file under `src/`, because an operation is as reachable from a caller as from a delegate beside the port, and (step 9) the scripts of `scripts/`, and a file that imports `rows` under another name.
 */
function delegatedOperations(): Set<string> {
  const found = new Set<string>();
  const sourceRoot = join(HERE, "..");
  const scriptsRoot = join(HERE, "..", "..", "scripts");
  const files = [
    ...readdirSync(sourceRoot, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("node_modules") && !f.startsWith("packaging/")).map((f) => join(sourceRoot, f)),
    ...readdirSync(scriptsRoot, { encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(scriptsRoot, f)),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // The name this file imports `rows` under: `rows`, or an alias (`import { rows as hostRows }`, when the file has a `rows` of its own).
    const imported = /import \{([^}]*)\} from "[^"]*plugins\/rows\.ts"/.exec(source)?.[1];
    const names = imported === undefined ? [] : [...imported.matchAll(/\brows(?:\s+as\s+(\w+))?/g)].map((match) => match[1] ?? "rows");
    const accessors = ["rows", "codeHostRows", ...names].join("|");
    for (const alias of names.length > 0 ? source.matchAll(new RegExp(`\\bconst (\\w+) = (?:${accessors})\\(\\)(?!\\.)`, "g")) : []) {
      for (const member of source.matchAll(new RegExp(`(?<![.\\w])${alias[1]}\\.(\\w+)`, "g"))) found.add(member[1]!);
    }
    for (const match of source.matchAll(new RegExp(`\\bdelegates?\\(([^)]*)\\)|\\b(?:${accessors})\\(\\)\\.(\\w+)|\\{([^{}]*)\\}\\s*=\\s*(?:${accessors})\\(\\)(?!\\.)`, "g"))) {
      if (match[2] !== undefined) found.add(match[2]);
      else if (match[3] !== undefined) for (const member of match[3].split(",")) found.add(member.split(":")[0]!.trim());
      else for (const name of match[1]!.matchAll(/"(\w+)"/g)) found.add(name[1]!);
    }
  }
  return found;
}

test("A11-160 the delegates and the code host's `rows` cover each other: an operation nobody delegates to, or a delegate to none, fails", () => {
  const operations = Object.keys(rows());
  const delegated = delegatedOperations();
  assert.ok(operations.length > 50, "the real code host's rows are the ones read: a short list would pass for the wrong reason");
  // `tracker` is core's own vocabulary (`TRACKER`) and is checked below, and `acts` is how the code host's operations act, which the contract suite reads; every other member is read through a delegate.
  const undelegated = operations.filter((operation) => operation !== "tracker" && operation !== "acts" && !delegated.has(operation));
  assert.deepEqual(undelegated, [], "an operation of the rows no file of src reaches");
  assert.deepEqual([...delegated].filter((operation) => !operations.includes(operation)), [], "a delegate to an operation the rows do not have");
  assert.equal(rows().tracker, TRACKER, "core's name for the adapter's kind of tracker is the code host's");
});

test("A11-160 a code host without `rows` refuses a row-mode program by name", () => {
  try {
    substituteCodeHost({ ...createFakeCodeHost(), rows: undefined });
    assert.throws(() => rows(), /row mode needs a code host that implements rows: .+ does not/);
    assert.equal(loadedCodeHost().rows, undefined, "the host that was asked is the one with none");
  } finally {
    forgetActivation();
  }
  assert.ok(rows().ticketAdapter, "CONTROL: with the substitute gone the host file's code host serves them");
});

// --- 4. the consumer -----------------------------------------------------------------------------------------------------------------

test("#484 consumer: readRowsOffBoard reads the tracker only through the port, and its facts are unchanged (on the fake code host's rows)", () => {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  const created = "2026-09-26T08:00:00.000Z";
  world.rows.set(1, fakeRow(world, 1, { title: "row 1", createdAt: created, onBoard: true }));
  world.rows.set(2, fakeRow(world, 2, { title: "row 2", createdAt: created, onBoard: false }));
  world.rows.set(3, fakeRow(world, 3, { title: "row 3", createdAt: created, state: "CLOSED" }));
  world.budget = { account: "a11ign-ai-leads", resource: "graphql", remaining: 4000, limit: 5000, resetAt: "2026-10-10T13:00:00Z" };
  substituteCodeHost(host);
  const run = (): string => {
    throw new Error("the fake code host acts on its own state: no gh is run");
  };
  const pools: unknown[] = [];
  try {
    const facts = readRowsOffBoard(run, pools as never);
    assert.deepEqual(facts, [
      { number: 1, title: "row 1", createdMs: Date.parse(created), onBoard: true },
      { number: 2, title: "row 2", createdMs: Date.parse(created), onBoard: false },
    ], "the open rows, each with whether it is on the board; a closed row is not asked about");
    assert.deepEqual(pools, [world.budget], "the budget the tracker named reached the tick");
    world.budget = null;
    pools.length = 0;
    readRowsOffBoard(run, pools as never);
    assert.deepEqual(pools, [], "CONTROL: a tracker that names none tells the tick none");
  } finally {
    forgetActivation();
  }
});

test("#484 consumer: work-gate.ts no longer names the off-board query or its paging; it asks through the port", () => {
  const source = workGateSource();
  const start = source.indexOf("export function readRowsOffBoard(");
  assert.ok(start > 0, "the function is still exported from work-gate.ts, where its callers import it");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /githubTicketAdapter\(/);
  assert.match(body, /readOpenItems\(/);
  assert.doesNotMatch(body, /"graphql"|projectItems|hasNextPage/, "the GitHub vocabulary is the adapter's");
});
