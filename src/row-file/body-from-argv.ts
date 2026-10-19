import { execFileSync } from "node:child_process";
import { acceptancePathsReason, extractAcceptanceSection, handRunAcceptanceReason, labFetchPathReason } from "../acceptance-commands/suite-and-checkout-commands.ts";
import { classifyCommand } from "../acceptance-commands/unmet-command-closure-requirements.ts";
import { jobCapabilities, unmetClosureRequirements } from "../acceptance-commands/classification.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { leakRefusalReason } from "../lib/leak-patterns.ts";
import { bareRstestRunReason, missingTemplateFields, wholeSuiteAcceptanceReason } from "../row-claim/template-fields-rule.ts";
import { waitingLanguageWarning } from "../row-claim/waiting-language-rule.ts";
import { DEFECT_LABEL } from "../defect-class-line.ts";
import { declaredRegionFiles, declaresNoCommit, directoryReservations, extractLabeledSection, regionPathTokens, slashlessDirectoryEntries, splitRegionEntry, unrecognisedRegionPaths } from "../region-paths.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { cloneOfKey } from "../claim-stall/claim-stalled.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { builtInCheckoutOf } from "../built-in-checkout.ts";
import { readUnlessRefused } from "../ticket-port/rows-by-label.ts";
import { parseWaits, umbrellaEdge } from "../wait-condition.ts";
import { DISTINCT_FROM_FLAG } from "../duplicate-row.ts";
import { ACCEPTANCE_FIELD, ANSWER_PREFIX } from "../project-vocabulary.ts";

export const defaultRun: (cmd: string, args: string[]) => string = (cmd, args): string => execFileSync(cmd, args, { encoding: "utf8" });

/** `gh issue create --help`'s complete flag surface, long and short forms, plus its two inherited flags. */
export const KNOWN_GH_ISSUE_CREATE_FLAGS = [
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
 * #855: A `--ready` ROW'S REGION NAMES A DIRECTORY ITS REPOSITORY HAS, or it is refused here, before `gh` runs. Measured on a11ign#4957
 * (cause 5): a row filed with Region `packages/guards/src/x.test.ts` into a repository with no `packages/` was accepted, claimed and
 * worked before anyone read the path back -- the silence the Region parser exists to end.
 *
 * ONE QUESTION PER PATH: does the top-level directory the path begins with exist on `origin/main` of the repository the entry is
 * keyed to (`""`, the project's first repository, is `HOME_CHECKOUT`; `key:` is that key's clone, from `host.json`)? A single new file
 * at the root (`src/new-file.test.ts` is not that -- its `src/` exists) is not a directory, so it is never read here.
 *
 * THE TOKENS ARE READ BY `regionPathTokens` in `region-paths.ts`, the one reader of a keyed token: `unrecognisedRegionPaths` and
 * `declaredRegionFiles` cannot see `nvda-worker:packages/...` (measured 2026-10-11 with a declared key: both came back empty).
 *
 * PROMOTION ASKS THE SAME QUESTION (#877): `promoteRefusalReason` calls this with `act: "promote"`, so a backlog row promoted to Ready
 * is not let past what `--ready` filing refuses.
 *
 * A KEYED ENTRY whose repository has NO CLONE DECLARED on this host is not read (`host.json`'s `clones` is absent until a host moves to the
 * installed form, #2623, and refusing there would stop every keyed row filing as it does today). A key the project does not declare is not
 * read either. An UNREADABLE clone is a refusal, not a pass: `git ls-tree` failing is "could not tell", and this file refuses on silence.
 * @param {string} body
 * @param {{ code?: readonly { key: string, repo: string }[], trackerRepo?: string, checkoutOf?: (key: string) => string | null,
 *   hasTopLevel?: (checkout: string, top: string) => boolean | null, present?: (checkout: string) => boolean }} [deps] every read is injectable; absent, it is the real one
 * @returns {string | null}
 */
export function absentRegionTopDirReason(body: string, { code = homeProjectDeclaration().code, trackerRepo = homeProjectDeclaration().repo,
  checkoutOf = checkoutOfKey, hasTopLevel = repoHasTopLevelDir, present = existsSync, act = "file --ready" }: { code?: readonly { key: string; repo: string; }[]; trackerRepo?: string;
  checkoutOf?: (key: string) => string | null; hasTopLevel?: (checkout: string, top: string) => boolean | null;
  present?: (checkout: string) => boolean; act?: string; } = {}): string | null {
  for (const token of regionPathTokens(body)) {
    const { key, path } = splitRegionEntry(token);
    const top = path.split("/")[0];
    const repo = code.find((entry) => entry.key === key);
    if (repo === undefined) continue;
    // A clone that is not on this disk (the CI runner has no ~/repos/agent-org) cannot be read at all: skipped, as an undeclared clone is (#2623).
    const checkout = checkoutOf(key);
    if (checkout === null || !present(checkout)) continue;
    const has = hasTopLevel(checkout, top);
    if (has === null) {
      return `REFUSING to ${act} -- could not read origin/main of ${repo.repo} to see whether it has \`${top}/\`, so \`${token}\` `
        + "cannot be checked (#855). Fetch origin, then file again.";
    }
    if (has) continue;
    const holders = code.filter((other) => other.key !== key).filter((other) => {
      const found = checkoutOf(other.key);
      return found !== null && hasTopLevel(found, top) === true;
    }).map((other) => other.repo);
    const where = holders.length === 0
      ? `No declared repository has \`${top}/\`, so the path is wrong, not in another repository.`
      : `${holders.join(", ")} ${holders.length === 1 ? "has" : "have"} \`${top}/\`: file the row there, or key the path to that repository.`;
    return `REFUSING to ${act} -- the \`## Region\` names \`${token}\`, but ${repo.repo} (the repository this entry builds in) has no `
      + `top-level \`${top}/\`. The tracker is ${trackerRepo}. ${where} (#855).`;
  }
  return null;
}

/** Where a repository's clone is: the project's first repository is `HOME_CHECKOUT`; a keyed one is `host.json`'s `clones.<key>`, or `null`. */
export function checkoutOfKey(key: string): string | null {
  if (key === "") return HOME_CHECKOUT;
  const clone = cloneOfKey(key);
  return "clone" in clone ? clone.clone : null;
}

/** Does `origin/main` of the checkout have `top` at its root? `null` when git cannot say (never a silent `false`). */
export function repoHasTopLevelDir(checkout: string, top: string): boolean | null {
  try {
    return execFileSync("git", ["-C", checkout, "ls-tree", "--name-only", "origin/main", "--", top],
      { encoding: "utf8", env: sandboxGitEnv() }).trim() !== "";
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------------------------------------------------------------------
// #1015: A BUILD ROW'S `spec` BLOCK, REFUSED FIELD BY FIELD AT FILING (the validation half of a11ign#5109's structured format).
//
// BEHIND `rows.specBlock` in `.agent-org/project.json`, ABSENT MEANING OFF (a11ign#5100's rule): flag off, the whole rule is a no-op. Revert: the flag off.
// A row with NO `spec` fence is exempt (a decomposition, investigation or fleet row carries none; the row states the exemption, this does not guess it).
//
// READ WITHOUT A YAML PARSER, DELIBERATELY: `yaml` is a devDependency and this file runs from the tool's checkout without one (`host-units.ts` says the same).
// The block's grammar is the small subset a spec uses -- nested maps, lists, lists of maps, plain/quoted scalars, `|`/`>` block scalars, `[]`/`{}` and
// flat `[a, b]` -- and anything else is REFUSED AS UNREADABLE rather than guessed at. `spec-block-refusal.test.ts` parses the same blocks with `yaml`
// and asserts the two agree, which is what makes this a reading of YAML rather than a second dialect.
// ---------------------------------------------------------------------------------------------------------------------------------------

type SpecValue = string | SpecValue[] | { [key: string]: SpecValue };
type SpecLine = { indent: number; text: string; raw: string; };

/** The words a `then` may be made of and still assert nothing. The deeper vagueness lint is a11ign#5117's, at Ready. */
const EMPTY_THENS: ReadonlySet<string> = new Set(["works", "correct", "as expected", "ok"]);
const SPEC_KEY_LINE = /^("[^"]*"|'[^']*'|[A-Za-z_][\w.-]*):(?:\s+(.*))?$/;

export class SpecUnreadable extends Error {}

function unquoteSpecScalar(text: string): string {
  if (text.startsWith("\"")) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) throw new SpecUnreadable(`the double-quoted scalar \`${text}\` is not closed on its line`);
    return text.slice(1, -1).replace(/\\(["\\n])/g, (_all, c: string) => (c === "n" ? "\n" : c));
  }
  if (!/^'(?:[^']|'')*'$/.test(text)) throw new SpecUnreadable(`the single-quoted scalar \`${text}\` is not closed on its line`);
  return text.slice(1, -1).replaceAll("''", "'");
}

/** One scalar, flow list or empty flow map from the text after `key:` or `- `. */
function readSpecScalar(rest: string): SpecValue {
  const text = rest.startsWith("\"") || rest.startsWith("'") ? rest.replace(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/, "$1") : rest.replace(/\s+#.*$/, "").trim();
  if (text === "~" || text === "null") return "";
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("\"") || text.startsWith("'")) return unquoteSpecScalar(text);
  if (/^[&*!{|>]/.test(text) && !/^[|>][+-]?$/.test(text)) throw new SpecUnreadable(`\`${text.slice(0, 20)}\` (an anchor, alias, tag or flow map) is not read in a spec block`);
  if (text.startsWith("[")) {
    if (!text.endsWith("]") || /[[{]/.test(text.slice(1, -1))) throw new SpecUnreadable(`the flow list \`${text.slice(0, 30)}\` is nested or not closed on its line`);
    return text.slice(1, -1).split(",").map((item) => item.trim()).filter((item) => item !== "").map((item) => String(readSpecScalar(item)));
  }
  return text;
}

/** The block's value, or a thrown `SpecUnreadable`. Exported for `spec-block-refusal.test.ts`, which compares it with `yaml`'s on the forms a spec uses. */
export function parseSpecYaml(source: string): SpecValue {
  const lines: SpecLine[] = source.split("\n").map((raw) => {
    if (/^\s*\t/.test(raw)) throw new SpecUnreadable("a line is indented with a tab, which YAML does not allow");
    return { indent: raw.length - raw.trimStart().length, text: raw.trim(), raw };
  });
  let at = 0;
  const skipBlank = (): void => { while (at < lines.length && (lines[at]!.text === "" || lines[at]!.text.startsWith("#"))) at += 1; };
  const nextDeeper = (than: number): SpecLine | null => { skipBlank(); const line = lines[at]; return line && line.indent > than ? line : null; };

  const blockScalar = (parentIndent: number, header: string): string => {
    const folded = header.startsWith(">");
    const body: string[] = [];
    let blockIndent = -1;
    while (at < lines.length) {
      const line = lines[at]!;
      if (line.text !== "" && line.indent <= parentIndent) break;
      if (line.text !== "" && blockIndent < 0) blockIndent = line.indent;
      body.push(line.text === "" ? "" : line.raw.slice(blockIndent));
      at += 1;
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    const text = body.join(folded ? " " : "\n");
    return header.includes("-") || text === "" ? text : `${text}\n`; // clip keeps one final newline; `+` is read as clip, which no check here can tell apart
  };

  const valueAfter = (parentIndent: number, rest: string, { sameIndentSequence }: { sameIndentSequence: boolean; }): SpecValue => {
    if (/^[|>][+-]?(?:\s+#.*)?$/.test(rest)) return blockScalar(parentIndent, rest);
    if (rest !== "" && !rest.startsWith("#")) return readSpecScalar(rest);
    const deeper = nextDeeper(parentIndent);
    if (deeper) return node(deeper.indent);
    skipBlank();
    const same = lines[at];
    const isSameSequenceItem = sameIndentSequence && same && same.indent === parentIndent && /^-(\s|$)/.test(same.text);
    if (isSameSequenceItem) return node(parentIndent);
    return "";
  };

  const sequence = (indent: number): SpecValue[] => {
    const items: SpecValue[] = [];
    for (skipBlank(); at < lines.length && lines[at]!.indent === indent && /^-(\s|$)/.test(lines[at]!.text); skipBlank()) {
      const line = lines[at]!;
      const rest = line.text.slice(1).trim();
      if (SPEC_KEY_LINE.test(rest)) {
        const offset = line.raw.indexOf(rest, indent + 1);
        lines[at] = { indent: offset, text: rest, raw: " ".repeat(offset) + rest }; // the item's first key, as a line of its own map
        items.push(mapping(offset));
      } else {
        at += 1;
        items.push(valueAfter(indent, rest, { sameIndentSequence: false }));
      }
    }
    return items;
  };

  const mapping = (indent: number): { [key: string]: SpecValue } => {
    const map: { [key: string]: SpecValue } = {};
    for (skipBlank(); at < lines.length && lines[at]!.indent === indent; skipBlank()) {
      const line = lines[at]!;
      const found = SPEC_KEY_LINE.exec(line.text);
      if (!found) throw new SpecUnreadable(`line \`${line.text.slice(0, 40)}\` is not a \`key: value\` line`);
      const key = found[1]!.replace(/^(["'])(.*)\1$/, "$2");
      if (Object.hasOwn(map, key)) throw new SpecUnreadable(`the key \`${key}\` appears twice at one level`);
      at += 1;
      map[key] = valueAfter(indent, found[2]?.trim() ?? "", { sameIndentSequence: true });
    }
    const stray = lines[at];
    if (stray && stray.indent > indent) throw new SpecUnreadable(`line \`${stray.text.slice(0, 40)}\` is indented under a value that cannot hold it`);
    return map;
  };

  const node = (indent: number): SpecValue => (/^-(\s|$)/.test(lines[at]!.text) ? sequence(indent) : mapping(indent));

  skipBlank();
  if (at >= lines.length) return {};
  const value = node(lines[at]!.indent);
  skipBlank();
  if (at < lines.length) throw new SpecUnreadable(`line \`${lines[at]!.text.slice(0, 40)}\` is outside the block's top-level map`);
  return value;
}

/** The bodies of every ```spec fence in a row body, in order, or the reason one is not closed. Other fences are skipped whole (a 4-backtick fence may SHOW a spec). */
function specFencesOf(body: string): { blocks: string[]; unterminated: boolean; } {
  const blocks: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,})\s*([\w-]*)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const close = new RegExp(`^ {0,3}\`{${open[1]!.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end]!)) end += 1;
    if (end >= lines.length) return { blocks, unterminated: open[2] === "spec" };
    if (open[2] === "spec") blocks.push(lines.slice(i + 1, end).join("\n"));
    i = end;
  }
  return { blocks, unterminated: false };
}

const asList = (value: SpecValue | undefined): SpecValue[] | null => (Array.isArray(value) ? value : null);
const asMap = (value: SpecValue | undefined): { [key: string]: SpecValue } | null =>
  value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
const isBlank = (value: SpecValue | undefined): boolean => value === undefined || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

/** Every way one spec's parsed value fails the grammar, as `<field path>: <why>` (the first is what the refusal leads with). */
function specFieldProblems(spec: SpecValue): string[] {
  const root = asMap(spec);
  if (!root) return ["spec: the block is not a map of fields (`files`, `tests`, `run`, `out_of_scope`)"];
  const problems: string[] = [];
  const need = (path: string, value: SpecValue | undefined): boolean => {
    if (value === undefined) { problems.push(`${path}: missing (a required field)`); return false; }
    if (isBlank(value)) { problems.push(`${path}: empty`); return false; }
    return true;
  };
  const strings = (path: string, value: SpecValue): void => {
    const list = asList(value);
    if (!list) { problems.push(`${path}: must be a list`); return; }
    list.forEach((item, i) => { if (typeof item !== "string" || item.trim() === "") problems.push(`${path}[${i}]: empty or not a string`); });
  };
  if (need("files", root.files)) strings("files", root.files!);
  const tests = root.tests;
  if (need("tests", tests)) {
    const map = asMap(tests);
    if (map) {
      if (need("tests.path", map.path) && typeof map.path !== "string") problems.push("tests.path: must be one path");
      if (need("tests.cases", map.cases)) {
        const cases = asList(map.cases);
        if (cases) cases.forEach((one, i) => {
          const fields = asMap(one);
          if (!fields) { problems.push(`tests.cases[${i}]: must be a map with \`given\`, \`when\` and \`then\``); return; }
          for (const name of ["given", "when", "then"] as const) {
            const at = `tests.cases[${i}].${name}`;
            if (!need(at, fields[name])) continue;
            if (typeof fields[name] !== "string") { problems.push(`${at}: must be a sentence`); continue; }
            const said = (fields[name] as string).trim().toLowerCase().replace(/[\s.!]+$/, "");
            if (name === "then" && EMPTY_THENS.has(said)) problems.push(`${at}: \`${said}\` asserts nothing -- name the value, the output or the refusal that is observed`);
          }
        });
        else problems.push("tests.cases: must be a list");
      }
    }
    else problems.push("tests: must be a map with `path` and `cases`");
  }
  if (need("run", root.run) && (typeof root.run !== "string" || /\n/.test(root.run.trim()))) problems.push("run: must be ONE command on one line");
  if (need("out_of_scope", root.out_of_scope) && !(typeof root.out_of_scope === "string" || asList(root.out_of_scope))) problems.push("out_of_scope: must be a sentence or a list");
  for (const optional of ["errors", "examples"] as const) {
    if (root[optional] !== undefined && isBlank(root[optional])) problems.push(`${optional}: present but empty (omit it, or fill it)`);
  }
  return problems;
}

/** `rows.specBlock` of a project declaration's TEXT: on only when exactly `true`, so absent, unreadable and mistyped are all OFF. */
export function specBlockFlagOf(declarationText: string): boolean {
  try {
    return JSON.parse(declarationText)?.rows?.specBlock === true;
  } catch (cause) {
    void cause; // not JSON is not a declaration that turned the flag on; the declaration reader refuses it where it matters
    return false;
  }
}

function readSpecBlockFlag(): boolean {
  try {
    return specBlockFlagOf(readFileSync(`${HOME_CHECKOUT}/.agent-org/project.json`, "utf8"));
  } catch (cause) {
    void cause; // no declaration at this checkout is a project that never declared the flag: OFF
    return false;
  }
}

/**
 * #1015: THE `spec` BLOCK VERDICT, PURE (`null` means proceed). Exported so `row-promote` and the Ready-time spec lint (a11ign#5117) can call it.
 * `enabled` is `rows.specBlock`; a caller that already holds the flag passes it, and tests do.
 * @param {string} body @returns {string | null}
 */
export function specBlockRefusal(body: string): string | null {
  const { blocks, unterminated } = specFencesOf(body);
  if (unterminated) return "REFUSING to file -- a ```spec fence is never closed, so its block cannot be read. Close it with a line of three backticks.";
  if (blocks.length === 0) return null; // the exemption: a row with no spec fence is not a build row
  if (blocks.length > 1) {
    return `REFUSING to file -- the body has ${blocks.length} \`spec\` fences; a build row carries ONE spec block. Merge them into one.`;
  }
  let problems: string[];
  try {
    problems = specFieldProblems(parseSpecYaml(blocks[0]!));
  } catch (cause) {
    if (!(cause instanceof SpecUnreadable)) throw cause;
    return `REFUSING to file -- the \`spec\` block does not read as YAML: ${cause.message}.`;
  }
  if (problems.length === 0) return null;
  return `REFUSING to file -- the \`spec\` block fails at \`${problems[0]!.split(":")[0]}\`: ${problems.join("; ")}. A build row's spec names \`files\`, \`tests\` (\`path\` and `
    + "`cases`, each with a `given`, `when` and `then` that asserts something), `run` and `out_of_scope`; a Haiku-tier engineer has less context than you have now.";
}

/**
 * THE VERDICT, PURE -- `null` means proceed. Reuses #707's `missingTemplateFields` outright rather than
 * re-deriving it; see this file's header for why that matters here specifically.
 * @param {string | null} body
 * @returns {string | null}
 */

export function fileRefusalReason(body: string | null, options: { specBlock?: boolean } = {}): string | null {
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
  const specBlock = (options.specBlock ?? readSpecBlockFlag()) ? specBlockRefusal(body) : null; // #1015: behind `rows.specBlock`, a row with no spec fence exempt
  if (specBlock) return `row-file: ${specBlock}`;
  const wholeSuite = wholeSuiteAcceptanceReason(body, "row-file");
  if (wholeSuite) return wholeSuite;
  // #775: A COMMAND THAT CAN RUN BUT NEVER PASS. `rstest run` on an agent-org test without its config finds no suites; the rule is in
  // `template-fields-rule.ts` beside the whole-suite one, and this is its one call, filing-side only.
  const bareRstest = bareRstestRunReason(body, "row-file");
  if (bareRstest) return bareRstest;
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
  const paths = acceptancePathsReason(body, "row-file", { builtInCheckout: builtInCheckoutOf(body) }); // #852
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
export function readBlocker(number: number, run: (cmd: string, args: string[]) => string, repo: string): { state: string; body: string; } | null {
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
    const isOwnFlag = arg.startsWith("--body=") || arg.startsWith("--body-file=") || arg.startsWith("--session=")
      || arg.startsWith(TRACKER_FLAG) || arg.startsWith(ROADMAP_FLAG) || arg.startsWith(DISTINCT_FROM_FLAG) || arg === READY_FLAG || arg === ALLOW_SAME_TITLE_FLAG;
    if (isOwnFlag) continue;
    kept.push(arg);
  }
  kept.push("--body", appendFiledBy(body, session));
  return kept;
}

// #844: THE ONE FLAG THIS FILE OWNS, NOT `gh`'s -- stripped by `withFiledBy` above the same way
// `--session=` is, so `refuseUnknownFlags`'s own gh-facing list never needs to know it.
export const READY_FLAG = "--ready";

// #4078: THE SECOND FLAG THIS FILE OWNS. `--tracker=<key>` overrides the tracker `rowTracker` reads off the Region; stripped by
// `withFiledBy`, which is also why it is not in the gh-facing list above.
export const TRACKER_FLAG = "--tracker=";

// #4123: THE THIRD FLAG THIS FILE OWNS. `--kind defect` (or `--kind=defect`) marks a row as a defect at filing: it adds the `defect` label, which
// is what makes a pull request that closes the row owe a `Class:` line (`defect-class-line.ts`). Stripped before `gh` sees it, as `--ready` is.
// ONE KIND TODAY, and any other value is refused before anything is filed: a typo must not file an unmarked row the check then never reads.
export const KIND_FLAG = "--kind";
/** The labels a `--kind` value adds, by value. */
export const KIND_LABELS = Object.freeze({ defect: DEFECT_LABEL });

// #4294: THE FOURTH FLAG THIS FILE OWNS. A filing run launched twice filed three layout rows twice, 18 s apart (#4223 = #4222, #4225 = #4224, #4228 = #4227),
// and nothing here asked whether an OPEN row already had the title. `--allow-same-title` is the one override; stripped before `gh` sees it, as `--ready` is.
export const ALLOW_SAME_TITLE_FLAG = "--allow-same-title";

// #516: THE FIFTH FLAG THIS FILE OWNS. `--roadmap=<option>` names the `Roadmap` value a row filed under a roadmap epic is boarded with; stripped
// before `gh` sees it, as `--tracker=` is. It is the epic's value that decides whether it is required (`roadmapPlan`), never a list in this file.
export const ROADMAP_FLAG = "--roadmap=";
/** The name of the cross-repository single-select field on the org projects (a11ign#928). Its OPTIONS are read from the project, never copied here. */
export const ROADMAP_FIELD = "Roadmap";

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

const OPEN_TITLE_READ_LIMIT = 200;

/**
 * The OPEN row in `repo` whose title equals `title` (trimmed, case-folded), as `{ number }`; `null` when there is none; `"unreadable"` when GitHub
 * could not be asked. ONE `gh issue list` call per filing, #5074: NOT a search (`--search` is sent as a GitHub SEARCH, whose allowance the installation
 * spent, 420 calls an hour from this check), so it is the newest {@link OPEN_TITLE_READ_LIMIT} open rows, compared by title here. THE PRICE: a twin of
 * an open row older than that window is not seen, where the search saw it; the check exists for the second copy of a filing run launched twice, which
 * is the newest row. A CLOSED row is never asked for -- a reopened-and-refiled row is legitimate.
 * @param {string} title @param {string} repo @param {(cmd: string, args: string[]) => string} run
 * @returns {{ number: number } | null | "unreadable"}
 */
export function openRowTitled(title: string, repo: string, run: (cmd: string, args: string[]) => string): { number: number; } | null | "unreadable" {
  try {
    const gh = (args: string[]): string => run("gh", args);
    const rows = JSON.parse(readUnlessRefused({ what: `the ${OPEN_TITLE_READ_LIMIT} newest open rows of ${repo}`, run: gh,
      read: () => gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(OPEN_TITLE_READ_LIMIT), "--json", "number,title"]) }));
    if (!Array.isArray(rows)) return "unreadable";
    const wanted = comparableTitle(title);
    const hit = rows.find((row) => typeof row?.title === "string" && comparableTitle(row.title) === wanted);
    return hit ? { number: Number(hit.number) } : null;
  } catch {
    return "unreadable"; // an outage is CANNOT_ASK, never "no duplicate"
  }
}

export type Tracker = import("../project-config.ts").Tracker;
