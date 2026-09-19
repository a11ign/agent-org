/**
 * `packages/agent-org/src/worker-profile.mjs` -- which model and effort a wake order's CAUSE deserves.
 *
 * THE TESTS THAT MATTER HERE ARE THE REFUSALS AND THE POLICY TIE. A routing table is trivial code whose
 * defects are all in what it does with a case nobody listed: an unknown cause that silently becomes
 * opus/xhigh restores the spend the table exists to end, and one that silently becomes haiku/low gives
 * hard work to a tier that cannot do it. Both hide. So the refusal is pinned, in both directions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROFILES, EFFORTS, MODELS, profileFor, agentArgs }
  from "../worker-profile.mjs";

/** A `why` shorter than this is a label, not an argument. */
const MIN_WHY_CHARS = 40;

const PRACTICES = readFileSync(
  new URL("../../../../.claude/rules/agent-practices.md", import.meta.url), "utf8");
const GATE = readFileSync(new URL("../work-gate.mjs", import.meta.url), "utf8");

/** The two shapes `profileFor` and `spawnInvocation` return, and narrowing that ASSERTS rather than casts. */
type Profile = { kind: string; model: string; effort: string; why: string };
type Refusal = { refusal: string };
function refusalOf(got: Profile | Refusal | { args: string[]; profile: unknown }): Refusal {
  assert.ok("refusal" in got, `expected a refusal, got ${JSON.stringify(got)}`);
  return got as Refusal;
}
function profileOf(got: Profile | Refusal): Profile {
  assert.ok(!("refusal" in got), `expected a profile, got ${JSON.stringify(got)}`);
  return got as Profile;
}


/**
 * THE CONTROL ON THE WHOLE TABLE. Every other test here reads `PROFILES`, so an empty one would pass
 * them all having routed nothing -- and this file's subject is precisely that nothing is left unrouted.
 */
test("every cause work-gate can actually emit has a profile, and nothing else does", () => {
  const emitted = [...GATE.matchAll(/cause: "([a-z-]+)"/g)].map((m) => m[1]).sort();
  assert.ok(emitted.length > 0, "read no causes out of work-gate.mjs -- this guard cannot see its population");
  assert.deepEqual(Object.keys(PROFILES).sort(), [...new Set(emitted)].sort(),
    "a cause work-gate emits with no profile refuses at run time, and a profile for a cause that no "
    + "longer exists is a routing decision nothing will ever read");
});

test("an unknown cause is REFUSED, never defaulted -- both defaults hide", () => {
  const got = profileFor("some-cause-nobody-listed");
  assert.ok("refusal" in got, "defaulting an unknown cause is how opus-everywhere came back last time");
  assert.match(refusalOf(got).refusal, /no profile for cause "some-cause-nobody-listed"/);
  assert.match(refusalOf(got).refusal, /Known causes: /,
    "the refusal must name what IS known, or the person hitting it cannot act on it");
});

/**
 * The policy is `.claude/rules/agent-practices.md`'s, ruled for subagents and applied here to whole
 * workers. This asserts the tie rather than the wording: if the rule is ever relaxed to allow opus by
 * default, this test is where that shows up.
 */
test("the routing policy this table implements is still the one in agent-practices.md", () => {
  assert.match(PRACTICES, /`model="sonnet"` for analysis and judgment over gathered material/);
  assert.match(PRACTICES, /`model="opus"` only for multi-step reasoning that a cheaper tier has measurably got wrong/);
});

test("no CLAUDE worker starts on opus -- reserved for a measured failure that has not happened", () => {
  for (const [cause, profile] of Object.entries(PROFILES)) {
    if (profile.kind !== "claude") continue;
    assert.notEqual(profile.model, "opus",
      `${cause} starts on opus, which agent-practices reserves for a cheaper tier MEASURABLY getting it `
      + "wrong; if that measurement now exists, cite the run in the profile's `why` and change this test");
  }
});

test("every profile names an effort ITS OWN product accepts -- the two vocabularies differ", () => {
  for (const [cause, profile] of Object.entries(PROFILES)) {
    const allowed = (EFFORTS as unknown as Record<string, readonly string[]>)[profile.kind];
    assert.ok(allowed, `${cause}: "${profile.kind}" is not an agent kind with a known effort vocabulary`);
    assert.ok(allowed.includes(profile.effort),
      `${cause}: "${profile.effort}" is not valid for ${profile.kind} (${allowed.join(", ")})`);
    if (profile.kind === "claude") {
      assert.ok(MODELS.includes(profile.model) || profile.model.includes("-"),
        `${cause}: "${profile.model}" is not a claude alias or full id`);
    }
  }
});

/**
 * The defect this pins: the first version of this table named a Claude model for the reviewer, whose
 * session is `codex`. `codex -m sonnet` does not resolve, so every spawned reviewer would have failed at
 * start -- and the table would have looked entirely reasonable while doing it.
 */
test("the reviewer cause is a CODEX worker, because the reviewer sessions are codex", () => {
  assert.equal(PROFILES["draft-awaiting-verdict"].kind, "codex");
  assert.equal(PROFILES["ready-row-unclaimed"].kind, "claude");
});

test("a codex worker keeps its SANDBOX -- only the approval prompt is turned off", () => {
  const args = agentArgs({ kind: "codex", model: "gpt-5.6-luna", effort: "medium" }).join(" ");
  assert.match(args, /approval_policy="never"/, "a spawned worker must never stop to ask");
  assert.match(args, /sandbox_mode="workspace-write"/, "the host chose a sandbox; spawning must not drop it");
  assert.doesNotMatch(args, /bypass-approvals-and-sandbox/,
    "that flag removes the sandbox as well as the prompts, which is not what non-interactive means");
});

test("every profile carries a WHY, because the number without the reason is how this drifts back", () => {
  for (const [cause, profile] of Object.entries(PROFILES)) {
    assert.ok(profile.why && profile.why.length > MIN_WHY_CHARS,
      `${cause} has no substantive reason recorded; a tier with no argument attached is one nobody can `
      + "challenge, and the last setting that had no argument cost a weekly allowance in three days");
  }
});

test("an operator override is applied and MARKED, so a run's tier is never silently not the table's", () => {
  const got = profileFor("ready-row-unclaimed", { model: "opus", effort: "max" });
  assert.deepEqual({ model: profileOf(got).model, effort: profileOf(got).effort },
    { model: "opus", effort: "max" });
  assert.match(profileOf(got).why, /\[OVERRIDDEN\]/,
    "an overridden run must say so, or the table gets blamed for a choice it did not make");
});

test("a malformed override is refused rather than passed to the CLI", () => {
  assert.match(refusalOf(profileFor("draft-awaiting-verdict", { effort: "ludicrous" })).refusal,
    /effort "ludicrous" is not one of/);
  assert.match(refusalOf(profileFor("ready-row-unclaimed", { model: "gpt5" })).refusal,
    /is not a known claude alias/);
});

test("a FULL model id is allowed through, since the CLI takes those too", () => {
  const got = profileFor("ready-row-unclaimed", { model: "claude-sonnet-5" });
  assert.equal(profileOf(got).model, "claude-sonnet-5");
});

test("agentArgs spells each product's flags its own way", () => {
  assert.deepEqual(agentArgs({ kind: "claude", model: "sonnet", effort: "high" }),
    ["--model", "sonnet", "--effort", "high", "--dangerously-skip-permissions",
      "--disallowedTools", "AskUserQuestion"]);
  assert.deepEqual(agentArgs({ kind: "codex", model: "gpt-5.6-luna", effort: "medium" }),
    ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="medium"',
     "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"']);
});

test("an effort valid for one product is REFUSED for the other", () => {
  assert.match(refusalOf(profileFor("draft-awaiting-verdict", { effort: "xhigh" })).refusal,
    /not one of minimal, low, medium, high for a codex worker/);
  assert.match(refusalOf(profileFor("ready-row-unclaimed", { effort: "minimal" })).refusal,
    /not one of low, medium, high, xhigh, max for a claude worker/);
});

/**
 * NEITHER PRODUCT MAY STOP AND ASK A HUMAN, and until 2026-09-19 only one of them was configured that way.
 *
 * A codex worker carries `approval_policy="never"`. A Claude worker carried no equivalent, so it could
 * raise a menu and WAIT -- a state herdr reports as `blocked`: not wakeable, taking no further cause,
 * until a human clears it by hand.
 *
 * MEASURED TWICE. `worker-capture` behind a menu, found from a screenshot; and `orchestrator`, which
 * correctly worked out that deploying protocol 19 costs ~2,122 recaptures and ~4h of fleet time,
 * correctly listed "Hold and escalate to ceo first" among its options, AND THEN ASKED A HUMAN TO PICK
 * IT. The escalation was the autonomous path -- `ceo` owns fleet-time decisions -- so the session had
 * the right answer and used the wrong channel.
 *
 * #1744 made it visible; this makes it impossible. A rule in a prompt is a sentence, and this org has
 * repeatedly proved it cannot keep one by habit.
 */
test("no spawned worker of EITHER product can stop and ask a human", () => {
  const claude = agentArgs({ kind: "claude", model: "sonnet", effort: "high" });
  assert.ok(claude.includes("--disallowedTools") && claude.includes("AskUserQuestion"),
    "a Claude worker that can raise a menu can block the whole session on a human");

  const codex = agentArgs({ kind: "codex", model: "gpt-5.6-luna", effort: "medium" }).join(" ");
  assert.match(codex, /approval_policy="never"/, "codex's half of the same rule, already in place");

  // AND THE SANDBOX MUST SURVIVE IT. Codex's comment above records that the first spelling here dropped
  // the sandbox along with the prompts; removing a question must never widen what a worker may do.
  assert.match(codex, /sandbox_mode="workspace-write"/);
});
