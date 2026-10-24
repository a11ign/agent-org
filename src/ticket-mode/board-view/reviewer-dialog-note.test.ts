// no-token: none -- pure notes, a queue held in memory, and a pool over fakes with an injected clock; nothing is spawned
//
// A11-221: a reviewer stopped on a dialog the board cannot answer is the run's Needs you note, in a sentence form of its own, and the pull request's review line says it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyQueue } from "../queue.ts";
import { enqueue, type Entry, type Queue } from "../queue/queue-entries-and-outcomes.ts";
import { recordStaleBlock } from "../queue/queue-pull-heads.ts";
import { recordReviewerDialog } from "../queue/queue-reviewer-dialog.ts";
import { finish } from "../queue/queue-transitions.ts";
import type { Ticket } from "../source.ts";
import { type PullRead, pullReviewText, reviewerDialogLine } from "./pull-review-state.ts";
import { runStatus } from "./pull-status-and-notes.ts";
import { isReviewerDialogNote, reviewerDialogNote } from "./reviewer-dialog-note.ts";
import { reasonOf } from "./run-reason.ts";
import { isStaleBlockNote } from "./stale-block.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const PR = "https://github.com/a11ign/control/pull/132";
const OTHER = "https://github.com/a11ign/agent-org/pull/9";
const PRS = [{ repo: "control", url: PR }];
const DIALOG = "Trust this folder? Codex can read, edit, and run files here. Trusting will apply to the repository root: /srv/stranger";
const NOTE = `the reviewer of a11ign/control #132 stopped on a dialog it cannot answer: "${DIALOG}": a person answers it in herdr`;
const read = (over: Partial<PullRead> = {}): PullRead => ({ head: "abcd1234ef56", settled: true, reviewing: true, verdict: null, earlier: null, refusal: null, unposted: null, ...over });
const run = (over: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "A11-203" }, phase: "finished", outcome: { kind: "reviewed", prs: PRS }, ...over });

test("A11-221: the note names each pull request whose reviewer is stopped, with the dialog's first line, and is null when none is", () => {
  assert.equal(reviewerDialogNote(run(), new Map([[PR, read({ dialog: DIALOG })]])), NOTE);
  assert.equal(reviewerDialogNote(run(), new Map([[PR, read()]])), null, "a look that finds no dialog");
  assert.equal(reviewerDialogNote(run(), new Map()), null, "a pull request not read");
  const two = run({ outcome: { kind: "reviewed", prs: [...PRS, { repo: "agent-org", url: OTHER }] } });
  assert.equal(reviewerDialogNote(two, new Map([[PR, read({ dialog: DIALOG })], [OTHER, read({ dialog: "Update available!" })]])),
    `${NOTE}; the reviewer of a11ign/agent-org #9 stopped on a dialog it cannot answer: "Update available!": a person answers it in herdr`);
  assert.equal(reviewerDialogNote(run({ pullStates: { [PR]: "merged" } }), new Map([[PR, read({ dialog: DIALOG })]])), null, "a merged pull request has no reviewer to wait on");
});

test("A11-221: the board recognises its own note by its form, and no other hand-back", () => {
  assert.equal(isReviewerDialogNote(NOTE), true);
  assert.equal(isReviewerDialogNote("a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides"), false);
  assert.equal(isReviewerDialogNote(undefined), false);
  assert.equal(isStaleBlockNote(NOTE), false, "and the stale block does not claim it");
});

test("A11-221: the pull request's review line says the reviewer is stopped, ahead of 'reviewing', and a look with no dialog reads as before", () => {
  assert.equal(pullReviewText(read({ dialog: DIALOG })), `the reviewer stopped on a dialog it cannot answer: "${DIALOG}"`);
  assert.equal(pullReviewText(read({ dialog: DIALOG })), reviewerDialogLine(DIALOG));
  assert.equal(pullReviewText(read()), "reviewing");
});

/** A queue of one finished run. */
const finishedQueue = (outcome: Entry["outcome"] = { kind: "reviewed", prs: PRS }): Queue => {
  const queue = enqueue(emptyQueue(1), [{ key: "A11-203", title: "t", description: "", url: "u", branch: "b", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 } as Ticket], { model: "sonnet", effort: "high" }, 0);
  return finish(queue, "A11-203", outcome!, 100);
};
const handedBackOf = (queue: Queue): string | undefined => queue.entries[0].handedBack;

test("A11-221: the note becomes the run's handedBack and reads Needs you; a null note clears it and no other hand-back, and it writes over none", () => {
  const flagged = recordReviewerDialog(finishedQueue(), "A11-203", NOTE);
  assert.equal(handedBackOf(flagged), NOTE);
  assert.equal(runStatus(flagged.entries[0] as ViewEntry), "needs-you");
  assert.equal(reasonOf(flagged.entries[0] as ViewEntry).line, NOTE, "the card quotes the dialog's first line");
  assert.equal(handedBackOf(recordReviewerDialog(flagged, "A11-203", null)), undefined, "the next look that finds no dialog clears it");
  const capped = { ...finishedQueue(), entries: [{ ...finishedQueue().entries[0], handedBack: "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped." }] } as Queue;
  assert.equal(handedBackOf(recordReviewerDialog(capped, "A11-203", null)), capped.entries[0].handedBack, "another hand-back is left alone when the dialog goes");
  assert.equal(handedBackOf(recordReviewerDialog(capped, "A11-203", NOTE)), capped.entries[0].handedBack, "and is not written over");
  assert.equal(handedBackOf(recordStaleBlock(flagged, "A11-203", null)), NOTE, "the stale block's clear leaves this note");
});

test("A11-221: a run that reads Needs you for its own reason, or has failed or concluded, is not flagged", () => {
  assert.equal(handedBackOf(recordReviewerDialog(finishedQueue({ kind: "needs-human", reason: "which of the two?" }), "A11-203", NOTE)), undefined, "the worker's question is the card's line");
  for (const outcome of [{ kind: "crashed", reason: "the pool restarted" }, { kind: "checked", reason: "nothing to change" }] as const) {
    assert.equal(handedBackOf(recordReviewerDialog(finishedQueue(outcome), "A11-203", NOTE)), undefined, outcome.kind);
  }
});
