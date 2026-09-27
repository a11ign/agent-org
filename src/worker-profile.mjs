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
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.mjs";
import { PROFILES } from "./cause-declaration.mjs";

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
 * #2621 (child 3e of #69): COMPUTED, NOT SPELLED HERE. `PROFILES` used to be a fourth hand-maintained
 * list a cause had to be added to, beside `work-gate.mjs`'s `CAUSES`, `JUDGMENT_CAUSES` and
 * `START_CAUSES` -- four lists in two files, and a cause added to one and not the others is a recorded
 * trap. `cause-declaration.mjs` is now the one place a cause is declared (`{cause, group, profile}`), and
 * this name -- unchanged from here on, same keys, same `kind`/`model`/`effort`/`why` shape -- is its
 * computation. See that file's `TOOL_CAUSE_DECLARATIONS` for every cause's own profile and the reasoning
 * behind it, kept verbatim from this file's own history.
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
export { PROFILES };

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
  // `--disallowedTools AskUserQuestion` IS THE CLAUDE HALF OF WHAT CODEX ALREADY HAS ABOVE.
  //
  // A codex worker carries `approval_policy="never"` -- "never stop to ask" -- and a Claude worker
  // carried NO equivalent. So a Claude session could raise a menu and WAIT, and herdr reports that
  // state as `blocked`: not wakeable, taking no further cause, until a human clears it by hand.
  //
  // MEASURED TWICE. `worker-capture` behind a menu, found by the chairman from a screenshot; and
  // `orchestrator` on 2026-09-19, which correctly worked out that deploying protocol 19 would cost
  // ~2,122 recaptures and ~4h of fleet time, correctly listed "Hold and escalate to ceo first" as one
  // of its options -- AND THEN ASKED A HUMAN TO PICK IT. `ceo` owns fleet-time decisions under the
  // routing rule, so the escalation WAS the autonomous path; the session had the right answer and used
  // the wrong channel to deliver it.
  //
  // #1744 made this VISIBLE (`work-tick` prints `BLOCKED <name>`); it never made it impossible, and a
  // rule in a prompt saying "never stop and wait on a human" is a sentence -- the exact class of
  // instruction this org has repeatedly proved it cannot keep by habit. Removing the tool is the
  // mechanical version: a session that cannot ask must escalate, which is what the routing rule
  // already tells it to do.
  //
  // `--autocompact 120000` (#2717) bounds compaction to a TURN, not only to the gap between orders.
  // #2688's `/compact`-before-order (`wake.mjs`'s `deliver()`, `prompt-session.mjs`'s `clearThenPrompt()`)
  // only checks cache-read tokens at the seam where an order REACHES a session; a session that never
  // returns for a new order on one long-running row (measured: 340 calls, peak context 479k in a single
  // turn) is never checked. This is the same 120,000 #2688 already ruled, not a second threshold --
  // passed to Claude Code's OWN auto-compact trigger, which otherwise fires wherever the model's default
  // context window puts it. Codex reviewers are a different product and are untouched below.
  return ["--model", profile.model, "--effort", profile.effort, "--dangerously-skip-permissions",
    "--disallowedTools", "AskUserQuestion", "--autocompact", "120000"];
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
