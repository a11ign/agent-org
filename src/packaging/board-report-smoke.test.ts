// no-token: REPO
// This file imports board-report.mjs, whose closure reads REPO from board-data.mjs, which spawns `gh`. Every test here
// renders from an injected fact set and, since #1442, an injected instant; nothing here calls or spawns it.
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

// --- #1442: the title's day is LONDON's, from editionDay, at an injected instant ---

test("#1442: the title names LONDON's day -- 23:30Z in BST is already the 14th", () => {
  // 2026-09-13T23:30Z is 00:30 BST on 14 September. A UTC slice titled it the 13th: the split #1302 removed from every
  // other edition script, one reader further on (board-schedule-liveness reads a day from this heading).
  assert.match(render(MINIMAL_FACTS, new Date("2026-09-13T23:30:00Z")), /^# Board report — 2026-09-14\n/);
});

test("#1442 POSITIVE CONTROL: at 07:13Z both zones agree, and in GMT 23:30Z is still the same day", () => {
  // A test asserting only these would pass for either zone; the BST case above is the one that decides.
  assert.match(render(MINIMAL_FACTS, new Date("2026-09-13T07:13:00Z")), /^# Board report — 2026-09-13\n/);
  assert.match(render(MINIMAL_FACTS, new Date("2026-12-13T23:30:00Z")), /^# Board report — 2026-12-13\n/);
});
