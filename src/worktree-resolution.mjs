// @ts-check
// #2181: WHERE DO THIS TREE'S `@a11ign/*` ACTUALLY RESOLVE? The question a green suite cannot answer.
//
// Measured on the agent host 2026-09-23: 42 of 56 linked worktrees resolve `@a11ign/agent-org` to
// `/home/agent/repos/a11y-witness/packages/agent-org` -- the PRIMARY checkout -- because their whole
// `node_modules` is a symlink to the primary's. A test in such a tree that imports `@a11ign/agent-org`
// reads `main`, while the file the branch changed sits untouched beside it. `worker-judge` reproduced
// both directions on `wt-1561`: with the symlink, `npm run test:all` gave 7,253 passed / 0 failed at a
// head CI was failing, and deleting `windowSize` from a fixture left the mutant ALIVE (14 pass / 0 fail);
// with a hybrid `node_modules` plus `npm run build`, the same deletion gave 9 pass / 5 fail, matching CI.
//
// THE SYMLINK IS DELIBERATE AND IS NOT THE DEFECT. It is what keeps 42 trees from each carrying a real
// `node_modules` (#57 measures the third-party share at 2.9G, and removes the symlink only after the
// first publish). The defect is that NOTHING SAYS the tree you are testing in is not the tree you are
// testing. This file says it, and says nothing else: it REPORTS, it does not refuse. A refusal firing on
// 42 of 56 trees on the day it landed would stop the org -- report first, the same order #2012/#2146
// followed for `worktrees:prune`.
//
// THREE ANSWERS, AND THE THIRD IS THE ONE THAT MATTERS. A classifier that asks only "inside or outside
// this worktree" gets the first two right and calls the third SAFE. `wt-1315` on this host resolves
// `@a11ign/agent-org` to its own `node_modules/@a11ign/agent-org` -- a real directory inside the tree,
// neither the primary's source nor the branch's, a copy frozen at whenever it was installed. Inside the
// worktree, and every bit as false as the primary's. So the `node_modules/` test is asked BEFORE the
// containment test, never after.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** The scope in which a package specifier can lie about which checkout it reads. */
const SCOPE = "@a11ign";

/**
 * What a worktree's `@a11ign/*` resolve to. Four answers, and only the first is safe.
 *
 * `NOTHING_LINKED` is not a fourth-wheel case: a tree `row-claim ... claim` has just created has no
 * `node_modules` at all, which is the commonest state of a brand-new tree and must not be folded into
 * `OWN_PACKAGES`. "Nothing resolves" and "everything resolves to your own source" are different facts
 * and the second is the one that licenses a suite run.
 */
export const RESOLUTION = Object.freeze({
  OWN_PACKAGES: "own-packages",
  OTHER_CHECKOUT: "other-checkout",
  STALE_COPY: "stale-copy",
  NOTHING_LINKED: "nothing-linked",
});

/**
 * Worst first. A tree showing more than one kind is reported by the most severe it shows, because the
 * reader's question is "may I trust a suite run here", and one lying package answers it.
 *
 * `OTHER_CHECKOUT` outranks `STALE_COPY` for one reason and it is not that it is more wrong: it NAMES
 * the checkout it is reading, so the reader can act on it in one line. Both falsify a run.
 */
const SEVERITY = [RESOLUTION.OTHER_CHECKOUT, RESOLUTION.STALE_COPY, RESOLUTION.OWN_PACKAGES];

/**
 * The real path of `path`, or null when it does not resolve.
 *
 * A DANGLING LINK IS NOT AN ERROR HERE. A hybrid `node_modules` built for a package this branch has since
 * deleted leaves exactly that, and throwing would make the report unavailable in the one tree most likely
 * to need it.
 *
 * @param {string} path @param {{ realpath?: typeof realpathSync }} [deps] @returns {string | null}
 */
function realOrNull(path, { realpath = realpathSync } = {}) {
  try {
    return realpath(path);
  } catch {
    // An absence, not a swallowed failure: the caller turns null into a named `nothing-linked` entry.
    return null;
  }
}

/**
 * True when `path` is `prefix` itself or sits under it -- never a bare `startsWith`, which matches
 * `packages-old` from `packages`.
 *
 * @param {string} path @param {string} prefix @returns {boolean}
 */
function isUnder(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The checkout a resolved package belongs to, for naming it back to the reader.
 *
 * @param {string} resolved @returns {string}
 */
function checkoutOf(resolved) {
  for (const marker of ["/packages/", "/node_modules/"]) {
    const at = resolved.indexOf(marker);
    if (at !== -1) return resolved.slice(0, at);
  }
  return resolved;
}

/**
 * Which of `RESOLUTION`'s answers a single resolved path is, given the tree it was read from.
 *
 * ORDER IS THE WHOLE CONTENT OF THIS FUNCTION. `node_modules` is asked before containment, because a copy
 * under the tree's own `node_modules` is INSIDE the tree and is not the tree's source.
 *
 * @param {string} realWorktree the worktree's own real path @param {string} resolved
 * @returns {{ kind: string, checkout: string | null }}
 */
export function classifyResolvedPath(realWorktree, resolved) {
  if (isUnder(resolved, join(realWorktree, "node_modules"))) return { kind: RESOLUTION.STALE_COPY, checkout: null };
  if (isUnder(resolved, join(realWorktree, "packages"))) return { kind: RESOLUTION.OWN_PACKAGES, checkout: null };
  return { kind: RESOLUTION.OTHER_CHECKOUT, checkout: checkoutOf(resolved) };
}

/**
 * Every `@a11ign/*` link in `worktree`, classified, with what it resolved to.
 *
 * @param {string} worktree
 * @param {{ exists?: typeof existsSync, list?: typeof readdirSync, realpath?: typeof realpathSync }} [deps]
 * @returns {Array<{ name: string, kind: string, resolved: string | null, checkout: string | null }>}
 */
export function resolvedScopeEntries(worktree, { exists = existsSync, list = readdirSync, realpath = realpathSync } = {}) {
  const scopeDir = join(worktree, "node_modules", SCOPE);
  if (!exists(scopeDir)) return [];
  const realWorktree = realOrNull(worktree, { realpath }) ?? worktree;
  return list(scopeDir).sort().map((name) => {
    const resolved = realOrNull(join(scopeDir, name), { realpath });
    if (resolved === null) return { name, kind: RESOLUTION.NOTHING_LINKED, resolved: null, checkout: null };
    return { name, resolved, ...classifyResolvedPath(realWorktree, resolved) };
  });
}

/**
 * The worktree's own answer: the most severe kind any of its `@a11ign/*` shows, and the entries behind it.
 *
 * @param {string} worktree
 * @param {{ exists?: typeof existsSync, list?: typeof readdirSync, realpath?: typeof realpathSync }} [deps]
 * @returns {{ kind: string, entries: ReturnType<typeof resolvedScopeEntries>, checkouts: string[] }}
 */
export function worktreeResolution(worktree, deps = {}) {
  const entries = resolvedScopeEntries(worktree, deps);
  const kinds = new Set(entries.map((e) => e.kind));
  const kind = SEVERITY.find((k) => kinds.has(k)) ?? RESOLUTION.NOTHING_LINKED;
  const checkouts = [...new Set(entries.map((e) => e.checkout).filter((c) => c !== null))].sort();
  return { kind, entries, checkouts };
}

/**
 * How many of `entries` carry `kind`.
 *
 * @param {Array<{ kind: string }>} entries @param {string} kind @returns {number}
 */
function countOf(entries, kind) {
  return entries.filter((e) => e.kind === kind).length;
}

/**
 * What the reader is told. One line per worktree, naming the kind, the count and -- for the outside case
 * -- the checkout actually being read, because that is the fact that ends the reader's investigation.
 *
 * @param {string} worktree @param {ReturnType<typeof worktreeResolution>} result @returns {string}
 */
export function resolutionLine(worktree, { kind, entries, checkouts }) {
  const total = entries.length;
  if (kind === RESOLUTION.NOTHING_LINKED) {
    return `${worktree}: no @a11ign/* resolve here -- node_modules is absent or empty of them. Not "safe": `
      + "nothing has been measured. `ln -s <primary>/node_modules node_modules` shares the primary's and "
      + "makes this tree read the PRIMARY's packages; a hybrid link plus `npm run build` makes it read this branch.";
  }
  if (kind === RESOLUTION.OWN_PACKAGES) {
    return `${worktree}: all ${total} @a11ign/* resolve to this worktree's own packages/ -- a suite run here `
      + "measures this branch. Cross-package imports still read `dist/`, so `npm run build` after a source edit.";
  }
  if (kind === RESOLUTION.STALE_COPY) {
    return `${worktree}: ${countOf(entries, RESOLUTION.STALE_COPY)} of ${total} @a11ign/* resolve to a COPY under `
      + "this tree's own node_modules/, not to its packages/. Inside the worktree and still not its source: a "
      + "run here measures whenever that copy was installed. Replace node_modules/@a11ign with links to this "
      + "tree's packages/, then `npm run build`.";
  }
  return `${worktree}: ${countOf(entries, RESOLUTION.OTHER_CHECKOUT)} of ${total} @a11ign/* resolve OUTSIDE this `
    + `worktree, to ${checkouts.join(", ")} -- a suite run here measures that checkout and not this branch. `
    + "That is how 7,253 passed at a head CI was failing (#2181). Replace node_modules/@a11ign with links to "
    + "this tree's packages/, keeping the third-party entries symlinked, then `npm run build`.";
}
