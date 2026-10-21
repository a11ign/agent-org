// no-token: none -- a source test: it reads this repository's own files, and no fixture reaches a network
//
// A11-159, Decision 2 of A11-157: CORE DEPENDS ONLY ON THE CONTRACTS. No plugin's code is imported by core, and nothing in core names Linear's API or MCP. This is the check that
// refuses a Linear import outside the plugin (no ESLint import rule exists in this repository, and Linear has no package to import, so what "a Linear import" can mean is a plugin's
// code and Linear's endpoints and tool names). It reads the TypeScript syntax tree, so a comment or prose that names Linear is not a finding. A plugin's name used as a value
// (`"linear"`) is not a Linear call and is not one either. There is NO allow-list for core: a new finding is fixed by moving the code into the plugin.
//
// A11-162 ADDS TWO MORE VOCABULARIES TO IT: Tailscale's (the `tailscale` command run by a program-running call, and tailnet host names ending `.ts.net`) and Telegram's (`api.telegram.org`).
// They are the plugins' own: `plugins/tailscale` runs the command and `plugins/telegram` calls the API, and a name used as a value (`"tailscale"` in the exposure block's `provider`) is not a call.
//
// A11-161 ADDS SLACK'S: the skill its publish run uses (`post-pr-to-slack`), its MCP tool names (`mcp__<server>__slack…`) and its hosts (`slack.com`). They are `plugins/slack`'s manifest's (`tooling.skills`), which the
// hook reads as data; a name used as a value (`"slack"` in the publish block's `provider`) is not one.
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

/** A tailnet host name (`<machine>.<tailnet>.ts.net`): the vocabulary only the Tailscale plugin speaks. */
const TAILNET = /\.ts\.net\b/;

/** Telegram's Bot API host: the vocabulary only the Telegram plugin speaks. */
const TELEGRAM = /api\.telegram\.org/;

/** Slack's publish skill, its MCP tool names and its hosts: the vocabulary only the Slack plugin speaks. */
const SLACK = /post-pr-to-slack|mcp__\w*slack|slack\.com/i;

/** The vocabularies a plugin owns, by what core's finding says. */
const VOCABULARIES: readonly Readonly<{ pattern: RegExp; names: string }>[] = [
  { pattern: LINEAR, names: "Linear's API or MCP" }, { pattern: TAILNET, names: "a tailnet host" }, { pattern: TELEGRAM, names: "Telegram's API" }, { pattern: SLACK, names: "Slack's skill, tools or hosts" },
];

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

/** Every string, template and regular-expression literal of `source` that matches `pattern`. Comments are not read. */
function literalsMatching(source: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    const text = literalText(node);
    if (text !== null && pattern.test(text)) out.push(`line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text.slice(0, 60)}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The name of the function or method a call is made to (`spawnSync`, `deps.run` -> `run`), or null for a call of anything else. */
function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

/** Whether a node is a call whose first argument is the string `text`. */
function callsWithFirstArgument(node: ts.Node, text: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
  const [first] = node.arguments;
  return ts.isStringLiteralLike(first) && first.text === text;
}

/** The calls that run a program whose first argument is the `tailscale` command: `spawnSync("tailscale", ...)`, `execFileSync(...)`, `run(...)`, `which(...)`. A name used as a value is not one. */
function tailscaleSpawns(source: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (callsWithFirstArgument(node, "tailscale")) {
      const callee = calleeName(node);
      if (callee !== null && /spawn|exec|run|which/i.test(callee)) out.push(`line ${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${callee}("tailscale", ...)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** What is wrong with a CORE file (under `src/` or `scripts/`): it imports a file of `plugins/`, names a plugin's vocabulary (Linear's API or MCP, a tailnet host, Telegram's API) or runs `tailscale`. `path` is absolute. */
export function coreFindings(path: string, source: string): string[] {
  const reachesPlugins = (specifier: string) => specifier.startsWith(".") && `${resolve(dirname(path), specifier)}${sep}`.startsWith(`${PLUGINS}${sep}`);
  const imports = importsOf(source).filter(({ specifier }) => reachesPlugins(specifier)).map(({ specifier, at }) => `${at}: imports ${specifier}, a plugin's code`);
  const vocabulary = VOCABULARIES.flatMap(({ pattern, names }) => literalsMatching(source, pattern).map((literal) => `names ${names} at ${literal}`));
  return [...imports, ...vocabulary, ...tailscaleSpawns(source).map((call) => `runs the tailscale command at ${call}`)];
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

test("core imports no plugin's code, names no Linear endpoint or MCP tool, no tailnet host, no Telegram endpoint and no Slack skill, tool or host, and runs no tailscale: not a file of src/ or scripts/", () => {
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
  const found = walk(join(PLUGINS, "linear")).filter((file) => literalsMatching(readFileSync(file, "utf8"), LINEAR).length > 0).map((file) => relative(PLUGINS, file));
  assert.ok(found.includes(join("linear", "linear.ts")), "linear.ts names api.linear.app");
});

test("A11-162: the Tailscale plugin is where the tailscale command is run, and the Telegram plugin is where the Bot API is called: the walk finds them there", () => {
  const spawning = walk(join(PLUGINS, "tailscale")).filter((file) => tailscaleSpawns(readFileSync(file, "utf8")).length > 0).map((file) => relative(PLUGINS, file));
  assert.ok(spawning.includes(join("tailscale", "exposure.ts")) && spawning.includes(join("tailscale", "checks.ts")), `exposure.ts and checks.ts run tailscale through deps.exec: ${spawning.join(", ")}`);
  const calling = walk(join(PLUGINS, "telegram")).filter((file) => literalsMatching(readFileSync(file, "utf8"), TELEGRAM).length > 0).map((file) => relative(PLUGINS, file));
  assert.ok(calling.includes(join("telegram", "send.ts")), "send.ts names api.telegram.org");
  const tailnet = walk(join(PLUGINS, "tailscale")).filter((file) => literalsMatching(readFileSync(file, "utf8"), TAILNET).length > 0).map((file) => relative(PLUGINS, file));
  assert.ok(tailnet.length > 0, "and the stand-in names a tailnet host, which is why it lives with the plugin and not in core");
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

test("A11-162 NEGATIVE CONTROL: a core file that runs tailscale, or names a tailnet host or Telegram's API, is reported (twin: a name used as a value, prose and a comment are not)", () => {
  const core = join(REPO, "src", "ticket-mode", "fixture.ts");
  assert.deepEqual(coreFindings(core, 'import { spawnSync } from "node:child_process";\nspawnSync("tailscale", ["status", "--json"]);\n'), ['runs the tailscale command at line 2: spawnSync("tailscale", ...)']);
  assert.deepEqual(coreFindings(core, 'execFileSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8" });\n'), ['runs the tailscale command at line 1: execFileSync("tailscale", ...)']);
  assert.deepEqual(coreFindings(core, 'const run = (file: string) => file;\ndeps.run("tailscale", args);\nwhich("tailscale");\n'), ['runs the tailscale command at line 2: run("tailscale", ...)', 'runs the tailscale command at line 3: which("tailscale", ...)']);
  assert.deepEqual(coreFindings(core, 'export const host = `https://agents.tail1234.ts.net:9443/`;\n'), ["names a tailnet host at line 1: https://agents.tail1234.ts.net:9443/"]);
  assert.deepEqual(coreFindings(core, 'export const api = "https://api.telegram.org";\n'), ["names Telegram's API at line 1: https://api.telegram.org"]);
  assert.deepEqual(coreFindings(core, '// tailscale serve publishes agents.tail1234.ts.net, and api.telegram.org answers the bot\nexport const provider = "tailscale";\nconst same = provider !== "tailscale";\nexport const names = ["local", "tailscale", "telegram"].includes(provider);\n'), [],
    "prose, a comment, and the plugin's name as a value (the exposure block's provider) are not a call");
  assert.deepEqual(coreFindings(core, 'import { createTelegramProvider } from "../../plugins/telegram/send.ts";\n'), ["line 1: imports ../../plugins/telegram/send.ts, a plugin's code"]);
});

test("A11-161: the Slack plugin is where Slack's skill is named: its manifest declares it as data, and no core file does", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGINS, "slack", "package.json"), "utf8")) as { agentOrg: { tooling: { skills: string[] } } };
  assert.deepEqual(manifest.agentOrg.tooling.skills, ["post-pr-to-slack"]);
});

test("A11-161 NEGATIVE CONTROL: a core file that names Slack's skill, a Slack tool or a Slack host is reported (twin: prose, a comment, and the plugin's name as a value are not)", () => {
  const core = join(REPO, "src", "ticket-mode", "fixture.ts");
  const named = (what: string) => [`names Slack's skill, tools or hosts at line 1: ${what}`];
  for (const [source, what] of [["export const skill = /post-pr-to-slack/;\n", "/post-pr-to-slack/"], ['export const tool = "mcp__plugin_slack_slack__slack_send_message";\n', "mcp__plugin_slack_slack__slack_send_message"],
    ["export const link = `https://x.slack.com/archives/C1/p1`;\n", "https://x.slack.com/archives/C1/p1"]]) assert.deepEqual(coreFindings(core, source), named(what), source);
  assert.deepEqual(coreFindings(core, '// the post-pr-to-slack skill posts to x.slack.com through mcp__slack__send\nexport const provider = "slack";\nconst publishes = provider !== "slack";\n'), [], "prose, a comment, and the plugin's name as a value");
  assert.deepEqual(coreFindings(core, 'import { create } from "../../plugins/slack/index.ts";\n'), ["line 1: imports ../../plugins/slack/index.ts, a plugin's code"]);
});
