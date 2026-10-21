// no-token: none -- a source test: it reads this repository's own files, and no fixture reaches a network
//
// A11-159, Decision 2 of A11-157: CORE DEPENDS ONLY ON THE CONTRACTS. No plugin's code is imported by core, and nothing in core names Linear's API or MCP. This is the check that
// refuses a Linear import outside the plugin (no ESLint import rule exists in this repository, and Linear has no package to import, so what "a Linear import" can mean is a plugin's
// code and Linear's endpoints and tool names). It reads the TypeScript syntax tree, so a comment or prose that names Linear is not a finding. A plugin's name used as a value
// (`"linear"`) is not a Linear call and is not one either. There is NO allow-list for core: a new finding is fixed by moving the code into the plugin.
//
// THE OTHER HALF OF THE BOUNDARY (ADR 0001): a plugin imports core's types only. A runtime import of a file outside the plugin's folder is a finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS = join(REPO, "plugins");

/** Linear's API hosts and its MCP's tool names: the vocabulary only the Linear plugin speaks. */
const LINEAR = /api\.linear\.app|uploads\.linear\.app|mcp\.linear\.app|mcp__linear__|mcp__claude_ai_Linear__/;

type Found = Readonly<{ specifier: string; typeOnly: boolean; at: string }>;

/** Every module `source` imports, re-exports or imports dynamically: its specifier, and whether it is a type-only import. */
function importsOf(source: string): Found[] {
  const out: Found[] = [];
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const at = `line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.push({ specifier: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly === true, at });
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) out.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, at });
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const isLoad = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (isLoad) out.push({ specifier: node.arguments[0].text, typeOnly: false, at });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The text of a string, template or regular-expression literal, or null for any other node. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) return node.text;
  return ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : null;
}

/** Every string, template and regular-expression literal of `source` that names Linear's API or MCP. Comments are not read. */
function linearLiterals(source: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text !== null && LINEAR.test(text)) out.push(`line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text.slice(0, 60)}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** What is wrong with a CORE file (under `src/` or `scripts/`): it imports a file of `plugins/`, or names Linear's API or MCP. `path` is absolute. */
export function coreFindings(path: string, source: string): string[] {
  const reachesPlugins = (specifier: string) => specifier.startsWith(".") && `${resolve(dirname(path), specifier)}${sep}`.startsWith(`${PLUGINS}${sep}`);
  const imports = importsOf(source).filter(({ specifier }) => reachesPlugins(specifier)).map(({ specifier, at }) => `${at}: imports ${specifier}, a plugin's code`);
  return [...imports, ...linearLiterals(source).map((literal) => `names Linear's API or MCP at ${literal}`)];
}

/** What is wrong with a PLUGIN file: it imports, at run time, a file outside its own folder. `path` is absolute. */
export function pluginFindings(path: string, source: string): string[] {
  const folder = join(PLUGINS, relative(PLUGINS, path).split(sep)[0]);
  return importsOf(source)
    .filter(({ specifier, typeOnly }) => specifier.startsWith(".") && !typeOnly && !`${resolve(dirname(path), specifier)}${sep}`.startsWith(`${folder}${sep}`))
    .map(({ specifier, at }) => `${at}: imports ${specifier} at run time, outside its folder: a plugin imports core's types only`);
}

const isSource = (name: string) => /\.(ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !name.endsWith(".d.ts");

/** The non-test `.ts` and `.mjs` files under `dir`, absolute. */
const walk = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && isSource(entry.name))
  .map((entry) => join(entry.parentPath, entry.name)).filter((path) => !path.split(sep).includes("node_modules")).sort();

test("core imports no plugin's code and names no Linear endpoint or MCP tool: not a file of src/ or scripts/", () => {
  const files = [...walk(join(REPO, "src")), ...walk(join(REPO, "scripts"))];
  assert.ok(files.some((file) => file.endsWith(join("ticket-mode", "server.ts"))) && files.some((file) => file.endsWith(join("plugins", "registry.ts"))), "the walk sees core: an empty walk would pass for the wrong reason");
  const findings = files.flatMap((file) => coreFindings(file, readFileSync(file, "utf8")).map((finding) => `${relative(REPO, file)} ${finding}`));
  assert.deepEqual(findings, []);
});

test("a plugin imports core's types only: not a runtime import of a file outside its own folder", () => {
  const files = walk(PLUGINS);
  assert.ok(files.some((file) => file.endsWith(join("linear", "index.ts"))), "the walk sees the Linear plugin: an empty walk would pass for the wrong reason");
  const findings = files.flatMap((file) => pluginFindings(file, readFileSync(file, "utf8")).map((finding) => `${relative(REPO, file)} ${finding}`));
  assert.deepEqual(findings, []);
});

test("the Linear plugin is where Linear's endpoints and tool names are: the walk finds them there", () => {
  const found = walk(join(PLUGINS, "linear")).filter((file) => linearLiterals(readFileSync(file, "utf8")).length > 0).map((file) => relative(PLUGINS, file));
  assert.ok(found.includes(join("linear", "linear.ts")), "linear.ts names api.linear.app");
});

test("NEGATIVE CONTROL: a core file that names a Linear URL or tool, or imports the plugin, is reported by file name (twin: prose and a plugin's name are not)", () => {
  const core = join(REPO, "src", "ticket-mode", "fixture.ts");
  assert.deepEqual(coreFindings(core, 'export const url = "https://api.linear.app/graphql";\n'), ['names Linear\'s API or MCP at line 1: https://api.linear.app/graphql']);
  assert.deepEqual(coreFindings(core, 'export const tool = `mcp__linear__${"save_issue"}`;\n'), ['names Linear\'s API or MCP at line 1: mcp__linear__']);
  assert.deepEqual(coreFindings(core, "export const pattern = /^mcp__claude_ai_Linear__get_/;\n"), ["names Linear's API or MCP at line 1: /^mcp__claude_ai_Linear__get_/"]);
  assert.deepEqual(coreFindings(core, 'import { linearSource } from "../../plugins/linear/linear.ts";\nexport const source = linearSource;\n'), ["line 1: imports ../../plugins/linear/linear.ts, a plugin's code"]);
  assert.deepEqual(coreFindings(core, 'export * from "../../plugins/linear/index.ts";\n'), ["line 1: imports ../../plugins/linear/index.ts, a plugin's code"]);
  assert.deepEqual(coreFindings(core, 'const plugin = await import("../../plugins/linear/index.ts");\n'), ["line 1: imports ../../plugins/linear/index.ts, a plugin's code"]);
  assert.deepEqual(coreFindings(core, '// api.linear.app and mcp__linear__save_issue are named in this comment\n/** and in this one: uploads.linear.app */\nexport const DEFAULT = "linear";\n'), [], "comments are prose, and the plugin's name is a value");
  assert.deepEqual(coreFindings(core, 'import { loadEnabled } from "./loader.ts";\nimport { CONCERNS } from "../plugins/concerns.ts";\n'), [], "src/plugins is core's own folder, and is not plugins/");
});

test("NEGATIVE CONTROL: a plugin file that imports core's code at run time is reported (twin: a type import is not)", () => {
  const plugin = join(PLUGINS, "linear", "fixture.ts");
  assert.deepEqual(pluginFindings(plugin, 'import { escapeRegExp } from "../../src/lib/escape-regexp.ts";\n'), ["line 1: imports ../../src/lib/escape-regexp.ts at run time, outside its folder: a plugin imports core's types only"]);
  assert.deepEqual(pluginFindings(plugin, 'const lib = await import("../../src/lib/escape-regexp.ts");\n'), ["line 1: imports ../../src/lib/escape-regexp.ts at run time, outside its folder: a plugin imports core's types only"]);
  assert.deepEqual(pluginFindings(plugin, 'import type { Ticket } from "../../src/plugins/contracts/tracker.ts";\nimport { keySource } from "./key.ts";\nimport { readFileSync } from "node:fs";\n'), []);
});
