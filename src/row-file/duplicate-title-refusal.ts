import { flagValue } from "../lib/cli-flags.ts";
import { filedByLine } from "../row-claim.ts";
import { PROJECT_NUMBER } from "../board-snapshot.ts";
import { REPO } from "../project-identity.ts";
import { DEFECT_LABEL } from "../defect-class-line.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { boardItemOf, PROJECT_ITEMS_PAGE } from "../ticket-port/project-membership.ts";
import { adopterRowKind } from "../work-gate/org-health.ts";
import { inLane } from "../lane-ownership.ts";
import { READY_LABEL, STATE_LABELS } from "../claim-labels.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL as OUT_OF_RELEASE, OUT_OF_RELEASE_MILESTONE, LANE_PREFIX, LANE_ANY_LABEL, LANES_FILE_PATH } from "../project-vocabulary.ts";
import { ALLOW_SAME_TITLE_FLAG, KIND_FLAG, KIND_LABELS, READY_FLAG, ROADMAP_FIELD, defaultRun, openRowTitled, titleFromArgv, type Tracker } from "./body-from-argv.ts";

/**
 * #4294: THE REFUSAL AT THE DOOR for a title an open row in the SAME tracker already carries -- the second copy of a filing run launched twice.
 * `null` lets the filing go on: no title, the override given, or no open row has it. A read that failed refuses: it cannot say there is no twin.
 * @param {string[]} argv @param {Tracker} tracker @param {(cmd: string, args: string[]) => string} run
 * @returns {string | null}
 */
export function duplicateTitleRefusal(argv: string[], tracker: Tracker, run: (cmd: string, args: string[]) => string): string | null {
  const title = titleFromArgv(argv);
  if (title === null || argv.includes(ALLOW_SAME_TITLE_FLAG)) return null;
  const found = openRowTitled(title, tracker.repo, run);
  if (found === null) return null;
  if (found === "unreadable") {
    return `row-file: REFUSING to file -- the open rows of ${tracker.repo} could not be read, so whether one already has the title "${title.trim()}" is unknown. `
      + `Nothing was filed. Run it again; to file without the check, pass \`${ALLOW_SAME_TITLE_FLAG}\` (#4294).`;
  }
  return `row-file: REFUSING to file -- an open row #${found.number} already has this title ("${title.trim()}") in ${tracker.repo}. If this is a retry, `
    + `#${found.number} is the row you filed. To file a second row on purpose, change the title or pass \`${ALLOW_SAME_TITLE_FLAG}\`. Nothing was filed (#4294).`;
}

/**
 * Every `--kind` value given, in either spelling (`--kind X`, `--kind=X`); a `--kind` with nothing after it is the empty string.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function kindValuesFromArgv(argv: string[]): string[] {
  return argv.flatMap((arg, i) => arg === KIND_FLAG ? [argv[i + 1] ?? ""] : arg.startsWith(`${KIND_FLAG}=`) ? [arg.slice(KIND_FLAG.length + 1)] : []);
}

/**
 * The refusal for a `--kind` this tool does not know, or null. Before anything is filed.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function kindRefusal(argv: string[]): string | null {
  const unknown = kindValuesFromArgv(argv).filter((value) => !Object.hasOwn(KIND_LABELS, value));
  if (unknown.length === 0) return null;
  return `row-file: REFUSING to file -- \`--kind ${unknown.join(", ")}\` is not a kind this tool knows (${Object.keys(KIND_LABELS).join(", ")}). `
    + "Nothing was filed (#4123).";
}

/**
 * `argv` with `--kind` taken out (`gh issue create` would refuse it) and the label it means put in, once: a filer who also wrote
 * `--label defect` does not get it twice.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function withKindLabel(argv: string[]): string[] {
  const labels = kindValuesFromArgv(argv).map((value) => KIND_LABELS[(value as keyof typeof KIND_LABELS)]).filter(Boolean);
  if (labels.length === 0) return argv;
  const kept = argv.filter((arg, i) => arg !== KIND_FLAG && argv[i - 1] !== KIND_FLAG && !arg.startsWith(`${KIND_FLAG}=`));
  const given = labelValuesFromArgv(kept).map((label) => label.toLowerCase());
  return [...kept, ...labels.filter((label) => !given.includes(label)).flatMap((label) => ["--label", label])];
}
/** #4378: the declaration `primaryMilestoneRefusal` reads: the trackers (which one has milestones) and the `code` and `dora` lists `adopterRowKind` judges a Region by */
export type AdopterDeclaration = Parameters<typeof adopterRowKind>[1] & { tracker: Tracker[]; };

/**
 * #4078: THE PROJECT'S OWN TRACKER -- the first declared, which is also what `REPO`, `PROJECT_OWNER` and `PROJECT_NUMBER` name. Promotion
 * (`--promote=`) and `--board=` act on a row that ALREADY EXISTS, found by its number in this tracker, and take it; filing takes the one
 * `rowTracker` names.
 * @returns {Tracker}
 */
export const homeTracker = (): Tracker => homeProjectDeclaration().tracker[0];

/** @param {Tracker} a @param {Tracker} b @returns {boolean} */
export const sameTracker = (a: Tracker, b: Tracker): boolean => a.repo === b.repo && a.board.owner === b.board.owner && a.board.number === b.board.number;

/**
 * Is this the milestone that says "outside every release"? Case is folded for the same reason
 * `labelsOutOfRelease` folds it -- one fact, and a filer's capitalisation is not a second one.
 *
 * EXPORTED WITH `outOfReleaseMilestone` INJECTABLE (#2619, child 3d of #69): a11ign's own value is the
 * default, and a test states a fixture project's DIFFERENT milestone title to show this same comparison,
 * unchanged, would refuse (or not) by that project's own word rather than a11ign's.
 * @param {string | null} milestone @param {string} [outOfReleaseMilestone] @returns {boolean}
 */
export const saysOutOfRelease = (milestone: string | null, outOfReleaseMilestone: string = OUT_OF_RELEASE_MILESTONE): boolean =>
  milestone !== null && sameLabel(milestone, outOfReleaseMilestone);

/**
 * The argv to file with: unchanged, unless this row declares itself out of release by ONE of the two
 * facts that say so, in which case the other is added beside it. Either door, both fields.
 *
 * #1962: THE REVERSE DIRECTION, WHICH #1130 LEFT OPEN ON PURPOSE AND WHICH FILED ITS OWN FINDING.
 * #1130 added the milestone to the label path and stopped, reasoning that "adding labels a caller did not
 * ask for is a wider change" and that the tracker-level assertion would catch the other side. It did catch
 * it -- as RELEASE DRIFT, minted by this tool. Measured 2026-09-22: `row-file --milestone "Out of release"`
 * filed #1960 with no `out-of-release` label, and `ready-label-audit.ts` reads the LABEL, so that row was
 * about to be counted out of the board's own out-of-release figure by the next run. The mirror case (#1740)
 * came from the same audit. Both were repaired by hand, which is what a tool writing one of two fields
 * costs every time.
 *
 * So the label is no longer "a label the caller did not ask for": a caller who names this milestone HAS
 * asked to be outside every release, and the label is the other spelling of that same answer. A caller who
 * names a REAL milestone still gets no label -- only this one is two-faced.
 *
 * @param {string[]} argv @returns {string[]}
 */
export function outOfReleaseArgv(argv: string[]): string[] {
  const byLabel = labelsOutOfRelease(argv);
  const milestone = milestoneFromArgv(argv);
  if (byLabel && milestone === null) return [...argv, "--milestone", OUT_OF_RELEASE_MILESTONE];
  if (!byLabel && saysOutOfRelease(milestone)) return [...argv, "--label", OUT_OF_RELEASE];
  return argv;
}

/**
 * #1962: WHAT THE READ-BACK EXPECTS OF THE RELEASE PAIR -- taken from what was FILED, never from what was
 * TYPED. Read from the caller's own `argv`, the half this tool ADDS beside the filer's is the one field
 * nothing confirms: a `--label out-of-release` filing expects no milestone and so never checks the
 * milestone `outOfReleaseArgv` just asked for. That leaves the remedy for the drift unverified, which is
 * the drift wearing the remedy's clothes.
 * @param {string[]} filedArgv the argv that reached `gh issue create`
 * @returns {{ milestone: string | null, releaseLabel: string | null, kindLabel: string | null }}
 */
export function releaseExpectation(filedArgv: string[]): { milestone: string | null; releaseLabel: string | null; kindLabel: string | null; } {
  return { milestone: milestoneFromArgv(filedArgv),
    releaseLabel: labelsOutOfRelease(filedArgv) ? OUT_OF_RELEASE : null, kindLabel: kindLabelOf(filedArgv) };
}

/**
 * #4123: the `defect` label the filing carries, read from what was FILED (as `releaseExpectation` is), so the read-back asks for it.
 * @param {string[]} filedArgv
 * @returns {string | null}
 */
export function kindLabelOf(filedArgv: string[]): string | null {
  return labelValuesFromArgv(filedArgv).some((label) => sameLabel(label, DEFECT_LABEL)) ? DEFECT_LABEL : null;
}

/**
 * #1011: A ROW NEEDS A MILESTONE, OR `out-of-release` -- AND `row-file` WAS THE ONE TOOL NOT ASKING.
 *
 * `--milestone`/`-m` sits in the passthrough allowlist and nowhere else: this tool accepted one, never
 * asked for one, and never confirmed one. Meanwhile the org's health check reads a row carrying neither a
 * milestone nor `out-of-release` as a finding, every thirty minutes. **Two rules about the same row with
 * nothing comparing them**, which is this repository's most-recorded shape.
 *
 * Three rows landed milestone-less on 2026-09-11. One of them, #1003, also reached the tracker off Project
 * 2 entirely and blocked every Status move in the org until product-manager boarded it by hand.
 *
 * REFUSED BEFORE `gh issue create` RUNS, so a refusal leaves nothing behind: no row, nothing half-filed,
 * nothing for the board to trip over. The read-back below is the other half and is not redundant with it --
 * `gh` ACCEPTING a flag is not evidence the field is set, which is this repo's own recorded defect
 * (silently discarded, the default runs, success reported).
 * The milestone this filing asked for, or `null` -- what the read-back expects to find on the filed row.
 * @param {string[]} argv @returns {string | null}
 */
export function milestoneFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--milestone=")) return arg.slice("--milestone=".length) || null;
    const isMilestoneWithValue = (arg === "--milestone" || arg === "-m") && (argv[i + 1] ?? "").length > 0;
    if (isMilestoneWithValue) return argv[i + 1];
  }
  return null;
}

/**
 * #1393: DOES THIS FILING SAY `out-of-release` BY LABEL, in any spelling `gh issue create` takes -- `--label X`,
 * `--label=X`, `-l X`, `-l=X`, a comma list, any case (gh folds it). The ONE predicate `declaresRelease` and
 * `outOfReleaseArgv` both ask: each carried its own exact-spelling copy, so `--label out-of-release,docs` was
 * refused as declaring "no release", and fixing only the refusal would have filed the row with no milestone.
 *
 * `outOfReleaseLabel` INJECTABLE for the same reason `saysOutOfRelease`'s `outOfReleaseMilestone` is
 * (#2619, child 3d of #69): a11ign's own value by default, a fixture project's own label in a test.
 * @param {string[]} argv @param {string} [outOfReleaseLabel] @returns {boolean}
 */
export function labelsOutOfRelease(argv: string[], outOfReleaseLabel: string = OUT_OF_RELEASE): boolean {
  return labelValuesFromArgv(argv).some((label) => sameLabel(label, outOfReleaseLabel));
}

/** @param {string[]} argv @returns {boolean} */
export function declaresRelease(argv: string[]): boolean {
  if (labelsOutOfRelease(argv)) return true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `--milestone=X`, `--milestone X`, `-m X`: a flag with no value declares nothing, which is why the
    // VALUE is checked rather than the flag's presence. An empty `--milestone=` is the same as none.
    if (arg.startsWith("--milestone=") && arg.slice("--milestone=".length).length > 0) return true;
    const isMilestoneWithValue = (arg === "--milestone" || arg === "-m") && (argv[i + 1] ?? "").length > 0;
    if (isMilestoneWithValue) return true;
  }
  return false;
}


/**
 * The repository's own open milestones, FETCHED rather than listed here -- a literal list is a second copy
 * of something GitHub already holds, and the day it drifts the refusal names milestones that do not exist.
 * `null` when the list could not be read: the RULE still stands, only the SUGGESTION degrades.
 * @param {{ run?: typeof defaultRun, repo?: string }} [deps] `repo` is the tracker the row is filed in (#4078) @returns {string[] | null}
 */
export function openMilestones({ run = defaultRun, repo = REPO }: { run?: typeof defaultRun; repo?: string; } = {}): string[] | null {
  try {
    const raw = run("gh", ["api", `repos/${repo}/milestones`, "--jq", ".[].title"]);
    const titles = raw.split("\n").map((t) => t.trim()).filter(Boolean);
    return titles.length > 0 ? titles : null;
  } catch {
    return null; // CANNOT_ASK on the suggestion, never on the rule
  }
}

/**
 * The refusal, FOLLOWABLE: it names both doors and, where it can, the exact milestones to choose from.
 * Following it must pass -- `row-file.test.ts` files again using this message's own suggestion.
 *
 * IT NEVER GUESSES ONE. A milestone chosen by a tool looks decided, and a wrong one is worse than an
 * absent one because the health check goes quiet. Nothing in a row -- its labels, its parent, its Region --
 * determines a release; a person picks.
 * @param {string[] | null} milestones @param {string} [repo] the tracker whose milestones these are (#4078); the home repository by default
 * @returns {string}
 */
export function milestoneRefusal(milestones: string[] | null, repo: string = REPO): string {
  // THE UNREADABLE CASE GETS ITS OWN LINE, not the list's slot -- worker-capture's review of #1016. Reading
  // `--milestone <one of the milestone list could not be read, so pick from ...>` is garbage inside angle
  // brackets, and it is the one case where the reader cannot see the list either, so the message is doing
  // the most work exactly where it read worst.
  const either = milestones === null
    ? `  Either: --milestone <a milestone> -- the list could not be read from here; \`gh api repos/${repo}`
      + "/milestones --jq '.[].title'` prints it"
    : `  Either: --milestone <one of ${milestones.map((m) => `"${m}"`).join(", ")}>`;
  return "row-file: REFUSING to file a row that declares no release -- nothing was sent to GitHub.\n"
    + "  The org's health check reads a row with neither a milestone nor `" + OUT_OF_RELEASE + "` as a "
    + "finding within thirty minutes, so a row filed without one is incomplete the moment it lands.\n"
    + `${either}\n`
    + `  Or:     --label ${OUT_OF_RELEASE}, if this row is genuinely outside the release.`;
}

/**
 * #844: which label -- and which Project 2 Status option, by the SAME name -- this filing gets.
 * `backlog` unless `--ready` is explicitly given: a row filed with everything a claimant needs (Region,
 * Acceptance, Open-check already checked above) can go straight to the Ready lane; every other row
 * starts in Backlog, matching this repo's own convention that `ready` is a judgement about pickability
 * a filer states on purpose, never a default.
 * @param {string[]} argv
 * @returns {{ label: string, status: "Backlog" | "Ready" }}
 */
export function boardingFor(argv: string[]): { label: string; status: "Backlog" | "Ready"; } {
  // #1322: a filer who writes `--label=ready` means `--ready`. Read as anything else it came out `backlog`
  // AND `ready` (#1315), a row saying "take me" and "not yet" at once.
  const ready = argv.includes(READY_FLAG)
    || labelValuesFromArgv(argv).some((label) => sameLabel(label, READY_LABEL));
  return ready ? { label: READY_LABEL, status: "Ready" } : { label: BACKLOG_LABEL, status: "Backlog" };
}

/**
 * #1322 review (worker-capture): `gh` resolves a `--label` name CASE-INSENSITIVELY (`strings.EqualFold`,
 * api/queries_repo.go at v2.100.0), so `--label=Ready` IS the `ready` label. Every comparison here folds case,
 * or `Ready` boards Backlog and `Lane:Orchestrator` files unrefused.
 * @param {string} a @param {string} b
 */
export const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * #2111: the OTHER board label. IMPORTED FROM `project-vocabulary.ts` (#2619, child 3d of #69) rather
 * than declared locally: `READY_LABEL` still comes from `claim-labels.ts`, the pinned leaf that owns it
 * (`backlog` is not one of that file's four claim-lifecycle labels), and both now name the fact once.
 */

/** The Project Status option a promoted row must end on -- the same name as its label, by #844's rule. */
export const READY_STATUS = "Ready";

/** #4456: an `epic` is never claimable (no Region, Acceptance or Open-check), so `--board=` boards it at Backlog and never `ready`. */
export const EPIC_LABEL = "epic";
export const BACKLOG_STATUS = "Backlog";

/** The two board labels, which `boardAndVerify` applies after the Status move (#844) and nothing else may. */
export const BOARD_LABELS = Object.freeze([BACKLOG_LABEL, READY_LABEL]);

/** One comma list, split the way `gh` splits it. @param {string} value */
const splitLabels = (value: string) => value.split(",").map((label) => label.trim()).filter(Boolean);

/**
 * Where each `--label` sits in argv, in every spelling `gh issue create` takes: `--label X`, `--label=X`,
 * `-l X`, `-l=X`. `span` is how many argv entries the occurrence occupies.
 * @param {string[]} argv
 * @returns {{ start: number, span: 1 | 2, values: string[] }[]}
 */
function labelOccurrences(argv: string[]): { start: number; span: 1 | 2; values: string[]; }[] {
  const found: { start: number; span: 1 | 2; values: string[]; }[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const inline = /^(?:--label|-l)=(.*)$/s.exec(argv[i]);
    if (inline) {
      found.push({ start: i, span: 1, values: splitLabels(inline[1]) });
    } else if ((argv[i] === "--label" || argv[i] === "-l") && i + 1 < argv.length) {
      found.push({ start: i, span: 2, values: splitLabels(argv[i + 1]) });
      i += 1;
    }
  }
  return found;
}

/**
 * #1322: EVERY LABEL THE FILER GAVE, in any spelling. `row-file` composed its own labels beside these without
 * reading them, so every filer who said what they meant got both meanings.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function labelValuesFromArgv(argv: string[]): string[] {
  return labelOccurrences(argv).flatMap((occurrence) => occurrence.values);
}

/**
 * #1322: argv with `drop`'s labels taken out of every `--label`, in place. An occurrence left with no value is
 * removed whole, so `gh` is never handed an empty `--label`; one left untouched keeps its original spelling.
 * @param {string[]} argv @param {readonly string[]} drop
 * @returns {string[]}
 */
export function withoutLabels(argv: string[], drop: readonly string[]): string[] {
  const out = [];
  let next = 0;
  for (const { start, span, values } of labelOccurrences(argv)) {
    out.push(...argv.slice(next, start));
    const kept = values.filter((value) => !drop.some((dropped) => sameLabel(dropped, value)));
    if (kept.length === values.length) out.push(...argv.slice(start, start + span));
    else if (kept.length > 0) out.push("--label", kept.join(","));
    next = start + span;
  }
  out.push(...argv.slice(next));
  return out;
}

/**
 * #1322: REFUSED BEFORE ANYTHING IS FILED, when the filer's own labels contradict the ones `row-file` applies.
 *
 * - **A lane the Region does not derive.** The lane label is derived from the file the merge guard reads (#883),
 *   so a typed lane that differs is a row telling a lane it may take work the guard will refuse. Measured: #1313
 *   was filed `--label lane:orchestrator` and came out `lane:any, lane:orchestrator`; #1306 `--label=lane:any`
 *   came out `lane:any, lane:ceo`. Both names are printed, so the filer fixes the Region or drops the label.
 * - **`ready` and `backlog` together**, in any mix of `--ready` and `--label`. There is no reading of both.
 *
 * A typed lane EQUAL to a derived one is not refused; it is dropped from the create call, and the derived set
 * is applied once, after the Status.
 * @param {string[]} argv @param {readonly string[]} laneLabels the derived set
 * @returns {string | null}
 */
export function labelRefusal(argv: string[], laneLabels: readonly string[]): string | null {
  const given = labelValuesFromArgv(argv);
  const stray = given.filter((label) => sameLabel(label.slice(0, LANE_PREFIX.length), LANE_PREFIX)
    && !laneLabels.some((derived) => sameLabel(derived, label)));
  if (stray.length > 0) {
    return `row-file: REFUSING to file -- --label ${stray.join(", ")} is not the lane this row's Region derives `
      + `(${laneLabels.join(", ")}). The lane label is derived from ${LANES_FILE_PATH}, the file the merge `
      + "guard reads (#883), so a typed lane that differs would send the row to a lane that cannot merge it. Fix "
      + "the Region, or drop the --label. Nothing was filed.";
  }
  if (boardingFor(argv).label === READY_LABEL && given.some((label) => sameLabel(label, BACKLOG_LABEL))) {
    return `row-file: REFUSING to file -- this filing says both \`${READY_LABEL}\` and \`${BACKLOG_LABEL}\`. \`--ready\` (or `
      + `\`--label ${READY_LABEL}\`) boards it Ready; no board flag boards it Backlog. Give one. Nothing was filed.`;
  }
  return secondStateRefusal(argv, given);
}

/**
 * #3942: A FILING GETS EXACTLY ONE STATE LABEL, and `boardingFor` already gives it `backlog` or `ready`, so a `--label` naming ANOTHER of
 * `STATE_LABELS` (`parked`, `epic`, `blocked`, `in-progress`) is a second one: eight open rows carry `backlog` beside `parked` or `epic`
 * that way. A state that is not the board label is set by the act that means it (a claim, a hold, a parking) once the row exists.
 * @param {string[]} argv @param {string[]} given the filer's own labels
 * @returns {string | null}
 */
function secondStateRefusal(argv: string[], given: string[]): string | null {
  const boarding = boardingFor(argv).label;
  const second = given.filter((label) => STATE_LABELS.some((state) => sameLabel(state, label)) && !sameLabel(label, boarding));
  if (second.length === 0) return null;
  return `row-file: REFUSING to file -- --label ${second.join(", ")} would give this row a SECOND state label beside \`${boarding}\`, which the filing writes itself. `
    + `A row is in exactly one of ${STATE_LABELS.join(", ")}; \`parked\` and \`epic\` REPLACE \`${BACKLOG_LABEL}\`, and the state that means it is set once the row exists. Drop the --label. Nothing was filed.`;
}

/**
 * #941: a Region DIRECTORY (`.github/`) touches a lane whose paths lie inside it, or that it lies inside
 * (`.github/workflows/nested/`). Read as a file, `.github/` is in no lane's prefix, and a row declaring the
 * whole directory would have been labelled `lane:any` by omission. An `except` names a file, so it cannot
 * cover a directory.
 * @param {string} directory ends in `/` @param {string[]} paths the lane's own prefixes and files
 */
function directoryTouchesLane(directory: string, paths: string[]) {
  return paths.some((path) => path.startsWith(directory) || (path.endsWith("/") && directory.startsWith(path)));
}

/**
 * #883: which `lane:<owner>` label(s) this row's Region section touches -- derived from the SAME
 * `docs/lane-ownership.json` `workflow-lane-check.mjs`'s merge guard reads, via that file's own exported
 * `inLane` predicate, never a second, hand-typed opinion. That is the whole point rather than an
 * implementation choice: a hand-typed lane label can disagree with the guard that refuses the branch,
 * and then the row is worse than unlabelled -- it tells a lane it may take work the guard will reject
 * after the work is done. One source, and the label cannot disagree with the refusal.
 *
 * A REGION TOUCHING MULTIPLE LANES NAMES ALL OF THEM -- #883's own acceptance: "a Region touching two
 * lanes is a fact, not a coin toss... silently picking one is how a row ends up in a lane that cannot
 * merge it." A Region touching no lane's paths at all gets `lane:any`, a real answer (most tooling rows
 * are genuinely anybody's own), never a fallback standing in for "could not tell."
 *
 * `except` is subtracted the way the retired `laneVerdict` subtracted it: a path excepted from a lane (a
 * generated file whose source lives elsewhere) must not pull that lane's label onto a row just because
 * the file happens to sit under the lane's directory.
 * @param {string[]} regionFiles
 * @param {{ lanes: import("./lane-ownership.ts").Lane[] }} lanes
 * @returns {string[]}
 */
export function laneLabelsFor(regionFiles: string[], lanes: { lanes: import("../lane-ownership.ts").Lane[]; }): string[] {
  const owners = lanes.lanes
    // #3254: a review-only lane protects its owner's REVIEW (CODEOWNERS carries that), not the right to author, so it
    // derives no label. A Region that also touches another lane keeps that lane's label; one touching only this
    // lane is `lane:any`. A row that needs a decision only the owner can make is labelled `lane:<owner>` by hand.
    .filter((lane) => lane.reviewOnly !== true)
    .filter((lane) => regionFiles.some((f) => (f.endsWith("/") ? directoryTouchesLane(f, lane.paths)
      : inLane(f, lane.paths) && !inLane(f, lane.except ?? []))))
    .map((lane) => lane.owner);
  return owners.length > 0 ? owners.map((owner) => `${LANE_PREFIX}${owner}`) : [LANE_ANY_LABEL];
}

/**
 * The issue number from `gh issue create`'s own stdout -- a bare URL, nothing else, on success. `null`
 * for anything that does not end in `/issues/<digits>`, so a caller can tell "filed, but I could not
 * read back what number it got" from a genuine number, rather than guessing.
 * @param {string} output
 * @returns {number | null}
 */
export function issueNumberFromUrl(output: string): number | null {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match ? Number(match[1]) : null;
}

/**
 * #844/#883: does a FRESH read-back confirm every record this filing wrote -- the board label, the
 * `lane:<owner>` label(s), the Filed-by line, and the Project Status? Named, not just a boolean: a
 * reader fixing a half-boarded row needs to know WHICH did not stick, not merely that something did not.
 * @param {{ labels: string[], body: string | null, boardStatus: string | null,
 *           milestone?: string | null }} after
 * @param {{ session: string | null, label: string, status: string, laneLabels: string[],
 *           milestone?: string | null, releaseLabel?: string | null, kindLabel?: string | null, projectNumber?: number }} expected `projectNumber` is the
 *   board the filing was added to (#4078), the home board by default; `session: null` is a
 *   row someone else filed (`--board=`), whose Filed-by line this act did not write and does not assert
 * @returns {string[]} empty when everything is confirmed
 */
export function unverifiedFilingFields(after: {
        labels: string[]; body: string | null; boardStatus: string | null;
        milestone?: string | null;
    }, expected: {
        session: string | null; label: string; status: string; laneLabels: string[];
        milestone?: string | null; releaseLabel?: string | null; kindLabel?: string | null; projectNumber?: number;
    }): string[] {
  const missing = [];
  if (!after.labels.includes(expected.label)) missing.push(`the \`${expected.label}\` label`);
  // #1962: the out-of-release LABEL is read back for the same reason #1011 reads the milestone back --
  // `gh` accepting `--label` is not evidence the label is on the row, and this pair is exactly the pair
  // the tracker compares. Half of it landing silently is the drift, not a smaller version of it.
  if (expected.releaseLabel != null && !after.labels.some((l) => sameLabel(l, expected.releaseLabel ?? ""))) {
    missing.push(`the \`${expected.releaseLabel}\` label`);
  }
  if (expected.kindLabel != null && !after.labels.some((l) => sameLabel(l, expected.kindLabel ?? ""))) {
    missing.push(`the \`${expected.kindLabel}\` label`); // #4123: the mark that makes the closing pull request owe a `Class:` line
  }
  const missingLanes = expected.laneLabels.filter((l) => !after.labels.includes(l));
  if (missingLanes.length > 0) missing.push(`${missingLanes.map((l) => `\`${l}\``).join("/")} label(s)`);
  if (expected.session !== null && (after.body === null || filedByLine(after.body) !== expected.session)) {
    missing.push("the Filed-by line");
  }
  // #1011: `gh` ACCEPTING `--milestone` is not evidence the field is set -- a flag nobody reads is this
  // repo's own recorded defect. Only a fresh read of the filed row says whether it landed.
  if (expected.milestone !== null && after.milestone !== expected.milestone) {
    missing.push(after.milestone === null
      ? "the milestone"
      : `the milestone (reads "${after.milestone}", not "${expected.milestone}")`);
  }
  if (after.boardStatus !== expected.status) {
    const board = expected.projectNumber ?? PROJECT_NUMBER;
    missing.push(after.boardStatus === null
      ? `Project ${board} membership`
      : `Project ${board} Status (reads "${after.boardStatus}", not "${expected.status}")`);
  }
  return missing;
}

/**
 * #844: is issue `issueNumber` on Project `PROJECT_NUMBER`, and what Status does it carry? A single
 * targeted GraphQL read of the one issue this filing just created -- never `board-snapshot.ts`'s whole
 * `fetchBoardItems()` walk, which answers a different, much larger question (every item on the board) at
 * a cost this one-row check does not need to pay.
 *
 * #3330: PAGED. `null` means "not among ALL the issue's project items", because `--board=` writes on it: a
 * `first: 10` read returned `null` for an issue on Project 1 at position 11, and boarding on that
 * duplicated the item. Stops at the first page that holds Project 1.
 *
 * #4078: THE BOARD IS THE TRACKER'S, and a read of the OTHER tracker's board does not satisfy it. A board is its owner AND its number: two
 * trackers may each have a Project 1, so the number alone would read the wrong board's item as this one's. (The owner is compared when the
 * response carries one, which GitHub's always does.)
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun, tracker?: Tracker }} [deps]
 * @returns {string | null} the Status option name, or `null` if the issue is not on this tracker's Project at all
 */
export function fetchIssueBoardStatus(issueNumber: number, { run = defaultRun, tracker = homeTracker() }: { run?: typeof defaultRun; tracker?: Tracker; } = {}): string | null {
  return boardItemOf(issueNumber, (args) => run("gh", args), tracker)?.fieldValueByName?.name ?? null;
}

/**
 * #516: THE ROADMAP VALUE, which the chairman's direction (a11ign#928, 2026-10-09) makes `row-file`'s to enforce: every row filed under a roadmap
 * epic is linked to it AND given the epic's `Roadmap` value on the project it is boarded to, in any repository. `--parent=` was passed straight
 * to `gh issue create` and no project field was read or written, so the next row filed under an epic landed with no value.
 *
 * EVERY READ GOES THROUGH `run` (or the injected `roadmapItems` / `roadmapField`), so a test needs no token. A read that FAILS is a refusal, never
 * "the epic has no value": absence is not proof, and a filing that guessed would file the row without the value this exists to give it.
 */
export type RoadmapItem = { id: string; number: number; owner: string; value: string | null };
export type RoadmapField = { projectId: string; fieldId: string; options: { id: string; name: string }[] };

/** @param {string} parent a `--parent` value: `516`, `#516`, a GitHub issue URL or `owner/repo#516` @param {string} repo the tracker the row is filed in @returns {{ repo: string, number: number } | null} */
export function parentRef(parent: string, repo: string): { repo: string; number: number } | null {
  const value = parent.trim();
  const bare = /^#?(\d+)$/.exec(value);
  if (bare) return { repo, number: Number(bare[1]) };
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/.exec(value);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(value);
  return qualified ? { repo: qualified[1], number: Number(qualified[2]) } : null;
}

/** The `--parent` value in either spelling `gh` takes (`--parent=X`, `--parent X`), or `null`; the last one given wins, as `gh` takes it. @param {string[]} argv @returns {string | null} */
export function parentFromArgv(argv: string[]): string | null {
  let found: string | null = null;
  argv.forEach((arg, i) => {
    if (arg.startsWith("--parent=")) found = arg.slice("--parent=".length);
    else if (arg === "--parent") found = argv[i + 1] ?? "";
  });
  return found;
}

/** @param {string[]} argv @returns {string | null} the `--roadmap=` value, `null` when the flag is absent */
export function roadmapFromArgv(argv: string[]): string | null {
  return flagValue(argv, "roadmap") ?? null;
}

/**
 * Every project item of one issue with its `Roadmap` value, paged. THROWS on a failed call or an unexpected shape.
 * @param {{ repo: string, number: number }} issue @param {typeof defaultRun} run @returns {RoadmapItem[]}
 */
export function roadmapItemsOf(issue: { repo: string; number: number }, run: typeof defaultRun): RoadmapItem[] {
  const [owner, name] = issue.repo.split("/");
  const items: RoadmapItem[] = [];
  let cursor: string | null = null;
  do {
    const after = cursor === null ? "" : `, after: "${cursor}"`;
    const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${issue.number}) `
      + `{ projectItems(first: ${PROJECT_ITEMS_PAGE}${after}) { pageInfo { hasNextPage endCursor } `
      + `nodes { id project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "${ROADMAP_FIELD}") `
      + `{ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
    const page: any = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`]))?.data?.repository?.issue?.projectItems;
    if (!Array.isArray(page?.nodes)) throw new Error(`gh's Project-membership response for ${issue.repo}#${issue.number} did not have the expected shape (is the issue there?)`);
    for (const node of page.nodes) {
      items.push({ id: String(node?.id ?? ""), number: Number(node?.project?.number), owner: String(node?.project?.owner?.login ?? ""),
        value: typeof node?.fieldValueByName?.name === "string" ? node.fieldValueByName.name : null });
    }
    cursor = page.pageInfo?.hasNextPage === true ? (page.pageInfo.endCursor ?? null) : null;
  } while (cursor !== null);
  return items;
}

/**
 * The `Roadmap` field of a tracker's board, with the ids a write needs and the OPTIONS the project holds now (`ceo` adds options, so none is
 * copied into this file). `null` when the board has no such single-select field; THROWS when the board cannot be read.
 * @param {Tracker} tracker @param {typeof defaultRun} run @returns {RoadmapField | null}
 */
export function roadmapFieldOf(tracker: Tracker, run: typeof defaultRun): RoadmapField | null {
  const project = `projectV2(number: ${tracker.board.number}) { id field(name: "${ROADMAP_FIELD}") { ... on ProjectV2SingleSelectField { id options { id name } } } }`;
  const query = `query { repositoryOwner(login: "${tracker.board.owner}") { ... on Organization { ${project} } ... on User { ${project} } } }`;
  const board: any = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`]))?.data?.repositoryOwner?.projectV2;
  if (typeof board?.id !== "string") throw new Error(`could not read ${tracker.board.owner}/projects/${tracker.board.number}`);
  const { id, options } = board.field ?? {};
  if (typeof id !== "string" || !Array.isArray(options)) return null;
  return { projectId: board.id, fieldId: id, options: options.map((o: any) => ({ id: String(o.id), name: String(o.name) })) };
}

/** The epic's value: the one on the row's own board when it has one, else the first value on any project it is boarded to. @param {RoadmapItem[]} items @param {Tracker} tracker @returns {string | null} */
export function epicRoadmapValue(items: RoadmapItem[], tracker: Tracker): string | null {
  const own = items.find((item) => item.number === tracker.board.number && item.owner.toLowerCase() === tracker.board.owner.toLowerCase());
  return own?.value ?? items.find((item) => item.value !== null)?.value ?? null;
}

export type RoadmapPlan = { refusal: string } | { set: { field: RoadmapField; option: { id: string; name: string } } | null; warning: string | null };
