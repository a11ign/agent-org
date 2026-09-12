/**
 * #735: the FILING-side twin of #707's claim-side gate -- `scripts/row-file.mjs` refuses to run
 * `gh issue create` when the body it would file is missing Region, Acceptance or Open-check, using the
 * SAME rule `row-claim` already enforces at claim time (`missingTemplateFields`, imported unchanged from
 * `row-claim/template-fields-rule.mjs`), asked one step earlier so the cost lands on whoever holds the
 * context rather than whoever claims the row later.
 *
 * #771: it also REQUIRES `--session=<name>` (the same flag `row-claim.mjs` uses) and writes
 * `Filed-by: <session>` into the body that actually reaches `gh` -- see `row-claim.mjs`'s `filedByLine`
 * for the read side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyFromArgv, fileRefusalReason, createIssue, sessionFromArgv, appendFiledBy, withFiledBy,
  boardingFor, issueNumberFromUrl, unverifiedFilingFields, fetchIssueBoardStatus, laneLabelsFor,
  milestoneRefusal,
} from "../../../../scripts/row-file.mjs";
import { filedByLine } from "../../../../scripts/row-claim.mjs";

const CLI = fileURLToPath(new URL("../../../../scripts/row-file.mjs", import.meta.url));

const COMPLETE_BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";

// --- bodyFromArgv: reading exactly the shape `gh issue create` itself would ---

test("bodyFromArgv: --body VALUE (two separate argv entries)", () => {
  assert.equal(bodyFromArgv(["--title", "x", "--body", "hello"]), "hello");
});

test("bodyFromArgv: --body=VALUE (one argv entry)", () => {
  assert.equal(bodyFromArgv(["--title=x", "--body=hello"]), "hello");
});

test("bodyFromArgv: --body-file PATH reads the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-file-test-"));
  try {
    const path = join(dir, "body.md");
    writeFileSync(path, "file contents\n");
    assert.equal(bodyFromArgv(["--body-file", path]), "file contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bodyFromArgv: --body-file=PATH reads the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-file-test-"));
  try {
    const path = join(dir, "body.md");
    writeFileSync(path, "file contents\n");
    assert.equal(bodyFromArgv([`--body-file=${path}`]), "file contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bodyFromArgv: --body-file - (gh's own stdin convention) reads as null, not a literal filename", () => {
  assert.equal(bodyFromArgv(["--body-file", "-"]), null);
  assert.equal(bodyFromArgv(["--body-file=-"]), null);
});

test("bodyFromArgv: neither flag present is null", () => {
  assert.equal(bodyFromArgv(["--title", "x", "--label", "backlog"]), null);
});

// --- fileRefusalReason: THE VERDICT, PURE ---

test("MUTATION TARGET: a body missing all three is refused, naming all three", () => {
  const reason = fileRefusalReason("just some prose, no headings at all");
  assert.ok(reason);
  assert.match(reason as string, /Region/);
  assert.match(reason as string, /Acceptance/);
  assert.match(reason as string, /Open-check/);
});

test("a body with only Open-check missing is refused, naming exactly that field", () => {
  const body = "## Region\n\nfoo\n\n## Acceptance\n\nbar\n";
  const reason = fileRefusalReason(body);
  assert.ok(reason);
  assert.match(reason as string, /Open-check/);
  assert.doesNotMatch(reason as string, /missing Region/);
});

test("a complete body is not refused", () => {
  assert.equal(fileRefusalReason(COMPLETE_BODY), null);
});

test("a null body (no --body/--body-file found) is refused with its own distinct message, never silently "
  + "treated as complete or as 'missing everything'", () => {
  const reason = fileRefusalReason(null);
  assert.ok(reason);
  assert.match(reason as string, /no --body or --body-file/);
});

// --- #771: sessionFromArgv / appendFiledBy / withFiledBy ---

test("sessionFromArgv reads --session=<name>", () => {
  assert.equal(sessionFromArgv(["--title", "x", "--session=worker-contracts"]), "worker-contracts");
});

test("sessionFromArgv is null when absent -- there is no space-separated --session <name> form, matching "
  + "row-claim.mjs's own convention exactly", () => {
  assert.equal(sessionFromArgv(["--title", "x"]), null);
  assert.equal(sessionFromArgv(["--session", "worker-contracts"]), null);
});

test("appendFiledBy lands the line on its own line regardless of the body's own trailing whitespace", () => {
  assert.equal(appendFiledBy("## Region\nfoo", "worker-contracts"),
    "## Region\nfoo\n\nFiled-by: worker-contracts\n");
  assert.equal(appendFiledBy("## Region\nfoo\n\n\n", "worker-contracts"),
    "## Region\nfoo\n\nFiled-by: worker-contracts\n");
});

test("withFiledBy replaces --body with the augmented text, strips --session, and leaves every other "
  + "argument in place", () => {
  const argv = ["--title", "x", "--body", "## Region\nfoo", "--session=worker-contracts", "--label", "backlog"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--label", "backlog", "--body",
    "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

test("withFiledBy also strips a --body-file form, replacing it with the augmented --body", () => {
  const argv = ["--title", "x", "--body-file=/tmp/x.md", "--session=worker-contracts"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--body", "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

test("withFiledBy strips --ready too -- #844's own flag, not gh's", () => {
  const argv = ["--title", "x", "--body", "## Region\nfoo", "--session=worker-contracts", "--ready"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--body", "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

// --- #844: boardingFor -- backlog unless --ready is explicitly given ---

test("boardingFor: no --ready -- backlog label, Backlog Status", () => {
  assert.deepEqual(boardingFor(["--title", "x"]), { label: "backlog", status: "Backlog" });
});

test("boardingFor: --ready given -- ready label, Ready Status, never both", () => {
  assert.deepEqual(boardingFor(["--title", "x", "--ready"]), { label: "ready", status: "Ready" });
});

// --- #883: laneLabelsFor -- derived from the SAME docs/lane-ownership.json the merge guard reads ---

const PIPELINE_LANE = { lane: "the pipeline", owner: "dispatcher", branchPrefixes: ["dispatcher/"],
  paths: [".github/workflows/"], why: "trunk health", except: [".github/workflows/consumer-gate.yml"] };
const DOCS_LANE = { lane: "docs", owner: "pm", branchPrefixes: ["pm/"], paths: ["docs/"], why: "docs" };

test("laneLabelsFor: a Region touching one lane's paths gets that lane's owner", () => {
  const labels = laneLabelsFor([".github/workflows/ci.yml"], { lanes: [PIPELINE_LANE] });
  assert.deepEqual(labels, ["lane:dispatcher"]);
});

test("#883 ACCEPTANCE: a Region touching TWO lanes names BOTH, never picks one silently", () => {
  const labels = laneLabelsFor([".github/workflows/ci.yml", "docs/README.md"],
    { lanes: [PIPELINE_LANE, DOCS_LANE] });
  assert.deepEqual(labels.sort(), ["lane:dispatcher", "lane:pm"]);
});

test("laneLabelsFor: a Region touching NO lane's paths gets lane:any -- a real answer, not a fallback", () => {
  const labels = laneLabelsFor(["scripts/row-file.mjs"], { lanes: [PIPELINE_LANE] });
  assert.deepEqual(labels, ["lane:any"]);
});

test("laneLabelsFor: an EMPTY Region (a non-code row) also gets lane:any", () => {
  assert.deepEqual(laneLabelsFor([], { lanes: [PIPELINE_LANE] }), ["lane:any"]);
});

test("#941: a DIRECTORY entry touches a lane lying inside it, or around it -- never lane:any by omission", () => {
  assert.deepEqual(laneLabelsFor([".github/"], { lanes: [PIPELINE_LANE] }), ["lane:dispatcher"], "the lane is inside it");
  assert.deepEqual(laneLabelsFor([".github/workflows/"], { lanes: [PIPELINE_LANE] }), ["lane:dispatcher"]);
  assert.deepEqual(laneLabelsFor([".github/workflows/nested/"], { lanes: [PIPELINE_LANE] }), ["lane:dispatcher"],
    "it is inside the lane");
  assert.deepEqual(laneLabelsFor(["scripts/", "docs/board/"], { lanes: [PIPELINE_LANE] }), ["lane:any"]);
});

test("#883 ACCEPTANCE, MUTATION TARGET: the label MOVES when lane-ownership.json's paths move -- a "
  + "row touching a path now assigned to a lane derives that lane; the identical row against the OLD "
  + "config (the path unassigned) derives lane:any instead. If the label does not move with the config, "
  + "it is a copy of the ruling, not a reading of it", () => {
  const path = "scripts/new-tool.mjs";
  const before = laneLabelsFor([path], { lanes: [PIPELINE_LANE] }); // path not yet owned by any lane
  assert.deepEqual(before, ["lane:any"]);
  const movedConfig = { lanes: [{ ...PIPELINE_LANE, paths: [...PIPELINE_LANE.paths, "scripts/new-tool.mjs"] }] };
  const after = laneLabelsFor([path], movedConfig); // the SAME path, now inside the lane's own paths
  assert.deepEqual(after, ["lane:dispatcher"]);
});

test("laneLabelsFor: an EXCEPTED path inside a lane's own directory does not pull that lane's label -- "
  + "the identical subtraction workflow-lane-check.mjs's own laneVerdict makes", () => {
  const labels = laneLabelsFor([".github/workflows/consumer-gate.yml"], { lanes: [PIPELINE_LANE] });
  assert.deepEqual(labels, ["lane:any"],
    "consumer-gate.yml is generated from README.md and excepted from the pipeline lane -- touching only "
    + "it must not derive lane:dispatcher");
});

// --- #844: issueNumberFromUrl ---

test("issueNumberFromUrl reads the number off gh issue create's own bare-URL stdout", () => {
  assert.equal(issueNumberFromUrl("https://github.com/DanBeckDev/a11y-witness/issues/900\n"), 900);
});

test("issueNumberFromUrl is null on anything that does not end in /issues/<digits>", () => {
  assert.equal(issueNumberFromUrl("not a url"), null);
  assert.equal(issueNumberFromUrl("https://github.com/DanBeckDev/a11y-witness/pull/900"), null);
});

// --- #844/#883: unverifiedFilingFields -- named, not a bare boolean ---

test("unverifiedFilingFields: everything confirmed, including a lane label -- empty", () => {
  const after = { labels: ["backlog", "lane:any"], body: "## Region\nfoo\n\nFiled-by: worker-contracts\n", boardStatus: "Backlog" };
  assert.deepEqual(unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] }), []);
});

test("unverifiedFilingFields: missing label named", () => {
  const after = { labels: ["lane:any"], body: "Filed-by: worker-contracts\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] });
  assert.deepEqual(missing, ["the `backlog` label"]);
});

test("#883: unverifiedFilingFields: a missing lane label is named distinctly from the board label", () => {
  const after = { labels: ["backlog"], body: "Filed-by: worker-contracts\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:dispatcher"] });
  assert.deepEqual(missing, ["`lane:dispatcher` label(s)"]);
});

test("#883: unverifiedFilingFields: MULTIPLE missing lane labels are all named together, not just one", () => {
  const after = { labels: ["backlog"], body: "Filed-by: worker-contracts\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:dispatcher", "lane:pm"] });
  assert.deepEqual(missing, ["`lane:dispatcher`/`lane:pm` label(s)"]);
});

test("unverifiedFilingFields: missing Filed-by named -- wrong session or absent line, both count", () => {
  const after = { labels: ["backlog", "lane:any"], body: "## Region\nfoo\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] });
  assert.deepEqual(missing, ["the Filed-by line"]);
});

test("unverifiedFilingFields: never on the board at all vs. on it with the WRONG Status are named "
  + "differently", () => {
  const notBoarded = { labels: ["backlog", "lane:any"], body: "Filed-by: worker-contracts\n", boardStatus: null };
  assert.deepEqual(unverifiedFilingFields(notBoarded,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] }),
    ["Project 2 membership"]);
  const wrongStatus = { labels: ["backlog", "lane:any"], body: "Filed-by: worker-contracts\n", boardStatus: "Ready" };
  assert.deepEqual(unverifiedFilingFields(wrongStatus,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] }),
    ['Project 2 Status (reads "Ready", not "Backlog")']);
});

test("unverifiedFilingFields: everything missing at once is all named, not just the first", () => {
  const after = { labels: [], body: null, boardStatus: null };
  const missing = unverifiedFilingFields(after,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] });
  assert.equal(missing.length, 4);
});

// --- #844: fetchIssueBoardStatus -- a single targeted read, not the whole board ---

test("fetchIssueBoardStatus reads the Status option name off the one matching project", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [
    { project: { number: 2 }, fieldValueByName: { name: "Backlog" } },
  ] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), "Backlog");
});

test("fetchIssueBoardStatus: no project item at all reads as null, not a crash", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), null);
});

test("fetchIssueBoardStatus: an item on a DIFFERENT project is not read as this one's Status", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [
    { project: { number: 7 }, fieldValueByName: { name: "Done" } },
  ] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), null);
});

test("MUTATION: fetchIssueBoardStatus throws, never returns null as if unboarded, when gh fails", () => {
  const run = () => { throw new Error("gh: not authenticated"); };
  assert.throws(() => fetchIssueBoardStatus(900, { run }), /could not read #900's Project membership/);
});

// --- #771 ACCEPTANCE: filedByLine (row-claim.mjs) reads exactly what row-file.mjs writes, and only that ---

test("#771 ACCEPTANCE: filedByLine reads the exact line appendFiledBy writes", () => {
  const augmented = appendFiledBy("## Region\nfoo", "worker-contracts");
  assert.equal(filedByLine(augmented), "worker-contracts");
});

test("#771 ACCEPTANCE, MUTATION TARGET: older prose ('Filed by `orchestrator`', no hyphen) is NEVER "
  + "inferred as the new line -- #737 and #758's real shape, both must read as absent", () => {
  const oldProseBody = "Found in #685's control arm. Filed by `orchestrator`; **not claimed**.\n\n"
    + "## The measurement\n";
  assert.equal(filedByLine(oldProseBody), null);
});

test("filedByLine is null on a body with no Filed-by line at all", () => {
  assert.equal(filedByLine("## Region\nfoo\n"), null);
});

// --- createIssue: the CLI's own decision, with every gh-facing dependency injected so nothing reaches
// the network. #844: files, labels, boards, sets Status, then reads all three back before reporting. ---

const FILED_URL = "https://github.com/DanBeckDev/a11y-witness/issues/900";

/** A `run` fake for the calls createIssue makes AFTER spawnGh: `gh project item-add` and the body
 * read-back (`gh issue view ... --json body --jq .body`). Everything else answers "" harmlessly. */
function afterRun(body: string, milestone = "CI reset") {
  // #1011: the read-back now asks for the milestone as well as the body -- `gh` ACCEPTING `--milestone` is
  // not evidence the field is set. A fixture that answers only the body would report the row unverified.
  return (_cmd: string, args: string[]) => {
    if (args.includes("milestone")) return milestone;
    return args.includes("body") ? body : "";
  };
}

/** The full set of happy-path dependencies, so each test overrides only what it means to test. */
/**
 * #1011: EVERY FILING NOW DECLARES A RELEASE, so every fixture below carries one. That is the row's whole
 * subject reaching its own tests: `row-file` refuses a row with neither a milestone nor `out-of-release`,
 * because the org's health check reads such a row as a finding within thirty minutes, and three rows
 * landed that way on 2026-09-11 -- one of them (#1003) also reaching the tracker off Project 2 and
 * blocking every Status move in the org until it was boarded by hand.
 */
const RELEASE = ["--milestone", "CI reset"];

/** The milestone reader, injected everywhere so no test reaches GitHub for the suggestion list. */
const MILESTONES = () => ["CI reset", "Road to version one"];

function happyDeps(session: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    spawnGh: () => FILED_URL,
    run: afterRun(appendFiledBy(COMPLETE_BODY, session)),
    fetchBoardStatus: () => (label === "ready" ? "Ready" : "Backlog"),
    fetchLabels: () => ({ number: 900, title: "a real row", labels: [label, "lane:any"] }),
    moveStatus: () => ({ moved: true as const }),
    milestones: MILESTONES,
    // #883: an EMPTY lane list -- no lane's `paths` can match anything, so `laneLabelsFor` always derives
    // `lane:any` regardless of COMPLETE_BODY's own Region content, keeping these tests independent of
    // docs/lane-ownership.json's real, changeable contents.
    loadLanesConfig: () => ({ lanes: [] }),
    ensureLabels: () => {},
    ...overrides,
  };
}

test("ACCEPTANCE: a complete body with --session= files -- spawnGh receives the body WITH Filed-by "
  + "appended and --session stripped, but NO --label at all: the board label is added later, never at "
  + "creation time (see #844's own header for why)", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let called: string[] | null = null;
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    spawnGh: (a) => { called = a; return FILED_URL; },
  });
  assert.equal(code, 0);
  // #1011: `--milestone` is PASSED THROUGH to `gh issue create` untouched -- this tool refuses a filing
  // that declares no release, and forwards the one it was given rather than restating it.
  // #1011: `--milestone` is PASSED THROUGH untouched -- this tool refuses a filing that declares no
  // release and forwards the one it was given. `withFiledBy` rebuilds `--body` at the END, which is why
  // the milestone precedes it here rather than trailing.
  assert.deepEqual(called, ["--title", "a real row", ...RELEASE, "--body",
    appendFiledBy(COMPLETE_BODY, "worker-contracts")]);
});

test("#844 ACCEPTANCE, MUTATION TARGET: the board label is added via a SEPARATE gh issue edit call, "
  + "AFTER the Status move succeeds, never before -- the exact ordering #867's own live dogfooding run "
  + "proved necessary: a `ready` label present before the item has a Status makes the row itself the "
  + "shape #747's board-safety floor refuses, on its own snapshot, every time", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE, "--ready"];
  const order: string[] = [];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "ready"),
    run: (cmd: string, args: string[]) => {
      if (args[1] === "item-add") order.push("board");
      if (args.includes("--add-label")) order.push(`label:${args[args.indexOf("--add-label") + 1]}`);
      return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(cmd, args);
    },
    moveStatus: (n: number, s: string) => { order.push(`status:${s}`); return { moved: true as const }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["board", "status:Ready", "label:ready"],
    `board, then Status, then the label -- got: ${JSON.stringify(order)}`);
});

test("ACCEPTANCE: the issue is added to Project 2 and its Status is moved to match the label, both "
  + "AFTER a successful gh issue create", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  const projectCalls: string[][] = [];
  const moveCalls: [number, string][] = [];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    run: (cmd: string, args: string[]) => {
      if (args[1] === "item-add") projectCalls.push(args);
      return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(cmd, args);
    },
    moveStatus: (n: number, s: string) => { moveCalls.push([n, s]); return { moved: true }; },
  });
  assert.equal(code, 0);
  assert.equal(projectCalls.length, 1);
  assert.ok(projectCalls[0].includes("--url") && projectCalls[0].includes(FILED_URL));
  assert.deepEqual(moveCalls, [[900, "Backlog"]]);
});

test("ACCEPTANCE, MUTATION TARGET: the issue number and https URL are read back and printed only after "
  + "every check confirms -- prints exactly the issue's own URL", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let printed = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try {
    const code = createIssue(argv, happyDeps("worker-contracts", "backlog"));
    assert.equal(code, 0);
    assert.equal(printed, `${FILED_URL}\n`);
  } finally {
    process.stdout.write = original;
  }
});

test("#883 ACCEPTANCE: a MULTI-LANE Region derives and applies BOTH lane labels through the whole "
  + "createIssue flow -- ensureLabels is asked to create both, and both are added in the same edit call "
  + "as the board label", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  // Two synthetic lanes both genuinely covering COMPLETE_BODY's own Region path
  // (packages/lab/src/packaging/foo.ts) by prefix, so this exercises real matching end to end rather
  // than a config chosen to avoid matching anything.
  const wideLane = { ...PIPELINE_LANE, lane: "wide", owner: "worker-a", paths: ["packages/lab/"] };
  const narrowLane = { ...DOCS_LANE, lane: "narrow", owner: "worker-b", paths: ["packages/lab/src/packaging/"] };
  const ensured: string[][] = [];
  let editArgs: string[] | null = null;
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog", {
      fetchLabels: () => ({ number: 900, title: "a real row",
        labels: ["backlog", "lane:worker-a", "lane:worker-b"] }),
      loadLanesConfig: () => ({ lanes: [wideLane, narrowLane] }),
    }),
    run: (cmd: string, args: string[]) => {
      if (args[1] === "edit") editArgs = args;
      return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(cmd, args);
    },
    ensureLabels: (labels: string[]) => { ensured.push(labels); },
  });
  assert.equal(code, 0);
  assert.deepEqual(ensured[0]?.sort(), ["backlog", "lane:worker-a", "lane:worker-b"].sort());
  const finalEditArgs = editArgs as string[] | null;
  assert.ok(finalEditArgs, "expected a gh issue edit call");
  assert.ok(finalEditArgs.includes("lane:worker-a") && finalEditArgs.includes("lane:worker-b"),
    `expected both lane labels in the edit call; got: ${JSON.stringify(finalEditArgs)}`);
});

test("#883 ACCEPTANCE, MUTATION TARGET: an unreadable/malformed docs/lane-ownership.json refuses BEFORE "
  + "gh issue create runs -- CANNOT_ASK, never \"nothing has a lane\"", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let called = false;
  const code = createIssue(argv, {
    spawnGh: () => { called = true; return FILED_URL; },
    loadLanesConfig: () => null,
  });
  assert.equal(code, 1);
  assert.equal(called, false, "nothing must be filed when the lane cannot be derived");
});

test("ACCEPTANCE: no --session= at all refuses -- spawnGh is NEVER called, even with a complete body", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; return FILED_URL; } });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test("ACCEPTANCE: an incomplete body still refuses even with --session= present -- spawnGh is NEVER called", () => {
  const argv = ["--title", "a real row", "--body", "no sections at all", "--session=worker-contracts", ...RELEASE];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; return FILED_URL; } });
  assert.equal(code, 1);
  assert.equal(called, false, "gh issue create must never run when the body is incomplete");
});

test("a gh failure (non-zero exit) is surfaced as this tool's own exit code, not swallowed as success", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  const code = createIssue(argv, {
    spawnGh: () => { throw Object.assign(new Error("gh failed"), { status: 7 }); },
  });
  assert.equal(code, 7);
});

test("#844 ACCEPTANCE: gh issue create succeeding but printing something that is not a real issue URL "
  + "is refused distinctly -- filed, but unboardable and unverifiable", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  const code = createIssue(argv, { spawnGh: () => "not a url at all" });
  assert.equal(code, 2);
});

test("#844 ACCEPTANCE: a failure adding the issue to Project 2 is refused distinctly (exit 2), naming "
  + "the issue number and the hand-recovery command -- it is NOT reported as a plain success", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      run: (_cmd: string, args: string[]) => {
        if (args[1] === "item-add") throw new Error("gh: could not add item");
        return "";
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900/);
    assert.match(stderr, /could NOT add it to Project/);
    assert.match(stderr, /gh project item-add 2 --owner DanBeckDev --url/);
  } finally {
    process.stderr.write = original;
  }
});

test("#844 ACCEPTANCE, MUTATION TARGET: a Status move that does not succeed is refused distinctly "
  + "(exit 2), never reported as filed cleanly", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    moveStatus: () => ({ moved: false, reason: "gh: rate limited", notOnBoard: false }),
  });
  assert.equal(code, 2);
});

test("#844 ACCEPTANCE: a label-add failure AFTER a successful Status move is refused distinctly (exit "
  + "2), naming the issue number and the Status already set, never reported as filed cleanly", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      run: (_cmd: string, args: string[]) => {
        if (args.includes("--add-label")) throw new Error("gh: label add failed");
        return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(_cmd, args);
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900, boarded with Status "Backlog"/);
    assert.match(stderr, /`backlog`\/`lane:any` could not be added/);
  } finally {
    process.stderr.write = original;
  }
});

test("#844 ACCEPTANCE, MUTATION TARGET: everything succeeds but the READ-BACK disagrees (e.g. the label "
  + "did not actually stick) -- refused distinctly (exit 2), naming what is missing, never reported as "
  + "filed cleanly on the strength of the write calls alone", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      fetchLabels: () => ({ number: 900, title: "x", labels: [] }), // the write claimed success; the read-back disagrees
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900/);
    assert.match(stderr, /the `backlog` label/);
  } finally {
    process.stderr.write = original;
  }
});

// --- the REAL CLI, spawned -- proves it is guarded (cli-flags.test.ts's discovery test requires it) ---

test("REAL CLI: an unrecognised flag is refused by name, before gh ever runs", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "y", "--session=worker-contracts", ...RELEASE, "--bogus-flag"], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 2, `expected exit 2 from refuseUnknownFlags, got: ${e.stderr}`);
      assert.match(e.stderr ?? "", /--bogus-flag/);
      return true;
    },
  );
});

test("REAL CLI: --session= itself is a KNOWN flag to the guard, never refused as unrecognised", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "no sections", "--session=worker-contracts", ...RELEASE], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1, `expected the section-check refusal, got: ${e.stderr}`);
      assert.doesNotMatch(e.stderr ?? "", /unknown flag/i);
      return true;
    },
  );
});

test("REAL CLI: a genuinely known gh flag (e.g. -l/--label) is NOT refused by the flag guard -- it is "
  + "refused by the SECTION check instead, proving the guard did not swallow it as unknown", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "no sections", "--session=worker-contracts", ...RELEASE, "-l", "backlog"],
      { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1, `expected the section-check refusal (exit 1), got: ${e.stderr}`);
      assert.match(e.stderr ?? "", /missing/);
      assert.doesNotMatch(e.stderr ?? "", /unknown flag/i);
      return true;
    },
  );
});

test("REAL CLI: no --session= at all refuses with its own message, distinct from the section refusal", () => {
  assert.throws(
    () => execFileSync("node", [CLI, "--title", "x", "--body", COMPLETE_BODY], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1);
      assert.match(e.stderr ?? "", /--session=<name> is required/);
      return true;
    },
  );
});

// --- #1011: A ROW DECLARES A RELEASE, OR IT IS NOT FILED --------------------------------------------
//
// `--milestone` sat in the passthrough allowlist and nowhere else: this tool accepted one, never asked for
// one, and never confirmed one -- while the org's health check reads a row with neither a milestone nor
// `out-of-release` as a finding every thirty minutes. Two rules about the same row with nothing comparing
// them. Three rows landed that way on 2026-09-11; #1003 also reached the tracker off Project 2 and blocked
// every Status move in the org until it was boarded by hand.

/** Files with `argv`, answering every lookup from fixtures -- nothing here reaches GitHub. */
function fileWith(argv: string[], overrides: Record<string, unknown> = {}) {
  let created: string[] | null = null;
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    spawnGh: (a: string[]) => { created = a; return FILED_URL; },
    ...overrides,
  });
  return { code, created };
}

test("#1011: neither a milestone nor `out-of-release` is REFUSED, and nothing is filed", () => {
  const { code, created } = fileWith(
    ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts"]);
  assert.equal(code, 1);
  assert.equal(created, null,
    "the refusal must come BEFORE `gh issue create`, or it leaves a row the board then trips over");
});

test("#1011: the refusal names BOTH doors and the milestones that actually exist", () => {
  const message = milestoneRefusal(["CI reset", "Road to version one"]);
  assert.match(message, /--milestone <one of "CI reset", "Road to version one">/,
    "a hard-coded list is a second copy of something GitHub holds; this is the live one");
  assert.match(message, /--label out-of-release/);
  assert.match(message, /nothing was sent to GitHub/);
});

test("#1011 FOLLOWABILITY: filing again with the refusal's OWN suggestion passes", () => {
  // This repo's rule is that following a refusal exactly must pass. Read the milestone out of the message
  // the tool printed, put it back on the command line, and file again.
  const suggested = /--milestone <one of "([^"]+)"/.exec(milestoneRefusal(["CI reset", "Road to version one"]));
  assert.ok(suggested, "the refusal must name a milestone a reader can copy");
  const { code, created } = fileWith(["--title", "a real row", "--body", COMPLETE_BODY,
    "--session=worker-contracts", "--milestone", suggested![1]]);
  assert.equal(code, 0, "obeying the refusal must file the row");
  assert.ok((created as unknown as string[]).includes(suggested![1]));
});

test("#1011: `--label out-of-release` with no milestone is ALLOWED -- the deliberate escape", () => {
  const { code } = fileWith(["--title", "a real row", "--body", COMPLETE_BODY,
    "--session=worker-contracts", "--label", "out-of-release"],
  { fetchLabels: () => ({ number: 900, title: "a real row", labels: ["backlog", "lane:any"] }),
    run: afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"), "") });
  assert.equal(code, 0);
});

test("#1011: a milestone GITHUB DID NOT APPLY is named by the read-back -- the #1003 half", () => {
  // `gh` accepting a flag is not evidence the field is set: a flag nobody reads is this repo's own
  // recorded defect (silently discarded, the default runs, success reported). Only a fresh read says.
  const { code } = fileWith(["--title", "a real row", "--body", COMPLETE_BODY,
    "--session=worker-contracts", ...RELEASE],
  { run: afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"), "") });
  assert.equal(code, 2, "FILED but unverified is exit 2, never success");
});

test("#1011: a failed milestone LOOKUP does not turn the refusal into a pass", () => {
  // CANNOT_ASK on the SUGGESTION, never on the RULE. The list degrades to a command the reader can run.
  const { code, created } = fileWith(
    ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts"],
    { milestones: () => null });
  assert.equal(code, 1);
  assert.equal(created, null);
  assert.match(milestoneRefusal(null), /gh api repos\/.+\/milestones/,
    "when it cannot name them it names how to ask");
});

test("#1011: nothing INFERS a milestone -- labels, a parent and a Region do not decide a release", () => {
  // A milestone chosen by a tool looks decided, and a wrong one is worse than an absent one because the
  // health check goes quiet. The tool refuses and names the options; a person picks.
  const { code } = fileWith(["--title", "a real row", "--body", COMPLETE_BODY,
    "--session=worker-contracts", "--label", "ready", "--parent", "908"]);
  assert.equal(code, 1, "a row rich in signals is still refused -- none of them names a release");
});
