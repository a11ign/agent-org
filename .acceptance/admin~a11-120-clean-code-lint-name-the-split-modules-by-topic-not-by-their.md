The split modules that still named themselves after their first export (the 20 that PR #1764 left, plus three of the 17 it renamed that still name a single export: host-identity-drift, shipped-units and board-truth-readings) are renamed to a name for the topic each holds. Every import, dynamic import, path string, regex pin and comment that named one of them now names the new file, and the export names and code are unchanged. The check below reads every one of the 37 files PR #1762 split out and fails if a file's basename is the kebab-case of one of its own exports.

Acceptance:
```bash
# The naming check: every split file's basename must differ from the kebab-case of each export.
FILES=(
  src/acceptance-commands/acceptance-report-and-closure.ts
  src/acceptance-commands/command-classes-and-declarations.ts
  src/acceptance-commands/suite-and-checkout-commands.ts
  src/claim-stall/stall-causes-and-claim-readings.ts
  src/host-units/gh-wrapper-and-notes.ts
  src/host-units/host-drift-findings-and-notes.ts
  src/host-units/shipped-unit-texts-and-declarations.ts
  src/lib/source-text-reads.ts
  src/org-health/board-truth-and-access-readings.ts
  src/org-health/claim-and-tick-readings.ts
  src/org-health/fleet-build-readings.ts
  src/org-health/hold-and-rerun-readings.ts
  src/org-health/overdue-readings.ts
  src/org-health/sweep-readings.ts
  src/org-health/thresholds.ts
  src/org-retro/journal-stats-and-verdicts.ts
  src/org-retro/retro-window-and-journal-patterns.ts
  src/row-file/issue-body-and-region-checks.ts
  src/row-file/roadmap-and-milestone-checks.ts
  src/row-file/title-kind-and-label-refusals.ts
  src/ticket-mode/board-view/pull-status-and-notes.ts
  src/ticket-mode/board-view/view-types-and-filters.ts
  src/ticket-mode/queue/queue-entries-and-outcomes.ts
  src/ticket-mode/queue/queue-transitions.ts
  src/wake/ci-class-and-spares.ts
  src/wake/exit-and-limits.ts
  src/wake/fyi-delivery-and-limits.ts
  src/wake/fyi-queue.ts
  src/wake/merge-queue-wait.ts
  src/wake/pull-request-spawn-orders.ts
  src/wake/release-line-and-seats.ts
  src/wake/reviewer-tokens-and-checkouts.ts
  src/wake/seat-reset.ts
  src/wake/session-endings.ts
  src/work-gate/pr-orders/pr-gate-readings.ts
  src/work-gate/reads/read-memo-and-exit.ts
  src/work-gate/tick/tick-decisions-and-flags.ts
)
node --input-type=module - "${FILES[@]}" <<'JS'
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
const ts = createRequire(process.cwd() + "/package.json")("typescript");
const kebab = (n) => n.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase();
let failed = 0;
for (const file of process.argv.slice(2)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = [];
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) || [] : [];
    if (mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) names.push(d.name.getText(sf));
      else if (st.name) names.push(st.name.getText(sf)); else names.push("default");
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) names.push(el.name.getText(sf));
    if (ts.isExportAssignment(st)) names.push("default");
  }
  const base = basename(file, ".ts");
  const hit = names.filter((n) => kebab(n) === base);
  if (hit.length) { failed++; console.log("FAIL " + file + " named after " + hit.join(",")); } else console.log("pass " + file);
}
if (failed) { console.log(failed + " file(s) named after a single export"); process.exit(1); }
JS
```
