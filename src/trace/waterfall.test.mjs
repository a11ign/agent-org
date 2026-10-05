// a11ign/a11ign#3511 (slice 4 of #3494): the waterfall, on a fixture row in the store's shapes. Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every event is a fixture; `waterfall` is a pure function and calls nothing
import assert from "node:assert/strict";
import { test } from "node:test";
import { BETWEEN, duration, PHASES, renderWaterfall, waterfall } from "./waterfall.mjs";

const REPO_ROW = 9001;
const PR = 9100;
const H1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const at = (hhmmss) => Date.parse(`2026-10-04T${hhmmss}Z`);
const MINUTE = 60 * 1000;
const NOW = at("13:30:00");

const base = { repo: null, cause: null, causeKey: null, wakeId: null };
/** A GitHub record, as `github-events.mjs` makes it: `session: "github"`, a stable id, the row or the pull request. */
const gh = (kind, time, extra = {}, subject = { pr: PR }) => ({ id: `gh:a11ign/a11ign#${subject.pr ?? REPO_ROW}:${kind}:${time}`, kind, source: "github", session: "github", at: at(time),
  row: subject.pr ? null : REPO_ROW, pr: subject.pr ?? null, ...base, actor: "worker-9001", ...extra });
const rowEvent = (kind, time, extra = {}) => gh(kind, time, extra, { pr: null });
const review = (id, time, headSha, state = "APPROVED") => gh("reviewed", time, { id: `gh:a11ign/a11ign#${PR}:reviewed:${id}:${headSha}`, state, headSha, actor: "external-reviewer" });
const run = (id, name, started, completed, headSha, conclusion = "success") => gh("ci_run", completed ?? started, {
  id: `gh:a11ign/a11ign#${PR}:ci_run:${id}:${completed ? "completed" : "in_progress"}`, name, status: completed ? "completed" : "in_progress", state: completed ? conclusion : null,
  startedAt: at(started), completedAt: completed ? at(completed) : null, headSha });
const tokens = { input: 10, output: 20, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 };
/** A model turn that ran from `start` to `end`, on the row (or, for a standing seat, on the pull request it was woken about). */
const turn = (session, start, end, costUsd, extra = {}) => ({ id: `turn:${session}:${end}`, kind: "turn", source: "transcript", at: at(end), session, row: REPO_ROW, pr: null, ...base,
  model: costUsd === null ? "mystery-model" : "claude-sonnet-5-5", tokens, costUsd, wallClockMs: at(end) - at(start), ...extra });
const wake = (time, session, causeKey, extra = {}) => ({ id: `wake:${session}:${time}`, kind: "wake", source: "wake-ledger", at: at(time), session, row: null, pr: null, ...base, causeKey, deliveryLagMs: null, ...extra });

/**
 * One ordinary row: filed 10:00, claimed 10:30 by worker-9001, a PR opened 11:20 as a draft, approved 11:30 and marked ready 11:50, pushed again 12:00, reviewed 12:20 and AGAIN 12:25
 * at the same head, queued 12:30, ejected 12:35, queued again 12:40 at the same head, merged 12:50, the row closed 5 s later. Two gaps between phases have no record at all.
 */
const ROW = [
  rowEvent("filed", "10:00:00", { actor: "product-manager" }),
  rowEvent("claimed", "10:30:00", { claimant: "worker-9001", actor: "a11ign-ai-workers" }),
  { id: "deferral:worker-9001:1", kind: "deferral", source: "deferral-log", at: at("10:35:00"), session: "worker-9001", row: REPO_ROW, pr: null, ...base, causeKey: "engineers/ready-row-unclaimed/9001",
    startedAt: at("10:30:00"), completedAt: at("10:35:00"), how: "delivered" },
  wake("10:40:00", "worker-9001", "engineers/ready-row-unclaimed/9001", { row: REPO_ROW, deliveryLagMs: 2 * MINUTE }),
  turn("worker-9001", "10:40:00", "10:40:30", 0.1),
  turn("worker-9001", "10:50:00", "11:10:00", 0.5),
  turn("worker-9001", "11:15:00", "11:19:30", null),
  gh("head_moved", "11:19:00", { headSha: H1, actor: null }),
  gh("opened", "11:20:00"),
  gh("labeled", "11:22:00", { name: "pr:hold" }), gh("unlabeled", "11:24:00", { name: "pr:hold" }),
  run(1, "lint", "11:20:30", "11:28:00", H1), run(2, "test", "11:20:30", "11:27:00", H1),
  review(5001, "11:30:00", H1),
  wake("11:31:00", "orchestrator", "orchestrator/draft-convinced-not-ready/pr-9100/caf5b440", { pr: PR }),
  turn("orchestrator", "11:31:00", "11:32:00", 0.2, { row: null, pr: PR }),
  wake("11:41:00", "orchestrator", "orchestrator/draft-convinced-not-ready/pr-9100/caf5b440", { pr: PR }),
  turn("orchestrator", "11:41:00", "11:42:00", 0.2, { row: null, pr: PR }),
  gh("ready_for_review", "11:50:00"),
  gh("head_moved", "12:00:00", { headSha: H2, actor: null }),
  turn("worker-9001", "12:00:00", "12:01:00", 0.05),
  { id: "compaction:worker-9001:1", kind: "compaction", source: "transcript", at: at("12:02:00"), session: "worker-9001", row: REPO_ROW, pr: null, ...base },
  run(3, "lint", "12:00:30", "12:10:00", H2), run(4, "test", "12:00:30", "12:15:00", H2), run(6, "test", "12:00:33", "12:14:00", H2), run(5, "lint", "12:16:30", "12:17:30", H2),
  review(5002, "12:20:00", H2), review(5003, "12:25:00", H2),
  gh("added_to_merge_queue", "12:30:00", { id: "gh:a11ign/a11ign#9100:added_to_merge_queue:q1" }),
  gh("removed_from_merge_queue", "12:35:00", { outcome: "unmerged" }),
  gh("added_to_merge_queue", "12:40:00", { id: "gh:a11ign/a11ign#9100:added_to_merge_queue:q2" }),
  gh("removed_from_merge_queue", "12:50:00", { outcome: "merged", id: "gh:a11ign/a11ign#9100:removed_from_merge_queue:end" }),
  gh("merged", "12:50:00", { actor: "merge-queue" }), gh("closed", "12:50:00"),
  rowEvent("closed", "12:50:05"),
];

const phaseOf = (wf, name) => wf.phases.find((phase) => phase.phase === name);
const iso = (ms) => new Date(ms).toISOString().slice(11, 19);
const bounds = (phase) => phase.runs.map((one) => `${iso(one.from)}-${iso(one.end)}`);
const waitingMs = (one) => one.wallClockMs - one.workingMs - one.unexplainedMs;

test("PHASES: the eight, in order, each bounded by the records the definition names", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  assert.deepEqual(wf.phases.map((phase) => phase.phase), PHASES);
  assert.deepEqual(bounds(phaseOf(wf, "spec")), ["10:00:00-10:30:00"], "filed -> claimed");
  assert.deepEqual(bounds(phaseOf(wf, "claim")), ["10:30:00-10:40:00"], "claimed -> the claimant's first turn BEGAN (10:40:00, 30 s before it ended)");
  assert.deepEqual(bounds(phaseOf(wf, "build")), ["10:40:00-11:20:00"], "that turn -> the pull request opened");
  assert.deepEqual(bounds(phaseOf(wf, "verify")), ["11:20:00-11:50:00"], "opened -> ready_for_review, though the approval came at 11:30");
  assert.deepEqual(bounds(phaseOf(wf, "review")), ["11:20:00-11:30:00", "12:00:00-12:20:00"], "each push -> the review after it; the ready mark on a head already reviewed starts none");
  assert.deepEqual(bounds(phaseOf(wf, "CI")), ["11:20:00-11:28:00", "12:00:00-12:15:00", "12:16:30-12:17:30"], "each head -> its LAST check-run completing (a head committed before the PR opened starts at the opening), once per wave: lint run again at 12:16:30 is wave 2");
  assert.deepEqual(bounds(phaseOf(wf, "queue")), ["12:30:00-12:50:00"], "the first entry -> merged: the ejection is not an end");
  assert.deepEqual(bounds(phaseOf(wf, "merge")), ["12:50:00-12:50:05"], "merged -> the ROW closed, not the pull request");
  assert.equal(wf.open, false);
  for (const phase of wf.phases) assert.equal(phase.state, "ended", phase.phase);
});

test("WORKING + WAITING + unexplained is the wall-clock of every run, of every phase and of the whole row, exactly", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  for (const phase of [...wf.phases, wf.between]) {
    for (const one of phase.runs) assert.equal(one.workingMs + one.waits.reduce((sum, wait) => sum + wait.ms, 0) + one.unexplainedMs, one.wallClockMs, `${phase.phase} ${one.label}`);
  }
  assert.equal(wf.whole.workingMs + wf.whole.waits.reduce((sum, wait) => sum + wait.ms, 0) + wf.whole.unexplainedMs, wf.whole.wallClockMs);
  assert.equal(wf.whole.wallClockMs, at("12:50:05") - at("10:00:00"));
  const exclusive = [...wf.phases, wf.between].reduce((sum, phase) => sum + phase.exclusiveMs, 0);
  assert.equal(exclusive, wf.whole.wallClockMs, "EXCLUSIVE counts each moment once, so it adds up to the row's wall-clock though the phases overlap");
  assert.ok(wf.phases.reduce((sum, phase) => sum + phase.wallClockMs, 0) > wf.whole.wallClockMs, "and the phases do overlap, which is why the exclusive column exists");
});

test("CLAIM: a deferral span and an order's delivery lag are each named WAITING, and what neither covers is unexplained", () => {
  const claim = phaseOf(waterfall({ events: ROW, now: NOW }), "claim");
  assert.equal(claim.workingMs, 0);
  assert.deepEqual(claim.waits.map((wait) => [wait.source, wait.ms]), [["deferral-log", 5 * MINUTE], ["wake-ledger", 2 * MINUTE]]);
  assert.match(claim.waits[1].label, /1 order to worker-9001 delivered after being typed \(longest 2m00s\)/);
  assert.match(claim.waits[0].label, /order engineers\/ready-row-unclaimed\/9001 deferred for busy worker-9001 \(delivered\)/);
  assert.equal(claim.unexplainedMs, 3 * MINUTE, "10:35:00 to 10:38:00: nothing was recorded");
});

test("BUILD: working is the union of the turns, and the rest of the run is unexplained, not working", () => {
  const build = phaseOf(waterfall({ events: ROW, now: NOW }), "build");
  assert.equal(build.workingMs, 30 * 1000 + 20 * MINUTE + 4.5 * MINUTE, "10:40:00-10:40:30, 10:50:00-11:10:00, 11:15:00-11:19:30");
  assert.equal(build.unexplainedMs, 15 * MINUTE);
  assert.deepEqual(build.waits, []);
});

test("A GAP WITH NO RECORD is unexplained and never WORKING (the acceptance's positive control, with its own contrast)", () => {
  const gap = [rowEvent("filed", "10:00:00"), rowEvent("claimed", "10:30:00", { claimant: "worker-9001" })];
  const unrecorded = phaseOf(waterfall({ events: gap, now: NOW }), "spec");
  assert.equal(unrecorded.unexplainedMs, 30 * MINUTE);
  assert.equal(unrecorded.workingMs, 0, "a waterfall that folded the gap into WORKING would read 30 minutes here, and this assertion is the one that goes RED");
  const worked = phaseOf(waterfall({ events: [...gap, turn("worker-9001", "10:00:00", "10:30:00", 0.1)], now: NOW }), "spec");
  assert.deepEqual([worked.workingMs, worked.unexplainedMs], [30 * MINUTE, 0], "the same gap with a turn in it IS working: the assertion tells the two apart");
  assert.match(renderWaterfall(waterfall({ events: gap, now: NOW }), { title: "#9001", now: NOW }).join("\n"), /spec +ENDED +wall-clock 30m00s .*unexplained 30m00s/);
});

test("WAITING names its source: a hold label, CI running, a review not yet posted, a queue entry, an ejection", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  const verify = phaseOf(wf, "verify");
  const named = (phase, source) => phase.waits.filter((wait) => wait.source === source);
  assert.equal(named(verify, "label")[0].ms, 2 * MINUTE);
  assert.match(named(verify, "label")[0].label, /label pr:hold \(held; put on by worker-9001\)/);
  assert.equal(named(verify, "CI")[0].ms, 5.5 * MINUTE, "the check-runs ran 7m30s and the hold label claimed 2 minutes of it first");
  assert.match(named(verify, "review")[0].label, /review not yet posted \(opened\)/);
  const queue = phaseOf(wf, "queue");
  assert.deepEqual(queue.waits.map((wait) => [wait.source, wait.ms]).sort(), [["merge-queue", 5 * MINUTE], ["merge-queue", 10 * MINUTE], ["merge-queue", 5 * MINUTE]].sort());
  assert.ok(queue.waits.some((wait) => /ejected from the merge queue, awaiting re-entry/.test(wait.label)));
  assert.equal(queue.unexplainedMs, 0);
  for (const wait of wf.phases.flatMap((phase) => phase.waits)) assert.ok(wait.source && wait.label, "every wait carries its source");
});

test("INFERRED: an approved draft waiting to be marked ready is named from the review, the order delivered and the seat's turns, and is marked inferred", () => {
  const verify = phaseOf(waterfall({ events: ROW, now: NOW }), "verify");
  const wait = verify.waits.find((one) => one.source === "approved-draft");
  assert.equal(wait.inferred, true);
  assert.equal(wait.ms, 18 * MINUTE, "11:30:00 to 11:50:00, less the 2 minutes the orchestrator was working in it");
  assert.match(wait.label, /approved draft #9100 not yet marked ready, waiting on orchestrator/);
  assert.equal(wait.evidence.length, 4, "the review, the two orders, and the one session's turn count");
  assert.match(wait.evidence[0], /review 5001 APPROVED by external-reviewer at 2026-10-04 11:30:00 at head 1111111/, "record 1: the review event");
  assert.match(wait.evidence[1], /order orchestrator\/draft-convinced-not-ready\/pr-9100\/caf5b440 delivered to orchestrator at 2026-10-04 11:31:00/, "record 2: the ledger's delivery");
  assert.equal(wait.evidence.at(-1), "orchestrator: 2 turns in the gap", "record 3: the seat's own turns");
  assert.equal(verify.workingMs, 2 * MINUTE, "and those turns are WORKING, not part of the wait");
  assert.deepEqual(verify.waits.filter((one) => one.source !== "approved-draft").map((one) => one.inferred), [false, false, false], "every other wait is a record");
});

test("REPEATS: each of the chairman's five is flagged in the phase it happened in, with its evidence", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  const flagged = (name) => phaseOf(wf, name).repeats;
  assert.deepEqual(flagged("review").map((repeat) => repeat.kind), ["second review at the same head"]);
  assert.match(flagged("review")[0].summary, /review 5003 at head 2222222 after review 5002/);
  assert.deepEqual(flagged("review")[0].evidence.map((line) => line.replace(/ at 2026.*/, "")), ["review 5002 APPROVED by external-reviewer", "review 5003 APPROVED by external-reviewer"], "the two review ids");
  assert.deepEqual(flagged("queue").map((repeat) => repeat.kind), ["re-queue at the same head"]);
  assert.deepEqual(flagged("queue")[0].evidence.map((line) => line.replace(/ at 2026.*/, "")), ["queue entry gh:a11ign/a11ign#9100:added_to_merge_queue:q1", "queue entry gh:a11ign/a11ign#9100:added_to_merge_queue:q2"], "the two entries");
  assert.deepEqual(flagged("verify").map((repeat) => repeat.kind), ["re-wake with the same cause key"]);
  assert.match(flagged("verify")[0].evidence[1], /delivered again 2026-10-04 11:41:00 .* 10m00s later/);
  assert.deepEqual(flagged("CI").map((repeat) => repeat.kind).sort(), ["CI re-run at the same head", "compaction"]);
  const rerun = flagged("CI").find((repeat) => repeat.kind === "CI re-run at the same head");
  assert.equal(rerun.summary, "#9100: 1 check run again at head 2222222 (wave 2: lint)");
  assert.deepEqual(rerun.evidence, ["before: 1 check-runs from 2026-10-04 12:00:30 (lint)", "again: 1 check-runs from 2026-10-04 12:16:30 (lint)"], "only lint ran before; test, and the duplicate trigger of it in wave 1, are not re-runs");
  for (const name of ["spec", "claim", "build", "merge"]) assert.deepEqual(flagged(name), [], `${name}: no repeat happened in it`);
  assert.equal(wf.repeats.length, 5);
});

test("CI WAVES: two triggers of one check are one wave, and a later wave of checks no earlier wave ran is not a re-run (measured on #3406)", () => {
  const duplicate = [run(1, "arm", "11:00:00", "11:00:10", H1), run(2, "arm", "11:00:03", "11:00:12", H1)];
  const only = (events) => waterfall({ events: [gh("opened", "10:59:00"), ...events], now: NOW });
  assert.deepEqual(only(duplicate).repeats, [], "arm twice within one wave, overlapping");
  const fresh = only([...duplicate, run(3, "mutate", "12:00:00", "12:00:20", H1)]);
  assert.deepEqual(bounds(phaseOf(fresh, "CI")), ["10:59:00-11:00:12", "12:00:00-12:00:20"], "two waves, each its own CI run");
  assert.deepEqual(fresh.repeats, [], "mutate had never run at this head: starting it is not running it again");
  const again = only([...duplicate, run(3, "arm", "12:00:00", "12:00:20", H1)]);
  assert.deepEqual(again.repeats.map((repeat) => [repeat.kind, repeat.phase]), [["CI re-run at the same head", "CI"]]);
  const chained = only([run(1, "lint", "11:00:00", "11:00:10", H1), run(2, "test", "11:00:40", "11:01:00", H1)]);
  assert.equal(phaseOf(chained, "CI").runs.length, 1, "a check starting within a minute of the last one finishing is a job that needed it");
});

test("REPEATS are not invented: a second review at ANOTHER head, a re-queue after a push, and a different cause key are no repeats", () => {
  const fresh = ROW.filter((event) => event.id !== `gh:a11ign/a11ign#${PR}:reviewed:5003:${H2}` && !(event.kind === "wake" && event.at === at("11:41:00")))
    .map((event) => (event.id.endsWith(":q2") ? { ...event, at: at("12:40:00") } : event));
  const repeats = waterfall({ events: fresh, now: NOW }).repeats.map((repeat) => repeat.kind);
  assert.deepEqual(repeats.sort(), ["CI re-run at the same head", "compaction", "re-queue at the same head"], "the review and the wake went; the others, which this fixture still has, stay");
  const pushed = [...fresh, gh("head_moved", "12:36:00", { headSha: "3333333ccccccccccccccccccccccccccccccc" }), run(9, "lint", "12:36:30", "12:38:00", "3333333ccccccccccccccccccccccccccccccc")];
  assert.ok(!waterfall({ events: pushed, now: NOW }).repeats.some((repeat) => repeat.kind === "re-queue at the same head"), "a push between the two entries makes it a different head");
});

test("SPEND: dollars are the store's costUsd, a null cost is UNPRICED and not zero, each turn is in one phase, and the phases add up to the row", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  const build = phaseOf(wf, "build").spend;
  assert.deepEqual([build.turns, build.priced, build.unpriced], [3, 2, 1]);
  assert.ok(Math.abs(build.dollars - 0.6) < 1e-9, "0.10 + 0.50, the unpriced turn adds nothing and is counted apart");
  assert.equal(build.tokens, 3 * 1030);
  assert.deepEqual(Object.keys(phaseOf(wf, "verify").spend.bySession), ["orchestrator"]);
  assert.ok(Math.abs(phaseOf(wf, "verify").spend.dollars - 0.4) < 1e-9);
  assert.equal(phaseOf(wf, "CI").spend.turns, 1, "a turn that ended where CI and a review began together is in the LATER phase of the two");
  const all = [...wf.phases, wf.between];
  assert.equal(all.reduce((sum, phase) => sum + phase.spend.turns, 0), wf.spend.turns);
  assert.ok(Math.abs(all.reduce((sum, phase) => sum + phase.spend.dollars, 0) - wf.spend.dollars) < 1e-9);
  assert.deepEqual([wf.spend.priced, wf.spend.unpriced], [5, 1]);
  assert.deepEqual(Object.keys(wf.spend.bySession).sort(), ["orchestrator", "worker-9001"]);
  const text = renderWaterfall(wf, { title: "#9001", now: NOW }).join("\n");
  assert.match(text, />= \$0\.6000 over 2 priced turns, 1 UNPRICED \(not counted as 0\)/);
});

test("BETWEEN: a stretch no phase covers is its own line, classified like a run, and never owned by a phase", () => {
  const wf = waterfall({ events: ROW, now: NOW });
  assert.deepEqual(wf.between.runs.map((one) => [iso(one.from), iso(one.end), one.unexplainedMs]), [["11:50:00", "12:00:00", 10 * MINUTE], ["12:20:00", "12:30:00", 10 * MINUTE]]);
  assert.equal(wf.between.exclusiveMs, 20 * MINUTE);
  assert.match(wf.between.runs[0].label, /after verify, before (review|CI)/);
  assert.equal(BETWEEN, wf.between.phase);
});

test("OPEN: a phase with a start and no end prints open, to the reading, and is never printed as ended", () => {
  const open = ROW.filter((event) => at("11:50:00") > event.at && event.kind !== "closed");
  const wf = waterfall({ events: open, now: NOW });
  const verify = phaseOf(wf, "verify");
  assert.equal(verify.state, "open");
  assert.equal(verify.runs[0].to, null);
  assert.equal(verify.runs[0].end, NOW, "an open run is read up to the reading");
  assert.equal(verify.runs[0].wallClockMs, NOW - at("11:20:00"));
  assert.equal(wf.open, true);
  assert.match(verify.runs[0].note, /still a draft, or opened ready/, "the store does not say whether it began as a draft, and the report says so");
  for (const name of ["queue", "merge"]) assert.deepEqual([phaseOf(wf, name).state, phaseOf(wf, name).why?.startsWith("not reached")], ["not reached", true]);
  const text = renderWaterfall(wf, { title: "#9001", now: NOW }).join("\n");
  assert.match(text, /verify +OPEN/);
  assert.match(text, /11:20:00 -> OPEN \(still running at the reading\)/);
  assert.match(text, /whole row 2026-10-04 10:00:00 -> OPEN/);
  assert.doesNotMatch(text, /verify +ENDED/);
});

test("CUT: a phase that never ended before the row closed ends at the close and says so", () => {
  const closed = [rowEvent("filed", "10:00:00"), rowEvent("claimed", "10:30:00", { claimant: "worker-9001" }), turn("worker-9001", "10:31:00", "10:32:00", 0.1), rowEvent("closed", "10:45:00")];
  const build = phaseOf(waterfall({ events: closed, now: NOW }), "build");
  assert.deepEqual([build.state, bounds(build)], ["cut", ["10:31:00-10:45:00"]]);
  assert.match(renderWaterfall(waterfall({ events: closed, now: NOW }), { title: "#9001", now: NOW }).join("\n"), /\(CUT at the close: no ending record\)/);
});

test("NOT HELD vs NOT REACHED: a phase with no start record says what is missing, and one never begun says that", () => {
  const prOnly = ROW.filter((event) => event.source === "github" && event.pr === PR);
  const wf = waterfall({ events: prOnly, now: NOW });
  assert.deepEqual(wf.phases.slice(0, 3).map((phase) => [phase.phase, phase.state]), [["spec", "not held"], ["claim", "not held"], ["build", "not held"]]);
  assert.match(phaseOf(wf, "spec").why, /no `filed` event of a row/);
  assert.match(phaseOf(wf, "claim").why, /no claim record/);
  assert.equal(phaseOf(wf, "queue").state, "ended", "the pull request's own phases are drawn");
  const noTurn = waterfall({ events: ROW.filter((event) => event.kind !== "turn" || event.session !== "worker-9001"), now: NOW });
  assert.match(phaseOf(noTurn, "build").why, /no turn of worker-9001 on the row at or after its claim is in the store/);
  const empty = renderWaterfall(waterfall({ events: [], now: NOW }), { title: "#1", now: NOW }).join("\n");
  assert.match(empty, /no phase has a record in the store/);
});

test("PRINT: the eight phases in order, each with wall-clock, WORKING, WAITING, unexplained, dollars and tokens", () => {
  const text = renderWaterfall(waterfall({ events: ROW, now: NOW }), { title: "row #9001", now: NOW }).join("\n");
  const order = PHASES.map((name) => text.search(new RegExp(`^  ${name.padEnd(7)} ENDED`, "m")));
  assert.ok(order.every((place, index) => place >= 0 && (index === 0 || place > order[index - 1])), `phases in order: ${order}`);
  assert.match(text, /^WATERFALL row #9001 {2}\(read 2026-10-04 13:30:00Z\)/);
  assert.match(text, /whole row 2026-10-04 10:00:00 -> 2026-10-04 12:50:05: wall-clock 2h50m05s = WORKING \S+ \+ WAITING \S+ \+ unexplained \S+/);
  assert.match(text, /verify +ENDED +wall-clock 30m00s \(exclusive \S+\) = WORKING 2m00s \+ WAITING 28m00s \+ unexplained 0s/);
  assert.match(text, /WAITING +18m00s {2}approved draft #9100 not yet marked ready, waiting on orchestrator {2}\[INFERRED from: review 5001 APPROVED/);
  assert.match(text, /REPEAT second review at the same head: #9100: review 5003 at head 2222222 after review 5002/);
  assert.match(text, /REPEAT re-queue at the same head/);
  assert.match(text, /between +ENDED/);
  assert.match(text, /phases overlap, so their wall-clocks add to more than the row's/);
});

test("DURATION: seconds, minutes and hours", () => {
  assert.deepEqual([0, 400, 4000, 65000, 2 * 3600000 + 15 * 60000 + 8000].map(duration), ["0s", "<1s", "4s", "1m05s", "2h15m08s"], "a wait of under a second is not printed as none");
});
