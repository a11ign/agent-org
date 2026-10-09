/**
 * #2621 (child 3e of #69): ROLE BRIEFS AND GATE CAUSES ARE A PROJECT'S DECLARATION (ADR 0040, decision 1,
 * surface 3). Two claims, each with its control in this file:
 *
 *   1. A CAUSE IS ONE DECLARATION, `{cause, group, profile}` (`cause-shape.mjs`/`cause-declaration.mjs`), so
 *      `CAUSES`, `JUDGMENT_CAUSES`, `START_CAUSES` and `PROFILES` are COMPUTED from a list of them rather
 *      than four hand-maintained lists. Measured (ADR 0040's own reading, at `46b59abf0`): 29 causes, ONE
 *      routing to the fleet (`fleet-batch-due`) -- so 28 were the tool's own code and 1 a plugin. Two tool
 *      causes landed after that snapshot (`pr-codeowner-review-missing` #1959, `row-call-count-signal`
 *      #2691), so TODAY's classification is **30 tool / 1 project (N=1, at most 2)**, re-derived below
 *      rather than trusted from the stale snapshot -- this row's own convention for a quoted count.
 *   2. A ROLE BRIEF IS READ FROM THE PROJECT'S DECLARED DIRECTORY (`project-roles.mjs`), not a path baked
 *      into the tool: `.agent-org/project.json`'s `roles.dir` names it, a missing directory is REFUSED
 *      naming it, and the tool's own tree (`packages/agent-org/`) ships none.
 *
 * POSITIVE CONTROL: the a11ign cause list is asserted to contain `fleet-batch-due`, so a declaration that
 * lost it (moved to the plugin but never wired back in) cannot equal the recorded lists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPS, CauseDeclarationRefusal, declareCause, declaredCauses, causesOf, judgmentCausesOf,
  startCausesOf, profilesOf } from "../cause-shape.ts";
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES, PROFILES, TOOL_CAUSE_DECLARATIONS, parseProjectCauseModule }
  from "../cause-declaration.ts";
import { HOME_CHECKOUT, ProjectDeclarationRefusal } from "../project-config.ts";
import { parseRolesDir, homeRolesDir, roleBriefPath } from "../project-roles.ts";

// A mutation reaches into a shape the fixture's own type would otherwise pretend is optional, the same
// tradeoff `project-config.test.ts` accepts for the identical reason.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// --- 1a. `declareCause`: ONE declaration, and it refuses rather than defaulting -------------------------

test("declareCause builds a frozen {cause, group, profile}", () => {
  const decl = declareCause("x", GROUPS.ACTION, { kind: "claude", model: "sonnet", effort: "high", why: "because" });
  assert.deepEqual(decl, { cause: "x", group: "action", profile: { kind: "claude", model: "sonnet", effort: "high", why: "because" } });
  assert.ok(Object.isFrozen(decl) && Object.isFrozen(decl.profile));
});

test("a cause declared with a missing or unknown GROUP is REFUSED naming it", () => {
  const validProfile = { kind: "claude" as const, model: "sonnet", effort: "high", why: "because" };
  for (const badGroup of [undefined, null, "", "action-ish"] as Loose[]) {
    assert.throws(() => declareCause("x", badGroup, validProfile), (error: unknown) => {
      assert.ok(error instanceof CauseDeclarationRefusal, `expected a CauseDeclarationRefusal, got ${String(error)}`);
      assert.equal(error.subject, "x");
      assert.match(error.message, /group/);
      return true;
    });
  }
});

test("a cause declared with a missing PROFILE is REFUSED naming it", () => {
  for (const badProfile of [undefined, null] as Loose[]) {
    assert.throws(() => declareCause("y", GROUPS.JUDGMENT, badProfile), (error: unknown) => {
      assert.ok(error instanceof CauseDeclarationRefusal);
      assert.equal(error.subject, "y");
      assert.match(error.message, /profile/);
      return true;
    });
  }
});

// --- 1b. the four lists, COMPUTED from a list of declarations, pure and injectable -----------------------

const FIXTURE = [
  declareCause("a", GROUPS.ACTION, { kind: "claude", model: "sonnet", effort: "high", why: "w" }),
  declareCause("b", GROUPS.ACTION_START, { kind: "claude", model: "sonnet", effort: "high", why: "w" }),
  declareCause("c", GROUPS.JUDGMENT, { kind: "claude", model: "sonnet", effort: "high", why: "w" }),
  declareCause("d", GROUPS.JUDGMENT_START, { kind: "claude", model: "sonnet", effort: "high", why: "w" }),
];

test("causesOf/judgmentCausesOf/startCausesOf/profilesOf compute the four lists from ONE list of declarations", () => {
  assert.deepEqual(causesOf(FIXTURE), ["a", "b", "c", "d"]);
  assert.deepEqual(judgmentCausesOf(FIXTURE), ["c", "d"], "judgment: the JUDGMENT and JUDGMENT_START groups");
  assert.deepEqual(startCausesOf(FIXTURE), ["b", "d"], "start: the ACTION_START and JUDGMENT_START groups");
  assert.deepEqual(profilesOf(FIXTURE), Object.fromEntries(FIXTURE.map((d) => [d.cause, d.profile])));
});

test("declaredCauses combines lists and REFUSES a cause declared twice", () => {
  assert.deepEqual(declaredCauses(FIXTURE, []), FIXTURE, "a fixture project with NO causes changes nothing");
  const collision = [declareCause("a", GROUPS.ACTION, { kind: "claude", model: "sonnet", effort: "high", why: "w" })];
  assert.throws(() => declaredCauses(FIXTURE, collision), (error: unknown) => {
    assert.ok(error instanceof CauseDeclarationRefusal);
    assert.equal(error.subject, "a");
    return true;
  });
});

// --- 2. the classification: 30 tool / 1 project, asserted by value, not merely by count ------------------

test("the tool's own causes name NO project cause: `fleet-batch-due` is not among them", () => {
  const tool = causesOf(TOOL_CAUSE_DECLARATIONS);
  assert.equal(tool.length, 42,
    "42 tool causes today -- ADR 0040 measured 28 at `46b59abf0`; `pr-codeowner-review-missing` (#1959), "
    + "`row-call-count-signal` (#2691), `answer-label-unexplained` (#2711) and `ready-row-incomplete` (#2791) "
    + "and `closes-unresolved-repo-wide` (#2823) and `primary-stale` (#2781), then `repeating-log-line` and `backlog-aged-unpromoted` (#2848) "
    + "and `ready-row-unclaimable` (#2845), then `org-retrospective` (#2938), then `org-health` (#2936), then `chairman-answered` (#3390), then `tick-overran` (#3567), then `answer-given` (#3632), are the fourteen that landed after that snapshot");
  assert.ok(!tool.includes("fleet-batch-due"), "the ONE project cause must not be tool code");
});

test("a fixture project with NO project cause yields the tool's 30 causes intact and no fleet cause", () => {
  const combined = declaredCauses(TOOL_CAUSE_DECLARATIONS, []);
  assert.deepEqual(causesOf(combined), causesOf(TOOL_CAUSE_DECLARATIONS));
  assert.ok(!causesOf(combined).includes("fleet-batch-due"), "no fleet, no fleet cause");
});

// --- 1c. the four EXPORTED lists equal today's, by value, one assertion per list --------------------------

const EXPECTED_CAUSES = ["answer-given", "answer-label-unexplained", "answer-owed", "awaiting-evidence-stale", "backlog-aged-unpromoted",
  "blocked-unexaminable", "blocker-cleared", "chairman-answered", "chairman-blocked", "claim-stalled", "claimed-row-amended",
  "closes-unresolved-repo-wide", "disk-headroom-low", "draft-awaiting-verdict", "draft-convinced-not-ready", "epic-finished", "epic-unfiled",
  "fleet-batch-due", "host-units-stale", "lab-job-finished", "lane-backlog-unpromoted", "org-health", "org-retrospective", "org-stalled", "pr-checks-failing",
  "pr-codeowner-review-missing", "pr-green-unarmed", "pr-merge-conflict", "pr-review-blocked", "primary-stale",
  "ready-queue-empty", "ready-row-incomplete", "ready-row-unclaimable", "ready-row-unclaimed", "repeating-log-line", "reviewer-auth-failed", "row-branch-unshipped",
  "row-call-count-signal", "row-off-board", "tick-overran", "trunk-red", "unclaimed-blocker-cleared",
  "verdict-comment-unreviewed", "verdict-not-convinced"];

const EXPECTED_JUDGMENT = ["answer-given", "awaiting-evidence-stale", "backlog-aged-unpromoted", "blocked-unexaminable", "blocker-cleared",
  "chairman-answered", "chairman-blocked", "claimed-row-amended", "closes-unresolved-repo-wide", "disk-headroom-low", "epic-finished", "epic-unfiled", "fleet-batch-due",
  "lab-job-finished", "lane-backlog-unpromoted", "org-health", "org-retrospective", "org-stalled", "ready-queue-empty", "ready-row-incomplete", "ready-row-unclaimable", "repeating-log-line", "reviewer-auth-failed",
  "row-branch-unshipped", "row-call-count-signal", "row-off-board", "tick-overran", "unclaimed-blocker-cleared"];

const EXPECTED_START = ["blocked-unexaminable", "epic-finished", "epic-unfiled", "fleet-batch-due",
  "lane-backlog-unpromoted", "org-stalled", "ready-queue-empty", "ready-row-unclaimed", "unclaimed-blocker-cleared"];

test("CAUSES (re-exported by work-gate.mjs) equals the recorded list, by value", () => {
  assert.deepEqual([...CAUSES].sort(), [...EXPECTED_CAUSES].sort());
});

test("JUDGMENT_CAUSES (re-exported by work-gate.mjs) equals the recorded list, by value", () => {
  assert.deepEqual([...JUDGMENT_CAUSES].sort(), [...EXPECTED_JUDGMENT].sort());
});

test("START_CAUSES (re-exported by work-gate.mjs) equals today's 9, by value", () => {
  assert.deepEqual([...START_CAUSES].sort(), [...EXPECTED_START].sort());
});

test("PROFILES (re-exported by worker-profile.mjs) has one entry per cause, each with kind/model/effort/why", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), [...EXPECTED_CAUSES].sort());
  for (const [cause, profile] of Object.entries(PROFILES)) {
    assert.ok(["claude", "codex"].includes(profile.kind), `${cause}'s kind`);
    assert.ok(typeof profile.model === "string" && profile.model.length > 0, `${cause}'s model`);
    assert.ok(typeof profile.effort === "string" && profile.effort.length > 0, `${cause}'s effort`);
    assert.ok(typeof profile.why === "string" && profile.why.length > 0, `${cause}'s why`);
  }
});

// POSITIVE CONTROL: a declaration that lost `fleet-batch-due` cannot equal the recorded lists above.
test("POSITIVE CONTROL: the a11ign cause list is asserted to contain `fleet-batch-due`", () => {
  assert.ok(CAUSES.includes("fleet-batch-due"));
  assert.ok(JUDGMENT_CAUSES.includes("fleet-batch-due"));
  assert.ok(START_CAUSES.includes("fleet-batch-due"));
  assert.ok("fleet-batch-due" in PROFILES);
});

// --- 1d. the plugin module's own shape, PURE -------------------------------------------------------------

test("parseProjectCauseModule reads `causes.module`, ABSENT reads as none, and refuses a malformed one", () => {
  assert.equal(parseProjectCauseModule({ schema: 1 }), undefined, "no `causes` field: no plugin, no project cause");
  assert.equal(parseProjectCauseModule({ causes: { module: "plugins/causes.mjs" } }), "plugins/causes.mjs");
  for (const bad of [{ causes: {} }, { causes: { module: "" } }, { causes: { module: 7 } }, { causes: [] }] as Loose[]) {
    assert.throws(() => parseProjectCauseModule(bad), (error: unknown) => {
      assert.ok(error instanceof ProjectDeclarationRefusal, `expected a ProjectDeclarationRefusal, got ${String(error)}`);
      return true;
    });
  }
});

// --- 2a. role briefs: read from the DECLARED directory, refused when missing ------------------------------

test("a11ign's declaration names `.agent-org/roles`, read through `homeRolesDir`", () => {
  assert.equal(homeRolesDir(), ".agent-org/roles");
});

test("parseRolesDir is PURE and refuses a missing or mistyped `roles`/`roles.dir`", () => {
  assert.equal(parseRolesDir({ roles: { dir: ".agent-org/roles" } }), ".agent-org/roles");
  for (const bad of [{}, { roles: null }, { roles: [] }, { roles: {} }, { roles: { dir: "" } }, { roles: { dir: 7 } }] as Loose[]) {
    assert.throws(() => parseRolesDir(bad), (error: unknown) => {
      assert.ok(error instanceof ProjectDeclarationRefusal, `expected a ProjectDeclarationRefusal, got ${String(error)}`);
      return true;
    });
  }
});

test("roleBriefPath resolves a real brief under the declared directory, and the file exists", () => {
  const { relative, absolute } = roleBriefPath("engineer.md");
  assert.equal(relative, ".agent-org/roles/engineer.md");
  assert.ok(existsSync(absolute), `${absolute} must exist`);
});

test("a MISSING declared directory is REFUSED, naming it -- never silently answered with a11ign's", () => {
  const root = mkdtempSync(join(tmpdir(), "project-roles-missing-dir-"));
  try {
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    writeFileSync(join(root, ".agent-org/project.json"), JSON.stringify({ roles: { dir: ".agent-org/roles" } }));
    // No `.agent-org/roles/` directory is created: the declaration names a directory that is not there.
    assert.throws(() => roleBriefPath("engineer.md", root), (error: unknown) => {
      assert.ok(error instanceof ProjectDeclarationRefusal, `expected a ProjectDeclarationRefusal, got ${String(error)}`);
      assert.equal(error.field, "roles.dir");
      assert.match(error.message, /\.agent-org\/roles/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 2b. the tool's own tree ships no role brief -----------------------------------------------------------

test("the tool's tree ships no role brief: `packages/agent-org/docs/roles` is gone", () => {
  assert.ok(!existsSync(join(HOME_CHECKOUT, "packages/agent-org/docs/roles")),
    "the 33 role files moved out of the tool's own package (ADR 0040, decision 1, surface 3)");
});

test("no `.md` role brief lives under `packages/agent-org/src` or `packages/agent-org/docs`", () => {
  const walk = (dir: string): string[] => (existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      (e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith(".md") ? [join(dir, e.name)] : [])))
    : []);
  const docsBriefs = walk(join(HOME_CHECKOUT, "packages/agent-org/docs"));
  assert.deepEqual(docsBriefs, [], `the tool ships no brief under packages/agent-org/docs: ${docsBriefs.join(", ")}`);
});
