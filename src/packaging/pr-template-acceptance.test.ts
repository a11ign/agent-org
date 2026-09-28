/**
 * THE PR TEMPLATE MUST NOT MAKE A PR PASS THE ACCEPTANCE GATE BY DEFAULT.
 *
 * `ci.yml`'s `acceptance` job runs the commands in a PR's `Acceptance:` block and FAILS a PR that has
 * none (#353). The template exists so authors know the field is there at all — the enforcement shipped
 * first, and five open PRs failed a gate for a field nobody had been told about.
 *
 * The hazard the template introduces is the opposite one: a template that ships a placeholder command,
 * or whose guidance parses AS a command, would make every unfilled PR pass having checked nothing. That
 * is this repository's most-recorded defect arriving through the affordance rather than through the gate.
 *
 * Both halves are pinned here, against the REAL parser rather than a copy of its rules.
 */
import { declareWalkScope } from "../lib/walk-scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// A plain `.mjs`, and `scripts/**` IS in the typecheck program (#189), so this resolves and is checked.
import { extractAcceptanceSection, acceptanceReport } from "../acceptance-commands.mjs";

// #929: THIS GUARD READS ONLY `scripts`, `.github/PULL_REQUEST_TEMPLATE.md`, so a diff that cannot reach it need not run this file.
// Undeclared means unbounded, which is why the selector runs 173 always-run guards on every pull
// request. The declaration is ENFORCED rather than trusted: `declareWalkScope` observes what this
// file actually reads and fails it here if anything lands outside the scope -- so a scope that is
// too narrow is loud, never a guard that silently stopped running.
// #2619 (child 3d of #69): `.agent-org` joins the scope -- `acceptance-commands.mjs` now imports
// `RESOURCES`/`FLEET_QUESTION`/`ACCEPTANCE_FIELD`/`CLOSES_FIELD` from `project-vocabulary.mjs`, which
// reads `.agent-org/project.json` at import time.
export const WALK_SCOPE = ["scripts",".github/PULL_REQUEST_TEMPLATE.md", ".agent-org"];
await declareWalkScope(import.meta.url);

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const TEMPLATE = `${REPO}.github/PULL_REQUEST_TEMPLATE.md`;
const body = () => readFileSync(TEMPLATE, "utf8");

test("the UNFILLED template fails the acceptance gate — it must never pass by default", () => {
  const report = acceptanceReport(body(), () => 0);
  assert.equal(report.ok, false,
    "an author who opens a PR without filling in `Acceptance:` must be told so by the gate. A template "
    + "that passes unfilled certifies every PR having run nothing.");
  assert.deepEqual(report.lines, ["ACCEPTANCE: MISSING"]);
});

test("the template ships NO runnable command — not even a harmless-looking one", () => {
  const section = extractAcceptanceSection(body());
  assert.equal(section.kind, "missing",
    "a placeholder command in the template would run on every PR that left it in place, and would pass. "
    + "`npm run lint` as a default is exactly the kind of harmless-looking line that produces a green "
    + "check nobody chose.");
});

test("guidance sits ABOVE the header, because an HTML comment after it parses as a COMMAND", () => {
  // Measured against the real parser: `Acceptance:\n<!-- guidance -->` yields
  // commands: ["<!-- guidance -->"], which the job would hand to bash. GitHub's own template convention
  // is HTML comments, so this is the shape a well-meaning edit reintroduces.
  const lines = body().split("\n");
  const header = lines.findIndex((l) => /^\s*Acceptance:/.test(l));
  assert.ok(header >= 0, "the template must carry an `Acceptance:` header at all.");
  const next = lines[header + 1] ?? "";
  assert.ok(next.trim() === "" || /^(?:\*\*|__)?Mutation:/i.test(next.trim()),
    "the line after `Acceptance:` must be blank (or `Mutation:`). Anything else — an HTML comment most "
    + `likely — is read as a command to run. Found: ${JSON.stringify(next)}`);
});

test("the guidance names the three refusal classes, so an author is not surprised by a REFUSED verdict", () => {
  // Not a style assertion: a `REFUSED` line in the job output is only useful if the author already knows
  // that class exists. Otherwise it reads as the gate being broken.
  const text = body();
  for (const needle of ["fleet:", "runs/", "none —"]) {
    assert.ok(text.includes(needle),
      `the template must mention \`${needle}\` so the author knows why a command would be refused rather `
      + "than run, and what the deliberate opt-out looks like.");
  }
});
