// no-token: gh
//
// Every `gh` call in this file is a fixture: `runArmPr` takes an injected `run`, and the fake answers the reads a refused lab PR makes.
// Its WRITES change a seat that the next read reports: `pr merge --disable-auto` clears the auto-merge request, and the dequeue takes the
// PR out of the queue. A write that does not change the seat (`disableIgnored`) is how the test shows the outcome is read back, not the exit code.

/**
 * agent-org#1278: A `cross-repo-red` REFUSAL DISARMS THE PULL REQUEST IT REFUSES. The disarm is judged from the PR's state after each
 * write, and the comment's first line says what that state is. Three PR states are driven through `runArmPr`:
 * - auto-merge enabled and not queued -> disarmed;
 * - in the merge queue -> dequeued, then read back out of the queue -> disarmed, reported `already in the queue`;
 * - already merged -> nothing to disarm, reported `already merged`, and no write is sent.
 *
 * The third state is a merge that lands between `runArmPr`'s own read (still OPEN) and the disarm's first read. A PR that is
 * merged before `runArmPr` reads it never reaches the refusal at all: `settledReason` returns first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runArmPr, EXIT } from "../arm-pr.ts";
import { crossRepoRedMarker } from "../cross-repo-red.ts";

const LAB = "a11ign/lab";
const LEG = "checks (cross-repo)";
const STEP = "The tests of this leg";
const PR_HEAD = "e929f712";
const PR_RUN = "38150000001";
const PR_NODE = "PR_kwDOlab81";
const TRUNK_RUN = 38151939490;
const FILES = ["packages/lab/src/packaging/every-test-file-is-run.test.ts", "packages/lab/src/packaging/layer-edges.test.ts"];
const BODY = "Closes a11ign/a11ign#5078\n\nADR 0045 cut 1.";
const DECLARED_BODY = `${BODY}\nCross-repo-red: A11-123\n`;

/** One `FAIL` line in rstest's form, for the leg of the PR's own run (the same shape `cross-repo-red-refusal.test.ts` reads). */
const failLine = (file: string) => {
  const slash = file.lastIndexOf("/");
  return `${LEG}\t${STEP}\t2026-10-11T15:35:54.0000000Z ^[[41m^[[37m^[[1m FAIL ^[[22m^[[39m^[[49m ^[[90m${file.slice(0, slash + 1)}^[[39m^[[36m${file.slice(slash + 1)}^[[39m ^[[2m>^[[22m a test of it`;
};
const LOG = FILES.map(failLine).join("\n");

type Seat = { armed: boolean; queued: boolean; merged: boolean };
type Options = { disableIgnored?: boolean; dequeueRefused?: boolean; body?: string; seeded?: string[] };

/** A fake `gh` for one lab pull request, whose seat the writes change. Unknown calls answer `""`, as the doors' own fixtures do. `seeded` are comments already on the PR. */
function world(seat: Seat, { disableIgnored = false, dequeueRefused = false, body = BODY, seeded = [] }: Options = {}) {
  const calls: string[][] = [];
  const comments: string[] = [...seeded];
  const run = (_cmd: string, args: string[]): string => {
    calls.push(args);
    const line = args.join(" ");
    if (line.includes("pullRequest(number:$n){id merged")) {
      return JSON.stringify({ id: PR_NODE, merged: seat.merged,
        autoMergeRequest: seat.armed ? { enabledAt: "2026-10-13T10:00:00Z" } : null,
        mergeQueueEntry: seat.queued ? { state: "QUEUED" } : null });
    }
    if (args[0] === "api" && line.includes("dequeuePullRequest")) {
      if (dequeueRefused) return JSON.stringify({ errors: [{ message: "the pull request is not in the queue" }] });
      seat.queued = false;
      return JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (args.includes("--disable-auto") && !disableIgnored) seat.armed = false;
      return "";
    }
    if (args[0] === "pr" && args[1] === "comment") {
      comments.push(args[args.indexOf("--body") + 1]);
      return "";
    }
    if (args[0] === "pr" && args[1] === "view" && line.includes("comments")) return JSON.stringify({ comments: comments.map((body) => ({ body })) });
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ labels: [], body, state: "OPEN", author: { login: "worker-1" } });
    if (line.includes("headRefOid")) return `${PR_HEAD}\n`;
    if (line.includes("check-runs?per_page=100")) {
      return JSON.stringify({ total_count: 2, check_runs: [
        { name: "gate", conclusion: "success", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/1` },
        { name: LEG, conclusion: "failure", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/114504845032` },
      ] });
    }
    if (line.includes("actions/workflows/ci.yml/runs")) {
      return JSON.stringify({ workflow_runs: line.includes("event=push")
        ? [{ head_sha: "77283f6e", status: "completed", conclusion: "success", id: TRUNK_RUN, html_url: `https://github.com/${LAB}/actions/runs/${TRUNK_RUN}`, created_at: "2026-10-11T15:35:54Z", event: "push" }]
        : [] });
    }
    if (line.includes(`actions/runs/${TRUNK_RUN}/jobs`)) return JSON.stringify({ jobs: [{ name: "gate", conclusion: "success" }, { name: LEG, conclusion: "success" }] });
    if (line.startsWith(`run view ${PR_RUN} `)) return LOG;
    if (args[0] === "issue" && args[1] === "view") {
      if (args[args.indexOf("--json") + 1] === "state") return JSON.stringify({ state: "OPEN" });
      return JSON.stringify(args.includes("labels") ? { labels: [] } : { blockedBy: { nodes: [], totalCount: 0 } });
    }
    if (line.includes("timelineItems")) return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } });
    return "";
  };
  return { run, calls, comments };
}

function drive(seat: Seat, options: Options = {}) {
  const fake = world(seat, options);
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=81", `--repo=${LAB}`], env: {}, run: fake.run, sleep: () => "ok" as const,
    log: (line: string) => said.push(line), error: (line: string) => said.push(line), lanes: { lanes: [] } });
  const disableCalls = fake.calls.filter((args) => args.includes("--disable-auto"));
  const dequeueCalls = fake.calls.filter((args) => args[0] === "api" && args.join(" ").includes("dequeuePullRequest"));
  const plainMergeCalls = fake.calls.filter((args) => args[0] === "pr" && args[1] === "merge" && !args.includes("--disable-auto"));
  // The first line of the refusal comment after its marker: the line that says whether the PR is disarmed.
  const lead = fake.comments.length ? fake.comments[0].split("\n")[1] : null;
  return { code, said: said.join("\n"), seat, disableCalls, dequeueCalls, plainMergeCalls, comments: fake.comments, lead };
}

test("#1278 (1) a red leg with auto-merge enabled and NOT queued is disarmed: read back unarmed, exit DONE, the comment's first line says disarmed", () => {
  const seat = { armed: true, queued: false, merged: false };
  const out = drive(seat);
  assert.equal(out.disableCalls.length, 1, "the disarm is sent once");
  assert.equal(out.dequeueCalls.length, 0, "a PR that is not queued is not dequeued");
  assert.equal(seat.armed, false, "the state, read back, says auto-merge is off");
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.plainMergeCalls.length, 0, "a refused PR is not merged");
  assert.equal(out.lead, "**Disarmed: yes (disarmed).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: disarmed #81 -- disarmed/);
});

test("#1278 (2) a red leg IN THE MERGE QUEUE is dequeued through `dequeuePullRequestOf`, read back out of the queue and unarmed: reported `already in the queue`", () => {
  const seat = { armed: true, queued: true, merged: false };
  const out = drive(seat);
  assert.equal(out.dequeueCalls.length, 1, "the queued PR is dequeued once");
  assert.equal(seat.queued, false, "read back: no longer in the queue");
  assert.equal(seat.armed, false, "read back: auto-merge off");
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.lead, "**Disarmed: yes (already in the queue).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: disarmed #81 -- already in the queue/);
});

test("#1278 (3) a red leg ALREADY MERGED is not disarmed and no write is sent: reported `already merged`, exit DONE", () => {
  const seat = { armed: true, queued: false, merged: true };
  const out = drive(seat);
  assert.equal(out.disableCalls.length, 0, "a merged PR has nothing to disarm, so no write is sent");
  assert.equal(out.dequeueCalls.length, 0);
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.lead, "**Disarmed: no (already merged).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: NOT disarmed #81 -- already merged/);
});

test("#1278 (4) a queued red leg whose dequeue is REFUSED: the comment says queued and names the command, and the exit is CANNOT_ASK", () => {
  const seat = { armed: true, queued: true, merged: false };
  const out = drive(seat, { dequeueRefused: true });
  assert.equal(out.dequeueCalls.length, 1);
  assert.equal(seat.queued, true, "read back: still in the queue");
  assert.equal(out.code, EXIT.CANNOT_ASK, out.said);
  const lead = out.lead ?? "";
  assert.ok(lead.startsWith("**Disarmed: no (queued, and the dequeue failed (the dequeue was refused: the pull request is not in the queue)"), lead);
  assert.ok(lead.includes("to take it out of the queue run: gh api graphql -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{state}}}' -f id=PR_kwDOlab81"), lead);
});

test("#1278 (5) the OUTCOME IS READ BACK, not the exit code: a disarm that exits 0 and leaves auto-merge on is `NOT disarmed`, exit CANNOT_ASK", () => {
  const seat = { armed: true, queued: false, merged: false };
  const out = drive(seat, { disableIgnored: true });
  assert.equal(out.disableCalls.length, 1, "the write was sent and its exit (0) was not trusted");
  assert.equal(seat.armed, true, "read back: auto-merge still on");
  assert.equal(out.code, EXIT.CANNOT_ASK, out.said);
  assert.equal(out.lead, "**Disarmed: no (auto-merge is still enabled after `gh pr merge --disable-auto`).**", out.comments.join("\n---\n"));
});

test("#1278 (6) the disarm runs on a cross-repo-red verdict ONLY: a declared PR that arms sends no `--disable-auto`", () => {
  const seat = { armed: false, queued: false, merged: false };
  const out = drive(seat, { body: DECLARED_BODY });
  assert.equal(out.disableCalls.length, 0, out.said);
  assert.equal(out.comments.length, 0, "an armed PR gets no refusal comment");
  assert.equal(out.plainMergeCalls.length, 1, "the declared PR arms, so it is merged-armed as usual");
});

// The refusal made before this change: its marker comment says "Not armed" and nothing about the disarm.
const BEFORE_THIS_CHANGE = `${crossRepoRedMarker(FILES)}\n**Not armed: a red leg.** Nothing about the disarm.`;

test("#1278 (7) a PR already refused BEFORE this change (its marker, no disarm line) is disarmed, and the disarm's outcome is posted on a new comment", () => {
  const seat = { armed: true, queued: false, merged: false };
  const out = drive(seat, { seeded: [BEFORE_THIS_CHANGE] });
  assert.equal(seat.armed, false, "the state, read back, says auto-merge is off");
  assert.equal(out.comments.length, 2, "the old comment stands, and the outcome is posted beside it");
  assert.equal(out.comments[1].split("\n")[1], "**Disarmed: yes (disarmed).**", out.comments[1]);
  assert.equal(out.code, EXIT.DONE, out.said);
});

test("#1278 (8) a refusal whose outcome is already on the PR (same marker AND same lead) posts nothing more, on a repeat tick", () => {
  const seat = { armed: true, queued: false, merged: false };
  const out = drive(seat, { seeded: [`${crossRepoRedMarker(FILES)}\n**Disarmed: yes (disarmed).**\n**Not armed: a red leg.**`] });
  assert.equal(out.comments.length, 1, "the seeded comment already says this outcome, so nothing is posted");
  assert.equal(out.code, EXIT.DONE, out.said);
});
