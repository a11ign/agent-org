#!/usr/bin/env node
// @ts-check
// command: print every control-plane hygiene number fresh, measured by command, never typed once
// THE MEASUREMENT THIS ROW EXISTS TO REPLACE: a table typed once, from numbers somebody had to go and
// find. Every row below is measured fresh, by command, and printed beside the RULE or recorded DECISION
// for that accumulator -- never "we should clean this up" on its own, which #58 names as a failed
// acceptance.
//
// Read-only. Never deletes anything -- a lifecycle rule is a decision to record, not an action to take
// here, and `runs/` in particular must never be touched by a script that does not answer to `orchestrator`.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"],
  { encoding: "utf8", env: sandboxGitEnv() }).trim();

/** @param {string} path */
function du(path) {
  if (!existsSync(path)) return 0;
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8" });
    return Number(out.split("\t")[0]) * 1024;
  } catch {
    return 0;
  }
}

/** @param {number} bytes */
function humanMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/** Every registered worktree, real path and branch -- `git worktree list --porcelain`, not a glob, so a
 * worktree living outside the usual sibling-directory convention is still counted. */
export function worktrees(repoRoot = REPO_ROOT) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"],
    { cwd: repoRoot, encoding: "utf8", env: sandboxGitEnv() });
  /** @type {string[]} */
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

/** real | symlink | missing, for a path that is meant to hold either a real directory or a symlink to
 * one -- `node_modules` and `.venv` are both this shape across this repo's worktrees. */
/** @param {string} path */
export function linkState(path) {
  if (!existsSync(path)) return "missing";
  return lstatSync(path).isSymbolicLink() ? "symlink" : "real";
}

/** Every workspace package name, and whether its OWN root export actually resolves into `dist/` at all --
 * read from each package's own package.json under `packages/`, never hand-listed. The second field
 * matters: `nvda-worker`'s bare import resolves through `exports["."]` straight to `src/index.mjs`
 * (ADR 0031, no build step by design), so it needs no install-time build guarantee at all -- flagging it
 * on "resolves into dist/" alone was this check's own first false positive.
 * @param {string} repoRoot
 */
export function workspacePackages(repoRoot) {
  const dir = join(repoRoot, "packages");
  const dirsWithPackageJson = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "package.json")));
  return dirsWithPackageJson.map((e) => {
    const pkg = JSON.parse(readFileSync(join(dir, e.name, "package.json"), "utf8"));
    const rootExport = pkg.exports?.["."] ?? pkg.main ?? "";
    const rootExportsDist = /(^|\/)dist\//.test(typeof rootExport === "string" ? rootExport : JSON.stringify(rootExport));
    return { dir: e.name, name: pkg.name, rootExportsDist };
  });
}

/** Does the REPO ROOT's own `prepare` script build every workspace package? #168: per-package
 * `prepare: tsc --build` scripts used to provide the "dist/ exists after a plain npm install" guarantee
 * this check verifies -- and they RACED against each other during `npm ci`, because three packages
 * (`cli`, `judge`, `scorer`) all reference `evidence` in their own `tsconfig.json`, so npm firing all
 * five workspaces' `prepare` scripts at once could start multiple CONCURRENT `tsc --build` processes all
 * writing to `packages/evidence/dist/*` -- reproducing exactly `ci/ts`'s "wcag.d.ts is not a module"
 * symptom, a declaration file caught mid-write by a second process. The guarantee now comes from ONE
 * place instead: the root's own `prepare` (which npm also runs automatically on `npm install`, the
 * identical lifecycle hook, just at the top level rather than per-workspace) runs the SAME coordinated
 * `tsc --build` `npm run build` already uses everywhere else -- one process, so there is nothing left to
 * race with itself.
 * @param {string} repoRoot
 */
export function rootPrepareBuildsEverything(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const prepare = pkg.scripts?.prepare ?? "";
  const build = pkg.scripts?.build ?? "";
  return Boolean(build) && (prepare.includes("npm run build") || prepare.includes(build));
}

/** Which packages are imported by their BARE root specifier (`from "@a11ign/name"`, no subpath)
 * from source elsewhere in the repo -- that is the shape CLAUDE.md's own dist-resolution incident was
 * about, because a bare specifier resolves through the package's `exports`/`main` field, which for a
 * TypeScript package points into `dist/`. A SUBPATH import (`@a11ign/lab/src/x.mjs`,
 * `@a11ign/nvda-worker/error-text`) is deliberately excluded: this repo uses that shape specifically
 * to reach raw `.mjs` source with no build step at all (ADR 0031), so flagging it would be a false
 * positive -- checked against the real repo while building this, which is what found the false positives
 * a cruder "does the name appear" search produced first.
 * @typedef {{ dir: string, name: string, rootExportsDist: boolean }} WorkspacePackage
 * @param {string} repoRoot
 * @param {WorkspacePackage[]} packages
 */
export function packagesImportedByName(repoRoot, packages) {
  const bareQuoted = packages.map((p) => `from "${p.name}"`);
  const grepArgs = ["grep", "-l", "-F", ...bareQuoted.flatMap((pattern) => ["-e", pattern])];
  /** @type {string[]} */
  let rgOut;
  try {
    rgOut = execFileSync("git", grepArgs, { cwd: repoRoot, encoding: "utf8", env: sandboxGitEnv() })
      .split("\n").filter(Boolean);
  } catch {
    rgOut = []; // git grep exits 1 when nothing matches at all -- an empty result, not an error
  }
  /** @type {Set<string>} */
  const needed = new Set();
  for (const p of packages) {
    const pattern = `from "${p.name}"`;
    if (rgOut.some((f) => !f.startsWith(`packages/${p.dir}/`)
      && readFileSync(join(repoRoot, f), "utf8").includes(pattern))) {
      needed.add(p.name);
    }
  }
  return needed;
}

/** @param {string} repoRoot */
export function distTrapReport(repoRoot) {
  const packages = workspacePackages(repoRoot);
  const needed = packagesImportedByName(repoRoot, packages);
  // #168: the guarantee is now GLOBAL (the root's own prepare builds every package, once, coordinated --
  // see rootPrepareBuildsEverything's own header), not per-package -- so a package can only be exposed
  // if that global guarantee itself is missing, never by lacking an individual prepare script that would
  // have raced its siblings.
  const protectedByRoot = rootPrepareBuildsEverything(repoRoot);
  const exposed = protectedByRoot ? [] : packages.filter((p) => needed.has(p.name) && p.rootExportsDist);
  return { checked: packages.length, importedByOthers: needed.size, exposed, protectedByRoot };
}

/**
 * The refusal MESSAGE, as a pure function of the rendered rows -- or `null` when every row has a real
 * decision. #655: the first draft counted the undecided rows without naming which ones, so a reader had
 * to re-scan the whole table above to find the offender; this names them directly.
 * @param {Array<[string, string, string]>} rows
 * @returns {string | null}
 */
export function undecidedRefusal(rows) {
  const undecided = rows.filter(([, , rule]) => /we should clean|TODO|tidy/i.test(rule));
  if (undecided.length === 0) return null;
  return `REFUSING: ${undecided.length} row(s) have no recorded rule or decision, only an `
    + "intention -- that is a failed acceptance for this row by its own definition.\n"
    + `  ${undecided.map(([label]) => label).join(", ")}\n`
    + "Replace \"we should clean\"/\"TODO\"/\"tidy\" in the row(s) above with an actual rule: KEEP, DELETE, "
    + "or an explicit threshold -- the table's own job is to make that decision legible, not to defer it.";
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "npm run hygiene:report" });

  const trees = worktrees(REPO_ROOT);
  const nmStates = trees.map((t) => linkState(join(t, "node_modules")));
  const venvStates = trees.map((t) => linkState(join(t, ".venv")));
  const nmRealBytes = trees.reduce((sum, t, i) => sum + (nmStates[i] === "real" ? du(join(t, "node_modules")) : 0), 0);
  const venvRealBytes = trees.reduce((sum, t, i) => sum + (venvStates[i] === "real" ? du(join(t, ".venv")) : 0), 0);
  const runsBytes = du(join(REPO_ROOT, "runs"));
  const diskFreeOut = execFileSync("df", ["-k", homedir()], { encoding: "utf8" }).trim().split("\n").pop() ?? "";
  const diskFreeKb = Number(diskFreeOut.trim().split(/\s+/)[3]);
  const trap = distTrapReport(REPO_ROOT);

  /** @type {Array<[string, string, string]>} */
  const rows = [
    ["Worktrees registered", `${trees.length}`,
      "RULE: prune stale/fully-merged trees regularly; `git worktree remove` refuses a dirty tree by "
      + "design, which is the existing safety net. Manual practice today (dispatcher), no new command."],
    ["node_modules — real (own install)", `${nmStates.filter((s) => s === "real").length} of ${trees.length}, ${humanMb(nmRealBytes)}`,
      "DECISION, deliberately BIMODAL rather than averaged: an installed worktree costs roughly the same "
      + "regardless of size (measured 2026-09-06: 25 trees at ~169 MB each, 3.4 GB of duplicate installs), "
      + "so a mean across installed and un-installed trees would describe neither population. Real by "
      + "default; a worktree may symlink to the primary's INSTEAD only when its unit does not change "
      + "package source another worktree's test would need fresh. STRUCTURAL FIX IS `pnpm` (#57, "
      + "deliberately post-publish) — a content-addressed store makes every worktree's install nearly "
      + "free rather than a per-unit judgement call between disk and staleness risk. Measured here so "
      + "that row has a number when #57 is scheduled, not implemented by this row."],
    ["node_modules — symlinked to primary", `${nmStates.filter((s) => s === "symlink").length} of ${trees.length}`,
      "OWNER: #57 tracks the resolution risk this creates. Reported here, not re-decided here."],
    ["node_modules — missing (no install, no symlink)", `${nmStates.filter((s) => s === "missing").length} of ${trees.length}`,
      "EXPECTED for a worktree mid-setup (created but `npm install` not yet run) or one kept only for "
      + "its git history. Not a defect on its own; becomes one only if a worktree is actually being "
      + "worked in this state, which this script cannot tell from the outside."],
    [".venv — real (own copy)", `${venvStates.filter((s) => s === "real").length} of ${trees.length}, ${humanMb(venvRealBytes)}`,
      "RULE: always symlink `.venv` to the primary's, never install a fresh one per worktree -- one real "
      + "copy (the primary's) is correct; any other is the accumulator to fix by hand if this count "
      + "ever exceeds 1."],
    ["Per-worktree `dist`, for packages another package imports by name",
      `${trap.exposed.length} of ${trap.importedByOthers} exposed (${trap.checked} packages checked)`,
      trap.protectedByRoot
        ? "VERIFIED, not assumed: the repo ROOT's own `prepare` script builds every package (#168) -- one "
          + "coordinated `tsc --build`, run automatically by `npm install` the identical way a per-package "
          + "`prepare` used to, but as ONE process instead of five racing each other. That guarantee is "
          + "global, so no individual package can be exposed while it holds."
        : `RULE VIOLATED — the root's own prepare no longer builds everything (#168's own guarantee is `
          + `broken): ${trap.exposed.map((p) => p.name).join(", ")} resolve into dist/ and are imported `
          + "by name elsewhere, with nothing left to build them at install time."],
    ["Local `runs/` copy", humanMb(runsBytes),
      "RULE (already the answer, restated so nobody re-derives it): KEEP — it is what lets this machine "
      + "read the corpus at all. Staleness, not size, is the risk; `npm run lab:inventory` reports how "
      + "stale a copy is. Never delete without `orchestrator` — it is a copy several tools read."],
    ["Disk free", `${(diskFreeKb / (1024 * 1024)).toFixed(0)} GB`,
      "Informational only — not an accumulator, no rule needed at current scale."],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, measured, rule] of rows) {
    console.log(`${label.padEnd(width)}  ${measured}`);
    console.log(`  ${rule}\n`);
  }

  const refusal = undecidedRefusal(rows);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  process.exit(0);
}

// A string-concatenated `file://${path}` guard does not percent-encode, so a path containing a space
// (or another URL-reserved character) never equals `import.meta.url`, and this entry point silently
// never runs -- not a crash, not a warning, just an exit 0 that did nothing. `pathToFileURL` builds the
// comparison the way Node itself would, the exact defect class this row's own dist-trap check exists
// to catch, sitting in this row's own tooling until fixed here.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
