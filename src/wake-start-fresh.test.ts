// no-token: gh -- every `herdr` and `git` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.ts`, #4524: A CHAIRMAN ROW'S ORDER (`startFresh: true`) STARTS A FRESH ENGINEER ABOVE THE PILOT'S PACE LIMITS.
 *
 * Measured 2026-10-09: #4588 carried `priority:chairman` from the chairman, the gate put `startFresh: true` on its order, and `wake.ts` read
 * the field nowhere -- five ticks of `UNDELIVERED ... no engineer is idle and allowed to claim`. This drives the production entry (`deliver`)
 * with an EMPTY idle pool, as `wake-spawn-load-gate.test.ts` does, and the controls come first: the same order WITHOUT the flag is refused
 * for each pace limit, so a start with the flag is the flag's doing and not what the fixture always does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver as settlingDeliver, parseOrders, refusalReport, spawnClaimability, startsFresh } from "./wake.ts";
import { startedPanes } from "./packaging/started-pane.ts";

const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: () => {} });
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const overLoaded = () => ({ load: 98, cores: 16 });

const orderFor = (row: number, extra: Record<string, unknown> = {}) => ({
  session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  prompt: `Ready row #${row} is unclaimed.`, ...extra,
});
const plain = orderFor(4588);
const chairman = orderFor(4588, { startFresh: true });

function recordingHerdr() {
  const calls: string[] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run, started: () => calls.filter((c) => c.includes("agent start")) };
}
const BUSY = agents({ ceo: "working" });

test("#4524 CONTROL: a plain order at load 98 starts nothing", () => {
  const herdr = recordingHerdr();
  const got = deliver([plain], BUSY, [], { run: herdr.run, hostLoad: overLoaded });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /host load 98 is over its 16 cores/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: a chairman order at load 98 with no engineer idle starts a fresh one for its row", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, hostLoad: overLoaded });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent[0], /^worker-4588 <- engineers\/ready-row-unclaimed\/4588 \(STARTED /);
  assert.equal(herdr.started().length, 1);
});

test("#4524: a chairman order is started after the tick's allowance is spent; a plain one behind it is not", () => {
  const herdr = recordingHerdr();
  const got = deliver([orderFor(100), chairman, orderFor(101)], BUSY, [], { run: herdr.run });

  assert.deepEqual(got.sent.map((line) => line.split(" ")[0]), ["worker-100", "worker-4588"]);
  assert.equal(got.refused.length, 1);
  assert.match(got.refused[0], /^engineers\/ready-row-unclaimed\/101: .*MAX_SPAWNS_PER_TICK/);
});

test("#4524: it is at most ONE per row -- an address already holding a process refuses the second start", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], agents({ ceo: "working", "worker-4588": "working" }), [], { run: herdr.run });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /"worker-4588" is the address row #4588 would be named/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the safety checks still bind -- the memory floor refuses a chairman start", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, memory: () => "free memory is under the floor" });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /free memory is under the floor/);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the claim's own eligibility still binds -- a row the claim would refuse is not started", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], BUSY, [], { run: herdr.run, claimable: () => "overlaps #1 in a11ign/agent-org" });

  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /overlaps #1 in a11ign\/agent-org/);
});

test("#4524: an idle engineer still takes the chairman order, and nothing new is started", () => {
  const herdr = recordingHerdr();
  const got = deliver([chairman], agents({ ceo: "working", "worker-1": "idle" }), ["worker-1"], { run: herdr.run, hostLoad: overLoaded });

  assert.match(got.sent.join("\n"), /^worker-1 <- /);
  assert.deepEqual(herdr.started(), []);
});

test("#4524: the flag lifts nothing for an order the pilot would not take", () => {
  assert.equal(startsFresh({ session: "engineers", cause: "ready-row-unclaimed", startFresh: true }), true);
  assert.equal(startsFresh({ session: "engineers", cause: "ready-row-unclaimed" }), false, "no flag");
  assert.equal(startsFresh({ session: "engineers", cause: "draft-awaiting-verdict", startFresh: true }), false, "not a pilot cause");
  assert.equal(startsFresh({ session: "ceo", cause: "ready-row-unclaimed", startFresh: true }), false, "not the engineer pool");
});

test("#4524: the field survives the gate-to-wake hand-off (`parseOrders`)", () => {
  const [parsed] = parseOrders(`${JSON.stringify(chairman)}\n`);
  assert.equal((parsed as { startFresh?: boolean }).startFresh, true);
});

// --- #4524, THE AMENDED HALF: A CHAIRMAN ROW THE CLAIM WOULD REFUSE IS TOLD TO THE ROW, AND A PR IN THE MERGE QUEUE IS A WAIT -----------------------------------
//
// Measured 2026-10-09 20:36-20:42Z: #4629 carried `priority:chairman`, four ticks said `UNDELIVERED ... #4629 would be refused at the claim by the file-overlap
// check (B4): overlaps #545 in a11ign/agent-org`, and the journal was the only place that was said -- the chairman read it as plain orders served first.
// These drive the REAL spawner path (`deliver` -> `targetFor` -> `spawnWorker` -> `whyNoSpawn` -> `spawnClaimability`) with a GitHub that is a seam, so what is
// asserted is what reaches `gh issue comment`, not what a helper returned.

const REPOS = [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }];
const WAKE_TS = "agent-org:src/wake.ts";
const CHAIRMAN_ROW = 4524;

type OpenPr = { number: number; repo: string; files: string[]; };
type Github = { run: (args: string[]) => string; post: (args: string[]) => string; comments: Map<number, string[]>; posted: () => string[]; };

/** A fixture GitHub: each row's Region, the open PRs (and which are queued), and the comments written so far -- one list per row, read back by `gh api`. */
function github({ regions, prs, queued = [] }: { regions: Record<number, string[]>; prs: OpenPr[]; queued?: number[]; }): Github {
  const comments = new Map<number, string[]>();
  const writes: string[] = [];
  const run = (args: string[]): string => {
    const [verb, noun] = args;
    if (verb === "issue" && noun === "view") return issueView(args, regions);
    if (verb === "pr" && noun === "list") return JSON.stringify(prs.filter((pr) => pr.repo === args[args.indexOf("--repo") + 1]).map((pr) => (
      { number: pr.number, changedFiles: pr.files.length, files: pr.files.map((path) => ({ path })), body: "", labels: [], headRefName: `agent/pr-${pr.number}` })));
    if (verb === "api" && args.includes("graphql")) return String(queued.some((n) => args.join(" ").includes(`pullRequest(number:${n})`)));
    if (verb === "api") return commentLines(args, comments);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const post = (args: string[]): string => {
    assert.deepEqual(args.slice(0, 2), ["issue", "comment"], "the only write is a row comment");
    const row = Number(args[2]);
    comments.set(row, [...(comments.get(row) ?? []), args[args.indexOf("--body") + 1]]);
    writes.push(`${row}: ${args[args.indexOf("--body") + 1]}`);
    return "";
  };
  return { run, post, comments, posted: () => writes };
}

function issueView(args: string[], regions: Record<number, string[]>): string {
  if (args.includes("blockedBy")) return JSON.stringify({ blockedBy: { nodes: [] } });
  const files = regions[Number(args[2])] ?? [];
  return JSON.stringify({ body: `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n\n## Acceptance\n` });
}

/** `gh api repos/{owner}/{repo}/issues/N/comments --jq '.[] | [id, login, at, (.body | contains(<marker>))] | @json'`, answered from the fixture's list. */
function commentLines(args: string[], comments: Map<number, string[]>): string {
  const row = Number(/issues\/(\d+)\/comments/.exec(args.join(" "))?.[1]);
  const marker = JSON.parse(/contains\((".*")\)/.exec(args[args.length - 1])?.[1] ?? "null") as string;
  return (comments.get(row) ?? []).map((body, i) => JSON.stringify([i + 1, "a11ign-ai-workers", "2026-10-09T21:00:00Z", body.includes(marker)])).join("\n");
}

const claimable = (gh: Github) => spawnClaimability({ run: gh.run, post: gh.post, repos: REPOS, warn: () => {} });
const WAKE_PR: OpenPr = { number: 545, repo: "a11ign/agent-org", files: ["src/wake.ts"] };
const asChairman = orderFor(CHAIRMAN_ROW, { startFresh: true });

test("#4524 MIXED BATCH: a chairman row B4 refuses is NOT skipped silently -- its refusal names the PR and is written on the row; the plain rows are untouched", () => {
  const gh = github({ prs: [WAKE_PR], regions: { [CHAIRMAN_ROW]: [WAKE_TS], 4563: ["agent-org:src/wakes-per-row.ts"], 4443: ["agent-org:src/work-gate.ts"], 4644: ["agent-org:src/herdr-agents.ts"], 4570: [WAKE_TS] } });
  const herdr = recordingHerdr();
  // 4570 is a PLAIN row on the same file: it is asked BEFORE 4563 spends the tick's one allowance, so its refusal is the claim's and not the allowance's.
  const batch = [asChairman, orderFor(4570), orderFor(4563), orderFor(4443), orderFor(4644)];
  const got = deliver(batch, BUSY, [], { run: herdr.run, claimable: claimable(gh) });

  const chairmanLine = got.refused.find((line) => line.startsWith(`engineers/ready-row-unclaimed/${CHAIRMAN_ROW}:`));
  assert.match(chairmanLine ?? "", /#4524 would be refused at the claim by the file-overlap check \(B4\): overlaps #545 in a11ign\/agent-org/);
  assert.deepEqual([...gh.comments.keys()], [CHAIRMAN_ROW], "ONLY the chairman row is written to: a plain row's refusal stays a journal line");
  assert.match(gh.posted()[0], /^4524: <!-- chairman-row-hold:4524:B4:#545 in a11ign\/agent-org -->\n\*\*This `priority:chairman` row was NOT started this tick/);
  assert.match(gh.posted()[0], /overlaps #545 in a11ign\/agent-org/);
  assert.equal(gh.posted().length, 1);
  assert.match(got.sent.join("\n"), /^worker-4563 <- engineers\/ready-row-unclaimed\/4563 \(STARTED /, "a plain row that passes B4 is started, and has its own line");
  assert.match(got.refused.find((line) => line.includes("/4570:")) ?? "", /4570 would be refused at the claim by the file-overlap check \(B4\)/);
  assert.equal(herdr.started().length, 1);
});

test("#4524: the same refusal is written ONCE, however many ticks repeat it", () => {
  const gh = github({ prs: [WAKE_PR], regions: { [CHAIRMAN_ROW]: [WAKE_TS] } });
  for (let tick = 0; tick < 3; tick++) deliver([asChairman], BUSY, [], { run: recordingHerdr().run, claimable: claimable(gh) });

  assert.equal(gh.posted().length, 1);
});

test("#4524: a PR IN THE MERGE QUEUE is a WAIT that names it -- written once, DEFERRED not UNDELIVERED, and the tick after it merges starts the row", () => {
  const regions = { [CHAIRMAN_ROW]: [WAKE_TS] };
  const queued = github({ prs: [WAKE_PR], regions, queued: [545] });
  const first = deliver([asChairman], BUSY, [], { run: recordingHerdr().run, claimable: claimable(queued) });

  assert.match(first.refused[0], /; no spawn: #4524 waits for #545 in a11ign\/agent-org, which is in the merge queue: B4 /);
  assert.doesNotMatch(first.refused[0], /would be refused/, "a wait is not worded as a refusal");
  assert.match(queued.posted()[0], /\*\*Waiting, not refused/);
  const report = refusalReport(first.refused, () => new Map());
  assert.equal(report.deferred.length, 1);
  assert.deepEqual(report.undelivered, []);
  assert.equal(report.summary, null, "a wait in the merge queue does not make the tick exit ATTENTION");

  deliver([asChairman], BUSY, [], { run: recordingHerdr().run, claimable: claimable(queued) });
  assert.equal(queued.posted().length, 1, "the next tick, still queued, writes nothing more");

  // The PR left the queue by MERGING: it is no longer open, B4 clears, and the row starts -- nothing is reported as a refusal.
  const merged = github({ prs: [], regions });
  merged.comments.set(CHAIRMAN_ROW, queued.comments.get(CHAIRMAN_ROW) ?? []);
  const herdr = recordingHerdr();
  const after = deliver([asChairman], BUSY, [], { run: herdr.run, claimable: claimable(merged) });
  assert.deepEqual(after.refused, []);
  assert.match(after.sent[0], /^worker-4524 <- engineers\/ready-row-unclaimed\/4524 \(STARTED /);
  assert.deepEqual(merged.posted(), []);
});

test("#4524 CONTROL: the same overlap with the PR NOT in the queue is a refusal -- UNDELIVERED, and counted", () => {
  const gh = github({ prs: [WAKE_PR], regions: { [CHAIRMAN_ROW]: [WAKE_TS] }, queued: [] });
  const got = deliver([asChairman], BUSY, [], { run: recordingHerdr().run, claimable: claimable(gh) });
  const report = refusalReport(got.refused, () => new Map());

  assert.equal(report.undelivered.length, 1);
  assert.deepEqual(report.deferred, []);
  assert.notEqual(report.summary, null);
});

test("#4524: a plain row is never written to, and the merge queue is not even read for it", () => {
  const gh = github({ prs: [WAKE_PR], regions: { 4570: [WAKE_TS] }, queued: [545] });
  const reads: string[] = [];
  const run = (args: string[]) => { reads.push(args.join(" ")); return gh.run(args); };
  const got = deliver([orderFor(4570)], BUSY, [], { run: recordingHerdr().run, claimable: spawnClaimability({ run, post: gh.post, repos: REPOS, warn: () => {} }) });

  assert.match(got.refused[0], /4570 would be refused at the claim by the file-overlap check \(B4\)/);
  assert.deepEqual(gh.posted(), []);
  assert.equal(reads.filter((r) => r.includes("graphql")).length, 0);
});

test("#4524: a row write that fails is SAID and does not change the claim's answer", () => {
  const gh = github({ prs: [WAKE_PR], regions: { [CHAIRMAN_ROW]: [WAKE_TS] } });
  const said: string[] = [];
  const failing = spawnClaimability({ run: gh.run, post: () => { throw new Error("HTTP 502"); }, repos: REPOS, warn: (line) => said.push(line) });
  const got = deliver([asChairman], BUSY, [], { run: recordingHerdr().run, claimable: failing });

  assert.match(got.refused[0], /file-overlap check \(B4\)/);
  assert.match(said.join("\n"), /could not write #4524's claim refusal on the row \(HTTP 502\)/);
});
