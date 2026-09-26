#!/usr/bin/env node
// COPIED FROM `packages/guards/src/changed-files.mjs` at cd4bdb7dc (#2658, child 3g of #69; ADR 0040, decision 4): the tool's own copy, so `agent-org` imports nothing outside
// its package. The product keeps its original and the two can drift, with no cross-repository pin: `agent-org-outward-edges.test.ts` compares them.
// CHANGED FROM THE ORIGINAL, ONE LINE: its one sibling import, which was `../../worker-fleet/src/cli-flags.mjs` and is now the tool's own copy beside it.
// ==== end of copy header ====
// @ts-check
// command: list the paths a range changed, BOTH SIDES OF A RENAME
//
// THE ONE PLACE THIS REPOSITORY ASKS GIT "WHICH PATHS DID THIS CHANGE TOUCH" -- #939.
//
// `git diff --name-only` detects renames by default and prints only where a file WENT: a change moving
// `scripts/a.mjs` to `tools/a.mjs` listed `tools/a.mjs` alone. Reproduced in a sandbox, and pinned by
// `changed-files-renames.test.ts` rather than described:
//
//     git diff --name-only HEAD~1 HEAD                -> tools/a.mjs
//     git diff --name-only --no-renames HEAD~1 HEAD   -> scripts/a.mjs  tools/a.mjs
//
// For most readers the missing source path is a smaller population than the truth. For the LANE CHECK it was
// a bypass: a pull request moving a file OUT of another session's lane was not seen by the check that owns
// that lane. Nine readers asked the question and each spelled it itself; #938 fixed one of them.
//
// A LEAF MODULE, like `region-paths.mjs`: its only import is `git-env.mjs`, which imports nothing, so
// `ci-changed.mjs` -- an entry that runs before `npm ci` -- can use it without gaining a package specifier.
// `select-changed-tests.mjs` re-exports it rather than keeping the copy #938 wrote there.
//
// A FLAG ADDED AT NINE CALL SITES IS NINE COPIES OF A PREDICATE, and a tenth reader would write its own.
// So this takes the range VERBATIM -- `origin/main...HEAD`, `<sha> <sha>`, a bare ref -- and adds only the
// flag and the sandboxed environment, leaving each caller's own semantics exactly as they were.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { sandboxGitEnv } from "./git-env.mjs";
// RELATIVE, NOT `@a11ign/worker-fleet/cli-flags`, for the reason `ci-changed.mjs` records above its own:
// this module is reachable from a pre-install entry, and a package specifier there dies with
// ERR_MODULE_NOT_FOUND before `npm ci` finishes. `cli-flags.mjs` imports only `node:` builtins, so the
// leaf property above survives the import -- `pre-install-import-graph.test.ts` is what checks that, and
// it walks relative imports rather than taking this comment's word for it.
import { refuseUnknownFlags } from "./cli-flags.mjs";

/**
 * The paths a range changed, repo-relative, with the source side of every rename included.
 *
 * @param {string[]} range the range as its caller spells it, e.g. `["origin/main...HEAD"]` or `["a", "b"]`
 * @param {{ repoRoot?: string, pathspec?: string[] }} [options] `pathspec` narrows to those paths, after `--`
 * @returns {string[]}
 */
export function changedFiles(range, { repoRoot = process.cwd(), pathspec = [] } = {}) {
  const args = ["diff", "--name-only", "--no-renames", ...range,
    ...(pathspec.length > 0 ? ["--", ...pathspec] : [])];
  return execFileSync("git", args, { cwd: repoRoot, env: sandboxGitEnv(), encoding: "utf8" })
    .split("\n").filter(Boolean);
}

// The CLI half, for the workflow steps that cannot import: `node packages/guards/src/changed-files.mjs origin/main...HEAD`
// prints one path per line, which is what `> /tmp/lane-changed.txt` wants.
//
// `realpathSync` on argv[1], because without it the guard below silently does not fire through a symlink
// and a mistyped flag is ignored -- #237, documented in `refuseUnknownFlags` itself.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--");
  // GUARDED ON THE RANGE SIDE ONLY (#164's census, #939's shape). This command takes no flags of its own:
  // everything before `--` is a revision range, which is positional and never starts with a dash. What
  // comes AFTER `--` is a git PATHSPEC, git's language and not this wrapper's to validate -- the same
  // boundary `pr-open.mjs` draws at its mode word, drawn here inside the file rather than by exempting it.
  refuseUnknownFlags([], {
    entry: import.meta.url,
    argv: at === -1 ? argv : argv.slice(0, at),
    command: "node packages/guards/src/changed-files.mjs",
  });
  if (argv.length === 0) {
    console.error("usage: node packages/guards/src/changed-files.mjs <range...> [-- <pathspec...>]");
    process.exit(2);
  }
  const pathspec = at === -1 ? [] : argv.slice(at + 1);
  console.log(changedFiles(at === -1 ? argv : argv.slice(0, at), { pathspec }).join("\n"));
}
