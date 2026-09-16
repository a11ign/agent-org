// @ts-check
// command: compute whether a row is actually startable from the tree, never from a label alone
// IS THIS ROW STARTABLE? -- computed from the tree, never from a label.
//
// Ready showed four unclaimed rows, none `fleet-gated`, so by every label the lane read fully pickable.
// It was not. Measured 2026-09-07: the honest pickable count was 3 where the label count said 4, and on
// one earlier evening the true count was 1.
//
//   #143  held by an unmerged `lead/*` branch
//   #171  its step 1 is unreproducible on `main` -- the fixture is another row's unmerged groundwork
//   #186  `dirOnOriginMain` EXISTS ON NO REF BUT ONE, and that one is an open, conflicting PR
//
// **Every one of those rows is correctly classified.** They are `ready`, they are not `fleet-gated`, and
// nothing about their labels is wrong. The classification simply cannot express the fact, so the lane
// count is right about its labels and wrong about the work.
//
// NOT A LABEL, AND THAT IS THE WHOLE DESIGN. A hand-applied `blocked-behind-branch` is a fact stated
// twice and drifts the moment the branch merges, leaving a row marked blocked by something that landed --
// worse than no label, because it reads as current. This computes the answer at the moment it is asked.
//
// THE CHECK IS "DOES THIS ROW'S SUBJECT EXIST ON `main` YET", NOT "IS ANYONE ELSE IN THESE FILES".
// #186 is the case that forces the distinction and a naive implementation scores it CLEAR: nobody is
// editing `board-summary-check.mjs`, and the row is unstartable anyway because the function it is about
// is not in it. Region contention is the easier half and falls out of the same walk.
//
//   node packages/agent-org/src/row-reachability.mjs <issue-number>
//   node packages/agent-org/src/row-reachability.mjs --row=<issue-number>
//
// IT REPORTS; IT NEVER REFUSES A CLAIM. A row can be worth starting for reasons this cannot see -- the
// blocking PR may land in ten minutes, or the worker may intend to build on that branch deliberately.
// Exit codes say what was found, and `row-claim` prints it as a warning rather than acting on it: a check
// that blocks on an inference this coarse gets bypassed, and then it is not consulted at all.
//
// Exit codes are the contract:
//   0  STARTABLE   -- the subject is on `main` and no unmerged branch is in its region
//   1  BLOCKED     -- and it NAMES what on, because "wait" and "wait for X" are different instructions
//   2  CANNOT ASK  -- a lookup failed. INCONCLUSIVE, never "startable": reporting an unaskable question
//                     as clear is how a worker loses an evening at step 1
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { regionPathsFromBody, declaredRegionFiles } from "./region-paths.mjs";

const EXIT = { STARTABLE: 0, BLOCKED: 1, CANNOT_ASK: 2 };

/** @type {(args: string[]) => string} */
const git = (args) => execFileSync("git", args,
  { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
/** @type {(args: string[]) => string} */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// PATH extraction moved to `./region-paths.mjs` (#462, B4) -- a leaf module with no further imports, so
// `row-claim/file-overlap-rule.mjs` can read the SAME extraction this file uses without dragging this
// file's own `@a11ign/worker-fleet/cli-flags` import (fine for THIS file's `main()`, fatal before
// `npm ci`/`npm run build` if reached from a pre-install entry) into its import graph.

/**
 * IDENTIFIERS THE ROW IS ABOUT — the subject, as opposed to the region.
 *
 * A row names its subject in backticks: `dirOnOriginMain`, `RULE_CRITERIA`, `stalenessReason`. Only
 * multi-word-cased tokens are taken (camelCase or SCREAMING_SNAKE), because a lowercase backticked word
 * is far more often prose (`ready`, `main`, `git show`) than a symbol, and a check that treats every
 * quoted word as a subject reports every row blocked and is then ignored.
 */
const SYMBOL_IN_PROSE = /`([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]+_[A-Z0-9_]+)`/g;

/** @type {(values: string[]) => string[]} */
const unique = (values) => [...new Set(values)];

/**
 * #772: ZERO REFS IS A NARROWER ANSWER, NOT A CLEANER ONE.
 *
 * `unmergedRefs()` reads what this checkout has FETCHED, not what the remote holds, so a fresh clone
 * searches nothing: every symbol comes back carried by nobody and every region unheld. The verdict is
 * still the honest one available here — what it must not do is read like a search that happened.
 * @param {number} refs @returns {string[]}
 */
function unsearchedPopulationNote(refs) {
  if (refs > 0) return [];
  return ["  NOTE: this checkout has fetched NO unmerged remote branches, so the subject and region "
    + "searches had nothing to look at. `git fetch origin` and ask again for an answer with a population "
    + "behind it."];
}

/**
 * #1054: A CONTENTION ANSWER WITH NO POPULATION BEHIND IT, SAID RATHER THAN PRINTED AS CLEAN.
 *
 * The same shape as `unsearchedPopulationNote` above, one population along. "No unmerged branch is in its
 * region" is a claim about a set, and it is true and worthless when the set is empty -- which happened
 * every time a row declared its Region as a bare directory, because the extractor this file used could
 * not see one.
 *
 * `null` means the body has NO Region section at all, which is a different sentence again: nothing was
 * declared, so nothing was skipped.
 * @param {number | null | undefined} region @returns {string[]}
 */
function unreadRegionNote(region) {
  if (region === null || region === undefined) {
    return ["  NOTE: this row declares no `## Region` section, so the region half asked nothing. The "
      + "symbol verdict above stands on its own."];
  }
  if (region > 0) return [];
  return ["  NOTE: this row's `## Region` section yielded NO path this could read, so the region half "
    + "searched an empty set. Check the section names files or directories (a directory ends in `/`); "
    + "until it does, read the region line as \"not asked\" rather than as \"clear\"."];
}

/**
 * NOTHING TO CHECK — and "named nothing" and "named PROSE" are two different sentences (#228).
 *
 * The `.md` filter is correct: there is no symbol to verify in a README, and pretending to check one
 * would be worse than saying nothing. But dropping prose paths silently made this tell a docs row it
 * "names no source path" when it named one, in a Region field filled in correctly -- sending its author
 * to fix something that is not broken.
 *
 * Extracted from `startability` because adding the second branch took that function past the complexity
 * ceiling, which is the lint rule doing its job rather than an obstacle to route around.
 *
 * @param {number} row
 * @param {{paths: number, symbols: number, prose?: number, refs?: number, region?: number | null}} examined
 * @returns {{code: number, lines: string[]} | null} null when there IS something to check.
 */
function examinedNothing(row, examined) {
  // #1054: THE REGION POPULATION COUNTS AS SOMETHING EXAMINED. A row whose Region is only directories
  // (`docs/`) names no `paths` and may name no backticked symbol either. Before the region half was
  // taught to read declared entries, such a row reached here and was reported CANNOT_ASK -- having, in
  // fact, examined three declared entries against 291 refs.
  if (examined.paths > 0 || examined.symbols > 0 || (examined.region ?? 0) > 0) return null;
  if ((examined.prose ?? 0) > 0) {
    return { code: EXIT.CANNOT_ASK, lines: [
      `CANNOT SAY whether #${row} is startable: it names ${examined.prose} document(s) and no source `
      + "path or symbol.",
      "  Its Region is prose, and this checks code: there is no symbol to look for in a README, and",
      "  pretending to verify one would be worse than saying nothing.",
      "  NOT a missing Region: do not add one. Judge a docs row by reading it.",
    ] };
  }
  return { code: EXIT.CANNOT_ASK, lines: [
    `CANNOT SAY whether #${row} is startable: it names no source path and no symbol this can check.`,
    "  A row with no Region and no backticked identifier gives this nothing to examine, and reporting",
    "  STARTABLE having examined nothing is the defect this repo records most.",
  ] };
}

/**
 * #1054: "A MERGE COST, NOT A BLOCKER" IS TRUE OF A DEAD BRANCH AND FALSE OF AN OPEN PR.
 *
 * The old line said it of both. A closed PR or an unproposed branch is exactly a merge cost -- nobody is
 * coming, you resolve it once. An OPEN PR is the thing B4 refuses a claim over: `row-claim claim` will
 * not let this row start while that PR is open, and telling a reader it is merely a merge cost sends them
 * to a refusal they were just assured would not happen.
 *
 * This still does not RUN B4 -- it cannot, from here -- so it names the rule and what it will say rather
 * than pretending to have applied it.
 * @param {number} row
 * @param {{path: string, refs: string[], openPrs?: string[]}[]} heldRegions
 * @returns {string[]}
 */
function contendedVerdict(row, heldRegions) {
  const contested = heldRegions.filter(({ openPrs }) => (openPrs ?? []).length > 0);
  if (contested.length === 0) {
    return [`#${row} is STARTABLE -- its subject is on \`main\`.`,
      "  The contention above is a merge cost, not a blocker: no OPEN pull request is in its region."];
  }
  const paths = contested.map(({ path }) => `\`${path}\``).join(", ");
  return [`#${row}'s subject is on \`main\`, but ${paths} ${contested.length === 1 ? "is" : "are"} held `
    + "by an OPEN pull request.",
  "  EXPECT `row-claim claim` TO REFUSE THIS. B4 -- no two open pull requests touch the same file -- is",
  "  PREDICTED here from the OPEN PR above, and RUN by `row-claim check`, which prints its own refusal",
  "  below this block (#1063). Run standalone, this script gives you the prediction and not the rule.",
  "  Sequence with that PR's author. Narrowing the Region to route around it is not a remedy."];
}

/**
 * #1054: THE CLEAN VERDICT'S OWN WORDING, extracted so `startability` stays under the complexity ceiling
 * and so the two claims it makes can be read apart from each other.
 *
 * The region sentence is stated ONLY when a region was actually examined. It used to be unconditional,
 * and a row whose Region this file could not read got "no unmerged branch is in its region" over a set of
 * zero -- a positive claim about an empty population, which is the defect this file's own
 * `examinedNothing` header calls the one this repo records most.
 *
 * AND IT NAMES THE RULE IT DID NOT RUN. This verdict is what a reader consults before `row-claim claim`,
 * and `claim` additionally applies B4 -- no two open PRs touching one file -- which lives on the claim
 * path and is not reachable from here. A pre-check that answers in the deciding rule's vocabulary and
 * omits the deciding rule is worse than no pre-check, because nothing tells the reader to ask again.
 * @param {number} row
 * @param {{paths: number, symbols: number, prose?: number, refs?: number, region?: number | null}} examined
 * @returns {string[]}
 */
function startableLines(row, examined) {
  const counted = `${examined.paths} path(s), ${examined.symbols} symbol(s), `
    + `${examined.region ?? 0} declared region entr(ies), ${examined.refs ?? 0} unmerged ref(s) examined`;
  const regionClause = (examined.region ?? 0) > 0
    ? "and no unmerged branch is in its region"
    : "and its region was NOT examined";
  return [
    `#${row} is STARTABLE: every symbol it names is on \`main\`, ${regionClause} (${counted}).`,
    ...unsearchedPopulationNote(examined.refs ?? 0),
    ...unreadRegionNote(examined.region),
    "  This checks SYMBOLS, this row's DECLARED region against unmerged branches, and the `blocked`",
    "  label. It does NOT run B4 -- whether an OPEN PR already touches one of these files. `row-claim",
    "  check` runs that separately (#1063) and prints its refusal beside this verdict; run through",
    "  `row-claim`, not this script directly, or the B4 half is missing.",
    "  A row can still be blocked by something none of these express -- an unstated dependency, a "
      + "decision",
    "  nobody has taken -- so STARTABLE means \"nothing I can see\", never \"nothing blocks this\".",
  ];
}

/**
 * THE VERDICT, PURE — so every state is reachable without a network or a checkout.
 *
 * `null` for a lookup means it failed and is never read as an empty answer, the distinction this whole
 * tool exists to preserve one level up.
 *
 * @param {{row: number,
 *          subjectsMissing: {name: string, refs: string[]}[] | null,
 *          heldRegions: {path: string, refs: string[], openPrs?: string[]}[] | null,
 *          blockedLabel?: boolean,
 *          state?: string | null,
 *          closedAt?: string | null,
 *          examined: {paths: number, symbols: number, prose?: number, refs?: number,
 *            region?: number | null}}} facts
 * @returns {{code: number, lines: string[]}}
 */

export function startability({ row, subjectsMissing, heldRegions, examined, blockedLabel,
  state, closedAt }) {
  // A CLOSED ROW GETS NO VERDICT AT ALL, not a verdict with a note attached (#218).
  //
  // Measured 2026-09-07: #83 read `STARTABLE: no unmerged branch is in its region`, and BOTH sentences
  // were true -- nothing held the region and every symbol was on `main`, BECAUSE THE WORK WAS DONE AND
  // MERGED twenty-five minutes earlier. A worker was dispatched on that reading and it cost nothing only
  // because they checked GitHub themselves.
  //
  // This returns EARLY rather than appending a caveat: a green light with a note beside it is still a
  // green light, and the role file's target for units dispatched at closed rows is zero. The state was in
  // the query being made for the labels the whole time -- one field away, which is what makes it the
  // #208 limit reached one field earlier than the limit that sentence describes.
  if (state && state !== "OPEN") {
    return { code: EXIT.BLOCKED, lines: [
      `#${row} IS ${state}${closedAt ? ` (${closedAt})` : ""} — there is nothing to start.`,
      "  Region and symbol checks say nothing here: a finished row's region is clear and its symbols are",
      "  on `main` BECAUSE the work landed. That reads exactly like a green light, and is why this",
      "  refuses to print one.",
    ] };
  }
  if (subjectsMissing === null || heldRegions === null) {
    return { code: EXIT.CANNOT_ASK, lines: [
      `CANNOT SAY whether #${row} is startable: a lookup failed.`,
      "  INCONCLUSIVE, not clear. Reporting an unaskable question as startable is how somebody loses an",
      "  evening discovering it at step 1, which is the whole reason this check exists.",
    ] };
  }
  const nothingToCheck = examinedNothing(row, examined);
  if (nothingToCheck) return nothingToCheck;

  const lines = [];
  if (blockedLabel) {
    lines.push(`CARRIES THE \`blocked\` LABEL: somebody has recorded that this row waits on something.`,
      "  This tool checks regions and symbols; a row blocked by another ROW is invisible to both, which is",
      "  why the label is read rather than inferred from the prose that states it.");
  }
  for (const { name, refs } of subjectsMissing) {
    lines.push(`SUBJECT NOT ON main: \`${name}\` exists only on ${refs.join(", ")}.`,
      "  The row is about code that has not landed. Building on `main` finds nothing to change; building",
      "  on that branch means editing somebody's open work. Wait for it, or take the row WITH its branch.");
  }
  for (const { path, refs } of heldRegions) {
    lines.push(`REGION HELD: \`${path}\` has unmerged changes on ${refs.join(", ")}.`,
      "  Startable, but you will merge against them. Worth knowing before you begin, not at review.");
  }
  if (subjectsMissing.length > 0 || blockedLabel) return { code: EXIT.BLOCKED, lines };
  if (heldRegions.length > 0) return { code: EXIT.STARTABLE, lines: [...lines, ...contendedVerdict(row, heldRegions)] };
  return { code: EXIT.STARTABLE, lines: startableLines(row, examined) };
}

/**
 * THE STATE OF THE PR ON A BLOCKING REF, because "wait" and "nobody is coming" are different instructions.
 *
 * Measured 2026-09-07: #171's subject lives on `agent/identify-input-purpose-79`, whose PR **#89 is
 * CLOSED** — the work moved elsewhere and that branch will never merge. #186's lives on
 * `pm/reported-directory-159`, whose **PR #172 is OPEN**. Reported identically before this, and they are
 * not the same situation: a row blocked behind an abandoned branch is arguably not blocked at all, it is
 * a row whose subject nobody is currently building, which is a decision for a person rather than a wait.
 *
 * IT DOES NOT CHASE THE SUCCESSOR. Nothing links that branch to the row that replaced it except prose,
 * and inferring it would be the coarse guess this tool deliberately keeps away from its own verdict.
 * Report the state; let the reader draw the line.
 *
 * A ref with no PR at all is not an error — plenty of branches never open one — so it reports `no PR`
 * rather than failing, and an unreadable answer says so instead of implying `none`.
 */
/**
 * ONE LISTING, NOT ONE CALL PER REF — with a per-ref fallback so a truncated page cannot lie.
 *
 * The region half can name a dozen branches for one file (`ci.yml` currently has six), and a `gh` call
 * each would make the tool slow enough that people stop running it before dispatching, which is the
 * failure `row-claim` exists to prevent. So the map is built once.
 *
 * BUT A BOUNDED LISTING IS THE DEFECT THIS SESSION HAS CORRECTED MOST: a page that stops short would
 * report a real PR as `no PR`, which is the *worse* direction here — it turns "wait for it" into
 * "nobody is coming". So a ref MISSING from the map is not answered from the map; it falls through to
 * the authoritative per-ref query. Truncation then costs an extra call and never a wrong answer.
 */
/** @type {Map<string, string[]> | undefined} */
let prMap;
function prStateMap() {
  if (prMap) return prMap;
  prMap = new Map();
  try {
    for (const pr of JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "all",
      "--limit", "400", "--json", "number,state,headRefName"]))) {
      const key = /** @type {{ headRefName: string }} */ (pr).headRefName;
      prMap.set(key, [...(prMap.get(key) ?? []), `PR #${pr.number} ${pr.state}`]);
    }
  } catch {
    // An unreadable listing leaves the map EMPTY, so every ref falls through to its own query rather
    // than being reported as `no PR` on the strength of a call that failed.
  }
  return prMap;
}

/** @param {string} ref */
function prState(ref) {
  const branch = ref.replace(/^origin\//, "");
  const known = prStateMap().get(branch);
  if (known) return known.join(", ");
  try {
    const found = JSON.parse(gh(["pr", "list", "--repo", REPO, "--head", branch, "--state", "all",
      "--json", "number,state"]));
    if (!Array.isArray(found) || found.length === 0) return "no PR";
    return found.map((pr) => `PR #${pr.number} ${pr.state}`).join(", ");
  } catch {
    return "PR state unreadable";
  }
}

/**
 * Every remote branch except `main` — the population an unmerged claim is measured against.
 *
 * #772: IT IS PURELY LOCAL. `for-each-ref refs/remotes/origin` reads what this checkout has fetched, not
 * what the remote holds, so a checkout with no remote branches returns ZERO and every "is this symbol
 * carried elsewhere" loop below never runs. The answer is then an empty `carriers` list for every symbol
 * and a STARTABLE verdict — **from an empty population, not from a search.** "Zero unmerged refs" and "no
 * ref carries this" are different facts, and the caller reports the count so they cannot be read as one.
 */
function unmergedRefs() {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).split("\n")
    .map((r) => r.trim()).filter((r) => r && r !== "origin/main" && !r.startsWith("origin/HEAD"));
}

/** @param {string} path */
/** @param {string} path @param {{ run?: (args: string[]) => string }} [deps] @returns {boolean} */
export const onMain = (path, deps) => {
  // #772: `cat-file -e` RETURNS 128 FOR BOTH "no such path" AND "no such revision", measured against this
  // repository — so the `status === 1` test that fixes `symbolOnMain` and `refsCarryingSymbol` cannot fix
  // this one. The revision has to be proved readable SEPARATELY, and then a 128 is genuinely about the path.
  //
  // Without that, a checkout whose `origin/main` is missing reports every declared path as absent, which
  // reads as "none of this row's Region has landed" -- a confident answer from a question never asked.
  assertOriginMainReadable(deps);
  try {
    (deps?.run ?? git)(["cat-file", "-e", `origin/main:${path}`]);
    return true;
  } catch {
    return false; // `origin/main` resolves, so this is about the PATH
  }
};

/** @type {boolean | null} Proved once per process: the ref either resolves here or nothing below can ask. */
let originMainProved = null;

/**
 * Throws so `main()`'s CANNOT_ASK path reports it, rather than every path reading as absent.
 * @param {{ run?: (args: string[]) => string }} [deps]
 */
function assertOriginMainReadable({ run } = /** @type {{ run?: (args: string[]) => string }} */ ({})) {
  // THE MEMO IS FOR THE REAL GIT ONLY. A caller that injects `run` is asking about a different world, so
  // it must neither read the cache nor fill it -- the same discipline `rootFilesOnMain`'s `repoRoot` seam
  // keeps (#995). Without it the first real call in a process proves the ref and every later injected one
  // returns early without calling the stub at all, which is a test that cannot fail.
  if (run) { run(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]); return; }
  if (originMainProved) return;
  git(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]);
  originMainProved = true;
}

/**
 * #772: NO PRODUCTION CALLER — this exists only so `assertOriginMainReadable`'s own failure can be driven
 * in isolation. `onMain` is the production caller and takes the same `deps`, which is what holds the CALL
 * SITE; this holds the function. Neither alone is enough: asserting the call on the source misses a
 * swallowed failure inside, and driving the function misses the call being deleted.
 *
 * The seam exists so the FAILURE can be driven, and the stub is the whole fixture. A source-text
 * assertion that this function is CALLED catches its deletion and misses a swallowing `try` inside it --
 * still called, still named, unable to fail. That is the proof that proves nothing, which is the shape
 * this row exists to end, so the test drives a `run` that throws rather than reading the source.
 * @param {{ run?: (args: string[]) => string }} [deps] @returns {void}
 */
export function proveOriginMainReadable(deps) {
  assertOriginMainReadable(deps);
}

/**
 * IS THIS SYMBOL ON `main`, ANYWHERE — never bounded to the row's own Region (#719).
 *
 * The row's named files are the right scope for the REGION question and the wrong one for this: #687's
 * body named five files, `regionPathsFromBody` recovered three (a bare filename after a full path and a
 * glob both dropped a real symbol's home), and `environmentKey` lived in one of the two it missed. It had
 * been on `main` the whole time; searching only the Region's own files reported it absent. `git grep`
 * across the whole tree at `origin/main` is the actual question — "has this landed" — asked of the place
 * it would have landed, not of the row's own guess at where to look.
 *
 * `-F` for a literal substring (matching the old `mainText.includes(name)`, never a regex); `-e` so a
 * symbol cannot be misread as an option. Exit 1 is git grep's own "no match", a real no; anything else
 * (128 for an unreadable revision, say) is a genuine failure and must reach `main()`'s CANNOT_ASK path
 * rather than being read as "not on main".
 * @param {string} name
 * @param {{ run?: (args: string[]) => string }} [deps] (#1566) the same git runner `subjectAndRegionFacts` injects,
 *   so the subject half can be driven over a synthetic repository instead of this checkout's `origin/main`.
 */
export function symbolOnMain(name, { run = git } = {}) {
  try {
    run(["grep", "-q", "-F", "-e", name, "origin/main"]);
    return true;
  } catch (error) {
    if (/** @type {{ status?: number }} */ (error).status === 1) return false;
    throw error;
  }
}

/**
 * Which refs carry this symbol ANYWHERE in their tree — never bounded to the row's Region paths (#719).
 *
 * The old check asked `refsCarrying(path, symbol, refs)` for each of the Region's own files: a branch
 * "carried" a symbol only because it touched a Region file whose TEXT happened to contain the string,
 * which is a red herring the row's own issue names outright — nothing about that branch is where the
 * symbol lives, and a worker sent to "take the row with its branch" would take the wrong one. Searching
 * the ref's whole tree is the same fix as `symbolOnMain`, aimed at "wait for it" instead of "is it here".
 * @param {string} symbol
 * @param {string[]} refs
 * @param {{ run?: (args: string[]) => string }} [deps] (#1566) as `symbolOnMain`.
 */
export function refsCarryingSymbol(symbol, refs, { run = git } = {}) {
  /** @type {string[]} */
  const carrying = [];
  for (const ref of refs) {
    try {
      run(["grep", "-q", "-F", "-e", symbol, ref]);
      carrying.push(ref);
    } catch (error) {
      // #772: "no match" AND "could not read this ref" ARE NOT THE SAME ANSWER, and the comment that used
      // to sit here said "either way, it does not carry it" -- which is the conflation, written down.
      //
      // A ref this checkout cannot read is not a ref that lacks the symbol. The 128 paths are real and
      // ordinary: a ref deleted between the listing and the grep, a partial or shallow clone, object
      // corruption. Each one silently shortened the carrier list.
      //
      // NOT the empty-checkout case, and the first version of this comment said it was: with nothing
      // fetched, `unmergedRefs()` returns ZERO refs and this loop never runs at all. That symptom is an
      // empty POPULATION, which `unsearchedPopulationNote` reports instead -- see its own header.
      //
      // `symbolOnMain`, THIRTY LINES ABOVE, ALREADY DRAWS THIS LINE -- exit 1 is git grep's own "no match",
      // a real no; anything else (128 for an unreadable revision) is a failure that must reach `main()`'s
      // CANNOT_ASK path. The rule was stated once in this file and not followed by its neighbour.
      if (/** @type {{ status?: number }} */ (error).status === 1) continue;
      throw error;
    }
  }
  return carrying;
}

/**
 * THE GIT-SIDE HALF, decoupled from the `gh issue view` fetch (#719) -- so a row's real body can be
 * handed in directly as a regression fixture (`#687`'s own text, verbatim) without a live network call
 * standing between a test and the git tree it actually needs to exercise. `facts(row)` below is now a
 * thin wrapper: fetch the body and the board's own record (label, state), then hand off here.
 * @param {string} body
 * @param {{run?: (args: string[]) => string, refs?: () => string[], state?: (ref: string) => string,
 *   regionFiles?: (body: string) => string[] | null}} [deps] (#1054) injected so the CONTENTION WALK
 *   be driven over a synthetic repository with synthetic refs. The walk's own logic -- the two-diff
 *   conjunction, the MERGED filter -- is the part that must be exercised; a test that reached only the
 *   extraction would prove a directory prefix is PARSED and never that it is SEARCHED.
 */
export function subjectAndRegionFacts(body, deps = {}) {
  const { run = git, refs: refsOf = unmergedRefs, state: stateOf = prState,
    regionFiles = declaredRegionFiles } = deps;
  // PROSE PATHS ARE COUNTED, NOT DISCARDED. The `.md` filter is correct -- there is no symbol to verify
  // in a README, and pretending to check one would be worse than saying nothing. But dropping them
  // SILENTLY made the verdict say a docs row "names no source path" when it named one, which sent the
  // reader to add a Region that was already there.
  const named = regionPathsFromBody(body);
  const paths = named.filter((path) => !path.endsWith(".md"));
  const prose = named.filter((path) => path.endsWith(".md"));
  const symbols = unique([...body.matchAll(SYMBOL_IN_PROSE)].map((m) => m[1]));
  // #1054: THE CONTENTION HALF ASKS THE DECLARED REGION, THE SUBJECT HALF ASKS THE WHOLE BODY, AND THEY
  // ARE DIFFERENT QUESTIONS. #710 left this file on `regionPathsFromBody` deliberately, and that was
  // right for the subject: a symbol is searched tree-wide on purpose (#719), so a path mentioned anywhere
  // is a fair place to look for one. It is wrong for contention, which is a claim about what this row
  // INTENDS TO CHANGE -- the same narrower question `fileOverlapReason` already asks -- and the two
  // extractors then drifted apart when #941 taught `declaredRegionFiles` about directory prefixes and
  // left the prose scan unable to see them.
  //
  // Measured on #907, whose Region is `CLAUDE.md`, `docs/` and `packages/lab/src/packaging/`:
  //
  //   regionPathsFromBody  ->  ["docs/backlog.md"]   <- from the row's PROSE, not its Region
  //   declaredRegionFiles  ->  the three it declares
  //
  // The `.md` split above is NOT applied here, and that is the point of keeping them separate: there is
  // no symbol to verify in a README, which is why the subject half drops one -- but a branch editing
  // `CLAUDE.md` holds `CLAUDE.md` against you exactly as a branch editing a `.mjs` does.
  const declared = regionFiles(body);
  const refs = refsOf();
  // #772: THE COUNT TRAVELS WITH THE VERDICT. An empty ref list is a real state -- a fresh clone, a
  // checkout that has never fetched branches -- and a subject search across it proves nothing. Counted
  // here rather than guarded, because zero refs is legitimate and its cost is only that the answer is
  // narrower than it looks; what is not acceptable is that narrowness being invisible.

  // THE #186 CASE FIRST. A symbol the row is about, absent from `main`'s WHOLE TREE and present on some
  // other ref, means the row's subject has not landed -- which no region check can see, because nobody is
  // editing the file it is missing from. #719: this used to ask the question of the row's own named files
  // rather than of `main` itself -- see `symbolOnMain`'s own header for why that is a different question.
  const present = (declared ?? []).filter((path) => onMain(path, { run }));
  const subjectsMissing = [];
  for (const name of symbols) {
    if (symbolOnMain(name, { run })) continue;
    const carriers = unique(refsCarryingSymbol(name, refs, { run }));
    if (carriers.length > 0) {
      // #1566: the INJECTED state, as `heldRegionsFor` already takes it. Calling `prState` here left a `gh` spawn
      // on the one path a test passing `state` believed it had replaced.
      subjectsMissing.push({ name, refs: carriers.map((ref) => `${ref} (${stateOf(ref)})`) });
    }
  }

  const heldRegions = heldRegionsFor({ present, refs, run, stateOf });
  return { subjectsMissing, heldRegions,
    examined: { paths: paths.length, symbols: symbols.length, prose: prose.length, refs: refs.length,
      region: declared === null ? null : declared.length } };
}

/**
 * #1054: THE CONTENTION HALF, ON ITS OWN.
 *
 * Pulled out of `subjectAndRegionFacts` when that function went past the 90-physical-line ceiling, which
 * is the lint rule naming something true: the two halves ask different questions of different
 * populations, and reading one no longer means reading past the other.
 * @param {{present: string[], refs: string[], run: (args: string[]) => string,
 *   stateOf: (ref: string) => string}} inputs
 * @returns {{path: string, refs: string[], openPrs: string[]}[]}
 */
function heldRegionsFor({ present, refs, run, stateOf }) {
  // BOTH DIFFS, AND EACH ALONE GIVES A WRONG ANSWER. This tool produced both wrong answers in turn, on
  // its first two runs, which is why the conjunction is spelled out rather than assumed.
  //
  //   THREE-DOT `origin/main...<ref>` -- what the ref changed since the MERGE BASE. Stays non-empty for
  //     work already on `main` under a different sha (a squash, a cherry-pick, a re-resolved merge), so
  //     it reported a branch that merged hours earlier as holding a region. That is the fourth state --
  //     content-merged is neither "unmerged" nor "absent" -- which this session corrected in three other
  //     people's claims tonight and then committed here, in the tool written to compute it.
  //
  //   TWO-DOT `origin/main <ref>` -- how the blobs DIFFER, in either direction. Non-empty for any branch
  //     merely BEHIND `main`, because `main` has moved on. That reported EIGHTY-FIVE branches as holding
  //     one file, which is not a report anyone reads.
  //
  // A ref genuinely holds a path when it has changed that path since the merge base AND the result still
  // differs from `main`: its own work, not yet landed. Neither condition is sufficient; the pair is.
  /** @type {{ path: string, refs: string[], openPrs: string[] }[]} */
  const heldRegions = [];
  /** @param {string[]} range @param {string} path */
  const changed = (range, path) => {
    try {
      return run(["diff", "--numstat", ...range, "--", path]).trim().length > 0;
    } catch { return false; }
  };
  for (const path of present) {
    const holders = refs.filter((ref) => changed([`origin/main...${ref}`], path)
      && changed(["origin/main", ref], path));
    // THE SAME FACT THE SUBJECT HALF ALREADY REPORTS. `(PR #89 CLOSED)`, `(PR #172 OPEN)` and `(no PR)`
    // are three different messages: nobody is coming, wait for it, and somebody's unproposed work. The
    // fifth state was solved for the subject half in #208 and not carried across, so the two halves of
    // one tool said different amounts about the same branch -- and a reader takes an undecorated
    // `REGION HELD` as "wait for that to land" even when the branch is dead.
    // A MERGED BRANCH CANNOT HOLD A REGION AGAINST YOU, and neither git diff can tell that on its own.
    // A SQUASH merge leaves the branch's commits off `main`, so three-dot stays non-empty, and `main`
    // has moved on, so two-dot does too -- the pair I added to defeat the fourth state does not defeat
    // this form of it. Measured: `agent/changeset-packed-check-132 (PR #151 MERGED)` was reported as
    // holding `ci.yml`. The PR state is the authoritative record git cannot reconstruct.
    //
    // THE FAILURE MODE THIS ACCEPTS, named rather than hidden: a branch that was merged and then REUSED
    // for new commits is dropped here, and it does genuinely hold. That is rare, and the alternative --
    // listing every squash-merged branch for ever -- is the eighty-five-branch report nobody reads.
    const live = holders.map((ref) => ({ ref, state: stateOf(ref) }))
      .filter(({ state }) => !/\bMERGED\b/.test(state));
    if (live.length > 0) {
      heldRegions.push({ path, refs: heldRefsSummary(live),
        openPrs: live.filter(({ state }) => /\bOPEN\b/.test(state)).map(({ ref }) => ref) });
    }
  }
  return heldRegions;
}

/**
 * #1054: EVERY OPEN PR BY NAME, THE REST BY COUNT AND STATE.
 *
 * A file-shaped Region names one or two holders. A DIRECTORY-shaped one names twelve, most of them dead
 * branches and closed PRs, and this file's own header already records what happens then: "EIGHTY-FIVE
 * branches as holding one file, which is not a report anyone reads." Teaching the region half to see
 * directory prefixes is what made that reachable, so the summary ships with it rather than after it.
 *
 * THE SPLIT IS BY WHAT THE READER WILL DO ABOUT IT, not by how many fit on a line. An OPEN PR is the one
 * B4 refuses a claim over, so every one is named. A closed PR or an unproposed branch is a merge cost,
 * and a merge cost is a number.
 *
 * IT IS NOT A TRUNCATION. The count is stated, the states behind it are stated, and nothing is dropped
 * silently -- a list cut to fit reads as a complete list, which is the failure this repo has recorded
 * against `tail` and `head` more than once.
 * @param {{ref: string, state: string}[]} live
 * @returns {string[]}
 */
export function heldRefsSummary(live) {
  const open = live.filter(({ state }) => /\bOPEN\b/.test(state));
  const rest = live.filter(({ state }) => !/\bOPEN\b/.test(state));
  const named = open.map(({ ref, state }) => `${ref} (${state})`);
  if (rest.length === 0) return named;
  const closed = rest.filter(({ state }) => /\bCLOSED\b/.test(state)).length;
  const unproposed = rest.length - closed;
  const parts = [];
  if (unproposed > 0) parts.push(`${unproposed} with no PR`);
  if (closed > 0) parts.push(`${closed} whose PR is CLOSED`);
  // The two readings need two sentences. With an open PR named, the rest are "and N more"; with none, a
  // dangling "and N more" reads as a continuation of a list that was never printed.
  const tail = `${rest.length} branch(es) (${parts.join(", ")}) -- a merge cost, nobody to wait for`;
  return named.length > 0 ? [...named, `and ${tail}`] : [tail];
}

/** @param {number} row */
function facts(row) {
  const issue = JSON.parse(gh(["issue", "view", String(row), "--repo", REPO,
    "--json", "body,labels,state,closedAt"]));
  const body = issue.body ?? "";
  // THE BOARD'S OWN RECORD, not prose. A row can be blocked by another ROW -- #77 is "blocked behind
  // #35's schema migration" and carries the `blocked` label -- and neither its region nor its symbols say
  // so. Reading the LABEL is not the prose-parsing this tool refuses elsewhere: it is the same
  // authoritative record `row-claim` already trusts for `in-progress`.
  const blockedLabel = (issue.labels ?? []).some((/** @type {any} */ l) => l?.name === "blocked");
  // THE ROW'S OWN STATE, and it was in this query's reach the whole time. See `startability`.
  const state = typeof issue.state === "string" ? issue.state : null;
  const closedAt = typeof issue.closedAt === "string" ? issue.closedAt : null;
  return { row, blockedLabel, state, closedAt, ...subjectAndRegionFacts(body) };
}

function main() {
  // GUARDED THOUGH NOTHING CURRENTLY REQUIRES IT. `cli-flags.test.ts`'s census walks
  // `packages/{lab,worker-fleet}/{src,scripts}` and cannot see top-level `scripts/` -- which is #164, and
  // is why this file could have shipped unguarded without a single test objecting. Guarding it because it
  // is right, not because something asked.
  refuseUnknownFlags(["--row"], { entry: import.meta.url, command: "node packages/agent-org/src/row-reachability.mjs" });
  const argv = process.argv.slice(2);
  const row = Number(argv.map((a) => a.replace(/^--row=/, "")).find((a) => /^\d+$/.test(a)));
  if (!row) {
    console.error("Usage: node packages/agent-org/src/row-reachability.mjs <issue-number>\n"
      + "Answers whether a row can be STARTED today, computed from the tree rather than from its labels.");
    process.exit(EXIT.CANNOT_ASK);
  }
  let verdict;
  try {
    verdict = startability(facts(row));
  } catch (error) {
    verdict = startability({ row, subjectsMissing: null, heldRegions: null,
      examined: { paths: 0, symbols: 0 } });
    verdict.lines.push(`  ${String(error).slice(0, 200)}`);
  }
  const write = verdict.code === EXIT.STARTABLE ? console.log : console.error;
  for (const line of verdict.lines) write(line);
  process.exit(verdict.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
