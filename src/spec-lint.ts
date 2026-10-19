// A LEAF: `node:` builtins and relative imports only, and the one relative import is a TYPE. `org-retro.ts` imports this file, and `work-gate.ts`
// imports that before any `pnpm install`/build, so a package import here would break the gate on a fresh checkout. That is why the spec block
// is read by `parseSpec` below and not by `yaml`: `yaml` is a devDependency, which a published agent-org does not carry.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Question } from "./decision-provider.ts";

/**
 * THE SPEC LINT (a11ign#5117, the Haiku push). A build row carries ONE fenced `spec` block (a11ign#5109) and Haiku's success depends on what is in it:
 * missing detail costs a small model 3.3x against 1.6x for Sonnet, a written spec took it from 0/15 to 7/9, and a test oracle from 3/12 to 11/12. Sections being
 * PRESENT is not enough, so this refuses a spec whose CONTENT is vague, and names the FIELD, because a refusal that names no field cannot be acted on.
 *
 * Three halves, one file:
 *   1. {@link lintSpec} / {@link specLintRefusalReason}: DETERMINISTIC, and the only half that blocks. Same input, same answer, no model.
 *   2. {@link reviewSpec}: Jev's reading of "could an engineer who has never seen this repo build this from the spec alone?". It WARNS, never blocks.
 *   3. {@link underspecifiedReading}: the feedback loop. A worker that stops "underspecified" names the field; the daily retro counts by field.
 *
 * Behind `rows.specLint` in `.agent-org/project.json`, absent meaning OFF ({@link specLintFlagOf}). The caller asks the flag; nothing in this file reads it.
 */

// --- THE FLAG -----------------------------------------------------------------------------------------------------------------

export const SPEC_LINT_FLAG = "rows.specLint";

/**
 * `rows.specLint` of a project declaration's TEXT: on only when exactly `true`, so absent, unreadable and mistyped are all OFF. OFF is the flag's own meaning of
 * "I could not tell", because a lint that refuses promotions on a declaration it could not read would stop the board for a typo.
 */
export function specLintFlagOf(declarationText: string): boolean {
  try {
    return JSON.parse(declarationText)?.rows?.specLint === true;
  } catch {
    return false;
  }
}

// --- THE SPEC BLOCK, and a reader for the subset of YAML it is written in ----------------------------------------------------------

export type SpecValue = string | boolean | null | SpecValue[] | { [key: string]: SpecValue };
export type SpecMap = { [key: string]: SpecValue };
export type ParseResult = { ok: true; value: SpecValue } | { ok: false; line: number; reason: string };

type Line = { no: number; indent: number; text: string };
type Cursor = { lines: Line[]; at: number };

const SPEC_FENCE = /^```spec[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** The bodies of every fenced `spec` block in a row's body, in order. A row that carries more than one is refused by {@link lintRowBody}. */
export function specBlocksOf(body: string): string[] {
  return [...body.matchAll(SPEC_FENCE)].map((match) => match[1]);
}

/** The reader refuses what it cannot read: `line` is counted from the first line of the block. */
function refuse(line: number, reason: string): never {
  throw Object.assign(new Error(reason), { specLine: line });
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(#.*)?$/.test(raw)) return;
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes("\t")) refuse(index + 1, "a tab in the indentation; indent with spaces");
    lines.push({ no: index + 1, indent, text: raw.trim() });
  });
  return lines;
}

const KEY = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;
const isItem = (text: string): boolean => text === "-" || text.startsWith("- ");
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'\s*(?:#.*)?$/;

function quoted(text: string, no: number): string {
  const double = DOUBLE_QUOTED.exec(text);
  if (double !== null) {
    try {
      return JSON.parse(`"${double[1]}"`);
    } catch (cause) {
      throw Object.assign(new Error("a double-quoted value with an escape this reader cannot read", { cause }), { specLine: no });
    }
  }
  const single = SINGLE_QUOTED.exec(text);
  return single === null ? refuse(no, "a quoted value that is not closed on its line") : single[1].replace(/''/g, "'");
}

/** Splits a flow list's inside on the commas that are not inside a quote. */
function flowItems(inside: string): string[] {
  const items: string[] = [];
  let quote = "";
  let current = "";
  for (const char of inside) {
    if (quote === "" && char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    if (quote === "" && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = "";
    current += char;
  }
  return current.trim() === "" && items.length === 0 ? [] : [...items, current];
}

function flowList(text: string, no: number): SpecValue[] {
  if (!text.endsWith("]")) refuse(no, "a `[` list that does not close on its line; write one item per `- ` line");
  return flowItems(text.slice(1, -1)).map((item) => {
    if (/^\s*[[{]/.test(item)) refuse(no, "a list inside a flow list; write one item per `- ` line");
    return scalar(item, no);
  });
}

function scalar(raw: string, no: number): SpecValue {
  const text = raw.trim();
  if (text.startsWith("[")) return flowList(text, no);
  if (/^["']/.test(text)) return quoted(text, no);
  if (/^[{|>&*!%@`]/.test(text)) refuse(no, `a value starting with \`${text[0]}\`, which YAML reserves; write it as a quoted string`);
  const plain = text.replace(/\s+#.*$/, "");
  if (/:(\s|$)/.test(plain)) refuse(no, "a plain value containing `: `; quote it");
  if (plain === "true" || plain === "false") return plain === "true";
  return plain === "null" || plain === "~" ? null : plain;
}

function underItem(cur: Cursor, indent: number): SpecValue {
  const next = cur.lines[cur.at];
  return next !== undefined && next.indent > indent ? parseNode(cur, next.indent) : null;
}

/** Under `key:` a list MAY sit at the key's own indent, which is how YAML is usually written. */
function underKey(cur: Cursor, indent: number): SpecValue {
  const next = cur.lines[cur.at];
  return next !== undefined && next.indent === indent && isItem(next.text) ? parseSequence(cur, indent) : underItem(cur, indent);
}

function parseSequence(cur: Cursor, indent: number): SpecValue[] {
  const items: SpecValue[] = [];
  for (let line = cur.lines[cur.at]; line !== undefined && line.indent === indent && isItem(line.text); line = cur.lines[cur.at]) {
    const rest = line.text.slice(1).trimStart();
    if (rest === "") {
      cur.at += 1;
      items.push(underItem(cur, indent));
    } else if (KEY.test(rest)) {
      // `- key: v` opens a mapping whose later keys sit under `key`, so the item's line is read again as that mapping's first line.
      const inner = indent + (line.text.length - rest.length);
      cur.lines[cur.at] = { no: line.no, indent: inner, text: rest };
      items.push(parseMapping(cur, inner));
    } else {
      cur.at += 1;
      items.push(scalar(rest, line.no));
    }
  }
  return items;
}

function parseMapping(cur: Cursor, indent: number): SpecMap {
  const map: SpecMap = Object.create(null);
  for (let line = cur.lines[cur.at]; line !== undefined && line.indent === indent && !isItem(line.text); line = cur.lines[cur.at]) {
    const match = KEY.exec(line.text);
    if (match === null) refuse(line.no, `expected \`key: value\`, found \`${line.text}\`; quote a value that contains \`: \``);
    const [, key, rest = ""] = match as RegExpExecArray;
    if (Object.hasOwn(map, key)) refuse(line.no, `the key \`${key}\` appears twice`);
    cur.at += 1;
    map[key] = rest.trim() === "" || rest.trim().startsWith("#") ? underKey(cur, indent) : scalar(rest, line.no);
  }
  return map;
}

function parseNode(cur: Cursor, indent: number): SpecValue {
  return isItem(cur.lines[cur.at].text) ? parseSequence(cur, indent) : parseMapping(cur, indent);
}

/**
 * The block's text as a value. THE SUBSET: mappings, `- ` lists, plain and quoted scalars, `true`/`false`/`null`, one-line `[a, b]` lists, `#` comment lines.
 * No block scalars (`|`, `>`), anchors, tags, flow mappings or multiple documents: each is a `reason` naming its line, never a guess, because a spec
 * read wrongly and linted as clean is the one failure this file exists to prevent.
 */
export function parseSpec(text: string): ParseResult {
  try {
    const cur: Cursor = { lines: linesOf(text), at: 0 };
    if (cur.lines.length === 0) return { ok: false, line: 1, reason: "the block is empty" };
    const value = parseNode(cur, cur.lines[0].indent);
    if (cur.at < cur.lines.length) refuse(cur.lines[cur.at].no, "unexpected indentation");
    return { ok: true, value };
  } catch (error) {
    const line = (error as { specLine?: unknown }).specLine;
    if (typeof line !== "number") throw error;
    return { ok: false, line, reason: (error as Error).message };
  }
}

// --- THE LINT -----------------------------------------------------------------------------------------------------------------

/** The refusals the row names, one rule each. `unreadable`, `multiple-blocks` and `missing` are the structure the lint needs before it can ask any of them. */
export type Rule = "unreadable" | "multiple-blocks" | "missing" | "file-absent" | "no-assertion" | "run-not-executable" | "run-misses-tests"
  | "vague" | "too-many-files" | "too-many-subsystems" | "empty-out-of-scope";
export type Finding = { field: string; rule: Rule; message: string };
/** `findings` refuse. `unchecked` is what could not be ASKED (a checkout that is not there): it is reported and never refuses, and it is never folded into `findings`. */
export type LintResult = { findings: Finding[]; unchecked: Finding[] };

/** The three facts the lint asks the machine. `null` is "could not tell" in each, and is never read as `false`. */
export type LintDeps = {
  /** `path` may carry a Region-style `repo:` prefix. */
  fileExists: (path: string) => boolean | null;
  onPath: (executable: string) => boolean | null;
  /** Does `command` PARSE as shell, without running it. */
  shellParses: (command: string) => boolean | null;
};

/** More than this is a row to split: each file is a thing a worker must hold in mind, and the study's Haiku runs failed on breadth. */
export const MAX_FILES = 6;
export const MAX_SUBSYSTEMS = 1;

/** The fields a spec block has, in the order a reader meets them; also the vocabulary an "underspecified" stop names one from. */
export const SPEC_FIELDS = Object.freeze(["files", "tests.path", "tests.cases", "tests", "run", "out_of_scope", "errors", "examples"] as const);
/** `errors` and `examples` are VERBATIM output, so the vague-phrase scan leaves them alone: an `etc.` inside a pasted message is the message's. */
const VERBATIM_FIELDS = new Set(["errors", "examples"]);

const finding = (field: string, rule: Rule, message: string): Finding => ({ field, rule, message });

const isMap = (value: SpecValue | undefined): value is SpecMap => typeof value === "object" && value !== null && !Array.isArray(value);
const isBlank = (value: SpecValue | undefined): boolean => value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.length === 0);

type Listed = { field: string; path: string; isNew: boolean };
type Report = LintResult & { deps: LintDeps };

function listedFile(entry: SpecValue, field: string): Listed | null {
  if (typeof entry === "string" && entry.trim() !== "") return { field, path: entry.trim(), isNew: false };
  if (isMap(entry) && typeof entry.path === "string" && entry.path.trim() !== "") return { field, path: entry.path.trim(), isNew: entry.new === true };
  return null;
}

/** Every file the spec lists: `files:` and the tests path, each marked `new: true` or not. A malformed entry is a finding and not a silent drop. */
function listedFiles(spec: SpecMap, report: Report): Listed[] {
  const listed: Listed[] = [];
  if (isBlank(spec.files)) report.findings.push(finding("files", "missing", "`files:` is required: list the exact paths the worker may change"));
  else if (Array.isArray(spec.files)) {
    spec.files.forEach((entry, index) => {
      const field = `files[${index}]`;
      const one = listedFile(entry, field);
      if (one === null) report.findings.push(finding(field, "missing", "a file is a path, or a mapping with `path:` and optionally `new: true`"));
      else listed.push(one);
    });
  }
  else report.findings.push(finding("files", "missing", "`files:` must be a list of paths"));
  const tests = spec.tests;
  if (isMap(tests)) {
    const path = listedFile({ path: tests.path ?? null, new: tests.new ?? null }, "tests.path");
    if (path !== null) listed.push(path);
  }
  return listed;
}

function checkFilesExist(listed: Listed[], report: Report): void {
  for (const { field, path, isNew } of listed) {
    if (isNew) continue;
    const exists = report.deps.fileExists(path);
    if (exists === false) report.findings.push(finding(field, "file-absent", `\`${path}\` does not exist and is not marked \`new: true\``));
    else if (exists === null) report.unchecked.push(finding(field, "file-absent", `\`${path}\` could not be checked: no checkout of its repository was readable`));
  }
}

const REPO_PREFIX = /^([A-Za-z0-9_.-]+):(?!\/)/;

/**
 * The subsystem a path belongs to: its repository (a Region-style `repo:` prefix, else the row's own) and its top directory, two levels under `packages/`.
 * A test file and the source it tests are therefore one subsystem, and `.agent-org/roles/x.md` beside `agent-org:src/x.ts` are two: the split a row like that wants.
 */
export function subsystemOf(path: string): string {
  const repo = REPO_PREFIX.exec(path)?.[1] ?? "";
  const segments = path.replace(REPO_PREFIX, "").split("/");
  const top = segments.length === 1 ? "." : segments[0] === "packages" && segments.length > 2 ? `packages/${segments[1]}` : segments[0];
  return repo === "" ? top : `${repo}:${top}`;
}

function checkSize(listed: Listed[], report: Report): void {
  const paths = [...new Set(listed.map((one) => one.path))];
  if (paths.length > MAX_FILES) report.findings.push(finding("files", "too-many-files", `${paths.length} files listed; more than ${MAX_FILES} is a row to split`));
  const subsystems = [...new Set(paths.map(subsystemOf))];
  if (subsystems.length > MAX_SUBSYSTEMS) {
    report.findings.push(finding("files", "too-many-subsystems", `${subsystems.length} subsystems (${subsystems.join(", ")}); more than ${MAX_SUBSYSTEMS} is a row to split`));
  }
}

/** A `then` is an assertion only when it names a VALUE a test can compare: a quoted string, a code span, a number, or null/true/false/empty. */
const CONCRETE_VALUE = /`[^`]+`|"[^"]+"|'[^']+'|\b\d+\b|\b(?:null|undefined|true|false|empty)\b|\[\s*\]|\{\s*\}/i;

function checkCase(entry: SpecValue, index: number, report: Report): void {
  const base = `tests.cases[${index}]`;
  if (!isMap(entry)) {
    report.findings.push(finding(base, "missing", "a case is a mapping with `given:`, `when:` and `then:`"));
    return;
  }
  for (const part of ["given", "when", "then"] as const) {
    if (isBlank(entry[part])) report.findings.push(finding(`${base}.${part}`, "missing", `\`${part}:\` is required and is empty or absent`));
  }
  const then = entry.then;
  if (typeof then === "string" && then.trim() !== "" && !CONCRETE_VALUE.test(then)) {
    report.findings.push(finding(`${base}.then`, "no-assertion",
      "names no value, string, count or exit code a test could compare; write the exact assertion (`returns null`, `exit code 1`, a quoted message)"));
  }
}

function checkTests(spec: SpecMap, report: Report): void {
  const tests = spec.tests;
  if (!isMap(tests)) {
    report.findings.push(finding("tests", "missing", "`tests:` is required: the test file `path:` and the `cases:`"));
    return;
  }
  if (isBlank(tests.path)) report.findings.push(finding("tests.path", "missing", "`tests.path:` is required: the file the worker must make pass"));
  if (isBlank(tests.cases) || !Array.isArray(tests.cases)) {
    report.findings.push(finding("tests.cases", "missing", "`tests.cases:` is required: at least one case with `given`, `when` and a concrete `then`"));
    return;
  }
  tests.cases.forEach((entry, index) => checkCase(entry, index, report));
}

// --- the `run:` command --------------------------------------------------------------------------------------------------------

const SHELL_BUILTINS = new Set(["cd", "export", "set", "test", "[", "true", "false", "exit", "source", ".", "echo", "pushd", "popd", "unset", "time"]);
const MAX_SHELL_NESTING = 2;

/** The command split at the `&&`, `||`, `;`, `|` and newlines that are not inside a quote. */
function segmentsOf(command: string): string[] {
  const segments: string[] = [];
  let quote = "";
  let current = "";
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "" && (char === "'" || char === '"')) quote = char;
    else if (char === quote) quote = "";
    const operator = quote === "" ? /^(?:&&|\|\||;|\||\n)/.exec(command.slice(i))?.[0] : undefined;
    if (operator === undefined) {
      current += char;
    } else {
      segments.push(current);
      current = "";
      i += operator.length - 1;
    }
  }
  return [...segments, current].map((segment) => segment.trim()).filter((segment) => segment !== "");
}

const SHELL_C = /^(?:ba)?sh\s+-c\s+(['"])([\s\S]*)\1$/;

/** The executables a command line starts: every segment's first word after `VAR=value` prefixes, and the inside of `bash -c '...'`. Builtins are not executables. */
export function executablesOf(command: string, depth = 0): string[] {
  return segmentsOf(command).flatMap((segment) => {
    const words = segment.split(/\s+/).filter((word) => !/^\w+=/.test(word));
    const name = (words[0] ?? "").replace(/^\(+/, "");
    const inner = SHELL_C.exec(words.join(" "));
    const nested = inner !== null && depth < MAX_SHELL_NESTING ? executablesOf(inner[2], depth + 1) : [];
    return [...(name === "" || SHELL_BUILTINS.has(name) ? [] : [name]), ...nested];
  });
}

function checkRun(spec: SpecMap, report: Report): void {
  const run = spec.run;
  if (typeof run !== "string" || run.trim() === "") {
    report.findings.push(finding("run", "missing", "`run:` is required: the ONE command that runs the tests"));
    return;
  }
  if (run.trim().includes("\n")) report.findings.push(finding("run", "run-not-executable", "`run:` is ONE command; this one spans lines"));
  const parses = report.deps.shellParses(run);
  if (parses === false) report.findings.push(finding("run", "run-not-executable", "`run:` does not parse as a shell command"));
  else if (parses === null) report.unchecked.push(finding("run", "run-not-executable", "`run:` could not be parse-checked: no shell answered"));
  for (const name of new Set(executablesOf(run))) {
    const found = report.deps.onPath(name);
    if (found === false) report.findings.push(finding("run", "run-not-executable", `\`${name}\` is not an executable on this machine's PATH`));
    else if (found === null) report.unchecked.push(finding("run", "run-not-executable", `\`${name}\` could not be looked up`));
  }
  const tests = isMap(spec.tests) ? spec.tests.path : null;
  const named = typeof tests === "string" ? tests.replace(REPO_PREFIX, "") : "";
  if (named !== "" && !run.includes(named)) {
    report.findings.push(finding("run", "run-misses-tests", `\`run:\` never names \`${named}\`, so passing it proves nothing about those tests`));
  }
}

// --- vague words, and what is out of scope --------------------------------------------------------------------------------------

/**
 * The phrases the row names. `handle edge cases` is allowed when it is followed by a colon and the cases, which is what "without a list" means; the other
 * three are never a spec, because each stands where the thing itself should be.
 */
const VAGUE_PHRASES: readonly { name: string; pattern: RegExp }[] = Object.freeze([
  { name: "TBD", pattern: /\bTBD\b/i },
  { name: "etc.", pattern: /\betc\b\.?/i },
  { name: "as appropriate", pattern: /\bas appropriate\b/i },
  { name: "handle edge cases", pattern: /\bhandle (?:the |all )?edge[- ]cases?\b(?!\s*:\s*\S)/i },
]);

/** Every string in the value with the dotted/indexed path that names it. */
function stringsOf(value: SpecValue, path: string): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsOf(item, `${path}[${index}]`));
  if (isMap(value)) return Object.entries(value).flatMap(([key, item]) => stringsOf(item, path === "" ? key : `${path}.${key}`));
  return [];
}

function checkVague(spec: SpecMap, report: Report): void {
  for (const [path, text] of stringsOf(spec, "")) {
    if (VERBATIM_FIELDS.has(path.split(/[.[]/)[0])) continue;
    for (const { name, pattern } of VAGUE_PHRASES) {
      if (pattern.test(text)) report.findings.push(finding(path, "vague", `says "${name}" and names nothing; list the items, or say what is out of scope`));
    }
  }
}

function checkScope(spec: SpecMap, report: Report): void {
  if (isBlank(spec.out_of_scope)) {
    report.findings.push(finding("out_of_scope", "empty-out-of-scope", "`out_of_scope:` is empty; say what this row does NOT do, because a small model does everything it is not told to leave"));
  }
}

/** Lint ONE parsed spec. Pure over `deps`: the same spec and the same answers are the same findings. */
export function lintSpec(spec: SpecValue, deps: LintDeps): LintResult {
  const report: Report = { findings: [], unchecked: [], deps };
  if (!isMap(spec)) {
    report.findings.push(finding("spec", "unreadable", "the block is not a mapping of fields (`files:`, `tests:`, `run:`, `out_of_scope:`)"));
    return { findings: report.findings, unchecked: report.unchecked };
  }
  const listed = listedFiles(spec, report);
  checkFilesExist(listed, report);
  checkSize(listed, report);
  checkTests(spec, report);
  checkRun(spec, report);
  checkScope(spec, report);
  checkVague(spec, report);
  return { findings: report.findings, unchecked: report.unchecked };
}

/** The lint of a row's BODY. `none` is a row with no `spec` block: the caller decides whether that row is a build row, because the body cannot say. */
export function lintRowBody(body: string, deps: LintDeps): { status: "none" } | ({ status: "linted" } & LintResult) {
  const blocks = specBlocksOf(body);
  if (blocks.length === 0) return { status: "none" };
  if (blocks.length > 1) {
    return { status: "linted", findings: [finding("spec", "multiple-blocks", `${blocks.length} \`spec\` blocks; a row carries ONE`)], unchecked: [] };
  }
  const parsed = parseSpec(blocks[0]);
  if (!parsed.ok) return { status: "linted", findings: [finding("spec", "unreadable", `line ${parsed.line}: ${parsed.reason}`)], unchecked: [] };
  return { status: "linted", ...lintSpec(parsed.value, deps) };
}

/**
 * THE REFUSAL AT PROMOTION, in the wording `row-file`'s `promoteRefusalReason` uses, or `null` when the spec is clean (or the row has no block and
 * `requireBlock` is not set). `requireBlock` is the caller's: a decomposition, investigation or fleet row has no spec block and is exempt by saying
 * nothing (a11ign#5109 made the same choice), so only a caller that KNOWS the row is a build row may ask for one.
 */
export function specLintRefusalReason(body: string | null, issueNumber: number, deps: LintDeps, { requireBlock = false }: { requireBlock?: boolean } = {}): string | null {
  const result = lintRowBody(body ?? "", deps);
  if (result.status === "none") {
    return requireBlock ? `row-file: REFUSING to promote -- #${issueNumber} is a build row and carries no fenced \`spec\` block. Nothing was changed.` : null;
  }
  if (result.findings.length === 0) return null;
  const lines = result.findings.map((one) => `  - ${one.field} (${one.rule}): ${one.message}`);
  const unchecked = result.unchecked.length === 0 ? [] : ["  Could not be checked, which is not a refusal:", ...result.unchecked.map((one) => `  - ${one.field}: ${one.message}`)];
  return [`row-file: REFUSING to promote -- #${issueNumber}'s \`spec\` block fails the spec lint (${SPEC_LINT_FLAG}), ${result.findings.length} finding(s):`, ...lines, ...unchecked,
    `  Asked of #${issueNumber}'s EXISTING body at promotion time. Nothing was changed.`].join("\n");
}

// --- the defaults for the three questions -------------------------------------------------------------------------------------------

/** Is `name` an executable file on `PATH`, or (when it has a `/`) at that path. */
export function executableOnPath(name: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const candidates = name.includes("/") ? [name.replace(/^~(?=\/)/, env.HOME ?? "~")] : (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, name));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false; // not there, or not executable: `false` is the answer, and the only one this question has
    }
  });
}

/** `bash -n`: PARSES, does not run. `null` when bash itself could not be started. */
export function bashParses(command: string): boolean | null {
  const result = spawnSync("bash", ["-n", "-c", command], { encoding: "utf8", timeout: 5000 });
  return result.error === undefined && result.status !== null ? result.status === 0 : null;
}

/**
 * The lint's three questions answered from this machine. `roots` maps a Region `repo:` prefix to a checkout, with `""` the row's own repository; a prefix with
 * no root is `null` (could not tell), never `false`.
 */
export function machineDeps(roots: Readonly<Record<string, string>>): LintDeps {
  return {
    fileExists: (path) => {
      const prefix = REPO_PREFIX.exec(path)?.[1] ?? "";
      const root = roots[prefix];
      return root === undefined ? null : existsSync(join(root, path.replace(REPO_PREFIX, "")));
    },
    onPath: (name) => executableOnPath(name),
    shellParses: bashParses,
  };
}

// --- JEV'S READING: a warning, never a block -----------------------------------------------------------------------------------------

export const SPEC_REVIEW_LABEL = "spec:review";
/** Woken when a spec scores below {@link SPEC_REVIEW_THRESHOLD}: the first reader for rows and process. */
export const SPEC_REVIEW_WAKE = "product-manager";
/** A score below this warns. On the provider's 1..5 scale, 3 is "an engineer would have to ask"; 1 and 2 are the readings that are a warning. */
export const SPEC_REVIEW_THRESHOLD = 3;
export const SPEC_REVIEW_QUESTION = "Could an engineer who has never seen this repo build this from the spec alone, with no questions?";

type ScoreQuestion = Extract<Question, { type: "score" }>;

/**
 * The question as the provider is asked it. THE FALLBACK IS THE TOP LEVEL, on purpose: with no provider, a spec is not warned about, because a warning that
 * fires whenever Jev is down would put `spec:review` on every row and train product-manager to ignore it.
 */
export function specReviewQuestion(): ScoreQuestion {
  return {
    type: "score",
    instructions: `${SPEC_REVIEW_QUESTION} Score the spec block you are given by position: 1 is "no, it leaves a decision to the builder in several places"; 5 is "yes, every file, assertion and exclusion is named".`,
    levels: [
      "No: the spec names no files, no assertion, or no command, so the builder would have to ask what is wanted.",
      "Mostly no: one required thing is missing or vague, and a builder would have to guess it.",
      "Partly: a builder could start, but at least one decision (a name, a value, a boundary) is left to them.",
      "Mostly yes: a builder could finish; one detail would be worth confirming.",
      "Yes: every file, assertion, command and exclusion is named; a builder needs to ask nothing.",
    ],
    fallback: 5,
  };
}

export type ReviewVerdict = { warn: false; reason: string } | { warn: true; reason: string; label: typeof SPEC_REVIEW_LABEL; wake: typeof SPEC_REVIEW_WAKE; score: number };

/**
 * What a score does. `fellBack` is the provider's own flag that the value is the deterministic fallback and not its reading: a fallback is NO reading, so it never
 * warns whatever number it carries. A score that is not a number in 1..5 is no reading either.
 */
export function specReviewVerdict(answer: { value: string | number; fellBack: boolean } | null): ReviewVerdict {
  if (answer === null) return { warn: false, reason: "Jev was not asked, so there is no reading and no warning" };
  if (answer.fellBack) return { warn: false, reason: "Jev did not answer, so the fallback stood and there is no warning" };
  const score = typeof answer.value === "number" ? answer.value : Number.NaN;
  if (!(score >= 1 && score <= 5)) return { warn: false, reason: `Jev's answer \`${String(answer.value)}\` is not a score from 1 to 5, so there is no reading` };
  if (score >= SPEC_REVIEW_THRESHOLD) return { warn: false, reason: `Jev scored the spec ${score} of 5, at or above ${SPEC_REVIEW_THRESHOLD}` };
  return { warn: true, reason: `Jev scored the spec ${score} of 5, below ${SPEC_REVIEW_THRESHOLD}: ${SPEC_REVIEW_QUESTION}`, label: SPEC_REVIEW_LABEL, wake: SPEC_REVIEW_WAKE, score };
}

/**
 * Ask Jev through `ask` (the caller binds it to `decide`, so this file stays a leaf) and return the verdict. NEVER THROWS and NEVER BLOCKS: an `ask` that
 * throws is no reading, said in the reason, because this is a warning and the promotion has already been decided by the lint above.
 */
export async function reviewSpec(specText: string, ask: (question: ScoreQuestion, specText: string) => Promise<{ value: string | number; fellBack: boolean } | null>): Promise<ReviewVerdict> {
  try {
    return specReviewVerdict(await ask(specReviewQuestion(), specText));
  } catch (error) {
    return { warn: false, reason: `Jev could not be asked (${String((error as Error)?.message ?? error).split("\n")[0]}), so there is no reading and no warning` };
  }
}

// --- THE FEEDBACK LOOP: "underspecified" stops, counted by field ----------------------------------------------------------------------

/** A field above this many stops in a day files a class row, to tighten the lint or the spec writer's prompt. */
export const UNDERSPECIFIED_DAILY_LIMIT = 2;
/** A stop that names no field in {@link SPEC_FIELDS} is counted here, never dropped: "which field" being unanswered is itself the finding. */
export const UNNAMED_FIELD = "unnamed";

export type UnderspecifiedStop = { at: number; row: number | null; field: string };
export type UnderspecifiedReading = { status: "read"; total: number; byField: Record<string, number>; overLimit: string[] };

const STOP_LINE = /^[ \t>*_-]*underspecified[*_]*[ \t]*:[*_]*[ \t]*(.*)$/i;

/** The spec field a stop's token names: `tests.cases[2].then` is `tests.cases`, `` `Files` `` is `files`, and anything else is {@link UNNAMED_FIELD}. */
export function fieldOf(token: string): string {
  // Only emphasis markers go: an underscore INSIDE `out_of_scope` is the field's name, so only edge underscores (`_files_`) are stripped.
  const cleaned = token.toLowerCase().replace(/[`*]/g, "").trim().replace(/^_+|_+$/g, "").replace(/\[\d+\]/g, "");
  return SPEC_FIELDS.find((field) => cleaned === field || cleaned.startsWith(`${field}.`)) ?? UNNAMED_FIELD;
}

function fieldsOfLine(rest: string): string[] {
  const tokens = rest.split(/[,;]|\band\b/i).map((token) => token.trim()).filter((token) => token !== "");
  return tokens.length === 0 ? [UNNAMED_FIELD] : tokens.map(fieldOf);
}

/**
 * THE STOPS in a window, from GitHub issue comments (`created_at`, `body`, `issue_url`): a worker that stops "underspecified" (a11ign#5110) writes a
 * line `Underspecified: <field>[, <field>]` in its comment on the row. Only a line that BEGINS with the word and a colon counts, so the retro's own
 * report line ("Underspecified stops by field: ...") posted on a row is not read back as stops.
 */
export function underspecifiedStops(comments: readonly unknown[], { since, until }: { since: number; until: number }): UnderspecifiedStop[] {
  return comments.flatMap((comment) => {
    const { body, created_at: createdAt, issue_url: issueUrl } = (comment ?? {}) as { body?: unknown; created_at?: unknown; issue_url?: unknown };
    const at = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    if (typeof body !== "string" || !(at >= since && at < until)) return [];
    const row = typeof issueUrl === "string" ? Number(issueUrl.split("/").pop()) : Number.NaN;
    return body.split(/\r?\n/).flatMap((line) => {
      const match = STOP_LINE.exec(line);
      return match === null ? [] : fieldsOfLine(match[1]).map((field) => ({ at, row: Number.isInteger(row) ? row : null, field }));
    });
  });
}

/** The count by field, and the fields above {@link UNDERSPECIFIED_DAILY_LIMIT} (the unnamed bucket included: it says the worker was not made to name one). */
export function underspecifiedReading(stops: readonly UnderspecifiedStop[]): UnderspecifiedReading {
  const byField: Record<string, number> = {};
  for (const { field } of stops) byField[field] = (byField[field] ?? 0) + 1;
  const overLimit = Object.entries(byField).filter(([, count]) => count > UNDERSPECIFIED_DAILY_LIMIT).sort((a, b) => b[1] - a[1]).map(([field]) => field);
  return { status: "read", total: stops.length, byField, overLimit };
}

/** The report's lines. `null` is a read nobody made or that was refused: `unknown`, never `none`. */
export function underspecifiedLines(reading: UnderspecifiedReading | null | undefined): string[] {
  const label = "- Underspecified stops by field";
  if (reading === null || reading === undefined) return [`${label}: unknown (the row comments could not be read)`];
  if (reading.total === 0) return [`${label}: none in the 24 hours`];
  const counts = Object.entries(reading.byField).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([field, count]) => `${field} ${count}`).join(", ");
  const over = reading.overLimit.map((field) => `  - \`${field}\` is above ${UNDERSPECIFIED_DAILY_LIMIT} a day (${reading.byField[field]}): file a \`ready\` class row to tighten the lint or the spec writer's prompt for it`);
  return [`${label}: ${counts} (${reading.total} in all)`, ...over];
}
