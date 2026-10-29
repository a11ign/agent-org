// no-token: gh -- A11-374: overlap means stack, not wait; the hold knows a run's files without a plan, and a stack is started on the run it overlaps
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePullUrl } from "../plugins/fakes/code-host.ts";
import { overlapWait } from "./board-view/overlap-hold.ts";
import { overlapStackOf } from "./board-view/overlap-stack.ts";
import { stackNote, stackedOn, waitNote } from "./board-view/pull-status-and-notes.ts";
import { keysWithStackAbove, stackedOnItNote } from "./board-view/stack-wait.ts";
import { waitsOn } from "./board-view/pull-status-and-notes.ts";
import { nextStarts } from "./queue.ts";
import { dropSettledOverlapStacks } from "./queue/queue-overlap-stack.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import { regionClaimsOf } from "./region-claims.ts";
import { briefText } from "./worker-files.ts";
import type { Ticket } from "./source.ts";

const REPO = "agent-org";
const SLUG = `a11ign/${REPO}`;
const pullOf = (number: number): string => fakePullUrl(SLUG, number);

/** A run on the queue: queued, for the project's repository, unless `over` says more. */
function run(key: string, over: Record<string, unknown> = {}): Entry {
  return ({ ticket: { key, title: key, description: "", url: `https://linear.app/a11ign/issue/${key}`, branch: `admin/${key.toLowerCase()}` }, repos: [], model: "opus", effort: "high", phase: "queued", queuedAt: 1,
    projectRepo: REPO, ...over }) as unknown as Entry;
}

/** A finished run with one open pull request, which changes `files`. */
const finishedWith = (key: string, number: number, files: readonly string[], over: Record<string, unknown> = {}): Entry =>
  run(key, { phase: "finished", finishedAt: 5, outcome: { kind: "ready-pr", prs: [{ repo: REPO, url: pullOf(number) }] }, pullStates: { [pullOf(number)]: "open" }, pullFiles: { [pullOf(number)]: files }, ...over });

/** A queued run that has an open pull request of its own, which changes `files`: a later step of a plan, or a requeued run. */
const queuedWith = (key: string, number: number, files: readonly string[], over: Record<string, unknown> = {}): Entry =>
  run(key, { opened: [{ repo: REPO, url: pullOf(number) }], pullStates: { [pullOf(number)]: "open" }, pullFiles: { [pullOf(number)]: files }, ...over });

const queueOf = (...entries: Entry[]): Queue => ({ entries, max: 6, paused: false }) as unknown as Queue;

const startedKeys = (queue: Queue): string[] => nextStarts(queue, 0, 14).map((entry) => entry.ticket.key);

test("A11-374: two queued tickets with no plan paths whose open pull requests share a file: the second starts stacked on the first, and its pull request's base is the first's branch", () => {
  const first = finishedWith("A11-1", 11, ["src/ticket-mode/queue.ts", "src/other.ts"]);
  const second = queuedWith("A11-2", 12, ["src/ticket-mode/queue.ts"], { paths: [] });
  const queue = queueOf(first, second);
  const [started, ...rest] = nextStarts(queue, 0, 14);
  assert.deepEqual([started.ticket.key, rest.length], ["A11-2", 0], "the second starts at once, and the first is already worked");
  assert.deepEqual(started.overlapStack, { key: "A11-1", repo: REPO, branch: "admin/a11-1", head: null, url: pullOf(11), shared: "src/ticket-mode/queue.ts", others: [] });
  const stacked = { ...started, phase: "starting" as const };
  assert.deepEqual(stackedOn(stacked, [first, stacked]).map(({ key, branch, url }) => [key, branch, url]), [["A11-1", "admin/a11-1", pullOf(11)]], "stackedOn gives the first's branch");
  assert.deepEqual(waitsOn(stacked, [first, stacked]), [], "and it waits for nothing");
  const text = briefText({ ticket: { ...stacked.ticket, status: "", statusOrder: 0, team: "A11", project: null, priority: 0, parent: null } as Ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { [REPO]: "/work/agent-org" },
    worktreeCommand: "node bin.ts ticket:worktree", prOpenCommand: "/node /tool/src/bin.ts pr:open", stackedOn: stackedOn(stacked, [first, stacked]), overlapStack: started.overlapStack, drafts: false });
  for (const part of ["## Stack on the work you wait for", `- A11-1: ${pullOf(11)}, on branch \`admin/a11-1\``, "`node bin.ts ticket:worktree agent-org --from <branch>`", "`gh pr create --base <branch>`, ready",
    "A11-1 does not block this ticket. It changes `src/ticket-mode/queue.ts`, which this ticket changes too"]) assert.ok(text.includes(part), part);
  assert.equal(text.includes("These tickets block this one"), false, "it does not say the base blocks the ticket");
});

test("A11-374: the run below is promoted, and its card and the stacked run's card say the stack (A11-370's priority and notes apply)", () => {
  const first = queuedWith("A11-1", 11, ["src/a.ts"]);
  const second = finishedWith("A11-2", 12, ["src/a.ts"], { overlapStack: { key: "A11-1", repo: REPO, branch: "admin/a11-1", head: null, url: pullOf(11), shared: "src/a.ts", others: [] }, stackBase: { key: "A11-1", repo: REPO, branch: "admin/a11-1", sha: "1".repeat(40) } });
  const entries = [first, second];
  assert.ok(keysWithStackAbove(entries).has("A11-1"), "the base has a stack above it");
  assert.equal(stackedOnItNote(first, entries), "#12 (A11-2) is stacked on it");
  assert.equal(stackNote([{ key: "A11-1", url: pullOf(11), repo: REPO, branch: "admin/a11-1", head: null }], second.overlapStack), `Stacked on A11-1 #11 (overlaps \`src/a.ts\`)`);
  assert.equal(stackNote([{ key: "A11-1", url: pullOf(11), repo: REPO, branch: "admin/a11-1", head: null }], { ...second.overlapStack!, shared: null }), `Stacked on A11-1 #11 (same repository, files not known)`);
});

test("A11-374: a ticket with no files known waits for a running ticket of its repository to push a branch, and starts stacked on it once it has; in another repository it starts alone", () => {
  const running = run("A11-1", { phase: "running", startedAt: 2 });
  const waiting = run("A11-2", { queuedAt: 3 });
  assert.deepEqual(startedKeys(queueOf(running, waiting)), [], "the repository is claimed whole, and the running ticket has no branch to build on");
  assert.equal(waitNote(waiting, [running, waiting]), "Waits for A11-1 to push its branch: same repository, files not known");
  const pushed = { ...running, pushed: { repo: REPO, head: "a".repeat(40) } };
  const [started] = nextStarts(queueOf(pushed, waiting), 0, 14);
  assert.deepEqual([started.ticket.key, started.overlapStack?.key, started.overlapStack?.head, started.overlapStack?.url, started.overlapStack?.shared], ["A11-2", "A11-1", "a".repeat(40), null, null]);
  const stacked = { ...started, phase: "starting" as const };
  assert.deepEqual(stackedOn(stacked, [pushed, stacked]).map(({ key, head, url }) => [key, head, url]), [["A11-1", "a".repeat(40), null]], "stacked on its branch alone, with no pull request yet");
  assert.equal(stackNote(stackedOn(stacked, [pushed, stacked]), started.overlapStack), "Stacked on A11-1 (branch `admin/a11-1`, no pull request yet) (same repository, files not known)");
  assert.deepEqual(startedKeys(queueOf(running, run("A11-3", { projectRepo: "lab" }))), ["A11-3"], "another repository claims another repository");
});

test("A11-374: a ticket with no repository known claims nothing, and one with a plan claims its plan's paths and not its repository", () => {
  assert.equal(overlapWait(run("A11-2", { projectRepo: undefined }), [run("A11-1", { phase: "running" })]), null);
  const planned = run("A11-2", { paths: [`${REPO}:docs/readme.md`] });
  assert.equal(overlapWait(planned, [run("A11-1", { phase: "running", paths: [`${REPO}:src/a.ts`] })]), null, "two plans with different files do not meet");
});

test("A11-374: a ticket's Region names what it claims when it has no plan and no pull request, and the claim is its own repository's unless the Region names a cloned one", () => {
  assert.deepEqual(regionClaimsOf("## Region\n\nagent-org ticket mode: `src/ticket-mode/queue.ts` and `lab:docs/a.md`, `other:x/y.ts`.\n", [REPO, "lab"]), [":src/ticket-mode/queue.ts", "lab:docs/a.md", ":x/y.ts"]);
  assert.deepEqual(regionClaimsOf("no region here", [REPO]), []);
  const below = finishedWith("A11-1", 11, ["src/ticket-mode/queue.ts"]);
  const overlapping = run("A11-2", { regionPaths: [":src/ticket-mode/queue.ts"] });
  assert.equal(overlapStackOf(overlapping, [below, overlapping])?.base.key, "A11-1", "its Region meets a file the run below changes");
  assert.equal(overlapStackOf(overlapping, [below, overlapping])?.shared, "src/ticket-mode/queue.ts");
  assert.deepEqual(startedKeys(queueOf(below, run("A11-3", { regionPaths: [":src/elsewhere.ts"] }))), ["A11-3"], "a Region that meets no file starts without a stack");
  assert.equal(nextStarts(queueOf(below, run("A11-3", { regionPaths: [":src/elsewhere.ts"] })), 0, 14)[0].overlapStack, undefined);
});

test("A11-374: a ticket that overlaps two open stacks stacks on the most recently updated one, and is told the other's branch", () => {
  const older = finishedWith("A11-1", 11, ["src/a.ts"], { finishedAt: 10 });
  const newer = finishedWith("A11-2", 12, ["src/a.ts"], { finishedAt: 20 });
  const waiting = queuedWith("A11-3", 13, ["src/a.ts"]);
  const [started] = nextStarts(queueOf(older, newer, waiting), 0, 14);
  assert.equal(started.overlapStack?.key, "A11-2", "the one most recently updated");
  assert.deepEqual(started.overlapStack?.others, [{ key: "A11-1", branch: "admin/a11-1" }]);
  const text = briefText({ ticket: { ...started.ticket, status: "", statusOrder: 0, team: "A11", project: null, priority: 0, parent: null } as Ticket, folder: "/f", ticketDir: "/d", attachments: [], clones: { [REPO]: "/w" }, worktreeCommand: "w",
    prOpenCommand: "p", stackedOn: [{ key: "A11-2", url: pullOf(12), repo: REPO, branch: "admin/a11-2", head: null }], overlapStack: started.overlapStack });
  assert.ok(text.includes("A11-1 also touches files you will change, on branch `admin/a11-1`. Merge it into your branch only if your work needs it; otherwise leave it, and the board restacks you as the stack below merges."));
});

test("A11-374: the overlap base is never waited for; once its pull request has merged the run is no longer stacked on it, and the stack is kept for the restack", () => {
  const below = finishedWith("A11-1", 11, ["src/a.ts"]);
  const stack = { key: "A11-1", repo: REPO, branch: "admin/a11-1", head: null, url: pullOf(11), shared: "src/a.ts", others: [] };
  const above = run("A11-2", { phase: "running", startedAt: 6, overlapStack: stack });
  assert.deepEqual(waitsOn(above, [below, above]), []);
  assert.deepEqual(stackedOn(above, [below, above]).map(({ key }) => key), ["A11-1"], "stacked while the base's pull request is open");
  const merged = { ...below, pullStates: { [pullOf(11)]: "merged" } } as Entry;
  assert.deepEqual(stackedOn(above, [merged, above]), [], "and not once it has merged: the base's own pull requests say so");
  assert.equal(dropSettledOverlapStacks(queueOf(merged, above)).entries[1].overlapStack?.key, "A11-1", "a run that started keeps its stack, which the restack finds its branch by");
  const queued = run("A11-3", { overlapStack: stack });
  assert.equal(dropSettledOverlapStacks(queueOf(merged, queued)).entries[1].overlapStack, undefined, "a queued run is decided again once its base has merged");
  assert.equal(dropSettledOverlapStacks(queueOf(queued)).entries[0].overlapStack, undefined, "or its run has left the queue");
  assert.equal(dropSettledOverlapStacks(queueOf({ ...below, trackerState: "completed" } as Entry, queued)).entries[1].overlapStack, undefined, "or its ticket has ended");
  assert.equal(dropSettledOverlapStacks(queueOf(below, queued)).entries[1].overlapStack?.key, "A11-1", "and keeps it while the base's pull request is open");
});

test("A11-374: overlapping tickets do not start together in one pass: the second waits for the first to push a branch, and is then stacked on it", () => {
  const below = finishedWith("A11-1", 11, ["src/a.ts"]);
  const second = run("A11-2", { regionPaths: [":src/a.ts"], queuedAt: 2 });
  const third = run("A11-3", { regionPaths: [":src/a.ts"], queuedAt: 3 });
  const queue = queueOf(below, second, third);
  assert.deepEqual(startedKeys(queue), ["A11-2"], "the second is stacked on the pull request below, and the third waits for the second's branch");
  assert.equal(waitNote(third, [...queue.entries, { ...second, phase: "starting" } as Entry]), "Waits for A11-2 to push its branch: both touch src/a.ts");
  const pushed = { ...second, phase: "running", startedAt: 9, pushed: { repo: REPO, head: "d".repeat(40) } } as Entry;
  const [next] = nextStarts(queueOf(below, pushed, third), 0, 14);
  assert.deepEqual([next.ticket.key, next.overlapStack?.key], ["A11-3", "A11-2"], "once it has pushed, the third is stacked on it, the one most recently updated");
  assert.deepEqual(next.overlapStack?.others, [{ key: "A11-1", branch: "admin/a11-1" }]);
});

test("A11-374: a ticket that names no file overlaps the runs at work in its repository, not every pull request open in it", () => {
  const readOpen = finishedWith("A11-1", 11, ["src/a.ts"]);
  const unreadOpen = finishedWith("A11-3", 13, [], { pullFiles: undefined });
  const planless = run("A11-2");
  assert.deepEqual(startedKeys(queueOf(readOpen, planless)), ["A11-2"], "a finished run's pull request whose files are read is no one it can compare with");
  assert.equal(nextStarts(queueOf(readOpen, planless), 0, 14)[0].overlapStack, undefined, "so it starts alone");
  assert.deepEqual(startedKeys(queueOf(unreadOpen, planless)), ["A11-2"], "and one whose files are not read yet holds it for no read");
  const working = run("A11-4", { phase: "running", startedAt: 2, pushed: { repo: REPO, head: "c".repeat(40) } });
  assert.equal(nextStarts(queueOf(readOpen, working, planless), 0, 14)[0].overlapStack?.key, "A11-4", "a run at work in its repository is the one it stacks on");
});
