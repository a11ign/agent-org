/**
 * #513: split out of `row-claim.test.ts`, verbatim -- this file's one test needs a real GitHub API call,
 * and the other 52 tests in `row-claim.test.ts` need nothing. A file-scoped requirement covering only one
 * of them would refuse `Acceptance:`/`Refutation:` usage of a file whose other 52 tests are pure, which is
 * why this test lives on its own now rather than gaining a bespoke per-test guard.
 *
 * It failed CI on 2026-09-08, on PR #504, whose change had nothing to do with it: the `acceptance` job
 * declares `permissions: contents: read` and nothing else, so a call reaching `issues` (which needs
 * `issues: read`) fails there -- correctly, since that job runs commands taken from an arbitrary PR body.
 * The failure named #504's author as the person with a problem, for a line neither they nor their change
 * ever touched. See #513.
 *
 * `// requires: token` (#510/B8) goes on this file once that mechanism lands -- deliberately not yet: B8
 * is still in flight, and this move is independently correct with or without it. Recorded here so a reader
 * of this header does not read the header's absence as forgotten rather than sequenced.
 */
// requires: token
//
// #510/B8: this job's `token` capability is structurally always false (contents: read only, see the header
// above), so `acceptance-commands.mjs` REFUSES a `tsx --test` command naming this file, named, before ever
// reaching the API call that used to fail unattributed. Naming this file alone -- never the whole
// `row-claim.test.ts` -- is what #513 built the split for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fetchLabels, filedByLine } from "../../../../scripts/row-claim.mjs";

// --- Live, read-only smoke test against the real repo ---

test("fetchLabels against the real #55 succeeds structurally, live", () => {
  // Not asserting a specific claimed state -- issue state can move. The contract under test is narrower:
  // a real gh call against a real, existing issue returns a well-formed result without throwing.
  const result = fetchLabels(55);
  assert.equal(result.number, 55);
  assert.ok(Array.isArray(result.labels));
});

function liveBody(n: number): string {
  return JSON.parse(execFileSync("gh",
    ["issue", "view", String(n), "--repo", "DanBeckDev/a11y-witness", "--json", "body"],
    { encoding: "utf8" })).body;
}

// --- #771: filedByLine, against the REAL #737 and #758 -- the issue's own named fixtures ---

test("#771 ACCEPTANCE, LIVE: #737 and #758 both carry only the OLDER 'Filed by `orchestrator`' prose "
  + "(no hyphen, no colon-value line) -- filedByLine must read both as absent, never infer from it", () => {
  for (const n of [737, 758]) {
    const body = liveBody(n);
    assert.match(body, /Filed by `orchestrator`/,
      `#${n} no longer carries the prose this test is named for -- re-check the fixture`);
    assert.equal(filedByLine(body), null,
      `#${n}'s older prose must never be read as a Filed-by: line`);
  }
});
