// no-token: none -- every read and write goes through the fake code host's world (lab#81 and its seat in the merge queue); nothing here reaches GitHub
//
// A11-160 (step 5): `runArmPr` is driven on the fake code host. Its WRITES change a seat that the next read reports: the disarm clears the auto-merge request, and the dequeue takes the PR out of the queue. A write
// that does not change the seat (`disableIgnored`) is how the test shows the outcome is read back, not the exit code. (The arguments those writes send, and the command a person runs to dequeue by hand, are the GitHub plugin's:
// `plugins/github/rows/arming.test.ts`.)

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
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { runArmPr, EXIT } from "../arm-pr.ts";
import { crossRepoRedMarker } from "../cross-repo-red.ts";
import { forgetActivation } from "../plugins/active.ts";
import { BODY, DECLARED_BODY, FILES, LAB, labWorld } from "./cross-repo-red-world.test.support.ts";

afterEach(() => forgetActivation());

type Seat = { armed: boolean; queued: boolean; merged: boolean };
type Options = { disableIgnored?: boolean; dequeueRefused?: boolean; body?: string; seeded?: string[]; mergesBeforeTheDisarmReads?: boolean };

function drive(seat: Seat, { disableIgnored = false, dequeueRefused = false, body = BODY, seeded = [], mergesBeforeTheDisarmReads = false }: Options = {}) {
  // `runArmPr` reads the PR as OPEN, then the disarm reads its seat: a merge landing between them is the third state, so `merged` is flipped when the seat is first read.
  const { host, world, pull } = labWorld({ body, comments: seeded, seat: mergesBeforeTheDisarmReads ? { ...seat, merged: false } : seat });
  const rows = host.rows!;
  const disableWrites: string[] = [];
  const readSeat = rows.readDisarmSeat;
  const disable = rows.disableAutoMergeOf;
  rows.readDisarmSeat = (request) => { if (mergesBeforeTheDisarmReads) pull.merged = true; return readSeat(request); };
  rows.disableAutoMergeOf = (request) => { disableWrites.push(request.number); if (!disableIgnored) disable(request); };
  if (dequeueRefused) world.queue.dequeueRefusal = "the dequeue was refused: the pull request is not in the queue";
  else world.queue.onDequeue = () => { world.queue.entries = []; };
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=81", `--repo=${LAB}`], env: {}, sleep: () => "ok" as const,
    log: (line: string) => said.push(line), error: (line: string) => said.push(line), lanes: { lanes: [] } });
  const queued = () => !(world.queue.entries instanceof Error) && world.queue.entries.some((entry) => entry.pull === 81);
  const comments = pull.comments.slice(seeded.length);
  // The first line of the refusal comment after its marker: the line that says whether the PR is disarmed.
  const lead = comments.length ? comments[0].split("\n")[1] : null;
  return { code, said: said.join("\n"), armed: pull.armed, queued: queued(), disableWrites, dequeues: world.queue.dequeued, armCalls: world.calls.filter((c) => c.startsWith("armPullAuto ")), comments, allComments: pull.comments, lead };
}

test("#1278 (1) a red leg with auto-merge enabled and NOT queued is disarmed: read back unarmed, exit DONE, the comment's first line says disarmed", () => {
  const out = drive({ armed: true, queued: false, merged: false });
  assert.equal(out.disableWrites.length, 1, "the disarm is sent once");
  assert.equal(out.dequeues.length, 0, "a PR that is not queued is not dequeued");
  assert.equal(out.armed, false, "the state, read back, says auto-merge is off");
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.armCalls.length, 0, "a refused PR is not armed");
  assert.equal(out.lead, "**Disarmed: yes (disarmed).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: disarmed #81 -- disarmed/);
});

test("#1278 (2) a red leg IN THE MERGE QUEUE is dequeued through `dequeuePullRequestOf`, read back out of the queue and unarmed: reported `already in the queue`", () => {
  const out = drive({ armed: true, queued: true, merged: false });
  assert.equal(out.dequeues.length, 1, "the queued PR is dequeued once");
  assert.equal(out.queued, false, "read back: no longer in the queue");
  assert.equal(out.armed, false, "read back: auto-merge off");
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.lead, "**Disarmed: yes (already in the queue).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: disarmed #81 -- already in the queue/);
});

test("#1278 (3) a red leg ALREADY MERGED is not disarmed and no write is sent: reported `already merged`, exit DONE", () => {
  const out = drive({ armed: true, queued: false, merged: false }, { mergesBeforeTheDisarmReads: true });
  assert.equal(out.disableWrites.length, 0, "a merged PR has nothing to disarm, so no write is sent");
  assert.equal(out.dequeues.length, 0);
  assert.equal(out.code, EXIT.DONE, out.said);
  assert.equal(out.lead, "**Disarmed: no (already merged).**", out.comments.join("\n---\n"));
  assert.match(out.said, /arm-pr: NOT disarmed #81 -- already merged/);
});

test("#1278 (4) a queued red leg whose dequeue is REFUSED: the comment says queued and names the command, and the exit is CANNOT_ASK", () => {
  const out = drive({ armed: true, queued: true, merged: false }, { dequeueRefused: true });
  assert.equal(out.dequeues.length, 1);
  assert.equal(out.queued, true, "read back: still in the queue");
  assert.equal(out.code, EXIT.CANNOT_ASK, out.said);
  const lead = out.lead ?? "";
  assert.ok(lead.startsWith("**Disarmed: no (queued, and the dequeue failed (the dequeue was refused: the pull request is not in the queue)"), lead);
  assert.ok(lead.includes("to take it out of the queue run: fake: dequeue PR_fake_81 by hand"), "the command the code host gives for this pull request's node id, said to the person");
});

test("#1278 (5) the OUTCOME IS READ BACK, not the exit code: a disarm that exits 0 and leaves auto-merge on is `NOT disarmed`, exit CANNOT_ASK", () => {
  const out = drive({ armed: true, queued: false, merged: false }, { disableIgnored: true });
  assert.equal(out.disableWrites.length, 1, "the write was sent and its exit (0) was not trusted");
  assert.equal(out.armed, true, "read back: auto-merge still on");
  assert.equal(out.code, EXIT.CANNOT_ASK, out.said);
  assert.equal(out.lead, "**Disarmed: no (auto-merge is still enabled after `gh pr merge --disable-auto`).**", out.comments.join("\n---\n"));
});

test("#1278 (6) the disarm runs on a cross-repo-red verdict ONLY: a declared PR that arms sends no disarm", () => {
  const out = drive({ armed: false, queued: false, merged: false }, { body: DECLARED_BODY });
  assert.equal(out.disableWrites.length, 0, out.said);
  assert.equal(out.comments.length, 0, "an armed PR gets no refusal comment");
  assert.equal(out.armCalls.length, 1, "the declared PR arms, so it is armed as usual");
});

// The refusal made before this change: its marker comment says "Not armed" and nothing about the disarm.
const BEFORE_THIS_CHANGE = `${crossRepoRedMarker(FILES)}\n**Not armed: a red leg.** Nothing about the disarm.`;

test("#1278 (7) a PR already refused BEFORE this change (its marker, no disarm line) is disarmed, and the disarm's outcome is posted on a new comment", () => {
  const out = drive({ armed: true, queued: false, merged: false }, { seeded: [BEFORE_THIS_CHANGE] });
  assert.equal(out.armed, false, "the state, read back, says auto-merge is off");
  assert.equal(out.allComments.length, 2, "the old comment stands, and the outcome is posted beside it");
  assert.equal(out.allComments[1].split("\n")[1], "**Disarmed: yes (disarmed).**", out.allComments[1]);
  assert.equal(out.code, EXIT.DONE, out.said);
});

test("#1278 (8) a refusal whose outcome is already on the PR (same marker AND same lead) posts nothing more, on a repeat tick", () => {
  const out = drive({ armed: true, queued: false, merged: false }, { seeded: [`${crossRepoRedMarker(FILES)}\n**Disarmed: yes (disarmed).**\n**Not armed: a red leg.**`] });
  assert.equal(out.allComments.length, 1, "the seeded comment already says this outcome, so nothing is posted");
  assert.equal(out.code, EXIT.DONE, out.said);
});
