// agent-org#1501 (ADR 0045 cut c; a11ign/a11ign#5460): THE HOST GATE'S RECEIVING SIDE of what a11ign's `deliberateRefusals` job refused. It lives in its own file, not
// in `closes-mismatch-check.ts`, because that file is imported by the work gate's reads and this one imports the merge guard: the two in one file made an import
// cycle that left `work-gate/reads.ts` asking for its own budget before it was initialised.
import { readFileSync } from "node:fs";
import { acceptanceSourceOf } from "./acceptance-commands/unmet-command-closure-requirements.ts";
// agent-org#1578: THE FLAG'S READER IS THE DECISION SWITCHES', the one every `decisions.json` key is read through (absent file = off; a file that cannot be used = off, said once).
import { readSwitches } from "./decision-provider.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";
import { sourceLine } from "./acceptance-file.ts";
import { lookup, lookupClosingIssues, lookupRecentClosesPrs } from "./merge-guard/lookups.ts";
import { mergeSafetyVerdict, lookupTestsFirstFacts } from "./merge-guard/safety-verdict.ts";
import { approvalFactsOf } from "./ticket-port/approval-reads.ts";
import { addedFilesTextOf, branchRefTextOf, defaultBranchFileTextOf, fileAtTextOf, pullTextOf } from "./ticket-port/deliberate-refusal-reads.ts";
import { ORG_LOGINS } from "./messaging/sources/readers.ts";
import {
  closesVerdictOf, lookupClaimedRowsOfTrackers, lookupOpenClaimedRows, trackerReposFor, type ClosesFacts,
} from "./closes-mismatch-check.ts";

/** agent-org#1578: THE KEY IN A PROJECT'S `.agent-org/decisions.json` THAT LETS AGENT-ORG ASK, FROM OUTSIDE THE PROJECT, WHAT ITS `deliberateRefusals` JOB ASKS. Absent is off; ON is SHADOW: the verdict is recorded and blocks nothing. */
export const OUTSIDE_REFUSALS_FLAG = "outside.refusals";

/** Is the outside home of the deliberate refusals switched on for the project whose `decisions.json` is at `switchesPath`? Only the literal `true` is on, as for `outside.arm`. */
export function outsideRefusalsOn(switchesPath: string, { read = readFileSync, diagnostic = printDiagnostic, state = processState }: { read?: typeof readFileSync; diagnostic?: (line: string) => void; state?: typeof processState; } = {}): boolean {
  return (readSwitches(switchesPath, { diagnostic, state, read }) as Record<string, boolean | undefined>)[OUTSIDE_REFUSALS_FLAG] === true;
}

export type DeliberateRefusal = { kind: "clear"; } | { kind: "refused" | "cannot-ask"; why: string; };

/** The seams `deliberateRefusalVerdict` reads through: `run` is the caller's `gh`; the rest default to reads made through it. */
export type DeliberateRefusalReads = { branchTip?: (branch: string) => string | null; facts?: (body: string, pull: PullFacts) => ClosesFacts; };
type PullFacts = { number: number; repo: string; headSha: string; headRef: string; author: string | null; };

const tipOf = (repo: string, run: (args: string[]) => string, branch: string): string | null =>
  lookup(() => {
    const sha = JSON.parse(branchRefTextOf(repo, branch, run)).object?.sha;
    return typeof sha === "string" && sha !== "" ? sha : null;
  });

/** The facts of the comparison read through `run`, for a pull request of `repo` at `head`: the acceptance file comes from the contents API at that commit, not from a checkout. */
function hostFacts(run: (args: string[]) => string, body: string, pull: PullFacts): ClosesFacts {
  return {
    resolved: () => lookupClosingIssues(pull.number, pull.repo, run),
    claimed: {
      head: () => ({ branch: pull.headRef, fork: false }),
      rows: (repo) => lookupClaimedRowsOfTrackers(trackerReposFor(repo), (tracker) => lookupOpenClaimedRows(tracker, run)),
    },
    acceptance: () => {
      let added: string[] | undefined;
      try {
        added = addedFilesTextOf(pull.repo, pull.number, run)
          .split("\n").filter(Boolean);
      } catch { /* an unread diff resolves the body's own block, which is what `resolveAcceptanceSource` does for an absent list */ }
      const source = acceptanceSourceOf({
        body, run: () => 0, diff: added === undefined ? { ok: false, why: "the changed files could not be read" } : { ok: true, files: added, added },
        readFile: (path) => fileAtTextOf(pull.repo, path, pull.headSha, run),
        author: pull.author ?? undefined,
      });
      return { text: source.kind === "file" || source.kind === "body" ? source.text : null, named: sourceLine(source) };
    },
    consumerFile: (repo, path) => lookup(() => defaultBranchFileTextOf(repo, path, run)),
    recent: () => lookupRecentClosesPrs(run),
  };
}

/**
 * WHAT a11ign's `deliberateRefusals` JOB REFUSED, ASKED OF ONE PULL REQUEST BEFORE THE HOST ARMS IT (agent-org#1501). That job ran two commands on every
 * pull request: `merge-guard --ci-gate` (the `hold:` label and the head GitHub recorded against the branch's real tip) and this file's comparison of the
 * declared `Closes` with what GitHub will close. Neither was run by the gate: it names `deliberateRefusals` as one of the two jobs a hold turns red, and
 * the arming door (`arm-pr`) asked the hold alone. So a head that was not the tip, or a `Closes` GitHub would not honour, was refused by that job and by
 * nothing else, and the job leaving `gate`'s `needs` (a11ign/a11ign#5460) would have let both through to the merge.
 *
 * THE VERDICTS ARE THE JOB'S OWN, NOT COPIES: `mergeSafetyVerdict` for the first (its approvals and tests-first reads included, because `--ci-gate` asked
 * them) and `closesVerdictOf` for the second, so a reason says what a11ign's log said. The shape is the arming doors' (`clear`, or `refused` / `cannot-ask`
 * with a `why`), and `cannot-ask` is a refusal to arm: a read that failed is not a pull request that passed.
 *
 * AGENT PULL REQUESTS ONLY (ADR 0045 D4): a pull request whose head is in a fork, or whose author is no org identity (`ORG_LOGINS`, REST's spelling
 * included), is `clear` here -- an outside contributor never meets the org's process. The author is the PR's own `user.login`, never the branch name or
 * the body, which the author controls. A pull request that is not open asks nothing: there is nothing left to arm.
 *
 * @param pr `repo` is `owner/name`, and `run` the caller's own `gh`, so the identity and the call census are the caller's; `author` is the login the caller
 *   already read, which is only ever used to say "no org identity" sooner, never to say "an org identity" (the pull request's own `user.login` decides that)
 */
export function deliberateRefusalVerdict({ number, repo, run, author: knownAuthor, reads = {} }: {
  number: number | string; repo: string; run: (args: string[]) => string; author?: string | null; reads?: DeliberateRefusalReads;
}): DeliberateRefusal {
  // A caller that already holds the author (`arm-pr` and the sweep both read it) spares an outside pull request every read below: no org identity, no refusal.
  if (typeof knownAuthor === "string" && knownAuthor !== "" && !ORG_LOGINS.includes(knownAuthor)) return { kind: "clear" };
  let pull: any;
  try {
    pull = JSON.parse(pullTextOf(repo, number, run));
  } catch (cause) {
    return { kind: "cannot-ask", why: `could not read #${number} to ask whether it may merge: ${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}` };
  }
  const author: string | null = typeof pull?.user?.login === "string" ? pull.user.login : null;
  const headRepo = pull?.head?.repo?.full_name;
  const sameRepository = typeof headRepo === "string" && headRepo === pull?.base?.repo?.full_name;
  if (pull?.state !== "open" || !sameRepository || author === null || !ORG_LOGINS.includes(author)) return { kind: "clear" };
  const headSha = String(pull?.head?.sha ?? ""), headRef = String(pull?.head?.ref ?? "");
  if (headSha === "" || headRef === "") return { kind: "cannot-ask", why: `#${number} names no head commit or branch, so whether it may merge is unknown` };
  const names = Array.isArray(pull.labels) ? pull.labels.map((label: { name?: unknown; }) => label?.name) : null;
  const prLabels = names !== null && names.every((name: unknown) => typeof name === "string") ? (names as string[]) : null;
  const body = typeof pull.body === "string" ? pull.body : "";
  const safety = mergeSafetyVerdict({
    pr: { number: Number(number), state: "open", headRefOid: headSha },
    branchTip: (reads.branchTip ?? ((branch) => tipOf(repo, run, branch)))(headRef),
    prLabels,
    approvals: approvalFactsOf({ repo, number: Number(number), head: headSha }, run),
    testsFirst: lookupTestsFirstFacts({ number: Number(number), head: headSha, author, body }, { run, repo }),
  });
  if (safety.code !== 0) return { kind: safety.code === 1 ? "refused" : "cannot-ask", why: safety.reasons.join("\n") };
  const pullFacts: PullFacts = { number: Number(number), repo, headSha, headRef, author };
  const closes = closesVerdictOf(body, Number(number), repo, (reads.facts ?? ((text, facts) => hostFacts(run, text, facts)))(body, pullFacts));
  if (closes.exit === 0) return { kind: "clear" };
  return { kind: closes.exit === 1 ? "refused" : "cannot-ask", why: closes.lines.join("\n") };
}
