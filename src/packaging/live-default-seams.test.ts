/**
 * #1401: NO TEST REACHES A LIVE DEFAULT SEAM UNINJECTED -- a tree-wide guard over every script and every test.
 *
 * A script exports a function whose spawn dependency DEFAULTS to a real call (`{ run = defaultRun }`), and a test
 * calls it without injecting that dependency, so every local suite run performs the real call. On 2026-09-13 that
 * shape was a live Project 2 write (#1400) and five read-only spends of the shared pools (#1405-#1409): worker-capture's
 * census counted 31 `gh` calls from one `npm run test:ts`. All six were fixed that night, and the census at `b79efddb`
 * read 0. This guard is what keeps it at 0.
 *
 * ## What it computes -- from the TypeScript AST, never from a list of seam names
 *
 * The row filed 66 matches of eight seam names. A name list cannot say what a default CALLS, and it missed every
 * seam spelled differently. So, for every `scripts/**` `.mjs` and every test file:
 * - **Seams:** every defaulted spawn dependency -- a destructured `{ run = defaultRun }`, a positional
 *   `(args, run = defaultRun)`, a body default `const { run = defaultRun } = deps`, and a plain alias
 *   `const run = defaultRun`, which no caller can inject at all. The default must resolve to a module function that
 *   spawns something.
 * - **Liveness:** a function spends `gh` through a name when it calls that name with `"gh"`, is itself a `gh`
 *   helper, or hands the name on (as a property, a shorthand or a positional argument) to a function that spends
 *   `gh` through what it receives. Propagated to a fixpoint over EVERY module function, because an undefaulted
 *   helper such as `fetchPRHeadRefPage({ run, page })` otherwise hides every seam that feeds it.
 * - **Carriers:** a module function that calls a live seam's function without injecting it, so the live default
 *   fires beneath it. A test cannot inject through a carrier.
 * - **Findings:** a test call to a live seam's function that does not inject it, or any test call to a carrier.
 *
 * **A11-279: the machine.** `gh` is not the only real call a default can make. A test that switched a plugin off reached
 * `writePlan`'s `deps.outgoing ?? loadOutgoing`; `loadOutgoing` builds `realPluginDeps`, whose `exec` ran the real
 * `tailscale`, and the agents host's live serves went off. So a function that calls a live root (`realPluginDeps`,
 * `realExec`, `realExecAsync`), or a module function that does, is a MACHINE default, and two seams are read for it:
 * every shape above whose default is one, and a nullish default read off a positional parameter
 * (`deps.outgoing ?? loadOutgoing`). A machine seam is live by what it defaults to; the gh seams stay live by what they spend.
 *
 * Measured at `27c9621c` (#1401, comment 5656304055), over the whole product tree: 147 defaulted spawn seams, 63 live, 36
 * carriers, 266 test calls to live seams or carriers, 0 findings. Four passes were needed, each finding a population the
 * previous one could not see; the planted fixture below holds every shape they found.
 *
 * PORTED from a11ign/a11ign `packages/lab/src/packaging/` at 95cb57e33 (a11ign/a11ign#3106), where the tool's `.mjs` were walked as
 * `packages/agent-org/src` and stopped being walked when the tool left. It walks this tool's `src/` now. Measured at the port (the
 * tool at agent-org `main` f03041e, by calling `liveSeamFindings` on `toolSources()`/`toolTests()`): 179 defaulted spawn seams,
 * 51 live, 30 carriers, 123 test calls to live seams or carriers examined, 0 findings.
 *
 * ## What it cannot see -- named, so a clean result is not read as more than it is
 *
 * 1. **A test that runs a script as a subprocess.** Calls inside the child are invisible to an AST. The whole-suite
 *    census behind a logging `gh` shim covers those; the stranded-branches CLI tests are the shape (#1430).
 * 2. **A default destructured from a rest element**, as in `withBoardSnapshot`'s
 *    `const { run = defaultRun } = snapshotDeps` where `snapshotDeps` is `...snapshotDeps` of `deps`
 *    (`board-snapshot.ts`). The body-default rule reads only a destructure of a parameter.
 * 3. **A call through a renamed local** (`const f = imported; f()`), a dynamic `import()`, or a package-specifier
 *    import. Imports are resolved by relative path only.
 * 4. **An injected value that is itself live**, such as a test passing `{ run: defaultRun }` it imported.
 * 5. **A nullish default read off anything but a positional parameter**, such as `pluginsApi`'s `seam.deps ?? ...`, where
 *    `seam` is destructured from its options. The refusal in `realExec` (`src/plugins/real-seams.ts`) is what stops a
 *    test that reaches `tailscale` that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { toolSources, toolTests } from "./tool-source.ts";

/** The one command name this guard is about, assembled so this file's own text never spells a spawn of it. */
const GH = ["g", "h"].join("");
/** The fixture's local-only command, assembled for the same reason: `git-spawn-classification.test.ts` reads a
 *  spelled `x("git", ...)` in this file's text as a real unscrubbed git spawn, and this file spawns nothing. */
const GIT = ["g", "i", "t"].join("");

type Source = { path: string; text: string };
type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Functions = Map<string, { node: FunctionLike; exported: boolean }>;
type Module = { file: string; sf: ts.SourceFile; fns: Functions };
type Seam = {
  file: string; fn: string; line: number; key: string; dflt: string;
  shape: "destructured" | "positional" | "body-destructured" | "alias" | "nullish"; index?: number; live?: boolean;
  /** What the default reaches: `gh` through a spawn (live when it spends it), or the machine through a live root (always live). */
  reach: "gh" | "machine";
};
type Carrier = { file: string; fn: string; calls: string; key: string };
type Finding = { test: string; line: number; fn: string; via: string };

const parse = (source: Source) => ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true,
  source.path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
const hasExportModifier = (node: ts.Node) =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
const isFunctionLike = (n: ts.Node): n is FunctionLike =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const identifierText = (n: ts.Node | undefined) => (n !== undefined && ts.isIdentifier(n) ? n.text : null);

/** The calls that reach the machine itself: the real plugin deps, and the real `exec` they carry (A11-279). */
const LIVE_ROOTS = new Set(["realPluginDeps", "realExec", "realExecAsync"]);

function callsUnder(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node) => { if (ts.isCallExpression(n)) out.push(n); ts.forEachChild(n, walk); };
  walk(node);
  return out;
}

/** Visits every node of a function's own body, not descending into nested functions. */
function eachOwnNode(fn: FunctionLike, visit: (n: ts.Node) => void): void {
  const walk = (n: ts.Node) => { visit(n); if (!isFunctionLike(n)) ts.forEachChild(n, walk); };
  if (fn.body) ts.forEachChild(fn.body, walk);
}

/** Names listed in `export { a, b }` statements. */
function exportListNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const e of st.exportClause.elements) names.add((e.propertyName ?? e.name).text);
  }
  return names;
}

/** A module's top-level callables, by name: function declarations and `const x = (...) =>` / function expressions. */
function topLevel(sf: ts.SourceFile): Functions {
  const listed = exportListNames(sf);
  const out: Functions = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) {
      out.set(st.name.text, { node: st, exported: hasExportModifier(st) || listed.has(st.name.text) });
    }
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const name = identifierText(d.name);
      if (name === null || !d.initializer || !isFunctionLike(d.initializer)) continue;
      out.set(name, { node: d.initializer, exported: hasExportModifier(st) || listed.has(name) });
    }
  }
  return out;
}

/** What a helper spawns: the literal command, "generic" when the command is its argument, or null for none. */
function spawnKind(fn: FunctionLike): string | null {
  let kind: string | null = null;
  for (const c of callsUnder(fn)) {
    if (!/^(execFileSync|execSync|spawnSync|spawn|execFile)$/.test(c.expression.getText())) continue;
    const first = c.arguments[0];
    kind = first && ts.isStringLiteralLike(first) && kind !== "generic" ? first.text : "generic";
  }
  return kind;
}

const bindingNames = (pattern: ts.ObjectBindingPattern) =>
  pattern.elements.map((e) => identifierText(e.name)).filter((n): n is string => n !== null);

/** Every name a function can spend a spawn through: its parameters and its own local bindings. */
function namesIn(fn: FunctionLike): string[] {
  const names = fn.parameters.flatMap((p) => (ts.isObjectBindingPattern(p.name) ? bindingNames(p.name)
    : ts.isIdentifier(p.name) ? [p.name.text] : []));
  eachOwnNode(fn, (n) => {
    if (!ts.isVariableDeclaration(n)) return;
    if (ts.isIdentifier(n.name)) names.push(n.name.text);
    if (ts.isObjectBindingPattern(n.name)) names.push(...bindingNames(n.name));
  });
  return [...new Set(names)];
}

const passesKeyByName = (arg: ts.Expression, key: string) => ts.isObjectLiteralExpression(arg)
  && arg.properties.some((p) => ts.isSpreadAssignment(p)
    || ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === key));

/** Does `call` inject `seam`? A positional seam by its argument; an alias never; otherwise by key or a spread. */
function injects(call: ts.CallExpression, seam: Seam): boolean {
  if (seam.shape === "alias") return false;
  if (seam.shape === "positional") return call.arguments.length > (seam.index ?? 0);
  if (seam.shape === "nullish") {
    const arg = call.arguments[seam.index ?? 0];
    return arg !== undefined && (ts.isSpreadElement(arg) || /^(deps|options|opts)$/.test(identifierText(arg) ?? "") || passesKeyByName(arg, seam.key));
  }
  return call.arguments.some((a) => ts.isSpreadElement(a) || /^(deps|options|opts)$/.test(identifierText(a) ?? "")
    || passesKeyByName(a, seam.key));
}

/** The elements of a destructuring pattern whose default names a spawning function, as seams of the given shape. */
function destructuredSeams(mod: Module, fn: string, elements: ts.NodeArray<ts.BindingElement>, reachOf: ReachOf,
  shape: Seam["shape"]): Seam[] {
  const seams: Seam[] = [];
  for (const el of elements) {
    const dflt = identifierText(el.initializer);
    const key = identifierText(el.name);
    const reach = dflt === null ? null : reachOf(dflt);
    if (dflt === null || key === null || reach === null) continue;
    seams.push({ file: mod.file, fn, line: lineOf(mod.sf, el), key, dflt, shape, reach });
  }
  return seams;
}

/** What a default named `name` reaches: the machine through a live root, `gh` (or any program) through a module function that spawns, or nothing (null). */
type ReachOf = (name: string) => Seam["reach"] | null;

/** Seams declared in a function's parameter list: positional defaults and destructured defaults. */
function parameterSeams(mod: Module, fn: string, node: FunctionLike, reachOf: ReachOf): Seam[] {
  const seams: Seam[] = [];
  node.parameters.forEach((p, index) => {
    const dflt = identifierText(p.initializer);
    const reach = dflt === null ? null : reachOf(dflt);
    if (ts.isIdentifier(p.name) && dflt !== null && reach !== null) {
      seams.push({ file: mod.file, fn, line: lineOf(mod.sf, p), key: p.name.text, dflt, shape: "positional", index, reach });
    }
    if (!ts.isObjectBindingPattern(p.name)) return;
    seams.push(...destructuredSeams(mod, fn, p.name.elements, reachOf, "destructured"));
  });
  return seams;
}

/** Seams declared in a function's body: a default destructured from a parameter, and a plain alias. */
function bodySeams(mod: Module, fn: string, node: FunctionLike, reachOf: ReachOf): Seam[] {
  const seams: Seam[] = [];
  const params = node.parameters.map((p) => identifierText(p.name)).filter((n): n is string => n !== null);
  eachOwnNode(node, (n) => {
    if (!ts.isVariableDeclaration(n)) return;
    const source = identifierText(n.initializer);
    if (source === null) return;
    const reach = reachOf(source);
    if (ts.isIdentifier(n.name) && reach !== null) {
      seams.push({ file: mod.file, fn, line: lineOf(mod.sf, n), key: n.name.text, dflt: source, shape: "alias", reach });
    }
    if (!ts.isObjectBindingPattern(n.name) || !params.includes(source)) return;
    seams.push(...destructuredSeams(mod, fn, n.name.elements, reachOf, "body-destructured"));
  });
  return seams;
}

/** Whether `expression` is, or calls, something that reaches the machine: a live root, or a module function in `machine`. */
function reachesMachine(expression: ts.Expression, machine: Set<string>): boolean {
  const name = identifierText(expression);
  if (name !== null) return LIVE_ROOTS.has(name) || machine.has(name);
  const calls = ts.isCallExpression(expression) ? [expression, ...callsUnder(expression)] : callsUnder(expression);
  return calls.some((c) => LIVE_ROOTS.has(c.expression.getText()) || machine.has(c.expression.getText()));
}

/** A11-279: `<positional parameter>.<key> ?? <machine default>` in a function's own body, the shape `writePlan`'s `deps.outgoing ?? loadOutgoing` is. */
function nullishSeams(mod: Module, fn: string, node: FunctionLike, machine: Set<string>): Seam[] {
  const seams: Seam[] = [];
  const params = node.parameters.map((p) => identifierText(p.name));
  eachOwnNode(node, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken || !ts.isPropertyAccessExpression(n.left)) return;
    const index = params.indexOf(identifierText(n.left.expression));
    if (index < 0 || !reachesMachine(n.right, machine)) return;
    seams.push({ file: mod.file, fn, line: lineOf(mod.sf, n), key: n.left.name.text, dflt: n.right.getText(), shape: "nullish", index, reach: "machine" });
  });
  return seams;
}

/** The module's functions that reach the machine: each that calls a live root, or a module function that does, to a fixpoint. */
function machineFunctions(mod: Module): Set<string> {
  const machine = new Set<string>();
  let grew = true;
  while (grew) {
    const added = [...mod.fns].filter(([fn, { node }]) => !machine.has(fn)
      && callsUnder(node).some((c) => LIVE_ROOTS.has(c.expression.getText()) || machine.has(c.expression.getText()))).map(([fn]) => fn);
    for (const fn of added) machine.add(fn);
    grew = added.length > 0;
  }
  return machine;
}

function seamsOf(mod: Module): Seam[] {
  const machine = machineFunctions(mod);
  const reachOf: ReachOf = (name) => (LIVE_ROOTS.has(name) || machine.has(name) ? "machine"
    : mod.fns.has(name) && spawnKind(mod.fns.get(name)!.node) !== null ? "gh" : null);
  return [...mod.fns].flatMap(([fn, { node }]) =>
    [...parameterSeams(mod, fn, node, reachOf), ...bodySeams(mod, fn, node, reachOf), ...nullishSeams(mod, fn, node, machine)]);
}

const spendKey = (file: string, fn: string, name: string) => `${file}::${fn}::${name}`;

/** The names a function spends GH through directly: all of them for a GH helper, else each name it calls with GH. */
function directlySpendingNames(node: FunctionLike): string[] {
  if (spawnKind(node) === GH) return namesIn(node);
  const ghCalls = callsUnder(node).filter((c) => c.arguments[0] !== undefined
    && ts.isStringLiteralLike(c.arguments[0]) && c.arguments[0].text === GH).map((c) => c.expression.getText());
  return namesIn(node).filter((name) => ghCalls.includes(name));
}

/** The first pass: names a function calls with GH, and every name of a function that is itself a GH helper. */
function directSpends(modules: Module[]): Set<string> {
  return new Set(modules.flatMap(({ file, fns }) => [...fns].flatMap(([fn, { node }]) =>
    directlySpendingNames(node).map((name) => spendKey(file, fn, name)))));
}

/** The names `callee` receives when `call` hands it `name`: as a property or shorthand, or positionally. */
function namesReceived(call: ts.CallExpression, name: string, callee: FunctionLike): string[] {
  const byProperty = call.arguments.flatMap((a) => (ts.isObjectLiteralExpression(a) ? [...a.properties] : []))
    .filter((p) => (ts.isShorthandPropertyAssignment(p) && p.name.text === name)
      || (ts.isPropertyAssignment(p) && identifierText(p.initializer) === name))
    .map((p) => (p as ts.ShorthandPropertyAssignment | ts.PropertyAssignment).name.getText());
  const index = call.arguments.findIndex((a) => identifierText(a) === name);
  const byPosition = identifierText(callee.parameters[index]?.name);
  return byPosition === null || index < 0 ? byProperty : [...byProperty, byPosition];
}

/** Does `node` hand `name` on to a module function that spends GH through what it receives? */
function handsOnToSpender(mod: Module, node: FunctionLike, name: string, spends: Set<string>): boolean {
  return callsUnder(node).some((c) => {
    const callee = c.expression.getText();
    const target = mod.fns.get(callee);
    if (!target) return false;
    const received = namesReceived(c, name, target.node);
    return received.some((r) => spends.has(spendKey(mod.file, callee, r)));
  });
}

/** One propagation pass over every module function; true when it added a spending name. */
function propagateOnce(modules: Module[], spends: Set<string>): boolean {
  const added = modules.flatMap((mod) => [...mod.fns].flatMap(([fn, { node }]) => namesIn(node)
    .filter((name) => !spends.has(spendKey(mod.file, fn, name)) && handsOnToSpender(mod, node, name, spends))
    .map((name) => spendKey(mod.file, fn, name))));
  for (const key of added) spends.add(key);
  return added.length > 0;
}

/** Propagates spending through hand-offs, to a fixpoint over every module function. */
function propagateSpends(modules: Module[], spends: Set<string>): Set<string> {
  while (propagateOnce(modules, spends)) { /* each pass may unlock another; stop when one adds nothing */ }
  return spends;
}

/** Callers in the same module that call a live seam's function without injecting it. */
function findCarriers(modules: Map<string, Module>, live: Seam[]): Carrier[] {
  return live.flatMap((seam) => [...modules.get(seam.file)!.fns]
    .filter(([fn, { node }]) => fn !== seam.fn
      && callsUnder(node).some((c) => c.expression.getText() === seam.fn && !injects(c, seam)))
    .map(([fn]) => ({ file: seam.file, fn, calls: seam.fn, key: seam.key })));
}

/** A test's relative named imports: local name -> the repo-relative file and exported name. */
function importsOf(sf: ts.SourceFile, testPath: string): Map<string, { file: string; name: string }> {
  const imported = new Map<string, { file: string; name: string }>();
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const spec = (st as ts.ImportDeclaration).moduleSpecifier.getText().slice(1, -1);
    if (!spec.startsWith(".")) continue;
    const file = normalize(join(dirname(testPath), spec));
    for (const e of bindings.elements) imported.set(e.name.text, { file, name: (e.propertyName ?? e.name).text });
  }
  return imported;
}

/** Every test call to a live seam's function or a carrier, and which of them reach it uninjected. */
function findTestCalls(tests: Source[], live: Seam[], carriers: Carrier[]): { findings: Finding[]; examined: number } {
  const findings: Finding[] = [];
  let examined = 0;
  for (const t of tests) {
    const sf = parse(t);
    const imported = importsOf(sf, t.path);
    for (const c of callsUnder(sf)) {
      const target = imported.get(c.expression.getText());
      if (!target) continue;
      const seams = live.filter((s) => s.file === target.file && s.fn === target.name);
      const via = carriers.filter((k) => k.file === target.file && k.fn === target.name);
      examined += seams.length + via.length;
      for (const seam of seams.filter((s) => !injects(c, s))) {
        findings.push({ test: t.path, line: lineOf(sf, c), fn: seam.fn, via: `${seam.key} (${seam.shape})` });
      }
      for (const k of via) findings.push({ test: t.path, line: lineOf(sf, c), fn: k.fn, via: `carrier of ${k.calls}` });
    }
  }
  return { findings, examined };
}

/**
 * THE ANALYSIS, pure over the sources it is handed: every seam and whether it is live, every carrier, and every
 * test call that reaches a live seam without injecting it.
 */
export function liveSeamFindings({ scripts, tests }: { scripts: Source[]; tests: Source[] }) {
  const modules = new Map(scripts.map((s) => { const sf = parse(s); return [s.path, { file: s.path, sf, fns: topLevel(sf) }]; }));
  const list = [...modules.values()];
  const seams = list.flatMap(seamsOf);
  const spends = propagateSpends(list, directSpends(list));
  for (const seam of seams) {
    // A seam that spends gh is a gh seam, whatever else its default reaches, so the tree's "no live gh seam" assertion still sees it.
    const spendsGh = spends.has(spendKey(seam.file, seam.fn, seam.key));
    if (spendsGh) seam.reach = "gh";
    seam.live = spendsGh || seam.reach === "machine";
  }
  const live = seams.filter((s) => s.live);
  const carriers = findCarriers(modules, live);
  return { seams, live, carriers, ...findTestCalls(tests, live, carriers) };
}

/** The real tree: every `.mjs` of the tool's own source, and every test file of the tool. */
function realTree() {
  return { scripts: toolSources().filter((f) => /\.(mjs|ts)$/.test(f.path)), tests: toolTests() };
}

// --- THE PLANTED FIXTURE: every shape the four enumeration passes found, and one that must NOT count ---------------

const FIXTURE_SCRIPT = `
import { execFileSync } from "node:child_process";
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const ghHelper = (args, run = defaultRun) => run("${GH}", args);
export function readDirect({ run = defaultRun } = {}) { return run("${GH}", ["api", "x"]); }
function pageOf({ run, page }) { return run("${GH}", ["api", String(page)]); }
export function readThroughHelper({ run = defaultRun } = {}) { return pageOf({ run, page: 1 }); }
export function readPositional(deps = {}) { const { run = defaultRun } = deps; return ghHelper(["pr", "view"], run); }
export function readAliased() { const run = defaultRun; return run("${GH}", ["issue", "list"]); }
export function carrierOfDirect() { return readDirect(); }
export function localOnly({ run = defaultRun } = {}) { return run("${GIT}", ["status"]); }
`;
const FIXTURE_TEST = `
import { readDirect, readThroughHelper, readPositional, readAliased, carrierOfDirect, localOnly } from "../fixture-live.mjs";
readDirect();
readDirect({ run: () => "" });
readThroughHelper();
readPositional();
readPositional({ run: () => "" });
readAliased();
carrierOfDirect();
localOnly();
`;
const FIXTURE = {
  scripts: [{ path: "src/fixture-live.mjs", text: FIXTURE_SCRIPT }],
  tests: [{ path: "src/packaging/fixture-live.test.ts", text: FIXTURE_TEST }],
};

test("#1401 POSITIVE CONTROL: the planted fixture yields exactly its five uninjected live calls, and none of the rest", () => {
  const { findings, live } = liveSeamFindings(FIXTURE);
  assert.deepEqual(findings.map((f) => `${f.line}:${f.fn}`), [
    "3:readDirect",
    "5:readThroughHelper",
    "6:readPositional",
    "8:readAliased",
    "9:carrierOfDirect",
  ], "a bare direct call, one through an undefaulted helper, a body default handed on positionally, a non-injectable "
    + "alias, and a carrier -- while the injected calls (lines 4 and 7) and the git-only seam (line 10) are not findings");
  assert.ok(!live.some((s) => s.fn === "localOnly"), "a seam that only spawns git is not live");
});

// A11-279: a plan writer whose outgoing plugin defaults, through a nullish read of its deps, to one built on the real plugin deps; a writer whose default reaches nothing; and the real exec as a default.
const MACHINE_SCRIPT = `
import { realExec, realPluginDeps } from "./active.ts";
export async function loadOutgoing(plugin) { const deps = realPluginDeps({ env: process.env }); return plugin.release(deps); }
function quiet() { return null; }
export async function writePlan(plan, deps, confirmed) { const outgoing = await (deps.outgoing ?? loadOutgoing)(plan.leaves); return [outgoing, confirmed]; }
export function writeQuiet(plan, deps) { return (deps.outgoing ?? quiet)(plan); }
export function probe({ exec = realExec } = {}) { return exec("tailscale", ["status"]); }
`;
const MACHINE_TEST = `
import { writePlan, writeQuiet, probe } from "../fixture-machine.ts";
await writePlan(plan, { hostPath: "/x", log }, []);
await writePlan(plan, { hostPath: "/x", log, outgoing: async () => stub }, []);
writeQuiet(plan, { hostPath: "/x" });
probe();
probe({ exec: stub });
`;
const MACHINE_FIXTURE = {
  scripts: [{ path: "src/fixture-machine.ts", text: MACHINE_SCRIPT }],
  tests: [{ path: "src/packaging/fixture-machine.test.ts", text: MACHINE_TEST }],
};

test("A11-279 POSITIVE CONTROL: a nullish default to a function that builds the real plugin deps, and the real exec as a default, are found where a test reaches them uninjected", () => {
  const { findings, live } = liveSeamFindings(MACHINE_FIXTURE);
  assert.deepEqual(findings.map((f) => `${f.line}:${f.fn} ${f.via}`), ["3:writePlan outgoing (nullish)", "6:probe exec (destructured)"],
    "the uninjected writePlan and probe calls -- while the injected calls (lines 4 and 7) and the nullish default that reaches nothing (line 5) are not findings");
  assert.deepEqual(live.map((seam) => `${seam.fn} ${seam.key} ${seam.reach}`), ["writePlan outgoing machine", "probe exec machine"]);
});

test("#1401 THE LIVE ASSERTION: no test in the tree calls a live default seam without injecting it", () => {
  // The positive control that this can return a finding is the planted fixture test above; the controls that it
  // examined the real population are the named members in the next test. An empty list here is only evidence
  // with both of those green.
  // Since step 9 of A11-160 no file outside `plugins/github` spawns `gh` (`gh-call-ratchet.test.ts`), so the real tree holds no live default seam and nothing is examined: an empty population is the end state,
  // not a broken walk. What shows the walk can still find one is the planted fixture above, and what keeps a seam from coming back is the ratchet.
  // A machine seam (A11-279) may stay in the tree, as `writePlan`'s does: what must not is a test that reaches it uninjected, which the findings below hold to none.
  const { findings, live } = liveSeamFindings(realTree());
  assert.deepEqual(live.filter((seam) => seam.reach === "gh").map((seam) => `${seam.file} ${seam.fn}`), [], "a live default seam is back in the tree: a `gh` spawn belongs in plugins/github, behind the code host");
  assert.deepEqual(findings, [],
    `these test calls reach a live default seam without injecting it -- each performs a real ${GH} call, or reaches `
    + `this machine through the real plugin deps or exec, on every local run:\n  ${findings.map((f) => `${f.test}:${f.line} -> ${f.fn} (${f.via})`).join("\n  ")}`);
});

test("#1401 POPULATION CONTROL: named seams from the enumeration are classified as it found them", () => {
  const { live, seams } = liveSeamFindings(realTree());
  const isLive = (file: string, fn: string) => live.some((s) => s.file === file && s.fn === fn);
  const expectedLive: Array<[string, string, string]> = [
  ];
  for (const [file, fn, why] of expectedLive) assert.ok(isLive(file, fn), `${file} ${fn} should be live: ${why}`);
  assert.ok(seams.some((s) => s.file === "src/prune-worktrees.ts" && s.fn === "pruneWorktrees" && !s.live),
    "and a seam that spawns only git is collected but not live");
  assert.ok(live.some((s) => s.file === "src/plugins/cli.ts" && s.fn === "writePlan" && s.key === "outgoing" && s.shape === "nullish" && s.reach === "machine"),
    "A11-279: writePlan's `deps.outgoing ?? loadOutgoing`, the seam a test took the agents host's serves off through, is a live machine seam");
});
