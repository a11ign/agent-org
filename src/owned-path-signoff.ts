#!/usr/bin/env node
// @ts-check
// command: check a PR touching a corpus-invalidating path named the facts its own body must state
/**
 * A CHANGE TO A CORPUS-INVALIDATING PATH MUST NAME THE FACTS IT DID NOT MOVE — #356.
 *
 *   node packages/agent-org/src/owned-path-signoff.ts --diff=<file of changed paths> --body=<file with the PR body>
 *
 * ## Why a check and not a CODEOWNERS review
 *
 * `ceo`'s ruling, 2026-09-07, and the argument is measured rather than stylistic. Every agent session
 * pushes as the same account, so nobody can approve a PR here at all:
 *
 *     gh pr review 350 --approve
 *       failed to create review: GraphQL: Review Can not approve your own pull request
 *
 * And `main`'s protection carried `require_code_owner_reviews: true` with NO CODEOWNERS file — armed and
 * inert only because no path had an owner. Adding the file would have made every PR touching those paths
 * require an approval its own author could not give, with `enforce_admins: true` so nobody could bypass
 * it: a permanent block on exactly the paths where a mistake costs a corpus, arriving silently and
 * looking like correct configuration.
 *
 * **And a human approval would have caught none of the failures these paths have actually had.** Each was
 * a correct-looking change whose consequence was invisible at the diff: `browserVersion` memoised on
 * `bootConstant` and stale for five days; `refreshBrowseBuffer` guarded on a flag nothing ever set, inert
 * on every capture ever taken; the census stripped at export so no rule reading it could fire. A reviewer
 * sees a correct remedy, correctly commented, at the right call site, and passes all three.
 *
 * So this asks for FACTS, not diligence. "I checked" is refused by construction: the block must name each
 * fact and its state, and writing it is what forces the author to look.
 *
 * ## The fact list is DATA, and it is not this file's to decide
 *
 * `ceo`: *"Orchestrator writes the fact list; that is its code ownership expressed in a check."* So the
 * list lives in `owned-path-facts.json`, which `orchestrator` owns and may correct and extend without
 * touching this logic. What is here is the mechanism: which paths are owned, and whether a body names
 * every required fact with a state.
 *
 * ## It reports what it could not ask, and never treats that as a pass
 *
 * A missing diff file and an empty diff are different answers -- "I could not ask" and "nothing owned was
 * touched" -- and only one of them means the check is satisfied. Exit 2 is CANNOT_ASK throughout.
 */
import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { isAcceptancePath } from "./acceptance-file.ts";
import { isBrokenRed } from "./red-pr.ts";
import type { OrgSideVerdict } from "./acceptance-commands.ts"; // a type only: no load-time edge into the file that has a cycle with the gate

const EXIT = { SIGNED: 0, REFUSED: 1, CANNOT_ASK: 2 };
const REPO = HOME_CHECKOUT;

/**
 * The owned paths and the facts a change to them must state, read from the file `orchestrator` owns.
 *
 * READ, NEVER INLINED: the whole point of the ruling is that the list is the owner's expression of
 * ownership. A copy in this file would be a second spelling of it, and the two would drift -- which is
 * the shape this repository pays for most.
 *
 * @returns {{owned: string[], facts: {id: string, states: string[]}[]} | null}
 */
export function loadFacts(path = resolve(REPO, "docs/owned-path-facts.json")): { owned: string[]; facts: { id: string; states: string[]; }[]; } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.owned) || !Array.isArray(parsed?.facts)) return null;
    return parsed;
  } catch {
    return null;   // absent or malformed is CANNOT_ASK, never "nothing is owned"
  }
}

/**
 * Does this changed path fall under an owned prefix?
 *
 * Prefix matching on a directory boundary, so `packages/nvda-worker-notes/x` does not match
 * `packages/nvda-worker/`. A bare file path in the list matches exactly.
 *
 * @param {string} changed @param {string[]} owned
 */
export function isOwned(changed: string, owned: string[]) {
  if (isAcceptancePath(changed)) return false; // ADR 0044: a pull request's own acceptance file is no owner's path
  return owned.some((prefix) => (prefix.endsWith("/")
    ? changed.startsWith(prefix)
    : changed === prefix || changed.startsWith(`${prefix}/`)));
}

/**
 * Does `line` say `state`, as a WHOLE WORD? `"unchanged".includes("changed")` is true -- a bare substring
 * test reads one word as declaring two contradicting states of the same fact, purely because one state's
 * spelling contains another's (`environmentKey`'s real states are exactly this pair). Word boundaries are
 * what a reader uses to tell them apart, so the check must too.
 *
 * @param {string} line @param {string} state
 */
function mentionsState(line: string, state: string) {
  return new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line);
}

/**
 * Which fact "owns" a line, when it names more than one -- the fact whose id occurs FIRST. A table row
 * for `environmentKey` legitimately lists `provisionRevision` among the fields it hashes; a naive "any
 * fact id on this line" reading would credit environmentKey's OWN state word to provisionRevision too,
 * a false contradiction when provisionRevision's real declaration elsewhere disagrees with prose it never
 * made. Only the first-named fact on a line may claim that line's state word.
 *
 * @param {string} line @param {{id: string, states: string[]}[]} allFacts
 * @returns {{id: string, states: string[]} | null}
 */
function owningFact(line: string, allFacts: { id: string; states: string[]; }[]): { id: string; states: string[]; } | null {
  let owner = null;
  let earliest = Infinity;
  for (const fact of allFacts) {
    const at = line.indexOf(fact.id);
    if (at !== -1 && at < earliest) { earliest = at; owner = fact; }
  }
  return owner;
}

/**
 * Every line THIS fact owns (see `owningFact`) that also says one of its states -- and the set of states
 * they name. `find`-on-first-naming-line is wrong the moment prose explaining a fact precedes the line
 * that actually declares it; this walks every owned line, so a declaration anywhere in the body satisfies
 * the fact regardless of what comes before it.
 *
 * @param {string[]} lines @param {{id: string, states: string[]}} fact
 * @param {{id: string, states: string[]}[]} allFacts
 * @returns {{declaringLines: string[], statesNamed: Set<string>}}
 */
function factDeclarations(lines: string[], fact: { id: string; states: string[]; }, allFacts: { id: string; states: string[]; }[]): { declaringLines: string[]; statesNamed: Set<string>; } {
  const declaringLines = lines.filter((l) => owningFact(l, allFacts) === fact
    && fact.states.some((state) => mentionsState(l, state)));
  const statesNamed = new Set(
    declaringLines.flatMap((l) => fact.states.filter((state) => mentionsState(l, state))),
  );
  return { declaringLines, statesNamed };
}

/**
 * THE PURE VERDICT, so every state is exercisable without a PR.
 *
 * A fact is SATISFIED when SOME line names it AND says something about its state -- not just the first
 * line naming it, which is wrong the moment prose explaining the fact precedes the line that states it.
 *
 * A fact whose naming lines disagree on which state holds is a REAL FINDING, never silently resolved by
 * document order: refused with every disagreeing line quoted, distinct from a fact nobody stated at all.
 *
 * @param {{changed: string[] | null, body: string | null,
 *          facts: {owned: string[], facts: {id: string, states: string[]}[]} | null}} input
 * @returns {{code: number, reasons: string[]}}
 */
export function signoffVerdict({ changed, body, facts }: {
        changed: string[] | null; body: string | null;
        facts: { owned: string[]; facts: { id: string; states: string[]; }[]; } | null;
    }): { code: number; reasons: string[]; } {
  const missing = [
    changed === null && "the list of changed paths",
    body === null && "the pull request body",
    facts === null && "docs/owned-path-facts.json (absent or malformed)",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether this change is signed off: could not read ${missing.join("; ")}.\n`
      + "  INCONCLUSIVE, never clean -- a check that cannot ask must not report a pass.",
    ] };
  }
  const known = (facts as {owned: string[], facts: {id: string, states: string[]}[]});
  const touched = (changed as string[]).filter((p) => isOwned(p, known.owned));
  if (touched.length === 0) return { code: EXIT.SIGNED, reasons: [] };

  const lines = (body as string).split("\n");
  const unstated = [];
  const contradicted = [];
  for (const fact of known.facts) {
    const { declaringLines, statesNamed } = factDeclarations(lines, fact, known.facts);
    if (declaringLines.length === 0) { unstated.push(fact); continue; }
    if (statesNamed.size > 1) contradicted.push({ fact, lines: declaringLines });
  }
  if (unstated.length === 0 && contradicted.length === 0) return { code: EXIT.SIGNED, reasons: [] };

  const reasons = [];
  if (unstated.length > 0) {
    reasons.push(
      `This PR changes ${touched.length} owned path(s) -- ${touched.slice(0, 4).join(", ")}`
      + `${touched.length > 4 ? ", ..." : ""} -- and its body does not state:\n`
      + unstated.map((f) => `    ${f.id}  (say one of: ${f.states.join(", ")})`).join("\n")
      + "\n\n  These are the paths where a mistake costs a CORPUS rather than a revert, and every failure\n"
      + "  they have had looked correct at the diff. Name each fact and its state; \"I checked\" is refused\n"
      + "  by construction, because writing the state is what makes you look.",
    );
  }
  if (contradicted.length > 0) {
    reasons.push(
      "This PR's body names CONTRADICTING states for the same fact -- document order must not silently\n"
      + "  resolve which one is true:\n"
      + contradicted.map(({ fact, lines: ls }) =>
        `    ${fact.id}:\n${ls.map((l) => `      "${l.trim()}"`).join("\n")}`).join("\n"),
    );
  }
  return { code: EXIT.REFUSED, reasons };
}

/**
 * agent-org#1598 (the epic "agent-org stands alone", a11ign#928; a11ign#5549 ruled OPTION 2): THE OUTSIDE HOME OF a project's `ownedPaths` JOB, SHIPPED OFF, AND SHADOW WHEN ON.
 *
 * The job does two things: `git diff --name-only origin/<base>...HEAD` and `owned-path-signoff --diff --body`. THE FIRST READ: the outside has no equivalent of either ("none, built
 * here"), and needs no checkout for the first, because the open-pull-request payload the gate already reads carries `files` (and `changedFiles`, which says when the list is cut short)
 * and `body`. The owned paths are NOT copied: {@link loadFacts} reads the project's `docs/owned-path-facts.json` at the home checkout, so every path in its `owned` list is covered by
 * construction, and a path added there is covered the next tick. Not the same check as the one a11ign#5044 names (that covers `.github/workflows/`).
 *
 * The flag is `outside.ownedPaths` in the project's `.agent-org/decisions.json`; the caller reads it with `decision-provider.ts`'s `readSwitches` (absent = off) and hands the record
 * here. OFF: nothing is read or asked. ON: the verdict is RECORDED beside the job's and `blocks` is the literal `false`: a shadow verdict arms nothing and holds nothing, and the job
 * stays in `gate`'s `needs`. Revert is the flag set `false`. ADR 0045 D4: AGENT pull requests only; an outside pull request meets no sign-off request (it is `not-run` before the facts are read).
 *
 * KNOWN DIVERGENCES, for the canary's explanations: the job reads the facts file from the pull request's merge ref and this reads the home checkout's, so a pull request that edits the
 * facts file can differ; a pull request whose file list the payload cut short is `not-run`, never a pass.
 */
export const OUTSIDE_OWNED_PATHS_FLAG = "outside.ownedPaths";
export const outsideOwnedPathsOn = (switches: Readonly<Record<string, unknown>> | null | undefined): boolean => switches?.[OUTSIDE_OWNED_PATHS_FLAG] === true;

/** The project's `ownedPaths` job's verdict on a head, read off the pull request's check rollup already narrowed to the newest run per name: `pass` on SUCCESS, `fail` when `isBrokenRed`
 *  says the check is red, and `null` for everything else (absent, running, skipped for a prose-only body edit, cancelled), which the comparison reads as not-compared, never as agreement. */
export function ownedPathsJobOf(rollup: { name?: string; conclusion?: string | null; }[] | null | undefined): "pass" | "fail" | null {
  const run = (rollup ?? []).find((check) => /(^|[\s/])ownedPaths$/.test(String(check?.name ?? "")));
  if (run === undefined) return null;
  if (isBrokenRed({ statusCheckRollup: [run] })) return "fail"; // red is `isBrokenRed`'s to say (#2956 ONE DECIDER), asked of this one check alone
  return String(run.conclusion ?? "").toUpperCase() === "SUCCESS" ? "pass" : null;
}

/**
 * The org-side verdict of ONE pull request's owned-path sign-off: {@link signoffVerdict} over the payload's `files` and `body`. `eligible` is INJECTED (`orgSideAcceptanceEligibility`
 * bound), so an outside pull request is `not-run` BEFORE `facts` is called: it meets no sign-off request. A file list shorter than `changedFiles`, a body that is not text, and facts that
 * cannot be read are `not-run` (the check could not ask), never `pass`.
 */
export function ownedPathsVerdict(pr: any, { eligible, facts = () => loadFacts() }: {
  eligible: (pr: any) => { eligible: true; } | { eligible: false; reason: string; };
  facts?: () => { owned: string[]; facts: { id: string; states: string[]; }[]; } | null;
}): OrgSideVerdict {
  const refused = eligible(pr);
  if (!refused.eligible) return { kind: "not-run", head: null, lines: [], why: `owned-path sign-off not asked on the org side: ${refused.reason}` };
  const head = typeof pr?.headRefOid === "string" && pr.headRefOid !== "" ? pr.headRefOid : null;
  const notRun = (why: string): OrgSideVerdict => ({ kind: "not-run", head, lines: [], why: `owned-path sign-off not run: ${why}` });
  if (head === null) return notRun("the pull request's head was not read");
  if (typeof pr?.body !== "string") return notRun("the pull request's body was not read");
  const files = pr?.files;
  if (!Array.isArray(files) || files.some((file: any) => typeof file?.path !== "string")) return notRun("the pull request's file list was not read");
  if (!Number.isInteger(pr?.changedFiles) || pr.changedFiles > files.length) return notRun(`the file list is cut short (${files.length} of ${String(pr?.changedFiles)})`);
  const verdict = signoffVerdict({ changed: files.map((file: any) => String(file.path)), body: pr.body, facts: facts() });
  const short = head.slice(0, 8);
  if (verdict.code === EXIT.CANNOT_ASK) return { kind: "not-run", head, lines: verdict.reasons, why: `owned-path sign-off could not be asked at ${short}` };
  return verdict.code === EXIT.SIGNED
    ? { kind: "pass", head, lines: [], why: `owned-path sign-off satisfied at ${short}` }
    : { kind: "fail", head, lines: verdict.reasons, why: `owned-path sign-off REFUSED at ${short}` };
}

/** `agree`: the same pass or fail as the job. `disagree`: the two differ, which the canary counts. `not-compared`: the home did not run to an end, or the job's verdict was not read. */
export type ShadowOwnedPaths =
  | { on: false; }
  | { on: true; blocks: false; verdict: OrgSideVerdict; job: "pass" | "fail" | null; agreement: "agree" | "disagree" | "not-compared"; };

export function shadowOwnedPathsVerdict<PR>(pr: PR, { switches, job = null, verdictOf }: {
  switches: Readonly<Record<string, unknown>> | null | undefined; job?: "pass" | "fail" | null; verdictOf: (pr: PR) => OrgSideVerdict;
}): ShadowOwnedPaths {
  if (!outsideOwnedPathsOn(switches)) return { on: false };
  const verdict = verdictOf(pr);
  const agreement = verdict.kind === "not-run" || job === null ? "not-compared" : verdict.kind === job ? "agree" : "disagree";
  return { on: true, blocks: false, verdict, job, agreement };
}

/** @param {string | undefined} path @returns {string | null} */
const readOrNull = (path: string | undefined): string | null => {
  if (!path) return null;
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

function main() {
  refuseUnknownFlags(["--diff=", "--body=", "--facts="],
    { entry: import.meta.url, command: "node packages/agent-org/src/owned-path-signoff.ts" });
  const diffText = readOrNull(flagValue(process.argv, "diff"));
  const bodyText = readOrNull(flagValue(process.argv, "body"));
  const factsPath = flagValue(process.argv, "facts");
  const verdict = signoffVerdict({
    changed: diffText === null ? null : diffText.split("\n").map((l) => l.trim()).filter(Boolean),
    body: bodyText,
    facts: factsPath ? loadFacts(factsPath) : loadFacts(),
  });
  if (verdict.code === EXIT.SIGNED) {
    process.stdout.write("owned-path sign-off: satisfied.\n");
  } else {
    process.stderr.write(`${verdict.reasons.join("\n")}\n`);
  }
  process.exit(verdict.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
