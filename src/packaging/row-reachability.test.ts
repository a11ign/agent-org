/**
 * A ROW'S LABELS DESCRIBE ITS CLASSIFICATION, NEVER ITS REACHABILITY (#177).
 *
 * Ready showed four unclaimed rows, none `fleet-gated`, so by every label the lane read fully pickable.
 * The honest pickable count was 3; on one earlier evening it was 1. **Every one of those rows was
 * correctly classified** — `ready`, not `fleet-gated`, nothing about the labels wrong. The classification
 * cannot express the fact, so the count is right about its labels and wrong about the work.
 *
 * THE CHECK IS "DOES THIS ROW'S SUBJECT EXIST ON `main` YET", not "is anyone else in these files", and
 * #186 is the case that forces the distinction: nobody is editing `board-summary-check.mjs`, and the row
 * is unstartable anyway because `dirOnOriginMain` — the function it is entirely about — exists on one
 * unmerged branch and nowhere else. A region check alone scores that CLEAR.
 *
 * Driven against the pure verdict: the states worth testing are combinations of lookup results, and
 * arranging them against real refs would mean creating branches at the moment the test runs.
 */
// no-token: gh
//
// #772: this file imports `row-reachability.mjs` for `startability`, `symbolOnMain` and
// `refsCarryingSymbol`, and that module's line 53 spawns `gh` for the ISSUE fetch — a path none of these
// tests take: every one of them drives git against a real local tree, or hands `startability` a facts
// object built here. DECLARED AND THEN PROVED, because the mechanism's own check is shallow (this file
// must not call `gh(`): run with `GH_TOKEN`/`GITHUB_TOKEN` unset and a fake `gh` first on `PATH` that
// exits 97 and shouts, and the suite passes with the fake never invoked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startability, subjectAndRegionFacts, symbolOnMain, refsCarryingSymbol, proveOriginMainReadable, onMain,
  heldRefsSummary } from "../../../../scripts/row-reachability.mjs";
import { declaredRegionFiles, regionPathsFromBody } from "../../../../scripts/region-paths.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxGitEnv } from "../../../../scripts/git-env.mjs";
import { ABSENT_FIXTURE_SYMBOLS } from "../../../../scripts/fixture-symbols.mjs";

const examined = { paths: 3, symbols: 2, region: 3 };
const clear = { row: 189, subjectsMissing: [], heldRegions: [], examined };


test("THE #186 CASE: the subject does not exist on main, and no region check would see it", () => {
  const v = startability({
    ...clear, row: 186,
    subjectsMissing: [{ name: "dirOnOriginMain", refs: ["origin/pm/reported-directory-159"] }],
    heldRegions: [],
  });
  assert.equal(v.code, 1, "a row about code that has not landed is not startable");
  const text = v.lines.join("\n");
  assert.match(text, /SUBJECT NOT ON main: `dirOnOriginMain`/);
  assert.match(text, /origin\/pm\/reported-directory-159/,
    "it must NAME the ref -- 'blocked' and 'blocked on X' are different instructions");
  assert.match(text, /editing somebody's open work/,
    "and say why building on that branch is not simply the workaround");
});

test("a held region is reported but does NOT block — it is a merge cost, not a blocker", () => {
  // The half that stops this being deleted: a check that reports every row blocked is one nobody reads.
  const v = startability({
    ...clear, heldRegions: [{ path: "scripts/row-claim.mjs", refs: ["origin/agent/x"] }],
  });
  assert.equal(v.code, 0, "contention is worth knowing and is not a reason to refuse the row");
  assert.match(v.lines.join("\n"), /REGION HELD/);
  assert.match(v.lines.join("\n"), /merge cost, not a blocker/);
});

test("a clear row is STARTABLE and says what it examined", () => {
  const v = startability(clear);
  assert.equal(v.code, 0);
  assert.match(v.lines.join("\n"), /STARTABLE/);
  assert.match(v.lines.join("\n"),
    /3 path\(s\), 2 symbol\(s\), 3 declared region entr\(ies\), \d+ unmerged ref\(s\) examined/,
    "a count of what was looked at, or 'startable' is indistinguishable from 'nothing was checked' -- and "
    + "#1054: EACH population separately, because one symbol used to certify a region nothing had read");
});

test("#772: ZERO unmerged refs is reported, because the search then had nothing to look at", () => {
  // `unmergedRefs()` reads what this checkout has FETCHED, not what the remote holds. A fresh clone
  // searches nothing, every symbol comes back carried by nobody, and the verdict is STARTABLE -- from an
  // EMPTY POPULATION rather than from a search. worker-judge's finding on #1023: the empty list, not the
  // 128, is what actually produced the symptom this row was filed for, and nothing counted it.
  const noRefs = { ...clear, examined: { ...clear.examined, refs: 0 } };
  const said = startability(noRefs).lines.join("\n");
  assert.equal(startability(noRefs).code, 0, "zero refs is legitimate -- a fresh clone -- not a refusal");
  assert.match(said, /fetched NO unmerged remote branches/,
    "the narrowness must be visible: STARTABLE from an unsearched population reads exactly like STARTABLE "
    + "from a clean one");
  assert.doesNotMatch(startability({ ...clear, examined: { ...clear.examined, refs: 4 } }).lines.join("\n"),
    /fetched NO unmerged/, "and it must not fire when there was a population to search");
});

test("EXAMINED NOTHING is inconclusive, never startable — the sharpest case here", () => {
  // A row with no Region and no backticked identifier gives this nothing to work on. Reporting STARTABLE
  // would be a check reporting success having examined nothing, which is what the whole row is about.
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0 } });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /names no source path and no symbol/);
});

test("a failed lookup is inconclusive, and must never read as startable", () => {
  for (const broken of [{ subjectsMissing: null }, { heldRegions: null }]) {
    const v = startability({ ...clear, ...broken });
    assert.equal(v.code, 2, "null is 'I could not ask', never 'there is nothing there'");
    assert.match(v.lines.join("\n"), /CANNOT SAY/);
  }
});

test("both faults at once are reported separately, and the blocker wins the exit code", () => {
  const v = startability({
    ...clear, row: 171,
    subjectsMissing: [{ name: "formInputs", refs: ["origin/agent/identify-input-purpose-79"] }],
    heldRegions: [{ path: "packages/judge/src/coverage.ts", refs: ["origin/agent/identify-input-purpose-79"] }],
  });
  assert.equal(v.code, 1);
  const text = v.lines.join("\n");
  assert.match(text, /SUBJECT NOT ON main/);
  assert.match(text, /REGION HELD/);
  assert.doesNotMatch(text, /is STARTABLE/,
    "a blocked row must not also print the startable sentence -- one verdict per run");
});

/**
 * THE FIFTH STATE: the blocking ref's PR is CLOSED, so nobody is coming (#177, found by `dispatcher`).
 *
 * Measured 2026-09-07. #171's subject lives on `agent/identify-input-purpose-79`, whose PR **#89 is
 * CLOSED** — the work moved and that branch will never merge. #186's lives on `pm/reported-directory-159`,
 * whose **PR #172 is OPEN**. Before this the two printed identically, and they are not the same
 * situation: *wait for it* and *nobody is building this* are different instructions, and a reader
 * following the first onto a closed PR learns nothing about what replaced it.
 *
 * The verdict deliberately does not DECIDE between them — a row blocked behind an abandoned branch is
 * arguably not blocked at all, and that is a call for a person. It reports the state and stops.
 */
test("a blocking ref carries its PR state, so 'wait' and 'nobody is coming' are distinguishable", () => {
  const abandoned = startability({
    ...clear, row: 171,
    subjectsMissing: [{ name: "formInputs",
      refs: ["origin/agent/identify-input-purpose-79 (PR #89 CLOSED)"] }],
    heldRegions: [],
  });
  assert.match(abandoned.lines.join("\n"), /PR #89 CLOSED/,
    "a reader following an abandoned branch needs to know it is abandoned before they wait on it");

  const waiting = startability({
    ...clear, row: 186,
    subjectsMissing: [{ name: "dirOnOriginMain", refs: ["origin/pm/reported-directory-159 (PR #172 OPEN)"] }],
    heldRegions: [],
  });
  assert.match(waiting.lines.join("\n"), /PR #172 OPEN/);

  assert.equal(abandoned.code, waiting.code,
    "the VERDICT is the same in both -- the subject is not on main either way. Only the reader can decide "
    + "whether an abandoned blocker is a blocker, and this tool must not decide it for them");
});

/**
 * THE SIXTH STATE: a row blocked by another ROW, which neither regions nor symbols can express.
 *
 * `dispatcher` ran the merged tool across the backlog and found #77 reported STARTABLE while its own
 * title reads *"blocked behind #35's schema migration"* and #35 is open. The tool was correct about what
 * it examined — the region is clear and the symbols are on `main` — and a reader takes STARTABLE as
 * *nothing blocks this*. That is #187's fourth shape, in the tool built to compute reachability.
 *
 * IT READS THE LABEL, NOT THE PROSE. Parsing a title for a blocker is the coarse inference this tool
 * refuses everywhere else; the `blocked` label is the same authoritative record `row-claim` already
 * trusts for `in-progress`, so reading it is not a guess. And the STARTABLE sentence now states its own
 * limit, because a verdict that cannot say what it did not check is the defect the census catalogues.
 */
test("the `blocked` label is read, and STARTABLE says what it did not check", () => {
  const blocked = startability({ ...clear, row: 77, blockedLabel: true });
  assert.equal(blocked.code, 1, "a row somebody has recorded as blocked must not read as startable");
  assert.match(blocked.lines.join("\n"), /CARRIES THE `blocked` LABEL/);

  const startable = startability(clear);
  assert.equal(startable.code, 0);
  assert.match(startable.lines.join("\n"), /never "nothing blocks this"/,
    "STARTABLE must name its own limit, or it is read as a wider claim than it makes");
});

/**
 * A CLOSED ROW GETS NO VERDICT AT ALL — not a verdict with a caveat (#218).
 *
 * Measured 2026-09-07: #83 read `STARTABLE: no unmerged branch is in its region`, and **both sentences
 * were true** — nothing held the region and every symbol was on `main`, BECAUSE the work was done and
 * merged twenty-five minutes earlier. `dispatcher` briefed a worker on that reading; it cost nothing only
 * because that worker checked GitHub themselves before starting.
 *
 * This is #208's limit reached one field earlier than the limit it states. STARTABLE was documented as
 * *"nothing I can see"* — and what it could not see here was not a subtle dependency. **It was the
 * issue's own `state`, already in the query being made for the labels.**
 *
 * IT RETURNS EARLY RATHER THAN APPENDING A NOTE, because a green light with a caveat beside it is still
 * a green light, and the role file's target for units dispatched at closed rows is zero.
 */
test("a CLOSED row is refused outright, and the region check is not even consulted", () => {
  const v = startability({
    ...clear, row: 83, state: "CLOSED", closedAt: "2026-09-07T03:17:43Z",
    subjectsMissing: [], heldRegions: [],
  });
  assert.equal(v.code, 1);
  const text = v.lines.join("\n");
  assert.match(text, /#83 IS CLOSED \(2026-09-07T03:17:43Z\)/, "it names the state and when");
  assert.doesNotMatch(text, /STARTABLE/,
    "a closed row must not print a startable verdict at all -- a caveat beside one is still a green light");
  assert.match(text, /BECAUSE the work landed/,
    "and it must say WHY the region being clear is not evidence here, or the next reader re-derives it");
});

test("an OPEN row's output is unchanged — refusing more is not automatically better", () => {
  // This check is consulted before every dispatch. A version that refuses more things gets distrusted,
  // and then it is not consulted at all.
  const open = startability({ ...clear, state: "OPEN" });
  const stateless = startability(clear);
  assert.equal(open.code, 0);
  assert.deepEqual(open.lines, stateless.lines,
    "adding the state check must not change what an open row prints");
});

/**
 * THE REGION HALF SAYS AS MUCH ABOUT A BRANCH AS THE SUBJECT HALF DOES.
 *
 * #208 taught the SUBJECT half to report a blocking ref's PR state — `(PR #89 CLOSED)` means nobody is
 * coming, `(PR #172 OPEN)` means wait. **The region half never got it**, so one tool said two different
 * amounts about the same branch, and an undecorated `REGION HELD` reads as *"wait for that to land"*
 * even when the branch is dead. Found by `dispatcher` using the tool four minutes after #221 merged:
 * `REGION HELD … origin/agent/identify-input-purpose-79`, whose PR #89 is closed and whose work moved
 * wholesale to another row.
 *
 * `(no PR)` is a THIRD message and deliberately not folded into the other two: a branch nobody has
 * proposed is not abandoned, it is plausibly somebody's live work, and it is the one case where "wait"
 * may genuinely be right.
 */
test("a held region names each branch's PR state, and `no PR` stays its own answer", () => {
  const v = startability({
    ...clear,
    heldRegions: [{ path: "packages/evidence/src/verify.ts", refs: [
      "origin/agent/identify-input-purpose-79 (PR #89 CLOSED)",
      "origin/agent/same-document-resolved-url (no PR)",
    ] }],
  });
  const text = v.lines.join("\n");
  assert.match(text, /PR #89 CLOSED/, "nobody is coming");
  assert.match(text, /\(no PR\)/, "unproposed is not abandoned, and must not read as either of the others");
  assert.equal(v.code, 0, "contention is still a merge cost, not a blocker -- decorating it changes nothing");
});

/**
 * "NAMED NOTHING" AND "NAMED PROSE" ARE TWO DIFFERENT SENTENCES (#228).
 *
 * The `.md` filter is correct: there is no symbol to verify in a README, and pretending to check one
 * would be worse than saying nothing. But dropping prose paths SILENTLY made the verdict tell a docs row
 * it *"names no source path"* — when it named one, `packages/cli/README.md`, in a Region field that was
 * filled in correctly. That sends its author to fix something that is not broken.
 *
 * This is the third time tonight this tool's WALK was right and its SENTENCE was wider: #218 said
 * STARTABLE for a closed row, #227 said a branch held a region without saying whether it would ever land,
 * and this. All three are the census's own fourth shape, in the tool its author wrote.
 */
test("a row whose Region is PROSE is told so, and NOT told to add a Region it already has", () => {
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0, prose: 1 } });
  assert.equal(v.code, 2, "still inconclusive -- this checks code and cannot judge a document");
  const text = v.lines.join("\n");
  assert.match(text, /names 1 document\(s\)/);
  assert.match(text, /NOT a missing Region: do not add one/,
    "the whole point: its author filled the field in correctly and must not be sent back to it");
  assert.doesNotMatch(text, /names no source path/,
    "that is the OTHER sentence, for a row that named nothing at all");
});

test("a row that named nothing at all still gets the original sentence", () => {
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0, prose: 0 } });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /names no source path and no symbol/);
  assert.doesNotMatch(v.lines.join("\n"), /document\(s\)/,
    "collapsing the two is what made the docs message wrong; keep them apart in both directions");
});

/**
 * #719: `row-reachability` asked "is this symbol in the files the row NAMES" and reported the answer as
 * "is this symbol on `main`" — a different question its own Region cannot always answer, because a row's
 * extracted Region can miss a real file (a bare filename after a full path, a glob) without the row being
 * wrong about anything.
 *
 * THE REGRESSION FIXTURE IS #687's REAL BODY, VERBATIM (`fixtures/issue-687-body.txt`) — the case nobody
 * wrote, and the reason the existing population of hand-built fixtures above never caught this. Its own
 * Region names five things; `regionPathsFromBody` recovers three, and `environmentKey` — real, and on
 * `main` at `packages/lab/src/training/capture-cache.mjs` the entire time — lives in one of the two it
 * misses. `facts()`/`subjectAndRegionFacts()` are the actual mechanism (`startability` above is the pure
 * verdict one level up, already exercised against hand-built facts; this is the layer that computes them).
 *
 * These tests drive `subjectAndRegionFacts` against the real `origin/main` and real remote refs in
 * whatever checkout runs them, exactly as `facts()` does live — no live `gh issue view` in the test itself
 * (the body is a saved snapshot, so an edit to the real #687 cannot make this test flaky), but a real `git
 * grep` against a real, shared object database, the same choice `pre-push-resolve-toward-main.test.ts`
 * makes for the same reason: a guard whose fixture is invented is one nobody has seen bite.
 */
/**
 * Is `origin/main` a readable ref HERE? — #772, and the answer is not always yes.
 *
 * CI's acceptance job checks out the PR's merge ref and has no `origin/main`: measured, `git grep … 
 * origin/main` there is `fatal: ambiguous argument 'origin/main': unknown revision`. The tests below drive
 * the real object database deliberately — a guard whose fixture is invented is one nobody has seen bite —
 * but that choice means the ref they need can be absent, and **before #772 those runs passed anyway**,
 * because an unreadable ref returned the same empty list as a ref that genuinely lacked the symbol. Three
 * assertions in this file were green in CI for that reason, which is the very conflation the row fixes.
 *
 * So they SKIP LOUDLY where the ref is missing, rather than asserting against an environment they do not
 * have — and rather than passing for a reason that has nothing to do with what they claim.
 */
function originMainReadable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checked at RUN time and reported, never as a `{ skip }` option: a skipped test is invisible in an
 * ordinary run and reads as "not applicable", and this one is skipped for a reason a reader needs — the
 * checkout has no `origin/main`, so the real-object-database tests below cannot be asked at all.
 */
function skipsWithoutOriginMain(): boolean {
  if (originMainReadable()) return false;
  console.error("SKIPPED (no `origin/main` in this checkout, as CI's acceptance job has none): this test "
    + "drives the real object database, and a ref it cannot read is not a result it can assert on.");
  return true;
}

/**
 * #1064: THE REF POPULATION, AND WHY ITS FLOOR NEEDS THE SAME TREATMENT `origin/main` GOT.
 *
 * The floor below asserts `examined.refs > 0`, and #772 added it for a reason that is still right: `const
 * refs = []` keeps the spelling, keeps the count, and reports zero for every row for ever. **An empty
 * population must not read as a clean result.**
 *
 * But it was asserting against an environment CI does not have. `actions/checkout` fetches the pull
 * request's ref and its base -- not the other ~290 `origin/agent/*` -- so the count is legitimately zero
 * and the test failed on the checkout rather than on the code. Measured: `docs` was red on #1057 (whose
 * tree predates #1056) and on #1062, both `not ok 2078`, and #1057 MERGED through it.
 *
 * So: the sibling of `skipsWithoutOriginMain`, one population along. A ref population it cannot have is
 * not a result it can assert on either.
 *
 * WHAT MAKES THE READ NON-CIRCULAR. Asking "are there unmerged refs" a second way would be asking the
 * function under test. This asks a DIFFERENT question with a certain answer: does this checkout hold any
 * remote-tracking ref under `origin/` besides main and HEAD? If it holds none, zero is explained by the
 * checkout and the floor can discriminate nothing.
 *
 * AND A NOTE ON THE NAME, because the message below inherits it. `unmergedRefs()` enumerates
 * `refs/remotes/origin` minus `origin/main` and `origin/HEAD` -- it never asks whether anything is
 * MERGED. A branch fully landed on main is in that list. The floor's own failure text says "this checkout
 * has unmerged remote branches", which is a claim the function does not compute; this file cannot fix the
 * name (out of #1064's Region) and will not repeat it.
 */
export function remoteRefsBesidesMain(
  { run = defaultForEachRef }: { run?: () => string } = {},
): number {
  try {
    return run().split("\n").map((r) => r.trim())
      .filter((r) => r && r !== "origin/main" && !r.startsWith("origin/HEAD")).length;
  } catch {
    return 0;
  }
}

const defaultForEachRef = (): string =>
  execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * #1064: `"skip"` when the checkout cannot hold a population, `"held"` when the floor is satisfied,
 * `"vacuous"` when there is a population to search and the search returned nothing.
 *
 * PURE, so both directions are drivable. A skip proved only by running in an environment that happens to
 * lack refs is a skip proved to be quiet, which is the defect this row is about wearing a different hat.
 */
export function refPopulationVerdict(
  { available, examined }: { available: number; examined: number | undefined },
): "skip" | "held" | "vacuous" {
  if (available === 0) return "skip";
  return examined !== undefined && examined > 0 ? "held" : "vacuous";
}

/**
 * Reported at RUN time and never as a `{ skip }` option, for `skipsWithoutOriginMain`'s reason: a skipped
 * test is invisible in an ordinary run and reads as "not applicable", and this one is skipped for a reason
 * a reader needs.
 */
export function refFloorSkipped(available: number, { warn = console.error } = {}): boolean {
  if (available > 0) return false;
  warn("SKIPPED, ref-population floor only (this checkout holds no remote-tracking branch under "
    + "`origin/` besides main, as a CI checkout does not): a zero here is explained by the checkout, so "
    + "the floor can tell nothing from it. The rest of this test still ran.");
  return true;
}

test("#719 REGRESSION: #687's real body, whose Region misses environmentKey's actual file", () => {
  if (skipsWithoutOriginMain()) return;
  const body = readFileSync(
    fileURLToPath(new URL("./fixtures/issue-687-body.txt", import.meta.url)), "utf8");
  const result = subjectAndRegionFacts(body);
  assert.ok(result.examined.symbols > 0, "the fixture must actually name a symbol, or this proves nothing");
  // #772: AND THE REF POPULATION, for the same reason one line up. `refs: refs.length` being spelled in the
  // source is not the same as `unmergedRefs()` being what fills it -- `const refs = []` keeps the spelling,
  // keeps the count, and reports zero for every row for ever, with the NOTE printing each time.
  const available = remoteRefsBesidesMain();
  if (!refFloorSkipped(available)) {
    assert.notEqual(refPopulationVerdict({ available, examined: result.examined.refs }), "vacuous",
      `this checkout holds ${available} remote-tracking branch(es) besides main, so a zero here means the `
      + "search read no population -- the same 'proves nothing' the symbol floor beside it guards against");
  }
  const missing = result.subjectsMissing.map((s) => s.name);
  assert.ok(!missing.includes("environmentKey"),
    "environmentKey has been on main all along (packages/lab/src/training/capture-cache.mjs); reporting "
    + `it missing is the exact bug this row fixes. Reported missing: ${JSON.stringify(missing)}`);
});

/**
 * THE FALSE POSITIVE HALF: a branch was named a "carrier" of a missing symbol only because it touched a
 * Region file whose TEXT happened to contain the string — the row's own issue calls this out as a red
 * herring, since nothing about that branch is where the symbol actually lives.
 *
 * `refsCarryingSymbol` no longer takes a path at all (compare its signature to the old `refsCarrying`) —
 * it searches a ref's WHOLE TREE, so there is no Region file left to accidentally match against. Proven
 * with a REAL local ref rather than a mock: the fix IS the `git grep` invocation, and faking git would
 * test nothing. The ref lives under a disposable namespace, created and deleted in the same test — the
 * same convention `git-fixture-cache.mjs` (#660) uses for its own temporary refs — so nothing is left in
 * the shared object database this worktree's `.git` carries.
 */
/**
 * #770 REGRESSION: THIS TEST WAS ITS OWN COUNTEREXAMPLE. `symbolOnMain` asks `git grep` of `origin/main`'s
 * WHOLE TREE -- and once this test file itself is merged, its own literal fixture-symbol string is PART
 * of that tree, in this very file. The PR job's `origin/main` is the OLD one (this branch has not landed
 * yet), so a "guaranteed absent" assertion passed there -- and failed on `trunk-guard`, which runs AFTER
 * the merge, against the NEW `origin/main` that now contains this file. Same class of bug as #621's
 * self-reference guard in `acceptance-commands.mjs` (a check walking its own describing code), one file
 * over. `git grep` is comment-blind, unlike that file's `stripComments`-protected walk -- so even a
 * comment quoting the fixture symbol verbatim would self-match; this doc comment deliberately never
 * spells it out. Fixed the identical way `fingerprint()` fixes it there: concatenated below so the
 * literal substring never appears contiguously anywhere in this file, prose included.
 */
/**
 * #1038: THE SYMBOLS MOVED TO `scripts/fixture-symbols.mjs`, AND THE COMMENT ABOVE IS WHY THEY HAD TO.
 *
 * That doc comment named this exact trap, for the #719 fixture, eight lines above a control that then
 * walked into it — and main went red for 0.38 hours on this file's own merge. **A comment is not a
 * guard.** The registry is now data in one module, and `fixture-absence-guard.test.ts` asserts every entry
 * is absent from the TRACKED WORKING TREE — the tree that contains the file under review, which
 * `origin/main` at review time structurally cannot be.
 */


test("#719: a branch is a named carrier only when it actually contains the symbol, anywhere in its tree", () => {
  if (skipsWithoutOriginMain()) return;
  const env = sandboxGitEnv();
  const FIXTURE_SYMBOL =
    ABSENT_FIXTURE_SYMBOLS["row-reachability.test.ts #719: the carrier fixture's symbol"];
  const REF = "refs/remotes/origin/row-reachability-fixture-719";
  const tmpIndex = execFileSync("mktemp", { encoding: "utf8" }).trim();
  try {
    // Not on `main`, guaranteed -- a name this specific occurs nowhere in real history.
    assert.equal(symbolOnMain(FIXTURE_SYMBOL), false);

    // A commit adding ONE new file, at a path this fixture never claims as a Region -- so a carrier found
    // here can only come from the whole-tree search this fix adds. The OLD, Region-scoped check would have
    // found nothing here even though the branch genuinely carries the symbol.
    const indexEnv = { ...env, GIT_INDEX_FILE: tmpIndex };
    execFileSync("git", ["read-tree", "origin/main"], { encoding: "utf8", env: indexEnv });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"],
      { encoding: "utf8", env, input: `export const ${FIXTURE_SYMBOL} = true;\n` }).trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", "100644", blob,
      "zz-row-reachability-fixture-719.mjs"], { encoding: "utf8", env: indexEnv });
    const tree = execFileSync("git", ["write-tree"], { encoding: "utf8", env: indexEnv }).trim();
    // `-c user.name=`/`-c user.email=` -- PER-INVOCATION, never touching the real repo's config. A CI
    // runner has no global git identity configured (only this machine does), and `commit-tree` refuses
    // to make a commit object without one -- measured live: this exact test failed in CI with "Author
    // identity unknown" while passing locally, the same class of environment-dependent gap this session's
    // own `runInSyntheticRepo` (pre-push-resolve-toward-main.test.ts) already works around.
    const commit = execFileSync("git",
      ["-c", "user.name=row-reachability-fixture", "-c", "user.email=fixture@example.invalid",
        "commit-tree", tree, "-p", "origin/main", "-m",
        "row-reachability #719 fixture (throwaway, deleted at the end of this test)"],
      { encoding: "utf8", env }).trim();
    execFileSync("git", ["update-ref", REF, commit], { encoding: "utf8", env });

    assert.deepEqual(refsCarryingSymbol(FIXTURE_SYMBOL, [REF]), [REF],
      "the symbol lives in this ref's tree, in a file this fixture's Region never names -- a whole-tree "
      + "search must find it regardless of where it landed");
    assert.deepEqual(refsCarryingSymbol(FIXTURE_SYMBOL, ["origin/main"]), [],
      "and a ref that does not actually contain it must not be reported");
  } finally {
    try { execFileSync("git", ["update-ref", "-d", REF], { encoding: "utf8", env }); }
    catch { /* never created -- nothing to remove */ }
    try { execFileSync("rm", ["-f", tmpIndex]); } catch { /* already gone */ }
  }
});

/**
 * #772: "NO MATCH" AND "COULD NOT READ THIS REF" ARE NOT THE SAME ANSWER.
 *
 * `refsCarryingSymbol` caught every `git grep` failure and treated it as "this ref does not carry it" —
 * the old comment said so outright: *"either way, it does not carry it"*. In a checkout with no remote
 * branches fetched, every ref is unreadable, so every symbol reads as carried by nothing, `subjectsMissing`
 * comes back empty and the row reports STARTABLE. **A clean answer from a question never asked**, which is
 * the direction that looks like success.
 *
 * `symbolOnMain` — thirty lines above it in the same file — already draws the line: exit 1 is git grep's
 * own "no match", a real no; anything else (128 for an unreadable revision) must reach `main()`'s
 * CANNOT_ASK path. The rule was stated once and not followed by its neighbour.
 */
test("#772: an UNREADABLE ref throws rather than reporting the symbol absent", () => {
  // Concatenated: a literal here would put the symbol in this file's own tree, and a later assertion that
  // it is absent from `origin/main` would then fail once this test merges — #770's own regression, which
  // this file already carries a doc comment about.
  const symbol = `refsCarry${"ingSymbol"}`;
  assert.throws(() => refsCarryingSymbol(symbol, ["origin/this-ref-does-not-exist"]),
    (error: unknown) => (error as { status?: number }).status !== 1,
    "a ref git cannot read must not be silently reported as not carrying the symbol -- with no remote "
    + "branches fetched, that reads every row as STARTABLE");
});

test("#772 CONTROL: a real ref that genuinely lacks the symbol is still a plain, quiet no",
  () => {
  if (skipsWithoutOriginMain()) return;
  // The other direction, and the one a fix aimed only at the throw would break: exit 1 is a real answer.
  // CONCATENATED for the reason the doc comment above `fixtureSymbolName` gives, which this test did not
  // take and #1023's merge then proved: written whole, the literal was guaranteed absent from
  // `origin/main` only until this very file merged INTO `origin/main`, at which point `refsCarryingSymbol`
  // correctly found it here and the control failed. The function was right; the fixture named itself.
  // #1038: FROM THE REGISTRY, so the guard that checks the working tree has this claim in its population.
  // Assembled here it would be invisible to it, which is how this assertion came to be checked only
  // against a tree that could not disagree with it.
  const absentEverywhere =
    ABSENT_FIXTURE_SYMBOLS["row-reachability.test.ts #772 CONTROL: the symbol no tree holds"];
  assert.deepEqual(refsCarryingSymbol(absentEverywhere, ["origin/main"]), [],
    "git grep's exit 1 is a genuine 'not present', and must stay a quiet empty result");
});

test("#772: `onMain` THROWS when `origin/main` cannot be read -- it never reports the path absent", () => {
  // THE CALL SITE, not the function. Driving `proveOriginMainReadable` holds the function and misses the
  // call being DELETED from `onMain`; asserting the call on the source holds the call and misses a
  // swallowed failure inside. worker-judge: neither half alone holds it, and the failure is identical
  // either way -- one line gone, every declared path reads as absent, nothing goes red.
  const throwing = () => { throw new Error("fatal: bad revision"); };
  assert.throws(() => onMain("packages/lab/src/dataset-paths.mjs", { run: throwing }), /bad revision/,
    "an unreadable origin/main must reach main()'s CANNOT_ASK path, never `return false` -- `cat-file -e` "
    + "gives 128 for a missing PATH and a missing REVISION alike, so `false` here would report the whole "
    + "Region unlanded");
});

test("#772: proving `origin/main` is DRIVEN -- a `rev-parse` that fails must reach CANNOT_ASK", () => {
  // The stub is the whole fixture, and it is here because the alternative -- a checkout with no
  // `origin/main` inside one that has it -- is a sandbox this test does not need. `cat-file -e` returns
  // 128 for a missing PATH and 128 for a missing REVISION alike, so without proving the revision first
  // every declared path reads as absent and the row reports its whole Region unlanded.
  //
  // Driven rather than asserted on the source: a text check catches the call being DELETED and misses a
  // swallowing `try` inside it -- still called, still named, unable to fail. worker-judge's finding, and
  // it is the proof that proves nothing.
  assert.throws(() => proveOriginMainReadable({ run: () => { throw new Error("fatal: bad revision"); } }),
    /bad revision/, "an unreadable origin/main must throw out to main()'s CANNOT_ASK path");
  assert.doesNotThrow(() => proveOriginMainReadable({ run: () => "abc123" }),
    "and a readable one must not -- the guard is a refusal, not a wall");
});


// ---------------------------------------------------------------------------------------------------
// #1054: THE CONTENTION HALF READS THE DECLARED REGION, AND A DIRECTORY PREFIX IS SEARCHED
//
// Measured on #907 at 2026-09-12T05:40Z, through these exact functions, from the row's real body:
//
//   examined: {"paths":0,"symbols":1,"prose":1,"refs":291}   heldRegions: 0
//   "#907 is STARTABLE: ... no unmerged branch is in its region (0 path(s), ...)"
//
// #907's Region is `CLAUDE.md`, `docs/` and `packages/lab/src/packaging/`. `regionPathsFromBody` -- the
// whole-body prose scan this file used for BOTH halves -- returned `["docs/backlog.md"]`, a path from the
// row's PROSE, which the `.md` filter then moved to `prose`. So `paths` was empty, the walk ran over
// nothing, and the verdict stated a positive fact about a population of zero. `row-claim claim` refused
// the same row for overlapping an OPEN PR in `packages/lab/src/packaging/`.
//
// TWO SEPARATE DEFECTS, AND ONLY ONE IS THE EXTRACTOR. The other is that `examinedNothing`'s guard was a
// DISJUNCTION across two populations: one backticked symbol certified a region nothing had read. A guard
// whose whole header says "STARTABLE having examined nothing is the defect this repo records most"
// cannot be satisfied by a different population being non-empty.

/** A real git repository with a real `origin/main`, so the two-diff conjunction is exercised, not faked. */
function syntheticRepo(): { repo: string; run: (args: string[]) => string; cleanup: () => void } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "a11y-region-walk-")));
  const run = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: sandboxGitEnv(), stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  mkdirSync(resolve(repo, "docs"));
  writeFileSync(resolve(repo, "docs/guide.md"), "one\n");
  writeFileSync(resolve(repo, "elsewhere.mjs"), "export const a = 1;\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "base"]);
  run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return { repo, run, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

/** A branch off `origin/main` that changes `path`, left unmerged. */
function branchTouching(run: (args: string[]) => string, repo: string, name: string, path: string): void {
  run(["checkout", "--quiet", "-b", name, "origin/main"]);
  writeFileSync(resolve(repo, path), "changed\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", `touch ${path}`]);
  run(["checkout", "--quiet", "main"]);
}

const REGION_IS_A_DIRECTORY = "## Region\n\n```\ndocs/\n```\n";

test("#1054 ACCEPTANCE: a directory-prefix Region is SEARCHED -- the walk FINDS contention under it", () => {
  const { repo, run, cleanup } = syntheticRepo();
  try {
    branchTouching(run, repo, "feature", "docs/guide.md");
    const facts = subjectAndRegionFacts(REGION_IS_A_DIRECTORY, {
      run, refs: () => ["feature"], state: () => "no PR",
      regionFiles: (body: string) => declaredRegionFiles(body, { rootFiles: new Set<string>() }),
    });
    assert.equal(facts.examined.region, 1, "the declared prefix must reach the walk as one entry");
    assert.deepEqual(facts.heldRegions.map((h: { path: string }) => h.path), ["docs/"],
      "a branch changing a file UNDER the declared directory holds that directory");
  } finally { cleanup(); }
});

test("#1054 ACCEPTANCE, THE NEGATIVE CONTROL: the same walk says CLEAR when nothing is under the prefix", () => {
  // Without this the test above is satisfied by a walk that reports every prefix held, which is the
  // "eighty-five branches" report this file's own header records as the answer nobody reads.
  const { repo, run, cleanup } = syntheticRepo();
  try {
    branchTouching(run, repo, "feature", "elsewhere.mjs");
    const facts = subjectAndRegionFacts(REGION_IS_A_DIRECTORY, {
      run, refs: () => ["feature"], state: () => "no PR",
      regionFiles: (body: string) => declaredRegionFiles(body, { rootFiles: new Set<string>() }),
    });
    assert.equal(facts.examined.region, 1, "the prefix is still examined -- this is a clear answer, not an absent one");
    assert.deepEqual(facts.heldRegions, [], "a branch outside the declared directory holds nothing in it");
  } finally { cleanup(); }
});

test("#1054: the two extractors read one Region section, and the CONTENTION half takes the declared one", () => {
  // The drift itself, asserted directly rather than through a verdict string. `regionPathsFromBody` is
  // still right for the SUBJECT half -- #719 searches a symbol tree-wide on purpose -- so this pins the
  // SPLIT, not a replacement.
  assert.deepEqual(regionPathsFromBody(REGION_IS_A_DIRECTORY), [],
    "the prose scan cannot see a directory prefix -- that is the fact, not the bug");
  assert.deepEqual(declaredRegionFiles(REGION_IS_A_DIRECTORY, { rootFiles: new Set<string>() }), ["docs/"],
    "the declared reader can, since #941");
  const { run, cleanup } = syntheticRepo();
  try {
    const facts = subjectAndRegionFacts(REGION_IS_A_DIRECTORY, { run, refs: () => [], state: () => "no PR" });
    assert.equal(facts.examined.paths, 0, "the subject half still reads the whole body and finds no source path");
    assert.equal(facts.examined.region, 1,
      "and the contention half reads the DECLARED section -- if these are ever equal again the copies have re-merged");
  } finally { cleanup(); }
});

test("#1054: a path named ONLY in the row's prose is not contention", () => {
  // #907's `docs/backlog.md` is the live example: named in a sentence about what a guard checks, never
  // declared. A row that cites somebody else's file as an example does not hold it.
  const body = `${REGION_IS_A_DIRECTORY}\n\nThe guard also reads \`elsewhere.mjs\`, which is not ours.\n`;
  const { repo, run, cleanup } = syntheticRepo();
  try {
    branchTouching(run, repo, "feature", "elsewhere.mjs");
    const asked: string[] = [];
    const spy = (args: string[]) => { if (args[0] === "diff") asked.push(args[args.length - 1]); return run(args); };
    const facts = subjectAndRegionFacts(body, {
      run: spy, refs: () => ["feature"], state: () => "no PR",
      regionFiles: (b: string) => declaredRegionFiles(b, { rootFiles: new Set<string>() }),
    });
    assert.deepEqual(facts.heldRegions, [], "the prose mention must not become a held region");
    assert.ok(!asked.includes("elsewhere.mjs"),
      "and it must never be ASKED about -- a clear answer about a path it queried would pass this by luck");
  } finally { cleanup(); }
});

test("#1054 MUTATION TARGET: one symbol must not certify a region nothing examined", () => {
  // #907's exact shape: paths 0, symbols 1, region 0. The old guard returned early on `symbols > 0` and
  // the verdict then stated "no unmerged branch is in its region" over an empty set.
  const v = startability({
    row: 907, subjectsMissing: [], heldRegions: [], state: "OPEN",
    examined: { paths: 0, symbols: 1, prose: 1, refs: 291, region: 0 },
  });
  const text = v.lines.join("\n");
  assert.ok(!/no unmerged branch is in its region/.test(text),
    "a positive claim about a population of zero is the defect this row exists to remove");
  assert.match(text, /region was NOT examined/, "and the reader is told which half did not answer");
  assert.match(text, /0 declared region entr\(ies\)/, "with the count that says so");
});

test("#1054: a Region of only directories is not CANNOT_ASK -- three entries and 291 refs is a real search", () => {
  const v = startability({
    row: 907, subjectsMissing: [], heldRegions: [], state: "OPEN",
    examined: { paths: 0, symbols: 0, prose: 0, refs: 291, region: 3 },
  });
  assert.equal(v.code, 0, "the region population counts as something examined");
  assert.match(v.lines.join("\n"), /3 declared region entr\(ies\)/);
});

test("#1054: the verdict NAMES the rule it did not run -- B4 lives on the claim path", () => {
  const v = startability({
    row: 189, subjectsMissing: [], heldRegions: [], state: "OPEN",
    examined: { paths: 3, symbols: 2, refs: 40, region: 2 },
  });
  assert.match(v.lines.join("\n"), /IT DOES NOT RUN B4/,
    "a pre-check that answers in the deciding rule's vocabulary must say which rule it skipped");
  assert.match(v.lines.join("\n"), /can read STARTABLE where the claim is refused/);
});

test("#1054: an OPEN pull request in the region is not 'a merge cost' -- claim WILL refuse", () => {
  const contested = startability({
    row: 907, subjectsMissing: [], state: "OPEN",
    heldRegions: [{ path: "packages/lab/src/packaging/", refs: ["origin/agent/x (PR #1052 OPEN)"],
      openPrs: ["origin/agent/x"] }],
    examined: { paths: 0, symbols: 1, refs: 291, region: 3 },
  });
  const text = contested.lines.join("\n");
  assert.match(text, /EXPECT `row-claim claim` TO REFUSE THIS/);
  assert.ok(!/merge cost, not a blocker/.test(text),
    "telling a reader it is only a merge cost sends them to a refusal they were assured would not happen");
  assert.match(text, /Narrowing the Region to route around it is not a remedy/);

  const dead = startability({
    row: 907, subjectsMissing: [], state: "OPEN",
    heldRegions: [{ path: "docs/", refs: ["origin/agent/y (PR #181 CLOSED)"], openPrs: [] }],
    examined: { paths: 0, symbols: 1, refs: 291, region: 3 },
  });
  assert.match(dead.lines.join("\n"), /merge cost, not a blocker/,
    "and a dead branch genuinely IS only a merge cost -- the distinction is the point");
});

test("#1054: every OPEN pull request is named, the rest are counted -- and the count is stated, not cut", () => {
  const summary = heldRefsSummary([
    { ref: "origin/a", state: "PR #1052 OPEN" },
    { ref: "origin/b", state: "no PR" },
    { ref: "origin/c", state: "PR #181 CLOSED" },
    { ref: "origin/d", state: "PR #172 CLOSED" },
  ]);
  assert.match(summary.join(" "), /origin\/a \(PR #1052 OPEN\)/, "the one B4 acts on is named");
  assert.ok(!/origin\/c/.test(summary.join(" ")), "a closed PR is a number, not a line");
  assert.match(summary.join(" "), /3 branch\(es\) \(1 with no PR, 2 whose PR is CLOSED\)/,
    "the count and the states are stated -- a list cut to fit reads as a complete list");
  assert.deepEqual(heldRefsSummary([{ ref: "origin/z", state: "no PR" }]),
    ["1 branch(es) (1 with no PR) -- a merge cost, nobody to wait for"],
    "and with no OPEN holder there is no dangling 'and N more' after a list that was never printed");
});

test("#1064: the ref floor SKIPS where the checkout cannot hold a population, and HOLDS where it can", () => {
  // Driven over injected counts, both directions, because a skip proved only by running somewhere that
  // happens to lack refs is a skip proved to be quiet. CI is the "skip" row; this checkout is "held".
  assert.equal(refPopulationVerdict({ available: 0, examined: 0 }), "skip",
    "no remote-tracking branch besides main: a zero is explained by the checkout, not by the code");
  assert.equal(refPopulationVerdict({ available: 0, examined: undefined }), "skip",
    "and an absent count is the same situation, not a worse one");
  assert.equal(refPopulationVerdict({ available: 290, examined: 290 }), "held",
    "a checkout with branches, and a search that read them");
  assert.equal(refPopulationVerdict({ available: 290, examined: 0 }), "vacuous",
    "#772's case, which must still fail: `const refs = []` keeps the spelling and loses the population");
  assert.equal(refPopulationVerdict({ available: 290, examined: undefined }), "vacuous",
    "and a count that is not reported at all is not a pass");
});

test("#1064: the floor is the ONLY conditional part -- the row's own subject still runs without refs", () => {
  // The cure must not kill the patient. #719's finding is that `environmentKey` is reported missing; that
  // assertion does not depend on the ref population and must not become conditional on it. Asserted on the
  // real body, with the ref question answered as CI answers it.
  if (skipsWithoutOriginMain()) return;
  const body = readFileSync(
    fileURLToPath(new URL("./fixtures/issue-687-body.txt", import.meta.url)), "utf8");
  const result = subjectAndRegionFacts(body);
  assert.equal(refPopulationVerdict({ available: 0, examined: result.examined.refs }), "skip",
    "the floor is skipped in a CI-shaped checkout");
  assert.ok(!result.subjectsMissing.map((s) => s.name).includes("environmentKey"),
    "and the subject assertion still runs and still holds -- losing it to an environment check would be "
    + "the cure killing the patient");
});


test("#1064: the two impure halves are driven too -- the seam is not the call site", () => {
  // Mutation found this gap and reading did not: `refPopulationVerdict` was covered while the two helpers
  // that decide whether it is CONSULTED were not. `refFloorSkipped` returning true unconditionally, and
  // `remoteRefsBesidesMain` returning 0 unconditionally, were both **0 red** -- the skip would have been
  // permanent and every assertion here would still have passed.
  const said: string[] = [];
  assert.equal(refFloorSkipped(0, { warn: (m: string) => said.push(m) }), true);
  assert.equal(said.length, 1, "and it SAYS so -- a silent skip reads as 'not applicable'");
  assert.match(said[0], /SKIPPED, ref-population floor only/);
  assert.match(said[0], /The rest of this test still ran/,
    "the message must scope itself, or a reader takes the whole test as skipped");

  said.length = 0;
  assert.equal(refFloorSkipped(290, { warn: (m: string) => said.push(m) }), false,
    "with a population available the floor is REACHED -- an unconditional skip is the mutation this catches");
  assert.deepEqual(said, [], "and nothing is announced when nothing was skipped");

  const refs = ["origin/main", "origin/HEAD -> origin/main", "origin/agent/x", "origin/agent/y", ""];
  assert.equal(remoteRefsBesidesMain({ run: () => refs.join("\n") }), 2,
    "main, HEAD and the blank line are excluded and the two branches counted -- an environment read that "
    + "always answers zero makes the skip permanent and nothing else here would notice");
  assert.equal(remoteRefsBesidesMain({ run: () => "origin/main\n" }), 0, "and a CI-shaped checkout is zero");
});
