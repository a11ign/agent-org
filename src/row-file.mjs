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
// through `loadLanes`/`inLane`, THE SAME FUNCTIONS `lane-ownership.mjs` owns (the merge guard that also read them was retired) --
// never a second, hand-typed spelling of the same rule that could drift from the guard that actually
// refuses the branch. A Region touching two lanes gets BOTH labels, never one picked silently (see
// `laneLabelsFor`); a Region touching none gets `lane:any`, a real answer, not a fallback. A missing or
// malformed lane file is CANNOT_ASK -- refused before `gh issue create` even runs, identically to the
// merge guard's own `laneVerdict` refusing rather than reading silence as "no path has a lane". The
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
// `--session=<name>`, REQUIRED, the identical flag `row-claim.mjs` already uses for the same fact --
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
import { extractAcceptanceSection, fleetOrLabAcceptance } from "./acceptance-commands.mjs";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { leakRefusalReason } from "../../lab/src/packaging/leak-patterns.mjs";
import { missingTemplateFields, wholeSuiteAcceptanceReason } from "./row-claim/template-fields-rule.mjs";
import { moveProjectStatus, filedByLine, fetchLabels as fetchIssueLabels, ensureLabelsExist } from "./row-claim.mjs";
import { PROJECT_OWNER, PROJECT_NUMBER } from "./board-snapshot.mjs";
import { launchGate } from "./board-snapshot-scope.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { declaredRegionFiles, directoryReservations, extractLabeledSection, extractRegionSection, slashlessDirectoryEntries, unrecognisedRegionPaths } from "./region-paths.mjs";
import { loadLanes, inLane } from "./lane-ownership.mjs";

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

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
export function bodyFromArgv(argv) {
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
export function directoryRegionWarning(body) {
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
export function slashlessDirectoryWarning(body) {
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
export function unrecognisedRegionWarning(body) {
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

export function regionRefusalReason(body) {
  if ((declaredRegionFiles(body) ?? []).length > 0) return null;
  // SCOPED TO THE REGION SECTION, never to the whole body. The phrase appears in prose on rows that DO
  // change files -- this row's own body says it twice -- and a declaration that can be made accidentally
  // somewhere else is the easy path past the check this refusal exists to close.
  //
  // THROUGH `extractRegionSection`, NOT A REGEX. My first version wrote its own, and worker-judge found
  // it disagrees with the shared one BOTH WAYS: the inline form (`Region: ...`) was invisible to mine, so
  // a row using it could not make the declaration at all; and a `###` sub-heading ENDS the section
  // everywhere else (#170's recorded shape) while mine ran past it, so a declaration under `### Why`
  // would have been accepted here and ignored by B4. **The section half is where all of this row's logic
  // lives, so "the same function B4 reads" has to be true of the section, not only of the paths.**
  const section = extractRegionSection(body);
  if (section !== null && NOT_A_COMMIT.test(section)) return null;
  return "REFUSING to file -- the `## Region` section names no file, and nothing says that is deliberate. "
    + "A Region naming no path reserves nothing under B4, so a row that simply FORGOT its paths is "
    + "indistinguishable from one that has none, and nobody can route around it. Either name the files "
    + "this row will change, or write `its deliverable is not a commit` in the Region section -- which is "
    + "the sentence #989's in-build rule already uses for a settings change, a ruling, or a measurement "
    + "posted on the row.";
}

/** #989's own words, so the clock and the filer name one category rather than two spellings. */
const NOT_A_COMMIT = /its deliverable is not a commit/i;

/**
 * A sentence in an Open-check that ASSERTS what the command prints. `Prints \`0\` today`, `returns 3`,
 * `reads 7`, `-> 0`. Deliberately about CLAIMS rather than about output: clause 4 of #1174 -- some rows'
 * checks are a command whose meaning the reader judges, and mandating output would refuse those.
 */
const ASSERTS_AN_OUTPUT = /\b(?:prints?|returns?|reads?|outputs?|gives?|yields?)\b[^.\n]{0,40}?[`'"]?-?\d/i;

/** A line that looks like something being RUN rather than something it printed. */
const LOOKS_LIKE_A_COMMAND = /^\s*(?:\$\s+)?(?:npx|npm|node|git|gh|grep|rg|sed|awk|cat|ls|find|python3?|bash|sh)\b/;

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
function isCommandLine(line) {
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
function hasAdjacentTranscript(section) {
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
export function openCheckTranscriptRefusal(body) {
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
 * THE PARSER IS CALLED, NEVER COPIED: which lines count as a header is `acceptance-commands.mjs`'s rule,
 * already fixed five times for forms authors keep writing, and a second copy here would drift from the one
 * CI runs. So this refuses exactly what that parser cannot read -- `duplicate` and `missing` -- and names
 * the one-header forms that pass, so following the refusal files.
 *
 * @param {string} body @returns {string | null}
 */
export function acceptanceShapeRefusal(body) {
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
 * THE VERDICT, PURE -- `null` means proceed. Reuses #707's `missingTemplateFields` outright rather than
 * re-deriving it; see this file's header for why that matters here specifically.
 * @param {string | null} body
 * @returns {string | null}
 */

export function fileRefusalReason(body) {
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
  const region = regionRefusalReason(body);
  if (region) return `row-file: ${region}`;
  const openCheck = openCheckTranscriptRefusal(body);
  if (openCheck) return `row-file: ${openCheck}`;
  // PRESENCE FIRST, THEN CONTENT. A row with no Acceptance section is refused above for that reason; a
  // row whose Acceptance names the whole suite has the section and cannot be run from it, and the two
  // refusals must not be collapsed -- the fix for each is different, which is the same argument
  // `missingTemplateFields` makes for naming each missing field rather than counting them.
  // #1488: and the section must PARSE as one -- see `acceptanceShapeRefusal`.
  const acceptance = acceptanceShapeRefusal(body);
  if (acceptance) return `row-file: ${acceptance}`;
  return wholeSuiteAcceptanceReason(body, "row-file");
}

/**
 * The `--session=<name>` value, or `null` when absent -- the same convention `row-claim.mjs` requires for
 * dispatch/claim/decline, reused rather than a second, independently-typed flag.
 * @param {string[]} argv
 * @returns {string | null}
 */
export function sessionFromArgv(argv) {
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
export function appendFiledBy(body, session) {
  return `${body.replace(/\s+$/, "")}\n\nFiled-by: ${session}\n`;
}

/**
 * `argv` with any `--body`/`--body-file` form removed and replaced by a single `--body <augmentedBody>`,
 * and `--session=`/`--ready` removed entirely -- `gh issue create` knows neither and would refuse them
 * as unknown flags. Every other argument (title, labels, ...) passes through in its original position,
 * unchanged.
 * @param {string[]} argv @param {string} session @param {string} body the body BEFORE augmentation
 * @returns {string[]}
 */
export function withFiledBy(argv, session, body) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--body" || arg === "--body-file" || arg === "--session") { i += 1; continue; }
    if (arg.startsWith("--body=") || arg.startsWith("--body-file=") || arg.startsWith("--session=")
      || arg === READY_FLAG) continue;
    kept.push(arg);
  }
  kept.push("--body", appendFiledBy(body, session));
  return kept;
}

// #844: THE ONE FLAG THIS FILE OWNS, NOT `gh`'s -- stripped by `withFiledBy` above the same way
// `--session=` is, so `refuseUnknownFlags`'s own gh-facing list never needs to know it.
const READY_FLAG = "--ready";

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
 */
export const OUT_OF_RELEASE = "out-of-release";

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
 * 16 rows unseen.
 */
export const OUT_OF_RELEASE_MILESTONE = "Out of release";

/**
 * The argv to file with: unchanged, unless this row declares itself out of release by LABEL alone, in
 * which case the milestone is added beside it.
 *
 * NOT the reverse. A row given the milestone and no label is left alone here, because the label is what
 * `board-data.mjs`'s `outOfRelease()` reads and adding labels a caller did not ask for is a wider change
 * than this row's. The tracker-level assertion is what catches that direction.
 *
 * @param {string[]} argv @returns {string[]}
 */
export function outOfReleaseArgv(argv) {
  const byLabel = labelsOutOfRelease(argv);
  if (!byLabel || milestoneFromArgv(argv) !== null) return argv;
  return [...argv, "--milestone", OUT_OF_RELEASE_MILESTONE];
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
export function milestoneFromArgv(argv) {
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
 * @param {string[]} argv @returns {boolean}
 */
export function labelsOutOfRelease(argv) {
  return labelValuesFromArgv(argv).some((label) => sameLabel(label, OUT_OF_RELEASE));
}

/** @param {string[]} argv @returns {boolean} */
export function declaresRelease(argv) {
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
 * @param {{ run?: typeof defaultRun }} [deps] @returns {string[] | null}
 */
export function openMilestones({ run = defaultRun } = {}) {
  try {
    const raw = run("gh", ["api", `repos/${REPO}/milestones`, "--jq", ".[].title"]);
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
 * @param {string[] | null} milestones @returns {string}
 */
export function milestoneRefusal(milestones) {
  // THE UNREADABLE CASE GETS ITS OWN LINE, not the list's slot -- worker-capture's review of #1016. Reading
  // `--milestone <one of the milestone list could not be read, so pick from ...>` is garbage inside angle
  // brackets, and it is the one case where the reader cannot see the list either, so the message is doing
  // the most work exactly where it read worst.
  const either = milestones === null
    ? `  Either: --milestone <a milestone> -- the list could not be read from here; \`gh api repos/${REPO}`
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
 * @returns {{ label: "backlog" | "ready", status: "Backlog" | "Ready" }}
 */
export function boardingFor(argv) {
  // #1322: a filer who writes `--label=ready` means `--ready`. Read as anything else it came out `backlog`
  // AND `ready` (#1315), a row saying "take me" and "not yet" at once.
  const ready = argv.includes(READY_FLAG) || labelValuesFromArgv(argv).some((label) => sameLabel(label, "ready"));
  return ready ? { label: "ready", status: "Ready" } : { label: "backlog", status: "Backlog" };
}

/**
 * #1322 review (worker-capture): `gh` resolves a `--label` name CASE-INSENSITIVELY (`strings.EqualFold`,
 * api/queries_repo.go at v2.100.0), so `--label=Ready` IS the `ready` label. Every comparison here folds case,
 * or `Ready` boards Backlog and `Lane:Orchestrator` files unrefused.
 * @param {string} a @param {string} b
 */
const sameLabel = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The two board labels, which `boardAndVerify` applies after the Status move (#844) and nothing else may. */
const BOARD_LABELS = Object.freeze(["backlog", "ready"]);

/** One comma list, split the way `gh` splits it. @param {string} value */
const splitLabels = (value) => value.split(",").map((label) => label.trim()).filter(Boolean);

/**
 * Where each `--label` sits in argv, in every spelling `gh issue create` takes: `--label X`, `--label=X`,
 * `-l X`, `-l=X`. `span` is how many argv entries the occurrence occupies.
 * @param {string[]} argv
 * @returns {{ start: number, span: 1 | 2, values: string[] }[]}
 */
function labelOccurrences(argv) {
  /** @type {{ start: number, span: 1 | 2, values: string[] }[]} */
  const found = [];
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
export function labelValuesFromArgv(argv) {
  return labelOccurrences(argv).flatMap((occurrence) => occurrence.values);
}

/**
 * #1322: argv with `drop`'s labels taken out of every `--label`, in place. An occurrence left with no value is
 * removed whole, so `gh` is never handed an empty `--label`; one left untouched keeps its original spelling.
 * @param {string[]} argv @param {readonly string[]} drop
 * @returns {string[]}
 */
export function withoutLabels(argv, drop) {
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
export function labelRefusal(argv, laneLabels) {
  const given = labelValuesFromArgv(argv);
  const stray = given.filter((label) => sameLabel(label.slice(0, "lane:".length), "lane:")
    && !laneLabels.some((derived) => sameLabel(derived, label)));
  if (stray.length > 0) {
    return `row-file: REFUSING to file -- --label ${stray.join(", ")} is not the lane this row's Region derives `
      + `(${laneLabels.join(", ")}). The lane label is derived from docs/lane-ownership.json, the file the merge `
      + "guard reads (#883), so a typed lane that differs would send the row to a lane that cannot merge it. Fix "
      + "the Region, or drop the --label. Nothing was filed.";
  }
  if (boardingFor(argv).label === "ready" && given.some((label) => sameLabel(label, "backlog"))) {
    return "row-file: REFUSING to file -- this filing says both `ready` and `backlog`. `--ready` (or "
      + "`--label ready`) boards it Ready; no board flag boards it Backlog. Give one. Nothing was filed.";
  }
  return null;
}

/**
 * #941: a Region DIRECTORY (`.github/`) touches a lane whose paths lie inside it, or that it lies inside
 * (`.github/workflows/nested/`). Read as a file, `.github/` is in no lane's prefix, and a row declaring the
 * whole directory would have been labelled `lane:any` by omission. An `except` names a file, so it cannot
 * cover a directory.
 * @param {string} directory ends in `/` @param {string[]} paths the lane's own prefixes and files
 */
function directoryTouchesLane(directory, paths) {
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
 * `except` is subtracted the identical way `laneVerdict` subtracts it: a path excepted from a lane (a
 * generated file whose source lives elsewhere) must not pull that lane's label onto a row just because
 * the file happens to sit under the lane's directory.
 * @param {string[]} regionFiles
 * @param {{ lanes: import("./lane-ownership.mjs").Lane[] }} lanes
 * @returns {string[]}
 */
export function laneLabelsFor(regionFiles, lanes) {
  const owners = lanes.lanes
    .filter((lane) => regionFiles.some((f) => (f.endsWith("/") ? directoryTouchesLane(f, lane.paths)
      : inLane(f, lane.paths) && !inLane(f, lane.except ?? []))))
    .map((lane) => lane.owner);
  return owners.length > 0 ? owners.map((owner) => `lane:${owner}`) : ["lane:any"];
}

/**
 * The issue number from `gh issue create`'s own stdout -- a bare URL, nothing else, on success. `null`
 * for anything that does not end in `/issues/<digits>`, so a caller can tell "filed, but I could not
 * read back what number it got" from a genuine number, rather than guessing.
 * @param {string} output
 * @returns {number | null}
 */
export function issueNumberFromUrl(output) {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match ? Number(match[1]) : null;
}

/**
 * #844/#883: does a FRESH read-back confirm every record this filing wrote -- the board label, the
 * `lane:<owner>` label(s), the Filed-by line, and the Project Status? Named, not just a boolean: a
 * reader fixing a half-boarded row needs to know WHICH did not stick, not merely that something did not.
 * @param {{ labels: string[], body: string | null, boardStatus: string | null,
 *           milestone?: string | null }} after
 * @param {{ session: string, label: string, status: string, laneLabels: string[],
 *           milestone?: string | null }} expected
 * @returns {string[]} empty when everything is confirmed
 */
export function unverifiedFilingFields(after, expected) {
  const missing = [];
  if (!after.labels.includes(expected.label)) missing.push(`the \`${expected.label}\` label`);
  const missingLanes = expected.laneLabels.filter((l) => !after.labels.includes(l));
  if (missingLanes.length > 0) missing.push(`${missingLanes.map((l) => `\`${l}\``).join("/")} label(s)`);
  if (after.body === null || filedByLine(after.body) !== expected.session) missing.push("the Filed-by line");
  // #1011: `gh` ACCEPTING `--milestone` is not evidence the field is set -- a flag nobody reads is this
  // repo's own recorded defect. Only a fresh read of the filed row says whether it landed.
  if (expected.milestone !== null && after.milestone !== expected.milestone) {
    missing.push(after.milestone === null
      ? "the milestone"
      : `the milestone (reads "${after.milestone}", not "${expected.milestone}")`);
  }
  if (after.boardStatus !== expected.status) {
    missing.push(after.boardStatus === null
      ? `Project ${PROJECT_NUMBER} membership`
      : `Project ${PROJECT_NUMBER} Status (reads "${after.boardStatus}", not "${expected.status}")`);
  }
  return missing;
}

/**
 * #844: is issue `issueNumber` on Project `PROJECT_NUMBER`, and what Status does it carry? A single
 * targeted GraphQL read of the one issue this filing just created -- never `board-snapshot.mjs`'s whole
 * `fetchBoardItems()` walk, which answers a different, much larger question (every item on the board) at
 * a cost this one-row check does not need to pay.
 * @param {number} issueNumber
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {string | null} the Status option name, or `null` if the issue is not on this Project at all
 */
export function fetchIssueBoardStatus(issueNumber, { run = defaultRun } = {}) {
  const [owner, name] = REPO.split("/");
  const query = `query { repository(owner: "${owner}", name: "${name}") { issue(number: ${issueNumber}) `
    + `{ projectItems(first: 10) { nodes { project { number } fieldValueByName(name: "Status") `
    + `{ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`;
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`row-file: could not read #${issueNumber}'s Project membership -- refusing to guess `
      + `whether it boarded. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} was not JSON -- `
      + `refusing to guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const nodes = /** @type {any} */ (parsed)?.data?.repository?.issue?.projectItems?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`row-file: gh's Project-membership response for #${issueNumber} did not have the `
      + `expected shape -- refusing to guess. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const onThisProject = nodes.find((/** @type {any} */ n) => n?.project?.number === PROJECT_NUMBER);
  return onThisProject?.fieldValueByName?.name ?? null;
}

/**
 * Every argument, unchanged, straight to the real `gh issue create`. Captures stdout (the created issue's
 * URL) instead of inheriting the terminal -- #844: this file now reports its OWN verdict after boarding
 * and reading it back, not `gh`'s raw output, and needs the URL to do either.
 * @param {string[]} argv
 * @returns {string} gh's own stdout, trimmed
 */
function spawnGhIssueCreate(argv) {
  return execFileSync("gh", ["issue", "create", ...argv], { encoding: "utf8" }).trim();
}

/**
 * #883: the lane label(s) for this row, or the refusal to print -- pulled out of `createIssue` to keep
 * that function's own complexity under this repo's gate, same shape as `boardAndVerify`'s own extraction:
 * one concept (derive from the file the merge guard reads, or refuse rather than guess) written out
 * rather than a genuinely separate responsibility. A missing or malformed `docs/lane-ownership.json` is
 * CANNOT_ASK, never "nothing has a lane" (the identical rule `workflow-lane-check.mjs`'s own `laneVerdict`
 * applies to the merge guard's side of the same file) -- refused BEFORE `gh issue create` runs, so
 * nothing is filed on a guess. `body` is assumed to already carry a `## Region` section: the only caller,
 * `createIssue`, checks that via `fileRefusalReason` first, so `declaredRegionFiles` cannot return `null`
 * here.
 * #1322: and the filer's own `--label` values are READ against the lanes it derives, before anything is filed --
 * see `labelRefusal`. Here rather than in `createIssue` because it is the same question: which labels this row gets.
 * @param {string} body @param {typeof loadLanes} loadLanesConfig @param {string[]} argv
 * @returns {{ ok: true, laneLabels: string[] } | { ok: false, message: string }}
 */
function laneLabelsOrRefusal(body, loadLanesConfig, argv) {
  const lanes = loadLanesConfig();
  if (lanes === null) {
    return { ok: false, message: "row-file: could not read docs/lane-ownership.json (absent, empty or "
      + "malformed) -- refusing to guess which lane this row belongs to. Nothing was filed." };
  }
  const regionFiles = /** @type {string[]} */ (declaredRegionFiles(body));
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
  if (fleetReason && !laneLabels.includes("lane:orchestrator")) laneLabels.push("lane:orchestrator");
  const labelProblem = labelRefusal(argv, laneLabels);
  return labelProblem ? { ok: false, message: labelProblem } : { ok: true, laneLabels };
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
 *   moveStatus?: typeof moveProjectStatus, ensureLabels?: typeof ensureLabelsExist,
 *   loadLanesConfig?: typeof loadLanes }} deps
 * @returns {number} the process exit code
 */
export function createIssue(argv, deps = {}) {
  // A single spread merge, not seven per-property default values -- each `x = defaultX` in a destructured
  // parameter is its own branch for this repo's complexity gate, and `createIssue` already carries the
  // real decision points (session/template/lane refusals, the `gh` try/catch, the two post-file checks).
  // Injectable so a test can prove every step -- the label composed into argv, the lane derivation, the
  // board-add call, the Status move, and the read-back -- without spawning a real `gh`, reaching GitHub,
  // or reading a real `docs/lane-ownership.json`.
  const { spawnGh, run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels, loadLanesConfig,
    milestones } = {
    spawnGh: spawnGhIssueCreate, run: defaultRun, fetchBoardStatus: fetchIssueBoardStatus,
    fetchLabels: fetchIssueLabels, moveStatus: moveProjectStatus, ensureLabels: ensureLabelsExist,
    loadLanesConfig: loadLanes, milestones: openMilestones, ...deps,
  };
  const session = sessionFromArgv(argv);
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
  // #1158: AFTER the refusals and BEFORE anything is filed. It does not stop the filing -- see
  // `unrecognisedRegionWarning` for why a warning rather than a refusal -- but the author sees it while
  // they still have the body in front of them, which is the only moment the line is cheap to act on.
  const strayRegion = unrecognisedRegionWarning(/** @type {string} */ (body));
  if (strayRegion) process.stderr.write(`row-file: ${strayRegion}\n`);
  const dirRegion = directoryRegionWarning(/** @type {string} */ (body));
  if (dirRegion) process.stderr.write(`row-file: ${dirRegion}\n`);
  // #1193: beside the other two, for the same reason and at the same moment. These three answer three
  // different questions about one Region and a body can trip more than one -- they are printed, never
  // chosen between.
  const slashless = slashlessDirectoryWarning(/** @type {string} */ (body));
  if (slashless) process.stderr.write(`row-file: ${slashless}\n`);
  // #883: THE LANE(S), DERIVED BEFORE ANYTHING IS FILED -- see `laneLabelsOrRefusal`'s own header for why
  // a missing/malformed `docs/lane-ownership.json` refuses here rather than guessing.
  const laneResult = laneLabelsOrRefusal(/** @type {string} */ (body), loadLanesConfig, argv);
  if (!laneResult.ok) {
    process.stderr.write(`${laneResult.message}\n`);
    return 1;
  }
  const laneLabels = laneResult.laneLabels;
  // #1011: BEFORE `gh issue create`, so a refusal leaves nothing behind. See `milestoneRefusal`.
  if (!declaresRelease(argv)) {
    process.stderr.write(`${milestoneRefusal(milestones({ run }))}\n`);
    return 1;
  }
  const boarding = boardingFor(argv);
  // #844: THE BOARD LABEL IS NOT ADDED HERE -- see `boardAndVerify`'s own header for why it has to wait
  // until AFTER the Project Status is set, not merely after the issue exists. The lane label(s) travel
  // with it for the identical reason and the same simplicity: one label-add step, not two.
  // #1130: the label alone must not leave the row out of the milestone that says the same thing.
  // #1322: the board and lane labels are this tool's to apply, after the Status move. A filer's copy of either is
  // dropped from the create call rather than landing at creation beside them -- a `ready` there is #867's refusal.
  const filedArgv = withFiledBy(withoutLabels(outOfReleaseArgv(argv), [...BOARD_LABELS, ...laneLabels]), session,
    /** @type {string} */ (body));

  /** @type {string} */
  let url;
  try {
    url = spawnGh(filedArgv);
  } catch (error) {
    process.stderr.write(`row-file: gh issue create failed -- nothing was filed. `
      + `${/** @type {Error} */ (error).message}\n`);
    return /** @type {{ status?: number }} */ (error).status ?? 1;
  }
  const issueNumber = issueNumberFromUrl(url);
  if (issueNumber === null) {
    process.stderr.write(`row-file: FILED, but could not read an issue number back from gh's own output `
      + `-- cannot board it or verify it. gh printed: ${url}\n`);
    return 2;
  }

  const result = boardAndVerify({ issueNumber, url, boarding, session, laneLabels,
    milestone: milestoneFromArgv(argv) },
    { run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels });
  if (!result.ok) {
    process.stderr.write(`row-file: ${result.message}\n`);
    return 2;
  }
  process.stdout.write(`https://github.com/${REPO}/issues/${issueNumber}\n`);
  return 0;
}

/**
 * The item-add rung's refusal: what failed, what it SKIPPED, and the command for each.
 *
 * Extracted for `boardAndVerify`'s line budget, but it earns its own name: this is the rung that skips
 * TWO steps rather than one, so it is the only refusal in the ladder that has to describe a repair in
 * three parts. Reported by worker-capture on #1250 -- the first #1249 fix reached the Status rung, which
 * is the one the FILING author hit, and left this one, which is the rung the reviewer's own filing hit.
 * @param {{ issueNumber: number, url: string, boarding: { status: string, label: string },
 *           allLabels: string[], repairLabels: string }} row
 * @param {unknown} error
 */
function boardAddRefusal({ issueNumber, url, boarding, allLabels, repairLabels }, error) {
  return `FILED as #${issueNumber}, but could NOT add it to Project ${PROJECT_NUMBER} -- refusing to `
    + `report success for a row nothing else can find. ${/** @type {Error} */ (error).message}\n  `
    + `AND neither the Status "${boarding.status}" nor ${allLabels.map((l) => `\`${l}\``).join("/")} `
    + `were applied, because both steps sit behind the board add and neither ran. Adding it by hand `
    + `alone leaves this row on the board with no Status and no labels. Apply all three:\n`
    + `    gh project item-add ${PROJECT_NUMBER} --owner ${PROJECT_OWNER} --url ${url}\n`
    + `    gh project item-edit ${PROJECT_NUMBER} --owner ${PROJECT_OWNER} --url ${url} `
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
 * @param {{ issueNumber: number, url: string, boarding: { label: string, status: string },
 *   session: string, laneLabels: string[], milestone: string | null }} filed
 * @param {{ run: typeof defaultRun, fetchBoardStatus: typeof fetchIssueBoardStatus,
 *   fetchLabels: typeof fetchIssueLabels, moveStatus: typeof moveProjectStatus,
 *   ensureLabels: typeof ensureLabelsExist }} deps
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function boardAndVerify({ issueNumber, url, boarding, session, laneLabels, milestone },
  { run, fetchBoardStatus, fetchLabels, moveStatus, ensureLabels }) {
  // #1249: `allLabels` is derived HERE, above the first step that can fail, so every refusal below can
  // name the labels it skipped. An operator cannot derive them -- they come from the Region -- so a
  // message that says "the labels" instead of `backlog`/`lane:any` is one they have to reconstruct.
  const allLabels = [boarding.label, ...laneLabels];
  const repairLabels = `gh issue edit ${issueNumber} --repo ${REPO} `
    + `${allLabels.map((l) => `--add-label ${l}`).join(" ")}`;
  try {
    run("gh", ["project", "item-add", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", url]);
  } catch (error) {
    // #1249, SECOND RUNG: this one skips TWO steps, not one. item-add is the first of three, and the
    // Status and the labels below both sit behind it -- so an operator who follows this message exactly
    // gets the row onto the board with no Status and no labels, which is the partial filing this whole
    // ladder exists to refuse, one rung up. Reported by worker-capture on #1250, whose point was that
    // the first fix reached the rung MY filing hit and not the rung THEIRS did.
    return { ok: false,
      message: boardAddRefusal({ issueNumber, url, boarding, allLabels, repairLabels }, error) };
  }
  const statusResult = moveStatus(issueNumber, boarding.status, { run });
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
    return { ok: false, message: `FILED as #${issueNumber} and added to Project ${PROJECT_NUMBER}, but `
      + `its Status could not be set to "${boarding.status}" -- ${statusResult.reason}\n  `
      + `AND ${allLabels.map((l) => `\`${l}\``).join("/")} were NOT applied, because the Status failed `
      + `first and the label step never ran. Fixing only the Status leaves this row unlabelled and `
      + `invisible to every label-keyed view. Apply both: ${repairLabels}` };
  }
  try {
    // #883: `lane:<owner>` is a PER-DERIVATION label -- `lane:dispatcher`, `lane:any`, whatever the
    // Region maps to -- and #749's own lesson applies identically here: `gh issue edit --add-label`
    // refuses a label that does not already exist in the repository. `ensureLabels` (row-claim.mjs's own
    // `ensureLabelsExist`, reused rather than a second copy) creates it idempotently first.
    ensureLabels(allLabels, { run });
    run("gh", ["issue", "edit", String(issueNumber), "--repo", REPO,
      ...allLabels.flatMap((l) => ["--add-label", l])]);
  } catch (error) {
    return { ok: false, message: `FILED as #${issueNumber}, boarded with Status "${boarding.status}", `
      + `but ${allLabels.map((l) => `\`${l}\``).join("/")} could not be added -- `
      + `${/** @type {Error} */ (error).message}` };
  }

  /** @type {string | null} */
  let bodyAfter;
  try {
    bodyAfter = run("gh", ["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body",
      "--jq", ".body"]);
  } catch {
    bodyAfter = null; // read-back failure reads as "cannot confirm the Filed-by line", not a crash
  }
  /** @type {string | null} */
  let milestoneAfter;
  try {
    milestoneAfter = run("gh", ["issue", "view", String(issueNumber), "--repo", REPO, "--json", "milestone",
      "--jq", ".milestone.title // \"\""]).trim() || null;
  } catch {
    milestoneAfter = null; // unreadable reads as "cannot confirm", which `unverifiedFilingFields` names
  }
  const after = {
    labels: fetchLabels(issueNumber, { run }).labels,
    body: bodyAfter,
    boardStatus: fetchBoardStatus(issueNumber, { run }),
    milestone: milestoneAfter,
  };
  const missing = unverifiedFilingFields(after,
    { session, label: boarding.label, status: boarding.status, laneLabels, milestone });
  if (missing.length > 0) {
    return { ok: false, message: `FILED as #${issueNumber}, but the read-back does not confirm it -- `
      + `missing: ${missing.join(", ")}. Refusing to report success for a row it could not fully board.` };
  }
  return { ok: true };
}

function main() {
  refuseUnknownFlags([...KNOWN_GH_ISSUE_CREATE_FLAGS, "--session=", READY_FLAG],
    { entry: import.meta.url, command: "npm run row-file --" });
  // #1352: from the primary checkout or a plain clone, refuse before filing anything -- exit 1, createIssue's own
  // "refused, nothing filed" code.
  if (launchGate("row-file")) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = createIssue(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
