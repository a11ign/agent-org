/**
 * RULE: DOES THIS ROW'S BODY STATE ALL THREE REQUIRED TEMPLATE FIELDS? -- #707. See
 * `packages/agent-org/src/row-claim/template-fields-rule.mjs` for the full account: `.github/ISSUE_TEMPLATE/backlog-row.yml`
 * marks Region, Acceptance and Open-check `required`, but that is a GitHub issue FORM and applies only in
 * the web UI -- every row here is filed with `gh issue create --body`, which bypasses it entirely.
 * Measured 2026-09-09: 39 of ~65 open rows had no Open-check.
 */
// no-token: gh
//
// template-fields-rule.mjs imports `gh` from `lookups.mjs`, so the acceptance classifier charges this
// whole file for a token via `REQUIRED_FIELDS -> gh -> lookups.mjs:26` -- measured, refused this row's own
// acceptance command as filed. No test here calls `gh`: every test passes a literal string body straight
// into `missingTemplateFields`/`templateFieldsReason`, both pure functions over that string and
// `REQUIRED_FIELDS` (a plain constant), so reaching `gh` is not part of what this file tests.
import { declareWalkScope } from "../lib/walk-scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_FIELDS, missingTemplateFields, templateFieldsReason,
} from "../row-claim/template-fields-rule.mjs";

// #929: THIS GUARD READS ONLY `packages/agent-org`, so a diff that cannot reach it need not run this file.
// Undeclared means unbounded, which is why the selector runs 173 always-run guards on every pull
// request. The declaration is ENFORCED rather than trusted: `declareWalkScope` observes what this
// file actually reads and fails it here if anything lands outside the scope -- so a scope that is
// too narrow is loud, never a guard that silently stopped running.
// #2616: `.agent-org` IS IN THE SCOPE because importing `repo-identity.mjs` now reads the project's declaration, `.agent-org/project.json`;
// the read is real, so a change to it correctly reaches this file.
export const WALK_SCOPE = ["packages/agent-org", ".agent-org"];
await declareWalkScope(import.meta.url);

// --- missingTemplateFields: THE VERDICT, PURE ---

test("#707's own shape: a body with no Open-check reports exactly that field missing", () => {
  const body = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n## Acceptance\n\n```\nnpx tsx --test x\n```\n";
  assert.deepEqual(missingTemplateFields(body), ["Open-check"]);
});

test("MUTATION TARGET: a completely bare body is missing all three, named", () => {
  assert.deepEqual(missingTemplateFields("just some prose, no headings at all"), REQUIRED_FIELDS);
});

test("a body stating all three fields, real-world heading style, is complete", () => {
  const body = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
    + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
    + "## Open-check -- the command that shows this row is still open\n\n```\ngh issue view 707 --json state\n```\n";
  assert.deepEqual(missingTemplateFields(body), []);
});

test("a heading present but with NOTHING under it before the next heading is still missing -- naming "
  + "the field is not stating it, the same rule #603's owned-path sign-off already enforces", () => {
  const body = "## Region\n\n## Acceptance\n\n```\nnpx tsx --test x\n```\n\n## Open-check\n\n```\ncmd\n```\n";
  assert.deepEqual(missingTemplateFields(body), ["Region"]);
});

test("an inline `Field:` line (no heading) also counts as stated -- the same two shapes region-paths.mjs "
  + "already accepts for Region", () => {
  const body = "Region: packages/lab/src/packaging/foo.ts\n"
    + "Acceptance: npx tsx --test x\n"
    + "Open-check: gh issue view 707 --json state\n";
  assert.deepEqual(missingTemplateFields(body), []);
});

// --- templateFieldsReason: the REFUSAL, naming the field(s) ---

test("templateFieldsReason names each missing field, and the issue number", () => {
  const reason = templateFieldsReason("prose, no headings", 707);
  assert.ok(reason);
  assert.match(reason as string, /#707/);
  assert.match(reason as string, /Region/);
  assert.match(reason as string, /Acceptance/);
  assert.match(reason as string, /Open-check/);
});

test("templateFieldsReason is silent once every field is stated", () => {
  const body = "## Region\n\nfoo\n\n## Acceptance\n\nbar\n\n## Open-check\n\nbaz\n";
  assert.equal(templateFieldsReason(body, 707), null);
});
