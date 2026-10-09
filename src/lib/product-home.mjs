#!/usr/bin/env node
// COPIED FROM `scripts/product-home.mjs` at cd4bdb7dc (#2658, child 3g of #69; ADR 0040, decision 4): the tool's own copy, so `agent-org` imports nothing outside
// its package. The product keeps its original and the two can drift, with no cross-repository pin: `agent-org-outward-edges.test.ts` compares them.
// CHANGED FROM THE ORIGINAL, 3 NAMED LINES:
// - `REPO_ROOT`, now the project's checkout (`HOME_CHECKOUT`) and not one directory above `scripts/`, which from four directories below is the HOME directory here (#3074)
// - its import of `node:path`, which no longer needs `dirname` or `resolve`
// - its import of `fileURLToPath`, which `REPO_ROOT` was the only user of
// ==== end of copy header ====
// @ts-check
// THE PRODUCT'S HOME, READ FROM THE MANIFEST RATHER THAN WRITTEN DOWN AGAIN -- a LEAF module, deliberately:
// `node:fs` and `node:path` and nothing else.
//
// #1113. The homepage was stated in EIGHT places. Seven -- six published manifests and the README -- are
// pinned equal by `homepage-agreement.test.ts`. The eighth was a literal in `board-document.mjs`, and it
// was the one the BOARD reads. So the copy nobody compared was the copy with the most expensive reader.
//
// WHY THIS IS A LEAF AND NOT A FUNCTION IN `board-document.mjs`. The guard has to reach this value to
// compare it, and `board-document.mjs` needs `token` -- `publishToDraftRelease` spawns `gh` (#1290 removed
// `todaysReleaseExists`, which this line used to name).
// Importing it into `homepage-agreement.test.ts` would move that file from `[]` to `["token"]` in #827's
// closure walk and disqualify it from the job that runs acceptance commands. Measured with the real
// deriver, both before and after. Same extraction, same reason, as `region-paths.mjs` (#462, B4).
//
// WHY ONE MANIFEST IS ENOUGH, and this is the part that would otherwise read as a shortcut: the six
// published manifests are not six facts. `homepage-agreement.test.ts` makes them ONE, and fails if any
// drifts. So reading the product's own package is reading the fact, not sampling it -- and if that guard
// is ever weakened, this stops being true and that is the guard's problem to refuse, not this file's to
// duplicate.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.ts";

// The product's manifest is the PROJECT's file. This used to be `src/lib` up four, which is the monorepo's root and is the HOME directory in this repository (#3074).
const REPO_ROOT = HOME_CHECKOUT;

/** The package that IS the product -- `a11ign`, the CLI a stranger installs. */
const PRODUCT_PACKAGE = "packages/cli/package.json";

/**
 * The URL the product calls home, or null when the manifest states none.
 *
 * NULL RATHER THAN A FALLBACK. A default here would be a ninth copy, and it would be the one that wins
 * silently on the day the manifest loses its `homepage` -- which is the state `homepage-agreement.test.ts`
 * already treats as a DISAGREEMENT rather than an exclusion. A caller that cannot render without it should
 * say so; this file will not invent one.
 *
 * @param {string} [repoRoot]
 * @returns {string | null}
 */
export function productHome(repoRoot = REPO_ROOT) {
  const manifest = /** @type {{ homepage?: unknown }} */ (
    JSON.parse(readFileSync(join(repoRoot, PRODUCT_PACKAGE), "utf8")));
  return typeof manifest.homepage === "string" && manifest.homepage !== "" ? manifest.homepage : null;
}

/** Where the value is read from, so a failure message can name a file rather than a function. */
export const PRODUCT_HOME_SOURCE = PRODUCT_PACKAGE;
