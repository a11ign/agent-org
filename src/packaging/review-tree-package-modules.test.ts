// no-token: gh -- `linkReviewDependencies` is handed a real temporary disk and no `gh`; nothing here reaches GitHub
/**
 * #3558: A REVIEW TREE HAS EACH PACKAGE'S OWN `node_modules`, so `tsc -p packages/cli` resolves a registry `@a11ign/*` there.
 *
 * Measured 2026-10-04 with `tsc -p packages/cli --noEmit`: exit 0 in the tick's checkout, exit 1 in a review tree at
 * `src/cli.ts(24,49): error TS2307: Cannot find module '@a11ign/documents'`. pnpm puts a package's own dependencies under
 * `packages/<dir>/node_modules`, and `linkReviewDependencies` linked the ROOT's and nothing else.
 *
 * THE SOURCES MUST BE RIGHT (#2181): a third-party entry is the tick checkout's store, a WORKSPACE entry is THIS tree's package of that
 * name (a link that reaches the primary's package makes the tree measure `main`), and a registry `@a11ign/*` entry is the store's.
 * Real symlinks on a real disk, so "resolves to" is `realpathSync`, not a string compared with the string the code wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, realpathSync, lstatSync, existsSync, readFileSync,
  readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkReviewDependencies } from "../wake.mjs";

const realFs = { existsSync, readFileSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync };

function writePackage(root: string, dir: string, name: string) {
  mkdirSync(join(root, "packages", dir), { recursive: true });
  writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name }));
}

/**
 * The live shape, reduced: the tick's checkout has `cli` (third-party `yaml`, workspace `@a11ign/evidence` by a RELATIVE link as pnpm writes
 * it, the registry's `@a11ign/documents`, a scope of third-party packages, the unscoped workspace `a11ign` that `lab` has) and `lab`, and
 * `docs` with no `node_modules`; the review tree has the same packages, each with source of its own and none with a `node_modules`.
 */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "review-tree-package-modules-"));
  const primary = join(dir, "primary");
  const tree = join(dir, "reviews", "reviewer-7");
  for (const root of [primary, tree]) {
    for (const [d, name] of [["cli", "a11ign"], ["lab", "@a11ign/lab"], ["evidence", "@a11ign/evidence"], ["docs", "@a11ign/docs"]]) writePackage(root, d, name);
    writeFileSync(join(root, "packages", "evidence", "marker"), root);
  }
  mkdirSync(join(primary, "node_modules", ".pnpm", "yaml@2", "node_modules", "yaml"), { recursive: true });
  mkdirSync(join(primary, "node_modules", ".pnpm", "@a11ign+documents@0.1.0", "node_modules", "@a11ign", "documents"), { recursive: true });
  mkdirSync(join(primary, "node_modules", ".pnpm", "@axe-core+playwright@4", "node_modules", "@axe-core", "playwright"), { recursive: true });
  for (const p of ["cli", "lab"]) mkdirSync(join(primary, "packages", p, "node_modules", "@a11ign"), { recursive: true });
  const cli = join(primary, "packages", "cli", "node_modules");
  symlinkSync("../../../node_modules/.pnpm/yaml@2/node_modules/yaml", join(cli, "yaml"));
  symlinkSync("../../../../node_modules/.pnpm/@a11ign+documents@0.1.0/node_modules/@a11ign/documents", join(cli, "@a11ign", "documents"));
  symlinkSync("../../../evidence", join(cli, "@a11ign", "evidence"));
  mkdirSync(join(cli, "@axe-core"));
  symlinkSync("../../../../node_modules/.pnpm/@axe-core+playwright@4/node_modules/@axe-core/playwright", join(cli, "@axe-core", "playwright"));
  mkdirSync(join(cli, ".bin"));
  const lab = join(primary, "packages", "lab", "node_modules");
  symlinkSync("../../../evidence", join(lab, "@a11ign", "evidence"));
  symlinkSync("../../cli", join(lab, "a11ign"));
  return { dir, primary, tree, cli: join(tree, "packages", "cli", "node_modules"), lab: join(tree, "packages", "lab", "node_modules") };
}

/** Run `body` on a fresh world that has been linked once, and always remove it. */
function linked(body: (w: ReturnType<typeof world>) => void) {
  const w = world();
  try {
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: realFs as never }) ?? null, null,
      "the link itself answered null: nothing refused it");
    body(w);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

test("#3558 (a): a package of the tick's checkout that has a `node_modules` gets one in the tree, with the same entry names", () => {
  linked((w) => {
    assert.deepEqual(readdirSync(w.cli).sort(), ["@a11ign", "@axe-core", "yaml"],
      "the entries of the tick's `packages/cli/node_modules`, bar `.bin`: the shims of a package's own workspace bins run the PRIMARY's source");
    assert.deepEqual(readdirSync(join(w.cli, "@a11ign")).sort(), ["documents", "evidence"]);
    assert.deepEqual(readdirSync(w.lab).sort(), ["@a11ign", "a11ign"]);
    assert.equal(lstatSync(join(w.cli, "@a11ign")).isDirectory(), true, "a REAL scope directory: a link to the primary's would be written through");
  });
});

test("#3558 (b): a third-party entry resolves to the same real path as the tick's, and so does a registry `@a11ign/*` one", () => {
  linked((w) => {
    const from = join(w.primary, "packages", "cli", "node_modules");
    for (const entry of ["yaml", "@a11ign/documents", "@axe-core/playwright"]) {
      assert.equal(realpathSync(join(w.cli, entry)), realpathSync(join(from, entry)), entry);
      assert.match(realpathSync(join(w.cli, entry)), /\/primary\/node_modules\/\.pnpm\//, `${entry} is the store's`);
    }
  });
});

test("#3558 (c): a WORKSPACE entry resolves INSIDE the tree, and never to the tick's package", () => {
  linked((w) => {
    for (const modules of [w.cli, w.lab]) {
      const real = realpathSync(join(modules, "@a11ign", "evidence"));
      assert.equal(real, realpathSync(join(w.tree, "packages", "evidence")));
      assert.equal(readFileSync(join(real, "marker"), "utf8"), w.tree, "this tree's source: a link copied verbatim from the tick's would read the PRIMARY's marker");
    }
    assert.equal(realpathSync(join(w.lab, "a11ign")), realpathSync(join(w.tree, "packages", "cli")), "the unscoped workspace package too");
  });
});

test("#3558 (d): a package with no `node_modules` in the tick's checkout gets none, and a package the tree no longer has is skipped", () => {
  const w = world();
  try {
    rmSync(join(w.tree, "packages", "lab"), { recursive: true });
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: realFs as never }) ?? null, null);
    assert.equal(existsSync(join(w.tree, "packages", "docs", "node_modules")), false, "`docs` has none in the tick's checkout");
    assert.equal(existsSync(join(w.tree, "packages", "lab")), false, "and nothing re-creates a package the PR removed");
    assert.equal(existsSync(w.cli), true, "CONTROL: the package that has one in both is linked in the same run");
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("#3558 (e): running it twice changes nothing, and a `node_modules` that is a link to the primary's is replaced, never written through", () => {
  linked((w) => {
    const writes: string[] = [];
    const counting = { ...realFs,
      symlinkSync: (...a: Parameters<typeof symlinkSync>) => { writes.push(`symlink ${a[1]}`); return symlinkSync(...a); },
      rmSync: (...a: Parameters<typeof rmSync>) => { writes.push(`rm ${a[0]}`); return rmSync(...a); } };
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: counting as never }) ?? null, null);
    assert.deepEqual(writes, [], "a second run on a right tree writes nothing: it runs on every head-changing push");

    rmSync(w.cli, { recursive: true });
    symlinkSync(join(w.primary, "packages", "cli", "node_modules"), w.cli);
    assert.equal(linkReviewDependencies({ path: w.tree, repoRoot: w.primary, fs: realFs as never }) ?? null, null);
    assert.equal(lstatSync(w.cli).isDirectory(), true, "a real directory again");
    assert.equal(realpathSync(join(w.cli, "@a11ign", "evidence")), realpathSync(join(w.tree, "packages", "evidence")));
    assert.deepEqual(readdirSync(join(w.primary, "packages", "cli", "node_modules")).sort(), [".bin", "@a11ign", "@axe-core", "yaml"],
      "nothing was written into the tick's checkout");
  });
});
