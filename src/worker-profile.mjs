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
    // HIGH, unlike its sibling above, and the asymmetry is the point -- but the asymmetry now has TWO
    // arguments behind it, because `notConvincedOrder` has two recipients and this rationale named only
    // the rarer one until #2017.
    //
    // THE COMMON CASE IS THE OWNER REWORKING. Since #2001 the order is addressed to the session the PR's
    // `session:` label names, and its prompt tells that session the rework is theirs -- adjudicating is
    // explicitly NOT its call, since disputing the verdict is the escalation back to `product-manager`.
    // So for most instances the argument is `pr-checks-failing`'s, not a weighing one: reading a refusal
    // and fixing what it names is debugging against an argument, a cheap tier guesses, pushes, and
    // spends a full CI cycle per guess. The refusal on #1957 named a surviving mutant at a `file:line`;
    // there was nothing there to weigh and everything to fix correctly the first time.
    //
    // THE UNLABELLED CASE IS THE ONE THAT WEIGHS. With no `session:` label the order goes to
    // `product-manager` and asks it to decide whether the objection stands, whether the row survives it,
    // and who holds the rework. Getting that wrong either abandons a good change or waves through one a
    // reviewer refused.
    //
    // Both land on `high`, which is why the recipient split changed nothing here. It is recorded anyway:
    // a rationale that names one of two recipients is how a correct setting gets changed for a wrong
    // reason by the next person reading this table.
    effort: "high",
    why: "two recipients, both high -- the PR's own session reworking a refusal is debugging against an "
      + "argument, where a wrong guess costs a CI cycle; and on an unlabelled PR product-manager weighs "
      + "whether the objection stands, where a wrong call abandons a good change or overrides a refusal",
  }),
  "pr-checks-failing": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, because a red build is a debugging job and debugging is where a cheap tier wastes the most
    // time: it guesses, pushes, waits for CI, guesses again, and each cycle costs minutes of runner time
    // on top of the tokens. The failure that prompted this cause was a missing changeset -- trivial --
    // but the cause covers every red build, and nothing in the order says which kind it is.
    effort: "high",
    why: "fixing a red build is debugging, and a wrong guess costs a full CI cycle on top of the tokens, "
      + "so the cheaper tier is not cheaper here",
  }),
  "ready-queue-empty": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and it is the most consequential judgment in the table. Promotion decides what the whole
    // engineering capacity does next, and the failure mode is not a wasted turn -- it is rows promoted
    // without a Region or an Acceptance, which is the `ready:audit` incident and costs every engineer
    // who then picks one up. Reading fifty rows to find the three that are genuinely ready is the work.
    effort: "high",
    why: "promotion decides what every engineer does next, and a row promoted without a Region or an "
      + "Acceptance costs more than the reading that would have caught it",
  }),
  "blocked-unexaminable": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH. Deciding whether a stale `blocked` label still holds means reading the row, finding what it
    // was waiting for, and judging whether that has happened -- measured 2026-09-20, eleven such rows
    // stood between the org and a full queue, one of them about code fixed the day before.
    effort: "high",
    why: "judging whether a claim nobody can evaluate still holds is exactly the work a machine cannot do",
  }),
  "answer-owed": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, because the question is by definition one the asker could not resolve themselves -- it
    // reached another session precisely because it needed judgment. And someone is STOPPED waiting on
    // it: on 2026-09-20 a ruling sat unread for 6.5 hours while the asker re-posted five times.
    effort: "high",
    why: "a question that reached another session is one the asker could not answer, with someone "
      + "already stopped waiting on the reply",
  }),
  "epic-unfiled": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH. Reading an epic and deciding what rows it becomes is the judgment the whole queue rests on:
    // measured 2026-09-20, 16 of 17 open epics had zero sub-issues and the pool had ONE claimable row,
    // so the org read as out of work while nine fleet-gated epics sat unfiled. Splitting one wrongly
    // strands the work again in smaller pieces; splitting one well is what puts six engineers back to
    // work. Cheap is the wrong saving here.
    effort: "high",
    why: "splitting an epic into claimable rows is the judgment the whole queue's supply rests on",
  }),
  "epic-finished": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and the reason is the same one `epic-unfiled` gives rather than a weaker version of it. The
    // cheap reading of "every child is closed" is "so close it", and the cheap reading is the WRONG one
    // half the time: the other answer is that the next tranche of rows has never been filed, which is
    // unfiled supply and worth more than the tidy-up. Telling those two apart means reading the epic's
    // scope against what its children actually delivered. A low-effort pass would close them all.
    effort: "high",
    why: "deciding whether a fully-closed epic is finished or merely unfiled is the same supply "
      + "judgment as splitting one, and the cheap answer is wrong half the time",
  }),
  "fleet-batch-due": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH. Each row in the batch needs a capture chosen, a reading interpreted, and a verdict on whether
    // the row can now move without the fleet -- judgement per row, over the org's scarcest resource, with
    // a wrong call costing hours of ten-worker time. This is the order that replaced a nightly timer, so
    // it now arrives whenever the gated set changes rather than once a day; that makes it more frequent,
    // not cheaper to get wrong.
    effort: "high",
    why: "a by-row reading of the fleet-gated batch decides how the org's scarcest resource is spent",
  }),
  "lane-backlog-unpromoted": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and for the same reason as `ready-queue-empty`: this decides what a whole lane does next, and
    // a lane owner is the only person who can. Getting it wrong strands rows nobody else may touch --
    // which is exactly the state this cause was written for, with five publish-gated rows behind one
    // unanswered question.
    effort: "high",
    why: "a lane owner is the only session that may promote its own rows, so a wrong call here strands "
      + "work nobody else can pick up",
  }),
  "org-stalled": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and this is the one cause whose input is an ABSENCE. Every other profile here reasons over
    // something the gate handed it -- a diff, a verdict, a failing check. This one is handed the fact
    // that nothing fired, and has to work out which of a dozen possible reasons is true THIS time: a
    // label whose condition became true, a capability that recovered, a step that exists only as prose,
    // a session stopped behind a menu. Diagnosis from silence is the hardest reasoning in the table, and
    // getting it wrong means the org stands still for another two hours with everyone idle.
    effort: "high",
    why: "diagnosis from an absence: the gate found nothing and the answer is whichever of a dozen gates "
      + "silently stopped being true. Measured over 48 hours, every instance was a different shape, and "
      + "the only thing that ever noticed was a human reading a terminal.",
  }),
  "chairman-blocked": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, because the output is a BRIEF FOR A PERSON and it is the only one in this table that leaves
    // the org. It must say what is waiting, what it blocks downstream, and the single next action in the
    // chairman's hands -- a vague one costs another day of eight rows standing still, which is what the
    // absence of any brief at all already cost.
    effort: "high",
    why: "the output is a brief for a person outside the org, and a vague one costs another day of "
      + "everything downstream standing still",
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
  return ["--model", profile.model, "--effort", profile.effort, "--dangerously-skip-permissions",
    "--disallowedTools", "AskUserQuestion"];
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
