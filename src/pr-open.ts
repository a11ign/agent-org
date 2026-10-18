#!/usr/bin/env node
// @ts-check
// command: check a PR body's Acceptance/Closes with the tree's own parser before gh pr create/edit sends it
//
// pr:open / pr:edit -- refusing with the parser's own message (#746).
//
// FOUR PRS WENT RED ON THE BODY IN ONE DAY, four authors, four different modes, none of them a defect in
// the change: #708 a DUPLICATE Acceptance section, #723 prose in the Acceptance section (then Closes
// missing), #727 a pipe the file pre-check cannot parse, #736 the section under a `## Verified` heading
// instead of `## Acceptance`. Every one cost a CI round. The parser (`packages/agent-org/src/acceptance-commands.ts`)
// was right in all four cases -- the defect is only that its answer arrives four minutes and one CI round
// after the mistake, instead of at the moment `gh pr create`/`gh pr edit` is about to send the body.
//
// NO SECOND PARSER. `checkBody` below iterates `CI_BODY_REPORTS` (#3209) -- the exact
// functions `packages/agent-org/src/acceptance-commands.ts`'s own CLI entry (the "acceptance / run" CI job) calls --
// never a local regex re-deriving "is this body valid". A second implementation of that question would
// drift from the first, which is this repository's most-repeated defect and would produce the worst
// possible outcome here: a body that passes this wrapper and fails in CI, exactly the situation being
// fixed. `packages/agent-org/src/acceptance-commands.ts` is therefore NOT touched by this file -- it is imported, not
// duplicated.
//
// WHAT THIS DOES NOT DO: a PR body edited in the web UI -- where a `## Verified` heading is most likely to
// be typed -- is not checked. This closes the path the fleet actually uses (`gh pr create`/`gh pr edit`
// from a script); the web form remains unguarded, the mirror of #735 (the row template's own web-form-vs-
// `gh issue create` gap).
//
// A DIFF OUTSIDE THE ROW'S REGION IS REFUSED TOO (#2417, ceo on #928, ruling 3). Three reviews were spent on a
// path the row never declared (#2253 twice, #2408), each after the PR had reached a reviewer. The Region is read
// from the row the body's `Closes #N` names, through `region-paths.ts` -- the leaf the claim rules already
// import, never a second parser of what counts as a path. The way through is a declared line, never an override:
// `Outside-Region: <path> — <reason>`, em dash required. The wiring lives in the ENTRY block, like #1352's
// `launchGate`: the row's body is read from GitHub, and the tests that call `main` directly must not reach it.
//
// A PULL REQUEST ON A CLAIMED ROW'S BRANCH CANNOT DECLARE `Closes: none` (agent-org#744): the same refusal CI's closes-mismatch check makes, read
// from every declared tracker, told here before anything is sent. Wired in the entry block, like the Region's.
//
// A TICKET-MODE RUN (`AGENT_ORG_TICKET`, A11-74) HAS A TICKET IN THE TRACKER AND NO ROW, CLAIM OR SESSION. The entry block reads the ticket first
// (`ticket-mode/pr-open-ticket.ts`), and the checks it makes are that module's: the Region from the ticket's description and plan files, `Refs <KEY>`
// or `Closes <KEY>` in place of `Closes #N`, the owner the run itself, the machine's drafts setting from its ready mark, and a changeset. Nothing is
// armed or labelled, because a ticket worker never merges. A ticket that cannot be read refuses the create. With `AGENT_ORG_TICKET` unset, none of
// this runs, and the row's checks are the ones above.
//
// EXIT CODES (#1479). A caller must be able to tell a refusal from a partial success, because they need
// opposite next steps: retry the command, or never retry it.
//   0  the body passed, `gh pr <mode>` ran, and a ready create was armed.
//   1  nothing was sent: the head or the body was refused, or `gh pr <mode>` itself failed. Retry unchanged.
//   2  usage: no `create`/`edit`, or no --body/--body-file. Nothing ran.
//   3  `gh pr create` LANDED and the step after it failed, so the PR exists. Do not retry pr-open; run only
//      the step the error line names. Before #1479 that throw escaped `main` and Node exited 1 for a PR
//      that existed.
//  75  (#4898) GitHub refused the call for a RATE LIMIT and `host/gh` HELD it: it is not sent and not failed. The gate makes it
//      after the reset, then arms the PR and labels it. Do NOT retry pr-open (that is a second copy) and do not ask a human.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acceptanceSourceOf, closesReferences, extractAcceptanceSection, extractClosesDeclaration, extractMutationSection, runAcceptanceCommand, runCiBodyReports }
  from "./acceptance-commands.ts";
import { ACCEPTANCE_DIR, acceptanceFileForBranch, isAcceptancePath, sectionsTextOf, writeAcceptanceFile } from "./acceptance-file.ts";
import { declaredRegionFiles, splitRegionEntry } from "./region-paths.ts";
import { outsideRegionDeclarations, regionPassLine, regionRefusalText, standingAgainstRegion } from "./pr-open-region.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { statedRepository } from "./row-file.ts";
import { leakRefusalReason } from "./lib/leak-patterns.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { REPO } from "./project-identity.ts";
import { SESSION_PREFIX } from "./project-vocabulary.ts";
import { launchGate } from "./board-snapshot-scope.ts";
import { worktreeOwner } from "./worktree-owner.ts";
import { isLiveSession } from "./arm-pr.ts";
import { APP_ROLE_LANE_OWNER, laneAuthorshipRefusal, loadLanes, reviewOnlyPathsIn } from "./lane-ownership.ts";
import { declarationRefusal } from "./hand-fix-ledger.ts";
import { referencesInReason } from "./merged-row-open-incident.ts";
import { openPullsOf } from "./ticket-port/open-pulls.ts";
import { gh as ghRead } from "./board-data.ts";
import { VERIFY_STATE, readVerifyStamp, verifyRefusalLine } from "./verify-stamp.ts";
import { QUEUED_EXIT, attachFollowUps } from "./gh-ledger.ts";
import { claimedBranchReport, lookupClaimedRowsOfTrackers, trackerReposFor, type ClaimedRow, type ClaimedRows } from "./closes-mismatch-check.ts";
import { STANDARD_MACHINERY_SIGNALS } from "./org-health.ts"; // a11ign#5100: the signals a `Health-signals:` line may name
import { readTicketContext, ticketBodyReports, ticketChecks, type TicketContext } from "./ticket-mode/pr-open-ticket.ts";
import { TICKET_ENV } from "./ticket-mode/worktree-command.ts";

export { REGION_EXEMPT, outsideRegionDeclarations, standingAgainstRegion } from "./pr-open-region.ts";

// The header's EXIT CODES, named because 1 and 3 ask a caller for opposite next steps.
export const EXIT_NOTHING_SENT = 1;
export const EXIT_USAGE = 2;
export const EXIT_LANDED_THEN_FAILED = 3;
export const EXIT_QUEUED = QUEUED_EXIT;

/**
 * Runs a command FOR REAL, through the SAME `runAcceptanceCommand` CI's `main` calls (#859: in the worktree this process was started in, a
 * leading `cd` into the primary checkout run there instead) -- this is the injectable execution seam `acceptanceReport` was built to take, not
 * a second parser: nothing here interprets the body or classifies a command, it only runs the ones the real parser already decided are runnable.
 * #1578: with `acceptanceEnv`'s `PATH`.
 * @param {string} command
 * @returns {number}
 */
function runForReal(command: string): number {
  return runAcceptanceCommand(command, { env: acceptanceEnv(process.env) });
}

/**
 * #1578: THE ACCEPTANCE'S OWN `PATH`, and only the Acceptance's.
 *
 * pr-open's `gh pr create`/`gh pr edit` and its head read resolve `gh` from the process `PATH`, and until this
 * the Acceptance child inherited that same `PATH`. So a refusing `gh` shim first on `PATH` refused pr-open's own
 * create, and with no shim a tracker-reaching test ran against the real `gh` inside pr-open, where nothing could
 * count its calls (#1576). `A11Y_ACCEPTANCE_PATH` is prepended to the CHILD's `PATH` alone:
 *
 *     A11Y_ACCEPTANCE_PATH="$SHIM_DIR" node packages/agent-org/src/pr-open.ts create --draft --body-file body.md ...
 *
 * runs the Acceptance against the shim's `gh` while pr-open's own calls keep the real one. Unset or empty, the
 * child's environment is the process's, unchanged.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function acceptanceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prefix = env.A11Y_ACCEPTANCE_PATH;
  if (!prefix) return env;
  return { ...env, PATH: env.PATH ? `${prefix}:${env.PATH}` : prefix };
}

/**
 * THE CHECK -- every report CI's acceptance job runs over a body (`CI_BODY_REPORTS`: Acceptance, Closes, `Mutation:`,
 * `## Measured`), through the SAME `runCiBodyReports` the CLI entry calls, so the two cannot be spelled apart again
 * (#3209: a body passed here and went red in CI on `MUTATION: MISSING`). `ok: false` means refuse; `lines` is
 * exactly what the CI acceptance job itself would print for this body.
 *
 * `diff` is what `mutationRecordReport` needs and the only thing a body check reads from the tree. A caller that has
 * none gets `UNCHECKED`, which is loud and not a refusal, exactly as CI treats a diff it could not read.
 * @param {string} body
 * #4123: `rowLabels` is the reader of a closed row's labels, for the `Class:` line a defect row's pull request owes; a caller with none gets
 * `CLASS: NOT CHECKED`, printed. ADR 0044: `readFile` reads the acceptance file the diff adds, from the head's tree (the working directory, by default).
 * A ticket-mode run passes `reports`, CI's list with its `closes` report replaced for the ticket (A11-74); absent, it is CI's list.
 * @param {{ run?: (command: string) => number, diff?: import("./acceptance-commands.ts").DiffReading,
 *   rowLabels?: import("./acceptance-commands.ts").BodyReportInput["rowLabels"], reports?: import("./acceptance-commands.ts").BodyReport[] }} [deps]
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkBody(body: string, { run = runForReal, diff = { ok: false, why: "no diff was handed to checkBody" }, rowLabels, readFile, reports }: {
    run?: (command: string) => number; diff?: import("./acceptance-commands.ts").DiffReading;
    rowLabels?: import("./acceptance-commands.ts").BodyReportInput["rowLabels"]; readFile?: (path: string) => string;
    reports?: import("./acceptance-commands.ts").BodyReport[];
} = {}): { ok: boolean; lines: string[]; } {
  // #891: checked BEFORE anything else, and returned on its own -- `acceptanceReport` actually RUNS the
  // body's Acceptance command for real, and a body worth refusing for a leak is not worth running
  // anything from first. The same `allLeaksIn` predicate the tree-wide guards already drive, never
  // restated.
  // ADR 0044: and the file's text too -- it is what gets run when the pull request adds one, so it is the text a leak must not hide in.
  const input = { body, run, diff, rowLabels, readFile };
  const acceptance = acceptanceSourceOf(input);
  const leak = leakRefusalReason(body) ?? leakRefusalReason(sectionsTextOf(acceptance) ?? "");
  if (leak) return { ok: false, lines: [leak] };
  return runCiBodyReports({ ...input, acceptance }, reports);
}


/**
 * The union of the Regions of the rows a body closes, read through `region-paths.ts`. A row whose body cannot be
 * read is `unread` (refuse: absence is not proof the diff is inside), and one with no Region section at all is
 * `no-section` (nothing to compare against, said aloud).
 *
 * #2617: a row is read from the repository the body NAMES (`Closes owner/repo#N`) and from the default tracker when it names none, so
 * `rowBody` is called with the repository only for a qualified row -- a bare one is asked exactly as before. `row` in a `no-section` is the
 * row as written (`#7`, `owner/repo#7`).
 * @param {import("./acceptance-commands.ts").ClosesReference[]} references
 * #3083: a row that STATES its repository (`statedRepository`) and is opened in THAT repository's tree (`tree.repo`, the `--repo`) wrote its
 * bare paths relative to that root, so they are read as its key's; stated or opened elsewhere, a bare path is the first repository's as ever.
 * #1182: and so does a row QUALIFIED to that repository (`Closes owner/repo#N`) when its body states none.
 * @param {{ rowBody: (number: number, repo?: string) => string, rootFiles?: Set<string>, tree: { key: string, repo: string | undefined } }} deps
 * @returns {{ kind: "region", region: string[] } | { kind: "unread", why: string } | { kind: "no-section", row: string }}
 */
function readRegions(references: import("./acceptance-commands.ts").ClosesReference[], { rowBody, rootFiles, tree, code = homeProjectDeclaration().code }: { rowBody: (number: number, repo?: string) => string; rootFiles?: Set<string>; tree: { key: string; repo: string | undefined; }; code?: readonly { key: string; repo: string; }[]; }): { kind: "region"; region: string[]; rows: RegionRow[]; } | { kind: "unread"; why: string; } | { kind: "no-section"; row: string; } {
  const union: Set<string> = new Set();
  const rows: RegionRow[] = [];
  for (const reference of references) {
    const name = referenceName(reference);
    let text;
    try {
      text = reference.repo === null ? rowBody(reference.number) : rowBody(reference.number, reference.repo);
    } catch (error) {
      return { kind: "unread", why: `could not read row ${name}'s body (${messageOf(error).split("\n")[0]})` };
    }
    // `declaredRegionFiles` reads `origin/main`'s root files by default; an injected set spares a test that git call.
    const declared = declaredRegionFiles(text, rootFiles ? { rootFiles } : undefined);
    if (declared === null) return { kind: "no-section", row: name };
    // #1182: a row QUALIFIED to this tree's repository (`Closes owner/repo#N`) is that repository's row even when its body does not say so, so
    // its bare paths are that tree's. A sentence the body states wins over the qualifier, as #3083 pinned.
    const keyBare = tree.key !== "" && (statedRepository(text) ?? reference.repo) === tree.repo;
    for (const path of declared) union.add(keyBare && splitRegionEntry(path).key === "" ? `${tree.key}:${path}` : path);
    const repositories = new Set<string>();
    for (const entry of declared) {
      const repo = repositoryOfEntry(entry, text, code);
      if (repo !== undefined) repositories.add(repo);
    }
    rows.push({ reference, name, repositories: [...repositories] });
  }
  return { kind: "region", region: [...union], rows };
}

/** agent-org#923: one row the body closes, as its Region reads: the repositories its entries are read in, in no order. */
type RegionRow = { reference: import("./acceptance-commands.ts").ClosesReference; name: string; repositories: string[]; };

/**
 * agent-org#923: THE REPOSITORY A REGION ENTRY IS READ IN -- the one `regionRepository` and `readRegions` both ask. An entry whose key names one of the
 * project's code repositories is that repository's; a bare path is the row's stated repository, else the project's first. Undefined for a key the
 * project does not declare, which is no repository to read and so is skipped, not refused.
 * @param {string} entry @param {string} text the row's body @param {readonly { key: string, repo: string }[]} code
 * @returns {string | undefined}
 */
function repositoryOfEntry(entry: string, text: string, code: readonly { key: string; repo: string; }[]): string | undefined {
  const { key } = splitRegionEntry(entry);
  return key === "" ? (statedRepository(text) ?? code[0]?.repo) : code.find((candidate) => candidate.key === key)?.repo;
}

/**
 * #2617: a row as its body wrote it -- `#7`, or `owner/repo#7` when it named a repository.
 * @param {import("./acceptance-commands.ts").ClosesReference} reference
 * @returns {string}
 */
const referenceName = (reference: import("./acceptance-commands.ts").ClosesReference): string => `${reference.repo ?? ""}#${reference.number}`;

/**
 * #2617: WHICH DECLARED REPOSITORY THIS TREE IS, by `--repo` (the flag `gh pr` takes to name one), as its key -- the first repository's,
 * the empty key, when the flag is absent or names none the declaration lists. It is what makes a Region entry's prefix mean a tree.
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {readonly { key: string, repo: string }[]} [code] the project's code repositories; absent, the declaration's
 * @returns {string}
 */
function treeKeyOf(rest: string[], code: readonly { key: string; repo: string; }[] = homeProjectDeclaration().code): string {
  const repo = flagAfter(rest, "--repo");
  return code.find((entry) => entry.repo === repo)?.key ?? "";
}

/**
 * #3149: WHICH DECLARED REPOSITORY THIS CHECKOUT IS, said when `--repo` was not passed -- or "" when nothing needs saying. `treeKeyOf` reads
 * the flag only, so a session in another repository's worktree who left it off had that tree read as the first repository's and was refused
 * its own paths, in words that never named the flag; and followed the refusal's remedy (`Outside-Region:`) into false statements. The hint
 * is a line on the refusal, not an inference: `gh pr` picks its repository from the same remote, but WHICH TREE the Region is read against
 * stays a thing the caller says.
 * @param {string[]} rest @param {string} prRepo the repository the PR is read as opened in
 * @param {{ git: (args: string[]) => string, code?: readonly { key: string, repo: string }[] }} deps
 * @returns {string}
 */
function repoFlagHint(rest: string[], prRepo: string, { git, code = homeProjectDeclaration().code }: { git: (args: string[]) => string; code?: readonly { key: string; repo: string; }[]; }): string {
  if (flagAfter(rest, "--repo") !== null) return "";
  const remote = originRepoOf(git, code);
  if (remote === undefined || remote === prRepo) return "";
  return `\nThis checkout's origin is ${remote}, a repository of the project, and \`--repo\` was not passed, so these paths were read as ${prRepo}'s tree. `
    + `If the PR is for ${remote}, pass \`--repo ${remote}\` BEFORE writing any Outside-Region line (#3149).`;
}

/**
 * #3149/#4469: THE DECLARED REPOSITORY THIS CHECKOUT'S `origin` IS, or undefined when `origin` cannot be read or is no repository the project
 * declares. Shared by the `--repo` hint and by the bare `Closes #N` test, which must not fall back to the tracker for a PR opened from
 * another repository's checkout (lab#39: `Closes: #4305, #4372` accepted, #4372 shelved by B4 for 71 ticks).
 * @param {(args: string[]) => string} git @param {readonly { key: string, repo: string }[]} code the project's code repositories
 * @returns {string | undefined}
 */
function originRepoOf(git: (args: string[]) => string, code: readonly { key: string; repo: string; }[]): string | undefined {
  let remote;
  try {
    remote = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(git(["remote", "get-url", "origin"]))?.[1];
  } catch (error) {
    void error; // no origin to read is "cannot say", and the callers lose only a hint or a refusal they could not have made
    return undefined;
  }
  return code.some((entry) => entry.repo === remote) ? remote : undefined;
}

/**
 * THE REGION CHECK (#2417), pure over its seams: the row's body (`rowBody`, GitHub) and the diff (`git`, the local tree,
 * which #1344/#1446 already require to be the head being sent). `refusal` is the whole text to refuse with, `note` the
 * one line to print when nothing is refused. Both are null only when there is nothing to say: a body whose `Closes` is
 * missing or malformed, which `checkBody` refuses next in its own words.
 *
 * DECISIONS THE ROW MADE AND THE PR STATES: the row is the one `Closes #N` names (several: the union of their
 * Regions); `Closes: none` has no row and so no Region, and says so; a row that cannot be read REFUSES, because the
 * alternative is a check that passes exactly when GitHub is down.
 * @param {string} body
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {{ git?: (args: string[]) => string, rowBody: (number: number, repo?: string) => string, rootFiles?: Set<string>,
 *   code?: readonly { key: string, repo: string }[], openPulls?: (repo: string) => OpenPull[] | null }} deps `code` is the project's code
 *   repositories, for which one THIS tree is (`--repo`); `openPulls` is wired for `create` only, and OFF when absent (agent-org#923)
 * @returns {{ refusal: string | null, note: string | null }}
 */
export function checkRegion(body: string, rest: string[], { git = defaultGit, rowBody, rootFiles, code, openPulls }: {
        git?: (args: string[]) => string; rowBody: (number: number, repo?: string) => string; rootFiles?: Set<string>;
        code?: readonly { key: string; repo: string; }[]; openPulls?: (repo: string) => OpenPull[] | null;
    }): { refusal: string | null; note: string | null; } {
  const closes = extractClosesDeclaration(body);
  if (closes.kind === "none") {
    return { refusal: null, note: "REGION: not checked -- `Closes: none` names no row, so there is no Region to read." };
  }
  if (closes.kind !== "closes") return { refusal: null, note: null };
  const references = closesReferences(closes);
  const prRepo = flagAfter(rest, "--repo") ?? REPO;
  // #2995: a bare `Closes #N` in another repository's PR names THAT repository's issue. #4469: which repository that is falls back to the
  // checkout's `origin` when `--repo` is absent, FOR THIS TEST ONLY -- `prRepo` above still picks the tree, as it did (#3149 keeps it a thing the caller says).
  const bareRepo = flagAfter(rest, "--repo") ?? originRepoOf(git, code ?? homeProjectDeclaration().code) ?? REPO;
  const bare = bareRepo === REPO ? undefined : references.find((reference) => reference.repo === null);
  if (bare) return { refusal: `pr-open: REFUSED -- \`Closes #${bare.number}\` names an issue of ${bareRepo}, not a row of ${REPO}. Write \`Closes ${REPO}#${bare.number}\`. Nothing was sent (#2995).`, note: null };
  const rows = references.map(referenceName).join(", ");
  const treeKey = treeKeyOf(rest, code);
  const read = readRegions(references, { rowBody, rootFiles, tree: { key: treeKey, repo: prRepo }, code: code ?? homeProjectDeclaration().code });
  if (read.kind === "no-section") {
    return { refusal: null, note: `REGION: not checked -- row ${read.row} has no Region section to read.` };
  }
  if (read.kind === "unread") {
    return { refusal: `pr-open: REFUSED -- ${read.why}, so the diff cannot be checked against ${rows}'s Region. `
      + "Retry once GitHub answers. Nothing was sent to GitHub (#2417).", note: null };
  }
  // agent-org#923: the other half of a row that spans repositories is asked before the diff. Its refusal is about the row, not the diff.
  const otherHalf = openPulls ? otherHalfRefusal(read.rows, { prRepo, openPulls }) : null;
  if (otherHalf !== null) return { refusal: otherHalf, note: null };
  const base = `origin/${flagAfter(rest, "--base") ?? "main"}`;
  let changed: string[];
  try {
    changed = git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`]).split("\0").filter(Boolean);
  } catch (error) {
    return { refusal: `pr-open: REFUSED -- could not read the diff ${base}...HEAD (${messageOf(error).split("\n")[0]}), `
      + `so ${rows}'s Region cannot be checked. Nothing was sent to GitHub (#2417).`, note: null };
  }
  const { declared, malformed } = outsideRegionDeclarations(body);
  const standing = changed.map((file) => standingAgainstRegion(file, { region: read.region, declared, treeKey }));
  const outside = changed.filter((_file, index) => standing[index] === "outside");
  if (outside.length > 0) {
    const hint = repoFlagHint(rest, prRepo, { git, code });
    return { refusal: regionRefusalText({ rows, outside, region: read.region, base, malformed }) + hint, note: null };
  }
  return { refusal: null, note: regionPassLine({ rows, changed, standing, base }) };
}

/** agent-org#923: an open pull request, as the other half of a row reads it: its number and its body. */
export type OpenPull = { number: number; body: string; };

/**
 * agent-org#923: A `Closes` OF A ROW WHOSE REGION SPANS SEVERAL REPOSITORIES IS REFUSED while another repository's open pull request names that row,
 * because that half is still open: a11ign#4969 closed its row with the second half unmerged. Only `create` asks, and the refusal says what to write
 * instead (`Closes: none -- first half of <row>`). A repository whose open pull requests cannot be listed REFUSES too, as an unread row does: an
 * empty answer after a failed read would pass exactly when GitHub is down. Every repository of the Region but this tree's is asked.
 * @param {RegionRow[]} rows @param {{ prRepo: string, openPulls: (repo: string) => OpenPull[] | null }} deps
 * @returns {string | null}
 */
function otherHalfRefusal(rows: RegionRow[], { prRepo, openPulls }: { prRepo: string; openPulls: (repo: string) => OpenPull[] | null; }): string | null {
  for (const row of rows) {
    if (row.repositories.length < 2) continue;
    // Qualified in the refusal, because a bare `#N` in another repository's pull request reads as THAT repository's row.
    const key = `${row.reference.repo ?? REPO}#${row.reference.number}`;
    const spans = row.repositories.join(" and ");
    for (const repo of row.repositories) {
      if (repo === prRepo) continue;
      const pulls = openPulls(repo);
      if (pulls === null) {
        return `pr-open: REFUSED -- ${row.name}'s Region spans ${spans}, and the open pull requests of ${repo} could not be read, so whether that half is still open cannot be said. `
          + "Retry once GitHub answers. Nothing was sent to GitHub (agent-org#923).";
      }
      const holder = pulls.find((pull) => namesRow(pull, key, repo));
      if (holder !== undefined) {
        return `pr-open: REFUSED -- ${row.name}'s Region spans ${spans}, and ${repo}#${holder.number} is open and names ${key}, so a \`Closes\` of ${key} here `
          + `would close the row while that half is still open. Write \`Closes: none -- first half of ${key}\` in this pull request instead, and close the row `
          + "from the pull request that finishes its last half. Nothing was sent to GitHub (agent-org#923).";
      }
    }
  }
  return null;
}

/** agent-org#923: a `Refs` line of a pull request body, which names a row without closing it. */
const REFS_LINE = /^\s*Refs\b.*$/gm;

/**
 * agent-org#923: whether an open pull request NAMES the row `rowKey` (`owner/repo#N`): its `Closes` list, a `Closes: none` reason, or a `Refs` line. A
 * bare number is the pull request's own repository's, as GitHub reads it (`pullRepo`), so it names the row only from the row's repository.
 * @param {OpenPull} pull @param {string} rowKey @param {string} pullRepo the repository the pull request is open in
 * @returns {boolean}
 */
function namesRow(pull: OpenPull, rowKey: string, pullRepo: string): boolean {
  const declaration = extractClosesDeclaration(pull.body);
  const closed = declaration.kind === "closes" ? closesReferences(declaration) : declaration.kind === "none" ? referencesInReason(declaration.reason) : [];
  const referenced = [...pull.body.matchAll(REFS_LINE)].flatMap(([line]) => referencesInReason(line));
  return [...closed, ...referenced].some((reference) => `${reference.repo ?? pullRepo}#${reference.number}`.toLowerCase() === rowKey.toLowerCase());
}

/**
 * #3209: THE DIFF `mutationRecordReport` READS, taken from the local tree the way CI takes it from the merge commit:
 * the files the PR adds or changes (`ACMR`, a deletion leaves no test to owe a mutant; `--no-renames`, so a moved test
 * reads as delete + add and the add is kept, #939). Not the Region's read, which keeps deletions: a deleted file is
 * still a path the row did not name. #1344/#1446 already require this tree to be the head being sent.
 *
 * UNREADABLE IS `ok: false`, NEVER AN EMPTY LIST: `mutationRecordReport` turns that into a loud `UNCHECKED` that does
 * not refuse, because a git hiccup is not the author's to fix, while an empty list would read as "no test, nothing owed".
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {(args: string[]) => string} [git]
 * @returns {import("./acceptance-commands.ts").DiffReading}
 */
export function localDiffReading(rest: string[], git: (args: string[]) => string = defaultGit): import("./acceptance-commands.ts").DiffReading {
  const base = `origin/${flagAfter(rest, "--base") ?? "main"}`;
  try {
    const files = git(["diff", "--name-only", "--no-renames", "--diff-filter=ACMR", "-z", `${base}...HEAD`]);
    const added = git(["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", `${base}...HEAD`]);
    return { ok: true, files: files.split("\0").filter(Boolean), added: added.split("\0").filter(Boolean) };
  } catch (error) {
    return { ok: false, why: `git said: ${messageOf(error).split("\n")[0]}` };
  }
}

/**
 * #2307: what `packages/guards/src/mutation-check.mjs` means by each exit code, said as the line an author reads
 * beside the Acceptance result. Only `0` is not a warning -- and even that one says what it cannot know, because
 * the tool "observes a nonzero exit, not WHY": a mutation that broke the build reports the same red.
 * @param {string} command
 * @param {number} code
 * @returns {{ line: string, warned: boolean }}
 */
function mutationVerdict(command: string, code: number): { line: string; warned: boolean; } {
  const named = `\`${command}\``;
  if (code === 0) {
    return { warned: false, line: `MUTATION: ${named} -> the guard bites (exit 0). That means the suite went red, `
      + "not that it went red for the reason you mutated: read its output above." };
  }
  const because = {
    1: "THE GUARD DID NOT BITE (exit 1): the code was broken and the test still passed. Suspect the guard "
      + "before the code.",
    2: "mutate refused before mutating (exit 2), so this says nothing either way about the guard.",
    3: "THE RESTORE FAILED (exit 3): the file on disk is not what it was. Restore it by hand before "
      + "pushing anything.",
  }[code] ?? `exit ${code} is not one of mutate's four codes, so nothing was learned about the guard.`;
  return { warned: true, line: `MUTATION: WARNING -- ${named} -> ${because} Nothing is refused (ceo, #2305).` };
}

/**
 * #2307: RUN THE `Mutation:` COMMAND THE AUTHOR DECLARED, AND WARN WHEN THE GUARD DOES NOT BITE. Part b of `ceo`'s
 * 2026-09-24 ruling on #2305, after 11 of 46 first-review refusals were tests that pass without testing their claim.
 *
 * WARNING, NEVER REFUSAL -- the ruling, and the reason is `mutation-check.mjs`'s own stated limit: it sees a
 * nonzero exit and not WHY, so a refusal on its reading would be wrong often enough to teach authors to
 * `gh pr create` around this wrapper. `ok` is therefore not a field here.
 *
 * WHY THE CI JOB STILL DOES NOT RUN IT. `acceptance-commands.ts` scopes itself to `Acceptance:` because a
 * mutation edits a real file and a shared runner must not; here the file is the AUTHOR's, in the author's
 * tree, so that objection does not apply.
 *
 * ONLY `pnpm run mutate` LINES RUN. The template calls `Mutation:` a RECORD, so most of what sits under it is
 * prose, and the section reader hands back every line as a "command". Nothing else in that section is gated
 * the way `Acceptance:` is, so nothing else in it is executed. The author names the mutation, as `reviewer.md`
 * already asks the reviewer to; no mutant is generated here.
 * @param {string} body
 * @param {(command: string) => number} run
 * @returns {{ lines: string[], warned: boolean }}
 */
export function mutationReport(body: string, run: (command: string) => number): { lines: string[]; warned: boolean; } {
  const section = extractMutationSection(body);
  if (section.kind !== "commands") return { lines: [], warned: false };
  const verdicts = section.commands.filter((command) => MUTATE_COMMAND.test(command))
    .map((command) => mutationVerdict(command, run(command)));
  return { lines: verdicts.map((v) => v.line), warned: verdicts.some((v) => v.warned) };
}

const MUTATE_COMMAND = /^p?npm run mutate(?:\s|$)/;

/**
 * The body to check, read from the SAME flags `gh pr create`/`gh pr edit` themselves read -- never a
 * shape this wrapper invents. `null` when neither is given, which `main` treats as a hard refusal: a body
 * typed into `gh`'s own interactive editor cannot be checked synchronously before it is sent.
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function bodyFromArgs(args: readonly string[]): string | null {
  const bodyIndex = args.indexOf("--body");
  if (bodyIndex !== -1 && args[bodyIndex + 1] !== undefined) return args[bodyIndex + 1];
  const bodyFileIndex = args.indexOf("--body-file");
  if (bodyFileIndex !== -1 && args[bodyFileIndex + 1] !== undefined) {
    return readFileSync(args[bodyFileIndex + 1], "utf8");
  }
  return null;
}

function usage() {
  return "Usage:\n"
    + "  node packages/agent-org/src/pr-open.ts create <gh pr create args...>   (checks --body/--body-file first)\n"
    + "  node packages/agent-org/src/pr-open.ts edit <pr-number> <gh pr edit args...>   (same check, same refusal)\n";
}

/**
 * #1277: A FAILED `gh pr create` SAYS WHERE IT STOPPED, IN ONE LINE, LIKE EVERY OTHER REFUSAL HERE.
 *
 * Measured 2026-09-13 11:32Z, filing #1254 while the account's GraphQL budget was exhausted: the
 * acceptance ran and passed, `gh pr create` failed, and the failure arrived as a raw `execFileSync`
 * throw -- 29 lines, 9 of them stack frames, ending in a dump whose `stdout: null, stderr: null` reads
 * as "the command produced no output" when the output is four lines above it. The two useful lines were
 * there; they were buried in twenty-seven that were not, in a file whose three deliberate refusals are
 * each a single sentence naming the remedy.
 *
 * THE SPAWN'S OWN MESSAGE IS NOT SWALLOWED, and it is worth being exact about which message that is:
 * `execFileSync` throws with "Command failed: <argv>", naming WHICH command died. The CAUSE -- the
 * `GraphQL: API rate limit already exceeded` that tells an operator to wait rather than to edit -- is
 * `gh`'s own, written to stderr, which `stdio: "inherit"` has already put on screen one line above. So
 * the two together are the answer and neither alone is; dropping the argv would leave a run that spawns
 * more than one `gh` unable to say which failed.
 *
 * The branch and head are here because the retry needs them, and reconstructing which head the
 * acceptance passed against is the thing the stack does not say at all.
 *
 * @param {{ mode: string, branch: string, head: string, message: string }} at
 */
export function sendFailureLine({ mode, branch, head, message }: { mode: string; branch: string; head: string; message: string; }) {
  // ONE PHRASE, NOT A TEMPLATE WITH A HOLE. `Branch `detached at abc123` at `abc123`` prints the sha
  // twice and reads as a branch literally named "detached at ..." -- the first fix for the detached
  // case produced exactly that, which is why the whole clause is chosen rather than the field filled.
  const where = branch.startsWith("detached at ") ? `Detached at \`${head}\``
    : `Branch \`${branch}\` at \`${head}\``;
  return `pr-open: the body passed and the acceptance ran, but \`gh pr ${mode}\` FAILED -- nothing was `
    + `created. ${where}; retry the same command unchanged once the cause below is gone.`
    + `\n  ${message.split("\n")[0]}`;
}

/**
 * (#4898) A RATE-LIMITED CREATE IS HELD, NOT FAILED, and the steps after it travel with it. The arm and the label name the branch (`--head`, or
 * the tree's own), not a PR number, so they can be written down before the PR exists and made by the gate once the create has been.
 * @param {string} mode @param {string[]} rest
 * @param {{ owner: string | null, labelExists?: (name: string, repo?: string) => boolean, branch: string | null }} deps
 * @returns {string[][]} the label's own `gh` argv, preceded by the label's creation when the repository is known not to have it
 */
function labelStepsAfterCreate(mode: string, rest: string[], { owner, labelExists, branch }: { owner: string | null; labelExists?: (name: string, repo?: string) => boolean; branch: string | null; }): string[][] {
  const steps: string[][] = [];
  for (const args of labelAfterCreate(mode, rest, owner, branch)) {
    const name = args[args.length - 1];
    const repo = flagAfter(args, "--repo"); // the same repository `ensureLabel` asks and creates in
    if (labelExists !== undefined && !labelExists(name, ...(repo === null ? [] : [repo]))) {
      steps.push(["label", "create", name, "--description", "The session that owns the pull request (pr:open)", ...(repo === null ? [] : ["--repo", repo])]);
    }
    steps.push(args);
  }
  return steps;
}

/** @returns {string | null} what went wrong attaching `steps` to the held call, or null when they are attached (or there was none to attach) */
function attachSteps(steps: string[][], { entry, attach }: { entry: { dir: string; id: string; } | null; attach: typeof attachFollowUps; }): string | null {
  if (steps.length === 0) return null;
  if (entry === null) return "the entry the wrapper held could not be found, so the arm and the label were NOT attached";
  try {
    attach(entry, steps);
    return null;
  } catch (error) {
    return `the arm and the label could not be attached (${messageOf(error)})`;
  }
}

/**
 * The line a held call ends the turn with. It says WHAT is true (nothing was sent, the gate makes it, and when), WHAT NOT TO DO (rerun it,
 * ask a human), and, when the follow-ups could not travel with it, the one thing a person must still do.
 * @param {{ mode: string, branch: string, head: string, entry: { id: string, resetAt: number } | null, attached: string | null }} at
 */
function heldLine({ mode, branch, head, entry, attached, arm }: { mode: string; branch: string; head: string; entry: { id: string; resetAt: number; } | null; attached: string | null; arm: boolean; }): string {
  const where = branch.startsWith("detached at ") ? `Detached at \`${head}\`` : `Branch \`${branch}\` at \`${head}\``;
  const when = entry === null ? "after the reset" : `as ${entry.id} after ${new Date(entry.resetAt * 1000).toISOString().slice(11, 19)}Z`;
  const follows = mode === "create" && arm ? " The arm and the session label are held with it and made right after." : "";
  const unattached = attached === null ? "" : `\n  NOT ATTACHED: ${attached}; once the PR exists, arm and label it by hand.`;
  return `pr-open: QUEUED, NOT FAILED -- GitHub is rate-limiting this account, so \`gh pr ${mode}\` was NOT sent; the gate holds it and makes it ${when}.${follows} `
    + `${where}. Do NOT rerun pr-open (that is a second copy) and do not ask a human: the work is finished, and the turn may end.${unattached}\n`;
}

/**
 * #1479: THE WRITE LANDED AND THE STEP AFTER IT FAILED, said as a partial success. `gh pr create` had already
 * made the PR when the arm threw, and the throw escaped `main`, so Node exited 1: the code this script sets
 * when NOTHING was sent. A caller reading 1 retries the create against a PR that exists. So the line names
 * the branch whose PR exists and the one step to re-run, never the whole command.
 * @param {{ mode: string, branch: string, head: string, step: string[], message: string }} at
 */
function landedThenFailedLine({ mode, branch, head, step, message }: { mode: string; branch: string; head: string; step: string[]; message: string; }) {
  const command = `gh ${step.join(" ")}`;
  return `pr-open: \`gh pr ${mode}\` LANDED -- the PR for \`${branch}\` at \`${head}\` exists -- but the step after `
    + `it, \`${command}\`, FAILED. Do not re-run pr-open, which would send the ${mode} again; run only `
    + `\`${command}\` once the cause below is gone.\n  ${message.split("\n")[0]}`;
}

/**
 * #2929: SAID AT THE MOMENT OF OPENING, because that is the only place every author is certain to be reading. A recap
 * ended "PR #2925 is open with its test passing" while `acceptance / run` and `gate` were red on that head: the author
 * had run a subset locally and the claim "passing" was that subset wearing CI's name. The author's turn cannot be held
 * open to wait for the checks, so the wording is fixed here, before the turn ends. It carries no judgment and changes
 * no exit code.
 * @param {{ head: string }} at the short head that was opened
 * @returns {string}
 */
export function ciPendingLine({ head }: { head: string; }): string {
  return `pr-open: opened \`${head}\` -- CI has NOT run on it. If a check goes red the gate wakes you with the result; `
    + `until then your recap must say \`opened, CI pending on ${head}\` and never "passing" until the checks on that head `
    + `are green. A local run of a subset (a test file, \`test:changed\`) is reported as that subset, not as passing.\n`;
}

/** @param {unknown} error */
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The branch, or `detached at <sha>` when there is none. `git rev-parse --abbrev-ref HEAD` returns the
 * literal string `HEAD` on a detached checkout, so the line named a branch that does not exist and told
 * the reader to retry from it. **`gh pr create` fails on a detached HEAD by construction**, so the one
 * shape where this message is guaranteed to be read is the shape where that field was wrong.
 * @param {(args: string[], fallback: string) => string} fact
 */
function branchName(fact: (args: string[], fallback: string) => string) {
  const name = fact(["rev-parse", "--abbrev-ref", "HEAD"], "(unknown)");
  return name === "HEAD" ? `detached at ${fact(["rev-parse", "--short", "HEAD"], "(unknown)")}` : name;
}

/**
 * The spawn, with its deps injected so the failure path has a test. `head` and `branch` are read only
 * when something has already gone wrong, so the happy path pays nothing for them.
 * @param {string} mode
 * @param {string[]} rest
 * `arm` false (a ticket-mode run, which never merges) sends the create and nothing after it: no arm, and no label where `owner` names none.
 * @param {{ run?: (args: string[]) => void, git?: (args: string[]) => string,
 *           err?: (line: string) => void, owner?: () => string | null, labelExists?: (name: string, repo?: string) => boolean, arm?: boolean }} [deps]
 * @returns {number} the header's exit code: 0, EXIT_NOTHING_SENT, or EXIT_LANDED_THEN_FAILED
 */
export function sendToGitHub(mode: string, rest: string[],
  { run = defaultGh, git = defaultGit, err = writeErr, owner = ownerOfTree, labelExists, queued = readQueuedEntry, attach = attachFollowUps, arm = true }: {
      run?: (args: string[]) => void; git?: (args: string[]) => string;
      err?: (line: string) => void; owner?: () => string | null; labelExists?: (name: string, repo?: string) => boolean;
      queued?: () => { dir: string; id: string; resetAt: number; } | null; attach?: typeof attachFollowUps; arm?: boolean;
  } = {}): number {
  // AN ERROR HANDLER THAT CAN ITSELF ERROR IS THE ONE PLACE A THROW COSTS THE MOST (worker-capture,
  // #1283). Both reads sat here unguarded, so a failing `git` -- a GIT_DIR pointing elsewhere, a stale
  // gitdir file, the CLI run from outside the checkout -- replaced this message with a raw throw that
  // carries git's error and LOSES gh's cause entirely. Worse than the 24-line dump it replaced, which
  // at least contained the answer.
  const fact: (args: string[], fallback: string) => string = (args, fallback): string => { try { return git(args) || fallback; } catch { return fallback; } };
  const head = () => fact(["rev-parse", "--short", "HEAD"], "(unknown)");
  const head8 = () => fact(["rev-parse", "--short=8", "HEAD"], "(unknown)");
  // Read ONCE per create, and only after the create has been attempted: the arm and the label must name the same branch even
  // if the checkout moves mid-call, and no other mode pays a git read it never uses.
  let branchRead: { value: string | null } | null = null;
  const branch = (): string | null => {
    if (mode !== "create") return null;
    if (branchRead === null) { const b = fact(["rev-parse", "--abbrev-ref", "HEAD"], ""); branchRead = { value: b === "" || b === "HEAD" ? null : b }; }
    return branchRead.value;
  };
  try {
    run(["pr", mode, ...rest]);
  } catch (error) {
    if ((error as { status?: number })?.status === EXIT_QUEUED) {
      const steps = mode === "create" ? [...(arm ? armAfterCreate(mode, rest, branch()) : []), ...labelStepsAfterCreate(mode, rest, { owner: owner(), labelExists, branch: branch() })] : [];
      const entry = queued(); // read once: reading it consumes the file the wrapper left
      err(heldLine({ mode, branch: branchName(fact), head: head(), entry, attached: attachSteps(steps, { entry, attach }), arm }));
      return EXIT_QUEUED;
    }
    err(`${sendFailureLine({ mode, branch: branchName(fact), head: head(), message: messageOf(error) })}\n`);
    return EXIT_NOTHING_SENT;
  }
  // `armAfterCreate` returns a WHOLE `gh` argv (`["pr", "merge", ...]`) and `run` is `gh` with its args as
  // given -- `args.slice(1)` stripped `pr` and spawned `gh merge`, an unknown command, after every ready
  // create since #1277, so the wrapper exited 1 on a PR that already existed.
  for (const args of arm ? armAfterCreate(mode, rest, branch()) : []) {
    // #1479: the create has LANDED by here, so a failure is a partial success with its own code.
    try {
      run(args);
    } catch (error) {
      err(`${landedThenFailedLine({ mode, branch: branchName(fact), head: head(),
        step: args, message: messageOf(error) })}\n`);
      return EXIT_LANDED_THEN_FAILED;
    }
  }
  labelCreatedPr(mode, rest, { run, err, owner: owner(), labelExists, branch: branch() });
  // #2929: only a create that LANDED and was armed -- the failed create and the failed arm returned above with their
  // own line, and this one never stands in for either. Last, so it is the line still on screen when the turn ends.
  if (mode === "create") err(ciPendingLine({ head: head8() }));
  return 0;
}

/**
 * The owner label after a create, moved out of `sendToGitHub` unchanged but for `ensureLabel`.
 *
 * WARNED, NEVER EXIT 3, AND THAT ASYMMETRY IS THE POINT. An arm that fails leaves a PR that will not
 * merge -- a caller must know. A label that fails leaves a PR that is merely unroutable, which is the
 * state every PR was in before this existed; turning that into EXIT_LANDED_THEN_FAILED would make an
 * author retry, or worse hand-fix, a create that entirely succeeded. The line still prints, because a
 * silently unlabelled PR is how this defect survived 20 merges unnoticed.
 * @param {string} mode
 * @param {string[]} rest
 * @param {{ run: (args: string[]) => void, err: (line: string) => void, owner: string | null,
 *           labelExists?: (name: string, repo?: string) => boolean, branch: string | null }} deps
 */
function labelCreatedPr(mode: string, rest: string[], { run, err, owner, labelExists, branch }: {
        run: (args: string[]) => void; err: (line: string) => void; owner: string | null;
        labelExists?: (name: string, repo?: string) => boolean; branch: string | null;
    }) {
  for (const args of labelAfterCreate(mode, rest, owner, branch)) {
    try {
      ensureLabel(args[args.length - 1], { run, labelExists, repo: flagAfter(args, "--repo") });
      run(args);
    } catch (error) {
      err(`pr-open: the PR was created but labelling it failed -- ${messageOf(error)}\n`
        + `  It carries no \`${SESSION_PREFIX}*\` label, so a red check on it wakes product-manager rather than its `
        + `author. Apply it by hand: \`gh pr edit <n> --add-label ${args[args.length - 1]}\`.\n`);
    }
  }
}

/**
 * #3639: `gh pr edit --add-label X` of a label the repository does not have is "not found" (read on
 * `session:worker-3510` in agent-org, 2026-10-05), and agent-org has none of the product repository's labels until
 * somebody makes them. So the label is MADE here when GitHub says it is absent. A failure to ask, or to create,
 * propagates to `labelCreatedPr`'s warning rather than being swallowed: the same outage as the missing label.
 * OFF when `labelExists` is not wired, like `rowBody`: the tests call `main` directly and must not reach `gh`.
 * @param {string} name
 * @param {{ run: (args: string[]) => void, labelExists?: (name: string, repo?: string) => boolean }} deps
 */
function ensureLabel(name: string, { run, labelExists, repo = null }: { run: (args: string[]) => void; labelExists?: (name: string, repo?: string) => boolean; repo?: string | null; }) {
  if (labelExists === undefined || labelExists(name, ...(repo === null ? [] : [repo]))) return;
  run(["label", "create", name, "--description", "The session that owns the pull request (pr:open)", ...(repo === null ? [] : ["--repo", repo])]);
}

/**
 * #3639: THE ROW A PULL REQUEST NAMES CARRIES ITS OWNER, for a tree nobody stamped.
 *
 * `.a11y-owner` is written by `row-claim` into the product repository's trees (260 of 278 stamped, measured
 * 2026-10-05) and by nobody into agent-org's, which are made by hand with `git worktree add` (5 of 207). The
 * fact is written down elsewhere, though: the PR's `Closes` line (or its title) names the row, and the row
 * carries `session:<owner>`. This reads it.
 *
 * NOTHING IS INVENTED, the same ruling as `labelAfterCreate`'s. The result is one owner or null: no row named, a row
 * with no `session:` label, or the rows between them naming two different sessions all yield null, because the wrong
 * session woken for a red check is worse than the unlabelled PR that already costs `product-manager` a turn.
 *
 * @param {string} body
 * @param {string[]} rest the args handed to `gh pr create`; `--title` is read
 * @param {(number: number, repo: string) => string[]} rowLabels the labels of one row; a throw is the caller's
 * @returns {string | null}
 */
export function rowOwnerLabel(body: string, rest: string[], rowLabels: (number: number, repo: string) => string[]): string | null {
  const owners = new Set<string>();
  for (const { repo, number } of rowsNamed(body, rest)) {
    for (const label of rowLabels(number, repo)) {
      if (label.startsWith(SESSION_PREFIX)) owners.add(label.slice(SESSION_PREFIX.length));
    }
  }
  return owners.size === 1 ? [...owners][0] : null;
}

/**
 * Every row the body's `Closes` line or the title's `owner/repo#N` names, once each. A bare `#N` is the default tracker's,
 * as in `readRegions`: a pull request in agent-org closes a row in the tracker, never an agent-org issue.
 * @param {string} body @param {string[]} rest
 * @returns {{ repo: string, number: number }[]}
 */
function rowsNamed(body: string, rest: string[]): { repo: string; number: number; }[] {
  const declaration = extractClosesDeclaration(body);
  const closed = declaration.kind === "closes" ? closesReferences(declaration) : [];
  const title = flagAfter(rest, "--title") ?? flagAfter(rest, "-t") ?? "";
  const titled = [...title.matchAll(/([\w.-]+\/[\w.-]+)#(\d+)/g)].map((m) => ({ repo: m[1], number: Number(m[2]) }));
  const all = [...closed.map((r) => ({ repo: r.repo ?? REPO, number: r.number })), ...titled];
  return all.filter((row, i) => all.findIndex((o) => o.repo === row.repo && o.number === row.number) === i);
}

/**
 * The owner `sendToGitHub` labels with: the tree's stamp when there is one (unchanged), else the named row's. Reading the
 * row costs an API call, so it is asked only of a tree with no stamp and only for a create, and a failure to read it is
 * PRINTED and leaves the PR unlabelled -- as it was before this -- rather than guessing from the rows that did answer.
 * @param {{ owner?: () => string | null, rowLabels?: (number: number, repo: string) => string[] }} deps
 * @param {{ mode: string, body: string, rest: string[], err: (line: string) => void }} pr
 * @returns {() => string | null}
 */
export function ownerOfPr({ owner = ownerOfTree, rowLabels }: { owner?: () => string | null; rowLabels?: (number: number, repo: string) => string[]; }, { mode, body, rest, err }: { mode: string; body: string; rest: string[]; err: (line: string) => void; }): () => string | null {
  return () => {
    const stamped = owner();
    if (stamped !== null || mode !== "create" || rowLabels === undefined) return stamped;
    try {
      return rowOwnerLabel(body, rest, rowLabels);
    } catch (error) {
      err(`pr-open: the tree has no ${SESSION_PREFIX}* stamp and the row it names could not be read -- ${messageOf(error)}\n`);
      return null;
    }
  };
}

/**
 * The session that stamped the tree this is running in, or null. Separated from `labelAfterCreate` so that
 * function stays pure and testable without a filesystem -- the same split `armAfterCreate` has.
 * @returns {string | null}
 */
function ownerOfTree(): string | null {
  try {
    return worktreeOwner(process.cwd());
  } catch {
    return null;
  }
}

/** `err` returns nothing, so a caller collecting lines cannot accidentally satisfy it with a length.
 * @param {string} line */
const writeErr = (line: string) => { process.stderr.write(line); };
/** @param {string} line */
const writeOut = (line: string) => { process.stdout.write(line); };

/** @param {string[]} args */
export const PR_OPEN_ENV = "A11Y_PR_OPEN";
/**
 * `host/gh` refuses `gh pr create` unless this variable is set (#4397), so the one create that may pass is this tool's. It is set on the `gh`
 * child alone: the row's Acceptance command runs from `process.env`, which never carries it.
 * @param {string[]} args
 */
export const defaultGh = (args: string[]) => {
  rmSync(QUEUED_TO, { force: true });
  execFileSync("gh", args, { stdio: "inherit", env: { ...process.env, [PR_OPEN_ENV]: "1", A11Y_GH_QUEUED_TO: QUEUED_TO } });
};
/** (#4898) WHERE `host/gh` LEAVES THE QUEUE ENTRY IT HELD: `<queue dir> TAB <id> TAB <reset epoch>`, written only for a call it queued. */
const QUEUED_TO = join(tmpdir(), `pr-open-queued-${process.pid}`);
/** @returns {{ dir: string, id: string, resetAt: number } | null} the entry the last `gh` call was held as, or null when none was (or an older wrapper left no file) */
export function readQueuedEntry(path: string = QUEUED_TO): { dir: string; id: string; resetAt: number; } | null {
  try {
    const text = readFileSync(path, "utf8");
    rmSync(path, { force: true }); // consumed: it is a per-process note, not a record, and the next call must not read this one's
    const [dir, id, resetAt] = text.trim().split("\t");
    return dir && id && Number.isFinite(Number(resetAt)) ? { dir, id, resetAt: Number(resetAt) } : null;
  } catch {
    return null; // no file is "not held", which the caller words; there is nothing to guess at
  }
}
/**
 * PR N's head, over REST (`gh api`, the core pool) rather than `gh pr view --json` (GraphQL, the pool that runs out).
 * @param {string} repo
 * @param {string} number
 * @returns {{ ref: string, oid: string } | null}
 */
const defaultPrHead = (repo: string, number: string): { ref: string; oid: string; } | null => JSON.parse(execFileSync("gh",
  ["api", `repos/${repo}/pulls/${number}`, "--jq", "{ref: .head.ref, oid: .head.sha}"], { encoding: "utf8" }));
/**
 * Row N's body, over REST like `defaultPrHead` (the core pool, not the GraphQL one that runs out), as the caller. It is
 * a sibling of `run` and not a use of it: `run` is `stdio: "inherit"` and returns nothing, so it cannot hand a body back.
 * #2617: from `repo` when the body's `Closes` named one, else the default tracker.
 * @param {number} number
 * @param {string} [repo]
 * @returns {string}
 */
const defaultRowBody = (number: number, repo: string = REPO): string =>
  execFileSync("gh", ["api", `repos/${repo}/issues/${number}`, "--jq", ".body"], { encoding: "utf8" });
/**
 * #3639: a row's labels over REST like `defaultRowBody`. `repo` is always qualified by `rowOwnerLabel`'s caller.
 * @param {number} number @param {string} repo
 * @returns {string[]}
 */
const defaultRowLabels = (number: number, repo: string): string[] => JSON.parse(execFileSync("gh",
  ["api", `repos/${repo}/issues/${number}`, "--jq", "[.labels[].name]"], { encoding: "utf8" }));
/**
 * #3639: whether THIS repository has the label, over REST. A 404 is "no"; anything else THROWS, because "could not ask" and
 * "absent" are different states and creating a label on the strength of the second would hide an auth or network fault.
 * @param {string} name
 * @returns {boolean}
 */
function defaultLabelExists(name: string, repo: string = "{owner}/{repo}"): boolean {
  try {
    execFileSync("gh", ["api", `repos/${repo}/labels/${encodeURIComponent(name)}`, "--silent"], { stdio: "pipe" });
    return true;
  } catch (error) {
    if (/HTTP 404|Not Found/i.test(`${(error as {stderr?: unknown}).stderr ?? ""}`)) return false;
    throw error;
  }
}
/** #3215: the stamp of the tree `pr-open` runs from, read against the body being sent. @param {string} body */
const defaultVerifyStamp = (body: string) => readVerifyStamp({ dir: defaultGit(["rev-parse", "--show-toplevel"]), body });
/** `sandboxGitEnv()` CALLED: git exports GIT_DIR into every hook environment. @param {string[]} args */
const defaultGit = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() }).trim();

/**
 * #2307's mutation report, printed for a body that will be SENT. Its own function only to keep `main` under the
 * complexity ceiling the #2939 declaration check pushed it past.
 * @param {string} body @param {(command: string) => number} runMutation @param {(line: string) => void} out
 */
function printMutationReport(body: string, runMutation: (command: string) => number, out: (line: string) => void) {
  for (const line of mutationReport(body, runMutation).lines) out(`${line}\n`);
}

/**
 * ADR 0044: A PULL REQUEST ADDS ITS ACCEPTANCE FILE, AND `pr-open` IS WHERE THE AUTHOR LEARNS IT IS MISSING. CI reads the Acceptance from the file
 * the pull request adds under `.acceptance/`; a diff that adds none is refused there (the body is read only for Dependabot, agent-org#519, and
 * a `pr:open` author is never that), so it is refused here with the file's exact name. WHEN THE BODY ALREADY CARRIES AN `Acceptance:` it WRITES that file, because the file's grammar is the body's own:
 * the same parser reads either, so the text moves unchanged and nothing is re-derived. It does not commit: the file must be in the head
 * the reviewer reads, and committing for the author is a decision about their history. An unreadable diff is not accused (`checkBody` says
 * `UNCHECKED` for it), and `null` is "go on". OFF when no `write` is wired, which is every direct caller of `main` and none of the shipped CLI
 * (the entry block passes `writeAcceptanceFile`, as `regionStep` is placed): a test's `git` seam answers one list for every diff, and a refusal
 * inside `main` would have refused the forty tests that never named a file.
 * @param {string} body @param {string[]} rest
 * @param {{ git?: (args: string[]) => string, write?: (path: string, text: string) => void, err: (line: string) => void }} io
 * @returns {number | null}
 */
function acceptanceFileStep(body: string, rest: string[], { git, write, err }: {
    git?: (args: string[]) => string; write?: (path: string, text: string) => void; err: (line: string) => void;
  }): number | null {
  if (!write) return null;
  const diff = localDiffReading(rest, git);
  if (!diff.ok || (diff.added ?? []).some(isAcceptancePath)) return null;
  const path = acceptanceFileForBranch(flagAfter(rest, "--head") ?? (git ?? defaultGit)(["rev-parse", "--abbrev-ref", "HEAD"]).trim());
  const declared = extractAcceptanceSection(body).kind;
  const carries = declared === "commands" || declared === "none";
  if (carries) write(path, body);
  err(`pr-open: REFUSED -- the diff adds no file under ${ACCEPTANCE_DIR}, and CI reads the Acceptance from the file a pull request adds `
    + `(ADR 0044). ${carries ? `Wrote ${path} from the body's own sections; \`git add\` it, commit and push, then run pr-open again`
      : `Create ${path} with the \`Acceptance:\` section (and \`Refutation\`/\`Mutation\` if you have them), commit and push, then run pr-open again`}. `
    + "`Closes` stays in the body. Nothing was sent.\n");
  return EXIT_NOTHING_SENT;
}

/**
 * #2417: `checkRegion` in `main`'s terms: prints its note, or its refusal, and returns the exit code only for a refusal.
 * OFF when no `rowBody` is wired, which is every direct caller of `main` and none of the shipped CLI: the entry block
 * passes the real reader (#1352's `launchGate` is placed the same way, and `pr-open-region.test.ts` pins the wiring).
 * @param {string} body
 * @param {string[]} rest
 * @param {{ git?: (args: string[]) => string, rowBody?: (number: number, repo?: string) => string, rootFiles?: Set<string>,
 *           code?: readonly { key: string, repo: string }[], out: (line: string) => void, err: (line: string) => void }} deps
 * @returns {number | null} EXIT_NOTHING_SENT for a refusal, else null
 */
function regionStep(body: string, rest: string[], { git, rowBody, rootFiles, code, openPulls, out, err }: {
        git?: (args: string[]) => string; rowBody?: (number: number, repo?: string) => string; rootFiles?: Set<string>;
        code?: readonly { key: string; repo: string; }[]; openPulls?: (repo: string) => OpenPull[] | null;
        out: (line: string) => void; err: (line: string) => void;
    }): number | null {
  if (!rowBody) return null;
  const region = checkRegion(body, rest, { git, rowBody, rootFiles, code, openPulls });
  if (region.refusal) {
    err(`${region.refusal}\n`);
    return EXIT_NOTHING_SENT;
  }
  if (region.note) out(`${region.note}\n`);
  return null;
}

/**
 * agent-org#744: A PULL REQUEST ON A CLAIMED ROW'S BRANCH CANNOT DECLARE `Closes: none`, AND THE AUTHOR IS TOLD HERE. `closes-mismatch-check.ts`
 * refuses it in CI, after the pull request exists and after the worker has moved on; three rows (agent-org#475 and #560, a11ign#4874) stayed
 * open with a worker holding the claim because the refusal was never reached for a pull request in another tracker. This is the same
 * comparison (`claimedBranchReport`, the head ref against every declared tracker's `Claimed-branch:` records), run before anything is sent.
 *
 * ONLY A MATCH REFUSES. A tracker that cannot be read is printed as `UNCHECKED` and goes on: CI asks again, and a GitHub blip must not stop
 * a pull request that finishes no row. A body that is not `Closes: none` is not asked (no read is made for it), and so is a pull request on
 * a branch no claim names, which passes with `Closes: none -- <reason>` as before. OFF when no `claimedRows` is wired, which is every direct
 * caller of `main` and none of the shipped CLI (the entry block wires it, as `regionStep`'s `rowBody` is).
 * @param {string} body @param {string[]} rest
 * @param {{ git?: (args: string[]) => string, code?: readonly { key: string, repo: string }[],
 *           claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null, out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number | null} EXIT_NOTHING_SENT for a refusal, else null
 */
function claimedRowStep(body: string, rest: string[], { git = defaultGit, code, claimedRows, out, err }: {
        git?: (args: string[]) => string; code?: readonly { key: string; repo: string; }[];
        claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null; out: (line: string) => void; err: (line: string) => void;
    }): number | null {
  if (!claimedRows) return null;
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind !== "none") return null;
  let branch = flagAfter(rest, "--head");
  if (branch === null) {
    try {
      branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    } catch (error) {
      void error; // an unreadable branch is "could not tell", reported by the report below
    }
  }
  const head = branch ? { branch, fork: false } : null;
  const prRepo = flagAfter(rest, "--repo") ?? originRepoOf(git, code ?? homeProjectDeclaration().code) ?? REPO;
  const report = claimedBranchReport(declaration, head, claimedRows(prRepo), prRepo);
  if (report.ok === null) {
    out(`pr-open: UNCHECKED -- the claimed-row comparison for \`Closes: none\` was skipped: ${report.reason}. CI asks again.\n`);
    return null;
  }
  if (report.ok) return null;
  err(`pr-open: REFUSED -- a claimed row's own pull request cannot declare \`Closes: none\`, because the merge is what closes the row:\n`
    + `${report.reasons.map((reason) => `  ${reason}`).join("\n")}\nNothing was sent (agent-org#744).\n`);
  return EXIT_NOTHING_SENT;
}

/**
 * #3215: A READY pull request is opened only on a green verify stamp for this head and this body; a DRAFT opens without one, because it is
 * where CI starts and work is shared, and refusing it would put the cost on the one step that cannot be re-run cheaply. `edit` opens nothing.
 * A project that declares no verify script is not refused, and the line says so by name (`verify-stamp.ts`). WIRED IN THE ENTRY BLOCK like
 * `rowBody`: the tests call `main` directly, and in CI's plain clone a refusal inside it would refuse them. `null` is "go on".
 * @param {string} mode @param {string[]} rest @param {string} body
 * @param {{ verifyStamp?: (body: string) => import("./verify-stamp.ts").VerifyReading, out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number | null}
 */
function verifyStampStep(mode: string, rest: string[], body: string, { verifyStamp, out, err }: { verifyStamp?: (body: string) => import("./verify-stamp.ts").VerifyReading; out: (line: string) => void; err: (line: string) => void; }): number | null {
  if (mode !== "create" || rest.includes("--draft") || !verifyStamp) return null;
  const reading = verifyStamp(body);
  if (reading.state === VERIFY_STATE.NO_VERIFY) {
    out(`pr-open: no verify declared for ${reading.project} -- a ready pull request is not checked against a verify stamp here.\n`);
    return null;
  }
  if (reading.state === VERIFY_STATE.GREEN) return null;
  err(`${verifyRefusalLine(reading, { bodyFile: flagAfter(rest, "--body-file") })}\n`);
  return EXIT_NOTHING_SENT;
}

/**
 * The CLI, returning the header's exit code, with every spawn injectable so the path that matters most, a
 * write that landed and a step after it that failed, is driven end to end (#1479).
 * @param {string[]} [argv]
 * @param {{ run?: (args: string[]) => void, git?: (args: string[]) => string,
 *           prHead?: (repo: string, number: string) => { ref: string, oid: string } | null,
 *           runAcceptance?: (command: string) => number, runMutation?: (command: string) => number,
 *           owner?: () => string | null, rowBody?: (number: number, repo?: string) => string, rootFiles?: Set<string>,
 *           rowLabels?: (number: number, repo: string) => string[], labelExists?: (name: string, repo?: string) => boolean,
 *           claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null,
 *           code?: readonly { key: string, repo: string }[], login?: () => string, lanes?: {lanes: import("./lane-ownership.ts").Lane[]} | null,
 *           verifyStamp?: (body: string) => import("./verify-stamp.ts").VerifyReading, write?: (path: string, text: string) => void,
 *           readFile?: (path: string) => string, branchHead?: (repo: string, branch: string) => string | null,
 *           out?: (line: string) => void, err?: (line: string) => void }} [deps]
 * @returns {number}
 */
export function main(argv: string[] = process.argv.slice(2),
  { run, git, prHead, runAcceptance, runMutation = runForReal, owner, rowBody, rowLabels, labelExists, rootFiles, code, login, lanes,
    claimedRows, verifyStamp, write, readFile, branchHead, openPulls, ticket, out = writeOut, err = writeErr }: {
          run?: (args: string[]) => void; git?: (args: string[]) => string;
          prHead?: (repo: string, number: string) => { ref: string; oid: string; } | null;
          runAcceptance?: (command: string) => number; runMutation?: (command: string) => number;
          owner?: () => string | null; rowBody?: (number: number, repo?: string) => string; rootFiles?: Set<string>;
          rowLabels?: (number: number, repo: string) => string[]; labelExists?: (name: string, repo?: string) => boolean;
          claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null;
          code?: readonly { key: string; repo: string; }[]; login?: () => string; lanes?: { lanes: import("./lane-ownership.ts").Lane[]; } | null;
          verifyStamp?: (body: string) => import("./verify-stamp.ts").VerifyReading; write?: (path: string, text: string) => void;
          readFile?: (path: string) => string; branchHead?: (repo: string, branch: string) => string | null;
          openPulls?: (repo: string) => OpenPull[] | null;
          /** A ticket-mode run's facts (A11-74): its checks read the ticket, and the row's reads (`rowBody`, `claimedRows`, `rowLabels`, `openPulls`) do not run. */
          ticket?: TicketContext;
          out?: (line: string) => void; err?: (line: string) => void;
      } = {}): number {
  const [mode, ...given] = argv;
  if (mode !== "create" && mode !== "edit") {
    err(usage());
    return EXIT_USAGE;
  }
  const body = bodyFromArgs(given);
  if (body === null) {
    err(`pr-open ${mode}: --body or --body-file is required -- this wrapper checks the `
      + "body before gh sends it, and cannot check a body it was never given. Use `gh pr " + mode
      + "` directly, unguarded, for an interactive editor session.\n");
    return EXIT_USAGE;
  }
  // agent-org#753: a row whose Region names another repository opens its pull request THERE, so the branch is asked of that repository.
  const crossRepo = otherRepositoryOf(mode, given, body, { git, rowBody, rootFiles, code, branchHead });
  const rest = crossRepo !== null && flagAfter(given, "--repo") === null ? [...given, "--repo", crossRepo] : given;
  // #1344: BEFORE checkBody, because checkBody RUNS the Acceptance -- in this working tree, whatever --head says.
  // #2939: and a `Hand-fix:` line the ledger could not read, which it would silently not count. Pure, like the heads.
  const headRefused = headTreeRefusal(mode, rest, { git, crossRepo, branchHead }) ?? editTreeRefusal(mode, rest, { git, prHead })
    ?? declarationRefusal(body) ?? (ticket === undefined ? draftRefusal(mode, rest, body) : null) ?? authorshipRefusal(mode, rest, { git, login, lanes })
    ?? machineryRefusal(localDiffReading(rest, git), body); // a11ign#5100: after the cheap pure refusals, so the diff is read only for a body that survived them
  if (headRefused) {
    err(`${headRefused}\n`);
    return EXIT_NOTHING_SENT;
  }
  const noFile = acceptanceFileStep(body, rest, { git, write, err });
  if (noFile !== null) return noFile;
  const beforeBody = beforeBodyCheck(mode, rest, body, { ticket, git, rootFiles, rowBody, code, openPulls, claimedRows, out, err });
  if (beforeBody !== null) return beforeBody;
  const result = checkBody(body, { run: runAcceptance, diff: localDiffReading(rest, git), readFile,
    rowLabels: rowLabels && ((row) => rowLabels(row.number, row.repo ?? REPO)), // #4123: a bare `#N` is the tracker's, as in `rowsNamed`
    reports: ticket === undefined ? undefined : ticketBodyReports(ticket.key, ticket.prReview, ticket.keywords) });
  for (const line of result.lines) out(`${line}\n`);
  if (!result.ok) {
    err(`pr-open: REFUSED -- this body would fail CI's own acceptance job; fix it before `
      + `gh pr ${mode} runs (nothing was sent to GitHub).\n`);
    return EXIT_NOTHING_SENT;
  }
  // #3215: AFTER the body reports, which are knowable before the pull request exists and are all a DRAFT is refused for.
  const unverified = verifyStampStep(mode, rest, body, { verifyStamp, out, err });
  if (unverified !== null) return unverified;
  // #2307: only for a body that will be SENT, and never a reason not to send it.
  printMutationReport(body, runMutation, out);
  // A ticket run's owner is the run, so no tree is stamped and no session is named: the create is sent with no label and no arm (A11-74).
  const stamped = ticket === undefined ? ownerOfPr({ owner, rowLabels }, { mode, body, rest, err })() : null;
  const unstamped = ticket === undefined ? unstampableRefusal(mode, stamped) : null;
  if (unstamped !== null) {
    err(`${unstamped}\n`);
    return EXIT_NOTHING_SENT;
  }
  return sendToGitHub(mode, rest, { run, git, err, labelExists, owner: () => stamped, arm: ticket === undefined });
}

/**
 * #4386: A CREATE THAT CANNOT NAME ITS OWNER IS REFUSED, BEFORE IT SENDS. `labelAfterCreate` skipped silently for a tree nobody stamped and
 * a row that named no session, and for an owner `isLiveSession` does not know -- and an unlabelled pull request of another repository has no
 * owner the gate can name, so every order about it (agent-org#436: a red check, then a review verdict) went to `ceo` to be routed by hand.
 * The two ways to be stamped: the tree's `.a11y-owner`, or a `Closes <owner/repo>#<n>` line naming a row that carries `session:<name>`.
 * An edit never creates a label, so it is not asked. `null` when the owner is a live session.
 * @param {string} mode @param {string | null} owner
 */
export function unstampableRefusal(mode: string, owner: string | null): string | null {
  if (mode !== "create" || (owner !== null && isLiveSession(owner))) return null;
  const why = owner === null ? "no session could be named as its owner" : `\`${owner}\` is not a live session`;
  return `pr-open: REFUSED -- ${why}, so the pull request would carry no \`${SESSION_PREFIX}*\` label and every order about it would go to \`ceo\` `
    + "(#4386). Either stamp this worktree (`.a11y-owner`, which `row-claim claim` writes) or put `Closes <owner/repo>#<n>` in the body, "
    + `naming a row that carries \`${SESSION_PREFIX}<you>\`. Nothing was sent to GitHub.`;
}

/**
 * #1344: THE ACCEPTANCE RUNS IN THIS WORKING TREE, SO THE TREE MUST BE THE HEAD BEING OPENED.
 *
 * `checkBody` runs each Acceptance command with no `cwd`, in whatever directory `pr-open` was started, and
 * `--head` is read only to arm. So `create --head B` from a tree on another branch printed
 * `ACCEPTANCE: RAN ... -> pass` for a branch it never tested. Measured 2026-09-13 by `orchestrator`: the same
 * command and body gave 51 tests from #1313's worktree and "# tests 43 / # pass 43" from the primary, and #1343
 * was created on the second.
 *
 * Pure over an injected `git`, and it refuses rather than guesses: a checkout on another branch, a detached
 * HEAD, an unreadable ref, or a tree whose HEAD is not `origin/B`'s commit (behind it, or ahead of it with
 * commits GitHub does not have) each name both sides. `null` when there is nothing to compare: `edit`, or a
 * `create` with no `--head`, where `gh` itself opens the checked-out branch.
 *
 * `origin/B` is the local remote-tracking ref, as fresh as the last fetch or push from this checkout; a push
 * made elsewhere since then reads as a mismatch, which refuses, never as a match.
 *
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {{ git?: (args: string[]) => string }} [deps]
 * @returns {string | null} the refusal, or null when the tree under test is the head being sent
 */
export function headTreeRefusal(mode: string, rest: string[], { git = defaultGit, crossRepo = null, branchHead }: {
        git?: (args: string[]) => string; crossRepo?: string | null; branchHead?: (repo: string, branch: string) => string | null;
    } = {}): string | null {
  if (mode !== "create") return null;
  const head = flagAfter(rest, "--head");
  if (head === null) return null;
  const read: (args: string[]) => string | null = (args): string | null => { try { return git(args) || null; } catch { return null; } };
  const nothingRan = "Nothing ran and nothing was sent (#1344).";
  const branch = read(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== head) {
    const where = branch === null ? "a checkout git could not read"
      : branch === "HEAD" ? `a detached HEAD at \`${read(["rev-parse", "--short", "HEAD"]) ?? "(unknown)"}\``
        : `\`${branch}\``;
    return `pr-open: REFUSED -- --head \`${head}\` but this working tree is on ${where}. The Acceptance runs in `
      + `this tree, so it would report a pass for a branch it never tested. Run pr-open from a worktree on `
      + `\`${head}\`. ${nothingRan}`;
  }
  const local = read(["rev-parse", "HEAD"]);
  // agent-org#753: the pull request opens in ANOTHER repository, whose branch this tree's `origin/<head>` is not a reading of.
  if (crossRepo !== null && branchHead) return otherRepositoryHeadRefusal(head, crossRepo, local, branchHead);
  const remote = read(["rev-parse", `refs/remotes/origin/${head}`]);
  if (local === null || remote === null || local !== remote) {
    return `pr-open: REFUSED -- this tree is on \`${head}\` at \`${local ?? "(unreadable)"}\`, but \`origin/${head}\` `
      + `is \`${remote ?? "(unreadable -- push the branch first)"}\`. The Acceptance would test a tree that is not `
      + `the head GitHub opens; push or pull until they are the same commit. ${nothingRan}`;
  }
  return null;
}

/**
 * agent-org#753: THE BRANCH OF THE REPOSITORY THE PULL REQUEST OPENS IN, READ FROM THAT REPOSITORY. `origin/<head>` is this tree's own remote, and
 * for a row whose Region is another repository's (a11ign#4889: `agent-org:` paths, branch pushed to a11ign/agent-org) it is "unreadable --
 * push the branch first" whatever was pushed, so the row stalled with finished work. A branch the repository does not hold, one it holds at
 * another commit, and a read that fails each refuse and name the repository; none is read as a match. `null` is "this tree is that head".
 * @param {string} head @param {string} repo @param {string | null} local the commit the Acceptance runs on
 * @param {(repo: string, branch: string) => string | null} branchHead the commit `repo` holds `branch` at, or null when it holds none
 * @returns {string | null}
 */
function otherRepositoryHeadRefusal(head: string, repo: string, local: string | null, branchHead: (repo: string, branch: string) => string | null): string | null {
  const nothingRan = "Nothing ran and nothing was sent (agent-org#753).";
  let held: string | null;
  try {
    held = branchHead(repo, head);
  } catch (error) {
    return `pr-open: REFUSED -- could not read branch \`${head}\` of ${repo} (${messageOf(error).split("\n")[0]}), where this pull request opens, so the tree under `
      + `test cannot be compared with its head. Retry once GitHub answers. ${nothingRan}`;
  }
  if (held === null) {
    return `pr-open: REFUSED -- ${repo} holds no branch \`${head}\`, and the pull request opens there (the row's Region names ${repo}). `
      + `Push \`${head}\` to ${repo} first. ${nothingRan}`;
  }
  if (local === null || local !== held) {
    return `pr-open: REFUSED -- this tree is on \`${head}\` at \`${local ?? "(unreadable)"}\`, but ${repo} holds \`${head}\` at \`${held}\`. `
      + `The Acceptance would test a tree that is not the head GitHub opens; push or pull until they are the same commit. ${nothingRan}`;
  }
  return null;
}

/**
 * agent-org#753: THE REPOSITORY A PULL REQUEST OPENS IN WHEN IT IS NOT THIS TREE'S, or null when it is (or when nothing can say). The one
 * single repository the Regions of the rows the body closes name -- `agent-org:src/x.ts` is the declared repository keyed `agent-org`, a bare
 * path is the row's stated repository or else the project's first -- or an explicit `--repo`, which outranks it. Compared with the repository
 * this tree's `origin` is; `Closes: none`, a row that cannot be read or has no Region, and Regions spread over several repositories name none,
 * and the tree's own `origin/<head>` is read as ever. OFF when no `branchHead` is wired, which is every direct caller of `main` (the entry block wires it).
 * @param {string} mode @param {string[]} rest @param {string} body
 * @param {{ git?: (args: string[]) => string, rowBody?: (number: number, repo?: string) => string, rootFiles?: Set<string>,
 *   code?: readonly { key: string, repo: string }[], branchHead?: (repo: string, branch: string) => string | null }} deps
 * @returns {string | null}
 */
export function otherRepositoryOf(mode: string, rest: string[], body: string, { git = defaultGit, rowBody, rootFiles, code, branchHead }: {
        git?: (args: string[]) => string; rowBody?: (number: number, repo?: string) => string; rootFiles?: Set<string>;
        code?: readonly { key: string; repo: string; }[]; branchHead?: (repo: string, branch: string) => string | null;
    }): string | null {
  if (mode !== "create" || !branchHead || flagAfter(rest, "--head") === null) return null;
  const target = flagAfter(rest, "--repo") ?? (rowBody ? regionRepository(body, { rowBody, rootFiles, code }) : null);
  if (target === null) return null;
  let slug: string | undefined;
  try {
    slug = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(git(["remote", "get-url", "origin"]))?.[1];
  } catch (error) {
    void error; // an origin that cannot be read is no proof the tree is the target's, so GitHub is asked about the target
  }
  return slug !== undefined && slug.toLowerCase() === target.toLowerCase() ? null : target;
}

/**
 * agent-org#753: the ONE repository the Regions of the rows a body closes are written against, or null. Pure over `rowBody`.
 * @param {string} body
 * @param {{ rowBody: (number: number, repo?: string) => string, rootFiles?: Set<string>, code?: readonly { key: string, repo: string }[] }} deps
 * @returns {string | null}
 */
function regionRepository(body: string, { rowBody, rootFiles, code = homeProjectDeclaration().code }: {
        rowBody: (number: number, repo?: string) => string; rootFiles?: Set<string>; code?: readonly { key: string; repo: string; }[];
    }): string | null {
  const closes = extractClosesDeclaration(body);
  if (closes.kind !== "closes") return null;
  const repositories = new Set<string>();
  for (const reference of closesReferences(closes)) {
    let text;
    try {
      text = reference.repo === null ? rowBody(reference.number) : rowBody(reference.number, reference.repo);
    } catch (error) {
      void error; // an unread row is `regionStep`'s refusal to make, in its own words
      return null;
    }
    const declared = declaredRegionFiles(text, rootFiles ? { rootFiles } : undefined);
    if (declared === null) return null;
    for (const entry of declared) {
      const repo = repositoryOfEntry(entry, text, code);
      if (repo === undefined) return null;
      repositories.add(repo);
    }
  }
  return repositories.size === 1 ? [...repositories][0] : null;
}

/**
 * agent-org#753: the commit `repo` holds `branch` at, over REST like `defaultRowBody`; null when the repository answers 404 (it holds no such
 * branch), a throw for any other failure -- which `otherRepositoryHeadRefusal` refuses on rather than read as absent.
 * @param {string} repo @param {string} branch
 * @returns {string | null}
 */
const defaultBranchHead = (repo: string, branch: string): string | null => {
  try {
    const path = branch.split("/").map(encodeURIComponent).join("/");
    return execFileSync("gh", ["api", `repos/${repo}/branches/${path}`, "--jq", ".commit.sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch (error) {
    const said = `${(error as { stderr?: unknown }).stderr ?? ""}${messageOf(error)}`;
    if (/HTTP 404|Not Found/i.test(said)) return null;
    throw error;
  }
};

/** `gh`'s own failure line: its stderr when it said one, else the error's first line. @param {unknown} error */
const ghFailureLine = (error: unknown) =>
  `${(error as { stderr?: unknown }).stderr ?? ""}`.trim().split("\n")[0] || messageOf(error).split("\n")[0];

/**
 * #811: THE LOGIN `gh` WILL AUTHOR THE PULL REQUEST AS, FROM `gh api user` AND, WHERE THAT IS REFUSED, FROM THE GRAPHQL VIEWER.
 *
 * Since #4910 a worker's `gh` runs on a GitHub App's installation token, and `GET /user` answers an installation token
 * `HTTP 403 Resource not accessible by integration`, so `gh api user` refused every worker's PR into a review-only lane.
 * GraphQL `viewer { login }` answers for the same token (`a11ign-workers[bot]`; measured 2026-10-11 from a worker session,
 * the 403 and the answer side by side). The second read runs only after the first fails, so a user token pays one call.
 *
 * #796: A THIRD READ, THE ROLE, WHEN BOTH FAIL AND THE CALLER KNOWS ONE. `role` is `AGENT_ORG_GH_ROLE`, the value `host/gh` routes the
 * call's token by and records as `app:<role>` in the ledger, so it names the same App `gh pr create` will author as. It answers
 * `app:<role>`, which `ownsReviewOnlyLane` resolves through `APP_ROLE_LANE_OWNER`: the lane check still decides, where it used to refuse
 * "could not say who is opening it" for every manager. A role the wrapper does not declare is no identity (the third read is skipped, and
 * `AGENT_ORG_GH_ROLE` unset is the ordinary case, where the workspace decides and only the two reads above can say).
 *
 * AN IDENTITY NONE OF THE READS ANSWERS THROWS, naming the failures: `authorshipRefusal` refuses on it, because a login that
 * cannot be read is never read as "not the owner" (#3254). An empty answer is a failure too, not a login.
 *
 * @param {(args: string[]) => string} gh runs `gh` with the args and returns its stdout, or throws
 * @param {string | undefined} role the caller's declared App role; absent in a test unless it is the subject, so the environment cannot reach it
 * @returns {string}
 */
export function loginThrough(gh: (args: string[]) => string, role?: string): string {
  const reads: [string, string[]][] = [
    ["`gh api user`", ["api", "user", "--jq", ".login"]],
    ["the GraphQL `viewer` read", ["api", "graphql", "-f", "query={ viewer { login } }", "--jq", ".data.viewer.login"]],
  ];
  const failures: string[] = [];
  for (const [name, args] of reads) {
    try {
      const login = gh(args).trim();
      if (login) return login;
      failures.push(`${name} answered no login`);
    } catch (error) {
      failures.push(`${name}: ${ghFailureLine(error)}`);
    }
  }
  if (role && Object.hasOwn(APP_ROLE_LANE_OWNER, role)) return `app:${role}`;
  throw new Error(failures.join("; "));
}

/** The login `gh` will author the pull request as -- `gh pr create` runs under the same account (or App) and `GH_CONFIG_DIR`. */
const defaultLogin = () => loginThrough((args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), process.env.AGENT_ORG_GH_ROLE);

/**
 * #3254, #1756 RULING ITEM 7: A REVIEW-ONLY LANE'S OWNER DOES NOT OPEN A PULL REQUEST INTO IT -- refused before
 * anything runs or is sent, the cheap early half of `arm-pr`'s refusal (which is the one a bare `gh pr create` cannot
 * walk around: `arm-pr` runs in CI on the PR's own event, and this wrapper is only the door the org's sessions use).
 *
 * THE LOGIN IS ASKED ONLY WHEN THE DIFF TOUCHES A REVIEW-ONLY LANE, so an ordinary PR costs no call. A diff or a login
 * that cannot be read refuses, for `headTreeRefusal`'s reason: the pass this would otherwise print is for a PR nobody
 * checked. `edit` never refuses: it opens nothing, and `arm-pr` reads the PR's own author and files.
 *
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {{ git?: (args: string[]) => string, login?: () => string, lanes?: {lanes: import("./lane-ownership.ts").Lane[]} | null }} [deps]
 * @returns {string | null}
 */
export function authorshipRefusal(mode: string, rest: string[], { git = defaultGit, login = defaultLogin, lanes = loadLanes() }: { git?: (args: string[]) => string; login?: () => string; lanes?: { lanes: import("./lane-ownership.ts").Lane[]; } | null; } = {}): string | null {
  if (mode !== "create") return null;
  const diff = localDiffReading(rest, git);
  if (!diff.ok) return `pr-open: REFUSED -- could not read the diff to check lane authorship (#3254): ${diff.why}. Nothing was sent.`;
  if (reviewOnlyPathsIn(diff.files, lanes).length === 0) return null;
  let author;
  try {
    author = login();
  } catch (error) {
    return `pr-open: REFUSED -- this diff touches a review-only lane and \`gh api user\` (and the GraphQL \`viewer\` read after it) could not say who is opening it: ${messageOf(error).split("\n")[0]}. Nothing was sent (#3254).`;
  }
  const refusal = laneAuthorshipRefusal({ author, files: diff.files, lanes });
  return refusal === null ? null : `pr-open: REFUSED -- ${refusal} Nothing was sent.`;
}

/**
 * PR N's head through `prHead`, or null when the read throws or answers without both a ref and a commit -- a
 * failed read is never a head this tree could match.
 * @param {(repo: string, number: string) => { ref: string, oid: string } | null} prHead
 * @param {string} repo
 * @param {string} number
 * @returns {{ ref: string, oid: string } | null}
 */
function readPrHead(prHead: (repo: string, number: string) => { ref: string; oid: string; } | null, repo: string, number: string): { ref: string; oid: string; } | null {
  try {
    const head = prHead(repo, number);
    return head && head.ref && head.oid ? head : null;
  } catch {
    return null;
  }
}

/** How a refusal names the tree's position: an unreadable checkout, a detached HEAD, or the branch. @param {string | null} branch */
const treeWhere = (branch: string | null) => (branch === null ? "a checkout git could not read"
  : branch === "HEAD" ? "a detached HEAD" : `\`${branch}\``);

/**
 * #1446: `edit N` RUNS THE BODY'S ACCEPTANCE IN THIS WORKING TREE, SO THE TREE MUST BE PR N'S HEAD.
 *
 * The edit half of #1344. `pr-open edit 1454 --body-file b.md` from a tree on another branch printed
 * `ACCEPTANCE: RAN ... -> pass` for commands run against THAT tree, then sent #1454 a body whose Acceptance never
 * ran at #1454's head (reproduced 2026-09-13 21:59Z, behind a gh shim, from a worktree at `da9858fb` against a PR
 * at `9d954d13`). `create --head` names its branch in the args; `edit` names only a PR, so its head is READ, from
 * GitHub, through the injected `prHead`.
 *
 * Refuses, naming both sides, when the selector is not a PR number, when PR N's head cannot be read, or when this
 * tree's branch or commit is not that head. The commit compared is the PR's own `head.sha`: GitHub's, not a local
 * remote-tracking ref, so a push this checkout has not fetched reads as a mismatch, never as a match.
 *
 * @param {string} mode
 * @param {string[]} rest `<pr-number> <gh pr edit args...>`
 * @param {{ git?: (args: string[]) => string,
 *           prHead?: (repo: string, number: string) => { ref: string, oid: string } | null }} [deps]
 * @returns {string | null} the refusal, or null when the tree under test is PR N's head
 */
export function editTreeRefusal(mode: string, rest: string[], { git = defaultGit, prHead = defaultPrHead }: {
    git?: (args: string[]) => string;
    prHead?: (repo: string, number: string) => { ref: string; oid: string; } | null;
} = {}): string | null {
  if (mode !== "edit") return null;
  const nothingRan = "Nothing ran and nothing was sent (#1446).";
  const selector = rest[0] ?? "";
  if (!/^\d+$/.test(selector)) {
    return `pr-open: REFUSED -- \`edit\` takes the PR NUMBER first (got \`${selector}\`), so it can read that PR's `
      + `head and check this tree is it. ${nothingRan}`;
  }
  const repo = flagAfter(rest, "--repo") ?? REPO;
  const head = readPrHead(prHead, repo, selector);
  if (head === null) {
    return `pr-open: REFUSED -- could not read PR #${selector}'s head from ${repo}, so this tree cannot be checked `
      + `against the head its Acceptance would test. ${nothingRan}`;
  }
  const read: (args: string[]) => string | null = (args): string | null => { try { return git(args) || null; } catch { return null; } };
  const branch = read(["rev-parse", "--abbrev-ref", "HEAD"]);
  const local = read(["rev-parse", "HEAD"]);
  if (branch !== head.ref || local !== head.oid) {
    return `pr-open: REFUSED -- PR #${selector}'s head is \`${head.ref}\` at \`${head.oid}\`, but this working tree is on `
      + `${treeWhere(branch)} at \`${local ?? "(unreadable)"}\`. The Acceptance runs in this tree, so it would report a pass for a `
      + `head it never tested. Run pr-open from a worktree on \`${head.ref}\` at that commit. ${nothingRan}`;
  }
  return null;
}

/**
 * a11ign#5036: A DRAFT IS OPENED ONLY WITH A REASON, IN THE BODY. An approved draft is a wait with no purpose: `auto-arm.yml` ignored drafts,
 * so a draft sat until a worker turn marked it ready (19-34 minutes on 10-10 night), and #4968 made READY the default without stopping a worker
 * passing `--draft` itself ("I opened it as a draft because it is control-plane product code"; a11ign#5035, agent-org#949, control#51-#54 were
 * open drafts at 12:40Z on 10-11). The reviewer and the merge queue are the gate, so "this is product code" is not a reason to wait. A real
 * "not now" costs one line, `Draft-because: <reason>` (for example `work in progress, do not review`), which the reviewer then reads.
 * A body-line and never an override flag: it is a declaration a reader can argue with, like `Closes: none -- <reason>`. Pure; `create`
 * only, because `gh pr edit` has no `--draft`. `null` is "go on".
 * @param {string} mode @param {string[]} rest @param {string} body
 * @returns {string | null}
 */
export function draftRefusal(mode: string, rest: string[], body: string): string | null {
  if (mode !== "create" || !rest.includes("--draft")) return null;
  if (/^Draft-because:[ \t]*\S/m.test(body)) return null;
  return "pr-open: REFUSED -- `--draft` without a reason. An approved draft is a wait with no purpose, and the reviewer and the merge queue are "
    + "the gate, so open it READY (drop `--draft`). If it genuinely must not be reviewed yet, add a line to the body: "
    + "`Draft-because: <reason>`, for example `Draft-because: work in progress, do not review`. Nothing was sent (a11ign#5036).";
}

/**
 * a11ign#5100: THE PATHS OF THE ORG'S OWN MACHINERY -- the gate, claims, the tick, waking, arming, releases and identities. A change to one ships behind a flag the gate can turn off
 * (`org-health.ts`'s machinery canary), so the pull request must say which flag, what it could hurt and how to undo it. Tests, docs, acceptance records and changesets are not machinery:
 * they change no behaviour a tick can show.
 */
export const MACHINERY_PATHS: readonly RegExp[] = Object.freeze([
  /^src\/work-gate(\.ts|\/)/, /^src\/row-claim(\.ts|\/)/, /^src\/claim-[^/]+\.ts$/,
  /^src\/work-tick[^/]*\.ts$/, /^host\/work-tick\./,
  /^src\/(wake|wakes-per-row|prompt-session)\.ts$/,
  /^src\/(arm-pr|auto-arm-sweep|pr-armed-state|pr-hold|pr-hold-state|merge-queue|merge-guard)\.ts$/, /^src\/merge-guard\//, /^\.github\/workflows\/auto-arm\.yml$/,
  /^src\/release-[^/]+\.ts$/, /^src\/update-tool\.ts$/, /^\.github\/workflows\/release\.yml$/,
  /^src\/host-config\.ts$/, /^host\/gh$/,
  /^src\/(org-health|pr-open)\.ts$/, // the canary and its own enforcement: a change to either is the one most worth a flag (review of #1014)
]);

const MACHINERY_EXEMPT = /\.test\.[cm]?[jt]sx?$|\.md$|^docs\/|^\.acceptance\/|^\.changeset\//;

/** @returns the files of a diff that are machinery */
export const machineryFilesIn = (files: readonly string[]): string[] => files.filter((file) => !MACHINERY_EXEMPT.test(file) && MACHINERY_PATHS.some((path) => path.test(file)));

const MACHINERY_MAX_SIGNALS = 3;
const FLAG_LINE = /^[ \t]*Flag:[ \t]*(.*)$/m;
const SIGNALS_LINE = /^[ \t]*Health-signals:[ \t]*(.*)$/m;
const REVERT_LINE = /^[ \t]*Revert:[ \t]*(.*)$/m;
const NONE_WITH_REASON = /^none[ \t]*(?:—|--)[ \t]*\S.*$/;

/**
 * a11ign#5100: THE THREE LINES A MACHINERY CHANGE NAMES. `Flag: <name>` (the key it reads in `machinery-canary.json`; `Flag: none -- <reason>` for a change that cannot be gated, such as a fix whose OLD
 * behaviour is the defect, which a reviewer may argue with as with `Closes: none`), `Health-signals:` one to three of the gate's standard signals (the ones it records, so a promise it cannot watch is
 * refused), and `Revert:` how to undo it. PURE. @returns what is wrong, one string each; empty when the declaration is whole
 */
export function machineryDeclarationProblems(body: string): string[] {
  const problems: string[] = [];
  const flag = FLAG_LINE.exec(body)?.[1].trim() ?? "";
  if (flag === "") problems.push("`Flag: <name>` is missing (or `Flag: none -- <reason>`)");
  else if (/^none\b/i.test(flag) && !NONE_WITH_REASON.test(flag)) problems.push("`Flag: none` needs its reason: `Flag: none -- <reason>`");
  const named = (SIGNALS_LINE.exec(body)?.[1] ?? "").split(",").map((signal) => signal.trim()).filter(Boolean);
  if (named.length === 0) problems.push(`\`Health-signals: <one to ${MACHINERY_MAX_SIGNALS} of the standard signals>\` is missing`);
  if (named.length > MACHINERY_MAX_SIGNALS) problems.push(`\`Health-signals:\` names ${named.length}; name the ${MACHINERY_MAX_SIGNALS} it could hurt most`);
  const foreign = named.filter((signal) => !STANDARD_MACHINERY_SIGNALS.includes(signal));
  if (foreign.length > 0) problems.push(`\`Health-signals:\` names ${foreign.map((signal) => `\`${signal}\``).join(", ")}, which the gate does not record (${STANDARD_MACHINERY_SIGNALS.join(", ")})`);
  if ((REVERT_LINE.exec(body)?.[1].trim() ?? "").length < 3) problems.push("`Revert: <how it is undone>` is missing");
  return problems;
}

/**
 * a11ign#5100: A PULL REQUEST THAT TOUCHES THE MACHINERY IS REFUSED WITHOUT ITS FLAG, SIGNALS AND REVERT, before anything is sent. `null` is "go on": no machinery in the diff, or a whole declaration.
 * AN UNREADABLE DIFF IS `null` TOO, and not a refusal: `checkBody`'s own read of it says `UNCHECKED` loudly, and a git hiccup is not the author's to fix (the rule `localDiffReading` documents).
 * @param {import("./acceptance-commands.ts").DiffReading} diff @param {string} body
 * @returns {string | null}
 */
export function machineryRefusal(diff: import("./acceptance-commands.ts").DiffReading, body: string): string | null {
  if (!diff.ok) return null;
  const touched = machineryFilesIn(diff.files);
  if (touched.length === 0) return null;
  const problems = machineryDeclarationProblems(body);
  if (problems.length === 0) return null;
  return `pr-open: REFUSED -- this change touches the org's machinery (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? `, and ${touched.length - 3} more` : ""}), which ships behind a flag the gate `
    + "watches for an hour and turns off if a named signal degrades (a11ign#5100). Four of the chairman's 2026-10-11 regressions were fixes green in tests and broken live. Missing:\n"
    + `${problems.map((problem) => `  - ${problem}`).join("\n")}\n`
    + "Add them to the body as lines of their own:\n  Flag: <name>\n  Health-signals: claims-refused, wakes-held\n  Revert: <turn the flag off, or revert this PR>\nNothing was sent.";
}

/**
 * #909: A PR THIS WRAPPER OPENS READY IS ARMED AT CREATION, BY THE WRAPPER. Pure: the extra `gh` argv to run
 * after `gh pr create`, or none. #4968: READY IS THE DEFAULT FOR EVERY PR, product or docs-and-tests. A product PR
 * used to open as a draft (#912) and wait for someone to mark it ready, because `auto-arm.yml` ignores drafts and
 * does not fire on a review: 0-8 minutes usually, 117 minutes at worst, and a worker turn each time. The merge
 * queue's `require_last_push_approval` now makes an approval cover the latest push, so the draft no longer stands
 * in for that rule. This wrapper never adds `--draft`; a create without it is armed here. Merge commits only, the
 * org's rule. `--draft` anywhere in the args means "not now" and is never armed; `edit` never arms.
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {string | null} branch the tree's own branch, which the create was made from
 * @returns {string[][]}
 */
export function armAfterCreate(mode: string, rest: string[], branch: string | null = null): string[][] {
  if (mode !== "create" || rest.includes("--draft")) return [];
  const selector = selectorOf(rest, branch);
  return selector === null ? [] : [["pr", "merge", "--auto", "--merge", ...selector, ...repoFlagOf(rest)]];
}

/**
 * THE SESSION LABEL BELONGS ON THE PR AT CREATION, NOT AT ARM -- and arming is the LAST thing that happens.
 *
 * `arm-pr.ts`'s `labelArmedPr` already copies a row's `session:*` onto the PR, but only when the PR is
 * armed (green AND convinced) and only via `closedRowNumbers(prBody)`. Both conditions fail on exactly the
 * population that needs routing:
 *
 *   - A PR that goes RED BEFORE IT IS EVER ARMED is unlabelled BY CONSTRUCTION. The label lands when the PR
 *     is about to merge -- when nobody needs to be told whose it is -- and is missing while it is stuck.
 *   - A PR declaring `Closes: none -- <reason>` (an accepted, merge-blocking-compliant declaration) names no
 *     row at all, so `closedRowNumbers` returns `[]` and `labelArmedPr` returns early. Such a PR is
 *     PERMANENTLY unroutable.
 *
 * Measured 2026-09-21: 11 of the last 20 merged PRs carried no `session:*` label. #1844 -- `orchestrator`'s
 * own nightly-batch scheduler -- went red with no label, so `work-gate.ts`'s `failingChecksOrder` fell back
 * to `product-manager`, whose entire job on that order is to find out whose PR it is and hand it back: an
 * extra session, an extra turn and an extra tick of latency, for a fact that was on disk the whole time.
 *
 * THE FACT IS ALREADY WRITTEN DOWN. `.a11y-owner` in the worktree root names the session that owns this
 * tree (#1128), `pr:open` runs from that tree, and 84 of the 93 worktrees on the agent host carry one. This
 * reads it -- it does not ask anyone to remember anything, which is the only kind of fix that has held in
 * this repository.
 *
 * NOTHING IS INVENTED. An unstamped tree yields no label rather than a guessed one -- `worktree-owner.ts`'s
 * own ruling, that a stamp naming nobody is worse than no stamp, applies with more force here because the
 * wrong session would then be woken for every red check. A retired or unknown owner is likewise refused,
 * for #1000's reason: a claim on the attribution record that no live session can answer for.
 *
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {string | null} owner the worktree's stamped session, or null when nobody stamped it
 * @param {string | null} branch the tree's own branch, which the create was made from
 * @returns {string[][]}
 */
export function labelAfterCreate(mode: string, rest: string[], owner: string | null, branch: string | null = null): string[][] {
  if (mode !== "create" || owner === null) return [];
  if (!isLiveSession(owner)) return [];
  const selector = selectorOf(rest, branch);
  return selector === null ? [] : [["pr", "edit", ...selector, ...repoFlagOf(rest), "--add-label", `${SESSION_PREFIX}${owner}`]];
}

/**
 * agent-org#753: `--repo <repo>` when the call was made for one, else nothing -- the arm and the label of a pull request opened in another
 * repository are aimed there too, because `gh pr merge <branch>` and `gh pr edit <branch>` otherwise look in the checkout's own.
 * @param {string[]} rest
 * @returns {string[]}
 */
function repoFlagOf(rest: string[]): string[] {
  const repo = flagAfter(rest, "--repo");
  return repo === null ? [] : ["--repo", repo];
}

/**
 * agent-org#952: the selector the arm and the label name the pull request by, after a create. `--head` when it was passed. Otherwise the
 * tree's own branch, but only with `--repo`: gh refuses `--repo` with no selector ("argument required when using the --repo flag"), which left
 * the PR unarmed and unlabelled, and without `--repo` gh reads the checkout's branch itself. `null` when `--repo` is given and no branch is known,
 * so the step is not sent at all rather than sent in the form gh refuses.
 * @param {string[]} rest
 * @param {string | null} branch
 * @returns {string[] | null}
 */
function selectorOf(rest: string[], branch: string | null): string[] | null {
  const head = flagAfter(rest, "--head");
  if (head) return [head];
  if (repoFlagOf(rest).length === 0) return [];
  return branch === null ? null : [branch];
}

/**
 * The value after a `--flag` (or `--flag=value`), or null.
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | null}
 */
function flagAfter(args: string[], flag: string): string | null {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/**
 * The checks made before the body is read, in the places they always ran: a row's Region and claim (#2417, agent-org#744), or a ticket run's owner,
 * draft policy, Region and changeset (A11-74). A refusal is printed and its exit code returned; a passing check prints its note. `null` is "go on".
 * @param {string} mode @param {string[]} rest @param {string} body
 * @param {{ ticket?: TicketContext, git?: (args: string[]) => string, rootFiles?: Set<string>, rowBody?: (number: number, repo?: string) => string,
 *   code?: readonly { key: string, repo: string }[], openPulls?: (repo: string) => OpenPull[] | null, claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null,
 *   out: (line: string) => void, err: (line: string) => void }} deps
 * @returns {number | null}
 */
function beforeBodyCheck(mode: string, rest: string[], body: string, { ticket, git, rootFiles, rowBody, code, openPulls, claimedRows, out, err }: {
    ticket?: TicketContext; git?: (args: string[]) => string; rootFiles?: Set<string>; rowBody?: (number: number, repo?: string) => string;
    code?: readonly { key: string; repo: string; }[]; openPulls?: (repo: string) => OpenPull[] | null; claimedRows?: (prRepo: string) => ClaimedRow[] | ClaimedRows | null;
    out: (line: string) => void; err: (line: string) => void;
}): number | null {
  if (ticket === undefined) {
    return regionStep(body, rest, { git, rowBody, rootFiles, code, openPulls: mode === "create" ? openPulls : undefined, out, err })
      ?? claimedRowStep(body, rest, { git, code, claimedRows, out, err });
  }
  const checked = ticketChecks(mode, rest, body, ticket, { git: git ?? defaultGit, base: `origin/${flagAfter(rest, "--base") ?? "main"}`,
    diff: localDiffReading(rest, git), rootFiles });
  for (const note of checked.notes) out(`${note}\n`);
  if (checked.refusal !== null) {
    err(`${checked.refusal}\n`);
    return EXIT_NOTHING_SENT;
  }
  return null;
}

/**
 * THE CLI'S SEAMS, WIRED FOR WHAT RUNS IT. A row's checks read GitHub. A ticket-mode run (`AGENT_ORG_TICKET`, which the pool sets for every worker)
 * reads its ticket from the tracker first, and its checks read no row, claim or session: they are `ticket-mode/pr-open-ticket.ts`'s (A11-74).
 * An unreadable ticket refuses the create before anything is sent, as an unreadable row does.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>} the header's exit code
 */
export async function runFromCli(env: NodeJS.ProcessEnv): Promise<number> {
  if (!env[TICKET_ENV.key]) {
    return main(undefined, { rowBody: defaultRowBody, verifyStamp: defaultVerifyStamp,
      claimedRows: (prRepo) => lookupClaimedRowsOfTrackers(trackerReposFor(prRepo)), branchHead: defaultBranchHead,
      rowLabels: defaultRowLabels, openPulls: (repo) => openPullsOf(repo, ghRead), labelExists: defaultLabelExists, write: writeAcceptanceFile });
  }
  let ticket: TicketContext;
  try {
    ticket = await readTicketContext(env, { git: defaultGit });
  } catch (error) {
    process.stderr.write(`pr-open: REFUSED -- the ticket could not be read (${messageOf(error).split("\n")[0]}), so the pull request cannot be checked against it. `
      + "Nothing was sent to GitHub (A11-74).\n");
    return EXIT_NOTHING_SENT;
  }
  return main(undefined, { ticket, verifyStamp: defaultVerifyStamp, branchHead: defaultBranchHead, write: writeAcceptanceFile });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // #1352: IN THE ENTRY BLOCK, NOT IN `main`, because the tests call `main` directly -- in CI's plain clone a refusal
  // inside it would refuse them. From the primary checkout or a plain clone: refuse before anything, nothing sent.
  if (launchGate(`pr-open ${process.argv[2] ?? ""}`.trim())) {
    process.exitCode = EXIT_NOTHING_SENT;
  } else {
    runFromCli(process.env).then((code) => { process.exitCode = code; });
  }
}
