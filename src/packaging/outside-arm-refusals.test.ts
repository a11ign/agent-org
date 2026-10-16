// no-token: gh
//
// Every `gh` call in this file is a fixture: `outsideArmPass` takes an injected `run`, and its default `arm` runs the REAL `runArmPr`
// over that same `run`, so `arm-pr`'s own reads and writes land in the fake too. True of the IMPORT and false of every CALL.
/**
 * agent-org#1622: AN OUTSIDE PASS REPORTS "armed" ONLY AFTER A READ-BACK SAYS SO, AND EVERY REFUSAL `arm-pr` MAKES IS NAMED, NOT PASSED.
 *
 * THE INSTANCE. a11ign/a11ign#1595 was ejected from the merge queue, the outside pass logged it "armed", and its GraphQL read said
 * `autoMergeRequest: null`. `arm-pr` exits DONE for a deliberate refusal as it does for an arm (its exit codes are not changed here),
 * so the pass read the exit as the answer. The answer is the read-back.
 *
 * ONE TEST PER REFUSAL, THROUGH THE PASS, with the real `runArmPr` under it. Each refusal asserts four things:
 *   - it is not in `result.armed`;
 *   - no `pr merge --auto` write was made;
 *   - it is named in `result.left` (with the line `arm-pr` wrote) or in `result.failed`;
 *   - no log line says "armed" in lowercase. The word belongs to the read-back line, and to nothing else.
 * The positive control beside them is an armable pull request, which IS in `result.armed` after its read-back says so.
 *
 * THE ORDER is `arm-pr`'s own (ejection first, because #3487 put it before any write for a pull request that nothing else has touched),
 * then the drift refusals (a fact the policy list did not show, read again by `arm-pr`), then the two that the pass's verdict refuses
 * before `arm-pr` is ever reached (a draft that is not approved, a fork). Those two assert that `arm-pr` was never called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { outsideArmListArgs, outsideArmPass, openPullRequestsQueryArgs, type OutsideArmPr } from "../auto-arm-sweep.ts";
import { armedQueryArgs } from "../pr-armed-state.ts";
import type { Lane } from "../lane-ownership.ts";

const REPO = "a11ign/a11ign";
const LAB = "a11ign/lab";
const LEADS = "a11ign-ai-leads";
const WORKERS = "a11ign-ai-workers";
const OUTSIDE = "an-outside-contributor";
const WORKFLOW = ".github/workflows/ci.yml";
const PIPELINE: Lane = { lane: "the pipeline", owner: "ceo", branchPrefixes: ["ceo/"], paths: [".github/workflows/"],
  why: "trunk health", except: [".github/workflows/consumer-gate.yml"], reviewOnly: true };
const NO_LANES = { lanes: [] as Lane[] };

const LIST: OutsideArmPr = { number: 7, state: "OPEN", isDraft: false, baseRefName: "main", isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", labels: [{ name: "agent" }] };
const CLEAN = { labels: [] as string[], body: "Closes #1", state: "OPEN", author: OUTSIDE };
const EMPTY_QUEUE = { mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: "PullRequestCommit" }] } };

// #3460's timeline, as `EJECTED_3460` in `arm-refuses-an-ejected-pr.test.ts`: two commits, then four ADDED / REMOVED `failed_checks` pairs.
const COMMIT = { __typename: "PullRequestCommit" };
const added = (createdAt: string) => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const removed = (createdAt: string, reason = "failed_checks") => ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason });
const EJECTED_3460 = { mergeQueueEntry: null, timelineItems: { nodes: [COMMIT, COMMIT,
  added("2026-10-04T14:08:56Z"), removed("2026-10-04T14:20:02Z"),
  added("2026-10-04T14:20:19Z"), removed("2026-10-04T14:27:45Z"),
  added("2026-10-04T14:28:56Z"), removed("2026-10-04T14:36:27Z"),
  added("2026-10-04T14:40:24Z"), removed("2026-10-04T14:48:06Z")] } };

// The cross-repo leg of lab's head: the same `FAIL` lines the leg's log prints for two files, in rstest's form.
const LEG = "checks (cross-repo)";
const PR_RUN = "38150000001";
const TRUNK_RUN = 38151939490;
const RED_FILES = ["packages/lab/src/packaging/every-test-file-is-run.test.ts", "packages/lab/src/packaging/layer-edges.test.ts"];
const failLine = (file: string) => {
  const slash = file.lastIndexOf("/");
  return `${LEG}\tThe tests of this leg\t2026-10-11T15:35:54.0000000Z ^[[41m^[[37m^[[1m FAIL ^[[22m^[[39m^[[49m ^[[90m${file.slice(0, slash + 1)}^[[39m^[[36m${file.slice(slash + 1)}^[[39m ^[[2m>^[[22m a test of it`;
};

type View = { labels: string[]; body: string; state: string; author: string; };
type World = {
  repo?: string;
  list?: Partial<OutsideArmPr>;   // the policy list the pass reads
  view?: Partial<View>;           // what `arm-pr` reads from `pr view` (drift: a fact the list did not show)
  timeline?: unknown;             // the queue history
  blockedBy?: { number: number; state: string; }[];
  files?: string[];               // the files of the pull request, for the authorship read
  tip?: string;                   // the branch's real tip, for the deliberate-refusal read; the head is `abc123`
  legRed?: boolean;               // the lab's cross-repo leg failed on RED_FILES, and the trunk passed them
};

/** The `gh` the pass and `arm-pr` talk to. Writes are recorded as their argument lines; unknown reads answer "", as the doors' fixtures do. */
function world(w: World = {}) {
  const repo = w.repo ?? REPO;
  const view: View = { ...CLEAN, ...w.view };
  const list: OutsideArmPr = { ...LIST, ...w.list };
  const state = { armed: false };
  const writes: string[] = [];
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const line = args.join(" ");
    if (line === outsideArmListArgs(repo).join(" ")) return JSON.stringify([list]);
    if (line === openPullRequestsQueryArgs(repo).join(" ")) return JSON.stringify([{ number: 7, isDraft: list.isDraft, autoMergeRequest: state.armed ? { enabledAt: "t" } : null }]);
    if (line === armedQueryArgs({ number: 7, repo }).join(" ")) {
      return JSON.stringify({ merged: view.state === "MERGED", autoMergeRequest: state.armed ? { enabledAt: "t" } : null, mergeQueueEntry: null });
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (args.includes("comments")) return JSON.stringify({ comments: [] });
      return JSON.stringify({ labels: view.labels.map((name) => ({ name })), body: view.body, state: view.state, author: { login: view.author } });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      writes.push(line);
      if (!args.includes("--disable-auto")) state.armed = true;
      return "";
    }
    if (args[0] === "pr" && (args[1] === "ready" || args[1] === "comment")) { writes.push(line); return ""; }
    if (args[0] === "api" && args[2]?.endsWith("/files")) return (w.files ?? []).join("\n");
    if (args[0] === "api" && args[1] === `repos/${repo}/pulls/7`) {
      return JSON.stringify({ state: view.state.toLowerCase(), user: { login: view.author }, labels: view.labels.map((name) => ({ name })), body: view.body,
        head: { sha: "abc123", ref: "agent/lane-7", repo: { full_name: REPO } }, base: { repo: { full_name: REPO } } });
    }
    if (args[0] === "api" && args[1] === `repos/${repo}/git/ref/heads/agent/lane-7`) return JSON.stringify({ object: { sha: w.tip ?? "abc123" } });
    if (args[0] === "api" && args[1] === `repos/${repo}/issues/1`) return JSON.stringify({ body: "a row naming no test" });
    // the disarm read-back of a red leg (`readDisarmSeat`): the node id, whether it merged, whether auto-merge is on, and the queue entry.
    if (args.some((x) => x.includes("pullRequest(number:$n){id merged"))) {
      return JSON.stringify({ id: "PR_node_7", merged: view.state === "MERGED", autoMergeRequest: state.armed ? { enabledAt: "t" } : null, mergeQueueEntry: null });
    }
    if (args.some((x) => x.includes("closingIssuesReferences"))) {
      return JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
        { number: 1, title: "a row", repository: { nameWithOwner: REPO }, labels: { nodes: [] } }] } } } } });
    }
    if (args.some((x) => x.includes("timelineItems"))) return JSON.stringify(w.timeline ?? EMPTY_QUEUE);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ labels: [], blockedBy: { nodes: w.blockedBy ?? [], totalCount: (w.blockedBy ?? []).length } });
    if (w.legRed && line.includes("check-runs?per_page=100")) {
      return JSON.stringify({ total_count: 2, check_runs: [
        { name: "gate", conclusion: "success", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/1` },
        { name: LEG, conclusion: "failure", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/114504845032` }] });
    }
    if (w.legRed && line.includes("headRefOid")) return "e929f712\n";
    if (w.legRed && line.includes("actions/workflows/ci.yml/runs")) {
      const common = { head_sha: "77283f6e", status: "completed", html_url: `https://github.com/${LAB}/actions/runs/${TRUNK_RUN}` };
      return JSON.stringify({ workflow_runs: line.includes("event=push")
        ? [{ ...common, id: TRUNK_RUN, conclusion: "success", created_at: "2026-10-11T15:35:54Z", event: "push" }]
        : [{ ...common, id: 38133429541, conclusion: "success", created_at: "2026-10-11T10:51:00Z", event: "schedule" }] });
    }
    if (w.legRed && line.includes(`actions/runs/${TRUNK_RUN}/jobs`)) return JSON.stringify({ jobs: [{ name: "gate", conclusion: "success" }, { name: LEG, conclusion: "success" }] });
    if (w.legRed && line.startsWith(`run view ${PR_RUN} `)) return RED_FILES.map(failLine).join("\n");
    if (w.legRed && line.startsWith(`run view ${TRUNK_RUN} `)) return "";
    return "";
  };
  return { run, writes, calls, repo };
}

/** One pass over the pull request #7 with the real `arm-pr` under it. The lanes are empty unless a case brings its own. */
function drive(w: World = {}, lanes: { lanes: Lane[] } = NO_LANES) {
  const fake = world(w);
  const lines: string[] = [];
  const result = outsideArmPass({ repo: fake.repo, switchesPath: "", on: true, run: fake.run, log: (line) => lines.push(line), lanes });
  return { result, lines, writes: fake.writes, calls: fake.calls };
}

/** The four things every refusal must hold, and the reason it is named by. */
function assertRefused(name: string, out: ReturnType<typeof drive>, why: RegExp) {
  assert.deepEqual(out.result.armed, [], `${name}: must not be armed`);
  assert.deepEqual(out.writes.filter((line) => line.startsWith("pr merge") && !line.includes("--disable-auto")), [], `${name}: no arm write`);
  const left = out.result.left.find((entry) => entry.number === 7);
  assert.ok(left !== undefined || out.result.failed.includes(7), `${name}: named in result.left or result.failed`);
  assert.match(left ? left.why : out.lines.join("\n"), why, `${name}: the reason`);
  for (const line of out.lines) assert.doesNotMatch(line, /\barmed\b/, `${name}: no log line says armed: ${line}`);
}

// --- the refusals, in arm-pr's own order, ejection first ----------------------------------------------------------------------------------

test("#1622 (1) ejected without a push: #3460's real timeline is named as the ejection, and nothing is armed", () => {
  const out = drive({ timeline: EJECTED_3460 });
  assertRefused("ejected", out, /without a push/);
  assert.ok(out.result.left.some((entry) => entry.why.includes("2026-10-04T14:48:06Z")), "the ejection time is in the reason");
});

test("#1622 (2) hold: a `hold:` label `arm-pr` reads, although the list the pass read showed none, is named as the hold", () => {
  const out = drive({ view: { labels: ["hold:ceo"] } });
  assertRefused("hold", out, /hold/i);
});

test("#1622 (3) settled: a pull request `arm-pr` reads as merged, although the list showed it open, is named as settled", () => {
  const out = drive({ view: { state: "MERGED" } });
  assertRefused("settled", out, /MERGED|merged/);
});

test("#1622 (4) authorship: a leads-login pull request that touches the pipeline is named as the lane refusal", () => {
  const out = drive({ view: { author: LEADS }, files: [WORKFLOW] }, { lanes: [PIPELINE] });
  assertRefused("authorship", out, /lane|pipeline/i);
});

test("#1622 (5) open blocker: a closing row that an OPEN row blocks is named as the block, and `arm-pr` announces it", () => {
  const out = drive({ blockedBy: [{ number: 9, state: "OPEN" }] });
  assertRefused("open blocker", out, /blocked by open #9/);
});

test("#1622 (6) red leg: lab's cross-repo leg fails on files the newest trunk run passed, and no declaration names a row", () => {
  const out = drive({ repo: LAB, legRed: true });
  assertRefused("red leg", out, /cross-repo leg/);
  assert.ok(out.result.left.some((entry) => entry.why.includes(RED_FILES[0])), "the failing file is named");
});

test("#1622 (7) deliberate refusal: an org author's head that is not the branch's tip is named as the refusal", () => {
  const out = drive({ view: { author: WORKERS }, tip: "def456" });
  assertRefused("deliberate", out, /BRANCH TIP/);
});

// --- the two the pass's verdict refuses before `arm-pr` is reached ------------------------------------------------------------------------

test("#1622 (8) draft not approved: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { isDraft: true, reviewDecision: "REVIEW_REQUIRED" } });
  assertRefused("draft", out, /draft that is not approved/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

test("#1622 (9) fork: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { isCrossRepository: true } });
  assertRefused("fork", out, /fork/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

test("#1622 (10) unread labels: a list that did not carry the labels is left, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { labels: undefined } });
  assertRefused("unread labels", out, /labels were not read/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

test("#1622 (11) hold in the list: the pass leaves a pull request its own list shows held, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { labels: [{ name: "hold:ceo" }] } });
  assertRefused("verdict hold", out, /hold:ceo/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

test("#1622 (12) closed in the list: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { state: "CLOSED" } });
  assertRefused("verdict state", out, /the pull request is CLOSED/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

test("#1622 (13) base not main in the list: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { baseRefName: "dev" } });
  assertRefused("verdict base", out, /its base is dev, not main/);
  assert.equal(out.calls.some((args) => args[0] === "pr" && args[1] === "view"), false, "no arm-pr read");
});

// --- the positive control -------------------------------------------------------------------------------------------------------------------

test("#1622 CONTROL: an armable pull request IS armed, and only after its read-back says so", () => {
  const out = drive({});
  assert.deepEqual(out.result.armed, [7], out.lines.join("\n"));
  assert.ok(out.writes.some((line) => line.startsWith("pr merge") && line.includes("--auto")), "the arm write happened");
  assert.ok(out.lines.some((line) => /OUTSIDE-ARM: #7 armed -- read back: /.test(line)), out.lines.join("\n"));
});
