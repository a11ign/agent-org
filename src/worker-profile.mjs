#!/usr/bin/env node
// @ts-check
// command: worker-profile -- which model and effort a wake order's CAUSE deserves. Data, not judgment.
//
// The org ran six sessions on Opus at xhigh (the ceo on Fable at high) because nothing ever chose: the
// model and the effort were whatever the session happened to be started with, by hand, months ago. This
// is the table that chooses, keyed on `work-gate`'s `cause` -- a string derived from GitHub state by a
// script, so the choice costs no model turn. A router that had to think would rebuild the burn it exists
// to remove.
//
// THE POLICY IS NOT INVENTED HERE. `.claude/rules/agent-practices.md` already carries the chairman's
// routing rule, ruled for subagents and applied here unchanged to whole workers:
//
//   haiku  -- data gathering: file reads, counting, directory walks, grep, API listings
//   sonnet -- analysis and judgment over gathered material
//   opus   -- ONLY for multi-step reasoning that a cheaper tier has MEASURABLY got wrong
//
// So nothing below starts on Opus, and that is the policy's plain reading rather than a cost preference.
// The measurement the rule asks for does not exist yet for any of these causes: nobody has run a review
// or a row build on sonnet and recorded it failing. Until someone has, "opus by default" is the option
// the rule specifically refuses, and the same 30-day measurement it cites -- Opus carrying 66% of
// billable tokens with no routing rule anywhere -- is what that default already cost.
//
// ESCALATION IS EXPECTED, AND IS EVIDENCE, NOT PREFERENCE. When a cause is measurably beyond its tier,
// raise it HERE, in this table, with the run that showed it. That keeps the reason attached to the
// number. A session quietly restarted on a bigger model is how the org got back to Opus-everywhere with
// nobody able to say who decided it.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";

/** The effort levels the `claude` CLI accepts. A value outside this set is a typo, not a preference. */
export const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** `codex`'s `model_reasoning_effort`. A separate list because it is a separate product's knob. */
export const CODEX_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);

/** The model aliases the `claude` CLI accepts. Full model IDs are allowed too; these are the shorthands. */
export const MODELS = Object.freeze(["haiku", "sonnet", "opus", "fable"]);

/** Effort vocabulary per agent kind -- the two products do not share one. */
export const EFFORTS = Object.freeze({ claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS });

/**
 * CAUSE -> the worker that should take it.
 *
 * Keyed on `cause` and not on `session`, deliberately. `session` says WHO is free, which is a scheduling
 * fact that changes minute to minute; `cause` says WHAT THE WORK IS, which is what decides how much
 * thinking it deserves. Two engineers taking different causes should not run at the same effort merely
 * because they are both engineers -- that conflation is how one setting ended up covering everything.
 *
 * `kind` IS PART OF THE PROFILE BECAUSE THE ORG IS NOT ALL ONE PRODUCT. The reviewers are `codex` and
 * the engineers are `claude`; a table that named only a model would have handed a reviewer a Claude
 * alias that `codex -m` cannot resolve. The first version of this file did exactly that.
 */
export const PROFILES = Object.freeze({
  "draft-awaiting-verdict": Object.freeze({
    kind: "codex",
    // `gpt-5.6-luna`, THE CHAIRMAN'S NAMED CHOICE (2026-09-17), not an inference. This first read
    // `gpt-5.4-nano`, reasoned from the naming convention that nano < mini < full and therefore that
    // nano was "the cheapest codex model" -- a guess about a price list this repository cannot see, and
    // it was wrong. The model to use is the one the person paying the bill names; the convention is not
    // evidence. Recorded because the next person to optimise this will be tempted by the same reasoning.
    //
    // It is also what the box already ran, so this is not a change to the reviewers' model -- it makes
    // the existing choice EXPLICIT and per-cause instead of inherited from a global default in
    // ~/.codex/config.toml that nobody picked for review work.
    //
    // THE EFFORT IS THE CHANGE, and the risk there is asymmetric, recorded rather than argued away: the
    // box ran `model_reasoning_effort = "high"` globally. A verdict is the last gate before a product
    // path merges, and a reviewer that wrongly writes "convinced" merges bad code, which costs more than
    // any effort setting saves -- so this drops one notch to `medium`, not to `minimal`. If verdicts
    // start coming back shallow or wrong, that IS the measurement: raise it here and cite the PR.
    model: "gpt-5.6-luna",
    effort: "medium",
    why: "review is judgment over a bounded diff, on the model the chairman named; effort one notch "
      + "below the box's global `high` because a wrong `convinced` merges bad code",
  }),
  "draft-convinced-not-ready": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM, and this is the cheapest thing the org does. The verdict has already been formed by
    // somebody else; this reads one comment, checks it names the current head, and marks the PR ready or
    // says why not. It is the smallest real decision in the pipeline and does not need more than that.
    effort: "medium",
    why: "promotion is a one-comment decision someone else already reasoned about -- the judgment was "
      + "spent writing the verdict, not reading it",
  }),
  "verdict-not-convinced": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, unlike its sibling above, and the asymmetry is the point: this one WEIGHS a refusal -- does
    // the objection stand, does the row survive it, who holds the rework. Getting it wrong either
    // abandons a good change or waves through one a reviewer refused.
    effort: "high",
    why: "weighing a refusal is judgment over the reviewer's argument, not a status flip -- getting it "
      + "wrong abandons a good change or overrides a refusal",
  }),
  "ready-row-unclaimed": Object.freeze({
    kind: "claude",
    model: "sonnet",
    effort: "high",
    // The one most likely to need escalating, and deliberately NOT pre-escalated. Building a row is
    // multi-step, but the rule's bar for opus is "a cheaper tier has MEASURABLY got it wrong", and no
    // such measurement exists for this cause. Raise it here when one does, naming the run.
    why: "building a row is multi-step, but no measurement shows sonnet failing it -- agent-practices "
      + "reserves opus for a cheaper tier measurably getting it wrong, and that evidence does not exist",
  }),
});

/**
 * The profile for a cause, or a refusal.
 *
 * REFUSES AN UNKNOWN CAUSE rather than defaulting. Both defaults are wrong in a way that hides: falling
 * back to opus/xhigh silently restores exactly the spend this table exists to end, and falling back to
 * haiku/low silently gives hard work to a tier that cannot do it. A refusal is the only answer that
 * makes a new cause someone's decision -- and `work-gate` adding one is the moment to make it.
 *
 * @param {string} cause
 * @param {{ model?: string, effort?: string }} [override] operator override, both fields optional
 * @returns {{ kind: "claude"|"codex", model: string, effort: string, why: string } | { refusal: string }}
 */
export function profileFor(cause, override = {}) {
  const base = /** @type {Record<string, {kind: "claude"|"codex", model: string, effort: string, why: string}>} */
    (PROFILES)[cause];
  if (!base) {
    return { refusal: `no profile for cause "${cause}" -- add one to PROFILES with the reason. `
      + `Known causes: ${Object.keys(PROFILES).join(", ")}` };
  }
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  const kind = base.kind;
  if (kind === "claude" && !MODELS.includes(model) && !model.includes("-")) {
    return { refusal: `model "${model}" is not a known claude alias (${MODELS.join(", ")}) or a full id` };
  }
  const allowed = EFFORTS[kind];  // keyed by the profile's own kind
  if (!allowed.includes(effort)) {
    return { refusal: `effort "${effort}" is not one of ${allowed.join(", ")} for a ${kind} worker` };
  }
  return { kind, model, effort,
    why: override.model || override.effort ? `${base.why} [OVERRIDDEN]` : base.why };
}

/**
 * The agent's own arguments for this profile -- everything after herdr's `--`.
 *
 * TWO PRODUCTS, TWO SPELLINGS, and neither is guessable from the other. `claude` takes `--model` and
 * `--effort` as flags; `codex` takes `-m` and sets its reasoning effort through `-c key=value`, the same
 * override mechanism its own `config.toml` uses.
 *
 * NOT STOPPING TO ASK IS DELIBERATE ON BOTH AND IS THE WHOLE POINT OF A SPAWNED WORKER:
 * nobody is sitting at that terminal, so a worker that stops to ask is a worker that hangs until a human
 * notices. It is defensible HERE and would not be on a developer's own machine -- these run in a
 * throwaway pane on the agent host, against a checkout the org owns, and what they may do is bounded by
 * the repository's own guards rather than by an interactive prompt. `codex`'s box already runs
 * `approval_policy = "never"` for the same reason.
 *
 * @param {{ kind: string, model: string, effort: string }} profile
 * @returns {string[]}
 */
export function agentArgs(profile) {
  if (profile.kind === "codex") {
    // NOT `--dangerously-bypass-approvals-and-sandbox`, which was the first spelling here and is wrong.
    // That flag drops the SANDBOX as well as the prompts, and this host deliberately runs
    // `sandbox_mode = "workspace-write"`. What a spawned worker needs is "never stop to ask", which is
    // `approval_policy = "never"` -- already this box's own setting, passed explicitly so a spawned
    // worker does not depend on a config file it did not write. The sandbox stays.
    return ["-m", profile.model,
      "-c", `model_reasoning_effort="${profile.effort}"`,
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="workspace-write"'];
  }
  return ["--model", profile.model, "--effort", profile.effort, "--dangerously-skip-permissions"];
}

function main() {
  refuseUnknownFlags(["--cause", "--model", "--effort"], {
    entry: import.meta.url, command: "node packages/agent-org/src/worker-profile.mjs",
  });
  const cause = flagValue(process.argv, "cause");
  if (!cause) {
    process.stdout.write(`${Object.entries(PROFILES)
      .map(([name, p]) => `${name}\t${p.model}\t${p.effort}\t${p.why}`).join("\n")}\n`);
    return;
  }
  const got = profileFor(cause, {
    model: flagValue(process.argv, "model") ?? undefined,
    effort: flagValue(process.argv, "effort") ?? undefined,
  });
  if ("refusal" in got) {
    process.stderr.write(`worker-profile: ${got.refusal}\n`);
    process.exit(1);
  }
  process.stdout.write(`${agentArgs(got).join(" ")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
