// @ts-check
// A LAB PULL REQUEST WHOSE CROSS-REPO LEG ADDS A RED TEST FILE IS NOT ARMED UNLESS IT NAMES THE TICKET THAT GREENS IT (agent-org#992).
//
// THE GAP. `ci.yml` sets `continue-on-error` on the `cross-repo` matrix leg so that it never blocks, and the price is that `gate` reads
// green while the leg is red: such a pull request is armed, merges, and puts `main` red. `readTrunkRed` (#539) then reads that red AFTER
// the merge, and the session it wakes is the merging one, which did not cause it (lab#81 put `main` red on 2026-10-11 as the known price
// of ADR 0045 cut 1; nothing at the gate asked that it be declared). This refuses the arm BEFORE the merge, unless the body names the
// ticket that greens the leg.
//
// THE EXIT NAMES A TICKET (A11-127). Rows live in the tracker now, and the GitHub issues that once held them are closed, so a declaration naming an OPEN GitHub row could never
// be written and every newly red leg was a wall. The line names the ticket that owns greening the leg (`A11-123`), and is read by its shape: CI and the arm bot hold no tracker
// credential, so they cannot ask whether the ticket is open. The refusal itself stays: a pull request that newly reds the leg is still not armed unannounced.
//
// WHAT "RED" MEANS HERE IS DIFFERENCE, NOT ABSENCE OF GREEN: the leg has stood red on `main` for days under #4425 phase 3, one test file
// at a time, so a pull request is judged on the files it fails that the newest trunk verdict run PASSED. A file `main` already fails is
// the world's red, not the pull request's, and refusing on it would hold every lab pull request behind one nobody here caused.
//
// THE LOG IS NOT TAP. The leg runs rstest, whose failed log has ` FAIL  <file> > <name>` lines (colour escapes included) where
// `failingTestsFromJobLog` reads `not ok N` lines, so `summarizeTestLog` answers `unknown` for it and no code here read it.
import { homeProjectDeclaration } from "./project-config.ts";
import { checkRunsOfHead, failedLogOfRun, headOfChange, jobsOfRun, workflowRunsOf, type CiJob } from "./ticket-port/ci-reads.ts";
import { isTicketKey } from "./ticket-mode/ticket-references.ts";
import { newestVerdictRun, trunkOfCodeRepository, type TrunkSource } from "./trunk-red.ts";

/**
 * THE LEG'S NAME RULE, the same one `trunk-red.ts` keeps as a private constant (`CROSS_REPO_LEG`): `cross-repo`, `checks (cross-repo)` or
 * `ci / cross-repo`, and not `cross-repo-copies`. It is not exported there and that file is not this row's Region, so the copy is held
 * to the original by a parity test that drives `readTrunkRed` with the same names (`cross-repo-red-refusal.test.ts`).
 */
export const CROSS_REPO_LEG = /(^|[\s(/])cross-repo\)?$/;

/** The line a body carries to declare the red, and what the refusal tells the author to add. */
export const DECLARATION = "Cross-repo-red";

export type CrossRepoRedVerdict = { kind: "clear" } | { kind: "cross-repo-red"; why: string; files: string[] } | { kind: "cannot-ask"; why: string };

/** `gh` as the caller has it: arguments in, stdout out, a refusal THROWN. */
type Run = (ghArgs: string[]) => string;

type Leg = CiJob;

/**
 * COLOUR ESCAPES, in both forms the log arrives in: the raw ESC byte (what GitHub stores) and the two characters `^[` (what the log was
 * printed as when the lab#81 leg was read through the host's `gh`, measured 2026-10-11). Stripped before any line is read, because
 * rstest paints the directory, the file name and the `>` separately.
 */
const ANSI = /(?:\u001b|\^\[)\[[0-9;]*m/g;
/** `<timestamp> ` that `gh run view --log-failed` puts in front of every line: it has to come off before an anchored pattern can match. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
/** ` FAIL  <file>` and then either ` > <test name>` or the end of the line (a file that failed to load has no test name). */
const FAIL_LINE = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?(?:\s+>\s|\s*$)/;

/**
 * The test FILES that failed, from the lines of the named job inside a `gh run view --log-failed` dump (`job\tstep\tline`): distinct and
 * sorted. `null` when the job has no lines here or none of them is a `FAIL` line -- which is "could not tell" and never "none failed",
 * so a TAP log (`not ok N`) and an empty one are `null` too.
 * @param {string} logFailed
 * @param {string} jobName
 * @returns {string[] | null}
 */
export function failingFilesFromRstestLog(logFailed: string, jobName: string): string[] | null {
  const prefix = `${jobName}\t`;
  const files = new Set<string>();
  let jobLines = 0;
  for (const raw of logFailed.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    jobLines += 1;
    const line = raw.split("\t").slice(2).join("\t").replace(ANSI, "").replace(TIMESTAMP, "");
    const file = FAIL_LINE.exec(line)?.[1];
    if (file !== undefined) files.add(file);
  }
  return jobLines === 0 || files.size === 0 ? null : [...files].sort();
}

/**
 * Every `Cross-repo-red:` line of a body, read. `malformed` carries the text after the colon of each line that is not exactly one ticket key.
 * @param {string} body
 * @returns {{ tickets: string[], malformed: string[] }}
 */
export function declaredTickets(body: string): { tickets: string[]; malformed: string[] } {
  const tickets: string[] = [];
  const malformed: string[] = [];
  for (const match of body.matchAll(new RegExp(`^[ \\t]*${DECLARATION}:[ \\t]*(.*?)[ \\t]*$`, "gim"))) {
    const text = match[1] ?? "";
    if (isTicketKey(text)) tickets.push(text);
    else malformed.push(text);
  }
  return { tickets, malformed };
}

const firstLine = (cause: unknown) => String((cause as Error)?.message ?? cause).split("\n")[0];

/** The code repository a pull request is in, as a trunk source, or `null` for the primary and for a repository the project does not declare (no leg to ask about). */
function legSourceOf(repo: string, codeRepositories: readonly { key: string; repo: string }[]): TrunkSource | null {
  const declared = codeRepositories.find((code) => code.repo === repo);
  if (declared === undefined || declared.key === "") return null;
  const source = trunkOfCodeRepository(declared.key, declared.repo);
  return source.crossRepoLeg ? source : null;
}

/** @returns {{ files: string[] } | { cannotAsk: string }} the failing files of one job of one run, read from the run's failed log */
function filesOfLeg({ repo, runId, jobName, run }: { repo: string; runId: string; jobName: string; run: Run }): { files: string[] } | { cannotAsk: string } {
  try {
    const files = failingFilesFromRstestLog(failedLogOfRun(repo, runId, run), jobName);
    return files === null ? { cannotAsk: `the failed log of ${repo} run ${runId} names no failing test file for \`${jobName}\`` } : { files };
  } catch (cause) {
    return { cannotAsk: `could not read the failed log of ${repo} run ${runId} (${firstLine(cause)})` };
  }
}

/**
 * THE VERDICT. Asks nothing for a repository with no leg (the primary, one the project does not declare): `clear`, with ZERO `gh`
 * calls. Otherwise: the PR head's leg, and only when it is red the newest trunk verdict run's leg, and only when the difference is not
 * empty the body's declaration and the row it names. A leg that is not `failure` is `clear`.
 *
 * `cannot-ask` IS A REFUSAL TO ARM, as for an unreadable label list: a log or a run that could not be read is not a red that is
 * inherited. It is never `clear`.
 *
 * @param {{ number: string | number, repo: string, prBody: string | null | undefined, run: Run,
 *   codeRepositories?: readonly { key: string, repo: string }[] }} pr `codeRepositories` is the project's declared set, read from its declaration when omitted
 * @returns {CrossRepoRedVerdict}
 */
export function crossRepoRedVerdict({ number, repo, prBody, run, codeRepositories }: {
  number: string | number; repo: string; prBody: string | null | undefined; run: Run; codeRepositories?: readonly { key: string; repo: string }[];
}): CrossRepoRedVerdict {
  let source: TrunkSource | null;
  try {
    source = legSourceOf(repo, codeRepositories ?? homeProjectDeclaration().code);
  } catch (cause) {
    return { kind: "cannot-ask", why: `the project's declared code repositories were not read, so whether ${repo} has a cross-repo leg is unknown (${firstLine(cause)})` };
  }
  if (source === null) return { kind: "clear" };

  // The PR's head, and its leg.
  let leg: Leg | undefined;
  try {
    const { checks, total } = checkRunsOfHead(repo, headOfChange(repo, number, run), run);
    leg = checks.find((check) => CROSS_REPO_LEG.test(String(check?.name)));
    // A page that was not read may hold the leg: absence is not proof.
    if (leg === undefined && total > checks.length) throw new Error(`${total} check runs exist and ${checks.length} were read`);
  } catch (cause) {
    return { kind: "cannot-ask", why: `the cross-repo leg of #${number}'s head was not read (${firstLine(cause)})` };
  }
  if (leg === undefined || leg.conclusion !== "failure") return { kind: "clear" };

  const prRun = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(String(leg.details_url ?? ""))?.[1];
  if (prRun === undefined) return { kind: "cannot-ask", why: `the cross-repo leg of #${number} failed and names no run (${leg.details_url ?? "no details_url"}), so its failing files are unread` };
  const own = filesOfLeg({ repo, runId: prRun, jobName: leg.name, run });
  if ("cannotAsk" in own) return { kind: "cannot-ask", why: `#${number}'s cross-repo leg failed and ${own.cannotAsk}` };

  // The newest trunk verdict run: the gate's own definition of red `main` (`newestVerdictRun`), over the events `readTrunkRed` asks.
  let trunk: ReturnType<typeof newestVerdictRun>;
  let trunkLeg: Leg | undefined;
  try {
    const runs = source.eventFilters.flatMap((filter) => workflowRunsOf(repo, source.workflow, filter, run));
    trunk = newestVerdictRun({ workflow_runs: runs });
    if (trunk === null) throw new Error(`${repo} has no completed ${source.workflow} run on main`);
    trunkLeg = jobsOfRun(repo, trunk.id, run).find((job) => CROSS_REPO_LEG.test(String(job?.name)));
    if (trunkLeg === undefined) throw new Error(`run ${trunk.id} has no cross-repo job`);
  } catch (cause) {
    return { kind: "cannot-ask", why: `#${number}'s cross-repo leg failed on ${own.files.join(", ")} and the newest trunk run could not be compared with (${firstLine(cause)})` };
  }
  let inherited: string[] = [];
  if (trunkLeg.conclusion === "failure") {
    const theirs = filesOfLeg({ repo, runId: String(trunk.id), jobName: trunkLeg.name, run });
    if ("cannotAsk" in theirs) return { kind: "cannot-ask", why: `#${number}'s cross-repo leg failed on ${own.files.join(", ")} and the newest trunk run's leg failed too and ${theirs.cannotAsk}` };
    inherited = theirs.files;
  } else if (trunkLeg.conclusion !== "success") {
    return { kind: "cannot-ask", why: `#${number}'s cross-repo leg failed on ${own.files.join(", ")} and the newest trunk run's leg read ${trunkLeg.conclusion ?? "unfinished"}, which says nothing to compare with` };
  }
  const added = own.files.filter((file) => !inherited.includes(file));
  // THE RED IS `main`'S OWN ALREADY: the pull request did not add it.
  if (added.length === 0) return { kind: "clear" };

  const named = `${added.length === 1 ? "a test file" : `${added.length} test files`} the newest trunk run (${trunk.html_url}, ${trunk.conclusion}) did not fail: ${added.join(", ")}`;
  const todo = `Add a line \`${DECLARATION}: <ticket>\` to the PR body naming the ticket that owns greening the leg (its key, for example \`A11-123\`)`;
  const refuse = (reason: string): CrossRepoRedVerdict => ({ kind: "cross-repo-red", files: added,
    why: `the cross-repo leg of #${number} fails on ${named}, and ${reason}. ${todo}` });
  if (typeof prBody !== "string") return { kind: "cannot-ask", why: `#${number}'s cross-repo leg fails on ${named}, and the PR body was not read, so its \`${DECLARATION}:\` line is unknown` };
  const { tickets, malformed } = declaredTickets(prBody);
  if (malformed.length > 0) return refuse(`its \`${DECLARATION}:\` line is malformed (${malformed.map((text) => `\`${text}\``).join(", ")} is not a ticket key such as \`A11-123\`)`);
  if (tickets.length === 0) return refuse(`its body carries no \`${DECLARATION}:\` line`);
  return { kind: "clear" };
}

/** The line that makes a once-only comment findable again; the files are in it, so a CHANGED set is said afresh. */
export const crossRepoRedMarker = (files: readonly string[]) => `<!-- arm-refused: cross-repo-red ${[...files].sort().join(",")} -->`;
