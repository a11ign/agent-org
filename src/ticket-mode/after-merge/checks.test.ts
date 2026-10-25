// no-token: none -- pure functions over records in memory
// A11-277: After-merge checks are records of their own, with a runner, closed with evidence
import { test } from "node:test";
import assert from "node:assert/strict";
import { ageOf, claimPost, CLOSED_KEPT_MS, closeCheck, closeComment, decideFollowUp, emptyChecks, EVIDENCE_CHARS, followUpText, listedIds, markUnpostable, pruneChecks, releasePost, roleOf, runnerOf, seedChecks, type ChecksFile } from "./checks.ts";

const DAY = 24 * 60 * 60 * 1000;
const run = (key: string, lines: readonly string[], finishedAt?: number) => ({
  ticket: { key, url: `https://linear.app/a11ign/issue/${key}` }, ...(finishedAt === undefined ? {} : { finishedAt }), afterMerge: lines.map((line) => ({ line, owner: null })),
});

/** The file once `id` is closed, which must succeed. */
function closed(file: ChecksFile, id: string, result: "passed" | "failed" | "superseded" = "passed", at = 5_000): ChecksFile {
  const answer = closeCheck(file, id, { result, evidence: "the board showed it", by: "person" }, at);
  assert.ok(answer.ok, `${id} closes`);
  return answer.file;
}

test("A11-277: each owner runs as the session, the person or (for a named role) the session for that role", () => {
  assert.equal(runnerOf("Chairman session"), "session");
  assert.equal(runnerOf("The chairman's session"), "session");
  assert.equal(runnerOf("On the agents host"), "session", "a host is the session's");
  assert.equal(runnerOf("The chairman"), "person");
  assert.equal(runnerOf("the person"), "person");
  assert.equal(runnerOf("The release manager"), "session", "a named role goes to the session, which passes it on");
  assert.equal(runnerOf(null), "session", "a line with no owner too");
  assert.equal(roleOf("The release manager"), "The release manager");
  assert.deepEqual([roleOf("Chairman session"), roleOf("On the agents host"), roleOf("The chairman"), roleOf(null)], [null, null, null, null], "only a role other than a session, a host or the person is run for");
});

test("A11-277: a run's listed lines are copied once, each with its owner read again from the line and its run's finish as when it was listed", () => {
  const runs = [run("A11-178", ["Chairman session: the next partial step goes back to In Progress.", "a line with no owner"], 1_000), run("A11-233", ["The chairman chooses the name."])];
  const seeded = seedChecks(emptyChecks(), runs, 9_000);
  assert.deepEqual(Object.keys(seeded.checks), ["A11-178#1", "A11-178#2", "A11-233#1"]);
  assert.deepEqual(seeded.checks["A11-178#1"], {
    id: "A11-178#1", key: "A11-178", url: "https://linear.app/a11ign/issue/A11-178", line: "Chairman session: the next partial step goes back to In Progress.", owner: "Chairman session", runner: "session",
    listedAt: 1_000, state: "open",
  }, "the owner the run recorded (null, from the old reader) is read again");
  assert.equal(seeded.checks["A11-233#1"].listedAt, 9_000, "a run with no finish is listed at the sweep");
  assert.equal(seeded.checks["A11-233#1"].runner, "person");
  assert.equal(seeded.checks["A11-178#2"].owner, null);
  assert.equal(seedChecks(seeded, runs, 10_000), seeded, "seeding again changes nothing");
  const passed = closed(seeded, "A11-178#1");
  assert.equal(seedChecks(passed, runs, 10_000).checks["A11-178#1"].state, "passed", "a closed check is never copied again");
});

test("A11-277: a person closes a check with one line of evidence, and a second close is refused, naming how it closed", () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-179", ["Chairman session: no run reads Ready to merge."])], 1_000);
  const answer = closeCheck(seeded, "A11-179#1", { result: "failed", evidence: "  A11-174 read Ready to merge while red  ", by: "person" }, 2_000);
  assert.ok(answer.ok);
  assert.deepEqual(answer.check, { ...seeded.checks["A11-179#1"], state: "failed", result: "A11-174 read Ready to merge while red", closedBy: "person", closedAt: 2_000 });
  assert.deepEqual(closeCheck(answer.file, "A11-179#1", { result: "passed", evidence: "ok", by: "session" }, 3_000),
    { ok: false, status: 409, error: "A11-179#1 is already failed, closed by a person: A11-174 read Ready to merge while red" });
  assert.deepEqual(closeCheck(seeded, "A11-179#2", { result: "passed", evidence: "ok", by: "person" }, 3_000), { ok: false, status: 404, error: "no After-merge check A11-179#2" });
});

test("A11-277: evidence is one line of 1 to 300 characters", () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-1", ["Chairman session: a check."])], 1_000);
  const close = (evidence: string) => closeCheck(seeded, "A11-1#1", { result: "passed", evidence, by: "person" }, 2_000);
  assert.deepEqual(close("   "), { ok: false, status: 400, error: "evidence must say, in one line, what was seen" });
  assert.deepEqual(close("one\ntwo"), { ok: false, status: 400, error: "evidence must be one line" });
  assert.deepEqual(close("x".repeat(EVIDENCE_CHARS + 1)), { ok: false, status: 400, error: "evidence must be at most 300 characters" });
  assert.equal(close("x".repeat(EVIDENCE_CHARS)).ok, true);
});

test("A11-277: a failed check's follow-up text is pre-filled from the check, and is decided once", () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-235", ["Chairman session: the next major arrives as a ticket."])], 1_000);
  const failed = closed(seeded, "A11-235#1", "failed");
  assert.equal(followUpText(failed.checks["A11-235#1"]), [
    "Follow-up to A11-235: its after-merge check failed.", "", "The check: Chairman session: the next major arrives as a ticket.", "What was seen: the board showed it", "", "Related: A11-235.",
  ].join("\n"));
  const decided = decideFollowUp(failed, "A11-235#1", "w-17");
  assert.ok(decided.ok);
  assert.equal(decided.check.followUp, "w-17");
  assert.deepEqual(decideFollowUp(decided.file, "A11-235#1", null), { ok: false, status: 409, error: "A11-235#1's follow-up is decided already: writer request w-17" });
  assert.deepEqual(decideFollowUp(seeded, "A11-235#1", null), { ok: false, status: 409, error: "A11-235#1 is open, and only a failed check has a follow-up" });
});

test("A11-277: the close is posted from fixed words, the evidence (or the reason) and who closed it", () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-202", ["Chairman session: the board at / is Atomaut."])], 1_000);
  const superseded = closeCheck(seeded, "A11-202#1", { result: "superseded", evidence: "the route this checked was replaced by A11-217's", by: "session" }, 2_000);
  assert.ok(superseded.ok);
  assert.equal(closeComment(superseded.check), [
    "After-merge check superseded: Chairman session: the board at / is Atomaut.", "Reason: the route this checked was replaced by A11-217's", "Closed by the person's session on the ticket board.",
  ].join("\n"));
  assert.equal(closeComment(closed(seeded, "A11-202#1").checks["A11-202#1"]).split("\n")[1], "Evidence: the board showed it");
});

test("A11-277: a closed check is kept 30 days once no run lists it, and an open one is never pruned", () => {
  const runs = [run("A11-1", ["Chairman session: one.", "Chairman session: two."])];
  const file = closed(seedChecks(emptyChecks(), runs, 0), "A11-1#1", "passed", 1_000);
  const later = 1_000 + CLOSED_KEPT_MS + 1;
  assert.equal(pruneChecks(file, 1_000 + CLOSED_KEPT_MS, new Set()), file, "kept for 30 days");
  assert.equal(pruneChecks(file, later, listedIds(runs)), file, "kept while its run still lists it, so it is not copied again, open");
  assert.deepEqual(Object.keys(pruneChecks(file, later, new Set()).checks), ["A11-1#2"], "then dropped; the open check stays");
});

test("A11-277: a row's age is in its largest whole unit", () => {
  assert.equal(ageOf(0, 12 * 60_000), "12 min");
  assert.equal(ageOf(0, 5 * 60 * 60_000 + 59 * 60_000), "5 h");
  assert.equal(ageOf(0, 3 * DAY + 1), "3 d");
  assert.equal(ageOf(10, 0), "0 min", "a clock behind the listing reads no age");
});

test("A11-277: a post is claimed only while the close is still to be posted", () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-1", ["Chairman session: a check."])], 1_000);
  assert.equal(claimPost(seeded, "A11-1#1"), seeded, "an open check is not posted");
  const done = closed(seeded, "A11-1#1");
  const claimed = claimPost(done, "A11-1#1");
  assert.equal(claimed.checks["A11-1#1"].posted, true);
  assert.equal(claimPost(claimed, "A11-1#1"), claimed, "a claimed post is not claimed twice");
  assert.equal(releasePost(claimed, "A11-1#1").checks["A11-1#1"].posted, undefined, "a released post is to be posted again");
  assert.equal(markUnpostable(done, "A11-1#1").checks["A11-1#1"].posted, false);
});

test("A11-277: a ticket run again and merged after its check was closed lists its line again, once the old close is posted", () => {
  const first = run("A11-145", ["Chairman session: the laptop run shows 3 of 3."], 1_000);
  const done = closed(seedChecks(emptyChecks(), [first], 1_000), "A11-145#1", "passed", 2_000);
  const again = run("A11-145", ["Chairman session: the laptop run shows 3 of 3."], 3_000);
  assert.equal(seedChecks(done, [again], 4_000), done, "not while the old close is still to be posted");
  const posted = claimPost(done, "A11-145#1");
  assert.deepEqual([seedChecks(posted, [again], 4_000).checks["A11-145#1"].state, seedChecks(posted, [again], 4_000).checks["A11-145#1"].listedAt], ["open", 3_000]);
  assert.equal(seedChecks(posted, [first], 4_000), posted, "the run that listed it before does not list it again");
});
