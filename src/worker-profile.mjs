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
  "pr-green-unarmed": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and the reason is the FORK rather than the act. Arming a pull request by hand is one command;
    // deciding WHICH of two situations this is, is not. One unarmed PR means that PR never got an arming
    // event; all of them unarmed means the arming credential is refusing and nothing in the repository
    // can arm anything until its pool returns (#1969, measured 2026-09-22: 28 minutes, two finished PRs
    // stranded, found by accident). Getting the fork wrong in the cheap direction arms one PR by hand and
    // leaves the outage running, which is the exact failure this cause exists to end.
    effort: "high",
    why: "the act is one command; telling a repository-wide credential outage from one PR that missed "
      + "its arming event is the judgment, and the cheap answer leaves the outage running",
  }),
  "verdict-comment-unreviewed": Object.freeze({
    kind: "codex",
    model: "gpt-5.6-luna",
    // LOW, and `draft-awaiting-verdict`'s `medium` is the contrast. That cause asks for a REVIEW -- judgment
    // over a diff. This one asks the reviewer to re-post a verdict it already formed, through the one script
    // that turns a comment into a review (#2365): the judgment was spent, and what remains is getting a
    // first line right. `codex` and not `claude` because the recipient is `reviewer`/`reviewer-2`.
    effort: "low",
    why: "the verdict already exists as a comment; the act is one `pr-review-verdict` call, so the "
      + "reasoning was spent writing it and low effort is enough to re-post it correctly",
  }),
  "pr-merge-conflict": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, for `pr-checks-failing`'s reason: the act is a rebase, and resolving a conflict is a judgment
    // about which side of each hunk wins. A cheap tier that guesses pushes a merge that still fails CI or,
    // worse, silently drops the other pull request's change -- #2203 conflicted on `work-gate.mjs` and
    // `agent-practices.md` after #2205 landed, files whose every hunk carries a ruling.
    effort: "high",
    why: "resolving a merge conflict is judgment about which side of each hunk wins, and a wrong guess "
      + "either costs a CI cycle or silently drops the other pull request's change",
  }),
  "trunk-red": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, for `pr-checks-failing`'s reason with a sharper edge: this is a red build on the branch every
    // other pull request merges onto, so a wrong guess costs a CI cycle for the whole org rather than for one
    // author. It is debugging against a failing test, which is where a cheap tier guesses, pushes, waits and
    // guesses again. NOT `opus`: `agent-practices.md` reserves it for reasoning a cheaper tier has MEASURABLY
    // got wrong, and no red trunk has been fixed on `sonnet`/`high` and recorded failing yet -- when one is,
    // raise it HERE with the run.
    effort: "high",
    why: "a red trunk is a debugging job on the branch every pull request lands on, so a wrong guess costs "
      + "the whole org a CI cycle, and the cheaper tier is not cheaper here",
  }),
  "pr-review-blocked": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, for `pr-green-unarmed`'s reason with a sharper fork. The act is cheap -- one
    // `prompt:session` to a reviewer, or one routing decision -- and CHOOSING BETWEEN THEM is the whole
    // job. `AWAITING_REVIEW` means nobody has reviewed and the reviewer lane never saw it; `REFUSED`
    // means somebody did and said no. Reading the second as the first prompts a reviewer who has already
    // answered, which `agent-practices.md` records costing a cleared verdict and a re-derivation.
    //
    // AND THE FORK HAS A THIRD ARM THAT ONLY READING CAN SETTLE, which is this row's own subject: a
    // `CHANGES_REQUESTED` may have been posted at a head the author has ALREADY fixed, because
    // `dismiss_stale_reviews` does not clear one. Routing rework for a refusal nobody still owes is the
    // failure #2049 spent seven hours in, and telling it apart means comparing the review's commit
    // against the current head rather than reading the verdict word.
    //
    // `claude` AND NOT `codex`, although a reviewer may be the eventual actor. This order's recipient is
    // `product-manager`, which is a `claude` session; the reviewer is reached by a `prompt:session` it
    // sends, and that wake carries `draft-awaiting-verdict`'s codex profile on its own.
    effort: "high",
    why: "the act is one command; telling an unreviewed pull request from a refused one -- and a live "
      + "refusal from one posted at a head the author has already fixed -- is the judgment",
  }),
  "awaiting-evidence-stale": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM. The act is reading a short list and routing each entry: to the row's owner for a wait nobody
    // explained, to `orchestrator` when the run is a fleet or lab one, or nowhere when the evidence source
    // turns out to be stated after all. There is no build, no verdict and no state to re-derive -- the order
    // names the pull requests and the label's age -- so `high` would buy a longer look at a list.
    effort: "medium",
    why: "the act is routing a short list of stalled waits, and the order already carries the pull requests "
      + "and the label's age",
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
  "host-units-stale": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM, and the effort is deliberately NOT bought up to match the consequence -- which is severe.
    // The wrong call here DELETES A LIVE TIMER: `host:install`'s removal loop drops every installed
    // `a11ign-*` unit the tree does not ship, and a unit the tree has not shipped YET is a normal state
    // that reads identically to a retirement. This org has been one command from that twice (#1993,
    // #2002).
    //
    // WHAT MAKES MEDIUM RIGHT ANYWAY: the hard part is not reasoning, it is TAKING A SECOND READING, and
    // the order's own prompt carries that as a procedure -- confirm no finding is a live orphan by a
    // route that does not go through the same reader, STOP and report if the two disagree, then run the
    // remedy and post whether any `REMOVED` line appeared. A bounded checklist with one real judgment in
    // it does not get safer with more reasoning effort; it gets safer with the second reading, which is
    // already required. Buying `high` here would be paying for thinking where the risk is actually in
    // looking.
    //
    // sonnet AND NOT haiku, though, and that is the half that is not negotiable: telling a retirement
    // from a not-yet-shipped unit is judgment over gathered material, which is exactly where
    // `agent-practices.md` draws its line. The gathering is already done -- the findings arrive IN the
    // prompt.
    //
    // ESCALATE HERE WITH THE RUN if a session ever gets this wrong, per this file's own rule. A wrong
    // call would be visible: a `REMOVED` line in an install the row says to post.
    effort: "medium",
    why: "confirming no drifting unit is a live orphan before running a remedy that deletes unshipped "
      + "units is judgment, but a bounded one the order's own procedure carries",
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
  "reviewer-auth-failed": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM, and the recipient is `ceo`, so this is the profile a spawned worker would take if one ever were
    // (`ceo` is a standing decision-holder and is never spawned). The work is a BRIEF FOR THE CHAIRMAN: which
    // instances, on which signal, and the one action that fixes it -- a re-login of the reviewer's codex
    // account, interactive, so nothing here can do it. The reasoning is reading two signals the gate already
    // named, not diagnosing an absence, so `org-stalled`'s `high` would be paid for nothing (#2401).
    effort: "medium",
    why: "the gate has already named the instances and the signal; the output is a short brief for the "
      + "chairman, whose only action is a re-login no session can perform",
  }),
  "disk-headroom-low": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM, and the recipient is `ceo`, a standing decision-holder that is never spawned, so this is the profile
    // a spawned worker would take if one ever were (#2163). The gate has already read the filesystem and named which
    // resource is low; the work is choosing what to remove and whether the chairman must be told another way. That
    // is a short judgment over a stated figure, not diagnosis from an absence, so `org-stalled`'s `high` would be
    // paid for nothing.
    effort: "medium",
    why: "the gate has already read the filesystem and named the low resource; the output is a decision about "
      + "what to remove, and a full disk is the one fault that stops every session at once",
  }),
  "claim-stalled": Object.freeze({
    kind: "claude",
    // SONNET AND MEDIUM, AND THE RECIPIENT IS THE HOLDER, so this is the profile a spawned worker would take if one ever were
    // (#2470; a nudge names a session that already exists and a release names nobody). The gate has already read the row, the
    // branch, the worktree and the interval, and the woken turn does one of three one-command things: commit or push what it
    // has, comment on the row, or write the reason it cannot in a FIELD. That is a short judgment over a stated fact, not the
    // multi-step build `blocker-cleared` asks for -- the session is mid-build with its context loaded -- and not diagnosis from
    // an absence, so `org-stalled`'s `high` would be paid for nothing.
    model: "sonnet",
    effort: "medium",
    why: "the gate has already read the claim and named what has not moved; the output is one commit, push or comment, "
      + "or a declared wait, by a session that is mid-build with its context loaded",
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
  "blocker-cleared": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // HIGH, and the reason is `ready-row-unclaimed`'s rather than a weaker version of it: what this order
    // actually asks for is the ROW BUILT, and the only difference is that the session already holds the
    // claim. A cheaper tier would arrive at a row that has been parked for however long its blocker took
    // and has to re-establish what it was doing -- strictly more context to rebuild than a fresh claim,
    // not less. Measured 2026-09-22, #1908 sat with six rows queued behind it.
    effort: "high",
    why: "resuming a parked claim is the same multi-step build as taking a fresh row, with the prior "
      + "state to re-establish on top of it",
  }),
  "unclaimed-blocker-cleared": Object.freeze({
    kind: "claude",
    model: "sonnet",
    // MEDIUM, AND IT IS `blocker-cleared`'s PROFILE WITH THE EXPENSIVE HALF REMOVED. That one is priced
    // HIGH because what it asks for is the ROW BUILT; this one asks `product-manager` whether a row that
    // is now startable should carry `ready`, and the build -- if it happens at all -- is somebody else's
    // turn afterwards. The gate has already handed over the row, the set that cleared and any label
    // still hiding it, so nothing here is gathered and nothing is diagnosed from an absence: it is
    // judgment over material already in the prompt, which `agent-practices.md` routes to sonnet.
    //
    // NOT HIGH, THOUGH `lane-backlog-unpromoted` IS, and the difference is the population rather than
    // the question. That cause hands a lane owner a WHOLE LANE to survey and a wrong call strands rows
    // nobody else may touch; this one is a single named row in the unlaned pool, where a wrong call
    // costs one row one tick -- the next clearing of a different set is a new causeKey and asks again.
    effort: "medium",
    why: "deciding whether one named, now-startable row should be promoted, with the row, the cleared "
      + "set and any hiding label already in the prompt -- judgment over gathered material, not a build",
  }),
  "claimed-row-amended": Object.freeze({
    kind: "claude",
    // SONNET AND MEDIUM, AND THE EFFORT IS THE ONE DECISION HERE. The order already names the marker and
    // quotes what the row now carries, so the woken turn is not diagnosing anything -- it reads one
    // constraint and decides whether the work in hand still satisfies it. That is judgment over a
    // handed-over fact, which `agent-practices.md` routes to sonnet, not the multi-step build
    // `ready-row-unclaimed`/`blocker-cleared` ask for: those two arrive at an EMPTY worktree and have to
    // build a row, while this one arrives mid-build with the context already loaded.
    model: "sonnet",
    effort: "medium",
    why: "reading one declared constraint against work already in hand -- the gate hands over the marker "
      + "and the row, so nothing here is diagnosed from an absence and nothing is built from scratch",
  }),
  "row-branch-unshipped": Object.freeze({
    kind: "claude",
    // SONNET AND MEDIUM, AND THE EFFORT IS THE DECISION. This order is NOT a build and must not be
    // priced as one: the work it is about already exists on `origin`, and the three exits the order
    // names -- open its pull request, delete the branch, rename it -- are each one command. What the
    // woken turn actually does is READ a diff and decide which of the three it is, over a branch and a
    // sha the order has already handed it. That is judgment over gathered material, which
    // `agent-practices.md` routes to sonnet, and it is the same shape as `claimed-row-amended` rather
    // than `ready-row-unclaimed`/`blocker-cleared`: those two arrive at an empty worktree and have to
    // build a row from a brief.
    model: "sonnet",
    effort: "medium",
    why: "reading one branch's diff and choosing between three named one-command exits -- the work "
      + "already exists on origin, so nothing here is built and nothing is diagnosed from an absence",
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
