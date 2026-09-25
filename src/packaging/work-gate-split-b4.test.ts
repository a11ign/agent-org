// no-token: gh -- reaches `fileOverlapReason` through `row-claim/file-overlap-rule.mjs`, whose own `lookup*` readers spawn `gh`; nothing here calls one (#2542)
/**
 * #2542: THE B4 POSITIVE CONTROL OF THE `work-gate.mjs` SPLIT.
 *
 * The split exists because B4 (`row-claim/file-overlap-rule.mjs`) compares a row's Region against the files of open
 * pull requests, so two org fixes that both name `work-gate.mjs` serialise even when they edit different orders.
 * Moving the pull-request orders into `work-gate/pr-orders.mjs` only helps if a Region NAMING that module is still
 * a Region B4 reads. This is the control: two Regions that both name the module DO collide, so a fix to one of its
 * orders waits behind another fix to one of its orders, and behind nothing else.
 *
 * WHAT THIS DOES NOT CLAIM. The negative half -- two Regions naming two DIFFERENT family modules do not collide --
 * needs a second family module and lands with the row that extracts it (#2542's Done-when 2). Until then this is
 * the only half a single module can support, and it is not evidence that the split reduces collisions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileOverlapReason } from "../row-claim/file-overlap-rule.mjs";
import { declaredRegionFiles } from "../region-paths.mjs";

const MODULE = "packages/agent-org/src/work-gate/pr-orders.mjs";
const SHIM = "packages/agent-org/src/work-gate.mjs";

/** A row body whose fenced Region names the given files, in the shape `row-file.mjs` files them. */
const rowBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n`;

/** An open PR whose file list is COMPLETE (#1419 compares the count to the list). */
const pr = (number: number, files: string[]) => ({ number, files, changedFiles: files.length });

/** The Region as B4 reads it, from the row body -- with no root files, so the read does not depend on `origin/main`. */
const regionOf = (...files: string[]) => declaredRegionFiles(rowBody(...files), { rootFiles: new Set() }) ?? [];

test("#2542: the module the row moves the orders into exists, and is a path a Region can name", () => {
  assert.ok(existsSync(new URL(`../../../../${MODULE}`, import.meta.url)), `${MODULE} must exist or the Regions below name nothing`);
  assert.deepEqual(regionOf(MODULE), [MODULE], "the fenced Region parses to the module's own path");
});

test("#2542 DONE-WHEN 2: two Regions that both name work-gate/pr-orders.mjs COLLIDE", () => {
  const first = regionOf(MODULE, "packages/lab/src/packaging/work-gate.test.ts");
  const second = pr(2600, regionOf(MODULE));
  const { reason } = fileOverlapReason(first, [second]);
  assert.ok(reason, "one fix to an order in the module must wait behind another fix to an order in the module");
  assert.match(reason as string, /#2600/, "and the refusal names the PR it waits behind");
  assert.match(reason as string, /work-gate\/pr-orders\.mjs/, "and the file it collides on");
});

test("#2542: the control is not a function that refuses everything -- a Region NOT naming the module goes through", () => {
  const unrelated = pr(2601, regionOf("packages/agent-org/src/wake.mjs"));
  assert.equal(fileOverlapReason(regionOf(MODULE), [unrelated]).reason, null,
    "POSITIVE CONTROL for the collision above: the same call with the file changed is quiet");
  assert.equal(fileOverlapReason(regionOf("packages/agent-org/src/wake.mjs"), [pr(2602, regionOf(MODULE))]).reason, null,
    "and it is symmetric: a Region on the other file is not held back by a PR on the module");
});

test("#2542: a Region naming the SHIM still collides with a PR on the shim, and not with one on the module", () => {
  // This row leaves `work-gate.mjs` as the entry point, so an edit to `CAUSES` or `decide` still meets another there
  // (the KNOWN LIMIT of the row). What it delivers is the second assertion below: an order in the module and a fix
  // in the file that stays are different files to B4. It is NOT the two-family-modules negative of Done-when 2.
  assert.ok(fileOverlapReason(regionOf(SHIM), [pr(2603, regionOf(SHIM))]).reason,
    "the registries stay in the shim, so two fixes to them still serialise: the split does not reach them");
  assert.equal(fileOverlapReason(regionOf(SHIM), [pr(2604, regionOf(MODULE))]).reason, null,
    "but a fix to the shim and a fix to an order in the module do NOT wait for each other");
});
