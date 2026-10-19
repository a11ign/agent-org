import { execFileSync } from "node:child_process";
import { fleetOrLabAcceptance, untrimmedFleetMention, declarationDisagreement } from "../acceptance-commands/classification.ts";
import { existsSync, readFileSync } from "node:fs";
import { flagValue } from "../lib/cli-flags.ts";
import { templateFieldsReason } from "../row-claim/template-fields-rule.ts";
import { moveProjectStatus, fetchLabels as fetchIssueLabels, ensureLabelsExist } from "../row-claim.ts";
import { PROJECT_NUMBER } from "../board-snapshot.ts";
import { REPO } from "../project-identity.ts";
import { DEFECT_LABEL } from "../defect-class-line.ts";
import { declaredRegionFiles, regionPathTokens, splitRegionEntry } from "../region-paths.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { rowTracker, trackerNamed } from "../row-tracker.ts";
import { adopterFacingDeclared, adopterRowKind } from "../work-gate/org-health.ts";
import { PRIMARY_MILESTONE_LINE } from "../org-health/thresholds.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { chairmanAskRefusal } from "../work-gate/chairman-ask-orders.ts";
import { unsplitDoneWhenRefusal } from "../unsplit-done-when.ts";
import { loadLanes } from "../lane-ownership.ts";
import { blastRadiusGate, ghBlastReads, type BlastVerdict } from "../blast-radius.ts";
import { sweepFilingAtFiling } from "../sweep-window.ts";
import { appendDistinctFrom } from "../duplicate-row.ts";
import { homeHostConfig, stateEntryPath } from "../host-config.ts";
import { decide, decisionLogPathFrom, decisionSwitchesPath, type DecisionDeps } from "../decision-provider.ts";
import { FAILURE_LEDGER_FILE, SPEC_LINT_REFUSED_KIND, recordFailure } from "../failure-ledger.ts";
import { answerLabelRefusal } from "../answer-label-guard.ts";
import { testsFirstOf } from "../merge-guard.ts";
import { githubTicketAdapter, TRACKER as TICKET_TRACKER } from "../ticket-port/github-adapter.ts";
import { SPEC_REVIEW_LABEL, SPEC_REVIEW_WAKE, lintRowBody, machineDeps, reviewSpec, specBlocksOf, specLintFlagOf, specLintRefusalReason, type LintDeps, type ReviewVerdict } from "../spec-lint.ts";
import { CLAIM_LABEL, READY_LABEL } from "../claim-labels.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL as OUT_OF_RELEASE, OUT_OF_RELEASE_MILESTONE, LANE_PREFIX, LANE_ANY_LABEL, LANES_FILE_PATH, FLEET_QUESTION, ANSWER_PREFIX } from "../project-vocabulary.ts";
import { BACKLOG_STATUS, BOARD_LABELS, EPIC_LABEL, READY_STATUS, boardingFor, declaresRelease, duplicateTitleRefusal, epicRoadmapValue, fetchIssueBoardStatus, homeTracker, issueNumberFromUrl, kindLabelOf, kindRefusal, labelRefusal, labelValuesFromArgv, labelsOutOfRelease, laneLabelsFor, milestoneFromArgv, milestoneRefusal, openMilestones, outOfReleaseArgv, parentFromArgv, parentRef, releaseExpectation, roadmapFieldOf, roadmapFromArgv, roadmapItemsOf, sameLabel, sameTracker, type AdopterDeclaration, type RoadmapField, type RoadmapItem, type RoadmapPlan, unverifiedFilingFields, withKindLabel, withoutLabels } from "./duplicate-title-refusal.ts";
import { ROADMAP_FIELD, ROADMAP_FLAG, TRACKER_FLAG, absentRegionTopDirReason, blockedByNumbers, blockedByRefusal, bodyFromArgv, checkoutOfKey, defaultRun, fileRefusalReason, filingWarnings, readBlocker, repoHasTopLevelDir, sessionFromArgv, type Tracker, withFiledBy } from "./body-from-argv.ts";

/** `--roadmap=` with no `--parent=` is refused: the value comes from the epic. Pure, so it is asked before anything is read. @param {string[]} argv @returns {string | null} */
export function roadmapWithoutParentRefusal(argv: string[]): string | null {
  if (roadmapFromArgv(argv) === null || parentFromArgv(argv) !== null) return null;
  return `row-file: REFUSING to file -- \`${ROADMAP_FLAG}\` is given with no \`--parent=\`. The Roadmap value comes from the epic a row is filed under, so a row with no `
    + "epic has nothing to take it from. Pass `--parent=<epic>`, or drop the flag. Nothing was filed.";
}

/**
 * #516: WHAT THE FILING OWES THE BOARD'S `Roadmap` FIELD, decided BEFORE anything is filed so a refusal leaves nothing behind.
 * No `--parent=` and no flag: nothing. A parent whose epic has a value: `--roadmap=` must name one of the board's options, and is refused with
 * the list when absent or unknown. A parent whose epic has NO value: nothing changes (a `--roadmap=` given anyway is still checked and set,
 * since an ignored flag that reports success is the defect `refuseUnknownFlags` exists to prevent).
 * @param {string[]} argv @param {Tracker} tracker
 * @param {{ run: typeof defaultRun, roadmapItems: typeof roadmapItemsOf, roadmapField: typeof roadmapFieldOf }} deps
 * @returns {RoadmapPlan}
 */
export function roadmapPlan(argv: string[], tracker: Tracker, deps: { run: typeof defaultRun; roadmapItems: typeof roadmapItemsOf; roadmapField: typeof roadmapFieldOf }): RoadmapPlan {
  const parent = parentFromArgv(argv);
  const given = roadmapFromArgv(argv);
  if (parent === null) return { set: null, warning: null };
  const ref = parentRef(parent, tracker.repo);
  if (ref === null) return { refusal: `row-file: REFUSING to file -- \`--parent=${parent}\` is not a row number, an issue URL or \`owner/repo#n\`, so its Roadmap value cannot be read. Nothing was filed.` };
  let epicValue: string | null;
  try {
    epicValue = epicRoadmapValue(deps.roadmapItems(ref, deps.run), tracker);
  } catch (error) {
    return { refusal: `row-file: REFUSING to file -- could not read the Roadmap value of ${ref.repo}#${ref.number}, so whether this row owes one is unknown: ${(error as Error).message}. Nothing was filed.` };
  }
  if (epicValue === null && given === null) return { set: null, warning: null };
  let field: RoadmapField | null;
  try {
    field = deps.roadmapField(tracker, deps.run);
  } catch (error) {
    return { refusal: `row-file: REFUSING to file -- could not read the \`${ROADMAP_FIELD}\` field of ${tracker.board.owner}/projects/${tracker.board.number}: ${(error as Error).message}. Nothing was filed.` };
  }
  if (field === null) {
    return { refusal: `row-file: REFUSING to file -- ${tracker.board.owner}/projects/${tracker.board.number} has no \`${ROADMAP_FIELD}\` field, so a row filed under ${ref.repo}#${ref.number} (${epicValue === null ? "no value" : `\`${epicValue}\``}) cannot be given one. Nothing was filed.` };
  }
  const names = field.options.map((option) => `\`${option.name}\``).join(", ");
  const option = given === null ? undefined : field.options.find((o) => o.name === given.trim())
    ?? field.options.find((o) => o.name.toLowerCase() === given.trim().toLowerCase());
  if (option === undefined) {
    const said = given === null ? `its epic ${ref.repo}#${ref.number} carries \`${ROADMAP_FIELD}\` = \`${epicValue}\`, and \`${ROADMAP_FLAG}<option>\` is absent`
      : `\`${ROADMAP_FLAG}${given}\` names no option of the project`;
    return { refusal: `row-file: REFUSING to file -- ${said}. Every row filed under a roadmap epic is given its value (a11ign#928); name one of: ${names}. Nothing was filed.` };
  }
  const warning = epicValue !== null && epicValue !== option.name
    ? `row-file: WARNING -- \`${ROADMAP_FLAG}${option.name}\` differs from ${ref.repo}#${ref.number}'s \`${ROADMAP_FIELD}\` (\`${epicValue}\`); the row is given the one you named.` : null;
  return { set: { field, option }, warning };
}

/**
 * #516: SET THE VALUE ON THE ROW'S ITEM ON THE BOARD IT WAS BOARDED TO, and read it back. A failed set, or a read-back that disagrees, is a
 * failure the caller reports and exits non-zero on; it is never a warning. `null` is success.
 * @param {number} issueNumber @param {Tracker} tracker @param {{ field: RoadmapField, option: { id: string, name: string } }} set
 * @param {{ run: typeof defaultRun, roadmapItems: typeof roadmapItemsOf }} deps
 * @returns {string | null}
 */
export function setRoadmapValue(issueNumber: number, tracker: Tracker, set: { field: RoadmapField; option: { id: string; name: string } }, deps: { run: typeof defaultRun; roadmapItems: typeof roadmapItemsOf }): string | null {
  const issue = { repo: tracker.repo, number: issueNumber };
  const onBoard = (item: RoadmapItem) => item.number === tracker.board.number && item.owner.toLowerCase() === tracker.board.owner.toLowerCase();
  try {
    const item = deps.roadmapItems(issue, deps.run).find(onBoard);
    if (item === undefined) return `#${issueNumber} is not an item of ${tracker.board.owner}/projects/${tracker.board.number}`;
    deps.run("gh", ["project", "item-edit", "--id", item.id, "--project-id", set.field.projectId, "--field-id", set.field.fieldId,
      "--single-select-option-id", set.option.id]);
    const after = deps.roadmapItems(issue, deps.run).find(onBoard)?.value ?? null;
    return after === set.option.name ? null : `the read-back shows \`${ROADMAP_FIELD}\` = ${after === null ? "no value" : `\`${after}\``}, not \`${set.option.name}\``;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Every argument, unchanged, straight to the real `gh issue create`. Captures stdout (the created issue's
 * URL) instead of inheriting the terminal -- #844: this file now reports its OWN verdict after boarding
 * and reading it back, not `gh`'s raw output, and needs the URL to do either.
 * @param {string[]} argv
 * @returns {string} gh's own stdout, trimmed
 */
function spawnGhIssueCreate(argv: string[]): string {
  return execFileSync("gh", ["issue", "create", ...argv], { encoding: "utf8" }).trim();
}

/**
 * #883: the lane label(s) for this row, or the refusal to print -- pulled out of `createIssue` to keep
 * that function's own complexity under this repo's gate, same shape as `boardAndVerify`'s own extraction:
 * one concept (derive from the file the merge guard reads, or refuse rather than guess) written out
 * rather than a genuinely separate responsibility. A missing or malformed `docs/lane-ownership.json` is
 * CANNOT_ASK, never "nothing has a lane" (the rule the retired `workflow-lane-check.mjs`'s `laneVerdict`
 * applies to the merge guard's side of the same file) -- refused BEFORE `gh issue create` runs, so
 * nothing is filed on a guess. `body` is assumed to already carry a `## Region` section: the only caller,
 * `createIssue`, checks that via `fileRefusalReason` first, so `declaredRegionFiles` cannot return `null`
 * here.
 * #1322: and the filer's own `--label` values are READ against the lanes it derives, before anything is filed --
 * see `labelRefusal`. Here rather than in `createIssue` because it is the same question: which labels this row gets.
 * @param {string} body @param {typeof loadLanes} loadLanesConfig @param {string[]} argv
 * @returns {{ ok: true, laneLabels: string[] } | { ok: false, message: string }}
 */
function laneLabelsOrRefusal(body: string, loadLanesConfig: typeof loadLanes, argv: string[]): { ok: true; laneLabels: string[]; } | { ok: false; message: string; } {
  const lanes = loadLanesConfig();
  if (lanes === null) {
    return { ok: false, message: `row-file: could not read ${LANES_FILE_PATH} (absent, empty or `
      + "malformed) -- refusing to guess which lane this row belongs to. Nothing was filed." };
  }
  const regionFiles = (declaredRegionFiles(body) as string[]);
  const laneLabels = laneLabelsFor(regionFiles, lanes);
  // #1241: THE ACCEPTANCE ANSWERS WHAT THE REGION CANNOT. `laneLabelsFor` derives a lane from PATHS, so a
  // row whose deliverable is not a commit carries none -- #1042 and #1234 both reached `ready`/`lane:any`
  // with an acceptance naming a specific session, and an engineer had to read the body to find out the
  // row was not theirs. Twice. A command that reaches the fleet or the lab names its owner directly.
  //
  // ADDED, never substituted: a row can have BOTH paths and a fleet acceptance (a code half plus a run
  // against real boxes), and dropping the path lane would route it away from the engineer who must write
  // the code. The two lanes answer different questions and a row may need both answers.
  const fleetReason = fleetOrLabAcceptance(body);
  reportAcceptanceRouting(fleetReason, untrimmedFleetMention(body), declarationDisagreement(body));
  const routed = withAcceptanceLane(laneLabels, fleetReason);
  const labelProblem = labelRefusal(argv, routed);
  return labelProblem ? { ok: false, message: labelProblem } : { ok: true, laneLabels: routed };
}

/**
 * #1912: the derived lanes plus `lane:orchestrator` when the Acceptance reaches the fleet or lab -- and
 * `lane:any` DROPPED when it does. `lane:any` means "no lane owns this"; beside `lane:orchestrator` it
 * contradicts it, and #1911 was filed carrying both. A path lane (`lane:ceo`) is kept: that pair is two
 * real answers (#1241), this one was an answer and its negation.
 * @param {readonly string[]} laneLabels from `laneLabelsFor` @param {string | null} fleetReason
 * @returns {string[]}
 */
export function withAcceptanceLane(laneLabels: readonly string[], fleetReason: string | null): string[] {
  if (!fleetReason) return [...laneLabels];
  const owned = laneLabels.filter((label) => label !== LANE_ANY_LABEL);
  const orchestratorLane = `${LANE_PREFIX}orchestrator`;
  return owned.includes(orchestratorLane) ? owned : [...owned, orchestratorLane];
}

/**
 * #1912: SAY WHICH PATTERN ROUTED THE ROW, or which one a trim swallowed without routing it. #1911 came
 * out `lane:orchestrator` with nothing saying why, and the filer found the cause by reading this module.
 *
 * #1988: THE SECOND TRIM IS NAMED IN THE SAME LINE. A scope-disclaiming paragraph now stops a NAMED
 * pattern routing the row, and a second silent trim would have re-made exactly the defect #1912 closed --
 * so the line says which of the two it was, and what to do about each.
 *
 * #2175: THE ROW'S OWN ANSWER IS THE THIRD THING A LANE CAN BE DECIDED BY, and where it and a pattern
 * disagree the line says so -- it was resolved in the pattern's favour, silently, before. It comes first:
 * it says everything the two lines below would, and says which side won.
 * @param {string | null} fleetReason
 * @param {{ reason: string, form: "bullet" | "scope disclaimer" } | null} untrimmed
 * @param {{ declared: "no" | "yes", routed: boolean, reason: string | null } | null} disagreement
 */
function reportAcceptanceRouting(fleetReason: string | null, untrimmed: { reason: string; form: "bullet" | "scope disclaimer"; } | null, disagreement: { declared: "no" | "yes"; routed: boolean; reason: string | null; } | null) {
  if (disagreement) {
    process.stderr.write(`${disagreementLine(disagreement)}\n`);
    return;
  }
  if (fleetReason) {
    process.stderr.write(`row-file: lane:orchestrator added -- the Acceptance ${fleetReason}.\n`);
  } else if (untrimmed) {
    const remedy = untrimmed.form === "bullet"
      ? "bullets are read as describing a test (#1912). If the row DOES it, write that step as a numbered clause"
      : "a paragraph declaring work OUT is read as disclaiming it (#1988). If the row DOES it, say so outside "
        + "that paragraph";
    process.stderr.write("row-file: NOT routed to orchestrator -- a "
      + `${untrimmed.form} in the Acceptance names something that ${untrimmed.reason}, and ${remedy}.\n`);
  }
}

/**
 * #2175: the one stderr line for a declaration that disagrees with the patterns. Each shape names the
 * question it quotes, which side won, and the one thing the filer can do about it.
 * @param {{ declared: "no" | "yes", routed: boolean, reason: string | null }} d
 * @returns {string}
 */
function disagreementLine({ declared, routed, reason }: { declared: "no" | "yes"; routed: boolean; reason: string | null; }): string {
  const question = `"${FLEET_QUESTION}?"`;
  if (declared === "yes") {
    return `row-file: lane:orchestrator added -- the row declares "Yes" to ${question}, though no pattern in `
      + "the Acceptance names the fleet or the lab. A declaration outranks a pattern (#2175); if the answer "
      + "is wrong, change it.";
  }
  if (routed) {
    return `row-file: lane:orchestrator added although the row declares "No" to ${question} -- the Acceptance `
      + `${reason}. A declaration silences only the named patterns, never an invocation (#2175); if the row `
      + "does not run it, say so without the command, and if it does, change the answer.";
  }
  return `row-file: NOT routed to orchestrator -- the row declares "No" to ${question}, and the Acceptance `
    + `names something that ${reason}. A declaration outranks a pattern (#2175). If the row DOES need it, `
    + "change the answer.";
}

/**
 * #4078: THE TRACKER THIS ROW IS FILED IN -- `--tracker=<key>` when given, else the one `rowTracker` reads off its Region. A key the
 * project does not declare is refused before anything is filed, naming the keys it does.
 *
 * `note` is the one line printed when the Region COULD NOT BE READ and a choice was actually made: with one declared tracker there is no
 * choice and nothing to say, and an explicit `--tracker=` has not read the Region at all.
 * @param {string[]} argv @param {string} body @param {Parameters<typeof rowTracker>[1] & { tracker: Tracker[] }} declaration
 * @returns {{ tracker: Tracker, note: string | null } | { refusal: string }}
 */
export function chooseTracker(argv: string[], body: string, declaration: Parameters<typeof rowTracker>[1] & { tracker: Tracker[]; }): { tracker: Tracker; note: string | null; } | { refusal: string; } {
  const key = flagValue(argv, "tracker");
  if (key !== undefined) {
    const named = trackerNamed(declaration.tracker, key);
    return "refusal" in named ? named : { tracker: named.tracker, note: null };
  }
  const { tracker, unreadable } = rowTracker(declaredRegionFiles(body), declaration, declaration.tracker);
  const note = unreadable && declaration.tracker.length > 1
    ? `row-file: the Region could not be read (it names no path), so the row went to the org tracker, ${tracker.repo}. `
      + `Name the tracker with \`${TRACKER_FLAG}<key>\` if that is wrong.`
    : null;
  return { tracker, note };
}

/**
 * #4078: A TRACKER'S MILESTONES ARE THE HOME TRACKER'S ALONE (the declaration's first). The release the milestone names is the product's, and an org row's release is
 * `--label out-of-release` and nothing else: the agent-org tracker has no "Out of release" milestone, so asking `gh` for one fails the
 * filing. So the home tracker keeps the milestone rule exactly as it was and any other tracker NEITHER reads its milestones NOR writes one.
 * @param {Tracker} tracker @param {{ tracker: Tracker[] }} declaration @returns {boolean}
 */
const usesMilestones = (tracker: Tracker, { tracker: trackers }: { tracker: Tracker[]; }): boolean => sameTracker(tracker, trackers[0]);

/** @param {string[]} argv @param {Tracker} tracker @param {{ tracker: Tracker[] }} declaration @returns {string[]} */
const releaseArgvFor = (argv: string[], tracker: Tracker, declaration: { tracker: Tracker[]; }): string[] => (usesMilestones(tracker, declaration) ? outOfReleaseArgv(argv) : argv);

/**
 * #4378: THE TITLES OF THE TRACKER'S OPEN MILESTONES WHOSE DESCRIPTION CARRIES THE `Primary: yes` LINE -- the milestone is data `ceo` sets (#4231), never a title this file knows. `null` when the list
 * could not be read, which is "could not say" and not "none".
 * @param {{ run?: typeof defaultRun, repo?: string }} [deps] @returns {string[] | null}
 */
export function primaryMilestoneTitles({ run = defaultRun, repo = REPO }: { run?: typeof defaultRun; repo?: string; } = {}): string[] | null {
  try {
    const listed: { title?: string; description?: string | null; }[] = JSON.parse(run("gh", ["api", `repos/${repo}/milestones`]));
    return listed.filter((milestone) => PRIMARY_MILESTONE_LINE.test(String(milestone.description ?? ""))).map((milestone) => String(milestone.title ?? ""));
  } catch {
    return null; // CANNOT_ASK: `primaryMilestoneRefusal` says so and files, rather than refusing on a read it could not make
  }
}

/**
 * #4378: AN ORG ROW IS NOT FILED INTO THE PRIMARY MILESTONE. The milestone's open-row count was read as progress, and org rows filed into it hid a product stall (the chairman, 2026-10-09). The row is judged by
 * `adopterRowKind`, #3820's `rowKind` over the repositories not declared `adopterFacing: false`; the refusal names the Region entry that made it org and the two ways out. A Region that cannot be read is org by
 * `rowKind`'s own word and is refused saying so. (An `epic` never reaches this: it takes its state label after filing, and the clock does not judge one.) DORMANT until the declaration names `adopterFacing` once, and for a tracker with no
 * milestones of its own. A milestone list that cannot be read files the row with a warning: the clock (`milestoneClockFact`) does not count an org row either way.
 * @param {string[]} argv @param {string} body @param {Tracker} tracker @param {AdopterDeclaration} declaration
 * @param {{ primaryMilestones: typeof primaryMilestoneTitles, run: typeof defaultRun }} deps @returns {string | null}
 */
export function primaryMilestoneRefusal(argv: string[], body: string, tracker: Tracker, declaration: AdopterDeclaration, { primaryMilestones, run }: { primaryMilestones: typeof primaryMilestoneTitles; run: typeof defaultRun; }): string | null {
  const milestone = milestoneFromArgv(argv);
  if (milestone === null || !usesMilestones(tracker, declaration) || !adopterFacingDeclared(declaration)) return null;
  const primaries = primaryMilestones({ run, repo: tracker.repo });
  if (primaries === null) {
    process.stderr.write(`row-file: warning: could not read ${tracker.repo}'s milestones, so whether "${milestone}" is the primary one was not checked.\n`);
    return null;
  }
  if (!primaries.some((title) => sameLabel(title, milestone))) return null;
  const { kind, because } = adopterRowKind(declaredRegionFiles(body), declaration);
  if (kind === "adopter") return null;
  return `row-file: REFUSING to file an org row into the primary milestone "${milestone}" -- nothing was sent to GitHub.\n`
    + `  The milestone holds adopter-facing rows only (#4378), and this row is not one: ${because}.\n`
    + `  Either: --milestone "${OUT_OF_RELEASE_MILESTONE}" --label ${OUT_OF_RELEASE} -- the row is org work and is outside the release\n`
    + "  Or:     the tracker the row belongs in (`--tracker=<key>`), if it is not this project's work at all";
}

/**
 * The refusal for a filing that declares no release: the milestone one, naming the home tracker's milestones, or for any other tracker
 * the label-only one, which reads nothing.
 * @param {Tracker} tracker @param {{ tracker: Tracker[] }} declaration @param {{ run: typeof defaultRun, milestones: typeof openMilestones }} deps @returns {string}
 */
function undeclaredReleaseRefusal(tracker: Tracker, declaration: { tracker: Tracker[]; }, { run, milestones }: { run: typeof defaultRun; milestones: typeof openMilestones; }): string {
  if (usesMilestones(tracker, declaration)) return milestoneRefusal(milestones({ run, repo: tracker.repo }), tracker.repo);
  return `row-file: REFUSING to file a row that declares no release -- nothing was sent to GitHub.\n`
    + `  ${tracker.repo} has no release milestone: an org row says it is outside the release with \`--label ${OUT_OF_RELEASE}\`.`;
}

/**
 * `gh issue create` is told the tracker's repository unless the filing is in the home tracker, where it runs as it always did. Ours is
 * appended last, and `gh` takes the last `--repo`, so a filer's own `--repo` cannot send the row somewhere its labels and board are not.
 * @param {string[]} argv @param {Tracker} tracker @param {{ tracker: Tracker[] }} declaration @returns {string[]}
 */
const filedInTracker = (argv: string[], tracker: Tracker, declaration: { tracker: Tracker[]; }): string[] => (usesMilestones(tracker, declaration) ? argv : [...argv, "--repo", tracker.repo]);

/**
 * #4078: THE LABEL THE CREATE ITSELF CARRIES MUST EXIST IN THE TARGET before `gh issue create` names it, which refuses an unknown one. The
 * board and lane labels are made later by `boardAndVerify`; this is the one this tool writes at creation. Only for another tracker: the
 * home tracker has it, and creating the filer's OTHER labels would turn a typo into a new label.
 * @param {string[]} filedArgv @param {Tracker} tracker @param {{ tracker: Tracker[] }} declaration
 * @param {{ run: typeof defaultRun, ensureLabels: typeof ensureLabelsOn }} deps
 */
function ensureReleaseLabel(filedArgv: string[], tracker: Tracker, declaration: { tracker: Tracker[]; }, { run, ensureLabels }: { run: typeof defaultRun; ensureLabels: typeof ensureLabelsOn; }) {
  if (usesMilestones(tracker, declaration) || !labelsOutOfRelease(filedArgv)) return;
  ensureLabels([OUT_OF_RELEASE], { run, repo: tracker.repo });
}

/**
 * Checks, then (only if it passes) files, with `Filed-by:` and a board label appended into the body/argv
 * that actually reach `gh`, adds the new issue to Project 2 with a matching Status, and REFUSES to
 * report success until a fresh read-back confirms all three landed -- #844: `row-file` used to hand a
 * created issue straight to `gh` with nothing else, so the filer had to remember the board and the
 * labels by hand, and five rows filed one night landed off Project 2, one (#844's own measurement) with
 * no labels at all. A row this cannot board is refused, not reported filed halfway: it prints exactly
 * which of the three did not stick and a distinct exit code, never a plain success for a row nothing
 * else can find.
 *
 * Injectable `spawnGh`/`run`/`fetchBoardStatus`/`loadLanesConfig` so a test can prove every step -- the
 * label composed into argv, the lane derivation, the board-add call, the Status move, and the read-back
 * -- without spawning a real `gh`, reaching GitHub, or reading a real `docs/lane-ownership.json`.
 * @param {string[]} argv
 * @param {{ spawnGh?: (argv: string[]) => string, run?: typeof defaultRun,
 *   fetchBoardStatus?: typeof fetchIssueBoardStatus, fetchLabels?: typeof fetchIssueLabels,
 *   moveStatus?: typeof moveTrackerStatus, ensureLabels?: typeof ensureLabelsOn,
 *   loadLanesConfig?: typeof loadLanes, declaration?: Parameters<typeof rowTracker>[1] & { tracker: Tracker[] } }} deps
 *   `declaration` (#4078) is the project's `tracker`, `code` and `dora` lists, which `rowTracker` reads; the home project's by default
 * @returns {number} the process exit code
 */
export function createIssue(argv: string[], deps: {
    spawnGh?: (argv: string[]) => string; run?: typeof defaultRun;
    fetchBoardStatus?: typeof fetchIssueBoardStatus; fetchLabels?: typeof fetchIssueLabels;
    moveStatus?: typeof moveTrackerStatus; ensureLabels?: typeof ensureLabelsOn;
    loadLanesConfig?: typeof loadLanes; declaration?: Parameters<typeof rowTracker>[1] & { tracker: Tracker[]; };
    roadmapItems?: typeof roadmapItemsOf; roadmapField?: typeof roadmapFieldOf; // #516
} = {}): number {
  const ctx = mergeIssueDeps(deps);
  const { declaration } = ctx;
  const session = sessionFromArgv(argv);
  const unknownKind = kindRefusal(argv);
  if (unknownKind) {
    process.stderr.write(`${unknownKind}\n`);
    return 1;
  }
  if (!session) {
    process.stderr.write("row-file: --session=<name> is required -- Filed-by: is taken from the session "
      + "filing the row, never guessed and never left blank.\n");
    return 1;
  }
  const body = bodyFromArgv(argv);
  const reason = fileRefusalReason(body) ?? roadmapWithoutParentRefusal(argv); // #516
  if (reason) {
    process.stderr.write(`${reason}\n`);
    return 1;
  }
  // #4078: THE TRACKER, chosen before anything reads a repository: the blocker below lives in it, and so do the milestone read, the
  // labels and the board.
  const chosen = chooseTracker(argv, (body as string), declaration);
  if ("refusal" in chosen) {
    process.stderr.write(`${chosen.refusal}\n`);
    return 1;
  }
  // #855: a `--ready` row names only directories its repository has. Backlog rows are not read: a judgement that can wait for pickup.
  if (boardingFor(argv).status === "Ready") {
    const absent = absentRegionTopDirReason(body as string, { code: declaration.code, trackerRepo: chosen.tracker.repo });
    if (absent) {
      process.stderr.write(`${absent}\n`);
      return 1;
    }
  }
  const { tracker } = chosen;
  if (chosen.note !== null) process.stderr.write(`${chosen.note}\n`);
  const planned = planIssue(argv, ctx, { body: body as string, session, tracker });
  if (typeof planned === "number") return planned;
  return fileIssue(planned, ctx);
}

/** The seams `createIssue` takes, each defaulted to its real one: a test replaces any of them, and nothing else reads them. */
function mergeIssueDeps(deps: NonNullable<Parameters<typeof createIssue>[1]>) {
  // A single spread merge, not seven per-property default values -- each `x = defaultX` in a destructured
  // parameter is its own branch for this repo's complexity gate, and `createIssue` already carries the
  // real decision points (session/template/lane refusals, the `gh` try/catch, the two post-file checks).
  // Injectable so a test can prove every step -- the label composed into argv, the lane derivation, the
  // board-add call, the Status move, and the read-back -- without spawning a real `gh`, reaching GitHub,
  // or reading a real `docs/lane-ownership.json`.
  return {
    spawnGh: spawnGhIssueCreate, run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus,
    fetchLabels: fetchIssueLabels, moveStatus: moveTrackerStatus, ensureLabels: ensureLabelsOn,
    loadLanesConfig: loadLanes, milestones: openMilestones, primaryMilestones: primaryMilestoneTitles, declaration: homeProjectDeclaration(),
    roadmapItems: roadmapItemsOf, roadmapField: roadmapFieldOf, ...deps,
  };
}

/** The refusals after the tracker is chosen, and the plan the filing is made from. Nothing is filed here, so a refusal leaves nothing behind. */
function planIssue(argv: string[], ctx: ReturnType<typeof mergeIssueDeps>, filing: { body: string; session: string; tracker: Tracker; }) {
  const { run, milestones, primaryMilestones, loadLanesConfig, roadmapItems, roadmapField, declaration } = ctx;
  const { body, session, tracker } = filing;
  // #1158: AFTER the refusals and BEFORE anything is filed. None of these stops the filing -- see
  // `unrecognisedRegionWarning` for why a warning rather than a refusal -- but the author sees them while they
  // still have the body in front of them, which is the only moment each line is cheap to act on. They answer
  // different questions about one body and a body can trip several: all are printed, never chosen between.
  // #2035: the acceptance-side three (`regionClosureWarning`, `quotedTestCountWarning`,
  // `malformedAcceptanceCommandWarning`) join the four Region/waiting ones in `filingWarnings`.
  const umbrella = blockedByRefusal((body as string), argv, { read: (number) => readBlocker(number, run, tracker.repo) }) ?? chairmanAskRefusal((body as string)) // #4020: a declared ask that could never raise one
    ?? unsplitDoneWhenRefusal((body as string), { declared: { blockedBy: blockedByNumbers(argv), labels: labelValuesFromArgv(argv) } }); // #4640: a Done-when no engineer can finish
  if (umbrella) {
    process.stderr.write(`${umbrella}\n`);
    return 1;
  }
  const blast = blastRadiusOf((body as string), run, declaration); // #4601: before anything is filed, so a refusal leaves nothing behind
  if (blast.refusal) {
    process.stderr.write(`${blast.refusal}\n`);
    return 1;
  }
  if (blast.warning) process.stderr.write(`${blast.warning}\n`);
  for (const warning of filingWarnings((body as string), argv)) {
    process.stderr.write(`row-file: ${warning}\n`);
  }
  // #883: THE LANE(S), DERIVED BEFORE ANYTHING IS FILED -- see `laneLabelsOrRefusal`'s own header for why
  // a missing/malformed `docs/lane-ownership.json` refuses here rather than guessing.
  const laneResult = laneLabelsOrRefusal((body as string), loadLanesConfig, argv);
  if (!laneResult.ok) {
    process.stderr.write(`${laneResult.message}\n`);
    return 1;
  }
  const laneLabels = laneResult.laneLabels;
  // #1011: BEFORE `gh issue create`, so a refusal leaves nothing behind. See `milestoneRefusal`.
  const releaseRefusal = declaresRelease(argv)
    ? primaryMilestoneRefusal(argv, (body as string), tracker, declaration, { primaryMilestones, run }) // #4378
    : undeclaredReleaseRefusal(tracker, declaration, { run, milestones });
  if (releaseRefusal) {
    process.stderr.write(`${releaseRefusal}\n`);
    return 1;
  }
  const duplicate = duplicateTitleRefusal(argv, tracker, run); // #4294: before the create call, so a refusal leaves nothing behind
  if (duplicate) {
    process.stderr.write(`${duplicate}\n`);
    return 1;
  }
  // #4603: A SESSION HOLDING A CLAIMED SWEEP FILES NO FOLLOW-UP INTO ITS AREA UNTIL THE MERGE, refused before the create call like the duplicate title above -- the one filing path that can read both the session and the sweep.
  const sweepHeld = sweepFilingAtFiling({ session, body: (body as string), reads: { run: ghRunner(run), repo: tracker.repo, repos: declaration.code } });
  if (sweepHeld) {
    process.stderr.write(`${sweepHeld}\n`);
    return 1;
  }
  // #516: the epic's value is read and the flag judged BEFORE the create call, so a refusal leaves nothing behind.
  const roadmap = roadmapPlan(argv, tracker, { run, roadmapItems, roadmapField });
  if ("refusal" in roadmap) {
    process.stderr.write(`${roadmap.refusal}\n`);
    return 1;
  }
  if (roadmap.warning !== null) process.stderr.write(`${roadmap.warning}\n`);
  const boarding = boardingFor(argv);
  // #844: THE BOARD LABEL IS NOT ADDED HERE -- see `boardAndVerify`'s own header for why it has to wait
  // until AFTER the Project Status is set, not merely after the issue exists. The lane label(s) travel
  // with it for the identical reason and the same simplicity: one label-add step, not two.
  // #1130: the label alone must not leave the row out of the milestone that says the same thing.
  // #1322: the board and lane labels are this tool's to apply, after the Status move. A filer's copy of either is
  // dropped from the create call rather than landing at creation beside them -- a `ready` there is #867's refusal.
  const filedArgv = filedInTracker(withFiledBy(withoutLabels(releaseArgvFor(withKindLabel(argv), tracker, declaration), [...BOARD_LABELS, ...laneLabels]), session,
    appendDistinctFrom((body as string), argv)), tracker, declaration);
  return { session, tracker, declaration, blast, laneLabels, roadmap, boarding, filedArgv };
}

/** Files the planned row: the create call, then the read-back that confirms the board, the labels and the roadmap value landed. */
function fileIssue({ session, tracker, declaration, blast, laneLabels, roadmap, boarding, filedArgv }: Exclude<ReturnType<typeof planIssue>, number>,
  ctx: ReturnType<typeof mergeIssueDeps>): number {
  const { spawnGh, run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels, roadmapItems } = ctx;
  let url: string;
  try {
    ensureReleaseLabel(filedArgv, tracker, declaration, { run, ensureLabels });
    if (kindLabelOf(filedArgv) !== null) ensureLabels([DEFECT_LABEL], { run, repo: tracker.repo }); // #4123: `gh issue create` refuses a label the repository lacks
    url = spawnGh(filedArgv);
  } catch (error) {
    process.stderr.write(`row-file: gh issue create failed -- nothing was filed. `
      + `${(error as Error).message}\n`);
    return (error as { status?: number }).status ?? 1;
  }
  const issueNumber = issueNumberFromUrl(url);
  if (issueNumber === null) {
    process.stderr.write(`row-file: FILED, but could not read an issue number back from gh's own output `
      + `-- cannot board it or verify it. gh printed: ${url}\n`);
    return 2;
  }

  const result = boardAndVerify({ issueNumber, url, boarding, session, laneLabels, tracker,
    ...releaseExpectation(filedArgv) }, { run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels });
  if (!result.ok) {
    process.stderr.write(`row-file: ${result.message}\n`);
    return 2;
  }
  if (roadmap.set !== null) {
    const failed = setRoadmapValue(issueNumber, tracker, roadmap.set, { run, roadmapItems });
    if (failed !== null) {
      process.stderr.write(`row-file: FILED as #${issueNumber} and boarded, but its \`${ROADMAP_FIELD}\` could not be set to \`${roadmap.set.option.name}\` -- ${failed}. `
        + `Set it by hand: gh project item-edit --id <item> --project-id ${roadmap.set.field.projectId} --field-id ${roadmap.set.field.fieldId} `
        + `--single-select-option-id ${roadmap.set.option.id}\n`); // #516: a failed set is a failure, not a warning
      return 2;
    }
  }
  if (blast.note) process.stderr.write(`${blast.note}\n`);
  process.stdout.write(`https://github.com/${tracker.repo}/issues/${issueNumber}\n`);
  return 0;
}

/**
 * #4601: HOW MUCH OF THE TREE THIS REGION RESERVES, judged by `blast-radius.ts`. Over 20 files or 5 open rows and pull requests refuses
 * unless the body declares a sweep; the reads go through the injected `run`, so a test needs no network.
 */
function blastRadiusOf(body: string, run: typeof defaultRun, declaration: Parameters<typeof ghBlastReads>[1]): BlastVerdict {
  return blastRadiusGate(body, ghBlastReads(run, declaration));
}

/**
 * #4078: THE STATUS MOVE, ON THE TRACKER'S BOARD. The home tracker's is `moveProjectStatus` exactly as it was, with its pre-write snapshot of
 * the home board (#399, #747's floor). Another tracker's board is not that board, and the snapshot reads the home one, so a move on it is the
 * one `item-edit` and its failure, stated rather than guarded by a reading of the wrong board.
 * @param {number} issueNumber @param {string} statusName
 * @param {{ run?: typeof defaultRun, tracker?: Tracker }} [deps]
 * @returns {ReturnType<typeof moveProjectStatus>}
 */
export function moveTrackerStatus(issueNumber: number, statusName: string, { run = defaultRun, tracker = homeTracker() }: { run?: typeof defaultRun; tracker?: Tracker; } = {}): ReturnType<typeof moveProjectStatus> {
  if (sameTracker(tracker, homeTracker())) return moveProjectStatus(issueNumber, statusName, { run });
  try {
    run("gh", ["project", "item-edit", String(tracker.board.number), "--owner", tracker.board.owner,
      "--url", `https://github.com/${tracker.repo}/issues/${issueNumber}`, "--field", "Status", "--value", statusName]);
    return { moved: true };
  } catch (error) {
    const message = (error as Error).message;
    return { moved: false, notOnBoard: /is not an item in project/.test(message),
      reason: `could not move #${issueNumber}'s Status to "${statusName}" on ${tracker.board.owner}/projects/${tracker.board.number} -- ${message}` };
  }
}

/**
 * #4078: THE LABELS, ENSURED IN THE REPOSITORY THE ROW IS FILED IN. `ensureLabelsExist` creates them in the home repository only, so a row
 * filed elsewhere would be refused its `lane:*` and `ready`/`backlog` by `gh issue edit --add-label` (#749). The home repository keeps
 * `ensureLabelsExist` exactly as it was.
 * @param {string[]} labels @param {{ run?: typeof defaultRun, repo?: string }} [deps]
 */
export function ensureLabelsOn(labels: string[], { run = defaultRun, repo = REPO }: { run?: typeof defaultRun; repo?: string; } = {}) {
  if (repo === REPO) return ensureLabelsExist(labels, { run });
  for (const label of labels) run("gh", ["label", "create", label, "--repo", repo, "--force"]);
}

/**
 * The item-add rung's refusal: what failed, what it SKIPPED, and the command for each.
 *
 * Extracted for `boardAndVerify`'s line budget, but it earns its own name: this is the rung that skips
 * TWO steps rather than one, so it is the only refusal in the ladder that has to describe a repair in
 * three parts. Reported by worker-capture on #1250 -- the first #1249 fix reached the Status rung, which
 * is the one the FILING author hit, and left this one, which is the rung the reviewer's own filing hit.
 * @param {{ issueNumber: number, url: string, boarding: { status: string, label: string }, tracker: Tracker,
 *           allLabels: string[], repairLabels: string, lead: string }} row
 * @param {unknown} error
 */
function boardAddRefusal({ issueNumber, url, boarding, tracker, allLabels, repairLabels, lead }: {
        issueNumber: number; url: string; boarding: { status: string; label: string; }; tracker: Tracker;
        allLabels: string[]; repairLabels: string; lead: string;
    }, error: unknown) {
  const { number: boardNumber, owner: boardOwner } = tracker.board;
  return `${lead}, but could NOT add it to Project ${boardNumber} -- refusing to `
    + `report success for a row nothing else can find. ${(error as Error).message}\n  `
    + `AND neither the Status "${boarding.status}" nor ${allLabels.map((l) => `\`${l}\``).join("/")} `
    + `were applied, because both steps sit behind the board add and neither ran. Adding it by hand `
    + `alone leaves this row on the board with no Status and no labels. Apply all three:\n`
    + `    gh project item-add ${boardNumber} --owner ${boardOwner} --url ${url}\n`
    + `    gh project item-edit ${boardNumber} --owner ${boardOwner} --url ${url} `
    + `--field Status --value "${boarding.status}"\n`
    + `    ${repairLabels}`;
}

/**
 * #844: board the freshly-created issue, set its Status, ONLY THEN add the board label, and finally
 * read all three records back -- pulled out of `createIssue` to keep that function's own complexity
 * under this repo's gate; it is the same one concept (board it, then prove it) written out, rather than
 * a genuinely separate responsibility.
 *
 * THE LABEL GOES ON LAST, AND THAT ORDER IS LOAD-BEARING, FOUND BY DOGFOODING THIS EXACT FIX (#867,
 * filed live with `--ready` while building this row): `moveStatus` snapshots the WHOLE board first
 * (#399's own rule), and #747's own floor inside that snapshot refuses if any OPEN `ready`-labelled
 * issue has no Status. A `ready` label added at CREATION time -- before the item is even on the board,
 * let alone has a Status -- makes the freshly-filed row itself the exact row that floor exists to catch,
 * refusing every `--ready` filing, always, on its own snapshot. Labelling AFTER the Status is set means
 * no reader (including this filing's own next step) ever sees `ready` without a Status: the row is
 * either not yet labelled `ready` at all (invisible to that floor, same as an ordinary unlabelled issue)
 * or fully consistent (labelled AND Statused) by the time anything could ask.
 * `--board=` (a row somebody else filed) calls this too: `session: null` skips the Filed-by read-back and
 * `lead` replaces the "FILED as #n" every refusal opens with, which would be false of a row that already existed.
 * #4078: `tracker` is the tracker the row lives in -- its repository for every label and read, its board for the item-add, the Status move and
 * the read-back, which asks the SAME board it wrote. The home tracker by default, which is what `--board=` and `--promote=` mean.
 * @param {{ issueNumber: number, url: string, boarding: { label: string, status: string },
 *   session: string | null, laneLabels: string[], milestone: string | null,
 *   releaseLabel?: string | null, kindLabel?: string | null, lead?: string, tracker?: Tracker }} filed
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveTrackerStatus,
 *   ensureLabels: typeof ensureLabelsOn }} deps
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function boardAndVerify({ issueNumber, url, boarding, session, laneLabels, milestone,
  releaseLabel = null, kindLabel = null, lead = `FILED as #${issueNumber}`, tracker = homeTracker() }: {
        issueNumber: number; url: string; boarding: { label: string; status: string; };
        session: string | null; laneLabels: string[]; milestone: string | null;
        releaseLabel?: string | null; kindLabel?: string | null; lead?: string; tracker?: Tracker;
    },
{ run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels }: {
    run: typeof defaultRun; fetchBoardStatus: typeof fetchIssueBoardStatus;
    fetchLabels: typeof fetchIssueLabels; moveStatus: typeof moveTrackerStatus;
    ensureLabels: typeof ensureLabelsOn;
}): { ok: true; } | { ok: false; message: string; } {
  const { repo } = tracker;
  const { number: boardNumber, owner: boardOwner } = tracker.board;
  // #1249: `allLabels` is derived HERE, above the first step that can fail, so every refusal below can
  // name the labels it skipped. An operator cannot derive them -- they come from the Region -- so a
  // message that says "the labels" instead of `backlog`/`lane:any` is one they have to reconstruct.
  const allLabels = [boarding.label, ...laneLabels];
  const repairLabels = `gh issue edit ${issueNumber} --repo ${repo} `
    + `${allLabels.map((l) => `--add-label ${l}`).join(" ")}`;
  try {
    run("gh", ["project", "item-add", String(boardNumber), "--owner", boardOwner, "--url", url]);
  } catch (error) {
    // #1249, SECOND RUNG: this one skips TWO steps, not one. item-add is the first of three, and the
    // Status and the labels below both sit behind it -- so an operator who follows this message exactly
    // gets the row onto the board with no Status and no labels, which is the partial filing this whole
    // ladder exists to refuse, one rung up. Reported by worker-capture on #1250, whose point was that
    // the first fix reached the rung MY filing hit and not the rung THEIRS did.
    return { ok: false,
      message: boardAddRefusal({ issueNumber, url, boarding, tracker, allLabels, repairLabels, lead }, error) };
  }
  const statusResult = moveStatus(issueNumber, boarding.status, { run, tracker });
  if (!statusResult.moved) {
    // #1249: NAME EVERY STEP THIS SKIPS, not only the one that failed.
    //
    // #1248 was filed with NO LABELS AT ALL and this message said only that the Status had not moved.
    // The label step is below and never runs, so an operator who follows the refusal exactly fixes the
    // Status and stops -- and the row stays invisible to every label-keyed view, which is #623's defect
    // arriving through a partial filing rather than through a missing label.
    //
    // THE ORDER IS KEPT AND THE MESSAGE CARRIES THE WEIGHT. Applying labels first would leave a labelled
    // row on a Status failure, which is friendlier -- but it makes the Status the partial half instead,
    // and the board is what the org reads for what is claimable. A report that describes ALL of what is
    // missing is what must survive, whichever half is written first.
    return { ok: false, message: `${lead} and added to Project ${boardNumber}, but `
      + `its Status could not be set to "${boarding.status}" -- ${statusResult.reason}\n  `
      + `AND ${allLabels.map((l) => `\`${l}\``).join("/")} were NOT applied, because the Status failed `
      + `first and the label step never ran. Fixing only the Status leaves this row unlabelled and `
      + `invisible to every label-keyed view. Apply both: ${repairLabels}` };
  }
  try {
    // #883: `lane:<owner>` is a PER-DERIVATION label -- `lane:dispatcher`, `lane:any`, whatever the
    // Region maps to -- and #749's own lesson applies identically here: `gh issue edit --add-label`
    // refuses a label that does not already exist in the repository. `ensureLabels` (row-claim.ts's own
    // `ensureLabelsExist`, reused rather than a second copy) creates it idempotently first.
    ensureLabels(allLabels, { run, repo });
    run("gh", ["issue", "edit", String(issueNumber), "--repo", repo,
      ...allLabels.flatMap((l) => ["--add-label", l])]);
  } catch (error) {
    return { ok: false, message: `${lead}, boarded with Status "${boarding.status}", `
      + `but ${allLabels.map((l) => `\`${l}\``).join("/")} could not be added -- `
      + `${(error as Error).message}` };
  }

  let bodyAfter: string | null;
  try {
    bodyAfter = run("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", "body",
      "--jq", ".body"]);
  } catch {
    bodyAfter = null; // read-back failure reads as "cannot confirm the Filed-by line", not a crash
  }
  let milestoneAfter: string | null;
  try {
    milestoneAfter = run("gh", ["issue", "view", String(issueNumber), "--repo", repo, "--json", "milestone",
      "--jq", ".milestone.title // \"\""]).trim() || null;
  } catch {
    milestoneAfter = null; // unreadable reads as "cannot confirm", which `unverifiedFilingFields` names
  }
  const after = {
    labels: fetchLabels(issueNumber, { run, repo }).labels,
    body: bodyAfter,
    boardStatus: fetchBoardStatus(issueNumber, { run, tracker }),
    milestone: milestoneAfter,
  };
  const missing = unverifiedFilingFields(after,
    { session, label: boarding.label, status: boarding.status, laneLabels, milestone, releaseLabel, kindLabel,
      projectNumber: boardNumber });
  if (missing.length > 0) {
    return { ok: false, message: `${lead}, but the read-back does not confirm it -- `
      + `missing: ${missing.join(", ")}. Refusing to report success for a row it could not fully board.` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------
// #2111: PROMOTION -- the SECOND act this file owns, and the one that was three separate hand writes.
//
// Filing gets a row's label and its board Status right in one act, and says so in this file's own header.
// Promoting one did not exist here at all: `gh issue edit --add-label ready`, `gh issue edit
// --remove-label backlog`, and a Status move to `Ready`, typed by hand, in any order, by whoever
// remembered. Miss the second and the row carries `backlog` AND `ready`, which nothing reported --
// measured 2026-09-23 on #2050 and #2110, both in that state for roughly 25 minutes, both found by a
// person rather than by a check.
//
// WHAT THAT COSTS IS NOT WHAT IT LOOKS LIKE. `backlog` is not in `work-gate.ts`'s `NOT_PICKABLE`, so a
// doubly-labelled row is still offered and still claimable -- nobody is hidden. The cost is DOUBLE-COUNTED
// STOCK: `readPromotableRows` reads `--label backlog` SERVER-SIDE and then filters only on `NOT_STARTABLE`
// and `waitingOn`, neither of which excludes `ready`. A promoted row that keeps `backlog` is counted as
// promotable backlog WHILE ALSO BEING READY, which distorts exactly the two judgments keyed on those
// populations (`ready-queue-empty`, `lane-backlog-unpromoted`) -- the same shape as #1899 and #1804's
// `meta` case, both recorded in the comments around that very function.
//
// FIXED AT THE SOURCE, NOT IN EVERY READER (`ceo`'s direction, 2026-09-23). Teaching `readPromotableRows`
// to ignore a row carrying `ready` would leave the row wrong on the board, in the Ready lane view, in the
// WIP count and in the audit, and would fix only the one reader that happened to be measured.
// ---------------------------------------------------------------------------------------------------

/** #2111: the one flag that makes this invocation a PROMOTE rather than a FILE. */
export const PROMOTE_FLAG = "--promote=";

/**
 * The row this invocation promotes, or `null` when `--promote=` is absent, empty, or names something
 * that is not a positive integer. Read through `flagValue`, the shared extractor `cli-flags.ts` owns,
 * rather than a sixteenth hand-rolled copy of the same three lines -- that file's own header records
 * what the one copy that drifted did.
 *
 * `null` for BOTH "absent" and "malformed" on purpose: `main` routes on the flag's PRESENCE, so by the
 * time this is asked the flag is known to be there and `null` can only mean the value is unusable.
 * @param {string[]} argv
 * @returns {number | null}
 */
export function promoteFromArgv(argv: string[]): number | null {
  const value = (flagValue(argv, "promote") ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/**
 * #2111: EVERY OTHER ARGUMENT, REFUSED -- a promotion files nothing, so a `--title`, `--body`, `--label`
 * or `--milestone` beside it is a caller who thinks they are filing. `refuseUnknownFlags` cannot catch
 * these: they are flags this command genuinely knows, on the other of its two paths, and a flag silently
 * ignored on the path you are actually on is the exact defect that file exists to end.
 *
 * `--session=<name>` is the one exception, ACCEPTED AND ECHOED in the success line rather than ignored:
 * every other act in this org names its session, and a refusal there would put friction on the act whose
 * whole purpose is to be used instead of three hand writes.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function promoteArgvRefusal(argv: string[]): string | null {
  const stray = argv.filter((a) => !a.startsWith(PROMOTE_FLAG) && !a.startsWith("--session="));
  if (stray.length === 0) return null;
  return `row-file: REFUSING to promote -- \`${PROMOTE_FLAG}<n>\` takes no argument but \`--session=<name>\`, `
    + `and ${stray.length} other(s) were given: ${stray.join(", ")}. A promotion FILES NOTHING: it adds `
    + `\`${READY_LABEL}\`, removes \`${BACKLOG_LABEL}\` and moves the Status of a row that already exists. `
    + "Nothing was changed.";
}

/** What a promotion asks of the lint. Every field is injectable; absent, it is this machine's. */
export type SpecLintAtPromotion = {
  /** `rows.specLint`. Absent, this checkout's declaration says ({@link readSpecLintFlag}). */
  enabled?: boolean;
  /** The lint's three machine questions. Absent, {@link specLintDeps}. */
  deps?: LintDeps;
  /** Told each refusal's findings. The act sites pass {@link recordSpecLintRefusals}; a bare verdict records nothing. */
  record?: (issueNumber: number, findings: readonly { field: string; rule: string; }[]) => void;
};

/** `rows.specLint` as `checkout`'s declaration says it. A checkout with no declaration is a project that never declared it: OFF. */
export function readSpecLintFlag(checkout: string = HOME_CHECKOUT): boolean {
  try {
    return specLintFlagOf(readFileSync(`${checkout}/.agent-org/project.json`, "utf8"));
  } catch (cause) {
    void cause; // no declaration at this checkout is a project that never declared the flag: OFF
    return false;
  }
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|sh)$/i;
const TEST_FILE_NAME = /(?:\.(?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]+$|_test\.[a-z]+$)/i;
/** A row that says it carries a spec: the fence's opening (a block never closed included, so it is refused as missing and not read as none), a `Spec` heading, or `Spec:`. */
const SPEC_MARKER = /^[ \t]*(?:```spec\b|#{1,6}[ \t]*spec\b|(?:\*\*|__)?spec:)/im;

/**
 * IS THIS A BUILD ROW, which is the CALLER's question (`specLintRefusalReason` takes it as `requireBlock`)? A Region that names a source file, and a body that says
 * `Tests-first:` or carries a spec marker. A decomposition, investigation or fleet row names no source file or no marker, and is exempt by saying nothing (a11ign#5109).
 */
function requiresSpecBlock(body: string): boolean {
  const names = regionPathTokens(body).map((token) => splitRegionEntry(token).path);
  const buildsSource = names.some((path) => SOURCE_FILE.test(path) && !TEST_FILE_NAME.test(path));
  return buildsSource && (testsFirstOf(body).marked || SPEC_MARKER.test(body));
}

/** The checkout on this disk of each repository prefix (`""` is the row's own) a Region can name; a repository with none is absent. */
function machineRoots(): Record<string, string> {
  const roots: Record<string, string> = {};
  for (const key of ["", ...homeProjectDeclaration().code.map((entry) => entry.key)]) {
    const checkout = checkoutOfKey(key);
    if (checkout !== null && existsSync(checkout)) roots[key] = checkout;
  }
  return roots;
}

/**
 * The lint's three questions from this machine, with ONE change from `machineDeps`: a file is looked for on `origin/main` of the repository's checkout, as
 * `absentRegionTopDirReason` does, and not in its working tree, which lags `origin/main` on a host nobody pulls in. A refusal for a file that exists is the failure
 * this lint cannot afford. A repository with no checkout on this disk has no root, so its prefix is `null` (could not tell), never a refusal.
 */
export function specLintDeps(roots: Record<string, string> = machineRoots()): LintDeps {
  return {
    ...machineDeps(roots),
    // `repoHasTopLevelDir` is `git ls-tree origin/main -- <path>`, and answers for any path; `null` when git cannot say.
    fileExists: (entry) => {
      const { key, path } = splitRegionEntry(entry);
      const root = roots[key];
      return root === undefined ? null : repoHasTopLevelDir(root, path);
    },
  };
}

/** The (field, rule) of each finding of a body the lint refused. A row refused for having no block has no finding of the lint's, and is `spec` / `no-block`. */
function refusedFindings(body: string, deps: LintDeps): { field: string; rule: string; }[] {
  const linted = lintRowBody(body, deps);
  return linted.status === "linted" ? linted.findings.map(({ field, rule }) => ({ field, rule })) : [{ field: "spec", rule: "no-block" }];
}

/** THE LINT'S VERDICT AT PROMOTION, `null` meaning proceed. Off, it is `null` without reading anything. */
function specLintPromotionReason(body: string, issueNumber: number, { enabled = readSpecLintFlag(), deps, record }: SpecLintAtPromotion): string | null {
  if (!enabled) return null;
  const lintDeps = deps ?? specLintDeps();
  const reason = specLintRefusalReason(body, issueNumber, lintDeps, { requireBlock: requiresSpecBlock(body) });
  if (reason !== null) record?.(issueNumber, refusedFindings(body, lintDeps));
  return reason;
}

/** One ledger line per finding (row, field, rule). Never throws: `recordFailure` says an append it could not make on stderr, and the refusal is what it was. */
export function recordSpecLintRefusals(issueNumber: number, findings: readonly { field: string; rule: string; }[],
  { logPath = stateEntryPath(FAILURE_LEDGER_FILE), now = Date.now() }: { logPath?: string; now?: number; } = {}): void {
  for (const { field, rule } of findings) recordFailure({ logPath, classKey: SPEC_LINT_REFUSED_KIND, ref: `#${issueNumber} ${field} ${rule}`, now });
}

/**
 * #2111 clause 2: IS THE ROW STILL CLAIMABLE AS IT STANDS? Asked of the row's EXISTING body, through the
 * two rules that already own this question -- `templateFieldsReason` (the claim side's own refusal,
 * which names the issue number) and `fileRefusalReason` (the filing side's, this file's own) -- never a
 * third copy that could drift from either.
 *
 * NOT HYPOTHETICAL, and that is why this clause is in the row. #2050 needed an `## Open-check` written
 * and a duplicated `## Acceptance` heading demoted AT PROMOTION TIME: a promote act that skipped these
 * would have published an unclaimable Ready row, which is a worse state than the unpromoted one it came
 * from -- the gate offers it, a session claims it, and `row-claim` refuses after the round trip.
 *
 * `fileRefusalReason`'s own wording says "REFUSING to file". Kept verbatim rather than reworded, because
 * the alternative is a second set of strings saying the same thing, and the trailing line below says
 * plainly which body was asked and when.
 * @param {string | null} body @param {number} issueNumber
 * @returns {string | null}
 */
export function promoteRefusalReason(body: string | null, issueNumber: number,
  absentDeps: Parameters<typeof absentRegionTopDirReason>[1] = {}, specLint: SpecLintAtPromotion = {}): string | null {
  const fields = templateFieldsReason(body ?? "", issueNumber);
  if (fields) return `row-file: REFUSING to promote -- ${fields}`;
  const filing = fileRefusalReason(body);
  if (!filing) {
    // #877: the `--ready` filing refusal for a Region directory the repository lacks (#855), which a backlog row promoted here never met.
    const absent = absentRegionTopDirReason(body ?? "", { ...absentDeps, act: "promote" });
    if (absent !== null) return `row-file: ${absent}\n  Asked of #${issueNumber}'s EXISTING body at promotion time. Nothing was changed.`;
    return specLintPromotionReason(body ?? "", issueNumber, specLint); // agent-org#1017: last, so a row that fails the cheap rules above is not also linted
  }
  return `${filing}\n  Asked of #${issueNumber}'s EXISTING body at promotion time, in the filing rule's own `
    + "wording: a body that could not be FILED as it stands must not be made Ready either, because Ready "
    + "is where a claimant meets it. Nothing was changed.";
}

/**
 * #2111 REWORK (reviewer's blocker on `3de784b0`, 2026-09-23): THE LABEL WRITE IS ONE SET REPLACEMENT,
 * AND IT IS NOT `gh issue edit --add-label … --remove-label …`.
 *
 * The first version of this act packed the add and the remove into a single `gh issue edit` and claimed
 * that one INVOCATION made them one WRITE. **This repository already records that it does not.**
 * `row-claim.ts`'s #749 comment carries #677's own live reproduction (13:23:15Z): the SAME command's
 * `--remove-label` applied while every `--add-label` in it did not. `gh` resolves label names and applies
 * the halves separately, so a half that fails leaves the other standing -- an invocation count is not an
 * atomicity proof, and a read-back can REPORT the wrong state but never stop it being observed. The
 * reviewer read that comment against this file's claim and was right to refuse it.
 *
 * `PUT /repos/{repo}/issues/{n}/labels` -- GitHub's "Set labels for an issue" -- sets the whole list in
 * ONE request: no add half and no remove half to come apart, so either the row's labels are exactly this
 * list or the request failed and they are UNTOUCHED. Verified at the wire on 2026-09-23 with `GH_DEBUG=api`
 * against a nonexistent row (404, so nothing was written): `-f 'labels[]=<name>'` repeated builds
 * `{"labels":[…]}` and `gh` sends exactly one PUT.
 *
 * **The replacement semantics are not taken on trust.** If this endpoint turned out to be additive,
 * `backlog` would survive the write, and `unverifiedPromotionFields`' middle clause -- the one that asks
 * whether something LEFT -- refuses to report success. The first real run MEASURES the assumption instead
 * of resting on it, and `row-file.test.ts` drives an additive fake to pin that refusal.
 *
 * **What the set form costs, stated rather than hidden.** A full-set write carries every OTHER label the
 * row holds, so a label added by somebody else between the read and the write is ERASED rather than merely
 * outraced. That is why the set is computed from `freshLabelsForWrite`'s read -- one request older, not a
 * Project round trip older -- and why a claim found in that read is refused rather than written over.
 * GitHub offers no compare-and-set on labels (no `If-Match`), so the window narrows and never closes. A
 * delta write has no such window and is not atomic; between erasing a label on a row twice verified
 * unclaimed and silently double-counting a row for 25 minutes, this row's own measurement is what picks.
 *
 * @param {string[]} labels the row's labels as read immediately before the write
 * @returns {string[]} the whole list the row must carry after it: `ready` in, `backlog` out, all else kept
 */
export function labelSetForPromotion(labels: string[]): string[] {
  const kept = labels.filter((l) => !sameLabel(l, BACKLOG_LABEL) && !sameLabel(l, READY_LABEL));
  return [READY_LABEL, ...kept];
}

/**
 * #2111: whether the labels ALREADY say what a promotion would write, so nothing need be written at all.
 *
 * Asked because a set write that changes nothing is still a WRITE, and a write can still clobber: an
 * already-Ready row must cost no label request, and still have all three facts verified below. The
 * measured half-promoted state (both labels) is NOT settled and is repaired by the one write.
 * @param {string[]} labels
 */
export function promotionLabelsSettled(labels: string[]) {
  return labels.some((l) => sameLabel(l, READY_LABEL)) && !labels.some((l) => sameLabel(l, BACKLOG_LABEL));
}

/**
 * #2111: the one request, as `gh api` arguments. `-f` repeated per label, which is how `gh` builds a JSON
 * array -- and the reason this is a named function rather than an inline argument list is that the test
 * asserts the exact request, the only place the atomicity claim above is checkable from inside the suite.
 * @param {number} issueNumber @param {string[]} labels
 */
export function labelSetArgs(issueNumber: number, labels: string[]) {
  return ["api", "--method", "PUT", `repos/${REPO}/issues/${issueNumber}/labels`,
    ...labels.flatMap((label) => ["-f", `labels[]=${label}`])];
}

/** THE ONE WRITE of a row's whole label list in this file: one `PUT` that SETS it (see {@link labelSetArgs}). The promotion and the spec review's warning both go through it. */
function writeLabelSet(run: typeof defaultRun, issueNumber: number, labels: string[]): void {
  run("gh", labelSetArgs(issueNumber, labels));
}

/** `run` as the ticket port's adapter takes it (arguments only), so a caller hands it `run` and names no `gh` of its own. */
function ghRunner(run: typeof defaultRun): (args: string[]) => string {
  return (args) => run("gh", args);
}

/**
 * #2111: what a FRESH read fails to confirm about a promotion -- named, never a boolean, for the reason
 * `unverifiedFilingFields` gives: a reader repairing a half-promoted row needs to know WHICH of the three
 * did not stick.
 *
 * THE MIDDLE CLAUSE IS AN ABSENCE, and it is the one the rest of this row is about. The other two ask
 * whether something landed; this asks whether something LEFT, and it is the only one of the three that
 * was never checked by anything before today.
 * @param {{ labels: string[], boardStatus: string | null }} after
 * @returns {string[]} empty when the promotion is confirmed
 */
export function unverifiedPromotionFields(after: { labels: string[]; boardStatus: string | null; }): string[] {
  const missing = [];
  if (!after.labels.some((l) => sameLabel(l, READY_LABEL))) missing.push(`the \`${READY_LABEL}\` label`);
  if (after.labels.some((l) => sameLabel(l, BACKLOG_LABEL))) {
    missing.push(`the REMOVAL of \`${BACKLOG_LABEL}\` -- it is still on the row, which is exactly the `
      + "double-counted stock #2111 is about, reported here rather than passed over");
  }
  if (after.boardStatus !== READY_STATUS) {
    missing.push(after.boardStatus === null
      ? `Project ${PROJECT_NUMBER} membership`
      : `Project ${PROJECT_NUMBER} Status (reads "${after.boardStatus}", not "${READY_STATUS}")`);
  }
  return missing;
}

/**
 * #2111: everything that must be true BEFORE anything is written -- the row exists, is open, is not
 * already claimed, and its body is still claimable. Every refusal here leaves the row untouched.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, fetchLabels: typeof fetchIssueLabels }} deps
 * The labels it reads are NOT handed on: `writePromotionLabels` reads them again immediately before the
 * write, because a set write computed from a read this old could erase a label added since (#2111 rework).
 * @returns {{ refusal: string | null }}
 */
function promoteGate(issueNumber: number, deps: { run: typeof defaultRun; fetchLabels: typeof fetchIssueLabels; specLint?: SpecLintAtPromotion; }): { refusal: string | null; } {
  const state = openUnclaimedGate(issueNumber, deps);
  return state.refusal === null ? { refusal: claimableBodyRefusal(issueNumber, deps.run, deps.specLint) } : { refusal: state.refusal };
}

/**
 * #4456: the half of `promoteGate` that is about the ROW'S STATE (readable, open, not claimed), split out so `--board=` can apply it to an
 * `epic` without the claimability body check an epic can never pass. `labels` is what the read saw, for the caller that routes on it.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, fetchLabels: typeof fetchIssueLabels }} deps
 * @returns {{ refusal: string | null, labels: string[] }}
 */
function openUnclaimedGate(issueNumber: number, { run, fetchLabels }: { run: typeof defaultRun; fetchLabels: typeof fetchIssueLabels; }): { refusal: string | null; labels: string[]; } {
  let before: { labels: string[]; state?: string; };
  try {
    before = fetchLabels(issueNumber, { run });
  } catch (error) {
    return { labels: [], refusal: `row-file: REFUSING to promote -- #${issueNumber}'s labels could not be read, and a `
      + `promotion that cannot see what the row already carries cannot know what to write. `
      + `${(error as Error).message}` };
  }
  // `state` is OPTIONAL on `fetchLabels`' own contract (#752) -- absent reads as "not verified closed",
  // never as closed, so a caller's fixture that omits it behaves exactly as an open row does.
  if (before.state === "CLOSED") {
    return { labels: before.labels, refusal: `row-file: REFUSING to promote -- #${issueNumber} is CLOSED. Ready means a session `
      + "may pick it up now, and nothing may pick up a closed row. Reopen it first if it is still work." };
  }
  if (before.labels.includes(CLAIM_LABEL)) {
    return { labels: before.labels, refusal: `row-file: REFUSING to promote -- #${issueNumber} is already claimed (\`${CLAIM_LABEL}\`). `
      + `Promoting it would leave \`${READY_LABEL}\` beside \`${CLAIM_LABEL}\`, which \`ready-label-audit\` `
      + "reports as a HAND CLAIM: a claim made outside `row-claim.ts`. That reading is strong evidence "
      + `rather than proof -- the claim path removes \`${READY_LABEL}\` in a SECOND call (#749), so a claim whose `
      + "removal did not land leaves the same pair -- but a promote act that MINTED the state deliberately "
      + "would point the audit at the mechanism for something this command did. Decline the claim first "
      + "(`row-claim.ts decline "
      + `${issueNumber} --session=<whoever holds it>\`), which restores \`${READY_LABEL}\` by itself.` };
  }
  return { refusal: null, labels: before.labels };
}

/** #4456: the other half of `promoteGate` -- is the row's body one a session could claim? `null` is yes. */
function claimableBodyRefusal(issueNumber: number, run: typeof defaultRun, specLint: SpecLintAtPromotion = {}): string | null {
  let body: string;
  try {
    body = rowBodyOf(issueNumber, run);
  } catch (error) {
    return `row-file: REFUSING to promote -- #${issueNumber}'s body could not be read, so the `
      + `claimability check below could not be asked. ${(error as Error).message}`;
  }
  // agent-org#1017: a promotion records what the spec lint refused; a bare `promoteRefusalReason` call records nothing.
  return promoteRefusalReason(body, issueNumber, {}, { record: recordSpecLintRefusals, ...specLint });
}

/** A row's body, as `gh` prints it. THE ONE READ of it in this file's promotion path: the claimability check and Jev's reading of the spec both go through it. */
function rowBodyOf(issueNumber: number, run: typeof defaultRun): string {
  return run("gh", ["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body", "--jq", ".body"]);
}

/**
 * #2111: the read-back, and the only place a promotion is allowed to report success.
 *
 * `boardAndVerify`'s pattern, inherited for the reason it was built: a promotion that reports success
 * without confirming the board is the drift it exists to close.
 * @param {number} issueNumber @param {string | null} session
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels }} deps
 * @returns {{ ok: true, message: string } | { ok: false, code: number, message: string }}
 */
function verifyPromotion(issueNumber: number, session: string | null, { run, fetchBoardStatus, fetchLabels }: {
        run: typeof defaultRun; fetchBoardStatus: typeof fetchIssueBoardStatus;
        fetchLabels: typeof fetchIssueLabels;
    }): { ok: true; message: string; } | { ok: false; code: number; message: string; } {
  let after: { labels: string[]; boardStatus: string | null; };
  try {
    after = { labels: fetchLabels(issueNumber, { run }).labels,
      boardStatus: fetchBoardStatus(issueNumber, { run }) };
  } catch (error) {
    return { ok: false, code: 2, message: `row-file: #${issueNumber}'s promotion was WRITTEN but could not `
      + `be read back, so it is unconfirmed rather than done. ${(error as Error).message}` };
  }
  const missing = unverifiedPromotionFields(after);
  if (missing.length > 0) {
    return { ok: false, code: 2, message: `row-file: #${issueNumber} was written, but the read-back does not `
      + `confirm it -- missing: ${missing.join("; ")}. Refusing to report a promotion it could not confirm.` };
  }
  const by = session ? ` by ${session}` : "";
  return { ok: true, message: `PROMOTED #${issueNumber}${by} -- \`${READY_LABEL}\` on, \`${BACKLOG_LABEL}\` `
    + `off, Project ${PROJECT_NUMBER} Status "${READY_STATUS}"; all three confirmed by a fresh read.` };
}

/**
 * #2111: the labels READ AGAIN, immediately before the set write, and the claim question asked a SECOND
 * time.
 *
 * A set write carries every label the row holds, so it must be computed from the newest read there is --
 * never from `promoteGate`'s, which by then is a Project round trip (the Status move) older. The second
 * claim check is not defensive habit either: a claim landing in that window, written over by a set
 * computed from the older read, would ERASE `in-progress`, `session:*`, `branch:*` and `worktree:*` --
 * destroying a claim in order to add a label. The gate's own refusal says why promoting a claimed row is
 * wrong; this one exists because writing over one is worse than promoting it.
 *
 * Both refusals here carry code 2, not 1: the Status is already `Ready` by the time this is asked, so
 * something HAS been written and "nothing was changed" would be false.
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, fetchLabels: typeof fetchIssueLabels }} deps
 * @returns {{ refusal: string } | { refusal: null, labels: string[] }}
 */
function freshLabelsForWrite(issueNumber: number, { run, fetchLabels }: { run: typeof defaultRun; fetchLabels: typeof fetchIssueLabels; }): { refusal: string; } | { refusal: null; labels: string[]; } {
  let labels: string[];
  try {
    labels = fetchLabels(issueNumber, { run }).labels;
  } catch (error) {
    return { refusal: `row-file: #${issueNumber}'s Status is now "${READY_STATUS}" but its labels could not `
      + `be read, so the label write DID NOT RUN -- a set write computed from a stale read would carry `
      + `whatever the row held a moment ago and erase anything else. ${(error as Error).message}`
      + `\n  The labels are untouched. Run \`--promote=${issueNumber}\` again: it is idempotent.` };
  }
  if (labels.includes(CLAIM_LABEL)) {
    return { refusal: `row-file: #${issueNumber}'s Status is now "${READY_STATUS}" but the row was CLAIMED `
      + `between the gate's read and this write (\`${CLAIM_LABEL}\` is on it now). REFUSING the label `
      + `write: it sets the whole list, so it would erase the claim's own labels to add \`${READY_LABEL}\`. `
      + `Nothing was relabelled. A claimed row is In progress, not Ready -- move its Status back if that `
      + "is not what the board should say." };
  }
  return { refusal: null, labels };
}

/**
 * #2111: the label half -- read, decide, write ONCE. `null` when there is nothing left to report, which
 * is both "written" and "there was nothing to write".
 * @param {number} issueNumber
 * @param {{ run: typeof defaultRun, fetchLabels: typeof fetchIssueLabels,
 *   ensureLabels: typeof ensureLabelsOn }} deps
 * @returns {{ ok: false, code: number, message: string } | null}
 */
function writePromotionLabels(issueNumber: number, deps: {
        run: typeof defaultRun; fetchLabels: typeof fetchIssueLabels;
        ensureLabels: typeof ensureLabelsOn;
    }): { ok: false; code: number; message: string; } | null {
  const { run, ensureLabels } = deps;
  const fresh = freshLabelsForWrite(issueNumber, deps);
  if (fresh.refusal !== null) return { ok: false, code: 2, message: fresh.refusal };
  if (promotionLabelsSettled(fresh.labels)) return null;
  const wanted = labelSetForPromotion(fresh.labels);
  try {
    // #749's lesson, the same one `boardAndVerify` pays: a label the repository does not have is a
    // refusal, and `--force` makes the creation idempotent. Kept ahead of the set write because it is
    // unknown whether this endpoint mints a missing name, and that is not a question to answer live.
    ensureLabels([READY_LABEL], { run });
    writeLabelSet(run, issueNumber, wanted);
  } catch (error) {
    return { ok: false, code: 2, message: `row-file: #${issueNumber}'s Status is now "${READY_STATUS}" but `
      + `the label write FAILED -- ${(error as Error).message}\n  The labels are UNTOUCHED: one `
      + `PUT sets the whole list, so there is no half-applied add or remove to unpick -- the row still `
      + `reads \`${BACKLOG_LABEL}\` and is still counted as promotable stock, exactly as before this ran. `
      + `It is NOT in the both-labels state this row is about. What is now inconsistent is the board: `
      + `Status "${READY_STATUS}" beside a \`${BACKLOG_LABEL}\` label.\n  The repair is this act: run `
      + `\`pnpm run row-file --promote=${issueNumber} --session=<you>\` again. It is idempotent -- the `
      + "Status move is a no-op and the label write is the same one request." };
  }
  return null;
}

/**
 * #2111: the Status FIRST, then the one label write, then the read-back.
 *
 * THAT ORDER IS LOAD-BEARING, and for a different reason than filing's. `boardAndVerify` labels last so
 * no reader ever sees `ready` on a row with no Status (#867's floor). Here the row already HAS a Status,
 * so the argument is the other one: the label write sits behind the Status move, so a Status failure
 * writes nothing at all and leaves the row exactly as it was.
 *
 * The reviewer's should-fix on `3de784b0` is what the rest of this comment answers: ordering alone is not
 * a guarantee, and the second failure has to be survivable too. It is, in three named ways -- the label
 * write is ONE set replacement, so it cannot half-apply (`labelSetForPromotion`); its failure is reported
 * at exit 2 naming the exact state rather than being silent; and the REPAIR is this same act, which is
 * idempotent, so recovery is running it again rather than a hand-written rollback that would itself be a
 * second non-atomic write. `row-file.test.ts` drives that recovery: a failed write followed by a second
 * run that lands.
 * @param {number} issueNumber @param {string | null} session
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveTrackerStatus,
 *   ensureLabels: typeof ensureLabelsOn }} deps
 * @returns {{ ok: true, message: string } | { ok: false, code: number, message: string }}
 */
function writePromotion(issueNumber: number, session: string | null, deps: {
        run: typeof defaultRun; fetchBoardStatus: typeof fetchIssueBoardStatus;
        fetchLabels: typeof fetchIssueLabels; moveStatus: typeof moveTrackerStatus;
        ensureLabels: typeof ensureLabelsOn;
    }): { ok: true; message: string; } | { ok: false; code: number; message: string; } {
  const { run, moveStatus } = deps;
  const statusResult = moveStatus(issueNumber, READY_STATUS, { run });
  if (!statusResult.moved) {
    return { ok: false, code: 1, message: `row-file: REFUSING to promote -- #${issueNumber}'s Status could `
      + `not be moved to "${READY_STATUS}": ${statusResult.reason}\n  NOTHING was relabelled: the label `
      + "write sits behind the Status move and never ran, so the row is exactly as it was. Fix the board "
      + "and run this again -- there is no half-promotion to clean up first." };
  }
  const failed = writePromotionLabels(issueNumber, deps);
  if (failed) return failed;
  return verifyPromotion(issueNumber, session, deps);
}

/**
 * #2111: promote #`issueNumber` to Ready as ONE act -- add `ready`, remove `backlog`, move the Status,
 * and report nothing until a fresh read-back confirms all three.
 *
 * Every dependency is injectable for the same reason `createIssue`'s are: a test proves the order, the
 * single label edit, each refusal and the read-back without spawning a real `gh` or reaching GitHub.
 * Module-local, unlike `boardAndVerify`: `promoteRow` is the only caller and the only seam the tests
 * need, so exporting this as well would be a second front door onto one act.
 * @param {number} issueNumber @param {string | null} session
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveTrackerStatus,
 *   ensureLabels: typeof ensureLabelsOn }} deps
 * @returns {{ ok: true, message: string } | { ok: false, code: number, message: string }}
 */
function promoteAndVerify(issueNumber: number, session: string | null, deps: {
        run: typeof defaultRun; fetchBoardStatus: typeof fetchIssueBoardStatus;
        fetchLabels: typeof fetchIssueLabels; moveStatus: typeof moveTrackerStatus;
        ensureLabels: typeof ensureLabelsOn; specLint?: SpecLintAtPromotion;
    }): { ok: true; message: string; } | { ok: false; code: number; message: string; } {
  const gate = promoteGate(issueNumber, deps);
  if (gate.refusal !== null) return { ok: false, code: 1, message: gate.refusal };
  return writePromotion(issueNumber, session, deps);
}

/**
 * #2111: the CLI's promote path. Exit 1 means REFUSED and nothing was changed; exit 2 means something was
 * written and could not be confirmed -- `createIssue`'s own two codes, meaning the same two things.
 * @param {string[]} argv
 * @param {{ run?: typeof defaultRun, fetchBoardStatus?: typeof fetchIssueBoardStatus,
 *   fetchLabels?: typeof fetchIssueLabels, moveStatus?: typeof moveTrackerStatus,
 *   ensureLabels?: typeof ensureLabelsOn }} [deps]
 * @returns {number} the process exit code
 */
export function promoteRow(argv: string[], deps: {
    run?: typeof defaultRun; fetchBoardStatus?: typeof fetchIssueBoardStatus;
    fetchLabels?: typeof fetchIssueLabels; moveStatus?: typeof moveTrackerStatus;
    ensureLabels?: typeof ensureLabelsOn; specLint?: SpecLintAtPromotion;
} = {}): number {
  const merged = { run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus, fetchLabels: fetchIssueLabels,
    moveStatus: moveTrackerStatus, ensureLabels: ensureLabelsOn, ...deps };
  const stray = promoteArgvRefusal(argv);
  if (stray) {
    process.stderr.write(`${stray}\n`);
    return 1;
  }
  const issueNumber = promoteFromArgv(argv);
  if (issueNumber === null) {
    process.stderr.write(`row-file: \`${PROMOTE_FLAG}<n>\` needs a row number -- \`${PROMOTE_FLAG}2111\`. `
      + "Nothing was changed.\n");
    return 1;
  }
  const result = promoteAndVerify(issueNumber, sessionFromArgv(argv), merged);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return result.code;
  }
  process.stdout.write(`${result.message}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// agent-org#1017: JEV'S READING OF A SPEC THAT WAS PROMOTED. A WARNING, NEVER A BLOCK.
// Asked AFTER the promotion landed and its lint passed (`main` calls it on exit 0), so it cannot change what the promotion did. A score under
// `SPEC_REVIEW_THRESHOLD` puts `spec:review` on the row and wakes `product-manager` the way every ruling is asked for: a comment that asks, then
// `answer:product-manager`. No provider, the use switched off, a refusal or a fallback is no reading and adds nothing (`reviewSpec`).
// ---------------------------------------------------------------------------------------------------

export type SpecReviewDeps = {
  /** `rows.specLint`. Absent, this checkout's declaration says. */
  enabled?: boolean;
  run?: typeof defaultRun;
  fetchLabels?: typeof fetchIssueLabels;
  ensureLabels?: typeof ensureLabelsOn;
  /** Jev as `reviewSpec` asks it. Absent, `decide("spec-review", ...)`. */
  ask?: Parameters<typeof reviewSpec>[1];
  /** The decision seam's own deps (a test's fake network). Absent, this host's provider, switches and log. */
  decision?: DecisionDeps;
};

/** `decide`, bound as `reviewSpec`'s `ask`. A host with no declaration throws here, which `reviewSpec` reads as no reading. */
function providerAsk(issueNumber: number, given?: DecisionDeps): Parameters<typeof reviewSpec>[1] {
  return async (question, specText) => {
    let deps = given;
    if (deps === undefined) {
      const host = homeHostConfig();
      const projectDir = host.projects.find((project) => project.id === host.primary)?.checkout ?? process.cwd(); // `.agent-org/decisions.json` is the primary project's
      deps = { host, switchesPath: decisionSwitchesPath(projectDir), logPath: decisionLogPathFrom(stateEntryPath("wake-ledger")) };
    }
    const decision = await decide("spec-review", { spec: specText }, { spec: question }, { id: `${REPO}#${issueNumber}`, ...deps });
    const answer = decision.answers.spec;
    return answer === undefined ? null : { value: answer.value, fellBack: answer.fellBack };
  };
}

/**
 * The warning's two writes: the comment that ASKS (first, because `answerLabelRefusal` wants the newest comment to ask the session something), then ONE label
 * write carrying `spec:review` and `answer:product-manager`. A row that already carries `spec:review` was warned about once, and a second `--promote` of it
 * (the act is idempotent) does not comment or wake again. The comment goes through the ticket port, so this file gains no `gh` call.
 */
function raiseSpecReview(issueNumber: number, verdict: { reason: string; score: number; }, deps: Required<Pick<SpecReviewDeps, "run" | "fetchLabels" | "ensureLabels">>): boolean {
  const { run, fetchLabels, ensureLabels } = deps;
  const have = fetchLabels(issueNumber, { run }).labels;
  if (have.includes(SPEC_REVIEW_LABEL)) return false;
  const wakeLabel = `${ANSWER_PREFIX}${SPEC_REVIEW_WAKE}`;
  const text = `Jev read #${issueNumber}'s spec at promotion and scored it ${verdict.score} of 5. ${verdict.reason}\n\n`
    + `${SPEC_REVIEW_WAKE}: should the spec be tightened before a worker claims it? The row stays Ready; this is a warning, not a refusal (agent-org#1017).`;
  const refused = answerLabelRefusal({ state: "OPEN", lastComment: { body: text }, session: SPEC_REVIEW_WAKE });
  githubTicketAdapter({ run: ghRunner(run), scope: REPO })
    .postDecision({ tracker: TICKET_TRACKER, scope: REPO, id: issueNumber }, { role: "jev", runId: `spec-review-${issueNumber}`, kind: "spec-review", text });
  const wanted = [SPEC_REVIEW_LABEL, ...(refused === null ? [wakeLabel] : [])];
  ensureLabels(wanted);
  writeLabelSet(run, issueNumber, [...have, ...wanted.filter((label) => !have.includes(label))]);
  return true;
}

/**
 * Jev's reading of #`issueNumber`'s `spec` block, after its promotion. `null` is nothing asked: the flag off, or a row with no block. NEVER THROWS and never
 * changes the promotion: a write that fails is said on stderr and the row stays Ready.
 */
export async function reviewPromotedSpec(issueNumber: number, deps: SpecReviewDeps = {}): Promise<ReviewVerdict | null> {
  const { enabled = readSpecLintFlag(), run = defaultRun, fetchLabels = fetchIssueLabels, ensureLabels = ensureLabelsOn } = deps;
  if (!enabled) return null;
  try {
    const [specText] = specBlocksOf(rowBodyOf(issueNumber, run));
    if (specText === undefined) return null; // no block, nothing to read: a decomposition row
    const verdict = await reviewSpec(specText, deps.ask ?? providerAsk(issueNumber, deps.decision));
    if (verdict.warn) raiseSpecReview(issueNumber, verdict, { run, fetchLabels, ensureLabels });
    return verdict;
  } catch (error) {
    process.stderr.write(`row-file: #${issueNumber} is promoted, and Jev's reading of its spec could not be acted on (${String((error as Error)?.message ?? error).split("\n")[0]}); no warning was raised.\n`);
    return null;
  }
}

/**
 * THE PROMOTE ACT, THEN JEV'S READING OF WHAT IT PROMOTED: the one call `main` makes for `--promote=`. The exit code is `promoteRow`'s, whatever Jev says: the warning
 * is printed and never changes it, and a promotion that refused (non-zero) is not read at all. The reading shares the act's `run`, `fetchLabels`, `ensureLabels` and
 * `specLint.enabled` unless `review` overrides them, so a caller's fakes reach both.
 */
export async function promoteAndReviewRow(argv: string[], deps: Parameters<typeof promoteRow>[1] & { review?: SpecReviewDeps; } = {}): Promise<number> {
  const { review, ...promote } = deps;
  const code = promoteRow(argv, promote);
  const promoted = code === 0 ? promoteFromArgv(argv) : null;
  if (promoted === null) return code;
  const verdict = await reviewPromotedSpec(promoted, { enabled: promote.specLint?.enabled, run: promote.run, fetchLabels: promote.fetchLabels, ensureLabels: promote.ensureLabels, ...review });
  if (verdict?.warn) process.stderr.write(`row-file: warning -- #${promoted} is Ready and now carries \`${SPEC_REVIEW_LABEL}\`: ${verdict.reason}\n`);
  return code;
}

// ---------------------------------------------------------------------------------------------------
// #3330: BOARDING -- the THIRD act this file owns, for a row that EXISTS and is on no board.
//
// `a11ign/a11ign#3328`'s host timer sweeps open `regression` rows the outsider job filed under
// `github.token`, which cannot resolve Project 1: each exists with no Project item, no Status, no `ready`
// and no lane label. Filing boards (`boardAndVerify`) but is reachable only from `gh issue create`;
// `--promote` takes an existing number but only moves the Status, and `gh` answers "is not an item in
// project" for an issue never added. This is `boardAndVerify` reached from an existing number.
// ---------------------------------------------------------------------------------------------------

/** #3330: the flag that makes this invocation a BOARD of an existing row. */
export const BOARD_FLAG = "--board=";

/**
 * The row to board, or `null` when `--board=` is empty or not a positive integer. `main` routes on the
 * flag's PRESENCE, so `null` can only mean the value is unusable -- and must refuse, never file.
 * @param {string[]} argv
 * @returns {number | null}
 */
export function boardFromArgv(argv: string[]): number | null {
  const value = (flagValue(argv, "board") ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

/**
 * #3330: every argument but `--board=`, `--lane=` and `--session=` refused, for `promoteArgvRefusal`'s
 * reason: boarding files nothing, and a `--title` or `--label` silently ignored on the path you are on is
 * the defect `refuseUnknownFlags` exists to end.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function boardArgvRefusal(argv: string[]): string | null {
  const stray = argv.filter((a) => !["--board=", "--lane=", "--session="].some((f) => a.startsWith(f)));
  if (stray.length === 0) return null;
  return `row-file: REFUSING to board -- \`${BOARD_FLAG}<n>\` takes no argument but \`--lane=<owner>\` and `
    + `\`--session=<name>\`, and ${stray.length} other(s) were given: ${stray.join(", ")}. Boarding FILES `
    + "NOTHING: it adds an existing row to the Project as Ready with a lane label. Nothing was changed.";
}

/**
 * The `lane:<owner>` label `--lane=` names, or a refusal. Checked against the lanes file (`any` is always
 * a lane) because `ensureLabels` would otherwise MINT `lane:typo` and board the row under it.
 * @param {string[]} argv @param {typeof loadLanes} loadLanesConfig
 * @returns {{ label: string } | { refusal: string }}
 */
function boardLane(argv: string[], loadLanesConfig: typeof loadLanes): { label: string; } | { refusal: string; } {
  const owner = (flagValue(argv, "lane") ?? "").trim();
  if (owner === "") {
    return { refusal: "row-file: REFUSING to board -- `--lane=<owner>` is required: a Ready row with no lane "
      + "is the state this act exists to end. Use `--lane=any` for a row no lane owns. Nothing was changed." };
  }
  const lanes = loadLanesConfig();
  const known = lanes === null ? null : lanes.lanes.map((l) => l.owner);
  if (lanes === null || (owner !== "any" && !known?.includes(owner))) {
    return { refusal: lanes === null
      ? `row-file: could not read ${LANES_FILE_PATH} -- refusing to guess whether \`${owner}\` is a lane. `
        + "Nothing was changed."
      : `row-file: REFUSING to board -- \`${owner}\` is not a lane owner in ${LANES_FILE_PATH} `
        + `(${["any", ...(known ?? [])].join(", ")}). Nothing was changed.` };
  }
  return { label: `${LANE_PREFIX}${owner}` };
}

/**
 * #3330: board an existing OPEN row as Ready, or leave it alone. The board is read FIRST, so a row already
 * on it in ANY Status (Backlog, Ready, In progress) costs one request and no write -- the sweep calls this
 * for every open `regression` row on every fire. An unreadable board REFUSES: absent and unreadable are
 * different states, and boarding on a guess could move a row that was already in flight.
 * Then `promoteGate`'s claimability rules (an `epic` skips the body half, #4456, and boards Backlog), then `boardAndVerify` (additive labels, never the full-set PUT:
 * this row is not being promoted from `backlog` and keeps `regression`, `out-of-release` and the rest).
 * @param {string[]} argv
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveTrackerStatus,
 *   ensureLabels: typeof ensureLabelsOn, loadLanesConfig: typeof loadLanes }} deps
 * @returns {{ ok: true, message: string } | { ok: false, code: number, message: string }}
 */
export function boardExisting(argv: string[], deps: {
        run: typeof defaultRun; fetchBoardStatus: typeof fetchIssueBoardStatus;
        fetchLabels: typeof fetchIssueLabels; moveStatus: typeof moveTrackerStatus;
        ensureLabels: typeof ensureLabelsOn; loadLanesConfig: typeof loadLanes;
    }): { ok: true; message: string; } | { ok: false; code: number; message: string; } {
  const issueNumber = boardFromArgv(argv);
  if (issueNumber === null) {
    return { ok: false, code: 1, message: `row-file: \`${BOARD_FLAG}<n>\` needs a row number -- `
      + `\`${BOARD_FLAG}3329\`. Nothing was changed.` };
  }
  const lane = boardLane(argv, deps.loadLanesConfig);
  if ("refusal" in lane) return { ok: false, code: 1, message: lane.refusal };
  let status: string | null;
  try {
    status = deps.fetchBoardStatus(issueNumber, { run: deps.run });
  } catch (error) {
    return { ok: false, code: 1, message: `row-file: REFUSING to board #${issueNumber} -- whether it is already `
      + `on Project ${PROJECT_NUMBER} could not be read, and boarding a row that may be in flight on a guess `
      + `could move it. ${(error as Error).message} Nothing was changed.` };
  }
  if (status !== null) {
    return { ok: true, message: `#${issueNumber} is already boarded on Project ${PROJECT_NUMBER} `
      + `(Status "${status}"): left alone, nothing written.` };
  }
  const state = openUnclaimedGate(issueNumber, deps);
  const isEpic = state.labels.includes(EPIC_LABEL);
  const gate = state.refusal ?? (isEpic ? null : claimableBodyRefusal(issueNumber, deps.run));
  if (gate !== null) {
    return { ok: false, code: 1, message: `row-file: \`${BOARD_FLAG}${issueNumber}\` is refused by the same `
      + `claimability rules as \`${PROMOTE_FLAG}\`:\n${gate}` };
  }
  // An epic's state label is `epic`, already on it (#3942: `epic` REPLACES `backlog`); Backlog is its Status, not a label to add.
  const boarding = isEpic ? { label: EPIC_LABEL, status: BACKLOG_STATUS } : { label: READY_LABEL, status: READY_STATUS };
  const result = boardAndVerify({ issueNumber, url: `https://github.com/${REPO}/issues/${issueNumber}`,
    boarding, session: null, laneLabels: [lane.label],
    milestone: null, lead: `Row #${issueNumber} (filed by somebody else)` }, deps);
  if (!result.ok) return { ok: false, code: 2, message: `row-file: ${result.message}` };
  return { ok: true, message: `#${issueNumber} boarded: Project ${PROJECT_NUMBER} item, Status `
    + `"${boarding.status}", \`${boarding.label}\` + \`${lane.label}\` added beside its other labels.` };
}
