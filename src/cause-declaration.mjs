// @ts-check
// #2621 (child 3e of #69): A CAUSE IS ONE DECLARATION, `{cause, group, profile}`, so a new one is added in
// ONE place instead of four. Before this, `work-gate.mjs` held `CAUSES`, `JUDGMENT_CAUSES` and
// `START_CAUSES` as three hand-maintained arrays and `worker-profile.mjs` held a fourth, `PROFILES` --
// four lists a cause had to be added to together, and a cause added to one and not the others is a
// recorded trap this file exists to close. `CAUSES`, `JUDGMENT_CAUSES`, `START_CAUSES` and `PROFILES` are
// now COMPUTED from the declarations below and re-exported, unchanged in name and value, from
// `work-gate.mjs` and `worker-profile.mjs` -- nothing that imports them changes.
//
// TWO SOURCES OF DECLARATIONS, AND THE LINE BETWEEN THEM IS ADR 0040's (decision 1, surface 3). Measured:
// of every cause the gate can emit, exactly ONE names the fleet (`orchestrator/` appears once against 10
// `product-manager/` and 4 `ceo/` in `work-gate.mjs`'s `causeKey` prefixes) -- so **30 are the tool's own
// code** (`TOOL_CAUSE_DECLARATIONS`, this file) **and 1 is a plugin** a project supplies because it must
// RUN project code: `fleet-batch-due`'s actual detection (`fleetBatchOrders` in `work-gate.mjs`, unmoved
// by this row) reads the `fleet-gated` label, which a project without a fleet does not have. A project
// with no fleet, lab or corpus declares no plugin and gets no fleet cause: `projectCauseDeclarations`
// reads an absent `.agent-org/project.json` `causes` field as none, for `project-vocabulary.mjs`'s
// `readResources`'s own reason.
//
// `GROUPS`/`declareCause`/the four combinators live in `cause-shape.mjs`, a LEAF, and are re-exported here
// rather than defined here: a plugin that needed `declareCause` from THIS file, rather than from the leaf,
// would import this file right back -- a cycle. (It also keeps the plugin load below a `require`, not an
// `import`, out of the risk entirely: `declared-walk-scope.test.ts` refuses a computed `import()` anywhere
// in a declaring guard's closure because the ESM loader reads off a thread the guard's observer cannot
// wrap, and a project plugin's path is data, never a literal. `require`'s reads ARE seen -- `Module.
// _resolveFilename` records what it resolved -- and Node 22 loads a plain ESM module (no top-level await
// of its own) through it synchronously, so this whole file needs no top-level await either.)
//
// RELATIVE IMPORTS ONLY, like `work-gate.mjs` and `region-paths.mjs`: this module is on both files' import
// graph and both state, at their own top, that they must run before any `pnpm install`/build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { HOME_CHECKOUT, ProjectDeclarationRefusal } from "./project-config.mjs";
import { GROUPS, CauseDeclarationRefusal, declareCause, declaredCauses, causesOf, judgmentCausesOf,
  startCausesOf, profilesOf } from "./cause-shape.mjs";

export { GROUPS, CauseDeclarationRefusal, declareCause, declaredCauses, causesOf, judgmentCausesOf,
  startCausesOf, profilesOf };

const SOURCE = ".agent-org/project.json";
const require = createRequire(import.meta.url);

/**
 * Read `.agent-org/project.json`'s `causes` key, PURE: a test drives every refusal with a plain object,
 * `project-vocabulary.mjs`'s `parseVocabulary` discipline. ABSENT reads as no plugin -- a project with no
 * fleet, lab or corpus has no causes of its own and loses no other rule, `readResources`'s own reason.
 * @param {unknown} parsed the whole parsed JSON document
 * @returns {string | undefined} the plugin module's path, relative to `.agent-org/`
 */
export function parseProjectCauseModule(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectDeclarationRefusal("(file)", "it must be a JSON object", SOURCE);
  }
  const holder = /** @type {Record<string, unknown>} */ (parsed);
  if (!Object.hasOwn(holder, "causes")) return undefined;
  const causes = holder.causes;
  if (typeof causes !== "object" || causes === null || Array.isArray(causes)) {
    throw new ProjectDeclarationRefusal("causes", `it must be an object, not ${Array.isArray(causes) ? "an array" : typeof causes}`, SOURCE);
  }
  const module = /** @type {Record<string, unknown>} */ (causes).module;
  if (typeof module !== "string" || module === "") {
    throw new ProjectDeclarationRefusal("causes.module", "it must be a non-empty string", SOURCE);
  }
  return module;
}

/**
 * The project's own cause declarations -- a PLUGIN, because deciding when `fleet-batch-due` fires runs
 * project code (`fleetBatchOrders`, unmoved by this row). Loaded by the path the declaration names, via
 * `require` (not `import`, see this file's own header), so the tool's own code never spells a project's
 * cause name: a second project with no such file in its `.agent-org/plugins/` gets no plugin and no extra
 * cause.
 *
 * Reads `.agent-org/project.json` a second time rather than teaching `project-config.mjs`'s strict reader
 * a field it does not otherwise need -- `project-vocabulary.mjs`'s `homeVocabulary` makes the identical
 * choice, for the identical reason.
 * @param {string} root @returns {ReturnType<typeof declareCause>[]}
 */
export function projectCauseDeclarations(root = HOME_CHECKOUT) {
  const path = `${root}/${SOURCE}`;
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "the declaration cannot be read", path, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ProjectDeclarationRefusal("(file)", "it is not valid JSON", path, { cause });
  }
  const modulePath = parseProjectCauseModule(parsed);
  if (modulePath === undefined) return [];
  const resolved = join(root, ".agent-org", modulePath);
  const imported = require(resolved);
  if (!Array.isArray(imported.causeDeclarations)) {
    throw new ProjectDeclarationRefusal("causes.module", `${resolved} must export a \`causeDeclarations\` array`, path);
  }
  return imported.causeDeclarations;
}

/**
 * The tool's own 30 causes (ADR 0040, decision 1, surface 3): every cause but `fleet-batch-due`, which a
 * project without a fleet does not get. Each `why` is the reasoning a router that had to think would
 * rebuild the burn `worker-profile.mjs` exists to remove -- see that file's own header for the routing
 * policy these apply (`.claude/rules/agent-practices.md`'s haiku/sonnet/opus rule, unchanged here).
 */
export const TOOL_CAUSE_DECLARATIONS = Object.freeze([
  declareCause("draft-awaiting-verdict", GROUPS.ACTION, {
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
  declareCause("draft-convinced-not-ready", GROUPS.ACTION, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM, and this is the cheapest thing the org does. The verdict has already been formed by
    // somebody else; this reads one comment, checks it names the current head, and marks the PR ready or
    // says why not. It is the smallest real decision in the pipeline and does not need more than that.
    effort: "medium",
    why: "promotion is a one-comment decision someone else already reasoned about -- the judgment was "
      + "spent writing the verdict, not reading it",
  }),
  declareCause("verdict-not-convinced", GROUPS.ACTION, {
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
  declareCause("pr-checks-failing", GROUPS.ACTION, {
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
  declareCause("ready-queue-empty", GROUPS.JUDGMENT_START, {
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
  declareCause("lane-backlog-unpromoted", GROUPS.JUDGMENT_START, {
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
  declareCause("chairman-blocked", GROUPS.JUDGMENT, {
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
  declareCause("org-stalled", GROUPS.JUDGMENT_START, {
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
  declareCause("epic-unfiled", GROUPS.JUDGMENT_START, {
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
  declareCause("epic-finished", GROUPS.JUDGMENT_START, {
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
  declareCause("answer-owed", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // HIGH, because the question is by definition one the asker could not resolve themselves -- it
    // reached another session precisely because it needed judgment. And someone is STOPPED waiting on
    // it: on 2026-09-20 a ruling sat unread for 6.5 hours while the asker re-posted five times.
    effort: "high",
    why: "a question that reached another session is one the asker could not answer, with someone "
      + "already stopped waiting on the reply",
  }),
  declareCause("blocked-unexaminable", GROUPS.JUDGMENT_START, {
    kind: "claude",
    model: "sonnet",
    // HIGH. Deciding whether a stale `blocked` label still holds means reading the row, finding what it
    // was waiting for, and judging whether that has happened -- measured 2026-09-20, eleven such rows
    // stood between the org and a full queue, one of them about code fixed the day before.
    effort: "high",
    why: "judging whether a claim nobody can evaluate still holds is exactly the work a machine cannot do",
  }),
  declareCause("blocker-cleared", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // HIGH, and the reason is `ready-row-unclaimed`'s rather than a weaker version of it: what this order
    // actually asks for is the ROW BUILT, and the only difference is that the session already holds the
    // claim. A cheaper tier would arrive at a row that has been parked for however long its blocker took
    // and has to re-establish what it was doing -- strictly more context to rebuild than a fresh claim,
    // not less. Measured 2026-09-22, #1908 sat with six rows queued behind it.
    //
    // THE GROUP MOVED TO JUDGMENT FOR A SEPARATE REASON FROM THE PROFILE ABOVE (#2741): a claimed, no-PR
    // row whose declared blockers all close is a clearing that DOES NOT RECUR on its own -- the same shape
    // `row-branch-unshipped` was reclassified for, "its answer is durable". `blockerClearedOrders` now
    // backs its causeKey off the way `unclaimedBlockerClearedOrders` already does (`PROMOTION_ASK_OFFSETS_MS`),
    // and that ladder is keyed to `JUDGMENT_TTL_MS`, not `WAKE_TTL_MS`: an ACTION cause redelivers the
    // unstaged key every twenty minutes for the whole two-hour first window, hits `MAX_DELIVERIES` inside
    // it and escalates before the ladder's own silence ever begins. #1756 escalated twice in one day this
    // way, and answering `answer:ceo` correctly -- reading the row, confirming nothing changed, removing
    // the label -- is what RESET the counter and let the identical two-hour cycle restart from zero.
    effort: "high",
    why: "resuming a parked claim is the same multi-step build as taking a fresh row, with the prior "
      + "state to re-establish on top of it",
  }),
  declareCause("pr-green-unarmed", GROUPS.ACTION, {
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
  declareCause("claimed-row-amended", GROUPS.JUDGMENT, {
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
  declareCause("row-branch-unshipped", GROUPS.JUDGMENT, {
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
  declareCause("ready-row-incomplete", GROUPS.JUDGMENT, {
    kind: "claude",
    // SONNET AND LOW, AND THE ORDER NAMES THE ROW AND THE MISSING SECTION: the woken turn adds one `## <Field>`
    // heading (or takes `ready` off), which is amending a row, not building one (#2791).
    model: "sonnet",
    effort: "low",
    why: "adding one named template section to a row, or taking the label off -- the gate hands over the "
      + "row and the section, so nothing is diagnosed and nothing is built",
  }),
  declareCause("closes-unresolved-repo-wide", GROUPS.JUDGMENT, {
    kind: "claude",
    // SONNET AND LOW: the gate hands over the PR set and how long it has stood; the turn reads GitHub's status and the
    // closer's last runs, and files a row or does not (#2823). Nothing is diagnosed from an absence.
    model: "sonnet",
    effort: "low",
    why: "reading whether GitHub is degraded and whether the post-merge closer ran, over a named set of pull "
      + "requests -- the gate hands over the set and its age, so nothing is built and nothing is inferred",
  }),
  declareCause("primary-stale", GROUPS.ACTION, {
    kind: "claude",
    // SONNET AND MEDIUM: the gate hands over the dirty paths and the shas (#2781); the turn decides whether the edits are
    // somebody's work to salvage before clearing them, which is judgment over gathered material, then runs one command.
    model: "sonnet",
    effort: "medium",
    why: "salvaging or clearing a named set of uncommitted edits in the primary and re-running `primary:update` -- the "
      + "gate hands over the paths and the commit distance, so nothing is diagnosed from an absence",
  }),
  declareCause("host-units-stale", GROUPS.ACTION, {
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
  declareCause("pr-review-blocked", GROUPS.ACTION, {
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
  declareCause("unclaimed-blocker-cleared", GROUPS.JUDGMENT_START, {
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
  declareCause("pr-merge-conflict", GROUPS.ACTION, {
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
  declareCause("trunk-red", GROUPS.ACTION, {
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
  declareCause("verdict-comment-unreviewed", GROUPS.ACTION, {
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
  declareCause("reviewer-auth-failed", GROUPS.JUDGMENT, {
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
  declareCause("awaiting-evidence-stale", GROUPS.JUDGMENT, {
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
  declareCause("disk-headroom-low", GROUPS.JUDGMENT, {
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
  declareCause("repeating-log-line", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM (#2848), and the recipient is `orchestrator`, so this is the profile a spawned worker would take if one ever were.
    // The gate has already normalised the journal, counted the run and quoted the line; the work is reading what the line
    // reports, then FIXING it or filing it `ready` or allowlisting it with a reason -- a short diagnosis from a stated line, and
    // not the diagnosis from an absence that `org-stalled`'s `high` is paid for.
    effort: "medium",
    why: "the gate has already counted the run and quoted the line; the output is a fix, a row filed ready, or an allowlist entry "
      + "with its reason, chosen by reading what one stated line reports",
  }),
  declareCause("backlog-aged-unpromoted", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM (#2848). The gate has already established that the row carries no wait and no unpickable label and how long that
    // has been true; the act is promoting it or recording the wait as a field, a short judgment over one stated row.
    effort: "medium",
    why: "the gate has already established that the row carries no wait and named its age; the output is a promotion or a "
      + "declared wait, a short judgment over one stated row",
  }),
  declareCause("claim-stalled", GROUPS.ACTION, {
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
  declareCause("row-off-board", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM (#2075). The gate has already read each row's own Project membership and named the absent ones; the work is
    // boarding each at the Status its label says and declaring a release where there is none. The Status is a small
    // judgment over a stated label (`ready` -> Ready, `in-progress` -> In progress), not diagnosis from an absence, so
    // `org-stalled`'s `high` would be paid for nothing -- and not a bare relay either, since a row that carries no label
    // that names a Status has to be read to be placed.
    effort: "medium",
    why: "the gate has already named the rows with no Project 1 item; the output is adding each at the Status its "
      + "label says and declaring a release where none exists",
  }),
  declareCause("pr-codeowner-review-missing", GROUPS.ACTION, {
    kind: "claude",
    model: "sonnet",
    // HIGH. The order names the pull request; deciding what to do with it is reading a pipeline diff and
    // posting the review CODEOWNERS has been waiting on -- the one act `#1959` exists because nothing
    // else asks `ceo` to do. A wrong approval here is a merge queue and trunk-health check waved through
    // by the one reviewer #1756 makes load-bearing; a wrong refusal blocks the pipeline lane outright.
    effort: "high",
    why: "the order names the pull request, and the judgment is reading a pipeline diff before approving "
      + "or refusing it -- the one review #1756 makes load-bearing for the whole merge queue",
  }),
  declareCause("row-call-count-signal", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM (#2691). The gate has already read each named row's session and its own call count; the work is
    // deciding whether that row is genuinely one unit or should be split -- a short judgment over a stated
    // number, not diagnosis from an absence, so `org-stalled`'s `high` would be paid for nothing.
    effort: "medium",
    why: "the gate has already named the row and its call count; the output is a judgment about whether to "
      + "split it, over a number already in the prompt",
  }),
  declareCause("answer-label-unexplained", GROUPS.ACTION, {
    kind: "claude",
    // SONNET AND MEDIUM, `claim-stalled`'s PROFILE (#2711): the recipient is the row's own holder, so this
    // is the profile a spawned worker would take if one ever were, and the gate has already read the label,
    // the timeline and which session set it. The woken turn does one of two one-command things -- post the
    // question or remove the label -- a short judgment over a stated fact, not the multi-step build
    // `blocker-cleared` asks for, and not diagnosis from an absence, so `org-stalled`'s `high` would be
    // paid for nothing.
    model: "sonnet",
    effort: "medium",
    why: "the gate has already named the bare label and when it was applied; the output is posting the "
      + "question or removing the label, by a session that already holds the row",
  }),
  declareCause("ready-row-unclaimed", GROUPS.ACTION_START, {
    kind: "claude",
    model: "sonnet",
    effort: "high",
    // The one most likely to need escalating, and deliberately NOT pre-escalated. Building a row is
    // multi-step, but the rule's bar for opus is "a cheaper tier has MEASURABLY got it wrong", and no
    // such measurement exists for this cause. Raise it here when one does, naming the run.
    why: "building a row is multi-step, but no measurement shows sonnet failing it -- agent-practices "
      + "reserves opus for a cheaper tier measurably getting it wrong, and that evidence does not exist",
  }),
  declareCause("ready-row-unclaimable", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // MEDIUM (#2845). The gate has already read the refusal and quoted it; the work is deciding whose tree it is and
    // whether the row should be claimed, re-laned or the tree released -- a short judgment over a stated fact, not
    // diagnosis from an absence. NOT `ready-row-unclaimed`'s `high`: that is a build, this is a queue-state decision.
    // JUDGMENT, NOT ACTION_START: it asks `product-manager` to look and decide, it starts no work, and a drain
    // (which withholds starts) is exactly when a stuck row should still be seen.
    effort: "medium",
    why: "the gate has already read and quoted the claim's refusal; the output is a decision about whose "
      + "tree it is, over a fact already in the prompt",
  }),
  declareCause("org-health", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // HIGH (#2936), for `org-stalled`'s reason: three of the four signals hand the session a NUMBER that says something is not
    // happening (no merge in 3 h, a PR red for 2 h, a row refused for 2.6 h) and the work is finding which link is stuck. That
    // is diagnosis from an absence, and a wrong reading leaves the org idle with the signal already spent on it.
    // JUDGMENT, NOT JUDGMENT_START: it asks `ceo` to look, it starts no work, and a drain (which withholds starts) is exactly
    // when an org that is not landing anything should still be told.
    effort: "high",
    why: "the gate read a number that says nothing is landing, a red PR is unattended, a row is refused or the primary is stale; "
      + "the output is which link is stuck and a fix or a ready row, diagnosed from an absence",
  }),
  declareCause("org-retrospective", GROUPS.JUDGMENT, {
    kind: "claude",
    model: "sonnet",
    // HIGH (#2938). The gate has already computed every number; what is left is the part no script can do -- reading a number that is
    // worse than yesterday's and finding the CLASS behind it, then writing a row whose Acceptance is a test over a population rather
    // than over the instance (#2912 fixed one closed row and left every PR with no row going to the wrong reader). That is multi-step
    // reasoning, the same grade as `org-stalled`'s diagnosis, and it runs once a day, so the effort costs one turn rather than a stream.
    // JUDGMENT, NOT JUDGMENT_START: it starts no work itself, and a drain (which withholds starts) is exactly when the org should
    // still look at how it is doing.
    effort: "high",
    why: "the gate has computed the numbers; the output is finding the class behind each one that worsened and filing a "
      + "row whose test covers the class -- reasoning no script does, once a day",
  }),
]);

/**
 * Every cause this project (a11ign) and the tool together declare, computed once at import time. A
 * project without a fleet, lab or corpus imports no plugin here and this is `TOOL_CAUSE_DECLARATIONS`
 * unchanged.
 */
const DECLARED = declaredCauses([...TOOL_CAUSE_DECLARATIONS], projectCauseDeclarations());

/** The causes this gate can emit. `wake.mjs` and the matrix validate against this list, never a copy. */
export const CAUSES = causesOf(DECLARED);
/** Causes whose answer is a JUDGMENT about the current state, not an action on a named thing. See `GROUPS`. */
export const JUDGMENT_CAUSES = judgmentCausesOf(DECLARED);
/** The causes that START new work, as opposed to finishing work already begun. See `GROUPS`. */
export const START_CAUSES = startCausesOf(DECLARED);
/** CAUSE -> the worker that should take it, kind/model/effort/why. See `worker-profile.mjs`. */
export const PROFILES = profilesOf(DECLARED);
