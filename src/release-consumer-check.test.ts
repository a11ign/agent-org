/**
 * a11ign/a11ign#4412 (b of #4407): THE RELEASE CHECKS ITS CONSUMER BEFORE IT TAGS.
 *
 * v0.88.0 renamed `src/*.mjs` to `.ts` and shipped, and every a11ign pull request's `acceptance / run` died on `ERR_MODULE_NOT_FOUND`: nothing between the merge and the tag asked
 * whether the project that installs the tag still works against it. `src/public-interface.test.ts` now pins WHAT IS DECLARED; this file pins that the release RUNS it, and runs a
 * second check beside it, that what a11ign actually imports is a subset of the declaration.
 *
 * Two things live here, each with its controls:
 *   1. `release.yml` has a job, `consumer-check`, that the tagging job `release` NEEDS, holding two steps in this order: the public-interface test, then this file against a checkout of
 *      a11ign/a11ign. Removing the job, the `needs`, or either step fails (the negative controls below); a step excused by `if:` or `continue-on-error` fails too, because a check that
 *      cannot stop the tag is the same as no check.
 *   2. `consumerProblems` reads a11ign's tree for the names it imports through `agent-org/<subpath>` and refuses any subpath or name `public-interface.test.ts` does not declare. It is
 *      run on the real tree only when `A11IGN_CHECKOUT` names one (the release job sets it), and ALWAYS on fixture trees, so the scan is exercised in every ordinary run.
 *
 * What it does NOT read: a11ign's `agent-org <subcommand>` calls (the `bin`'s own pin, `DECLARED_COMMANDS`, is the public-interface test's) and a path under `src/` (the import
 * guard of #4407 c refuses those). On 2026-10-09 a11ign imports NOTHING by name yet, so the real reading is "scanned N files, found no use" until its migration rows land.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSUMER = process.env["A11IGN_CHECKOUT"];

// ---- the declaration, READ from the file that pins it so that there is one list and not two ----------------------------------------------

type Declared = { exports: Record<string, readonly string[]>; data: readonly string[] };

/** The string-literal object/array initialiser of `name` in `source`, unwrapped from `as`/`satisfies`. A shape it cannot read throws: an unreadable pin must not pass as an empty one. */
function literalOf(source: ts.SourceFile, name: string): unknown {
  let found: ts.Expression | undefined;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) found = d.initializer;
  });
  if (found === undefined) throw new Error(`public-interface.test.ts declares no ${name}`);
  return evaluate(found);
}

function evaluate(node: ts.Expression): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((p) => {
      if (!ts.isPropertyAssignment(p) || !(ts.isStringLiteralLike(p.name) || ts.isIdentifier(p.name))) throw new Error("an object member public-interface.test.ts's list may not hold");
      return [p.name.text, evaluate(p.initializer)];
    }));
  }
  throw new Error(`a ${ts.SyntaxKind[node.kind]} in the declared list, which this reader does not evaluate`);
}

function readDeclared(file: string = join(ROOT, "src", "public-interface.test.ts")): Declared {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return { exports: literalOf(source, "DECLARED_EXPORTS") as Declared["exports"], data: literalOf(source, "DATA_EXPORTS") as string[] };
}

// ---- the consumer's use: every `agent-org/<subpath>` it imports, and the names it takes from it ---------------------------------------------

type Use = { file: string; specifier: string; names: string[] };
const SPECIFIER = /^agent-org(?:\/.*)?$/;
const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js", ".ts", ".mts", ".cts"]);
const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);
const NOT_THE_PROJECT = new Set([".git", "node_modules", "runs"]);

function* filesUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_THE_PROJECT.has(entry.name)) continue;
    if (entry.isDirectory()) yield* filesUnder(join(dir, entry.name));
    else if (entry.isFile()) yield join(dir, entry.name);
  }
}

/** `{ a, b as c }` of an import/export clause, or of a destructuring of `await import(...)`: the names the SOURCE exports, not the local ones. */
function boundNames(node: ts.Node): string[] {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const named = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text) : [];
    return [...(clause?.name === undefined ? [] : ["default"]), ...named];
  }
  if (ts.isExportDeclaration(node)) return node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : [];
  return [];
}

/** `const { a } = await import("agent-org/x")`: the pattern the call sits in, if any. */
function destructuredNames(call: ts.CallExpression): string[] {
  let parent: ts.Node = call.parent;
  while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isObjectBindingPattern(parent.name)) return [];
  return parent.name.elements.map((e) => (e.propertyName ?? e.name)).filter(ts.isIdentifier).map((id) => id.text);
}

/** A call that names a module by string: `import("x")`, `require("x")`, `createRequire(..).resolve("x")`. */
function isModuleCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  return (ts.isIdentifier(callee) && callee.text === "require") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "resolve");
}

function usesInSource(file: string, text: string): Use[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: Use[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (SPECIFIER.test(node.moduleSpecifier.text)) uses.push({ file, specifier: node.moduleSpecifier.text, names: boundNames(node) });
    } else if (ts.isCallExpression(node) && isModuleCall(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg) && SPECIFIER.test(arg.text)) uses.push({ file, specifier: arg.text, names: destructuredNames(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/**
 * A workflow imports a module only inside a `run:` script, as `import('x')`, `require('x')`, `.resolve('x')` or `from 'x'`: a quoted `"agent-org"` is the COMMAND's name (a11ign's workflows
 * run it dozens of times) and a comment line is prose, and neither is a use.
 */
function usesInWorkflow(file: string, text: string): Use[] {
  const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const call = /(?:\bimport\s*\(|\brequire\s*\(|\bresolve\s*\(|\bfrom)\s*["'`](agent-org(?:\/[A-Za-z0-9_./-]+)?)["'`]/g;
  return [...code.matchAll(call)].map((m) => ({ file, specifier: m[1] as string, names: [] }));
}

/** Every use under `root`, and how many files were read: a scan that read none found nothing for the wrong reason. */
function scan(root: string): { uses: Use[]; filesRead: number } {
  const uses: Use[] = [];
  let filesRead = 0;
  for (const file of filesUnder(root)) {
    const extension = extname(file);
    const isSource = SOURCE_EXTENSIONS.has(extension);
    if (!isSource && !WORKFLOW_EXTENSIONS.has(extension)) continue;
    filesRead += 1;
    const text = readFileSync(file, "utf8");
    uses.push(...(isSource ? usesInSource(file, text) : usesInWorkflow(file, text)));
  }
  return { uses, filesRead };
}

/** Every use the declaration does not carry: a subpath it does not name, or a name that subpath is not declared to give. */
function consumerProblems(uses: readonly Use[], declared: Declared): string[] {
  const problems: string[] = [];
  for (const use of uses) {
    const subpath = use.specifier.replace(/^agent-org/, ".");
    const names = declared.exports[subpath];
    if (names === undefined && declared.data.includes(subpath)) continue;
    if (names === undefined) {
      problems.push(`${use.file}: imports ${use.specifier}, which the declared interface does not name`);
      continue;
    }
    for (const name of use.names) if (!names.includes(name)) problems.push(`${use.file}: takes ${name} from ${use.specifier}, which is not a declared name`);
  }
  return problems;
}

test("a11ign's declared-name use is a subset of the declared interface (the release job's reading of the real tree)", {
  skip: CONSUMER === undefined ? "A11IGN_CHECKOUT is unset: only release.yml's consumer-check job has a11ign's tree, and the workflow test below pins that it sets this" : false,
}, () => {
  const { uses, filesRead } = scan(CONSUMER as string);
  // POSITIVE CONTROL for the emptiness below: a checkout that was not laid, or laid elsewhere, reads no files and would pass with `[]`.
  assert.ok(filesRead > 100, `read only ${filesRead} files under ${CONSUMER}: not a11ign's tree`);
  assert.deepEqual(consumerProblems(uses, readDeclared()), []);
});

// ---- the controls on the scan, on fixture trees ---------------------------------------------------------------------------------------

const DECLARED: Declared = { exports: { "./thing": ["kept", "alsoKept"] }, data: ["./package.json"] };

function consumerFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "release-consumer-check-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function problemsOfTree(files: Record<string, string>): { problems: string[]; uses: number } {
  const root = consumerFixture(files);
  try {
    const { uses } = scan(root);
    return { problems: consumerProblems(uses, DECLARED).map((p) => p.replace(root, "")), uses: uses.length };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("CONTROL (positive): a consumer using only declared subpaths and names, in every form the scan reads, passes, and the scan SAW each use", () => {
  const { problems, uses } = problemsOfTree({
    "a.mjs": 'import { kept, alsoKept as other } from "agent-org/thing";\n',
    "b.ts": 'const { kept } = await import("agent-org/thing");\nconst data = await import("agent-org/package.json");\n',
    "c.cjs": 'const path = require.resolve("agent-org/thing");\n',
    ".github/workflows/w.yml": "jobs:\n  j:\n    steps:\n      - run: node -e \"import('agent-org/thing')\"\n",
  });
  assert.deepEqual(problems, []);
  assert.equal(uses, 5);
});

test("CONTROL (negative): a name the declaration lacks, a subpath it lacks, a src/ path and the bare package each fail, each naming itself", () => {
  const { problems } = problemsOfTree({
    "name.mjs": 'import { kept, removed } from "agent-org/thing";\n',
    "subpath.ts": 'import { x } from "agent-org/other";\n',
    "deep.mjs": 'const m = await import("agent-org/src/acceptance-commands.ts");\n',
    "bare.mjs": 'import * as all from "agent-org";\n',
    ".github/workflows/w.yml": "run: node -e \"import('agent-org/gone')\"\n",
  });
  assert.deepEqual(problems.sort(), [
    "/.github/workflows/w.yml: imports agent-org/gone, which the declared interface does not name",
    "/bare.mjs: imports agent-org, which the declared interface does not name",
    "/deep.mjs: imports agent-org/src/acceptance-commands.ts, which the declared interface does not name",
    "/name.mjs: takes removed from agent-org/thing, which is not a declared name",
    "/subpath.ts: imports agent-org/other, which the declared interface does not name",
  ].sort());
});

test("CONTROL: mentions are not uses: a comment, a string that is not an import, a `github:` install spec and node_modules are not read", () => {
  const { problems, uses } = problemsOfTree({
    "a.mjs": '// import { gone } from "agent-org/gone"\nconst s = "see agent-org/gone";\nconst spec = "github:a11ign/agent-org#semver:^0.1.0";\n',
    ".github/workflows/w.yml": '# run: node -e "import(\'agent-org/gone\')"\nrun: "agent-org" pr:open "agent-org/src/x.ts"\n',
    "node_modules/x/index.mjs": 'import { gone } from "agent-org/gone";\n',
  });
  assert.deepEqual(problems, []);
  assert.equal(uses, 0);
});

test("the declared list is READ from public-interface.test.ts, not copied: it holds the real subpaths and fails loudly on a shape it cannot read", () => {
  const declared = readDeclared();
  assert.ok(Object.keys(declared.exports).length >= 9, `read ${Object.keys(declared.exports).length} declared subpaths`);
  assert.deepEqual(declared.data, ["./package.json"]);
  const root = consumerFixture({ "p.ts": "const DECLARED_EXPORTS = { './x': [name] };\nconst DATA_EXPORTS = [];\n" });
  try {
    assert.throws(() => readDeclared(join(root, "p.ts")), /does not evaluate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- release.yml: the check runs, and runs BEFORE the tag -----------------------------------------------------------------------------

interface Step { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: unknown; "continue-on-error"?: unknown }
interface Job { needs?: string | string[]; steps?: Step[]; uses?: string; if?: unknown; "continue-on-error"?: unknown }
interface Workflow { jobs: Record<string, Job> }

const REAL = parse(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")) as Workflow;
const CHECK_JOB = "consumer-check";
const TAG_JOB = "release";
const INTERFACE_RUN = /node --test src\/public-interface\.test\.ts\b/;
const CONSUMER_RUN = /node --test src\/release-consumer-check\.test\.ts\b/;

const needsOf = (job: Job | undefined): string[] => (job?.needs === undefined ? [] : [job.needs].flat());
const stepIndex = (steps: readonly Step[], pattern: RegExp): number => steps.findIndex((s) => pattern.test(s.run ?? ""));
/** An excuse: `if:` or `continue-on-error` on the job or the step lets the tag go ahead past a red check. */
const excused = (thing: { if?: unknown; "continue-on-error"?: unknown } | undefined): boolean => thing?.if !== undefined || thing?.["continue-on-error"] !== undefined;

/** The tagging job needs the check job; the check job runs the interface test, then the consumer reading against a11ign's checkout; nothing excuses any of it. */
function orderProblems(w: Workflow): string[] {
  const check = w.jobs[CHECK_JOB];
  const tag = w.jobs[TAG_JOB];
  const problems: string[] = [];
  if (tag === undefined) return [`there is no job ${TAG_JOB}, the one that tags`];
  if (check === undefined) return [`there is no job ${CHECK_JOB}: nothing runs before the tag`];
  if (!needsOf(tag).includes(CHECK_JOB)) problems.push(`${TAG_JOB} does not need ${CHECK_JOB}, so the tag can be cut while the check runs or fails`);
  if (excused(check) || excused(tag)) problems.push(`${CHECK_JOB} or ${TAG_JOB} is excused by if/continue-on-error`);
  const steps = check.steps ?? [];
  const iface = stepIndex(steps, INTERFACE_RUN);
  const consumer = stepIndex(steps, CONSUMER_RUN);
  if (iface < 0) problems.push(`${CHECK_JOB} does not run src/public-interface.test.ts`);
  if (consumer < 0) problems.push(`${CHECK_JOB} does not run src/release-consumer-check.test.ts`);
  if (iface >= 0 && consumer >= 0 && iface > consumer) problems.push("the consumer reading runs before the public-interface check");
  if (steps.some(excused)) problems.push(`a step of ${CHECK_JOB} is excused by if/continue-on-error`);
  return [...problems, ...consumerStepProblems(steps, consumer)];
}

/** The consumer reading is only a reading if a11ign/a11ign was checked out and `A11IGN_CHECKOUT` names it: otherwise the test skips, by its own reason, and the step is green. */
function consumerStepProblems(steps: readonly Step[], consumer: number): string[] {
  const problems: string[] = [];
  const checkout = steps.findIndex((s) => s.uses?.startsWith("actions/checkout@") && s.with?.["repository"] === "a11ign/a11ign");
  if (checkout < 0) problems.push(`${CHECK_JOB} does not check out a11ign/a11ign`);
  else if (consumer >= 0 && checkout > consumer) problems.push("a11ign/a11ign is checked out after the step that reads it");
  const path = checkout < 0 ? undefined : String(steps[checkout]?.with?.["path"] ?? "");
  const named = consumer < 0 ? undefined : steps[consumer]?.env?.["A11IGN_CHECKOUT"];
  if (named === undefined || path === undefined || path === "" || !named.endsWith(`/${path}`)) problems.push(`A11IGN_CHECKOUT (${String(named)}) does not name the a11ign checkout's path (${String(path)})`);
  return problems;
}

test("release.yml runs the public-interface check, then the consumer reading, in a job the tagging job needs", () => {
  assert.deepEqual(orderProblems(REAL), []);
});

test("CONTROL (the row's positive): the properties are about something: both jobs exist, both steps are found, the tag job is the shared call", () => {
  assert.ok(REAL.jobs[CHECK_JOB] && REAL.jobs[TAG_JOB]);
  assert.deepEqual(needsOf(REAL.jobs[TAG_JOB]), [CHECK_JOB]);
  assert.equal(stepIndex(REAL.jobs[CHECK_JOB]?.steps ?? [], INTERFACE_RUN) >= 0, true);
  assert.equal(stepIndex(REAL.jobs[CHECK_JOB]?.steps ?? [], CONSUMER_RUN) >= 0, true);
  assert.match(REAL.jobs[TAG_JOB]?.uses ?? "", /release-per-merge\.yml@/);
});

test("CONTROL (the row's negative): each copy with the check removed, or made unable to stop the tag, is refused", () => {
  const mutants: Array<[string, (w: Workflow) => void]> = [
    ["the step that runs the public-interface test removed", (w) => { (w.jobs[CHECK_JOB] as Job).steps = (w.jobs[CHECK_JOB]?.steps ?? []).filter((s) => !INTERFACE_RUN.test(s.run ?? "")); }],
    ["the step that reads a11ign's use removed", (w) => { (w.jobs[CHECK_JOB] as Job).steps = (w.jobs[CHECK_JOB]?.steps ?? []).filter((s) => !CONSUMER_RUN.test(s.run ?? "")); }],
    ["the whole job removed", (w) => { delete w.jobs[CHECK_JOB]; }],
    ["the tag job no longer needing it", (w) => { delete (w.jobs[TAG_JOB] as Job).needs; }],
    ["the tag job needing something else", (w) => { (w.jobs[TAG_JOB] as Job).needs = ["lint"]; }],
    ["the job excused by continue-on-error", (w) => { (w.jobs[CHECK_JOB] as Job)["continue-on-error"] = true; }],
    ["the job skipped by an if", (w) => { (w.jobs[CHECK_JOB] as Job).if = "false"; }],
    ["the public-interface step excused", (w) => { (w.jobs[CHECK_JOB]?.steps ?? []).find((s) => INTERFACE_RUN.test(s.run ?? ""))!["continue-on-error"] = true; }],
    ["the order reversed", (w) => { (w.jobs[CHECK_JOB] as Job).steps = [...(w.jobs[CHECK_JOB]?.steps ?? [])].reverse(); }],
    ["a11ign/a11ign not checked out", (w) => { (w.jobs[CHECK_JOB] as Job).steps = (w.jobs[CHECK_JOB]?.steps ?? []).filter((s) => s.with?.["repository"] !== "a11ign/a11ign"); }],
    ["A11IGN_CHECKOUT unset, so the reading would skip and stay green", (w) => { delete (w.jobs[CHECK_JOB]?.steps ?? []).find((s) => CONSUMER_RUN.test(s.run ?? ""))!.env; }],
    ["A11IGN_CHECKOUT naming a path the checkout is not at", (w) => { (w.jobs[CHECK_JOB]?.steps ?? []).find((s) => CONSUMER_RUN.test(s.run ?? ""))!.env = { A11IGN_CHECKOUT: "/elsewhere" }; }],
  ];
  for (const [what, mutate] of mutants) {
    const broken = structuredClone(REAL);
    mutate(broken);
    assert.notDeepEqual(orderProblems(broken), [], `${what}: not refused`);
  }
});
