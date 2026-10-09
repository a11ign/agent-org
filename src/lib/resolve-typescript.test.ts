// no-token: gh
/**
 * #3729: A `typescript` THAT LOADS BUT HAS NO JS COMPILER API IS NOT ONE THE TOOL CAN USE.
 *
 * TypeScript 7 is the native compiler; `require("typescript")` returns it without throwing and `ts.ScriptTarget` is `undefined`, so resolving the project's copy
 * FIRST crashed `pr:open` in `acceptance-commands.ts` and the fallback to the tool's own was never taken. The resolver is copied into a scratch tool tree, so
 * the tool's own `node_modules` is the one this test lays out and the project's is another.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESOLVER = fileURLToPath(new URL("./resolve-typescript.mjs", import.meta.url));
const WITH_API = "module.exports = { version: VERSION, ScriptTarget: { Latest: 99 }, createSourceFile() {}, forEachChild() {} };";
const NATIVE_COMPILER = "module.exports = { version: VERSION };";

const scratchDirs: string[] = [];
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "resolve-typescript-"));
  scratchDirs.push(dir);
  return dir;
}

/** A directory whose `node_modules/typescript` is `entry` (a CommonJS body with VERSION in it), reporting `version`. */
function directoryHolding(version: string, entry: string): string {
  const dir = scratch();
  const home = join(dir, "node_modules", "typescript");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "typescript", version, main: "index.js" }));
  writeFileSync(join(home, "index.js"), entry.replace("VERSION", JSON.stringify(version)));
  return dir;
}

async function resolverIn(toolTree: string) {
  mkdirSync(join(toolTree, "lib"), { recursive: true });
  cpSync(RESOLVER, join(toolTree, "lib", "resolve-typescript.mjs"));
  const module = await import(pathToFileURL(join(toolTree, "lib", "resolve-typescript.mjs")).href);
  return module.resolveTypescript as (where?: { from?: string }) => { version: string };
}

test("a project whose typescript has no JS API (7.x) falls back to the tool's own, which does", async () => {
  const resolve = await resolverIn(directoryHolding("6.0.3-tool", WITH_API));
  assert.equal(resolve({ from: directoryHolding("7.0.2-project", NATIVE_COMPILER) }).version, "6.0.3-tool");
});

test("positive control: the same call against a project WITH the API returns the project's, first", async () => {
  const resolve = await resolverIn(directoryHolding("6.0.3-tool", WITH_API));
  assert.equal(resolve({ from: directoryHolding("5.9.0-project", WITH_API) }).version, "5.9.0-project");
});

/** Each member the tool calls is required by the type it is used as, so each stub below breaks exactly one. */
const INCOMPLETE = {
  "ScriptTarget as a bare object, so `ScriptTarget.Latest` is undefined": "module.exports = { version: VERSION, ScriptTarget: {}, createSourceFile() {}, forEachChild() {} };",
  "no `createSourceFile`": "module.exports = { version: VERSION, ScriptTarget: { Latest: 99 }, forEachChild() {} };",
  "no `forEachChild`": "module.exports = { version: VERSION, ScriptTarget: { Latest: 99 }, createSourceFile() {} };",
};
for (const [broken, entry] of Object.entries(INCOMPLETE)) {
  test(`a project whose typescript has ${broken} is rejected: every member the tool uses is required`, async () => {
    const resolve = await resolverIn(directoryHolding("6.0.3-tool", WITH_API));
    assert.equal(resolve({ from: directoryHolding("7.0.2-project", entry) }).version, "6.0.3-tool");
  });
}

test("when no place has the API, it refuses naming each candidate rejected and why", async () => {
  const resolve = await resolverIn(directoryHolding("7.0.2-tool", NATIVE_COMPILER));
  const project = directoryHolding("7.0.2-project", NATIVE_COMPILER);
  assert.throws(() => resolve({ from: project }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /pnpm add -D typescript/);
    assert.ok(error.message.includes(project), error.message);
    assert.equal(error.message.match(/no JS compiler API/g)?.length, 2, `both candidates should be named as rejected: ${error.message}`);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.length, 2);
    return true;
  });
});
