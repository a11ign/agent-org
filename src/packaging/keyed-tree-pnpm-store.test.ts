// no-token: gh -- imports `wake.ts`, whose default readers spawn `gh`; `linkKeyedDependencies` runs against real temp directories and spawns nothing but the shim under test
/**
 * #3728: A KEYED REVIEW TREE THAT LINKS THE CLONE'S `.bin` BUT NOT ITS `.pnpm` HANDS A REVIEWER SHIMS THAT POINT AT NOTHING.
 *
 * pnpm's shims in `node_modules/.bin` compute `basedir` from `$0` WITHOUT following the symlink, so with `<tree>/node_modules/.bin` linked to the
 * clone's, `<bin>` looks for `<tree>/node_modules/.pnpm/<pkg>@<v>/...`. The package links themselves resolve; the shims did not, and a keyed reviewer
 * of a pnpm repository (screenreader-fleet#2, #3715) could not run `pnpm exec tsx` and posted an escalation instead of a verdict.
 *
 * The fixture is a clone with a pnpm-shaped `.bin` shim and `.pnpm` store, and a tree that declares the package the clone has. POSITIVE CONTROL: the
 * same fixture on `wake.ts` before the `.pnpm` link fails the shim case (shown RED at the branch point, `git stash`-free: see the row's comment).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = mkdtempSync(join(tmpdir(), "keyed-tree-pnpm-store-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// `wake.ts` reads the project it serves from `$AGENT_ORG_HOST` AT IMPORT, so the recorded project `keyed-repo-review.test.ts` runs against is set FIRST
// and the tool imported AFTER it (#3233); nothing here reads a11ign's checkout.
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/keyed-repo-review/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", clones: {},
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { linkKeyedDependencies } = await import("../wake.ts");

/** pnpm's POSIX shim shape: `basedir` from `$0` as written, so a symlinked `.bin` resolves relative to the symlink's own directory. */
const SHIM = `#!/bin/sh
basedir=$(dirname "$0")
exec node "$basedir/../.pnpm/tool@1.0.0/node_modules/tool/cli.mjs" "$@"
`;

/** A clone with one declared package `tool`, installed the way pnpm does: the store under `.pnpm`, a link to it, and a shim in `.bin`. */
function pnpmClone(root: string) {
  const store = join(root, "node_modules/.pnpm/tool@1.0.0/node_modules/tool");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "cli.mjs"), `console.log("tool ran");\n`);
  symlinkSync(store, join(root, "node_modules/tool"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/tool"), SHIM);
  chmodSync(join(root, "node_modules/.bin/tool"), 0o755);
}

function keyedTree(root: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { tool: "1.0.0" } }));
}

test("a keyed tree's pnpm shim resolves its target through the linked store", () => {
  const clone = join(SCRATCH, "shim/clone");
  const tree = join(SCRATCH, "shim/tree");
  pnpmClone(clone);
  keyedTree(tree);
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone }), null);
  const out = execFileSync(join(tree, "node_modules/.bin/tool"), { encoding: "utf8" });
  assert.equal(out.trim(), "tool ran");
});

test("the store is linked, and the clone is never written", () => {
  const clone = join(SCRATCH, "link/clone");
  const tree = join(SCRATCH, "link/tree");
  pnpmClone(clone);
  keyedTree(tree);
  const before = readdirSync(join(clone, "node_modules"), { recursive: true }).sort();
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone }), null);
  assert.ok(lstatSync(join(tree, "node_modules/.pnpm")).isSymbolicLink());
  assert.deepEqual(readdirSync(join(clone, "node_modules"), { recursive: true }).sort(), before);
});

test("other dot entries of the clone are still not linked", () => {
  const clone = join(SCRATCH, "dot/clone");
  const tree = join(SCRATCH, "dot/tree");
  pnpmClone(clone);
  writeFileSync(join(clone, "node_modules/.modules.yaml"), "");
  keyedTree(tree);
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone }), null);
  assert.equal(lstatSync(join(tree, "node_modules/.modules.yaml"), { throwIfNoEntry: false }), undefined);
});
