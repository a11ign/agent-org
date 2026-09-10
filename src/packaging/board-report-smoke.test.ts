/**
 * Guard triage 4 of 6 (#906): the board's content/style guards retire with the org shape they policed.
 * What survives is this — that the board report renders at all — because a render failure is a defect a
 * reader catches slower than a build does, and the render is what a person reads before anything of the
 * board's is published. Everything the deleted tests asserted about WORDING, CAPS and SECTION DETAIL is
 * now the product-manager's own read of the rendered document, per the CI Reset's own risk acceptance:
 * "the style guards were catching a class of defect a reader catches faster, and they cost every pull
 * request to do it."
 *
 * See docs/operational-lessons.md, "Guard triage 4 of 6", for what each retired test asserted and why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../../../../scripts/board-report.mjs";

const MINIMAL_FACTS = {
  since: "2026-09-05T00:00:00.000Z",
  sinceLabel: "commits and closures since 2026-09-05T00:00:00.000Z",
  ms: null,
  merges: [],
  unpushed: null,
  strays: [],
  latestGate: null,
  gateIsFresh: true,
  fleetHours: null,
  closed: [],
  open: [],
  blockers: [],
  ready: [],
  awaiting: [],
  conflict: {
    since: "2026-09-05T00:00:00.000Z", method: "smoke test fixture",
    opened: 0, merged: 0, closedUnmerged: 0,
    lifetimeMinutes: { count: 0, medianMinutes: null, p90Minutes: null },
    reconciliation: { neededReconciliation: 0, of: 0, unresolvable: 0 },
    hotspotFiles: [],
  },
};

test("#906: the board report renders a non-empty document from a minimal, empty-everywhere fact set", () => {
  const out = render(MINIMAL_FACTS);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "render() produced an empty document");
  assert.match(out, /^# Board report/, "a rendered board must open with its own title");
});

test("#906 MUTATION TARGET: render() must not silently swallow a throwing section", () => {
  const broken = { ...MINIMAL_FACTS, conflict: null } as unknown as typeof MINIMAL_FACTS;
  assert.throws(() => render(broken),
    "a fact set missing a section render() depends on must fail loudly, not render a gap silently");
});
