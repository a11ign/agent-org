#!/usr/bin/env node
// @ts-check
// command: refuse to file a backlog row via `gh issue create` when its body is missing a required
// section, or board/label it wrong -- see #844's own addition below for the second half
// #735: THE SAME GATE #707 PUT ON THE CLAIM SIDE, CALLED FROM THE FILING SIDE INSTEAD.
//
// #844: THE TEMPLATE CHECK ALONE STILL LET A FILED ROW LAND OFF THE BOARD. Measured by `product-manager`:
// five rows filed through this tool in one night were not on Project 2, and one carried no labels at all
// -- `gh issue create` needs neither, and this file checked only the body. So filing now also boards the
// new issue on Project 2 and moves its Status to match a label (`backlog` unless `--ready` is given, in
// which case `ready` -- never both), and REFUSES to report success until a fresh read-back confirms the
// label, the `Filed-by:` line and the Status all actually landed -- a row this cannot board is refused,
// not reported filed halfway.
//
// THE LABEL LANDS LAST, NOT AT `gh issue create` TIME, AND THAT ORDER IS LOAD-BEARING. Found by
// dogfooding this exact fix (#867, filed live with `--ready` while building it): a `ready` label present
// before the item has a Status makes the row itself the exact shape #747's own board-safety floor exists
// to catch (an OPEN `ready` issue with no Status), so `moveProjectStatus`'s own pre-write snapshot
// refused every `--ready` filing on itself, always. See `boardAndVerify`'s own header for the full
// account and why labelling last is safe.
//
// #883, dispatcher's ruling: A ROW ALSO GETS A `lane:<owner>` LABEL, DERIVED FROM ITS OWN `## Region`,
// SO READY IS READABLE BY LANE. Before this, a session watching Ready for its own lane could not tell an
// unlabelled row apart from one nobody had assigned -- `worker-config` held idle twice in one evening
// rather than self-select from an unlabelled column (the row's own filing cites both). The part that is
// the ruling rather than an implementation choice: the derivation reads `docs/lane-ownership.json`
// through `loadLanes`/`inLane`, THE SAME FUNCTIONS `lane-ownership.ts` owns (the merge guard that also read them was retired) --
// never a second, hand-typed spelling of the same rule that could drift from the guard that actually
// refuses the branch. A Region touching two lanes gets BOTH labels, never one picked silently (see
// `laneLabelsFor`); a Region touching none gets `lane:any`, a real answer, not a fallback. A missing or
// malformed lane file is CANNOT_ASK -- refused before `gh issue create` even runs, identically to the
// retired merge guard's own `laneVerdict` refusing rather than reading silence as "no path has a lane". The
// lane label(s) travel through the same "label lands last" step as the board label above, for the
// identical reason: the pre-write board snapshot must never see `ready` on a row with no Status, lane
// label or not. Backfilling pre-existing rows is deliberately out of scope here (dispatcher's own
// instruction) -- this only reaches rows filed from here on.
//
// #771: NOTHING RECORDS WHO FILED A ROW, SO A BACKFILL LIST CANNOT BE ADDRESSED. GitHub's `author` is the
// one fleet account for every row, and a `session:` label means CLAIMED, not filed (the 2026-09-09
// ruling) -- so for 25 of 27 rows measured missing a required section, nothing named who filed it, and an
// instruction to "send each filer its incomplete rows" could not be carried out. The two that COULD be
// attributed were attributed by accident: two from a session's own memory of filing them, one because
// `orchestrator` happened to write "Filed by `orchestrator`" in prose. That last one is the whole
// argument -- the information is useful, somebody wrote it by hand once, and nothing asked for it.
//
// So this writes `Filed-by: <session>` into the body -- a body LINE, never a label. A label means
// CLAIMED (the same ruling), and a `filed-by:*` label would put two different meanings in one namespace,
// exactly the collision #683 records: `session:` was asked to be both a claim about the present and a
// record of the past, and removing it on close (#754) destroyed the second. A body line has the property
// the label lacked: it is a record, so nothing later ever needs to remove it.
//
// `--session=<name>`, REQUIRED, the identical flag `row-claim.ts` already uses for the same fact --
// never a separately-named flag (`--filed-by=`) a caller could set to anything unrelated to who is
// actually running this. One place a session states its identity, not two that could disagree.
//
// `.github/ISSUE_TEMPLATE/backlog-row.yml` marks Region, Acceptance and Open-check `required` -- but that
// is a GitHub issue FORM, and forms apply only in the web UI. Every row this fleet files goes through
// `gh issue create --body`, which bypasses the form entirely, and nobody discovered a row was incomplete
// until someone tried to claim it (#707). Measured 2026-09-09 (worker-capture, #735):
//
//   open rows examined: 76
//   missing at least one required section: 36
//     missing Region: 25 | Acceptance: 5 | Open-check: 28
//
//   #0-399    8 of 36 (22%)
//   #400-599  9 of 11 (82%)
//   #600-699  10 of 18 (56%)
//   #700+     9 of 11 (82%)   <- of the eleven newest, exactly two carried all three
//
// The rate rises with recency because the more the org files its own work with `gh issue create`, the
// more of the backlog becomes un-claimable -- the web form's enforcement never runs against that path.
//
// ceo's ruling: refuse at FILING, not only at claiming, so the cost lands on whoever holds the context,
// not on whoever picks the row up later. In worker-capture's own words, filing #677 without this:
//
//   "I wrote #677's Open-check myself and I am not confident it is the one `orchestrator` would have
//   written."
//
// NOT A SECOND IMPLEMENTATION. `missingTemplateFields` is #707's own pure function, imported from
// `row-claim/template-fields-rule.mjs` unchanged -- the identical rule row-claim already enforces at
// claim time, asked here one step earlier. A body that would pass this refuses nothing later, and a body
// that would fail `row-claim claim` cannot be filed in the first place.
//
// `cli-flags.test.ts`'s discovery guard requires EVERY argv-reading file here to call
// `refuseUnknownFlags`, on a small, CLOSED, shrink-only exemption list this file does not qualify for --
// so `KNOWN_GH_ISSUE_CREATE_FLAGS` below is `gh issue create --help`'s own flag surface (read 2026-09-09,
// gh's current stable release), not a subset this wrapper invented. A flag it does not yet know is
// refused with the near miss named, same as any other guarded CLI here -- the cost of a genuinely new
// `gh` flag arriving is a refusal naming it, not a silent pass-through. Every argument that IS known still
// passes through to `gh` unexamined -- this file checks nothing about VALUES, only that the flag NAME is
// one `gh issue create` actually reads, which is `refuseUnknownFlags`'s whole job everywhere else in this
// tree, applied to a wrapped external tool instead of to this file's own flags.
import { execFileSync } from "node:child_process";
import {
  acceptancePathsReason, classifyCommand, extractAcceptanceSection, fleetOrLabAcceptance, jobCapabilities,
  unmetClosureRequirements, untrimmedFleetMention, declarationDisagreement, handRunAcceptanceReason, labFetchPathReason,
} from "./acceptance-commands.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { leakRefusalReason } from "./lib/leak-patterns.mjs";
import { missingTemplateFields, templateFieldsReason, wholeSuiteAcceptanceReason }
  from "./row-claim/template-fields-rule.mjs";
import { waitingLanguageWarning } from "./row-claim/waiting-language-rule.mjs";
import { moveProjectStatus, filedByLine, fetchLabels as fetchIssueLabels, ensureLabelsExist } from "./row-claim.ts";
import { PROJECT_OWNER, PROJECT_NUMBER } from "./board-snapshot.ts";
import { launchGate } from "./board-snapshot-scope.ts";
import { REPO } from "./project-identity.ts";
import { DEFECT_LABEL } from "./defect-class-line.ts"; // #4123
import { declaredRegionFiles, declaresNoCommit, directoryReservations, extractLabeledSection, slashlessDirectoryEntries, splitRegionEntry, unrecognisedRegionPaths } from "./region-paths.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { rowTracker, trackerNamed } from "./row-tracker.ts"; // #4078
import { adopterFacingDeclared, adopterRowKind } from "./work-gate/org-health.mjs"; // #4378
import { PRIMARY_MILESTONE_LINE } from "./org-health.ts"; // #4378
import { parseWaits, umbrellaEdge } from "./wait-condition.ts";
import { chairmanAskRefusal } from "./work-gate/chairman-ask-orders.mjs"; // #4020
import { loadLanes, inLane } from "./lane-ownership.ts";
// #2111: both labels from the leaf module that OWNS them (#804), never the strings retyped -- a promotion
// must refuse a row that is already claimed, and it writes `ready` four times. `ready-label-audit.test.ts`
// enforces exactly this: a fresh local declaration of any of the four, anywhere in this directory, is a
// finding -- and that guard reads RAW source, so this note must not spell one out either. It caught this
// very comment first.
import { CLAIM_LABEL, READY_LABEL, STATE_LABELS } from "./claim-labels.ts";
// #2619 (child 3d of #69): the rest of this file's vocabulary -- `backlog`, the release label and
// milestone, the `lane:` prefix and the lanes-file path, and the template's own field/question names.
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL as OUT_OF_RELEASE, OUT_OF_RELEASE_MILESTONE, LANE_PREFIX,
  LANE_ANY_LABEL, LANES_FILE_PATH, ACCEPTANCE_FIELD, FLEET_QUESTION, ANSWER_PREFIX } from "./project-vocabulary.ts";

const defaultRun: (cmd: string, args: string[]) => string = (cmd, args): string => execFileSync(cmd, args, { encoding: "utf8" });

/** `gh issue create --help`'s complete flag surface, long and short forms, plus its two inherited flags. */
const KNOWN_GH_ISSUE_CREATE_FLAGS = [
  "--assignee=", "-a",
  "--attach=",
  "--blocked-by=",
  "--blocking=",
  "--body=", "-b",
  "--body-file=", "-F",
  "--editor", "-e",
  "--label=", "-l",
  "--milestone=", "-m",
  "--parent=",
  "--project=", "-p",
  "--recover=",
  "--template=", "-T",
  "--title=", "-t",
  "--type=",
  "--web", "-w",
  "--help",
  "--repo=", "-R",
];

/**
 * The body text THIS invocation would file, read from its own argv exactly the way `gh issue create`
 * itself would: `--body <text>`, `--body=<text>`, `--body-file <path>`, or `--body-file=<path>`. `null`
 * when none of the four forms is present -- this tool has nothing to check, and says so rather than
 * guessing or letting `gh` file an unchecked body.
 *
 * A `--body-file` value of `-` (gh's own convention for "read stdin") is read as `null` rather than as a
 * literal filename: this wrapper runs synchronously and has no stdin capture of its own, and misreading
 * `-` as a path would throw `ENOENT` on a caller doing exactly what `gh`'s own docs describe.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function bodyFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--body") return argv[i + 1] ?? null;
    if (arg.startsWith("--body=")) return arg.slice("--body=".length);
    if (arg === "--body-file") {
      const path = argv[i + 1];
      if (!path || path === "-") return null;
      return readFileSync(path, "utf8");
    }
    if (arg.startsWith("--body-file=")) {
      const path = arg.slice("--body-file=".length);
      if (path === "-") return null;
      return readFileSync(path, "utf8");
    }
  }
  return null;
}

/**
 * #1186: HOW MANY FILES EACH DIRECTORY IN THE REGION RESERVES.
 *
 * A `/`-terminated entry claims every file beneath it -- B4 uses `regionCovers`, which has a directory
 * branch, per #941 and on purpose. So the author who writes `packages/` has reserved the package tree
 * against everyone until their row closes, and nothing told them the size of it.
 *
 * **The COUNT is the message.** Saying "this is a directory" tells them what they typed; saying it
 * reserves 1031 files tells them what they did. A warning rather than a refusal for #1158's reason: a
 * directory Region is sometimes exactly right, and blocking a correct filing to prevent a possible
 * mistake is the wrong trade for a failure whose mode is silence.
 *
 * @param {string} body @returns {string | null}
 */
export function directoryRegionWarning(body: string): string | null {
  const dirs = directoryReservations(body);
  if (dirs.length === 0) return null;
  const named = dirs.map(({ entry, files }) => `${entry} (${files} file(s))`).join(", ");
  return `WARNING -- the \`## Region\` section declares ${dirs.length} DIRECTORY entr(ies): ${named}. `
    + "Each reserves EVERY file beneath it against every other row until this one closes -- a one-line "
    + "Region that reserves a thousand files looks exactly like one that reserves one. If that is what "
    + "you mean, nothing to do; otherwise name the files, or say the exclusion in words.";
}

/**
 * #1193: A DIRECTORY DECLARED WITHOUT ITS SLASH -- the one spelling with no witness at all.
 *
 * `packages/lab/src/training` is DECLARED, reserves NOTHING, and was not reported stray either, because
 * something did take it. Both other warnings were satisfied and the author had reserved nothing.
 *
 * **It is where the old stray message SENT people.** Until #1193 that warning reported the slash-less
 * form of every declared directory -- *"declares NOTHING: packages/lab/src/training"* against a Region
 * that said `packages/lab/src/training/` -- and the obvious way to satisfy it is to delete the slash.
 * The message was followable, and following it moved the author from contradicted-but-visible to silent.
 *
 * The remedy is the one this file already uses twice: say what was declared, say what it reserves, and
 * leave the decision alone. A refusal would block the row whose author meant the file and mistyped it.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function slashlessDirectoryWarning(body: string): string | null {
  const entries = slashlessDirectoryEntries(body);
  if (entries.length === 0) return null;
  return `WARNING -- the \`## Region\` section declares ${entries.length} entr(ies) that name a `
    + `DIRECTORY with no trailing slash: ${entries.join(", ")}. Each reserves NOTHING -- `
    + "`regionCovers` keys on the slash, so a directory without one declares only itself and no file "
    + "beneath it. Add the slash to reserve the tree, or name the files you mean.";
}

/**
 * #1158: WHAT THE REGION LOOKS LIKE IT DECLARES AND DOES NOT — printed, never swallowed.
 *
 * A `.claude/` path declared inline reserved nothing while the same path fenced reserved normally, and
 * **nothing said so**: `row-file` accepted the row, the author read their own path back out of the body,
 * and B4 protected a file nobody had claimed. Deriving the prefix list fixes every directory that EXISTS;
 * this covers the rest — a typo, a path from another repo, a file moved since the row was drafted.
 *
 * **A PATH THIS CANNOT PLACE IS EITHER A TYPO OR A DIRECTORY THAT DOES NOT EXIST YET, and the two want
 * opposite responses.** The derivation reads `git ls-files`, so it sees only what is already TRACKED: a
 * greenfield row creating a new top-level directory reads exactly like a misspelling. That case is the
 * one where the author most wants B4 to reserve something and where nothing is reserved, so the message
 * has to name it -- a warning that reads as "you made a typo" is dismissed by the author who did not.
 *
 * A WARNING rather than a refusal, deliberately. A Region may legitimately mention a path in prose that
 * is not a declaration, and a refusal there would block a correct filing to prevent a possible mistake.
 * The failure this row is about is SILENCE; a line on stderr ends it without taking the decision away.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function unrecognisedRegionWarning(body: string): string | null {
  const stray = unrecognisedRegionPaths(body);
  if (stray.length === 0) return null;
  return `WARNING -- the \`## Region\` section names ${stray.length} path-shaped item(s) that declare `
    + `NOTHING: ${stray.join(", ")}. B4 will not reserve them and the lane labels will not see them. If `
    + `one is a declaration, check its spelling -- or, if it names a directory this row will CREATE, note `
    + `that nothing reserves it until it is tracked. If it is prose, this line is the only cost.`;
}

/**
 * #1117: A REGION THAT NAMES NO PATH MUST SAY IT MEANS TO.
 *
 * THE ROW'S PREMISE WAS THAT SUCH A ROW CANNOT BE FILED. Measured: it can. `missingTemplateFields`
 * requires the SECTION, not paths, so a Region reading only prose already passes here and
 * `declaredRegionFiles` already returns `[]` — it reserves nothing and B4 sees nothing. The workaround on
 * #1042 (a Region naming files it will never touch) was never necessary.
 *
 * SO THE GAP IS THE OTHER WAY ROUND, and it is worse: **a row whose author simply forgot the paths is
 * indistinguishable from one that has none.** Both reserve nothing, both file cleanly, and the first is a
 * row nobody can route work around — the same over-blocking harm the row describes, arrived at from the
 * side nobody was looking at.
 *
 * This makes the category EXPLICIT. A Region with no paths is accepted when it says so, in #989's own
 * words — that test reads `declaresPaths: false` as "not in build" for *"a settings change, a ruling, a
 * measurement posted on the row"* — and refused otherwise. **The clock and the filer now describe the
 * same category with the same sentence** instead of one inferring it from absence.
 *
 * NOT A SECOND REGION PARSER, and that has to hold for the SECTION as well as the paths:
 * `declaredRegionFiles` and `extractRegionSection` are both the functions B4 and the lane labels read, so
 * "names no path" and "inside the Region section" mean here exactly what they mean there.
 *
 * @param {string} body
 * @returns {string | null}
 */

export function regionRefusalReason(body: string): string | null {
  if ((declaredRegionFiles(body) ?? []).length > 0) return null;
  // SCOPED TO THE REGION SECTION, never to the whole body. The phrase appears in prose on rows that DO
  // change files -- this row's own body says it twice -- and a declaration that can be made accidentally
  // somewhere else is the easy path past the check this refusal exists to close.
  //
  // THROUGH THE SHARED `declaresNoCommit`, NOT A REGEX (#2177 moved the sentence to `region-paths.ts`, so
  // `row-reachability` reads the same one). My first version wrote its own, and worker-judge found it
  // disagrees with the shared extractor BOTH WAYS: the inline form (`Region: ...`) was invisible to mine,
  // so a row using it could not make the declaration at all; and a `###` sub-heading ENDS the section
  // everywhere else (#170's recorded shape) while mine ran past it, so a declaration under `### Why`
  // would have been accepted here and ignored by B4.
  if (declaresNoCommit(body)) return null;
  return "REFUSING to file -- the `## Region` section names no file, and nothing says that is deliberate. "
    + "A Region naming no path reserves nothing under B4, so a row that simply FORGOT its paths is "
    + "indistinguishable from one that has none, and nobody can route around it. Either name the files "
    + "this row will change, or write `its deliverable is not a commit` in the Region section -- which is "
    + "the sentence #989's in-build rule already uses for a settings change, a ruling, or a measurement "
    + "posted on the row.";
}

/** The sentence a row uses to say which repository its paths are relative to (``The repository is **`a11ign/agent-org`**``). */
const STATED_REPOSITORY = /\brepository is\s+\*{0,2}`([\w.-]+\/[\w.-]+)`/i;

/**
 * #3083: THE REPOSITORY A ROW SAYS ITS PATHS ARE RELATIVE TO, or `undefined` when it says none. Exported so `pr-open` reads the
 * sentence the filing check reads, and not a second copy of its shape that could disagree.
 * @param {string} body @returns {string | undefined}
 */
export const statedRepository = (body: string): string | undefined => STATED_REPOSITORY.exec(body)?.[1];

/**
 * #3056: A REGION IN A KEYED REPOSITORY MUST SPELL ITS KEY, or `pr-open` refuses every path of the PR that finishes the row.
 *
 * `splitRegionEntry` reads a bare path as the project's FIRST repository's tree (ADR 0040, decision 2), so a row that says
 * "the repository is `a11ign/agent-org`" and then lists `src/x.mjs` declares a path of the OTHER repository, and the PR in
 * agent-org read all 13 of its changed paths as outside the Region (a11ign/agent-org#35) -- passed only by one
 * `Outside-Region:` line per file, a declaration saying the opposite of what the check is for. Said here, where the
 * filer still holds the row, rather than at the PR, where it costs a line per file.
 *
 * ONLY A STATED REPOSITORY IS READ: a body that names none is the project's own, whose bare paths are right, and the
 * sentence is matched on a DECLARED code repository with a non-empty key, so a prose mention of some other repository
 * never refuses. The Region is read through `declaredRegionFiles` and `splitRegionEntry`, the one parser and the one
 * place the prefix is read, so "bare" means here what it means to `pr-open`.
 * @param {string} body
 * @param {{ code?: readonly { key: string, repo: string }[] }} [declared] the project's code repositories; absent, the declaration's
 * @returns {string | null}
 */
export function bareKeyedRegionReason(body: string, { code = homeProjectDeclaration().code }: { code?: readonly { key: string; repo: string; }[]; } = {}): string | null {
  const stated = statedRepository(body);
  const keyed = code.find((entry) => entry.key !== "" && entry.repo === stated);
  if (keyed === undefined) return null;
  const bare = (declaredRegionFiles(body) ?? []).filter((entry) => splitRegionEntry(entry).key === "");
  if (bare.length === 0) return null;
  const example = `${keyed.key}:${bare[0]}`;
  return `REFUSING to file -- the body says its repository is ${keyed.repo}, but ${bare.length} \`## Region\` entr(ies) are spelled bare: `
    + `${bare.join(", ")}. A bare path is the project's FIRST repository's tree, so \`pr-open --repo ${keyed.repo}\` would read every `
    + `changed path of the PR as outside the Region. Prefix each with the repository's key: \`${example}\` (#3056).`;
}

/**
 * A sentence in an Open-check that ASSERTS what the command prints. `Prints \`0\` today`, `returns 3`,
 * `reads 7`, `-> 0`. Deliberately about CLAIMS rather than about output: clause 4 of #1174 -- some rows'
 * checks are a command whose meaning the reader judges, and mandating output would refuse those.
 */
const ASSERTS_AN_OUTPUT = /\b(?:prints?|returns?|reads?|outputs?|gives?|yields?)\b[^.\n]{0,40}?[`'"]?-?\d/i;

/** A line that looks like something being RUN rather than something it printed. */
const LOOKS_LIKE_A_COMMAND = /^\s*(?:\$\s+)?(?:pnpm|npx|npm|node|git|gh|grep|rg|sed|awk|cat|ls|find|python3?|bash|sh)\b/;

/**
 * #1316: A `$ ` PROMPT MARKS A COMMAND, WHATEVER ITS FIRST WORD. The allowlist above decided alone until this row, so a
 * real pasted run beginning `$ echo …`, `$ touch …` or `$ printf …` had no "command" line and was refused with the
 * very instruction it followed. Measured 2026-09-13: worker-judge's #1314 transcript, pasted from the run, was
 * refused, and the same run re-typed as `bash -c '…'` was accepted -- the same command with a different first word.
 * A prompt is the paste's own evidence that the line was typed; the allowlist still recognises an unprompted
 * command, as before.
 */
const PROMPTED_COMMAND = /^\s*\$\s+\S/;

/** @param {string | undefined} line @returns {boolean} */
function isCommandLine(line: string | undefined): boolean {
  return line !== undefined && (PROMPTED_COMMAND.test(line) || LOOKS_LIKE_A_COMMAND.test(line));
}

/**
 * Is there a transcript in `section` whose OUTPUT sits directly under its COMMAND?
 *
 * #1174 clause 2, and the clause that carries the row: **adjacency is the property.** A check asking only
 * whether a command and a number both appear in the block would bless exactly the bodies this rule exists
 * to catch -- a command at the top and an unrelated figure pasted at the bottom, which is what a
 * reconstructed transcript looks like. My own #1161 was that shape: `Run at <sha>` above a block printing
 * a number the command cannot produce.
 *
 * @param {string} section @returns {boolean}
 */
function hasAdjacentTranscript(section: string): boolean {
  for (const fence of section.match(/```[\s\S]*?```/g) ?? []) {
    const lines = fence.split("\n").slice(1, -1).filter((l) => l.trim() !== "");
    for (let i = 0; i < lines.length - 1; i += 1) {
      // A command with a NON-command line straight after it, inside one fence. Two commands in a row are
      // two commands; a command as the last line of a fence printed nothing here.
      if (isCommandLine(lines[i]) && lines[i + 1] !== undefined && !isCommandLine(lines[i + 1])) return true;
    }
  }
  return false;
}

/**
 * #1174: AN OPEN-CHECK THAT ASSERTS AN OUTPUT MUST SHOW ONE, ADJACENT TO THE COMMAND.
 *
 * Eleven instances between two engineers in one day, of which three were open-checks written from belief:
 * `Prints \`0\` today -- I ran it` against a command that prints 7, with the file refuting the row among
 * the seven; and my own, `Run at <sha>` above a block that returns 0 and exits 1, in a row whose subject
 * was a command nobody executed.
 *
 * **A pasted transcript is only a transcript if it was pasted from a run** -- and that clause is what the
 * refusal has to be built on, because without it any plausible-looking block satisfies the rule, which is
 * the entire family. Adjacency is the closest machine-checkable proxy: a figure that came from the run
 * sits under the command, and one reconstructed from belief usually does not.
 *
 * WHAT THIS CANNOT DO, stated rather than implied: it cannot tell a real transcript from a fabricated
 * adjacent one. Someone who invents both lines passes. The defect it removes is the one that actually
 * happened eleven times -- an assertion with no transcript at all, or with one pasted somewhere else.
 *
 * @param {string} body @returns {string | null}
 */
export function openCheckTranscriptRefusal(body: string): string | null {
  const section = extractLabeledSection(body, "Open-check");
  if (section === null) return null;
  const prose = section.replace(/```[\s\S]*?```/g, " ");
  if (!ASSERTS_AN_OUTPUT.test(prose)) return null;
  if (hasAdjacentTranscript(section)) return null;
  return "REFUSING to file -- the `## Open-check` section ASSERTS what the command prints, and no "
    + "transcript in it shows a command with its output directly underneath. Paste the run: the command "
    + "on one line and what it printed on the next, in one fenced block. A transcript is only a "
    + "transcript if it was pasted FROM A RUN -- a claim reconstructed from what you expect the command "
    + "to say is the defect this refuses, and it has cost this repo eleven rows in one day.";
}

/**
 * #1488: THE ACCEPTANCE MUST READ AS ONE SECTION, TO THE PARSER CI'S ACCEPTANCE JOB USES.
 *
 * `missingTemplateFields` asks whether a `## Acceptance` heading exists; it never asks what the heading
 * holds. product-manager's fixed floor checker found 22 open rows carrying `## Acceptance` followed by an
 * `Acceptance: none — …` line, which `extractAcceptanceSection` reads as TWO headers -- `duplicate`, the
 * outcome #540 made fail the job -- and `row-file` had filed every one. Reproduced at `bb8a5168` on #1466's
 * real body: `duplicate`, and `fileRefusalReason` returned `null`.
 *
 * THE PARSER IS CALLED, NEVER COPIED: which lines count as a header is `acceptance-commands.ts`'s rule,
 * already fixed five times for forms authors keep writing, and a second copy here would drift from the one
 * CI runs. So this refuses exactly what that parser cannot read -- `duplicate` and `missing` -- and names
 * the one-header forms that pass, so following the refusal files.
 *
 * @param {string} body @returns {string | null}
 */
export function acceptanceShapeRefusal(body: string): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind === "duplicate") {
    const where = section.occurrences.map((o) => `line ${o.line}: \`${o.text}\``).join("; ");
    return `REFUSING to file -- the Acceptance section has ${section.occurrences.length} headers, which CI's `
      + `acceptance parser reads as DUPLICATE and fails on: ${where}. Keep exactly one: \`## Acceptance: none — `
      + "<reason>` on the heading line itself, or a `## Acceptance` heading followed by a fenced command block.";
  }
  if (section.kind === "missing") {
    return "REFUSING to file -- the Acceptance section is present, but CI's acceptance parser finds nothing in it "
      + "(MISSING): no command under the heading, or `none` with no reason. Put a command under `## Acceptance` "
      + "in a fenced block, or write `## Acceptance: none — <reason>` with the reason stated.";
  }
  return null;
}

/**
 * Is there a file at this path in the checkout the filer is standing in? Deliberately `statSync`:
 * `acceptance-check-at-filing.test.ts` reads this file's RAW source and refuses the usual boolean fs probe by
 * name (so this comment cannot spell it either), to stop a second copy of the ACCEPTANCE-token path check
 * (#1943) growing here. This asks about the REGION's source files, a different population the shared check
 * never sees, and that guard cannot tell the two apart by text.
 * @param {string} path @returns {boolean}
 */
function isReadable(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** A source file the closure walk can read; a `.md` or `.json` Region entry has no import closure. */
const WALKABLE_SOURCE = /\.(?:mjs|cjs|js|ts|tsx)$/;

/**
 * The one requirement a Region walk cannot judge: a TEST declares `// no-token: <fn>` (#827) in ITS OWN header,
 * and the test is what does not exist yet, so a `token` charge on an entry script is the walk being unable to
 * see the escape. Measured 2026-09-24 over 70 open and 80 closed rows: with it the closure warning spoke on
 * 79 of 150 (53%), 69 of them charged to `token` by entry scripts that spawn `gh` -- every filing of
 * `work-gate.ts` or `wake.ts` -- which is the warning that fires on every filing. `corpus` and `history`
 * have no such per-test exit that a Region walk misses, so they stay.
 */
const TEST_DECLARABLE = "token";

/** A command that RUNS tests: `tsx --test`, an rstest run, or one that names a test file. */
const TEST_COMMAND = /\btsx\s+--test\b|\brstest\b|\.(?:test|spec)\.[cm]?[jt]sx?\b/;

/**
 * #2035: A REGION FILE THE ACCEPTANCE JOB WILL CHARGE FOR A CAPABILITY IT LACKS -- said at filing, while the
 * Region can still change.
 *
 * `pr-open` refuses a test command whose import closure needs `corpus`; on #2018 that surfaced a round late,
 * after the row was built. The closure walk (`unmetClosureRequirements`, the very call `pr-open` makes) can
 * answer it now -- but NOT from the Acceptance command, because at filing time that names a test that has not
 * been written, and the walk on a path that does not exist returns `[]`, which reads as "needs nothing". So
 * this walks the files the Region NAMES, which exist, and lets the filer see what the entry script reaches.
 *
 * **AN ABSENT FILE IS REPORTED AS UNREAD, NEVER AS CLEAN.** The same `[]` would otherwise pass a Region full
 * of files this checkout does not have -- a new module, a moved path -- and the warning would go quiet in
 * exactly the case it was written for. The message says the walk did not happen, so silence keeps one
 * meaning.
 *
 * A WARNING, not a refusal: a `fleet-gated` row legitimately declares an Acceptance meant for the lab, and a
 * refusal would block it outright. Scoped to a TEST Acceptance, because that is the only kind `pr-open`'s
 * closure walk charges.
 *
 * @param {string} body
 * @param {{ exists?: (path: string) => boolean,
 *   walk?: typeof unmetClosureRequirements }} [deps]
 * @returns {string | null}
 */
export function regionClosureWarning(body: string, { exists = isReadable, walk = unmetClosureRequirements }: {
    exists?: (path: string) => boolean;
    walk?: typeof unmetClosureRequirements;
} = {}): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands" || !section.commands.some((c) => TEST_COMMAND.test(c))) return null;
  const files = (declaredRegionFiles(body) ?? []).filter((file) => WALKABLE_SOURCE.test(file));
  const capabilities = jobCapabilities(body);
  const unread = files.filter((file) => !exists(file));
  const charges = files.filter((file) => exists(file)).flatMap((file) => walk(file, capabilities)
    .filter((hit) => hit.requirement !== TEST_DECLARABLE)
    .map((hit) => `${file}: needs \`${hit.requirement}\`, which this job does not have -- ${hit.message}`));
  if (charges.length === 0 && unread.length === 0) return null;
  const chargeText = charges.length === 0 ? "" : `WARNING -- the \`## Region\` names source file(s) whose `
    + `import closure needs a capability the acceptance job lacks, and this row's Acceptance `
    + `runs tests: ${charges.join("; ")}. \`pr-open\` will refuse a test command that reaches it. Keep what the `
    + "test imports out of that closure (a `corpus` reader goes in its own module), declare `History: full` "
    + "for a `history` charge, or route the row to `orchestrator` if it is fleet-gated by design.";
  const unreadText = unread.length === 0 ? "" : `WARNING -- ${unread.length} Region source file(s) do not `
    + `exist in this checkout, so their import closure was NOT read and this is not a clean reading: `
    + `${unread.join(", ")}. If one is a new entry script the tests will import, check by hand what it `
    + "reaches (`unmetClosureRequirements`, `acceptance-commands.ts`) before the row is built.";
  return [chargeText, unreadText].filter((text) => text !== "").join(" ");
}

/**
 * #2035: HOW THE ROWS ACTUALLY QUOTE A TEST COUNT, derived from the population and not imagined -- the
 * `## Acceptance` sections of 70 open and 80 recently closed rows, read 2026-09-24T21:49Z. Each spelling
 * cites a row it was read from, and `row-file.test.ts` pins every one against that row's verbatim line.
 * A count needs a RESULT word beside it (`0 failed`, `pass`, a commit) so "adds 3 tests" is not a reading.
 */
const QUOTED_COUNT_SPELLINGS = [
  // `132 tests, 0 failed, measured at ...` (#2147), `2 files, 187 tests, \`status: pass\`` (#2177),
  // `the 24 tests in ...` (#2154, as measured), `the file's 76 tests, 0 failed, at \`c06bc5cc3\`` (#2245).
  /\b\d+\s+(?:tests?|specs?)\b[^\n]{0,60}?(?:\b0\s+fail|\bpass|\bgreen\b|\bmeasured\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b)/i,
  // `9 passed / 0 failed` (#2134), `-> 140/0 at 4c68f44a2` and `142/0` (#2003, #2005).
  /\b\d+\s+pass(?:ed)?\s*\/\s*\d+\s+fail/i,
  /\b\d+\s*\/\s*0\b(?!\.\d)/,
  // rstest's own JSON: `tests: 46` (#2206). Not `tests: 0`: a zero-match run is a condition, and zero cannot rot.
  /\btests:\s*[1-9]\d*\b/,
];

/** The sentence a body carries when it tells the builder its numbers are readings. */
const REMEASURE_INSTRUCTION = /\bre-?measure\b|\breading at a (?:named )?commit\b/i;

/**
 * #2035: A COUNT QUOTED IN AN ACCEPTANCE IS A READING AT A NAMED COMMIT, NEVER A REQUIREMENT.
 *
 * #2003 and #2005 both declared `140/0`; the builder read 142 at their own branch point and spent a paragraph
 * reconciling it. Naming the ref is necessary and not sufficient -- the builder necessarily reads at another
 * commit -- so the body must also say they re-measure and that what has to RISE is their own pre-change
 * reading. Same defect shape as `regionClosureWarning`: an Acceptance that reads fine at filing and misleads
 * whoever runs it later.
 *
 * A WARNING: a count is sometimes honest context. One that fires on every filing is noise, so a body that
 * carries the sentence is silent, and only a count beside a RESULT word is read (`QUOTED_COUNT_SPELLINGS`).
 *
 * @param {string} body
 * @returns {string | null}
 */
export function quotedTestCountWarning(body: string): string | null {
  const section = extractLabeledSection(body, ACCEPTANCE_FIELD);
  if (section === null || REMEASURE_INSTRUCTION.test(body)) return null;
  const quoted = QUOTED_COUNT_SPELLINGS.map((spelling) => spelling.exec(section)).find((hit) => hit !== null);
  if (!quoted) return null;
  return `WARNING -- the \`## Acceptance\` section quotes a test count (\`${quoted[0].trim()}\`) and the body `
    + "nowhere tells the builder to re-measure it. A count is a reading at a named commit, and the builder "
    + "reads at a different one, so a mismatch reads as 'my branch is wrong' when it is 'the file grew'. "
    + "Add: **THE NUMBER IS A READING AT A NAMED COMMIT, NOT A REQUIREMENT -- RE-MEASURE AT YOUR OWN BRANCH "
    + "POINT BEFORE YOU CHANGE ANYTHING; what must rise is YOUR pre-change reading.**";
}

/**
 * The lines of the Acceptance section a paragraph sits on directly under a CLOSING fence, no blank line
 * between -- the cause `commandLinesAfter` turns into a "command". Odd fence ordinal = the closing one.
 * @param {string} section @param {string} line @returns {boolean}
 */
function gluedToClosingFence(section: string, line: string): boolean {
  const lines = section.split(/\r\n|\r|\n/);
  const at = lines.findIndex((candidate) => candidate.trim() === line);
  if (at < 1 || !lines[at - 1].trim().startsWith("```")) return false;
  const fencesBefore = lines.slice(0, at - 1).filter((l) => l.trim().startsWith("```")).length;
  return fencesBefore % 2 === 1;
}

/** Enough of a prose line for the filer to find it; a whole paragraph would bury the sentence around it. */
const QUOTED_LINE_LIMIT = 80;

/**
 * A command whose first real token is a PATH (`.venv/bin/pytest`, `./scripts/x.sh`). `classifyCommand` calls
 * one `prose` when the file is not executable in THIS checkout, and a venv or a script a CI job creates is
 * absent from the filer's -- measured on #2304 and #2234, whose correct `pytest` lines both read as prose.
 * @param {string} command @returns {boolean}
 */
function namesAPath(command: string): boolean {
  const first = command.trim().split(/\s+/).find((token) => !/^[A-Za-z_]\w*=/.test(token));
  return first !== undefined && first.includes("/");
}

/**
 * #2035: AN ACCEPTANCE LINE THAT IS PROSE, WHICH THE PARSER NEVERTHELESS READS AS A COMMAND.
 *
 * Measured over the 63 open rows on 2026-09-23: #1889 declared its whole Acceptance as one bold paragraph,
 * and #2094 and #1865 glued a paragraph to the closing fence, so `extractAcceptanceSection` returned prose
 * (and, on #1865, an inline code span) as the row's commands. The row then declares an acceptance nobody
 * can run. `classifyCommand` already decides what is a command -- called here, never a regex -- so this
 * asks the decider CI asks, at the moment the filer can add one blank line.
 *
 * A WARNING: a `prose` verdict depends on which executables exist on the filer's PATH, so refusing on it
 * would make filing depend on the machine.
 *
 * @param {string} body
 * @param {{ classify?: typeof classifyCommand }} [deps]
 * @returns {string | null}
 */
export function malformedAcceptanceCommandWarning(body: string, { classify = classifyCommand }: { classify?: typeof classifyCommand; } = {}): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return null;
  const capabilities = jobCapabilities(body);
  const prose = section.commands.filter((command) => !namesAPath(command)
    && classify(command, { capabilities }).verdict === "prose");
  if (prose.length === 0) return null;
  const raw = extractLabeledSection(body, ACCEPTANCE_FIELD) ?? "";
  const glued = prose.filter((line) => gluedToClosingFence(raw, line));
  const quoted = prose.map((line) => `\`${line.slice(0, QUOTED_LINE_LIMIT)}\``).join(", ");
  const remedy = glued.length > 0
    ? `${glued.length} of them sit directly under the closing fence with no blank line, so the parser absorbed `
      + "them into the block: add ONE blank line after the closing ```."
    : "Put the command in a fenced block directly under `## Acceptance`, and any prose after a blank line.";
  return `WARNING -- the \`## Acceptance\` section yields ${prose.length} line(s) CI's acceptance parser reads `
    + `as a command that is not one: ${quoted}. ${remedy}`;
}

/**
 * Every warning a filing carries, in the order they print. Warnings, never refusals -- the author sees them
 * while they still have the body in front of them, which is the only moment each is cheap to act on. Pulled
 * out of `createIssue` so a seventh is one line here and not another branch there.
 * @param {string} body
 * @param {string[]} argv
 * @returns {string[]}
 */
export function filingWarnings(body: string, argv: string[]): string[] {
  return [unrecognisedRegionWarning(body), directoryRegionWarning(body), slashlessDirectoryWarning(body),
    waitingLanguageWarning(body, argv), regionClosureWarning(body), quotedTestCountWarning(body),
    malformedAcceptanceCommandWarning(body)].filter((warning) => warning !== null && warning !== undefined);
}

/**
 * #4229: A `Waiting-for:` THE GATE CANNOT READ IS REFUSED WHERE IT IS WRITTEN. `parseWaits` keeps a line outside its grammar as `unreadable` and
 * no gate acts on one: #4090 was parked on "ceo's dispatched run ... ends", the condition was true 45 minutes later and the row sat about ten hours.
 * The reader is `wait-condition.ts`'s own, so this cannot drift from what the gate reads, and a line inside a fence is not read (the reader skips it).
 * `manual` is a readable wait (signal 9 counts it). `null` means proceed.
 * @param {string} body
 * @returns {string | null}
 */
export function unreadableWaitReason(body: string): string | null {
  const unreadable = parseWaits(body).filter((wait) => wait.state === "unreadable");
  if (unreadable.length === 0) return null;
  const quoted = unreadable.map((wait) => `\`Waiting-for: ${wait.text}\``).join(", ");
  return `row-file: REFUSING to file -- ${quoted} is outside the grammar the gate reads, so nothing would ever lift this wait: the row would stand on a sentence for ever `
    + "(#4090 was parked ten hours on one after its condition was true). Write the condition as one of `closed #n`, `merged #n`, `labelled|unlabelled <label> #n`, "
    + "`published <pkg>@<dist-tag>`, `<pkg> latest = next`, `tagged <tag>`, or `manual` (a wait no field can express, counted). "
    + `A wait on a SESSION's act is not a \`Waiting-for:\` line: put the \`${ANSWER_PREFIX}<session>\` label on the row, and removing it IS the answer. Nothing was filed.`;
}

/**
 * THE VERDICT, PURE -- `null` means proceed. Reuses #707's `missingTemplateFields` outright rather than
 * re-deriving it; see this file's header for why that matters here specifically.
 * @param {string | null} body
 * @returns {string | null}
 */

export function fileRefusalReason(body: string | null): string | null {
  if (body === null) {
    return "row-file: no --body or --body-file (or --body-file -) found in these arguments -- this tool "
      + "cannot check a body it cannot read, so it refuses rather than filing one unchecked. Pass one of "
      + "them so the three required sections (Region, Acceptance, Open-check) can be checked before this "
      + "reaches GitHub.";
  }
  // #891: checked BEFORE the template-shape check -- a leak is refused on its own facts regardless of
  // whether the rest of the body is well-formed, and never restated: `leakRefusalReason` is the same
  // `allLeaksIn` predicate the tree-wide guards already drive.
  const leak = leakRefusalReason(body);
  if (leak) return `row-file: ${leak}`;
  const missing = missingTemplateFields(body);
  if (missing.length > 0) {
    return `row-file: REFUSING to file -- missing ${missing.join(", ")}. The issue template requires all `
      + "three (Region, Acceptance, Open-check) but the web form that enforces that does not apply to "
      + "`gh issue create`. Add the missing section(s) as a `## <Field>` heading with real content under "
      + "it, then file again -- whoever claims this row later has less context than you have right now.";
  }
  const unreadableWait = unreadableWaitReason(body);
  if (unreadableWait) return unreadableWait;
  const region = regionRefusalReason(body);
  if (region) return `row-file: ${region}`;
  const bareKeyed = bareKeyedRegionReason(body);
  if (bareKeyed) return `row-file: ${bareKeyed}`;
  const openCheck = openCheckTranscriptRefusal(body);
  if (openCheck) return `row-file: ${openCheck}`;
  // PRESENCE FIRST, THEN CONTENT. A row with no Acceptance section is refused above for that reason; a
  // row whose Acceptance names the whole suite has the section and cannot be run from it, and the two
  // refusals must not be collapsed -- the fix for each is different, which is the same argument
  // `missingTemplateFields` makes for naming each missing field rather than counting them.
  // #1488: and the section must PARSE as one -- see `acceptanceShapeRefusal`.
  const acceptance = acceptanceShapeRefusal(body);
  if (acceptance) return `row-file: ${acceptance}`;
  const wholeSuite = wholeSuiteAcceptanceReason(body, "row-file");
  if (wholeSuite) return wholeSuite;
  // #2099: THE FOURTH CAPABILITY, REFUSED WHERE THE OTHER "this job cannot run that" verdicts are. One
  // line here and the whole rule in `acceptance-commands.ts`, beside the classifier whose verdict it
  // moves earlier -- the same seam `acceptancePathsReason` and `labFetchPathReason` below already use,
  // and the reason `row-file.ts` is not this row's Region: it owns none of the logic, only the call.
  const handRun = handRunAcceptanceReason(body, "row-file");
  if (handRun) return handRun;
  // #1943: SHAPE, THEN THE PATHS THE SHAPE NAMES. The checks above ask whether a command can be run at
  // all; this asks whether the files it names are there -- a fact about the checkout the filer is
  // standing in, available here for the cost of a `stat`, and measured twice in one day (#1939, #1936)
  // as the thing nothing asked. Last, because a whole-suite command names no path and must be refused
  // for what it is rather than for naming nothing.
  const paths = acceptancePathsReason(body, "row-file");
  if (paths) return paths;
  // #1973: AND THE PATHS THAT EXIST BUT ARE THE WRONG ONES. The check above asks whether a named file is
  // there; this asks whether a row that fetches an artifact then reads it named the LAB's copy instead of
  // the one the fetch writes here. Last, and after the existence check, because the two answer different
  // questions about the same token and the existence check's `runs/` exemption is what leaves this one
  // anything to say -- a `runs/` path is never refused as absent, so nothing else would ever look at it.
  return labFetchPathReason(body, "row-file");
}

/**
 * THE ROW NUMBERS A FILING NAMES AS BLOCKERS: `--blocked-by=3778,12`, `--blocked-by #3778`, repeated or not. A reference of another form (a URL, `owner/repo#n`) is not read:
 * its done-whens are not this repository's to count, and an unread edge is not an umbrella one.
 * @param {string[]} argv @returns {number[]}
 */
export function blockedByNumbers(argv: string[]): number[] {
  const values = argv.flatMap((arg, i) => {
    if (arg.startsWith("--blocked-by=")) return [arg.slice("--blocked-by=".length)];
    return arg === "--blocked-by" && argv[i + 1] !== undefined ? [argv[i + 1]] : [];
  });
  return values.flatMap((value) => value.split(",")).flatMap((ref) => /^#?(\d+)$/.exec(ref.trim())?.slice(1).map(Number) ?? []);
}

/**
 * #4005: A NEW EDGE ONTO A ROW OF MORE THAN ONE DONE-WHEN MUST SAY WHICH ONE, or the filing must wait on a condition instead. A native `blocked-by` clears when the blocker
 * CLOSES (all of its done-whens) and names none of them: seven `ready` rows sat behind #3778 after the first version reached `next`, because the one fact they needed was one
 * of five. `null` means proceed. A blocker that cannot be READ, or is already closed, is not refused: that is an unknown, and a closed row holds nothing.
 * @param {string} body @param {string[]} argv
 * @param {{ read: (number: number) => { state: string, body: string } | null }} deps `read` is `gh issue view`'s state and body, `null` when it failed
 * @returns {string | null}
 */
export function blockedByRefusal(body: string, argv: string[], { read }: { read: (number: number) => { state: string; body: string; } | null; }): string | null {
  for (const number of blockedByNumbers(argv)) {
    const blocker = read(number);
    const edge = blocker && String(blocker.state).toUpperCase() === "OPEN" ? umbrellaEdge({ holderBody: body, blocker: { number, body: blocker.body } }) : null;
    if (edge) {
      return `row-file: REFUSING to file -- \`--blocked-by=${number}\` names a row of ${edge.doneWhens} done-whens and does not say which one this row waits for, so it holds `
        + `until ALL ${edge.doneWhens} are done. Either name it with a line \`Waits-on-done-when: ${number}.<k>\` (k is 1 to ${edge.doneWhens}) in the body, or wait on the CONDITION `
        + "with a \`Waiting-for:\` line the gate reads (\`published <pkg>@<dist-tag>\`, \`<pkg> latest = next\`, \`tagged <tag>\`, \`closed #n\`, \`merged #n\`).";
    }
  }
  return null;
}

/** @param {number} number @param {(cmd: string, args: string[]) => string} run @param {string} repo the tracker the new row is filed in, where its blocker lives @returns {{ state: string, body: string } | null} the blocker, `null` when it cannot be read */
function readBlocker(number: number, run: (cmd: string, args: string[]) => string, repo: string): { state: string; body: string; } | null {
  try {
    const row = JSON.parse(run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "state,body"]));
    return typeof row?.state === "string" ? { state: row.state, body: String(row.body ?? "") } : null;
  } catch {
    return null; // an unreadable blocker is an unknown, never an umbrella
  }
}

/**
 * The `--session=<name>` value, or `null` when absent -- the same convention `row-claim.ts` requires for
 * dispatch/claim/decline, reused rather than a second, independently-typed flag.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function sessionFromArgv(argv: string[]): string | null {
  const flag = argv.find((a) => a.startsWith("--session="));
  return flag ? flag.slice("--session=".length) : null;
}

/**
 * `body` with a trailing `Filed-by: <session>` line -- the whole of #771's record. Appended after the
 * body's own trailing whitespace is trimmed, so it always lands on its own line regardless of whether the
 * caller's body already ended with one.
 * @param {string} body @param {string} session
 * @returns {string}
 */
export function appendFiledBy(body: string, session: string): string {
  return `${body.replace(/\s+$/, "")}\n\nFiled-by: ${session}\n`;
}

/**
 * `argv` with any `--body`/`--body-file` form removed and replaced by a single `--body <augmentedBody>`,
 * and `--session=`/`--ready`/`--tracker=` removed entirely -- `gh issue create` knows neither and would refuse them
 * as unknown flags. Every other argument (title, labels, ...) passes through in its original position,
 * unchanged.
 * @param {string[]} argv @param {string} session @param {string} body the body BEFORE augmentation
 * @returns {string[]}
 */
export function withFiledBy(argv: string[], session: string, body: string): string[] {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--body" || arg === "--body-file" || arg === "--session") { i += 1; continue; }
    if (arg.startsWith("--body=") || arg.startsWith("--body-file=") || arg.startsWith("--session=")
      || arg.startsWith(TRACKER_FLAG) || arg === READY_FLAG || arg === ALLOW_SAME_TITLE_FLAG) continue;
    kept.push(arg);
  }
  kept.push("--body", appendFiledBy(body, session));
  return kept;
}

// #844: THE ONE FLAG THIS FILE OWNS, NOT `gh`'s -- stripped by `withFiledBy` above the same way
// `--session=` is, so `refuseUnknownFlags`'s own gh-facing list never needs to know it.
const READY_FLAG = "--ready";

// #4078: THE SECOND FLAG THIS FILE OWNS. `--tracker=<key>` overrides the tracker `rowTracker` reads off the Region; stripped by
// `withFiledBy`, which is also why it is not in the gh-facing list above.
const TRACKER_FLAG = "--tracker=";

// #4123: THE THIRD FLAG THIS FILE OWNS. `--kind defect` (or `--kind=defect`) marks a row as a defect at filing: it adds the `defect` label, which
// is what makes a pull request that closes the row owe a `Class:` line (`defect-class-line.ts`). Stripped before `gh` sees it, as `--ready` is.
// ONE KIND TODAY, and any other value is refused before anything is filed: a typo must not file an unmarked row the check then never reads.
const KIND_FLAG = "--kind";
/** The labels a `--kind` value adds, by value. */
const KIND_LABELS = Object.freeze({ defect: DEFECT_LABEL });

// #4294: THE FOURTH FLAG THIS FILE OWNS. A filing run launched twice filed three layout rows twice, 18 s apart (#4223 = #4222, #4225 = #4224, #4228 = #4227),
// and nothing here asked whether an OPEN row already had the title. `--allow-same-title` is the one override; stripped before `gh` sees it, as `--ready` is.
const ALLOW_SAME_TITLE_FLAG = "--allow-same-title";

/**
 * The title this invocation would file, in every spelling `gh issue create` takes: `--title X`, `--title=X`, `-t X`, `-t=X`, `-tX`. The last one
 * given wins, as `gh` takes it. `null` when there is none (`--web`/`--editor` file nothing from argv): then there is no title to compare.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function titleFromArgv(argv: string[]): string | null {
  let title = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--title" || arg === "-t") title = argv[i + 1] ?? title;
    else if (arg.startsWith("--title=")) title = arg.slice("--title=".length);
    else if (arg.startsWith("-t=")) title = arg.slice("-t=".length);
    else if (/^-t[^-=]/.test(arg)) title = arg.slice("-t".length);
  }
  return title;
}

/** The comparison form of a title: surrounding space trimmed, inner runs of space collapsed, case folded. @param {string} title @returns {string} */
const comparableTitle = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

const OPEN_TITLE_READ_LIMIT = 100;

/**
 * The OPEN row in `repo` whose title equals `title` (trimmed, case-folded), as `{ number }`; `null` when there is none; `"unreadable"` when GitHub
 * could not be asked. ONE `gh issue list` call per filing: the search narrows to rows whose title holds the phrase, the exact comparison is ours
 * (a search match is fuzzy; a refusal must not be). A CLOSED row is never asked for -- a reopened-and-refiled row is legitimate.
 * @param {string} title @param {string} repo @param {(cmd: string, args: string[]) => string} run
 * @returns {{ number: number } | null | "unreadable"}
 */
function openRowTitled(title: string, repo: string, run: (cmd: string, args: string[]) => string): { number: number; } | null | "unreadable" {
  try {
    const rows = JSON.parse(run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--search", `"${title.trim().replace(/"/g, " ")}" in:title`,
      "--limit", String(OPEN_TITLE_READ_LIMIT), "--json", "number,title"]));
    if (!Array.isArray(rows)) return "unreadable";
    const wanted = comparableTitle(title);
    const hit = rows.find((row) => typeof row?.title === "string" && comparableTitle(row.title) === wanted);
    return hit ? { number: Number(hit.number) } : null;
  } catch {
    return "unreadable"; // an outage is CANNOT_ASK, never "no duplicate"
  }
}

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

export type Tracker = import("./project-config.ts").Tracker;
/** #4378: the declaration `primaryMilestoneRefusal` reads: the trackers (which one has milestones) and the `code` and `dora` lists `adopterRowKind` judges a Region by */
type AdopterDeclaration = Parameters<typeof adopterRowKind>[1] & { tracker: Tracker[]; };

/**
 * #4078: THE PROJECT'S OWN TRACKER -- the first declared, which is also what `REPO`, `PROJECT_OWNER` and `PROJECT_NUMBER` name. Promotion
 * (`--promote=`) and `--board=` act on a row that ALREADY EXISTS, found by its number in this tracker, and take it; filing takes the one
 * `rowTracker` names.
 * @returns {Tracker}
 */
const homeTracker = (): Tracker => homeProjectDeclaration().tracker[0];

/** @param {Tracker} a @param {Tracker} b @returns {boolean} */
const sameTracker = (a: Tracker, b: Tracker): boolean => a.repo === b.repo && a.board.owner === b.board.owner && a.board.number === b.board.number;

/**
 * #844: which label -- and which Project 2 Status option, by the SAME name -- this filing gets.
 * `backlog` unless `--ready` is explicitly given: a row filed with everything a claimant needs (Region,
 * Acceptance, Open-check already checked above) can go straight to the Ready lane; every other row
 * starts in Backlog, matching this repo's own convention that `ready` is a judgement about pickability
 * a filer states on purpose, never a default.
 * @param {string[]} argv
 * @returns {{ label: "backlog" | "ready", status: "Backlog" | "Ready" }}
 *
 * The label that says a row is deliberately outside the release, rather than missing its milestone.
 * IMPORTED, NOT REDECLARED (#2619, child 3d of #69): `project-vocabulary.ts`'s field, re-exported under
 * this file's own established name so every existing importer keeps working unchanged.
 */
export { OUT_OF_RELEASE };

/**
 * The milestone that says the same thing as the label, created 2026-09-12 on `ceo`'s ruling so the board
 * can SEE that population rather than meet it as nine unmilestoned rows.
 *
 * #1130: TWO FACTS NOW SAY "OUTSIDE EVERY RELEASE" AND NOTHING COMPARED THEM. `declaresRelease` already
 * accepted this milestone -- any `--milestone` with a value satisfies it -- so the gap was the other
 * direction: the LABEL alone was accepted and left the row out of the milestone, recreating one row at a
 * time exactly the state the milestone was made to end.
 *
 * So `outOfReleaseArgv` gives the label path the milestone too. Filing can no longer produce a row where
 * the two disagree -- and `row-file.test.ts` pins them equal ACROSS THE TRACKER as well, because
 * filing-time agreement does not survive a hand-edit and a hand-edit is how `ready`/Status drifted across
 * 16 rows unseen. IMPORTED, NOT REDECLARED (#2619, child 3d of #69): see `OUT_OF_RELEASE`, above.
 */
export { OUT_OF_RELEASE_MILESTONE };

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
function releaseExpectation(filedArgv: string[]): { milestone: string | null; releaseLabel: string | null; kindLabel: string | null; } {
  return { milestone: milestoneFromArgv(filedArgv),
    releaseLabel: labelsOutOfRelease(filedArgv) ? OUT_OF_RELEASE : null, kindLabel: kindLabelOf(filedArgv) };
}

/**
 * #4123: the `defect` label the filing carries, read from what was FILED (as `releaseExpectation` is), so the read-back asks for it.
 * @param {string[]} filedArgv
 * @returns {string | null}
 */
function kindLabelOf(filedArgv: string[]): string | null {
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
    if ((arg === "--milestone" || arg === "-m") && (argv[i + 1] ?? "").length > 0) return argv[i + 1];
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
    if ((arg === "--milestone" || arg === "-m") && (argv[i + 1] ?? "").length > 0) return true;
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
const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * #2111: the OTHER board label. IMPORTED FROM `project-vocabulary.ts` (#2619, child 3d of #69) rather
 * than declared locally: `READY_LABEL` still comes from `claim-labels.ts`, the pinned leaf that owns it
 * (`backlog` is not one of that file's four claim-lifecycle labels), and both now name the fact once.
 */

/** The Project Status option a promoted row must end on -- the same name as its label, by #844's rule. */
const READY_STATUS = "Ready";

/** The two board labels, which `boardAndVerify` applies after the Status move (#844) and nothing else may. */
const BOARD_LABELS = Object.freeze([BACKLOG_LABEL, READY_LABEL]);

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
export function laneLabelsFor(regionFiles: string[], lanes: { lanes: import("./lane-ownership.ts").Lane[]; }): string[] {
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

/** #3330: project items asked for per request; `fetchIssueBoardStatus` pages past it rather than trusting it. */
const PROJECT_ITEMS_PAGE = 100;

/**
 * One page of the issue's `projectItems`. Throws, never guesses, on a failed call or an unexpected shape.
 * @param {number} issueNumber @param {string | null} cursor @param {typeof defaultRun} run @param {string} repo the tracker the issue lives in
 * @returns {{ nodes: any[], hasNextPage: boolean, endCursor: string | null }}
 */
function projectItemsPage(issueNumber: number, cursor: string | null, run: typeof defaultRun, repo: string): { nodes: any[]; hasNextPage: boolean; endCursor: string | null; } {
  const [owner, name] = repo.split("/");
  const after = cursor === null ? "" : `, after: "${cursor}"`;
  const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${issueNumber}) `
    + `{ projectItems(first: ${PROJECT_ITEMS_PAGE}${after}) { pageInfo { hasNextPage endCursor } `
    + `nodes { project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "Status") `
    + `{ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  let raw: string;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`row-file: could not read #${issueNumber}'s Project membership -- refusing to guess `
      + `whether it boarded. ${(cause as Error).message}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} was not JSON -- `
      + `refusing to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const items = (parsed as any)?.data?.repository?.issue?.projectItems;
  if (!Array.isArray(items?.nodes)) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} did not have the `
      + `expected shape -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const endCursor = items.pageInfo?.endCursor ?? null;
  const hasNextPage = items.pageInfo?.hasNextPage === true;
  if (hasNextPage && endCursor === null) {
    throw new Error(`row-file: gh reports more Project items for #${issueNumber} but no cursor to read them `
      + "-- refusing to guess whether it is on the Project.");
  }
  return { nodes: items.nodes, hasNextPage, endCursor };
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
  let cursor: string | null = null;
  do {
    const page = projectItemsPage(issueNumber, cursor, run, tracker.repo);
    const onThisProject = page.nodes.find((n) => isBoardOf(tracker, n?.project));
    if (onThisProject) return onThisProject.fieldValueByName?.name ?? null;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor !== null);
  return null;
}

/** @param {Tracker} tracker @param {{ number?: unknown, owner?: { login?: unknown } } | undefined} project @returns {boolean} */
function isBoardOf(tracker: Tracker, project: { number?: unknown; owner?: { login?: unknown; }; } | undefined): boolean {
  if (project?.number !== tracker.board.number) return false;
  const login = project.owner?.login;
  return typeof login !== "string" || login.toLowerCase() === tracker.board.owner.toLowerCase();
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
function chooseTracker(argv: string[], body: string, declaration: Parameters<typeof rowTracker>[1] & { tracker: Tracker[]; }): { tracker: Tracker; note: string | null; } | { refusal: string; } {
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
} = {}): number {
  // A single spread merge, not seven per-property default values -- each `x = defaultX` in a destructured
  // parameter is its own branch for this repo's complexity gate, and `createIssue` already carries the
  // real decision points (session/template/lane refusals, the `gh` try/catch, the two post-file checks).
  // Injectable so a test can prove every step -- the label composed into argv, the lane derivation, the
  // board-add call, the Status move, and the read-back -- without spawning a real `gh`, reaching GitHub,
  // or reading a real `docs/lane-ownership.json`.
  const { spawnGh, run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels, loadLanesConfig,
    milestones, primaryMilestones, declaration } = {
    spawnGh: spawnGhIssueCreate, run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus,
    fetchLabels: fetchIssueLabels, moveStatus: moveTrackerStatus, ensureLabels: ensureLabelsOn,
    loadLanesConfig: loadLanes, milestones: openMilestones, primaryMilestones: primaryMilestoneTitles, declaration: homeProjectDeclaration(), ...deps,
  };
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
  const reason = fileRefusalReason(body);
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
  const { tracker } = chosen;
  if (chosen.note !== null) process.stderr.write(`${chosen.note}\n`);
  // #1158: AFTER the refusals and BEFORE anything is filed. None of these stops the filing -- see
  // `unrecognisedRegionWarning` for why a warning rather than a refusal -- but the author sees them while they
  // still have the body in front of them, which is the only moment each line is cheap to act on. They answer
  // different questions about one body and a body can trip several: all are printed, never chosen between.
  // #2035: the acceptance-side three (`regionClosureWarning`, `quotedTestCountWarning`,
  // `malformedAcceptanceCommandWarning`) join the four Region/waiting ones in `filingWarnings`.
  const umbrella = blockedByRefusal((body as string), argv, { read: (number) => readBlocker(number, run, tracker.repo) }) ?? chairmanAskRefusal((body as string)); // #4020: a declared ask that could never raise one
  if (umbrella) {
    process.stderr.write(`${umbrella}\n`);
    return 1;
  }
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
  const releaseRefusal = !declaresRelease(argv)
    ? undeclaredReleaseRefusal(tracker, declaration, { run, milestones })
    : primaryMilestoneRefusal(argv, (body as string), tracker, declaration, { primaryMilestones, run }); // #4378
  if (releaseRefusal) {
    process.stderr.write(`${releaseRefusal}\n`);
    return 1;
  }
  const duplicate = duplicateTitleRefusal(argv, tracker, run); // #4294: before the create call, so a refusal leaves nothing behind
  if (duplicate) {
    process.stderr.write(`${duplicate}\n`);
    return 1;
  }
  const boarding = boardingFor(argv);
  // #844: THE BOARD LABEL IS NOT ADDED HERE -- see `boardAndVerify`'s own header for why it has to wait
  // until AFTER the Project Status is set, not merely after the issue exists. The lane label(s) travel
  // with it for the identical reason and the same simplicity: one label-add step, not two.
  // #1130: the label alone must not leave the row out of the milestone that says the same thing.
  // #1322: the board and lane labels are this tool's to apply, after the Status move. A filer's copy of either is
  // dropped from the create call rather than landing at creation beside them -- a `ready` there is #867's refusal.
  const filedArgv = filedInTracker(withFiledBy(withoutLabels(releaseArgvFor(withKindLabel(argv), tracker, declaration), [...BOARD_LABELS, ...laneLabels]), session,
    (body as string)), tracker, declaration);

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
  process.stdout.write(`https://github.com/${tracker.repo}/issues/${issueNumber}\n`);
  return 0;
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
const PROMOTE_FLAG = "--promote=";

/**
 * The row this invocation promotes, or `null` when `--promote=` is absent, empty, or names something
 * that is not a positive integer. Read through `flagValue`, the shared extractor `cli-flags.mjs` owns,
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
export function promoteRefusalReason(body: string | null, issueNumber: number): string | null {
  const fields = templateFieldsReason(body ?? "", issueNumber);
  if (fields) return `row-file: REFUSING to promote -- ${fields}`;
  const filing = fileRefusalReason(body);
  if (!filing) return null;
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
function promoteGate(issueNumber: number, { run, fetchLabels }: { run: typeof defaultRun; fetchLabels: typeof fetchIssueLabels; }): { refusal: string | null; } {
  let before: { labels: string[]; state?: string; };
  try {
    before = fetchLabels(issueNumber, { run });
  } catch (error) {
    return { refusal: `row-file: REFUSING to promote -- #${issueNumber}'s labels could not be read, and a `
      + `promotion that cannot see what the row already carries cannot know what to write. `
      + `${(error as Error).message}` };
  }
  // `state` is OPTIONAL on `fetchLabels`' own contract (#752) -- absent reads as "not verified closed",
  // never as closed, so a caller's fixture that omits it behaves exactly as an open row does.
  if (before.state === "CLOSED") {
    return { refusal: `row-file: REFUSING to promote -- #${issueNumber} is CLOSED. Ready means a session `
      + "may pick it up now, and nothing may pick up a closed row. Reopen it first if it is still work." };
  }
  if (before.labels.includes(CLAIM_LABEL)) {
    return { refusal: `row-file: REFUSING to promote -- #${issueNumber} is already claimed (\`${CLAIM_LABEL}\`). `
      + `Promoting it would leave \`${READY_LABEL}\` beside \`${CLAIM_LABEL}\`, which \`ready-label-audit\` `
      + "reports as a HAND CLAIM: a claim made outside `row-claim.ts`. That reading is strong evidence "
      + `rather than proof -- the claim path removes \`${READY_LABEL}\` in a SECOND call (#749), so a claim whose `
      + "removal did not land leaves the same pair -- but a promote act that MINTED the state deliberately "
      + "would point the audit at the mechanism for something this command did. Decline the claim first "
      + "(`row-claim.ts decline "
      + `${issueNumber} --session=<whoever holds it>\`), which restores \`${READY_LABEL}\` by itself.` };
  }
  let body: string;
  try {
    body = run("gh", ["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body", "--jq", ".body"]);
  } catch (error) {
    return { refusal: `row-file: REFUSING to promote -- #${issueNumber}'s body could not be read, so the `
      + `claimability check below could not be asked. ${(error as Error).message}` };
  }
  const reason = promoteRefusalReason(body, issueNumber);
  return { refusal: reason };
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
    run("gh", labelSetArgs(issueNumber, wanted));
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
        ensureLabels: typeof ensureLabelsOn;
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
    ensureLabels?: typeof ensureLabelsOn;
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
// #3330: BOARDING -- the THIRD act this file owns, for a row that EXISTS and is on no board.
//
// `a11ign/a11ign#3328`'s host timer sweeps open `regression` rows the outsider job filed under
// `github.token`, which cannot resolve Project 1: each exists with no Project item, no Status, no `ready`
// and no lane label. Filing boards (`boardAndVerify`) but is reachable only from `gh issue create`;
// `--promote` takes an existing number but only moves the Status, and `gh` answers "is not an item in
// project" for an issue never added. This is `boardAndVerify` reached from an existing number.
// ---------------------------------------------------------------------------------------------------

/** #3330: the flag that makes this invocation a BOARD of an existing row. */
const BOARD_FLAG = "--board=";

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
 * Then `promoteGate`'s claimability rules, then `boardAndVerify` (additive labels, never the full-set PUT:
 * this row is not being promoted from `backlog` and keeps `regression`, `out-of-release` and the rest).
 * @param {string[]} argv
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveTrackerStatus,
 *   ensureLabels: typeof ensureLabelsOn, loadLanesConfig: typeof loadLanes }} deps
 * @returns {{ ok: true, message: string } | { ok: false, code: number, message: string }}
 */
function boardExisting(argv: string[], deps: {
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
  const gate = promoteGate(issueNumber, deps);
  if (gate.refusal !== null) {
    return { ok: false, code: 1, message: `row-file: \`${BOARD_FLAG}${issueNumber}\` is refused by the same `
      + `claimability rules as \`${PROMOTE_FLAG}\`:\n${gate.refusal}` };
  }
  const result = boardAndVerify({ issueNumber, url: `https://github.com/${REPO}/issues/${issueNumber}`,
    boarding: { label: READY_LABEL, status: READY_STATUS }, session: null, laneLabels: [lane.label],
    milestone: null, lead: `Row #${issueNumber} (filed by somebody else)` }, deps);
  if (!result.ok) return { ok: false, code: 2, message: `row-file: ${result.message}` };
  return { ok: true, message: `#${issueNumber} boarded: Project ${PROJECT_NUMBER} item, Status `
    + `"${READY_STATUS}", \`${READY_LABEL}\` + \`${lane.label}\` added beside its other labels.` };
}

/**
 * #3330: the CLI's board path. Exit 1 is REFUSED with nothing changed; exit 2 is something written and not
 * confirmed (`promoteRow`'s own two codes); exit 0 is boarded OR already boarded, which the line says.
 * @param {string[]} argv
 * @param {{ run?: typeof defaultRun, fetchBoardStatus?: typeof fetchIssueBoardStatus,
 *   fetchLabels?: typeof fetchIssueLabels, moveStatus?: typeof moveTrackerStatus,
 *   ensureLabels?: typeof ensureLabelsOn, loadLanesConfig?: typeof loadLanes }} [deps]
 * @returns {number} the process exit code
 */
export function boardRow(argv: string[], deps: {
    run?: typeof defaultRun; fetchBoardStatus?: typeof fetchIssueBoardStatus;
    fetchLabels?: typeof fetchIssueLabels; moveStatus?: typeof moveTrackerStatus;
    ensureLabels?: typeof ensureLabelsOn; loadLanesConfig?: typeof loadLanes;
} = {}): number {
  const merged = { run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus, fetchLabels: fetchIssueLabels,
    moveStatus: moveTrackerStatus, ensureLabels: ensureLabelsOn, loadLanesConfig: loadLanes, ...deps };
  const stray = boardArgvRefusal(argv);
  const result = stray ? { ok: false, code: 1, message: stray } : boardExisting(argv, merged);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return (result.code as number);
  }
  process.stdout.write(`${result.message}\n`);
  return 0;
}

function main() {
  refuseUnknownFlags([...KNOWN_GH_ISSUE_CREATE_FLAGS, "--session=", READY_FLAG, PROMOTE_FLAG, BOARD_FLAG, "--lane=", TRACKER_FLAG, KIND_FLAG, `${KIND_FLAG}=`, ALLOW_SAME_TITLE_FLAG],
    { entry: import.meta.url, command: "pnpm run row-file" });
  // #1352: from the primary checkout or a plain clone, refuse before filing anything -- exit 1, createIssue's own
  // "refused, nothing filed" code.
  if (launchGate("row-file")) {
    process.exitCode = 1;
    return;
  }
  // #2111: routed on the flag's PRESENCE, never on its value -- a `--promote=` naming something unusable
  // must reach `promoteRow`'s own refusal rather than fall through and try to FILE a row. `--board=` (#3330)
  // routes the same way, and first: it is the act that takes an existing number AND a lane.
  const argv = process.argv.slice(2);
  const present = (flag: string) => argv.some((a) => a.startsWith(flag));
  if (present(BOARD_FLAG)) process.exitCode = boardRow(argv);
  else process.exitCode = present(PROMOTE_FLAG) ? promoteRow(argv) : createIssue(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
