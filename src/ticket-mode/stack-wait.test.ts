// no-token: none -- the stacked pull request's wait note, the base's note, and the queue's start order, in memory
// A11-370: #1984 (A11-366) sat on #1982 (A11-363) with no checks and no reviewer, and its card said nothing of why. A stacked pull request says what it waits on, its base says what is stacked on it, and a run with a stack above it starts first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stackedOnItNote, stackWaitNote } from "./board-view/stack-wait.ts";
import type { PullHead, ViewEntry } from "./board-view/view-types-and-filters.ts";
import { nextStarts } from "./queue.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import { noteOf } from "../../ui/src/runs/runs-model.ts";

const REPO = "agent-org";
const BASE_URL = "https://github.com/a11ign/agent-org/pull/1982";
const MEMBER_URL = "https://github.com/a11ign/agent-org/pull/1984";

const run = (fields: Partial<ViewEntry> & { ticket: { key: string } }): ViewEntry => ({ phase: "finished", ...fields }) as ViewEntry;
const reviewed = (url: string) => ({ kind: "reviewed", prs: [{ url, repo: REPO }] }) as ViewEntry["outcome"];
const stackOn = (key: string) => ({ key, repo: REPO, branch: `${key.toLowerCase()}-branch`, sha: "a".repeat(40) });

/** #1982, the base: finished, one open pull request, read as `head` says. */
const base = (head?: PullHead, over: Partial<ViewEntry> = {}) => run({ ticket: { key: "A11-363" }, outcome: reviewed(BASE_URL), pullHeads: head === undefined ? undefined : { [BASE_URL]: head }, ...over });
/** #1984, stacked on A11-363. */
const member = (over: Partial<ViewEntry> = {}) => run({ ticket: { key: "A11-366" }, outcome: reviewed(MEMBER_URL), stackBase: stackOn("A11-363"), ...over });

test("a stacked pull request's card reads 'waits on #<base> (<state of the base>)', with the state the base's pull request is read in", () => {
  const states: [PullHead | undefined, string][] = [
    [{ head: "h", approved: false, conflict: { base: "main" }, review: "changes-requested" }, "conflicting"],
    [{ head: "h", approved: false, review: "changes-requested" }, "changes requested"],
    [{ head: "h", approved: false, review: "none", red: ["suite"] }, "checks failing"],
    [{ head: "h", approved: false, review: "none", pending: ["suite"] }, "checks running"],
    [{ head: "h", approved: true, review: "approved" }, "approved"],
    [{ head: "h", approved: false, review: "none" }, "awaiting review"],
    [undefined, "awaiting review"],
  ];
  for (const [head, state] of states) {
    const entries = [base(head), member()];
    assert.equal(stackWaitNote(entries[1], entries), `waits on #1982 (${state})`);
  }
});

test("a base whose run is at work says so, whatever its pull request was last read as", () => {
  const read: PullHead = { head: "h", approved: false, review: "changes-requested" };
  assert.equal(stackWaitNote(member(), [base(read, { phase: "running" }), member()]), "waits on #1982 (being worked on)");
  assert.equal(stackWaitNote(member(), [base(read, { phase: "queued" }), member()]), "waits on #1982 (queued for a round)");
});

test("the card says nothing of a wait once the base has merged, when the member has no open pull request, or when it is stacked on nothing", () => {
  const merged = base({ head: "h", approved: true }, { pullStates: { [BASE_URL]: "merged" } });
  assert.equal(stackWaitNote(member(), [merged, member()]), null, "the base merged: the board moves the member to main");
  assert.equal(stackWaitNote(member({ pullStates: { [MEMBER_URL]: "merged" } }), [base(), member()]), null, "the member's own pull request is merged");
  const { stackBase: _gone, ...unstacked } = member();
  assert.equal(stackWaitNote(unstacked as ViewEntry, [base(), unstacked as ViewEntry]), null);
  assert.equal(stackWaitNote(member(), [member()]), null, "the base is not on the queue");
  assert.equal(stackWaitNote(member(), [base(undefined, { pullStates: { [BASE_URL]: "closed" } }), member()]), "waits on #1982 (closed without merging)", "a base closed unmerged strands the member, and the card says so");
  assert.equal(stackWaitNote(member({ stackBase: { ...stackOn("A11-363"), repo: "other" } }), [base(), member()]), null, "the base has no pull request in the member's repository");
});

test("the base's card names the pull requests stacked on it, and says nothing when none is", () => {
  const entries = [base(), member()];
  assert.equal(stackedOnItNote(entries[0], entries), "#1984 (A11-366) is stacked on it");
  const second = run({ ticket: { key: "A11-380" }, outcome: reviewed("https://github.com/a11ign/agent-org/pull/1990"), stackBase: stackOn("A11-363") });
  assert.equal(stackedOnItNote(entries[0], [...entries, second]), "#1984 (A11-366), #1990 (A11-380) are stacked on it");
  assert.equal(stackedOnItNote(entries[1], entries), null, "the member has nothing stacked on it");
  assert.equal(stackedOnItNote(base(undefined, { pullStates: { [BASE_URL]: "merged" } }), entries), null, "a merged base has no open pull request to be stacked on");
});

test("both notes reach the run's card, in the note the runs page draws", () => {
  const entries = [base({ head: "h", approved: false, conflict: { base: "main" } }), member()];
  const context = { queue: { entries, pulls: {} }, publisher: undefined, now: 0 } as unknown as Parameters<typeof noteOf>[1];
  assert.match(noteOf(entries[1] as never, context) ?? "", /waits on #1982 \(conflicting\)/);
  assert.match(noteOf(entries[0] as never, context) ?? "", /#1984 \(A11-366\) is stacked on it/);
});

const queued = (key: string, over: Partial<Entry> = {}): Entry => ({ ticket: { key }, phase: "queued", model: "opus", repos: [], ...over }) as unknown as Entry;
const queueOf = (entries: Entry[], max = 1): Queue => ({ entries, max, paused: false });
const startOrder = (entries: Entry[], max: number) => nextStarts(queueOf(entries, max), 0, 14).map((entry) => entry.ticket.key);

test("a queued run with a pull request stacked on it starts before the other queued runs of its model", () => {
  const first = queued("A11-1");
  const below = queued("A11-2", { outcome: reviewed("https://github.com/a11ign/agent-org/pull/20") as never });
  const above = run({ ticket: { key: "A11-3" }, outcome: reviewed("https://github.com/a11ign/agent-org/pull/21"), stackBase: stackOn("A11-2") }) as unknown as Entry;
  assert.deepEqual(startOrder([first, below, above], 1), ["A11-2"], "the run with a stack above it takes the only slot");
  assert.deepEqual(startOrder([first, below, above], 2), ["A11-1", "A11-2"], "with room for both, they are returned in queue order");
});

test("the priority is among runs of one model: a run of another model keeps its place", () => {
  const sonnet = queued("A11-1", { model: "sonnet" });
  const below = queued("A11-2", { outcome: reviewed("https://github.com/a11ign/agent-org/pull/20") as never });
  const above = run({ ticket: { key: "A11-3" }, outcome: reviewed("https://github.com/a11ign/agent-org/pull/21"), stackBase: stackOn("A11-2") }) as unknown as Entry;
  assert.deepEqual(startOrder([sonnet, below, above], 1), ["A11-1"], "the sonnet run is first in the queue, and the stack's priority does not pass it");
  assert.deepEqual(startOrder([sonnet, below, above], 2), ["A11-1", "A11-2"]);
});

test("a promoted run is returned in queue order, so a batch is still started under its first member", () => {
  const a = queued("A11-1", { batch: "b1" });
  const b = queued("A11-2", { batch: "b1", outcome: reviewed("https://github.com/a11ign/agent-org/pull/20") as never });
  const above = run({ ticket: { key: "A11-3" }, outcome: reviewed("https://github.com/a11ign/agent-org/pull/21"), stackBase: stackOn("A11-2") }) as unknown as Entry;
  assert.deepEqual(startOrder([a, b, above], 2), ["A11-1", "A11-2"], "the batch's lead is the first in the queue, not the member the stack promoted");
});

test("a queue with no stack starts in queue order, and a run stacked on by a settled run is not promoted", () => {
  const entries = [queued("A11-1"), queued("A11-2"), queued("A11-3")];
  assert.deepEqual(startOrder(entries, 2), ["A11-1", "A11-2"]);
  const merged = run({ ticket: { key: "A11-9" }, outcome: reviewed("https://github.com/a11ign/agent-org/pull/21"), stackBase: stackOn("A11-3"), pullStates: { "https://github.com/a11ign/agent-org/pull/21": "merged" } }) as unknown as Entry;
  assert.deepEqual(startOrder([...entries, merged], 1), ["A11-1"], "a member that merged waits on nothing");
});
