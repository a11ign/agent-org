// no-token: gh -- imports `wake.mjs`, whose default readers spawn `gh`; nothing here calls one, and the only process run is a `pnpm` shim on a scratch PATH (#3386)
/**
 * #3386: A KEYED CLONE'S `node_modules` GOES STALE ON A DEPENDENCY CHANGE, AND #3264'S REMEDY CANNOT BE CARRIED OUT OVER IT.
 *
 * Measured 2026-10-04 on `a11ign/screenreader-worker#10`/`#11`/`#12`: `reviewer-screenreader-worker-10` was `UNDELIVERED` for 3 h because the clone's one
 * install predated `#8`, which added `eslint`, `typescript` and five more. The remedy #3264 printed, `mv <tree>/node_modules <clone>/node_modules`, moves
 * the tree's directory INTO a `node_modules` that is already there, so the repair it names leaves every declared package where nothing looks.
 *
 *   (1) the INSTALL   a declared package the clone lacks is installed into the REVIEW TREE (private to one review, removed with it), the clone is not
 *                     written, and the tree is handed on -- no refusal, no reviewer lost
 *   (2) the REMEDY    when the install fails, the refusal names the failure's first line and a supply command that, RUN over a clone that already has a
 *                     `node_modules`, leaves each declared package at `<clone>/node_modules/<name>` and nothing at `<clone>/node_modules/node_modules`
 *
 * THE FAILING CONTROL (3a) is a run against the OLD code, recorded on the row: the old refusal for this fixture printed `mv`, and the first test below RUNS
 * that `mv` on the same shape and finds the nesting, so no later assertion can pass on a fixture where the old text was right.
 * POSITIVE CONTROLS ARE IN THIS FILE, each next to the assertion it serves (`.claude/rules/guards-and-assertions.md`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// `wake.mjs` takes its project from `$AGENT_ORG_HOST` AT IMPORT (#3233), so a recorded host is set FIRST and the tool imported after it.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-keyed-stale-deps-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/keyed-repo-review/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { linkKeyedDependencies } = await import("../wake.mjs");

const DECLARED = { eslint: "9.0.0", tsx: "4.0.0" };
let made = 0;

/** A tree declaring `eslint` and `tsx`, and a clone whose `node_modules` holds `tsx` only (with a file in it, so a clobbered clone is visible) and no manifest. */
function stale({ lockfile = false, cloneManifest = false } = {}) {
  const root = join(SCRATCH, `case-${made++}`);
  const tree = join(root, "tree");
  const clone = join(root, "clone");
  mkdirSync(tree, { recursive: true });
  mkdirSync(join(clone, "node_modules", "tsx"), { recursive: true });
  writeFileSync(join(clone, "node_modules", "tsx", "kept"), "the clone's own file");
  writeFileSync(join(tree, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: DECLARED }));
  if (lockfile) writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (cloneManifest) writeFileSync(join(clone, "package.json"), "{}");
  return { root, tree, clone };
}

/** What `pnpm install` leaves: every package the cwd's manifest declares at `node_modules/<name>`, in pnpm's real shape (a store entry and a link to it). */
function installDeclared(cwd: string) {
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  for (const name of Object.keys({ ...manifest.devDependencies, ...manifest.dependencies })) {
    mkdirSync(join(cwd, "node_modules", ".pnpm", `${name}@1`, "node_modules", name), { recursive: true });
    writeFileSync(join(cwd, "node_modules", ".pnpm", `${name}@1`, "node_modules", name, "index.js"), "");
    execFileSync("ln", ["-s", `.pnpm/${name}@1/node_modules/${name}`, join(cwd, "node_modules", name)]);
  }
}

/** A `pnpm` on `PATH` that logs `<cwd> <argv>` and either installs what the manifest declares or exits 1 with `stderr`. Returns the dir to prepend and the log. */
function pnpmShim(fails: string | null) {
  const dir = join(SCRATCH, `shim-${made++}`);
  mkdirSync(dir);
  const log = join(dir, "log");
  writeFileSync(join(dir, "pnpm"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } = require("node:fs");
appendFileSync(${JSON.stringify(log)}, process.cwd() + " " + process.argv.slice(2).join(" ") + "\\n");
if (${JSON.stringify(fails)} !== null) { console.error(${JSON.stringify(fails)}); process.exit(1); }
const m = JSON.parse(readFileSync("package.json", "utf8"));
for (const name of Object.keys({ ...m.devDependencies, ...m.dependencies })) {
  mkdirSync("node_modules/.pnpm/" + name + "@1/node_modules/" + name, { recursive: true });
  writeFileSync("node_modules/.pnpm/" + name + "@1/node_modules/" + name + "/index.js", "");
  symlinkSync(".pnpm/" + name + "@1/node_modules/" + name, "node_modules/" + name);
}
`);
  chmodSync(join(dir, "pnpm"), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

/** Run `body` with `dir` first on `PATH`, so the default install (the real `execFileSync("pnpm")`) reaches the shim. */
function withPath<T>(dir: string, body: () => T): T {
  const before = { PATH: process.env.PATH, npm_execpath: process.env.npm_execpath };
  process.env.PATH = `${dir}${delimiter}${before.PATH}`;
  delete process.env.npm_execpath; // set when `pnpm run` started this process, and then `pnpmCliInvocation` would run THAT pnpm and not the shim
  try {
    return body();
  } finally {
    process.env.PATH = before.PATH;
    if (before.npm_execpath !== undefined) process.env.npm_execpath = before.npm_execpath;
  }
}

/** The commands a refusal prints: its backticked spans that begin a shell line (`cd ...`, `rm ...`), in order. */
const printedCommands = (reason: string) => [...reason.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => /^(cd|rm) /.test(c));

test("(3a) FAILING CONTROL: the old remedy, `mv` over a clone that has a `node_modules`, nests the tree's and leaves `eslint` missing", () => {
  const { tree, clone } = stale();
  installDeclared(tree);
  execFileSync("mv", [join(tree, "node_modules"), join(clone, "node_modules")]);
  assert.ok(existsSync(join(clone, "node_modules", "node_modules", "eslint")), "the tree's directory landed INSIDE the clone's");
  assert.ok(!existsSync(join(clone, "node_modules", "eslint")), "so the package the clone lacked is still not where a tree links from");
});

test("(1) a declared package the clone lacks is INSTALLED INTO THE TREE: no refusal, the clone is not written, every declared package is in the tree", () => {
  const { tree, clone } = stale();
  const calls: { cwd: string; args: string[] }[] = [];
  const install = (run: { cwd: string; args: string[] }) => { calls.push(run); installDeclared(run.cwd); };
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone, install }), null);
  assert.deepEqual(calls, [{ cwd: tree, args: ["install", "--no-lockfile", "--ignore-scripts"] }], "one install, in the tree, with no lockfile because the tree has none");
  for (const name of Object.keys(DECLARED)) assert.ok(existsSync(join(tree, "node_modules", name)), `${name} resolves in the tree`);
  assert.deepEqual(readdirSync(join(clone, "node_modules")), ["tsx"], "the shared clone is exactly as it was");
  assert.equal(readFileSync(join(clone, "node_modules", "tsx", "kept"), "utf8"), "the clone's own file");
});

test("(1) a tree WITH a lockfile is installed frozen: the pull request's own pins", () => {
  const { tree, clone } = stale({ lockfile: true });
  const calls: string[][] = [];
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone, install: ({ cwd, args }) => { calls.push(args); installDeclared(cwd); } }), null);
  assert.deepEqual(calls, [["install", "--frozen-lockfile", "--ignore-scripts"]]);
});

test("(1) the DEFAULT install is `pnpm` in the tree: a real process, not a seam", () => {
  const { tree, clone } = stale();
  const shim = pnpmShim(null);
  assert.equal(withPath(shim.dir, () => linkKeyedDependencies({ path: tree, repoRoot: clone })), null);
  assert.deepEqual(shim.calls(), [`${tree} install --no-lockfile --ignore-scripts`]);
  assert.ok(existsSync(join(tree, "node_modules", "eslint")));
});

test("(3b) POSITIVE CONTROL: a clone that has every declared package causes NO install and links as before", () => {
  const { tree, clone } = stale();
  mkdirSync(join(clone, "node_modules", "eslint"));
  let installs = 0;
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone, install: () => { installs++; } }), null);
  assert.equal(installs, 0, "the exec seam is uncalled");
  for (const name of ["eslint", "tsx"]) assert.ok(lstatSync(join(tree, "node_modules", name)).isSymbolicLink(), `${name} is linked from the clone`);
});

test("(3c) the install FAILING is a refusal that names the failure and the hand remedy, never a link of a partial tree", () => {
  const { tree, clone } = stale();
  const install = () => { throw Object.assign(new Error("Command failed: pnpm install"), { stderr: "\n ERR_PNPM_FETCH_404  registry says no\nmore\n" }); };
  const reason = String(linkKeyedDependencies({ path: tree, repoRoot: clone, install }));
  assert.match(reason, /failed \(ERR_PNPM_FETCH_404  registry says no\)/, "the first line of the failure, not the command we sent");
  assert.match(reason, /lacks `eslint`, which .*package\.json declares/, "and what is missing");
  assert.ok(!existsSync(join(tree, "node_modules")), "nothing was linked into the tree");
  // An install that exits 0 and still leaves a declared package out is the same refusal, not a tree that cannot run.
  const partial = String(linkKeyedDependencies({ path: tree, repoRoot: clone, install: () => { mkdirSync(join(tree, "node_modules", "tsx"), { recursive: true }); } }));
  assert.match(partial, /finished without `eslint`;/);
  // CONTROL: the same call with an install that supplies everything is not refused, so both refusals above are the install's doing.
  assert.equal(linkKeyedDependencies({ path: tree, repoRoot: clone, install: ({ cwd }) => installDeclared(cwd) }), null);
});

test("(3c) the default install's failure is quoted from pnpm's own stderr", () => {
  const { tree, clone } = stale();
  const shim = pnpmShim(" ERR_PNPM_NO_MATCHING_VERSION  nothing satisfies 9.0.0");
  const reason = String(withPath(shim.dir, () => linkKeyedDependencies({ path: tree, repoRoot: clone })));
  assert.match(reason, /failed \(ERR_PNPM_NO_MATCHING_VERSION  nothing satisfies 9\.0\.0\)/);
});

test("(2) the printed remedy, RUN over a clone that already has a `node_modules`, puts every declared package at `<clone>/node_modules/<name>` and nests nothing", () => {
  const { tree, clone } = stale();
  const reason = String(linkKeyedDependencies({ path: tree, repoRoot: clone, install: () => { throw new Error("offline"); } }));
  const commands = printedCommands(reason);
  assert.equal(commands.length, 2, `the install and the carry, as commands: ${reason}`);
  assert.ok(!/\bmv\b/.test(commands.join(" ")), "and not `mv`");
  const shim = pnpmShim(null);
  for (const command of commands) execFileSync("sh", ["-c", command], { env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH}` } });
  assert.ok(existsSync(join(clone, "node_modules", "eslint", "index.js")), "the package the clone lacked resolves THROUGH its link");
  assert.ok(existsSync(join(clone, "node_modules", "tsx", "index.js")), "and the one it had is the tree's now: one install, not two mixed");
  assert.ok(!existsSync(join(clone, "node_modules", "node_modules")), "and nothing is nested");
  assert.ok(!existsSync(join(clone, "node_modules", "tsx", "kept")), "(the clone's old `node_modules` was replaced, which is the remedy and not a loss: it is derived)");
  assert.ok(existsSync(join(tree, "node_modules", "eslint")), "the tree under review keeps its own");
  // The remedy is idempotent: an operator who runs it twice, or a tick that races one, does not nest on the second run.
  execFileSync("sh", ["-c", commands[1]]);
  assert.ok(!existsSync(join(clone, "node_modules", "node_modules")));
});

test("(2) the printed remedy also works over a clone with NO `node_modules` at all", () => {
  const { tree, clone } = stale();
  rmSync(join(clone, "node_modules"), { recursive: true });
  const commands = printedCommands(String(linkKeyedDependencies({ path: tree, repoRoot: clone, install: () => { throw new Error("offline"); } })));
  const shim = pnpmShim(null);
  for (const command of commands) execFileSync("sh", ["-c", command], { env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH}` } });
  assert.ok(existsSync(join(clone, "node_modules", "eslint", "index.js")));
});

test("(2) a clone WITH a manifest is still told to `pnpm install` there, unchanged", () => {
  const { tree, clone } = stale({ cloneManifest: true });
  const reason = String(linkKeyedDependencies({ path: tree, repoRoot: clone, install: () => { throw new Error("offline"); } }));
  assert.ok(reason.includes(`cd ${clone} && pnpm install --no-lockfile`), "POSITIVE CONTROL: the old remedy, where it works");
  assert.ok(!reason.includes("cp -a"), "and none of the no-manifest one");
});
