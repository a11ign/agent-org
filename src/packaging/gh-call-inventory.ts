// #4505 PHASE 0 (agent-org#485): THE INVENTORY OF EVERY GITHUB-SPECIFIC CALL THE GATE AND ITS NEIGHBOURS MAKE, GENERATED SO IT CANNOT GO STALE.
//
// A ticket port (D1b) is cut against a list, and a hand-written list is wrong the week after it is written. So `docs/gh-call-inventory.json` is
// what this file prints, and `gh-call-inventory.test.ts` fails when the committed copy differs from a fresh scan. Rewrite it with
//
//     node --import tsx src/packaging/gh-call-inventory.ts
//
// WHAT A "CALL" IS HERE: a CALL SITE IN THE SOURCE, never a runtime call. A loop over rows is one site; a helper called from nine places is nine. The
// numbers are for sizing the port, and they say nothing about how many requests a tick spends (`GH_READS` in `work-gate.ts` is that table).
//
// WHAT IS READ, AND HOW: the TypeScript AST, so a `gh` named in a comment or a string is not a spawn. Three facts per file that spawns `gh`:
//   - `calls`: a SHAPE (`issue list`, `api graphql`, ...) is an array literal whose first element is a `gh` command and whose second is one of that
//     command's subcommands. It is counted wherever it sits in the file, because most files spawn through a one-line wrapper (`const gh = (args) =>
//     execFileSync("gh", args)`) and write the arguments at the wrapper's call sites. `spawns` is the number of spawn sites that name `gh` literally.
//   - `labels`: a label named as state, through a label constant (`READY_LABEL`, `ANSWER_PREFIX`, ...) or as the argument of a label flag
//     (`--label x`, `--add-label=x`). READ AND WRITE ARE NOT TOLD APART: that needs the data flow, and a guess would be a number nobody can check.
//   - `parsesCloses`: the file holds a regular expression, or a `RegExp` source, that names `Closes`, or reads `CLOSES_FIELD`. A file that calls a parser in another file is not followed.
// A file is listed when it names the command at a spawn site (`spawns` > 0) or holds a shape: 30 files write their arguments and hand them to a runner
// injected from another file, so a search for the literal command alone would leave out calls the port must cover. A file that spawns with its arguments
// built in another file has `spawns` and no shapes, which is a fact about the file and not a gap to be hidden.
//
// SCOPE: every non-test `.ts` and `.mjs` under `src/`, except `fixtures/` (test data some tests copy into a temporary tree; one spawns `gh` on purpose,
// and a port is not cut against it). Shell scripts are outside it, and `host-units.ts`'s `shellSpawnsGh` is the reader for them.
//
// WHICH TREE IS SCANNED: this repository's own. The gate lays the tool under a project and then rsyncs the project's helpers INTO `src/packaging/`
// (`ci.yml`, `--ignore-existing`), so a walk of the laid-out copy counts files that are not this repository's and the committed file would differ
// between a checkout and the gate. `AGENT_ORG_TOOL_REPO` names the checkout the copy came from (`mjs-ratchet.test.ts` judges it for the same reason),
// and `judgedRoot` is that tree where it is set. It is NOT a list of names to skip: the helpers' set moves with the pinned layer.
//
// THE DETECTOR THAT FILES A ROW WHEN A NEW DIRECT CALL APPEARS OUTSIDE THE ADAPTER IS NOT HERE: "outside the adapter" needs the adapter (D1b).
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The tree this file sits in: a checkout, or the gate's laid-out copy of one. */
export const REPO_ROOT = join(HERE, "..", "..");
export const INVENTORY_PATH = "docs/gh-call-inventory.json";

/** The tree the inventory describes: the checkout `env[TOOL_REPO_ENV]` names where the gate set it, else the tree this file sits in. */
export function judgedRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[TOOL_REPO_ENV] || REPO_ROOT;
}

/** Directories the scan does not enter. `fixtures` is test data, not a call the product makes. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", "fixtures"]);

const TEST_FILE = /\.test\.(?:ts|mjs)$/;
const SOURCE_FILE = /\.(?:ts|mjs)$/;

/** The command `gh` is spawned as. The one place the word is compared against. */
const GH_COMMAND = "gh";

/**
 * The subcommands that make `gh <command> <subcommand>` a shape. A closed list, because an array that starts `["run", ...]` is as likely to be
 * `pnpm run` as `gh run`, and only the second element settles it. `api` has no subcommand: it is `api graphql` or `api rest`.
 */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(Object.entries({
  issue: "list view create edit comment close reopen develop status transfer delete lock unlock pin unpin",
  pr: "list view create edit comment close reopen merge ready checks diff review status checkout update-branch",
  label: "list create edit delete clone",
  run: "list view watch rerun download cancel delete",
  release: "list view create upload download delete edit",
  workflow: "list view run enable disable",
  repo: "view list create edit clone fork delete sync",
  project: "list view item-list item-add item-edit item-create item-delete field-list create edit close",
  search: "issues prs repos commits code",
  auth: "status token login refresh",
  cache: "list delete",
  secret: "list set delete",
  variable: "list get set delete",
  ruleset: "list view check",
}).map(([command, words]) => [command, words.split(" ")])));

/** `--label x`, `--add-label x`, `--remove-label x` and the `=` spellings: the flags whose argument is a label name. */
const LABEL_FLAG = /^--(?:add-|remove-)?label(?:=(.*))?$/;

/**
 * The names that make a constant a LABEL constant: `READY_LABEL`, `CLASS_LABEL_PREFIX`, and the four prefixes `project-vocabulary.ts` reads from
 * `.agent-org/project.json` (`LANE_PREFIX`, `SESSION_PREFIX`, `ANSWER_PREFIX`) and `HOLD_PREFIX`. By NAME, because those prefixes are not literals
 * in the source, so a vocabulary read from literal values alone would drop three of the five commonest.
 */
const LABEL_CONSTANT = /(?:^|_)LABEL(?:S)?(?:_PREFIX)?$|^(?:LANE|SESSION|ANSWER|HOLD)_PREFIX$/;

export type FileEntry = {
  /** The number of spawn sites that name `gh` as their command, literally. */
  spawns: number;
  /** Shape to the number of array literals of that shape in the file. */
  calls: Record<string, number>;
  /** Label constants the file references and label-flag arguments it writes, sorted. */
  labels: string[];
  /** Whether the file holds a regular expression that names `Closes`. */
  parsesCloses: boolean;
};

export type CauseEntry = {
  group: string;
  /** Files in the inventory that name this cause as a string literal: where an order for it is built or read. Their entries are the lookup. */
  namedIn: string[];
};

export type Inventory = {
  generatedBy: string;
  summary: { files: number; spawns: number; calls: number; shapes: Record<string, number> };
  files: Record<string, FileEntry>;
  causes: Record<string, CauseEntry>;
};

/** Every non-test source file under `root/src`, as `src/...` paths with forward slashes, sorted so the output does not depend on the directory order. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(join(root, "src"));
  return found.sort();
}

function parse(root: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
}

const isString = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** `gh <command> <subcommand>` for an array literal that is one, else null. */
function shapeOf(array: ts.ArrayLiteralExpression): string | null {
  const [first, second] = array.elements;
  if (first === undefined || !isString(first)) return null;
  if (first.text === "api") {
    const early = array.elements.slice(1, 4);
    return early.some((element) => isString(element) && element.text === "graphql") ? "api graphql" : "api rest";
  }
  const known = SUBCOMMANDS[first.text];
  if (known === undefined || second === undefined || !isString(second) || !known.includes(second.text)) return null;
  return `${first.text} ${second.text}`;
}

/** The label names this array names through a label flag, as literals; the `=` spelling in one element or the value in the next. */
function flaggedLabels(array: ts.ArrayLiteralExpression): string[] {
  const out: string[] = [];
  const elements = array.elements;
  elements.forEach((element, index) => {
    if (!isString(element)) return;
    const flag = LABEL_FLAG.exec(element.text);
    if (flag === null) return;
    if (flag[1] !== undefined) {
      if (flag[1] !== "") out.push(flag[1]);
      return;
    }
    const value = elements[index + 1];
    if (value !== undefined && isString(value) && value.text !== "" && !value.text.startsWith("-")) out.push(value.text);
  });
  return out;
}

/** The first argument is the literal command `gh`: a spawn, however the callee is spelled (`execFileSync`, `spawnSync`, `run`, `guardedRunner`). */
function spawnsGh(call: ts.CallExpression): boolean {
  const [first] = call.arguments;
  return first !== undefined && isString(first) && first.text === GH_COMMAND;
}

/** A regular expression literal, or the source of a `RegExp`, that names `Closes`; and `project-vocabulary.ts`'s name for the field the declaration reads. */
const NAMES_CLOSES = /\bcloses?\b|clos\(es\)/i;
const CLOSES_FIELD = "CLOSES_FIELD";

function readFile(root: string, file: string): FileEntry {
  const source = parse(root, file);
  const entry: FileEntry = { spawns: 0, calls: {}, labels: [], parsesCloses: false };
  const labels = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (spawnsGh(node)) entry.spawns += 1;
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "RegExp") {
        const [pattern] = node.arguments;
        if (pattern !== undefined && NAMES_CLOSES.test(pattern.getText(source))) entry.parsesCloses = true;
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const [pattern] = node.arguments ?? [];
      if (pattern !== undefined && NAMES_CLOSES.test(pattern.getText(source))) entry.parsesCloses = true;
    } else if (ts.isArrayLiteralExpression(node)) {
      const shape = shapeOf(node);
      if (shape !== null) entry.calls[shape] = (entry.calls[shape] ?? 0) + 1;
      for (const name of flaggedLabels(node)) labels.add(name);
    } else if (ts.isRegularExpressionLiteral(node)) {
      if (NAMES_CLOSES.test(node.text)) entry.parsesCloses = true;
    } else if (ts.isIdentifier(node)) {
      if (LABEL_CONSTANT.test(node.text)) labels.add(`$${node.text}`);
      if (node.text === CLOSES_FIELD) entry.parsesCloses = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  entry.labels = [...labels].sort();
  entry.calls = Object.fromEntries(Object.entries(entry.calls).sort(([a], [b]) => a.localeCompare(b)));
  return entry;
}

/** A file makes `gh` calls when a spawn site names `gh`, or when it holds a shape: a runner injected from another file does the spawning there. */
const makesGhCalls = (entry: FileEntry): boolean => entry.spawns > 0 || Object.keys(entry.calls).length > 0;

/**
 * The causes `src/cause-declaration.ts` declares, by name and group, read off its `declareCause("name", GROUPS.X, ...)` calls rather than by importing
 * it: that module reads `.agent-org/project.json` and loads a plugin when it is evaluated, which a scan must not do. A declaration carries no event
 * field, so the lookup is the files that name the cause.
 */
function declaredCauses(root: string): { cause: string; group: string }[] {
  let source: ts.SourceFile;
  try {
    source = parse(root, "src/cause-declaration.ts");
  } catch {
    return [];
  }
  const found: { cause: string; group: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "declareCause") {
      const [name, group] = node.arguments;
      if (name !== undefined && isString(name) && group !== undefined && ts.isPropertyAccessExpression(group)) {
        found.push({ cause: name.text, group: group.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every string literal in a file, as a set, for "does this file name that cause". */
function literalsOf(root: string, file: string): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isString(node)) out.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parse(root, file));
  return out;
}

/** The inventory of the tree at `root`, built in memory. Pure in `root`: it reads files and writes none. */
export function buildInventory(root: string = REPO_ROOT): Inventory {
  const files: Record<string, FileEntry> = {};
  for (const file of sourceFiles(root)) {
    const entry = readFile(root, file);
    if (makesGhCalls(entry)) files[file] = entry;
  }
  const shapes: Record<string, number> = {};
  let spawns = 0;
  let calls = 0;
  for (const entry of Object.values(files)) {
    spawns += entry.spawns;
    for (const [shape, count] of Object.entries(entry.calls)) {
      shapes[shape] = (shapes[shape] ?? 0) + count;
      calls += count;
    }
  }
  const ordered = Object.fromEntries(Object.entries(shapes).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
  const declared = declaredCauses(root);
  const causes: Record<string, CauseEntry> = {};
  const literals = new Map(Object.keys(files).map((file) => [file, literalsOf(root, file)] as const));
  for (const { cause, group } of declared) {
    causes[cause] = {
      group,
      namedIn: Object.keys(files).filter((file) => file !== "src/cause-declaration.ts" && literals.get(file)?.has(cause)),
    };
  }
  return {
    generatedBy: "src/packaging/gh-call-inventory.ts",
    summary: { files: Object.keys(files).length, spawns, calls, shapes: ordered },
    files,
    causes,
  };
}

/** The committed file's text for an inventory: two-space JSON and a final newline, so a diff reads. */
export function render(inventory: Inventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

/** Rewrites the committed file from the tree this file sits in: a developer's action, in a checkout, so `AGENT_ORG_TOOL_REPO` is not read. */
function main(): void {
  const inventory = buildInventory(REPO_ROOT);
  writeFileSync(join(REPO_ROOT, INVENTORY_PATH), render(inventory));
  console.log(`${INVENTORY_PATH}: ${inventory.summary.files} files, ${inventory.summary.spawns} spawn sites, ${inventory.summary.calls} shapes counted`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
