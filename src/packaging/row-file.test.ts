// no-token: gh
//
// The acceptance parser charges a command the whole import closure of what it imports, and this file
// imports `row-file.mjs`, which spawns `gh`. True of the IMPORT and false of the CALL: every dependency
// here is injected -- `spawnGh`, `run`, `milestones`, the board and label readers -- and no test lets a
// real spawn happen.
//
// PROVED, NOT ASSERTED, since #827's check is deliberately shallow: GH_TOKEN and GITHUB_TOKEN unset, a
// fake `gh` first on PATH that exits 97 and shouts to stderr -- 66 pass, 0 fail, and the fake never
// printed.
/**
 * #735: the FILING-side twin of #707's claim-side gate -- `packages/agent-org/src/row-file.mjs` refuses to run
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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { regionRefusalReason, declaresRelease, outOfReleaseArgv, labelsOutOfRelease, OUT_OF_RELEASE, OUT_OF_RELEASE_MILESTONE }
  from "../row-file.mjs";
import { declaredRegionFiles } from "../region-paths.mjs";
import { bulletOnlyFleetMention, extractAcceptanceSection, fleetOrLabAcceptance } from "../acceptance-commands.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFiledBy, boardAndVerify, boardingFor, bodyFromArgv, createIssue, directoryRegionWarning, fetchIssueBoardStatus, acceptanceShapeRefusal, fileRefusalReason, issueNumberFromUrl, labelRefusal, labelValuesFromArgv, laneLabelsFor, milestoneRefusal, withAcceptanceLane, openCheckTranscriptRefusal, sessionFromArgv, slashlessDirectoryWarning, unrecognisedRegionWarning, unverifiedFilingFields, withFiledBy, withoutLabels } from "../row-file.mjs";
import { labelSetForPromotion, promoteArgvRefusal, promoteFromArgv, promoteRefusalReason, promoteRow,
  promotionLabelsSettled, unverifiedPromotionFields } from "../row-file.mjs";
import { CLAIM_LABEL } from "../claim-labels.mjs";
import { filedByLine } from "../row-claim.mjs";
import { REPO } from "../../../../scripts/repo-identity.mjs";

const CLI = fileURLToPath(new URL("../row-file.mjs", import.meta.url));
/**
 * #1352: row-file refuses when launched outside a linked worktree, and CI runs these tests in a plain clone. The REAL CLI
 * tests below launch it with the printed override, so each still reaches the check it was written to test.
 */
const CLI_ENV = { ...process.env, A11Y_POLICY_LAUNCH_REASON: "a test driving the real CLI from CI's plain clone" };

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
  const labels = laneLabelsFor(["packages/agent-org/src/row-file.mjs"], { lanes: [PIPELINE_LANE] });
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
  + "the subtraction the retired workflow-lane-check.mjs's laneVerdict made", () => {
  const labels = laneLabelsFor([".github/workflows/consumer-gate.yml"], { lanes: [PIPELINE_LANE] });
  assert.deepEqual(labels, ["lane:any"],
    "consumer-gate.yml is generated from README.md and excepted from the pipeline lane -- touching only "
    + "it must not derive lane:dispatcher");
});

// --- #844: issueNumberFromUrl ---

test("issueNumberFromUrl reads the number off gh issue create's own bare-URL stdout", () => {
  assert.equal(issueNumberFromUrl("https://github.com/a11ign/a11ign/issues/900\n"), 900);
});

test("issueNumberFromUrl is null on anything that does not end in /issues/<digits>", () => {
  assert.equal(issueNumberFromUrl("not a url"), null);
  assert.equal(issueNumberFromUrl("https://github.com/a11ign/a11ign/pull/900"), null);
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
    ["Project 1 membership"]);
  const wrongStatus = { labels: ["backlog", "lane:any"], body: "Filed-by: worker-contracts\n", boardStatus: "Ready" };
  assert.deepEqual(unverifiedFilingFields(wrongStatus,
    { session: "worker-contracts", label: "backlog", status: "Backlog", laneLabels: ["lane:any"] }),
    ['Project 1 Status (reads "Ready", not "Backlog")']);
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
    { project: { number: 1 }, fieldValueByName: { name: "Backlog" } },
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

const FILED_URL = "https://github.com/a11ign/a11ign/issues/900";

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
    assert.match(stderr, /gh project item-add 1 --owner a11ign --url/);
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
      [CLI, "--title", "x", "--body", "y", "--session=worker-contracts", ...RELEASE, "--bogus-flag"], { encoding: "utf8", env: CLI_ENV }),
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
      [CLI, "--title", "x", "--body", "no sections", "--session=worker-contracts", ...RELEASE], { encoding: "utf8", env: CLI_ENV }),
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
      { encoding: "utf8", env: CLI_ENV }),
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
    () => execFileSync("node", [CLI, "--title", "x", "--body", COMPLETE_BODY], { encoding: "utf8", env: CLI_ENV }),
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

/**
 * #1962: the read-back of a row that declared itself out of release. It comes back carrying the
 * `out-of-release` LABEL beside the board and lane ones, because that is what the filing applied -- and
 * since #1962 the read-back checks for it, so a fake omitting it describes a row `row-file` would refuse
 * to report success for. Shared rather than repeated: four tests file out of release for other reasons.
 */
const READ_BACK_OUT_OF_RELEASE = {
  fetchLabels: () => ({ number: 900, title: "a real row", labels: ["backlog", "lane:any", OUT_OF_RELEASE] }),
};

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
  { ...READ_BACK_OUT_OF_RELEASE,
    // #1962: the milestone this filing asks for is the one `outOfReleaseArgv` ADDS beside the label, and
    // the read-back now expects what was filed rather than what was typed. A fixture answering `""` here
    // described a row with the label and no milestone -- the very disagreement #1130 closed, reported as
    // a success because nothing checked the half this tool wrote itself.
    run: afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"), OUT_OF_RELEASE_MILESTONE) });
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
  const unreadable = milestoneRefusal(null);
  assert.match(unreadable, /gh api repos\/.+\/milestones/, "when it cannot name them it names how to ask");
  // worker-capture's review of #1016: the fallback gets its OWN line rather than being interpolated where
  // a list belongs -- `--milestone <one of the milestone list could not be read...>` reads as garbage
  // inside angle brackets, in the one case where the reader cannot see the list either.
  assert.doesNotMatch(unreadable, /<one of .*could not be read/);
  assert.match(unreadable, /--milestone <a milestone>/);
});

test("#1011: nothing INFERS a milestone -- labels, a parent and a Region do not decide a release", () => {
  // A milestone chosen by a tool looks decided, and a wrong one is worse than an absent one because the
  // health check goes quiet. The tool refuses and names the options; a person picks.
  const { code } = fileWith(["--title", "a real row", "--body", COMPLETE_BODY,
    "--session=worker-contracts", "--label", "ready", "--parent", "908"]);
  assert.equal(code, 1, "a row rich in signals is still refused -- none of them names a release");
});

// ---------------------------------------------------------------------------------------------------
// #1117: A REGION THAT NAMES NO PATH MUST SAY IT MEANS TO.
//
// The row's premise was that a non-commit row CANNOT BE FILED without a false Region. Measured: it can.
// `missingTemplateFields` requires the SECTION, not paths, so a prose-only Region already passes and
// `declaredRegionFiles` already returns `[]`. #1042's workaround was never necessary.
//
// THE GAP IS THE OTHER WAY ROUND AND IT IS WORSE: a row whose author FORGOT the paths is
// indistinguishable from one that has none. Both file cleanly and both reserve nothing under B4 — so the
// first is a row nobody can route work around, which is the same over-blocking harm the row describes,
// arrived at from the side nobody was looking at.
// ---------------------------------------------------------------------------------------------------

const rowWith = (region: string) =>
  `## What it is\nx\n\n## Region\n${region}\n\n## Acceptance\nNot a test.\n\n## Open-check\nn/a\n`;

test("#1117: a row whose deliverable is NOT A COMMIT files with no Region path", () => {
  const body = rowWith("**Not a commit.** Its deliverable is not a commit: a destination somebody "
    + "provisions, plus the one line of configuration that points at it.");
  assert.equal(regionRefusalReason(body), null,
    "a row that declares itself must file -- #1042's workaround named files it would never touch, and a "
    + "Region typed to satisfy a refusal reserves them for nobody");
  assert.deepEqual(declaredRegionFiles(body), [],
    "and it must reserve NOTHING: this is the clause that pays for the change, because the whole harm "
    + "today is false reservations under B4");
});

test("#1117: a Region that names no path and does NOT say so is still REFUSED", () => {
  // THE DIRECTION THAT MUST NOT WEAKEN. "No Region paths" must not become the easy path past the check:
  // an author who forgot is the common case and a declaration is the rare one.
  const reason = regionRefusalReason(rowWith("The corpus backup destination, on the lab."));
  assert.ok(reason, "a pathless Region with no declaration must refuse");
  assert.match(reason as string, /indistinguishable from one that has none/,
    "and the refusal must say WHY -- an author who forgot needs to know it reserves nothing, not merely "
    + "that a section is wrong");
  assert.match(reason as string, /its deliverable is not a commit/,
    "and it must quote the sentence that satisfies it: follow the refusal exactly and you must pass");
});

test("#1117: a Region that names files is untouched", () => {
  assert.equal(regionRefusalReason(rowWith("```\nscripts/row-file.mjs\n```")), null);
});

test("#1117: the declaration's vocabulary is #989's, so the clock and the filer name ONE category", () => {
  // #989's in-build rule reads `declaresPaths: false` as "its deliverable is not a commit" — a settings
  // change, a ruling, a measurement posted on the row. Two tools reading one tracker must not describe
  // that category in two spellings; keyed on the sentence rather than on a keyword nobody would guess.
  const source = readFileSync(new URL("../row-file.mjs", import.meta.url), "utf8");
  const claimSide = readFileSync(
    new URL("./row-claim-own-pr-health-rule.test.ts", import.meta.url), "utf8");
  const PHRASE = "its deliverable is not a commit";
  assert.ok(source.includes(PHRASE), `row-file.mjs must use #989's own words: ${PHRASE}`);
  assert.ok(claimSide.includes(PHRASE),
    "and the claim side must still use them -- if this fails the two have drifted, which is the defect "
    + "rather than this test being wrong");
});

test("#1117: the SHARED extractor draws the scope — the two forms that prove which parser runs", () => {
  // NOTHING IN THIS SUITE COULD TELL, and that is why these two cases exist. worker-judge substituted the
  // shared extractor for my hand-written regex and the suite read 71/0 BOTH WAYS -- so the scoping was
  // unheld and a future edit could swap either way with no signal. These are the only two shapes where
  // the two implementations disagree, which makes them the only two that pin it.

  // THE INLINE FORM. `REGION_INLINE` accepts `Region: ...`; my regex required a `## Region` heading, so a
  // row using this form could not make the declaration AT ALL -- a refusal its author cannot follow.
  assert.equal(regionRefusalReason(
    "## What it is\nx\n\n**Region:** its deliverable is not a commit.\n\n"
    + "## Acceptance\nNot a test.\n\n## Open-check\nn/a\n"), null,
  "the inline Region form must be able to carry the declaration, or the refusal is unfollowable");

  // THE `###` SUB-HEADING. It ENDS the Region section everywhere else (#170's recorded shape); my regex
  // ran past it, so a declaration under `### Why` would have been accepted here and invisible to B4 --
  // exactly the divergence the header claimed could not exist.
  assert.ok(regionRefusalReason(
    "## What it is\nx\n\n## Region\nThe destination.\n\n### Why\nIts deliverable is not a commit.\n\n"
    + "## Acceptance\nNot a test.\n\n## Open-check\nn/a\n"),
  "a `###` sub-heading ends the Region section, so a declaration below it is outside the scope B4 reads");
});

test("#1117: the declaration counts only inside the Region section", () => {
  // A phrase that can be made accidentally anywhere in a body is the easy path past the check this
  // refusal exists to close -- and it is not hypothetical: #1117's own body uses the sentence twice in
  // prose while declaring real files. Scoped, so a row that says it in passing still refuses.
  const elsewhere = `## What it is\nIts deliverable is not a commit, they said.\n\n`
    + `## Region\nThe corpus backup destination.\n\n## Acceptance\nNot a test.\n\n## Open-check\nn/a\n`;
  assert.ok(regionRefusalReason(elsewhere),
    "the phrase outside the Region section must not satisfy the declaration");
});


// ---------------------------------------------------------------------------------------------------
// #1130: TWO FACTS SAY "OUTSIDE EVERY RELEASE" -- the `out-of-release` LABEL and the `Out of release`
// MILESTONE, created 2026-09-12 so the board can see that population rather than meet it as nine
// unmilestoned rows. Nothing compared them.
//
// `declaresRelease` already accepted the milestone: any `--milestone` with a value satisfies it, so
// clause 1 passed before this row and I say so rather than count it as delivered. The gap was the other
// direction -- the LABEL alone was accepted and left the row OUT of the milestone, recreating one row at
// a time exactly the state the milestone was made to end.
// ---------------------------------------------------------------------------------------------------

test("#1130: `--milestone \"Out of release\"` alone is accepted -- ALREADY TRUE, asserted so it stays", () => {
  assert.equal(declaresRelease(["--milestone", OUT_OF_RELEASE_MILESTONE]), true);
  assert.equal(declaresRelease([`--milestone=${OUT_OF_RELEASE_MILESTONE}`]), true);
});

test("#1130: the LABEL alone is accepted AND gets the milestone, so filing cannot produce a disagreement", () => {
  const filed = outOfReleaseArgv(["--label", OUT_OF_RELEASE, "--title", "x"]);
  assert.deepEqual(filed.slice(-2), ["--milestone", OUT_OF_RELEASE_MILESTONE],
    "a row declaring itself out of release by label must land in the milestone that says the same thing, "
    + "or it is invisible to every milestone view -- the state that milestone was created to end");
  assert.deepEqual(filed.slice(0, 3), ["--label", OUT_OF_RELEASE, "--title"], "and nothing else moves");
});

test("#1130: an explicit milestone is NOT overridden -- the caller's choice wins", () => {
  const given = ["--label", OUT_OF_RELEASE, "-m", "Road to version one"];
  assert.deepEqual(outOfReleaseArgv(given), given,
    "adding a second --milestone would make `gh` pick one and the filer the other, which is a "
    + "disagreement created by the code that exists to prevent one");
});

test("#1130: neither is still REFUSED, and a row declaring no release is untouched -- the direction that must not weaken", () => {
  assert.equal(declaresRelease(["--title", "x"]), false);
  assert.deepEqual(outOfReleaseArgv(["--title", "x"]), ["--title", "x"]);
  assert.deepEqual(outOfReleaseArgv(["-m", "Road to version one", "--title", "x"]),
    ["-m", "Road to version one", "--title", "x"],
    "a REAL milestone still gets no label -- only `Out of release` is two-faced, and labelling every "
    + "filing would put `out-of-release` on rows that are squarely in the release");
});

// ---------------------------------------------------------------------------------------------------
// #1962: THE HALF #1130 LEFT OPEN, WHICH THEN FILED ITS OWN FINDING.
//
// #1130's own test asserted that `--milestone "Out of release"` alone was "left alone", reasoning that
// `ready-label-audit.mjs`'s tracker-level check would catch that side. It did catch it -- as RELEASE
// DRIFT, minted by `row-file` itself. Measured 2026-09-22: `row-file --milestone "Out of release"` filed
// #1960 with no `out-of-release` label, and the audit reads the LABEL, so the next run would have counted
// that row out of the board's own out-of-release figure. The mirror case, #1740, came from the same run.
// Both were repaired by hand. One fact, written to both fields the org reads, at the one moment a row is
// created -- and the read-back confirms the half this tool added, not only the half the filer typed.
// ---------------------------------------------------------------------------------------------------

test("#1962 ACCEPTANCE: the MILESTONE alone gets the label, in every spelling gh takes", () => {
  for (const argv of [["-m", OUT_OF_RELEASE_MILESTONE], ["--milestone", OUT_OF_RELEASE_MILESTONE],
    [`--milestone=${OUT_OF_RELEASE_MILESTONE}`], ["--milestone", "out of release"]]) {
    const filed = outOfReleaseArgv([...argv, "--title", "x"]);
    assert.deepEqual(filed.slice(-2), ["--label", OUT_OF_RELEASE],
      `${argv.join(" ")}: a row declaring itself out of release by milestone must carry the label that `
      + "says the same thing, or `ready-label-audit.mjs`, which reads the LABEL, reports it as drift");
    assert.deepEqual(filed.slice(0, argv.length), argv, "and nothing the filer wrote moves");
  }
});

test("#1962 ACCEPTANCE: the LABEL alone still gets the milestone -- the half #1130 shipped, unweakened", () => {
  const filed = outOfReleaseArgv(["--label", OUT_OF_RELEASE, "--title", "x"]);
  assert.deepEqual(filed.slice(-2), ["--milestone", OUT_OF_RELEASE_MILESTONE]);
});

test("#1962: a row that already says BOTH is untouched -- the fix adds the missing half, never a second copy", () => {
  const both = ["--label", OUT_OF_RELEASE, "--milestone", OUT_OF_RELEASE_MILESTONE, "--title", "x"];
  assert.deepEqual(outOfReleaseArgv(both), both,
    "a second `--label` or `--milestone` would make gh pick one and the filer the other, which is a "
    + "disagreement created by the code that exists to prevent one");
});

/**
 * #1158: THE WARNING REACHES THE AUTHOR. Lives here rather than in `region-paths.test.ts` because this
 * file already imports `row-file.mjs` and already carries its closure -- #1116's remedy is placement, and
 * pulling a `gh`-spawning module into the parser's own test to assert one line is how a test file loses
 * the job that runs it.
 */
test("#1158: the warning reaches the author, and is a warning rather than a refusal", () => {
  // An exported function nobody calls is not "surfaced" -- #1085's shape, where the test proved a
  // reporter EXISTED and the deliverable was that the caller CALLS it.
  const warned = unrecognisedRegionWarning("## Region\n\n`nosuchdir/thing.md`\n");
  assert.match(String(warned), /nosuchdir\/thing\.md/);
  assert.match(String(warned), /WARNING/);
  assert.equal(unrecognisedRegionWarning("## Region\n\n`docs/README.md`\n"), null);
  // And it must NOT be a refusal: a Region may legitimately mention a path in prose, and blocking a
  // correct filing to prevent a possible mistake is the wrong trade for a failure mode that is silence.
  assert.equal(fileRefusalReason("## Region\n\n`nosuchdir/thing.md`\n\n## Acceptance\n\n`npx tsx --test x.test.ts`\n"),
    fileRefusalReason("## Region\n\n`docs/README.md`\n\n## Acceptance\n\n`npx tsx --test x.test.ts`\n"),
    "a stray path must not change whether the row is refused");
});

/**
 * #1174: AN OPEN-CHECK THAT ASSERTS AN OUTPUT MUST SHOW ONE, ADJACENT TO THE COMMAND.
 *
 * Eleven instances between two engineers in one day; three were open-checks written from belief.
 * product-manager's #1129: *"Prints `0` today — I ran it"* against a command that prints **7**, with the
 * file that refuted the row among the seven. Mine on #1161: *"Run at `9941bef4`"* above a block that
 * returns `0` and exits 1 — in a row whose subject was a command nobody executed.
 *
 * **A pasted transcript is only a transcript if it was pasted FROM A RUN.** Adjacency is the closest
 * machine-checkable proxy: a figure that came from the run sits under the command.
 */
const openCheckBody = (openCheck: string) =>
  `## Region\n\n\`docs/README.md\`\n\n## Acceptance\n\n\`npx tsx --test x.test.ts\`\n\n## Open-check\n\n${openCheck}\n`;

test("#1174 clause 1: an Open-check asserting an output with NO transcript is refused", () => {
  const body = openCheckBody("**Prints `0` today -- I ran it.**\n\n```\ngrep -c foo bar.md\n```");
  assert.match(String(fileRefusalReason(body)), /Open-check/);
  assert.match(String(fileRefusalReason(body)), /pasted FROM A RUN/);
});

test("#1174 clause 2: a transcript present but NON-ADJACENT is refused", () => {
  // THE CLAUSE THAT CARRIES THE ROW. A check asking only whether a command and a number both appear in
  // the block would accept this -- and this is the shape a reconstructed transcript actually takes: the
  // command copied from somewhere real, the figure written from what the author expected it to say.
  const body = openCheckBody(
    "**Prints `0` today.**\n\n```\ngrep -c foo bar.md\n```\n\nand separately:\n\n```\n0\n```");
  assert.match(String(fileRefusalReason(body)), /directly underneath/);
});

test("#1174 clause 3: command and output adjacent is accepted, unchanged", () => {
  const body = openCheckBody("**Prints `0` today.**\n\n```\n$ grep -c foo bar.md\n0\n```");
  assert.equal(openCheckTranscriptRefusal(body), null);
});

test("#1174 clause 4: an Open-check that asserts NOTHING is still accepted", () => {
  // The rule is about unbacked CLAIMS, not about mandating output. Some rows' checks are a command whose
  // meaning the reader judges, and refusing those would make the rule a different, worse rule.
  const body = openCheckBody("Open while the guard is missing.\n\n```\ngrep -c foo bar.md\n```");
  assert.equal(openCheckTranscriptRefusal(body), null);
});

test("#1174: two commands in a row are two commands, not a command and its output", () => {
  // The adjacency test must not read the second command as the first one's output -- otherwise a block
  // of several commands and no output at all satisfies it, which is most of the bodies this refuses.
  const body = openCheckBody("**Prints `0` today.**\n\n```\n$ git fetch origin\n$ grep -c foo bar.md\n```");
  assert.match(String(openCheckTranscriptRefusal(body)), /directly underneath/);
});

test("#1186 clause 2: the warning says what to write instead, and reaches the author", () => {
  // An exported function nobody calls is not "surfaced" -- #1158's lesson and #1085's shape. row-file
  // prints this at filing time, while the author still has the body in front of them.
  const body = "## Region\n\n```\npackages/\n```\n\n## Acceptance\n\n`npx tsx --test x.test.ts`\n"
    + "\n## Open-check\n\nOpen while the guard is missing.\n";
  const warned = String(directoryRegionWarning(body));
  assert.match(warned, /packages\/ \(\d+ file\(s\)\)/, "the count, not just the fact");
  assert.match(warned, /name the files, or say the exclusion in words/, "what to write instead");
  // And it must NOT refuse: a directory Region is sometimes exactly right.
  assert.equal(fileRefusalReason(body), fileRefusalReason(body.replace("packages/", "docs/README.md")),
    "a directory must not change whether the row is refused");
});

/**
 * #1193: EXACTLY ONE OF THE THREE REGION WARNINGS SPEAKS, FOR EVERY WAY OF WRITING A DIRECTORY.
 *
 * NOT FOUR HAND-PICKED CASES. Four examples pass while the rule is still wrong, which is how this got
 * here: three sessions wrote three different tables of these spellings, each sampled a different pair of
 * shapes, and each generalised to an axis (fenced vs inline) that turned out not to be the axis at all.
 * It is *alone on its line* vs *inside a prose sentence*. Enumerating the cross-product is what found
 * that; no amount of care on a sample would have.
 *
 * Before this row, four of the ten cells fired TWO warnings that contradicted each other ("declares
 * NOTHING" beside "reserves 107 files", same directory, same run) and one fired none at all — and the
 * silent cell is the one an author reaches by following the contradictory message.
 *
 * The directory is one level down on purpose: `docs/` is one of the eight tracked top-level names, and
 * every one of them was green while the defect was live.
 */
const DIRECTORY_SPELLINGS = {
  fenced: (p: string) => `## Region\n\n\`\`\`\n${p}\n\`\`\`\n`,
  "bare line": (p: string) => `## Region\n\n${p}\n`,
  "backticked line": (p: string) => `## Region\n\n\`${p}\`\n`,
  bullet: (p: string) => `## Region\n\n- \`${p}\`\n`,
  "in a prose sentence": (p: string) => `## Region\n\nOnly \`${p}\` is touched.\n`,
};

test("#1193 clause 4: every spelling of a directory Region gets EXACTLY ONE witness", () => {
  const cells: string[] = [];
  for (const [shape, write] of Object.entries(DIRECTORY_SPELLINGS)) {
    for (const slash of ["/", ""]) {
      const body = write(`docs/adr${slash}`);
      const spoke = [
        directoryRegionWarning(body) ? "reserves" : null,
        unrecognisedRegionWarning(body) ? "stray" : null,
        slashlessDirectoryWarning(body) ? "slashless" : null,
      ].filter(Boolean);
      // The cell is named in the message: a bare count tells the next reader a number and not which of
      // ten ways of writing one path it came from.
      assert.equal(spoke.length, 1,
        `${shape} + ${slash || "no slash"}: expected exactly one warning, got ${spoke.length} `
        + `(${spoke.join(" and ") || "silence"}). Two is the contradiction this row fixed; none is the `
        + `cell an author lands on by following it.`);
      cells.push(`${shape}/${slash || "none"}`);
    }
  }
  // The population is asserted, not assumed: a shape table someone trims later must fail here rather
  // than quietly testing fewer cells. `assert.ok(cells.length)` would pass on a table of one.
  assert.equal(cells.length, 10, "five shapes times two spellings -- if this moved, so did the claim");
});

test("#1193 clause 5: a top-level directory keeps producing exactly one warning", () => {
  // THE POSITIVE CONTROL, and the reason it is here: `docs/` was green through the entire life of the
  // defect, so a fix that suppressed the stray check for anything with a slash would pass clause 4 and
  // break nothing visible. This pins that the correct spelling still reports its reservation.
  const body = "## Region\n\n```\ndocs/\n```\n";
  assert.ok(directoryRegionWarning(body), "docs/ reserves every file beneath it and must still say so");
  assert.equal(unrecognisedRegionWarning(body), null);
  assert.equal(slashlessDirectoryWarning(body), null);
});

/**
 * #1241: THE ACCEPTANCE ANSWERS WHAT THE REGION CANNOT.
 *
 * `laneLabelsFor` derives a lane from the Region's PATHS, so **a pathless row can never carry a path
 * lane**. #1042 (a destination the chairman provisions) and #1234 (a systemd timer on the control plane)
 * both reached `ready`/`lane:any` with an acceptance naming a specific session, and an engineer had to
 * read the body to discover the row was not theirs — twice, both found the same way.
 *
 * THE PATTERN LIST IS NOT RETYPED HERE EITHER. `fleetOrLabAcceptance` reuses `FLEET_LAB_PATTERNS`, which
 * is the resource ban every role file below `ceo` and `orchestrator` already carries.
 */
test("#1241: a pathless row whose acceptance reaches the fleet gets lane:orchestrator", () => {
  const body = "## Region\n\nits deliverable is not a commit\n\n## Acceptance\n\n```\n"
    + "npm run fleet:provision -- --limit=a11y-worker-2\n```\n";
  assert.match(String(fleetOrLabAcceptance(body)), /reaches the fleet/,
    "a fleet command in the acceptance names the row's owner, where the Region names nobody");
});

test("#1241: the lab is its own reason, and an ordinary row gets neither", () => {
  const lab = "## Acceptance\n\n```\nnpm run lab:job -- -e job=train\n```\n";
  assert.match(String(fleetOrLabAcceptance(lab)), /reaches the lab/,
    "the reason is the matched pattern's own, not a generic 'needs hardware'");
  const plain = "## Acceptance\n\n```\nnpx tsx --test packages/lab/src/packaging/row-file.test.ts\n```\n";
  assert.equal(fleetOrLabAcceptance(plain), null,
    "an ordinary acceptance must not route a row away from the engineer who can run it");
});

test("#1241: it reads the COMMANDS list, and a prose line IS one of those", () => {
  // `extractAcceptanceSection` returns `{kind, commands}`, not a string -- my first version tested the
  // regexes against the object, which stringifies and matches nothing, so `npm run fleet:provision`
  // returned null. Reading `commands` fixed that.
  //
  // AND A PROSE LINE LANDS IN `commands` TOO: the extractor does not judge whether a line is runnable --
  // `pr-open` does, by refusing it. I expected a sentence to be excluded and asserted so; it is not, and
  // the assertion was wrong about the system rather than the system being wrong.
  //
  // Routing on it is the SAFE direction: a row whose acceptance mentions a fleet command in prose is
  // almost certainly a fleet row, and a spurious `lane:orchestrator` is read and corrected, where a
  // missing one sends an engineer to a row they cannot build -- which is the harm #1042 and #1234 did.
  const prose = "## Acceptance\n\nSomebody should run `npm run fleet:provision` at some point.\n";
  assert.match(String(fleetOrLabAcceptance(prose)), /reaches the fleet/,
    "a prose line is in the commands list, so it routes -- deliberately, and in the safe direction");
});

/**
 * #1241, ADDED AFTER REVIEW: THE TWO FOUNDING CASES, PINNED.
 *
 * My first version cited #1042 and #1234 as the rows this closes and **caught neither** — the header
 * made a claim the code did not honour. Two causes, and the second was the real one:
 *
 * 1. The pattern list knew `fleet:`/`lab:` and not the control plane. Both rows are `orchestrator`'s
 *    because *the control plane is theirs*, said in prose.
 * 2. **`extractAcceptanceSection` returns the first COMMAND LINE, not the section.** For both rows that
 *    line is prose, so the numbered clauses naming systemd and the corpus backup were never looked at.
 *    Running a command and CLASSIFYING a row are different questions over the same text.
 *
 * **A lane deriver answering null for a row that is NOT lane:any looks exactly like one answering null
 * for a row that is** — and it becomes the thing a reader trusts instead of the body.
 */
test("#1241: the two rows this was filed on are both routed", () => {
  const systemdRow = "## Acceptance\n\n1. A systemd USER timer on `agents` at 07:10 London running "
    + "`gh workflow run board-report.yml`.\n";
  const labRow = "## Acceptance\n\n**Not a test.** This row closes when:\n\n1. A destination exists.\n"
    + "2. `A11Y_CORPUS_REMOTE` is set on the lab.\n";
  assert.match(String(fleetOrLabAcceptance(systemdRow)), /systemd unit on the control host/,
    "#1234's shape: no `fleet:` or `lab:` command anywhere, and still orchestrator's");
  assert.match(String(fleetOrLabAcceptance(labRow)), /corpus backup|on the lab/,
    "#1042's shape: a destination somebody provisions and a verify only the lab can run");
});

test("#1241: a clause below the first line is still read", () => {
  // The defect above in one assertion: the fleet command is in clause 3, and the first line is prose.
  const body = "## Acceptance\n\n**Not a test.** It closes when:\n\n1. A thing exists.\n"
    + "2. Another thing.\n3. `npm run fleet:status` reports every box green.\n";
  assert.match(String(fleetOrLabAcceptance(body)), /reaches the fleet/,
    "reading only the first line is what made both founding cases answer null");
});

/**
 * #1912: A NAMED PATTERN IN A BULLET DESCRIBES A TEST; IN A FENCE OR A NUMBERED CLAUSE IT IS THE WORK.
 *
 * #1911 was filed with a plain rstest Acceptance whose bullet said the test asserts a refusal "when
 * `A11Y_PVE_KEY` is absent", and came out `lane:any` AND `lane:orchestrator` -- refusing every engineer
 * a row that existed so `orchestrator` need not build it.
 */
// #1911's Acceptance as filed, verbatim (`gh issue view 1911`, 2026-09-22).
const ROW_1911_ACCEPTANCE = "## Acceptance\n\n```bash\n"
  + "npx rstest run --config scripts/rstest/rstest.config.mjs \\\n"
  + "  --include packages/lab/src/gates/corpus-release-nightly.test.ts \\\n"
  + "  --include packages/lab/src/packaging/host-units.test.ts\n```\n\n"
  + "The run passes, and it includes at least two new tests:\n"
  + "- One asserts that the script exits 2 with the `fleet.env` refusal when `A11Y_PVE_KEY` is absent.\n"
  + "- One asserts that the fetch-failure refusal carries text that the failing command wrote only to stdout.\n";

test("#1912: #1911's Acceptance -- the Proxmox key named only in a bullet -- derives no fleet/lab reason", () => {
  assert.equal(fleetOrLabAcceptance(ROW_1911_ACCEPTANCE), null,
    "a bullet saying what a unit test asserts about the key is not the row using the key");
  assert.match(String(bulletOnlyFleetMention(ROW_1911_ACCEPTANCE)), /Proxmox key/,
    "the one case the bullet rule can get wrong is reported, never silent");
});

test("#1912: the same name in a fence or a numbered clause still routes", () => {
  const fenced = "## Acceptance\n\n```bash\nssh -i \"$A11Y_PVE_KEY\" root@pve true\n```\n";
  const numbered = "## Acceptance\n\n1. `A11Y_PVE_KEY` opens a shell on the Proxmox host.\n";
  const fencedBullet = "## Acceptance\n\n```yaml\n- systemctl --user enable board.timer\n```\n";
  for (const body of [fenced, numbered]) {
    assert.match(String(fleetOrLabAcceptance(body)), /Proxmox key/, body);
    assert.equal(bulletOnlyFleetMention(body), null, "a routed row has nothing to warn about");
  }
  assert.match(String(fleetOrLabAcceptance(fencedBullet)), /systemd/,
    "a dash inside a code fence is YAML, not a bullet");
});

test("#1912: an INVOCATION in a bullet still routes -- only named things are read as a test's subject", () => {
  const body = "## Acceptance\n\nThe run passes and includes:\n- `npm run fleet:status` reports every box green\n";
  assert.match(String(fleetOrLabAcceptance(body)), /reaches the fleet/,
    "`fleet:status` in any sentence is somebody running it; the bullet rule is for the five named patterns");
});

// #1914's review: the WHOLE list item is a bullet, not its marker line. reviewer-2 and product-manager both
// reproduced a wrapped bullet whose `A11Y_PVE_KEY` sat on the continuation line routing silently.
const WRAPPED_1911 = "## Acceptance\n\n```bash\nnpx rstest run\n```\n\nThe run passes, and it includes:\n"
  + "- One asserts that the script exits 2 with the `fleet.env` refusal when\n"
  + "  `A11Y_PVE_KEY` is absent.\n";

test("#1914: a WRAPPED bullet is prose on every line -- its continuation does not route", () => {
  const lazy = WRAPPED_1911.replace("\n  `A11Y_PVE_KEY`", "\n`A11Y_PVE_KEY`");
  const secondParagraph = WRAPPED_1911.replace("\n  `A11Y_PVE_KEY`", "\n\n  `A11Y_PVE_KEY`");
  assert.notEqual(lazy, WRAPPED_1911, "the lazy-continuation replacement landed");
  assert.notEqual(secondParagraph, WRAPPED_1911, "the second-paragraph replacement landed");
  for (const body of [WRAPPED_1911, lazy, secondParagraph]) {
    assert.equal(fleetOrLabAcceptance(body), null, body);
    assert.match(String(bulletOnlyFleetMention(body)), /Proxmox key/, "and the warning still fires");
  }
});

test("#1914: a bullet item ENDS at a numbered clause, a heading, or a blank line then unindented text", () => {
  const bullet = "## Acceptance\n\n- One asserts the refusal.\n";
  const numbered = bullet + "1. `A11Y_PVE_KEY` opens a shell on the Proxmox host.\n";
  const paragraph = bullet + "\n`A11Y_PVE_KEY` opens a shell on the Proxmox host.\n";
  const fence = bullet + "```bash\nssh -i \"$A11Y_PVE_KEY\" root@pve true\n```\n";
  for (const body of [numbered, paragraph, fence]) {
    assert.match(String(fleetOrLabAcceptance(body)), /Proxmox key/, body);
  }
});

test("#1914: a fence ENDS the bullet item -- an unindented sentence after the closing fence is read", () => {
  const body = "## Acceptance\n\n- the run passes\n```bash\nnpm test\n```\n`A11Y_PVE_KEY` is set on the lab host.\n";
  assert.match(String(fleetOrLabAcceptance(body)), /Proxmox key/, body);
  assert.equal(bulletOnlyFleetMention(body), null, "and no bullet warning: that sentence was never a bullet");
});

test("#1912: row-file never emits lane:any together with another lane: label", () => {
  assert.deepEqual(withAcceptanceLane(["lane:any"], "reaches the fleet"), ["lane:orchestrator"],
    "#1911 came out `lane:any, lane:orchestrator` -- an answer and its negation");
  assert.deepEqual(withAcceptanceLane(["lane:ceo"], "reaches the fleet"), ["lane:ceo", "lane:orchestrator"],
    "a path lane is a second real answer (#1241) and is kept");
  assert.deepEqual(withAcceptanceLane(["lane:orchestrator"], "reaches the fleet"), ["lane:orchestrator"]);
  assert.deepEqual(withAcceptanceLane(["lane:any"], null), ["lane:any"], "no fleet reason, nothing changes");
});

/** `createIssue` on `body`, with everything it wrote to stderr and the labels it ensured. */
function fileCapturingStderr(body: string, labels: string[]) {
  const argv = ["--title", "a real row", "--body", body, "--session=worker-contracts", ...RELEASE];
  const ensured: string[][] = [];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog", {
        fetchLabels: () => ({ number: 900, title: "a real row", labels }),
      }),
      run: afterRun(appendFiledBy(body, "worker-contracts")),
      ensureLabels: (l: string[]) => { ensured.push(l); },
    });
    return { code, stderr, ensured: ensured[0]?.sort() };
  } finally {
    process.stderr.write = original;
  }
}

test("#1912: createIssue files a fleet-Acceptance row with lane:orchestrator and without lane:any, and says why", () => {
  const body = COMPLETE_BODY.replace("npx tsx --test x", "npm run fleet:status");
  assert.notEqual(body, COMPLETE_BODY, "the Acceptance replacement landed");
  const { code, stderr, ensured } = fileCapturingStderr(body, ["backlog", "lane:orchestrator"]);
  assert.equal(code, 0);
  assert.deepEqual(ensured, ["backlog", "lane:orchestrator"],
    "`happyDeps` derives lane:any from the Region; the fleet Acceptance must REPLACE it, not sit beside it");
  assert.match(stderr, /lane:orchestrator added -- the Acceptance reaches the fleet/,
    "#1911 was routed with nothing saying why; the filer must see the pattern that did it");
  assert.doesNotMatch(stderr, /NOT routed/);
});

test("#1914: createIssue on a bullet-only Proxmox mention files lane:any and WARNS on stderr", () => {
  const body = COMPLETE_BODY.replace("## Acceptance\n\n```\nnpx tsx --test x\n```\n", WRAPPED_1911);
  assert.notEqual(body, COMPLETE_BODY, "the Acceptance replacement landed");
  const { code, stderr, ensured } = fileCapturingStderr(body, ["backlog", "lane:any"]);
  assert.equal(code, 0);
  assert.deepEqual(ensured, ["backlog", "lane:any"], "a bullet describing a test does not route the row");
  assert.match(stderr, /NOT routed to orchestrator -- a bullet in the Acceptance names something that uses the Proxmox key/,
    "the one case the bullet rule can get wrong is said out loud, through the real filing path");
  assert.match(stderr, /write that step as a numbered clause/, "and the refusal-shaped message is followable");
  assert.doesNotMatch(stderr, /lane:orchestrator added/);
});

// --- #1249: a Status failure must name the labels it skipped ------------------------------------
//
// #1248 was filed with NO LABELS AT ALL. `boardAndVerify` returns early on the Status failure so the
// label step never runs, and the message named only the Status — so an operator following the refusal
// exactly fixes the Status and stops, leaving the row invisible to every label-keyed view.

// #1250: the `run` stub RECORDS, because the fact both halves of the pair need to measure is a CALL --
// "were the labels applied" -- and a stub that returns "" for everything cannot answer it in either
// direction. It dispatches on argv only where the success path reads back, so the verify actually passes
// and `ok: true` is a real outcome rather than a refusal the control happens not to match.
type Board = { ok: true } | { ok: false; message: string };
const boardRun = (calls: string[][]) => (cmd: string, argv: string[]) => {
  calls.push([cmd, ...argv]);
  if (argv.includes("--json") && argv.includes("body")) return "prose\n\nFiled-by: worker-capture\n";
  if (argv.includes("--json") && argv.includes("milestone")) return "Road to version one";
  return "";
};
const boardDeps = (moved: boolean, calls: string[][] = [], addFails = false) => ({
  run: (cmd: string, argv: string[]) => {
    if (addFails && argv[0] === "project" && argv[1] === "item-add") throw new Error("HTTP 502");
    return boardRun(calls)(cmd, argv);
  },
  fetchBoardStatus: () => "Backlog",
  fetchLabels: () => ({ labels: ["backlog", "lane:any"], body: "", milestone: "Road to version one" }),
  moveStatus: () => (moved ? { moved: true } : { moved: false, reason: "GraphQL 500" }),
  ensureLabels: () => {},
});
const labelCall = (calls: string[][]) =>
  calls.find((c) => c[1] === "issue" && c[2] === "edit" && c.includes("--add-label"));
const boardArgs = {
  issueNumber: 1248, url: "https://github.com/x/y/issues/1248",
  boarding: { status: "Backlog", label: "backlog" },
  session: "worker-capture", laneLabels: ["lane:any"], milestone: "Road to version one",
};

test("#1249: a Status failure names the labels it skipped, and how to apply both", () => {
  const r = boardAndVerify(boardArgs, boardDeps(false) as never);
  assert.equal(r.ok, false);
  assert.match(r.message, /were NOT applied/,
    "the refusal must say the labels did not land -- following it exactly must leave the row boarded");
  assert.match(r.message, /`backlog`\/`lane:any`/, "and name WHICH labels, not 'the labels'");
  assert.match(r.message, /--add-label backlog --add-label lane:any/,
    "and be followable: the command that repairs BOTH halves, not a description of one");
});

test("#1249 POSITIVE CONTROL: when the Status succeeds the labels are actually APPLIED", () => {
  // #1250, worker-capture: the control this replaces was `doesNotMatch(message, /were NOT applied/)` on
  // the success return -- which is `{ ok: true }` with NO `message` field, so it compared the empty
  // string and passed by construction for every possible implementation of the failure message. A check
  // whose reading cannot move with the variable is not a control; it is a second copy of the claim.
  //
  // The two halves now measure ONE fact from both sides: on failure the message says the labels did not
  // land, and on success they DID -- asserted at the call, which is the only place that is observable.
  const calls: string[][] = [];
  const r = boardAndVerify(boardArgs, boardDeps(true, calls) as never) as Board;
  assert.equal(r.ok, true,
    "the success path must actually succeed -- the old control passed on a read-back refusal too");
  assert.deepEqual(labelCall(calls),
    ["gh", "issue", "edit", "1248", "--repo", REPO, "--add-label", "backlog", "--add-label", "lane:any"],
    "the labels the failure message says were SKIPPED are the ones this path applies");
});

test("#1249 NEGATIVE CONTROL: when the Status fails the labels are not applied at all", () => {
  // The other side of the same fact. Without this, "the message says they were skipped" and "they were
  // skipped" are two claims with nothing comparing them.
  const calls: string[][] = [];
  boardAndVerify(boardArgs, boardDeps(false, calls) as never);
  assert.equal(labelCall(calls), undefined,
    "the early return is what the refusal is reporting -- if the labels landed anyway it is lying");
});

test("#1250: the item-add rung names BOTH steps it skips, and repairs all three", () => {
  // The rung worker-capture's own filing hit, and the one the first fix did not reach: item-add is the
  // first of three, so its failure skips the Status AND the labels. An operator who follows it exactly
  // must not end with a boarded row that has neither.
  const calls: string[][] = [];
  const r = boardAndVerify(boardArgs, boardDeps(true, calls, true) as never) as Board;
  assert.equal(r.ok, false);
  const message = (r as { message: string }).message;
  assert.match(message, /neither the Status "Backlog" nor/, "it must name the Status as skipped");
  assert.match(message, /`backlog`\/`lane:any`/, "and WHICH labels, not 'the labels'");
  assert.match(message, /item-edit 1 --owner \S+ --url \S+ --field Status --value "Backlog"/,
    "and be followable for the Status, not only describe it");
  assert.match(message, /--add-label backlog --add-label lane:any/, "and for the labels");
  assert.equal(labelCall(calls), undefined, "neither later step ran, which is what the message reports");
});

// ---------------------------------------------------------------------------------------------------
// #1322: ROW-FILE COMPOSED ITS OWN LABELS BESIDE THE FILER'S WITHOUT READING THEM.
//
// Three rows on 2026-09-13, two sessions: #1313 `--label lane:orchestrator` came out `backlog, lane:any,
// lane:orchestrator`; #1306 `--label=lane:any` came out `lane:any, lane:ceo`; #1315 `--label=ready
// --label=lane:any` came out `backlog, ready, lane:any`. Every filer who said what they meant got both meanings.
// Driven through `createIssue` with injected `spawnGh`/`run`, asserting what reaches `gh`.
// ---------------------------------------------------------------------------------------------------

/** `fileWith`, plus stderr and every label a `gh issue edit --add-label` call applied. */
/**
 * @param readBackMilestone what the filed row's milestone READS BACK as. `CI reset` is what `FILER`
 *   declares; a filing that declares `out-of-release` by label alone lands in `Out of release` instead,
 *   because `outOfReleaseArgv` adds it -- and since #1962 the read-back expects what was FILED, not what
 *   the filer typed, so a fixture still answering `CI reset` there describes a row that was never created.
 */
function fileWatching(argv: string[], overrides: Record<string, unknown> = {},
  readBackMilestone = "CI reset") {
  const added: string[] = [];
  const moved: string[] = [];
  let said = "";
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { said += String(chunk); return true; };
  try {
    const base = afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"), readBackMilestone);
    const { code, created } = fileWith(argv, {
      run: (cmd: string, args: string[]) => {
        args.forEach((arg, i) => { if (arg === "--add-label") added.push(args[i + 1]); });
        return base(cmd, args);
      },
      moveStatus: (_n: number, status: string) => { moved.push(status); return { moved: true as const }; },
      ...overrides,
    });
    return { code, created: created as string[] | null, added, moved, said };
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
}

const FILER = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", ...RELEASE];
const lanesIn = (labels: readonly string[]) => [...new Set(labels.filter((l) => l.startsWith("lane:")))];

test("#1322 ACCEPTANCE (case 1): an explicit lane that DIFFERS from the derived one refuses before filing, naming both", () => {
  // `happyDeps` derives `lane:any` for COMPLETE_BODY -- the #1313 shape: typed `lane:orchestrator`, derived `lane:any`.
  for (const spelling of [["--label=lane:orchestrator"], ["--label", "lane:orchestrator"], ["-l", "lane:orchestrator"],
    ["--label", "out-of-release,lane:orchestrator"], ["--label=Lane:Orchestrator"]]) {
    const { code, created, said } = fileWatching([...FILER, ...spelling]);
    assert.equal(code, 1, `${spelling.join(" ")} must refuse`);
    assert.equal(created, null, "refused BEFORE `gh issue create`, so nothing is left for the board to trip over");
    assert.match(said, /lane:orchestrator/i, "the lane the filer typed is named, in the filer's own spelling");
    assert.match(said, /\(lane:any\)/, "and the lane the Region derives");
  }
});

test("#1322 CONTROL (case 1): an explicit lane EQUAL to the derived one files, with exactly one lane label", () => {
  const { code, created, added } = fileWatching([...FILER, "--label=lane:any"],
    { fetchLabels: () => ({ number: 900, title: "a real row", labels: ["backlog", "lane:any"] }) });
  assert.equal(code, 0);
  assert.deepEqual(lanesIn([...(created ?? []), ...added]), ["lane:any"],
    "one lane, the derived one -- a typed copy that agrees neither adds a second nor goes missing");
  // #1322 review: gh folds case, so `LANE:ANY` IS the derived lane -- agreeing, and dropped from the create call.
  const shouted = fileWatching([...FILER, "--label=LANE:ANY"],
    { fetchLabels: () => ({ number: 900, title: "a real row", labels: ["backlog", "lane:any"] }) });
  assert.equal(shouted.code, 0, "a case variant of the derived lane is not a contradiction");
  assert.deepEqual(labelValuesFromArgv(shouted.created ?? []), [], "and it does not reach gh issue create beside the derived one");
});

test("#1322 ACCEPTANCE (case 2): `--label=ready` boards Ready and is never `backlog` too", () => {
  for (const spelling of [["--label=ready"], ["--label", "ready"], ["-l", "ready,lane:any"], ["--label=Ready"]]) {
    const { code, created, added, moved } = fileWatching([...FILER, ...spelling], {
      fetchBoardStatus: () => "Ready",
      fetchLabels: () => ({ number: 900, title: "a real row", labels: ["ready", "lane:any"] }),
    });
    assert.equal(code, 0, `${spelling.join(" ")} files`);
    assert.deepEqual(moved, ["Ready"], "treated as --ready: the Status is Ready");
    assert.ok(added.includes("ready") && !added.includes("backlog"), `ready, never backlog too -- added ${JSON.stringify(added)}`);
    assert.ok(!labelValuesFromArgv(created ?? []).some((l) => l.toLowerCase() === "ready"),
      "and `ready` does not reach `gh issue create`: a ready label before the Status is #867's own refusal");
  }
});

test("#1322 CONTROL (case 2): no board flag at all still files `backlog`", () => {
  const { code, added, moved } = fileWatching(FILER);
  assert.equal(code, 0);
  assert.deepEqual(moved, ["Backlog"]);
  assert.ok(added.includes("backlog") && !added.includes("ready"));
});

test("#1322: `ready` and `backlog` together refuse, in any mix of --ready and --label", () => {
  for (const both of [["--ready", "--label", "backlog"], ["--label=ready,backlog"], ["-l", "backlog", "--label=ready"],
    ["--ready", "--label=Backlog"]]) {
    const { code, created, said } = fileWatching([...FILER, ...both]);
    assert.equal(code, 1, `${both.join(" ")} must refuse`);
    assert.equal(created, null);
    assert.match(said, /both `ready` and `backlog`/);
  }
});

test("#1322: the board and lane labels never reach `gh issue create`; every other label does, in its own spelling", () => {
  // The untouched occurrence is spelled `-l`, NOT `--label`: the rewrite itself emits `--label`, so a rewrite that
  // rebuilt every occurrence would pass a `--label` assertion (worker-capture's review of #1381).
  const { code, created } = fileWatching([...FILER, "-l", "out-of-release", "--label=backlog,lane:any,docs"],
    READ_BACK_OUT_OF_RELEASE);
  assert.equal(code, 0);
  assert.deepEqual(labelValuesFromArgv(created ?? []), ["out-of-release", "docs"]);
  const at = (created ?? []).indexOf("out-of-release");
  assert.equal((created ?? [])[at - 1], "-l", "an occurrence nothing was dropped from keeps its original spelling");
});

test("#1322: labelValuesFromArgv reads every spelling gh takes; withoutLabels drops an emptied occurrence whole", () => {
  assert.deepEqual(labelValuesFromArgv(["--label", "a,b", "--label=c", "-l", "d", "-l=e", "--title", "-l"]),
    ["a", "b", "c", "d", "e"], "a trailing flag with no value is not a label");
  assert.deepEqual(withoutLabels(["--title", "x", "--label", "ready", "-l=lane:any,keep"], ["ready", "lane:any"]),
    ["--title", "x", "--label", "keep"]);
  assert.equal(labelRefusal(["--label", "lane:pm"], ["lane:pm", "lane:dispatcher"]), null,
    "a typed lane that is one of several derived lanes is not a contradiction");
});

// ---------------------------------------------------------------------------------------------------
// #1393: `out-of-release` WAS READ BY EXACT SPELLING, IN TWO COPIES.
//
// `declaresRelease` made the refusal and `outOfReleaseArgv` added the milestone, and both matched only
// `--label out-of-release`, `-l out-of-release` or `--label=out-of-release`. So a filer who wrote the label in
// any other spelling `gh` accepts was refused as declaring "no release" -- untrue, and not followable. Fixing
// one copy alone would file the row with no milestone, the state #1011 exists to end. Driven through
// `createIssue`, asserting the argv that reaches `gh`.
// ---------------------------------------------------------------------------------------------------

const UNRELEASED = FILER.slice(0, FILER.length - RELEASE.length);
const milestoneIn = (argv: readonly string[] | null) => {
  const at = (argv ?? []).indexOf("--milestone");
  return at < 0 ? null : (argv ?? [])[at + 1];
};

test("#1393 ACCEPTANCE: every spelling gh takes files with the Out of release milestone, the filer's label spelling unchanged", () => {
  assert.deepEqual(UNRELEASED.includes("--milestone"), false, "the filer declares no milestone of its own");
  // `-l=` is a real spelling: `gh issue list -l=ready` returns exactly `--label ready`'s rows (5655847590 on #1393).
  for (const spelling of [["--label", "out-of-release,docs"], ["--label=Out-of-release"], ["-l=out-of-release"]]) {
    const { code, created, said } = fileWatching([...UNRELEASED, ...spelling], READ_BACK_OUT_OF_RELEASE,
      OUT_OF_RELEASE_MILESTONE);
    assert.equal(code, 0, `${spelling.join(" ")} declares out-of-release and must file -- said: ${said.slice(0, 160)}`);
    assert.equal(milestoneIn(created), OUT_OF_RELEASE_MILESTONE, `${spelling.join(" ")}: the milestone is added beside the label`);
    const at = (created ?? []).indexOf(spelling[0]);
    assert.deepEqual((created ?? []).slice(at, at + spelling.length), spelling,
      "and the label reaches gh in the filer's own spelling -- gh folds case and reads `-l=`");
  }
});

test("#1393 CONTROL: `--label out-of-release` still files with the milestone, and no label is still refused", () => {
  const exact = fileWatching([...UNRELEASED, "--label", "out-of-release"], READ_BACK_OUT_OF_RELEASE,
    OUT_OF_RELEASE_MILESTONE);
  assert.equal(exact.code, 0);
  assert.equal(milestoneIn(exact.created), OUT_OF_RELEASE_MILESTONE);
  const none = fileWatching(UNRELEASED);
  assert.equal(none.code, 1);
  assert.equal(none.created, null, "refused before anything reaches gh");
  assert.match(none.said, /REFUSING to file a row that declares no release/);
  const other = fileWatching([...UNRELEASED, "--label", "docs"]);
  assert.equal(other.code, 1, "a label that is not out-of-release declares nothing either");
});

test("#1962 ACCEPTANCE, DRIVEN: `--milestone \"Out of release\"` alone files WITH the label -- the shape that filed #1960", () => {
  // Driven through `createIssue`, asserting the argv that reaches `gh`: `outOfReleaseArgv` returning the
  // right array proves nothing about what this tool files if the result is dropped on the way (#1393's
  // own lesson -- one of two copies fixed files the row with the other half missing).
  for (const spelling of [["--milestone", OUT_OF_RELEASE_MILESTONE], ["-m", OUT_OF_RELEASE_MILESTONE],
    [`--milestone=${OUT_OF_RELEASE_MILESTONE}`]]) {
    const { code, created, said } = fileWatching([...UNRELEASED, ...spelling], READ_BACK_OUT_OF_RELEASE,
      OUT_OF_RELEASE_MILESTONE);
    assert.equal(code, 0, `${spelling.join(" ")} must file -- said: ${said.slice(0, 200)}`);
    assert.deepEqual(labelValuesFromArgv(created ?? []), [OUT_OF_RELEASE],
      `${spelling.join(" ")}: the label is added beside the milestone, or ready:audit reads the row as `
      + "RELEASE DRIFT minted by the tool that filed it");
    const at = (created ?? []).indexOf(spelling[0]);
    assert.deepEqual((created ?? []).slice(at, at + spelling.length), spelling,
      "and the milestone reaches gh in the filer's own spelling -- nothing is rewritten to add the label");
  }
});

test("#1962 CONTROL: a REAL milestone gets no `out-of-release` label -- the direction that must not weaken", () => {
  // `FILER` declares `--milestone \"CI reset\"`: a row squarely IN the release. Labelling it out of release
  // would be the same drift pointing the other way, and this is the assertion that says the fix reads the
  // milestone's VALUE rather than the flag's presence.
  const { code, created } = fileWatching(FILER);
  assert.equal(code, 0);
  assert.deepEqual(labelValuesFromArgv(created ?? []), [],
    "no label at all: the board and lane labels land after the Status move, and this row is not out of release");
});

test("#1962 CONTROL: the MILESTONE this tool added is read back too, not only the one the filer typed", () => {
  // The mirror of the test below, and the reason the read-back reads `filedArgv` rather than `argv`:
  // a filing that says `out-of-release` by label alone asks for the `Out of release` milestone because
  // `outOfReleaseArgv` ADDS it. Expecting only what the filer typed expects `null` here, checks nothing,
  // and reports success for a row carrying the label and no milestone -- the disagreement #1130 closed,
  // surviving as an unverified half of its own remedy.
  const { code, said } = fileWatching([...UNRELEASED, "--label", "out-of-release"],
    READ_BACK_OUT_OF_RELEASE, "");
  assert.equal(code, 2, "filed but unconfirmed is exit 2, never success");
  assert.match(said, /missing: the milestone/, "and the refusal names the half that did not stick");
});

test("#1962 CONTROL: a label the read-back does NOT find is REFUSED, not reported as filed", () => {
  // The positive control for the read-back added by this row: with the fixture answering a row that came
  // back WITHOUT `out-of-release`, `row-file` must refuse rather than print the URL. `gh` accepting
  // `--label` is not evidence the label is on the row -- #1011's own finding, one field across.
  const { code, said } = fileWatching([...UNRELEASED, "--milestone", OUT_OF_RELEASE_MILESTONE], {},
    OUT_OF_RELEASE_MILESTONE);
  assert.equal(code, 2, "filed but unconfirmed is exit 2, never success");
  assert.match(said, /the `out-of-release` label/,
    "and the refusal NAMES the half that did not stick, so a reader repairing the row knows which");
});

test("#1393: labelsOutOfRelease reads every spelling, folds case, and is the one predicate both callers use", () => {
  for (const argv of [["--label", "out-of-release"], ["-l", "docs,out-of-release"], ["--label=OUT-OF-RELEASE"],
    ["-l=out-of-release"]]) {
    assert.equal(labelsOutOfRelease(argv), true, argv.join(" "));
    assert.equal(declaresRelease(argv), true, `declaresRelease agrees: ${argv.join(" ")}`);
    assert.equal(milestoneIn(outOfReleaseArgv(argv)), OUT_OF_RELEASE_MILESTONE, `outOfReleaseArgv agrees: ${argv.join(" ")}`);
  }
  for (const argv of [["--label", "docs"], ["--title", "out-of-release"], ["-l"], ["--label=out-of-release-ish"]]) {
    assert.equal(labelsOutOfRelease(argv), false, argv.join(" "));
    assert.equal(declaresRelease(argv), false, `declaresRelease agrees: ${argv.join(" ")}`);
  }
});

// --- #1316: a `$ ` prompt marks a command line whatever its first word; adjacency still decides ---

/** An Open-check asserting an output, with one fenced transcript whose lines are `lines`. */
const openCheckWith = (lines: string[]) =>
  "## Open-check\n\n```\n" + lines.join("\n") + "\n```\n\nOpen while it prints the refusal and exits 1.\n";

test("#1316 ACCEPTANCE: a pasted run whose prompted command begins with echo, touch or printf is accepted", () => {
  for (const first of ["echo", "touch", "printf"]) {
    const body = openCheckWith([`$ ${first} x >> f && git commit f; echo "exit=$?"`, "pre-commit: refusing", "exit=1"]);
    assert.equal(openCheckTranscriptRefusal(body), null, `a real paste starting with \`$ ${first}\` must be recognised as a command`);
  }
});

test("#1316 the MEASURED case: worker-judge's #1314 transcript shape, pasted from the run, is accepted", () => {
  const body = openCheckWith(['$ echo "one line" >> docs/README.md && git add docs/README.md && git commit -m x docs/README.md', "pre-commit: refusing -- staged files nobody has touched in 30m+:", "exit=1"]);
  assert.equal(openCheckTranscriptRefusal(body), null);
});

test("#1316 CONTROL: two PROMPTED commands in a row are two commands, not a command and its output -- still refused", () => {
  const body = openCheckWith(["$ echo a", "$ touch b"]);
  assert.match(String(openCheckTranscriptRefusal(body)), /directly underneath/);
});

test("#1316 CONTROL: a prompted command with nothing printed under it is still refused -- adjacency is the property", () => {
  const body = openCheckWith(["$ printf x"]);
  assert.match(String(openCheckTranscriptRefusal(body)), /directly underneath/);
});

test("#1316 an UNPROMPTED line is still judged by the allowlist alone -- the prompt is what widens it", () => {
  const unprompted = openCheckWith(["echo x", "3"]);
  assert.match(String(openCheckTranscriptRefusal(unprompted)), /directly underneath/,
    "without a prompt, 'echo x' is not recognised, so the 3 beneath it is not an output of anything");
  assert.equal(openCheckTranscriptRefusal(openCheckWith(["git rev-list --count HEAD", "3"])), null,
    "an allowlisted unprompted command with its output is accepted, as before");
});

// --- #1488: THE ACCEPTANCE MUST PARSE AS ONE SECTION. product-manager's floor checker found 22 open rows carrying
// `## Acceptance` then an `Acceptance: none — …` line -- DUPLICATE to the parser CI's acceptance job uses -- and
// row-file had filed every one. Reproduced at bb8a5168 on #1466's real body: duplicate, and fileRefusalReason null. ---

const ROW_REGION = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n";
const ROW_OPEN_CHECK = "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const withAcceptance = (acceptance: string) => ROW_REGION + acceptance + ROW_OPEN_CHECK;
const NONE_REASON = "a docs row with nothing to run";

test("#1488 ACCEPTANCE: a heading followed by an `Acceptance: none` line (the 22-row shape) is REFUSED, naming both lines", () => {
  const body = withAcceptance(`## Acceptance\n\nAcceptance: none — ${NONE_REASON}\n\n`);
  assert.equal(extractAcceptanceSection(body).kind, "duplicate", "the fixture must be the parser's DUPLICATE case");
  const reason = fileRefusalReason(body);
  assert.ok(reason, "a body CI's acceptance parser reads as DUPLICATE must not be filed");
  assert.match(reason as string, /^row-file: REFUSING to file -- the Acceptance section has 2 headers/);
  assert.ok((reason as string).includes("line 5: `## Acceptance`"), reason as string);
  assert.ok((reason as string).includes(`line 7: \`Acceptance: none — ${NONE_REASON}\``), reason as string);
});

test("#1488: an Acceptance section the parser reads as MISSING is refused, in both shapes the template check lets through", () => {
  for (const acceptance of ["## Acceptance: none\n\n", "## Acceptance\n\n<!-- nothing yet -->\n\n"]) {
    const body = withAcceptance(acceptance);
    assert.equal(extractAcceptanceSection(body).kind, "missing", `fixture: ${JSON.stringify(acceptance)}`);
    assert.match(fileRefusalReason(body) ?? "", /^row-file: REFUSING to file -- the Acceptance section is present, but .*\(MISSING\)/,
      `fixture: ${JSON.stringify(acceptance)}`);
  }
});

test("#1488 CONTROL: the one-header forms are accepted -- a heading with a command block, and `## Acceptance: none — <reason>`", () => {
  assert.equal(extractAcceptanceSection(COMPLETE_BODY).kind, "commands");
  assert.equal(fileRefusalReason(COMPLETE_BODY), null);
  const inlineNone = withAcceptance(`## Acceptance: none — ${NONE_REASON}\n\n`);
  assert.equal(extractAcceptanceSection(inlineNone).kind, "none");
  assert.equal(fileRefusalReason(inlineNone), null);
});

test("#1488: the refusal is FOLLOWABLE -- the refused body, collapsed to the one header it names, files", () => {
  const refused = withAcceptance(`## Acceptance\n\nAcceptance: none — ${NONE_REASON}\n\n`);
  assert.ok(fileRefusalReason(refused));
  const followed = refused.replace(`## Acceptance\n\nAcceptance: none — ${NONE_REASON}`, `## Acceptance: none — ${NONE_REASON}`);
  assert.equal(fileRefusalReason(followed), null, "doing exactly what the refusal says must pass");
});

test("#1488: the check CALLS the parser and keeps no copy of its rule -- it refuses exactly the kinds the parser cannot read", () => {
  const shapes = [
    "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n",
    `## Acceptance: none — ${NONE_REASON}\n\n`,
    `## Acceptance\n\nAcceptance: none — ${NONE_REASON}\n\n`,
    "## Acceptance: none\n\n",
    "## Acceptance\n\n<!-- nothing yet -->\n\n",
    "## Acceptance\n\n",
    "### Acceptance: npx tsx --test x\n\n",
    "Acceptance: npx tsx --test x\n\n",
  ];
  const kinds = new Set<string>();
  for (const acceptance of shapes) {
    const body = withAcceptance(acceptance);
    const kind = extractAcceptanceSection(body).kind;
    kinds.add(kind);
    assert.equal(acceptanceShapeRefusal(body) !== null, kind === "duplicate" || kind === "missing",
      `shape ${JSON.stringify(acceptance)} parses as ${kind}`);
  }
  assert.deepEqual([...kinds].sort(), ["commands", "duplicate", "missing", "none"], "the shapes must cover every kind");
});

// --- #2099: AN UNDECLARED `gh` ACCEPTANCE IS REFUSED AT FILING. The `acceptance` job is given no
// credential at all -- it alone executes commands taken from an untrusted PR body -- so a `gh` line run
// there dies on the missing credential, and nothing said so until `pr-open`, after a builder had claimed
// the row and built the change. The rule itself lives in `acceptance-commands.mjs` beside the classifier
// whose verdict it moves earlier, and is pinned in full there; these two pin that `fileRefusalReason`
// ACTUALLY CALLS IT, which is the half a unit test of the rule cannot see. ---

const HAND_RUN_GH_ROW = "gh api repos/a11ign/a11ign/branches/main/protection --jq '.enforce_admins.enabled'";

test("#2099: a row whose Acceptance is an UNDECLARED `gh` command is refused by `fileRefusalReason`, quoting it", () => {
  const reason = String(fileRefusalReason(withAcceptance(`## Acceptance\n\n\`\`\`\n${HAND_RUN_GH_ROW}\n\`\`\`\n\n`)));
  assert.match(reason, /^row-file: REFUSING to file --/);
  assert.ok(reason.includes(HAND_RUN_GH_ROW), `the refusal quotes the command: ${reason}`);
  assert.match(reason, /Hand-run: <who runs it and why>/);
});

test("#2099 CONTROL: the SAME row carrying the declaration files clean -- the ruling is DECLARE, not refuse, "
  + "because a blanket refusal refuses a CORRECT row (#2084 is the live one)", () => {
  const body = withAcceptance("## Acceptance\n\nHand-run: whoever holds the admin credential, which CI has not\n\n"
    + `\`\`\`\n${HAND_RUN_GH_ROW}\n\`\`\`\n\n`);
  assert.equal(fileRefusalReason(body), null,
    "and `null` is this rule's answer rather than another check's silence: the undeclared twin above differs "
    + "in exactly the declaration line");
});

// --- #2111: the PROMOTE act -- one command for the three writes that were done by hand ---
//
// Filing gets a row's label and Status right in one act; promoting one did not exist here at all.
// `gh issue edit --add-label ready`, `gh issue edit --remove-label backlog` and a Status move, typed by
// hand, by whoever remembered. Measured 2026-09-23: #2050 and #2110 were promoted by hand and both
// carried `backlog` AND `ready` for roughly 25 minutes, the only two of eight ready rows in that state.
// Every dependency below is injected, exactly as the filing tests inject theirs: no spawn, no network.
//
// REWORKED after the reviewer's blocker on `3de784b0`: the first version put `--add-label ready` and
// `--remove-label backlog` in ONE `gh issue edit` and called that atomic, and the tests only COUNTED the
// invocation. `row-claim.mjs`'s #749 comment already carried #677's reproduction of that same command
// half-applying, so the count proved nothing about the state a reader can observe. The label write is now
// one `PUT .../issues/<n>/labels`, which sets the whole list, and the tests below INJECT the failure:
// a write that throws, and a write that appends instead of replacing.

/**
 * A fake row whose labels are actually WRITTEN by the fake `gh`, so the read-back reads the write rather
 * than a second hand-written fixture. A read-ordinal fixture ("the first read says this, the rest say
 * that") cannot express a failed write at all, which is exactly what this row now has to test.
 */
function fakeRow(options: {
  labels?: string[];
  state?: "OPEN" | "CLOSED";
  body?: string;
  status?: string;
  failLabelWrite?: boolean;
  additiveLabelWrite?: boolean;
  onStatusMove?: (row: { labels: string[] }) => void;
} = {}) {
  const state = options.state ?? "OPEN";
  const row = { labels: [...(options.labels ?? ["backlog", "lane:any"])],
    status: options.status ?? "Backlog", calls: [] as string[][] };
  const deps = {
    run: (_cmd: string, args: string[]) => {
      row.calls.push(args);
      if (args[0] !== "api") return args.includes("body") ? (options.body ?? COMPLETE_BODY) : "";
      if (options.failLabelWrite) throw new Error("HTTP 502: Bad gateway (github.com)");
      const wanted = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
      // The real endpoint SETS the list. `additiveLabelWrite` is the fake that does NOT, which is how the
      // read-back's refusal gets driven rather than assumed -- see its own test below.
      row.labels = options.additiveLabelWrite
        ? [...row.labels, ...wanted.filter((l) => !row.labels.includes(l))]
        : wanted;
      return "";
    },
    fetchLabels: () => ({ number: 2111, title: "a real row", state, labels: [...row.labels] }),
    fetchBoardStatus: () => row.status,
    moveStatus: (_n: number, status: string) => {
      row.status = status;
      options.onStatusMove?.(row);
      return { moved: true as const };
    },
    ensureLabels: () => {},
  };
  /** Every label-WRITING call the act made -- the population the atomicity claim is about. */
  const labelWrites = () => row.calls.filter((args) => args[0] === "api");
  return { row, deps, labelWrites };
}

test("#2111 ACCEPTANCE, MUTATION TARGET: the Status moves first, and the labels are then written by "
  + "EXACTLY ONE request that SETS the whole list -- no `--add-label`/`--remove-label` pair anywhere, "
  + "because one `gh issue edit` invocation carrying both is one COMMAND and not one write (#677)", () => {
  const { row, deps, labelWrites } = fakeRow();
  const order: string[] = [];
  const code = promoteRow(["--promote=2111", "--session=worker-capture"], {
    ...deps,
    moveStatus: (_n: number, status: string) => { order.push(`status:${status}`); row.status = status;
      return { moved: true as const }; },
    run: (cmd: string, args: string[]) => { if (args[0] === "api") order.push("labels"); return deps.run(cmd, args); },
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["status:Ready", "labels"],
    `the Status moves before a single label write -- got: ${JSON.stringify(order)}`);
  assert.equal(labelWrites().length, 1, "one request, and the reason it is one is what makes it atomic");
  assert.deepEqual(labelWrites()[0], ["api", "--method", "PUT", `repos/${REPO}/issues/2111/labels`,
    "-f", "labels[]=ready", "-f", "labels[]=lane:any"],
    "GitHub's `Set labels for an issue`: the whole list in one PUT, every other label carried");
  assert.ok(!row.calls.some((args) => args.includes("--add-label") || args.includes("--remove-label")),
    "the delta form is the one #677 reproduced coming apart, so it must not appear at all");
  assert.deepEqual(row.labels, ["ready", "lane:any"], "and the row ends carrying exactly that list");
});

test("#2111 ACCEPTANCE, MUTATION TARGET, FAILURE INJECTION: when the label write FAILS the row's labels "
  + "are UNTOUCHED -- neither the both-labels state this row is about nor the neither-label one -- and "
  + "the act says so at exit 2 rather than reporting a promotion", () => {
  // The reviewer's blocker, made a test: the first version could not express this case, because a pair of
  // label operations has a partial outcome and a single set replacement does not.
  const { row, deps, labelWrites } = fakeRow({ failLabelWrite: true });
  let stderr = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    code = promoteRow(["--promote=2111"], deps);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(code, 2, "written (the Status) and unconfirmed -- createIssue's own code for exactly that");
  assert.deepEqual(row.labels, ["backlog", "lane:any"],
    "the labels are as they were: a failed set replacement applies no half of anything");
  assert.equal(labelWrites().length, 1, "and nothing retried or attempted a rollback write on top of it");
  assert.equal(row.status, "Ready", "the Status did move, which is the inconsistency the message must name");
  assert.match(stderr, /UNTOUCHED/);
  assert.match(stderr, /NOT in the both-labels state/);
  assert.match(stderr, /--promote=2111 --session=<you>` again\. It is idempotent/,
    "the recovery is this act, not a hand-written rollback that would be a second non-atomic write");
});

test("#2111 ACCEPTANCE, FAILURE INJECTION: the RECOVERY -- a second run after a failed label write "
  + "promotes the row and leaves exactly the intended list, so Status-first has a real repair behind it "
  + "rather than an ordering argument", () => {
  const failing = fakeRow({ failLabelWrite: true });
  assert.equal(promoteRow(["--promote=2111"], failing.deps), 2);
  // The same row, in the state that failure left it: Status Ready, labels untouched.
  const { row, deps, labelWrites } = fakeRow({ labels: failing.row.labels, status: failing.row.status });
  assert.equal(promoteRow(["--promote=2111", "--session=worker-capture"], deps), 0);
  assert.deepEqual(row.labels, ["ready", "lane:any"]);
  assert.equal(labelWrites().length, 1);
});

test("#2111 ACCEPTANCE, FAILURE INJECTION: if the endpoint APPENDED instead of replacing, the read-back "
  + "refuses to report a promotion -- the replacement semantics are checked rather than trusted", () => {
  const { row, deps } = fakeRow({ additiveLabelWrite: true });
  const code = promoteRow(["--promote=2111"], deps);
  assert.equal(code, 2, "`backlog` survived the write, and the middle clause of the read-back asks exactly that");
  assert.deepEqual(row.labels, ["backlog", "lane:any", "ready"],
    "the fake is the one behaving additively; the assertion is that the act notices");
});

test("#2111 ACCEPTANCE, MUTATION TARGET: a claim landing between the gate and the write is REFUSED, "
  + "never written over -- a set write computed from the older read would erase the claim's own labels "
  + "to add `ready`", () => {
  // The cost of a whole-list write, paid for by re-reading immediately before it. `onStatusMove` is the
  // window: the Project round trip is where a concurrent claim actually fits.
  const { row, deps, labelWrites } = fakeRow({
    onStatusMove: (r) => { r.labels = [...r.labels, CLAIM_LABEL, "session:worker-judge", "branch:agent/x"]; },
  });
  const code = promoteRow(["--promote=2111"], deps);
  assert.equal(code, 2);
  assert.equal(labelWrites().length, 0, "no label write at all");
  assert.deepEqual(row.labels, ["backlog", "lane:any", CLAIM_LABEL, "session:worker-judge", "branch:agent/x"],
    "the claim's labels are intact -- destroying a claim to add a label is worse than not promoting");
});

test("#2111 ACCEPTANCE: labelSetForPromotion is the whole list -- `ready` in, `backlog` out, every other "
  + "label kept, and it says `ready` once however the row spelled it", () => {
  assert.deepEqual(labelSetForPromotion(["backlog", "lane:any"]), ["ready", "lane:any"]);
  // The measured half-promoted state (#2050, #2110): the same one write repairs it.
  assert.deepEqual(labelSetForPromotion(["backlog", "ready", "lane:any"]), ["ready", "lane:any"]);
  assert.deepEqual(labelSetForPromotion(["Ready", "lane:ceo", "out-of-release"]),
    ["ready", "lane:ceo", "out-of-release"], "case-insensitively, the way `sameLabel` reads every label here");
  assert.deepEqual(labelSetForPromotion([]), ["ready"]);
});

test("#2111 ACCEPTANCE: promotionLabelsSettled is what stops an already-Ready row being written at all -- "
  + "a set write that changes nothing is still a write, and a write can still clobber", () => {
  assert.equal(promotionLabelsSettled(["ready", "lane:any"]), true);
  assert.equal(promotionLabelsSettled(["backlog", "ready"]), false, "the half-promoted state is not settled");
  assert.equal(promotionLabelsSettled(["backlog"]), false);
  const { row, deps, labelWrites } = fakeRow({ labels: ["ready", "lane:any"] });
  assert.equal(promoteRow(["--promote=2111"], deps), 0);
  assert.equal(labelWrites().length, 0, "no label request for a row whose labels already say it");
  assert.deepEqual(row.labels, ["ready", "lane:any"]);
  assert.equal(row.status, "Ready", "and the Status is still moved and still verified");
});

test("#2111 ACCEPTANCE: a row already carrying BOTH labels is repaired by the one write, and reported "
  + "promoted once the read-back confirms it", () => {
  const { row, deps, labelWrites } = fakeRow({ labels: ["backlog", "ready", "lane:any"] });
  assert.equal(promoteRow(["--promote=2050"], deps), 0);
  assert.deepEqual(labelWrites()[0], ["api", "--method", "PUT", `repos/${REPO}/issues/2050/labels`,
    "-f", "labels[]=ready", "-f", "labels[]=lane:any"]);
  assert.deepEqual(row.labels, ["ready", "lane:any"]);
});

/**
 * #2111 clause 6: THE CONTROL FOR THE REFUSAL BELOW. A new refusal that refuses everything passes every
 * negative test in this file and breaks the act outright, so the well-formed case is asserted first and
 * named as the control -- the refusal tests underneath are only meaningful beside it.
 */
test("#2111 ACCEPTANCE, MUTATION TARGET: a well-formed row is NOT refused -- the control for the "
  + "claimability refusal, which would otherwise pass by refusing every promotion", () => {
  const { row, deps } = fakeRow();
  assert.equal(promoteRow(["--promote=2111", "--session=worker-capture"], deps), 0,
    "COMPLETE_BODY carries Region, Acceptance and Open-check, so nothing may refuse it");
  assert.equal(row.status, "Ready", "and the Status move actually ran rather than being skipped");
});

test("#2111 ACCEPTANCE, MUTATION TARGET: a row whose body is missing a required section is REFUSED, and "
  + "NOTHING is written -- not the Status, not a label", () => {
  // #2050 needed an `## Open-check` written AT PROMOTION TIME. A promote act that skipped this check
  // would have published an unclaimable Ready row: the gate offers it, a session claims it, and
  // `row-claim` refuses after the round trip -- a worse state than the unpromoted one it came from.
  const incomplete = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n## Acceptance\n\n```\nnpx tsx --test x\n```\n";
  const { row, deps, labelWrites } = fakeRow({ body: incomplete });
  assert.equal(promoteRow(["--promote=2050"], deps), 1, "refused before anything was written");
  assert.equal(labelWrites().length, 0);
  assert.equal(row.status, "Backlog", "no Status move -- a refusal leaves the row exactly as it was");
});

test("#2111: the claimability refusal is the SAME rule the claim side enforces, named through "
  + "templateFieldsReason and fileRefusalReason rather than re-derived here", () => {
  // The refusal quotes the claim-side rule verbatim, including the issue number, so a session reading it
  // is reading the message `row-claim` would print if they claimed the row instead.
  const missingOpenCheck = "## Region\n\nx.ts\n\n## Acceptance\n\n```\nnpx tsx --test x\n```\n";
  const reason = promoteRefusalReason(missingOpenCheck, 2050);
  assert.match(String(reason), /#2050 is missing Open-check/);
  assert.equal(promoteRefusalReason(COMPLETE_BODY, 2111), null, "and a complete body is not refused");
  // A duplicated `## Acceptance` heading -- the OTHER thing #2050 needed fixed at promotion time --
  // reaches the filing rule's own parser rather than a second copy of it.
  const duplicated = `${COMPLETE_BODY}\n## Acceptance: none -- nothing to run\n`;
  assert.match(String(promoteRefusalReason(duplicated, 2050)), /DUPLICATE/);
});

test("#2111 ACCEPTANCE: the read-back refuses to report success when `backlog` is still on the row -- "
  + "the one clause that asks whether something LEFT", () => {
  const code = promoteRow(["--promote=2111"], {
    ...fakeRow().deps,
    // The write went out; the read-back still sees `backlog`. Before this row nothing asked.
    fetchLabels: () => ({ number: 2111, title: "a real row", state: "OPEN" as const,
      labels: ["backlog", "ready", "lane:any"] }),
  });
  assert.equal(code, 2, "written but unconfirmed -- createIssue's own code for exactly that");
});

test("#2111: unverifiedPromotionFields names each of the three facts separately", () => {
  assert.deepEqual(unverifiedPromotionFields({ labels: ["ready"], boardStatus: "Ready" }), []);
  assert.deepEqual(unverifiedPromotionFields({ labels: ["backlog"], boardStatus: "Ready" }).length, 2,
    "`ready` absent AND `backlog` still present are two separate facts, and a reader repairing the row "
    + "needs both named");
  assert.match(unverifiedPromotionFields({ labels: ["ready"], boardStatus: "Backlog" })[0],
    /reads "Backlog", not "Ready"/);
  assert.match(unverifiedPromotionFields({ labels: ["ready"], boardStatus: null })[0], /membership/);
});

test("#2111: a Status move that fails writes NO label at all, and says so -- the order in which the "
  + "first failure is a no-op", () => {
  const { row, deps, labelWrites } = fakeRow();
  const code = promoteRow(["--promote=2111"], {
    ...deps,
    moveStatus: () => ({ moved: false as const, reason: "is not an item in project 1", notOnBoard: true }),
  });
  assert.equal(code, 1, "nothing was written, so this is a refusal rather than a half-promotion");
  assert.equal(labelWrites().length, 0);
  assert.deepEqual(row.labels, ["backlog", "lane:any"]);
});

test("#2111: a CLOSED row and an already-CLAIMED row are refused, each for its own reason", () => {
  assert.equal(promoteRow(["--promote=2111"], fakeRow({ state: "CLOSED" }).deps), 1);
  // Promoting a claimed row would mint `ready` + `in-progress`, which `ready-label-audit`'s hand-claim
  // check reports as a claim made OUTSIDE row-claim.mjs -- so the promote act would point the audit at
  // the mechanism. `CLAIM_LABEL` is read from the module the claim path itself writes.
  const claimed = fakeRow({ labels: [CLAIM_LABEL, "session:worker-capture", "started"] });
  assert.equal(promoteRow(["--promote=2111"], claimed.deps), 1);
  assert.equal(claimed.labelWrites().length, 0);
  assert.equal(claimed.row.status, "Backlog", "refused at the gate, so not even the Status moved");
});

test("#2111: --promote= refuses every other filing argument rather than ignoring it, and accepts only "
  + "--session=", () => {
  assert.equal(promoteArgvRefusal(["--promote=2111"]), null);
  assert.equal(promoteArgvRefusal(["--promote=2111", "--session=worker-capture"]), null);
  // `refuseUnknownFlags` cannot catch these: they are flags this command genuinely knows, on its OTHER
  // path, and a flag silently ignored on the path you are actually on is the defect that file exists to end.
  assert.match(String(promoteArgvRefusal(["--promote=2111", "--title", "x"])), /--title/);
  assert.match(String(promoteArgvRefusal(["--promote=2111", "--ready"])), /--ready/);
});

test("#2111: promoteFromArgv reads a row number and nothing else", () => {
  assert.equal(promoteFromArgv(["--promote=2111"]), 2111);
  assert.equal(promoteFromArgv(["--promote=0"]), null);
  assert.equal(promoteFromArgv(["--promote=x"]), null);
  assert.equal(promoteFromArgv(["--promote="]), null);
  assert.equal(promoteFromArgv(["--session=x"]), null);
  // Refused rather than promoting some other row: `main` routes on the flag's PRESENCE, so a `--promote=`
  // naming something unusable must reach this refusal rather than fall through and try to FILE a row.
  assert.equal(promoteRow(["--promote=nope"], fakeRow().deps), 1);
});
