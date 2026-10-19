#!/usr/bin/env node
// command: run a PR's own stated Acceptance/Refutation command(s) and report RAN/REFUSED/MISSING
// NOTHING HAS EVER RUN A ROW'S ACCEPTANCE COMMAND -- pipeline unit 2, #353. Every PR body in this repo
// carries an `Acceptance:` line and its own PR argues its case; the only thing that has ever executed it
// is the author, reporting the result in prose. `capture-check` was mandatory after any `capture-core.mjs`
// change and had never run once; `scorer:verify` was a security check on the one artefact this project
// publishes and nothing invoked it; `release:gate` was broken from the day it was written. Every one of
// those was found the first time something actually ran it. This is the thing that actually runs it.
//
// THREE OUTCOMES, AND THEY MUST NEVER COLLAPSE INTO TWO:
//
//   RAN      the command executed here, in this job, on the fork's own code with a read-only token --
//            its exit code IS the verdict.
//   REFUSED  the command needs the fleet, the lab, or `runs/` -- named, and this never gates on it. A
//            GitHub-hosted runner has no Windows worker and no Proxmox, and `runs/` is gitignored so any
//            corpus-reading gate here would examine nothing and report cleanly -- CLAUDE.md's own rule,
//            "A GATE THAT READS runs/ IS NOT YOURS TO REPORT".
//   MISSING  no acceptance line at all. THE JOB FAILS. A check that finds nothing, runs nothing and
//            reports green is this repository's most-recorded defect wearing a pipeline's clothes -- the
//            `postSubmitFields` empty on all 2,122 captures, the signal-type regex that scraped nothing
//            and asserted over an empty set, the `sweepLog` guard written against a shape nobody verified.
//
// A DELIBERATE, STATED OPT-OUT IS NOT THE SAME AS SILENCE. `Acceptance: none — <reason>` is accepted and
// treated as an honest pass (nothing to run, nothing hidden) -- but the reason is REQUIRED. "Nobody wrote
// one" and "this row deliberately has none" must read as different states, or the second becomes cover
// for the first.
//
// SCOPED TO `Acceptance:` ONLY, DELIBERATELY -- not `Mutation:`. A mutation check edits a real file (even
// restored, it is a mutating, slower operation than this job is built to gate every PR on); #353's own
// region names `packages/agent-org/src/acceptance-commands.ts`, not a mutation runner, and folding the two together
// would make "did the acceptance command pass" wait on something with a different risk profile and cost.
//
// #471: THIS JOB ALSO REQUIRES A `Closes:` DECLARATION, on the identical shape -- `Closes #N`,
// `Closes: none — <reason>`, or the job FAILS. Built after #468 (the first PAT-armed merge) proved the
// closing pipeline works and, in the same run, exposed that a PR is allowed to declare nothing at all: its
// row stayed open while the work that closed it landed on main, and nothing said so. See
// `closesDeclarationReport` below; it NEVER infers a row from a branch name or title.
//
// THIS PARSER READS SEVERAL NAMED SECTIONS OUT OF AUTHOR-WRITTEN PROSE, AND EVERY READER OF IT MUST
// DECIDE EXPLICITLY WHETHER IT TAKES THE FIRST MATCH OR ALL OF THEM -- the default of "first" has now
// been wrong twice, in two different functions, on two different fields of the same document. #527:
// `extractClosesDeclaration`'s single `.exec()` reported only the first of two separate `Closes` lines,
// silently truncating a fact GitHub itself still honoured in full. #540 was the second: `extractSection`'s
// `lines.findIndex()` did the identical thing to a second `Acceptance:`/`Refutation:` header, except it
// failed SILENTLY rather than truncating -- fed `"Acceptance: pnpm test\n\ntext\n\nAcceptance: pnpm run
// lint"`, it reported `{commands: ["pnpm test"]}` with no trace the second header ever existed. Neither
// function chose "first" on purpose; it fell out of `findIndex`/`.exec()` being the obvious call, twice.
//
// #527 AND #540 CHOSE DIFFERENT REMEDIES, DELIBERATELY -- read `headerIndices`' own comment before
// assuming the fix here is "do what #527 did". `Closes #A`/`Closes #B` is a form GitHub itself accepts and
// closes both for, so concatenating every match was the honest reading of an established convention.
// Two `Acceptance:` blocks is not an established convention in this repo at all, so #540 does not guess
// that the author meant "run every command from every section" -- it reports the ambiguity as a DUPLICATE
// and fails the job, naming every occurrence, and leaves concatenation as a decision nobody has actually
// asked for yet.
//
// Read this before adding a fourth section reader.
//
// `pull_request`, NEVER `pull_request_target` -- wired in `ci.yml`, not here, but the reason belongs next
// to the code that makes it safe: this module runs the AUTHOR'S OWN commands from a PR body, so it must
// only ever run under the fork's read-only token and the fork's own checked-out code. Nothing in this
// file grants itself write access; it doesn't need to.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { pnpmCliInvocation } from "./lib/npm-cli-executable.ts";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { ciInputOf, runCiBodyReports, thisPullRequestInput, type BodyReportInput } from "./acceptance-commands/unmet-command-closure-requirements.ts";
import { runAcceptanceCommand } from "./acceptance-commands/suite-scripts-for.ts";

/**
 * agent-org#1502 (ADR 0045 cut c, a11ign#5460): WHO MAY HAVE ITS ACCEPTANCE COMMAND RUN ON THE ORG SIDE, AND WHERE.
 *
 * WHERE: the HOST GATE, on a pull request it already reads (plan a11ign#928 section 2: what starts it is an event on a11ign, so the gate and not a
 * scheduled workflow). It runs the command in its own checkout of the pull request's merge ref, as the engineer's `pr:open` already ran the same
 * command in the engineer's worktree: the command's author and its runner are one trust domain, which is the whole of why it may run there.
 *
 * WHO: a pull request is eligible only when ALL FOUR hold, and every doubt is "not eligible", never "eligible":
 *   1. GitHub says it is not from a fork (`isCrossRepository === false`), read and never inferred from a name;
 *   2. when `headRepository` names a repository, it is the base repository (a second reading of 1, which can only refuse);
 *   3. its branch is `agent/*`, the branch family the org's sessions open;
 *   4. its author is an identity the host declares: `byDeclaredIdentity` is `review-trust.ts`'s `reviewTrustOf(pr, declared) === INSIDE`, the one trust
 *      decision the reviewer already uses, INJECTED and not imported -- that module reaches `gh`, and importing it here would charge a token to every
 *      acceptance command whose closure includes this file (`packaging/board-snapshot-scope.test.ts` and #621's self-reference pin say so).
 * An outside pull request meets NONE of this: no checkout, no process, no read of its body past the fields above.
 *
 * `reason` is the sentence a person reads, so each refusal names the first rule that failed.
 */
export type OrgSidePullRequest = {
  number?: unknown; headRefName?: unknown; headRefOid?: unknown; isCrossRepository?: unknown; body?: unknown;
  headRepository?: { name?: unknown; nameWithOwner?: unknown; } | null; author?: { login?: unknown; } | null;
};
export const ORG_SIDE_BRANCH_PREFIX = "agent/";

export function orgSideAcceptanceEligibility(pr: OrgSidePullRequest | null | undefined, { byDeclaredIdentity, baseRepo }: { byDeclaredIdentity: (pr: OrgSidePullRequest) => boolean; baseRepo: string; }):
  { eligible: true; } | { eligible: false; reason: string; } {
  const no = (reason: string) => ({ eligible: false as const, reason });
  if (pr === null || pr === undefined) return no("no pull request was read");
  if (pr.isCrossRepository !== false) return no(pr.isCrossRepository === true ? "it is from a fork" : "GitHub did not say whether it is from a fork, and unreadable is outside");
  const head = pr.headRepository;
  const named = typeof head?.nameWithOwner === "string" ? head.nameWithOwner : typeof head?.name === "string" ? head.name : null;
  if (named !== null && named.toLowerCase() !== baseRepo.toLowerCase() && named.toLowerCase() !== baseRepo.split("/").at(-1)?.toLowerCase()) {
    return no(`its head repository is \`${named}\`, not \`${baseRepo}\``);
  }
  if (typeof pr.headRefName !== "string" || !pr.headRefName.startsWith(ORG_SIDE_BRANCH_PREFIX)) return no(`its branch is not \`${ORG_SIDE_BRANCH_PREFIX}*\``);
  if (!byDeclaredIdentity(pr)) return no(`its author \`${String(pr.author?.login ?? "")}\` is not an identity the host declares`);
  return { eligible: true };
}

/** `pass` and `fail` are the command's own verdict at `head`; `not-run` is every other state, which ARMS NOTHING (an unread verdict is not a pass). */
export type OrgSideVerdict = { kind: "pass" | "fail" | "not-run"; head: string | null; lines: string[]; why: string; };

/**
 * The org side's run of ONE pull request's acceptance family, behind {@link orgSideAcceptanceEligibility}. `checkout` and `report` are the seams, and the
 * test of "an outside pull request executes nothing" is that neither is called for it: `checkout` is the only thing that puts the pull request's files
 * on the host and `report` the only thing that runs its text. A checkout that throws, a body that is not text and a head the checkout does not hold are
 * `not-run`, never `pass`.
 *
 * @param checkout the directory holding the merge of this head into the base, or a throw saying why not; given the head it must hold
 * @param prepare makes that directory runnable (its dependencies installed). A throw is `not-run`, NEVER `fail`: a checkout that could not be prepared
 *   says nothing about the pull request, and a fresh worktree has no `node_modules` (the first real run, a11ign#5555, failed `rstest not found` for that reason)
 */
export function orgSideAcceptanceVerdict(pr: OrgSidePullRequest | null | undefined, { byDeclaredIdentity, baseRepo, checkout, prepare = () => {}, report = defaultOrgSideReport, release = () => {}, rowLabels }: {
  byDeclaredIdentity: (pr: OrgSidePullRequest) => boolean; baseRepo: string; checkout: (head: string, number: number) => string; prepare?: (cwd: string) => void;
  report?: (input: BodyReportInput, cwd: string) => { ok: boolean; lines: string[]; }; release?: (cwd: string) => void; rowLabels?: BodyReportInput["rowLabels"];
}): OrgSideVerdict {
  const eligibility = orgSideAcceptanceEligibility(pr, { byDeclaredIdentity, baseRepo });
  if (!eligibility.eligible) return { kind: "not-run", head: null, lines: [], why: `not run on the org side: ${eligibility.reason}` };
  const head = typeof pr?.headRefOid === "string" && pr.headRefOid !== "" ? pr.headRefOid : null;
  const number = Number(pr?.number);
  if (head === null || !Number.isInteger(number)) return { kind: "not-run", head, lines: [], why: "not run: the pull request's head or number was not read" };
  if (typeof pr?.body !== "string") return { kind: "not-run", head, lines: [], why: "not run: the pull request's body was not read" };
  let cwd: string;
  try {
    cwd = checkout(head, number);
  } catch (error) {
    return { kind: "not-run", head, lines: [], why: `not run: no checkout at ${head.slice(0, 8)} (${String((error as Error).message ?? error).split("\n")[0].slice(0, 160)})` };
  }
  let result: { ok: boolean; lines: string[]; };
  try {
    try {
      prepare(cwd);
    } catch (error) {
      return { kind: "not-run", head, lines: [], why: `not run: the checkout at ${head.slice(0, 8)} could not be prepared (${String((error as Error).message ?? error).split("\n")[0].slice(0, 160)})` };
    }
    result = report(thisPullRequestInput(pr.body, cwd, String(pr.author?.login), { run: (command) => runAcceptanceCommand(command, { cwd }), ...(rowLabels === undefined ? {} : { rowLabels }) }), cwd);
  } finally {
    release(cwd);
  }
  return { kind: result.ok ? "pass" : "fail", head, lines: result.lines, why: result.ok ? `acceptance passed at ${head.slice(0, 8)}` : `acceptance FAILED at ${head.slice(0, 8)}` };
}

/**
 * agent-org#1579 (the epic "agent-org stands alone", a11ign#928): THE OUTSIDE HOME OF a11ign's `acceptance` JOB, SHIPPED OFF, AND SHADOW WHEN ON.
 *
 * The flag is `outside.acceptance` in the project's `.agent-org/decisions.json`; the caller reads it with `decision-provider.ts`'s `readSwitches` (absent = off) and hands
 * the record here, so this file imports no reader that reaches `gh` (the #1502 note on `byDeclaredIdentity` is the same reason). OFF: nothing is checked out, run or read.
 * ON: the verdict {@link orgSideAcceptanceVerdict} gives is RECORDED beside the job's, and `blocks` is the literal `false`: a shadow verdict arms nothing and holds nothing,
 * and the job stays in `gate`'s `needs`. Revert is the flag set `false`.
 *
 * THE FIRST READ (what the job does that the outside home did not, a11ign#928 section 3 named the commands and not their equivalence): the job's `class` report reads the labels of
 * the rows a pull request closes (`ACCEPTANCE_ROW_LABELS`), and the #1502 verdict handed it no reader, so it said NOT CHECKED where the job said pass or fail. `rowLabels` is now a seam of the verdict.
 * Not built here, said so: the job's Dependabot wait for a body is moot (only `agent/*` by a declared identity is eligible) and its `History: full` deepen is moot in the host's full clone.
 */
export const OUTSIDE_ACCEPTANCE_FLAG = "outside.acceptance";
export const outsideAcceptanceOn = (switches: Readonly<Record<string, unknown>> | null | undefined): boolean => switches?.[OUTSIDE_ACCEPTANCE_FLAG] === true;

/** `agree`: the same pass or fail as the job. `disagree`: the two differ, which the canary counts. `not-compared`: the home did not run, or the job's verdict was not read. */
export type ShadowAcceptance =
  | { on: false; }
  | { on: true; blocks: false; verdict: OrgSideVerdict; job: "pass" | "fail" | null; agreement: "agree" | "disagree" | "not-compared"; };

export function shadowAcceptanceVerdict(pr: OrgSidePullRequest | null | undefined, { switches, job = null, verdictOf, ...seams }: {
  switches: Readonly<Record<string, unknown>> | null | undefined; job?: "pass" | "fail" | null;
  /** agent-org#1579: a caller that remembers verdicts by head (the gate's `familyOf`) hands its own; `seams` are then not used. */
  verdictOf?: (pr: OrgSidePullRequest | null | undefined) => OrgSideVerdict;
} & Parameters<typeof orgSideAcceptanceVerdict>[1]): ShadowAcceptance {
  if (!outsideAcceptanceOn(switches)) return { on: false };
  const verdict = verdictOf === undefined ? orgSideAcceptanceVerdict(pr, seams) : verdictOf(pr);
  const agreement = verdict.kind === "not-run" || job === null ? "not-compared" : verdict.kind === job ? "agree" : "disagree";
  return { on: true, blocks: false, verdict, job, agreement };
}

const defaultOrgSideReport = (input: BodyReportInput) => runCiBodyReports(input);

/**
 * THE DEFAULT CHECKOUT: `refs/pull/<n>/merge` fetched into a detached worktree under `scratch`, which is what CI's `pull_request` checkout is and what
 * `changedFilesOfThisPullRequest` reads (HEAD a merge commit, first parent the base). The merge ref is GitHub's and may be stale, so its second parent
 * must BE the head the gate asked about; a stale one throws. `git` is the seam so a test needs no remote.
 */
export function checkoutPullRequestMerge({ repoRoot, scratch, git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() }) }: {
  repoRoot: string; scratch: string; git?: (args: string[], cwd: string) => string;
}): (head: string, number: number) => string {
  return (head, number) => {
    git(["fetch", "--quiet", "origin", `refs/pull/${number}/merge`], repoRoot);
    const merged = git(["rev-parse", "FETCH_HEAD"], repoRoot).trim();
    const parents = git(["rev-list", "--parents", "-n", "1", merged], repoRoot).trim().split(/\s+/).slice(1);
    if (parents[1] !== head) throw new Error(`the merge ref's head is ${String(parents[1]).slice(0, 8)}, not ${head.slice(0, 8)}`);
    const dir = join(scratch, `pr-${number}-${head.slice(0, 12)}`);
    git(["worktree", "add", "--detach", "--force", dir, merged], repoRoot);
    return dir;
  };
}

/**
 * The `prepare` of {@link checkoutPullRequestMerge}: the checkout's own lockfile, installed from the host's store with NO network and NO lifecycle scripts,
 * so what runs next is the pull request's command and nothing an install pulled in. A tree that is not a pnpm workspace has no lockfile and needs none.
 */
export function installPullRequestCheckout({ run = (cwd: string) => {
  const pnpm = pnpmCliInvocation(["install", "--frozen-lockfile", "--offline", "--ignore-scripts"]); // the helper, not a bare `pnpm` (no-npm-spawn.test.ts: `pnpm.cmd` on Windows)
  execFileSync(pnpm.command, pnpm.args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}, exists = existsSync }: {
  run?: (cwd: string) => void; exists?: (path: string) => boolean;
} = {}): (cwd: string) => void {
  return (cwd) => { if (exists(join(cwd, "pnpm-lock.yaml"))) run(cwd); };
}

/** The `release` of {@link checkoutPullRequestMerge}: the worktree it added is removed, so a tick leaves no checkout of a pull request's files behind. */
export function releasePullRequestCheckout({ repoRoot, git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() }) }: {
  repoRoot: string; git?: (args: string[], cwd: string) => string;
}): (cwd: string) => void {
  return (cwd) => { git(["worktree", "remove", "--force", cwd], repoRoot); };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/acceptance-commands.ts" });
  // FROM AN ENV VAR, NEVER ARGV -- a PR body is adversarial input (anyone can open a PR), and passing it
  // as a shell argument would put it on a command line for something else to misinterpret. GitHub Actions'
  // own `env:` mapping is what keeps it a single opaque string here, never re-parsed as shell.
  const result = runCiBodyReports(ciInputOf(process.env));
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

// The package declares these names for its callers (public-interface.test.ts): they stay on this entry, declared in the file below.
export { extractClosesDeclaration, closesReferences, acceptanceSourceOfThisPullRequest, prAuthorFromEnv } from "./acceptance-commands/unmet-command-closure-requirements.ts";
export { hasFullHistoryDeclaration } from "./acceptance-commands/classification.ts";
