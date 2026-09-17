#!/usr/bin/env node
// @ts-check
// command: check a PR touching a corpus-invalidating path named the facts its own body must state
/**
 * A CHANGE TO A CORPUS-INVALIDATING PATH MUST NAME THE FACTS IT DID NOT MOVE — #356.
 *
 *   node packages/agent-org/src/owned-path-signoff.mjs --diff=<file of changed paths> --body=<file with the PR body>
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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";

const EXIT = { SIGNED: 0, REFUSED: 1, CANNOT_ASK: 2 };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The owned paths and the facts a change to them must state, read from the file `orchestrator` owns.
 *
 * READ, NEVER INLINED: the whole point of the ruling is that the list is the owner's expression of
 * ownership. A copy in this file would be a second spelling of it, and the two would drift -- which is
 * the shape this repository pays for most.
 *
 * @returns {{owned: string[], facts: {id: string, states: string[]}[]} | null}
 */
export function loadFacts(path = resolve(REPO, "docs/owned-path-facts.json")) {
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
export function isOwned(changed, owned) {
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
function mentionsState(line, state) {
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
function owningFact(line, allFacts) {
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
function factDeclarations(lines, fact, allFacts) {
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
export function signoffVerdict({ changed, body, facts }) {
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
  const known = /** @type {{owned: string[], facts: {id: string, states: string[]}[]}} */ (facts);
  const touched = /** @type {string[]} */ (changed).filter((p) => isOwned(p, known.owned));
  if (touched.length === 0) return { code: EXIT.SIGNED, reasons: [] };

  const lines = /** @type {string} */ (body).split("\n");
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

/** @param {string | undefined} path @returns {string | null} */
const readOrNull = (path) => {
  if (!path) return null;
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

function main() {
  refuseUnknownFlags(["--diff=", "--body=", "--facts="],
    { entry: import.meta.url, command: "node packages/agent-org/src/owned-path-signoff.mjs" });
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
