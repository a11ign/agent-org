/**
 * #1140: THE ONE TEST THAT ASKS GITHUB WHICH `session:*` LABELS EXIST, MOVED OUT OF `arm-pr.test.ts`.
 *
 * `arm-pr.test.ts` declares `// no-token: gh`, and this test spawned `gh` by string inside it. #827's check read
 * only a call shape (`gh(`), so the declaration held while the file spawned the command it disclaimed; #1140 made
 * the check read a string spawn too, and that file's declaration then refused. The opt-in flag below kept the
 * acceptance job from spawning, but a static check cannot see a flag -- so the test lives here, UNDECLARED, and
 * the parser charges this file `token`, which is the truth about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { LIVE_SESSIONS, RETIRED_SESSIONS } from "../../../../scripts/arm-pr.mjs";

test("#1000: every `session:*` label that EXISTS is classified -- asked of GitHub, skipped honestly", () => {
  // THE COVERAGE HALF, and it cannot be a literal: the question is "which labels exist", which only the
  // repository can answer. CI has no token, so this says so rather than passing -- a check that cannot ask
  // must report that, which is this repo's own rule and the reason the skip prints.
  // OPT-IN, and that is not timidity: a test that spawns `gh` whenever a token happens to be present asks
  // GitHub on every local run. The flag keeps the acceptance job from ever spawning, and an agent asks
  // deliberately.
  if (process.env.A11Y_CHECK_SESSION_LABELS !== "1") {
    console.log("  NOT RUN: the label coverage check is opt-in -- `A11Y_CHECK_SESSION_LABELS=1 npx tsx "
      + "--test packages/lab/src/packaging/arm-pr-labels-live.test.ts` asks GitHub which `session:*` labels exist. The "
      + "disjointness test in arm-pr.test.ts ran; nothing here checked that the two lists COVER them.");
    return;
  }
  let labels: string[];
  try {
    labels = JSON.parse(execFileSync("gh",
      ["label", "list", "--repo", "DanBeckDev/a11y-witness", "--limit", "200", "--json", "name"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))
      .map((l: { name: string }) => l.name).filter((n: string) => n.startsWith("session:"));
  } catch {
    console.log("  SKIPPED: `gh label list` could not be asked (no token here). NOT a pass -- the "
      + "disjointness test in arm-pr.test.ts still ran, but nothing checked that the two lists COVER the labels that "
      + "exist. Run this locally with a token before trusting the split.");
    return;
  }
  const classified = new Set([...LIVE_SESSIONS, ...RETIRED_SESSIONS].map((s) => `session:${s}`));
  const unclassified = labels.filter((l) => !classified.has(l)).sort();
  assert.deepEqual(unclassified, [],
    `these \`session:*\` labels exist and are neither live nor retired: ${unclassified.join(", ")}. A new `
    + "session must be added to LIVE_SESSIONS in arm-pr.mjs, or arm-pr will refuse every row it claims.");
  const missing = [...classified].filter((l) => !labels.includes(l)).sort();
  assert.deepEqual(missing, [],
    `these are classified in arm-pr.mjs and no longer exist as labels: ${missing.join(", ")}`);
});
