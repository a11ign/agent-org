// no-token: gh -- the queue and the board's words, in memory; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimOf, heldClaims, holderClaimOf, overlapHolders, overlapWait } from "./board-view/overlap-hold.ts";
import { runStatus, waitNote } from "./board-view/pull-status-and-notes.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import { enqueue } from "./queue/queue-entries-and-outcomes.ts";
import { markRunning, markStarting, recordPaths, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue, nextStarts } from "./queue.ts";
import type { Ticket } from "./source.ts";

const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };

/** A queue of `plans`' tickets (key to paths), each plan read, with room for all of them. */
const queued = (plans: Record<string, string[]>) =>
  recordPaths(resumeQueue(enqueue(emptyQueue(Object.keys(plans).length), Object.keys(plans).map(ticket), choice, 1)), new Map(Object.entries(plans)));

/** A run running with `paths` held, beside a queued run waiting on `waitingPaths`. */
function holderAndWaiter(holds: string[], waitingPaths: string[]) {
  const both = markRunning(markStarting(queued({ "A11-196": holds, "A11-200": waitingPaths }), "A11-196", 2), "A11-196", "w1", "w1:p1");
  return both.entries;
}

const SETTINGS_PAGE = ["agent-org:ui/src/pages/settings/", "agent-org:ui/test/settings/", "agent-org:ui/captures/settings/"];
const TICKETS_PAGE = ["agent-org:ui/src/pages/tickets/", "agent-org:ui/test/tickets/", "agent-org:ui/captures/tickets/"];

test("A11-212: two plans with per-feature paths run side by side, and neither card has a wait note", () => {
  const both = queued({ "A11-196": TICKETS_PAGE, "A11-200": SETTINGS_PAGE });
  assert.deepEqual(nextStarts(both, 0, 14).map((e) => e.ticket.key), ["A11-196", "A11-200"], "both start in one pass");
  assert.deepEqual(both.entries.map((e) => waitNote(e, both.entries)), [null, null]);
  const running = holderAndWaiter(TICKETS_PAGE, SETTINGS_PAGE);
  assert.equal(overlapWait(running[1], running), null, "and a run already running does not hold the other");
  assert.equal(runStatus(running[1], running), "queued");
});

test("A11-212: the A11-200 morning: whole folders held by a running ticket hold a ticket that needs one file in each, and the card says why", () => {
  const entries = holderAndWaiter(["agent-org:ui/src/shell/", "agent-org:ui/test/", "agent-org:ui/captures/"], ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts", "agent-org:ui/captures/settings/home.png"]);
  assert.equal(runStatus(entries[1], entries), "blocked");
  assert.equal(waitNote(entries[1], entries),
    "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts, ui/captures/settings/home.png; a folder claim, not a shared file: narrow A11-196's `ui/src/shell/`, `ui/test/`, `ui/captures/` in its plan");
});

test("A11-212: the card names every file both write, not only the first", () => {
  const files = ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts"];
  const entries = holderAndWaiter(files, files);
  assert.equal(waitNote(entries[1], entries), "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts");
  assert.deepEqual(overlapWait(entries[1], entries)?.overlaps, [
    { path: "ui/src/shell/App.tsx", folderOf: null, folder: null },
    { path: "ui/test/fixtures.ts", folderOf: null, folder: null },
  ]);
});

test("A11-212: a hold caused by a folder claim alone is flagged as one to narrow, naming whose folder; one shared file takes the flag away", () => {
  const folderOnly = holderAndWaiter(["agent-org:ui/src/shell/"], ["agent-org:ui/src/shell/App.tsx"]);
  assert.equal(waitNote(folderOnly[1], folderOnly), "Waits on A11-196: both touch ui/src/shell/App.tsx; a folder claim, not a shared file: narrow A11-196's `ui/src/shell/` in its plan");
  const own = holderAndWaiter(["agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/src/shell/"]);
  assert.equal(waitNote(own[1], own), "Waits on A11-196: both touch ui/src/shell/App.tsx; a folder claim, not a shared file: narrow A11-200's `ui/src/shell/` in its plan", "the waiting ticket's own folder is the one to narrow");
  const shared = holderAndWaiter(["agent-org:ui/src/shell/", "agent-org:ui/test/fixtures.ts"], ["agent-org:ui/src/shell/App.tsx", "agent-org:ui/test/fixtures.ts"]);
  assert.equal(waitNote(shared[1], shared), "Waits on A11-196: both touch ui/src/shell/App.tsx, ui/test/fixtures.ts", "a file both name is shared for real, so nothing is flagged");
});

test("A11-212: a folder inside another's folder overlaps at the narrower folder, and the one whose folder is wider is the one to narrow", () => {
  const entries = holderAndWaiter(["agent-org:ui/test/"], ["agent-org:ui/test/settings/"]);
  assert.equal(waitNote(entries[1], entries), "Waits on A11-196: both touch ui/test/settings/; a folder claim, not a shared file: narrow A11-196's `ui/test/` in its plan");
});

test("A11-212: a hold is still one hold: the first run that overlaps is named, and `path`, which Start anyway records, is the waiting run's own first overlapping claim", () => {
  const entries = holderAndWaiter(["agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/src/shell/", "agent-org:docs/"]);
  const wait = overlapWait(entries[1], entries);
  assert.deepEqual([wait?.key, wait?.pull, wait?.path], ["A11-196", null, "ui/src/shell/"]);
});

test("A11-212: the file the card names for that hold is the narrower claim, and the folder to narrow is the waiting run's own", () => {
  const entries = holderAndWaiter(["agent-org:ui/src/shell/App.tsx"], ["agent-org:ui/src/shell/", "agent-org:docs/"]);
  assert.deepEqual(overlapWait(entries[1], entries)?.overlaps, [{ path: "ui/src/shell/App.tsx", folderOf: "A11-200", folder: "ui/src/shell/" }]);
});

const URL_12 = "https://github.com/a11ign/agent-org/pull/12";
/** A finished run with a pull request open whose files are not read yet, and a queued run in its repository. */
function unreadHold() {
  const holder = { ticket: { key: "A11-196" }, phase: "finished", paths: [], outcome: { kind: "draft-pr", prs: [{ url: URL_12, repo: "agent-org" }] } } as unknown as ViewEntry;
  const waiting = { ticket: { key: "A11-200" }, phase: "queued", paths: ["agent-org:ui/src/a.ts"] } as unknown as ViewEntry;
  return { holder, waiting, entries: [holder, waiting] };
}

test("A11-212: a run held for a pull request whose files are not read yet says so, as before", () => {
  const { waiting, entries } = unreadHold();
  assert.equal(waitNote(waiting, entries), "Waits on A11-196 #12: its changed files are not read yet");
  const wait = overlapWait(waiting, entries);
  assert.deepEqual([wait?.key, wait?.pull, wait?.path], ["A11-196", "12", null]);
});

test("A11-212: and it names no overlapping path and no folder to narrow", () => {
  const { waiting, entries } = unreadHold();
  assert.deepEqual(overlapWait(waiting, entries)?.overlaps, []);
});

test("A11-212: a hold over many files names the first five and how many more, and the folder flag still names the folder", () => {
  const url = "https://github.com/a11ign/agent-org/pull/12";
  const files = Array.from({ length: 8 }, (_, n) => `ui/src/f${n}.ts`);
  const holder = { ticket: { key: "A11-196" }, phase: "finished", paths: [], outcome: { kind: "draft-pr", prs: [{ url, repo: "agent-org" }] }, pullFiles: { [url]: files } } as unknown as ViewEntry;
  const waiting = { ticket: { key: "A11-200" }, phase: "queued", paths: ["agent-org:ui/"] } as unknown as ViewEntry;
  assert.equal(waitNote(waiting, [holder, waiting]),
    "Waits on A11-196 #12: both touch ui/src/f0.ts, ui/src/f1.ts, ui/src/f2.ts, ui/src/f3.ts, ui/src/f4.ts, and 3 more; a folder claim, not a shared file: narrow A11-200's `ui/` in its plan");
});

const MIDDLEWARE = ["lab:middleware/runtime/main.py", "lab:middleware/README.md", "lab:middleware/src/", "lab:middleware-spike.yml"];
const URL_7 = "https://github.com/a11ign/lab/pull/7";

/** A run parked on its worker's declared wait (A11-245), holding the middleware files: `waits` is what its note declares. */
const parked = (key: string, waits: readonly unknown[], over: Record<string, unknown> = {}) =>
  ({ ticket: { key }, phase: "running", paths: MIDDLEWARE, working: { reason: "waiting", waiting: true, waits }, ...over }) as unknown as ViewEntry;

/** A queued run that needs the middleware files. */
const needsMiddleware = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", paths: ["lab:middleware/runtime/main.py"], ...over }) as unknown as ViewEntry;

test("A11-272: a run parked on a ticket wait does not hold that ticket behind its files: A11-229 starts on the files A11-231 holds", () => {
  const holder = parked("A11-231", [{ kind: "ticket", key: "A11-229", until: "done" }]);
  const waiting = needsMiddleware("A11-229");
  assert.equal(overlapWait(waiting, [holder, waiting]), null);
  assert.equal(runStatus(waiting, [holder, waiting]), "queued");
});

test("A11-272: a run parked on a pull request does not hold a ticket that pull request's ticket is blocked by, directly or two tickets down", () => {
  const owner = { ticket: { key: "B-1" }, phase: "finished", paths: [], outcome: { kind: "ready-pr", prs: [{ url: URL_7, repo: "lab" }] }, pullFiles: { [URL_7]: ["docs/x.md"] },
    blockers: [{ key: "C-1", state: "started", status: "In Progress" }] } as unknown as ViewEntry;
  const middle = needsMiddleware("C-1", { blockers: [{ key: "D-1", state: "started", status: "In Progress" }] });
  const deepest = needsMiddleware("D-1");
  const holder = parked("A-1", [{ kind: "pullRequest", url: URL_7, until: "merged" }]);
  const entries = [holder, owner, middle, deepest];
  assert.equal(overlapWait(middle, entries), null, "C-1 blocks the ticket whose pull request A-1 waits on");
  assert.equal(overlapWait(deepest, entries), null, "D-1 blocks C-1");
});

test("A11-272: a run parked on a fleet job or a CI run still holds a ticket it does not wait on, as before", () => {
  for (const waits of [[{ kind: "fleetJob", id: "fj-1" }], [{ kind: "ciRun", repository: "a11ign/lab", runId: 9 }]]) {
    const holder = parked("A-1", waits);
    const waiting = needsMiddleware("E-1");
    assert.equal(overlapWait(waiting, [holder, waiting])?.key, "A-1");
  }
});

test("A11-272: a run parked on a fleet job does not hold its own blocker's blocker", () => {
  const holder = parked("A-1", [{ kind: "fleetJob", id: "fj-1" }], { blockers: [{ key: "B-1", state: "started", status: "In Progress" }] });
  const blocker = { ticket: { key: "B-1" }, phase: "finished", paths: [], outcome: { kind: "ready-pr", prs: [] }, blockers: [{ key: "C-1", state: "started", status: "In Progress" }] } as unknown as ViewEntry;
  const waiting = needsMiddleware("C-1");
  assert.equal(overlapWait(waiting, [holder, blocker, waiting]), null);
});

test("A11-272: a run whose worker was woken from its wait, or works again, holds its files against the ticket it had declared, as before", () => {
  const woken = { ticket: { key: "A11-231" }, phase: "running", paths: MIDDLEWARE, working: { reason: "back at work", waits: [{ kind: "ticket", key: "A11-229", until: "done" }] } } as unknown as ViewEntry;
  const waiting = needsMiddleware("A11-229");
  assert.equal(overlapWait(waiting, [woken, waiting])?.key, "A11-231");
});

test("A11-272: a holder's exemption does not reach through a blocker that is done", () => {
  const holder = { ticket: { key: "A-1" }, phase: "running", paths: MIDDLEWARE, blockers: [{ key: "B-1", state: "completed", status: "Done" }] } as unknown as ViewEntry;
  const done = { ticket: { key: "B-1" }, phase: "finished", paths: [], outcome: { kind: "ready-pr", prs: [] }, blockers: [{ key: "C-1", state: "started", status: "In Progress" }] } as unknown as ViewEntry;
  const waiting = needsMiddleware("C-1");
  assert.equal(overlapWait(waiting, [holder, done, waiting])?.key, "A-1");
});

test("A11-272: a planner is still shown the claims of a run that waits on its ticket only through others, as before", () => {
  const planned = { ticket: { key: "A11-229" }, phase: "queued", plan: { model: "opus", effort: "max" } } as unknown as ViewEntry;
  const middle = { ticket: { key: "A11-231" }, phase: "queued", paths: ["lab:a.ts"], blockers: [{ key: "A11-229", state: "unstarted", status: "Todo" }] } as unknown as ViewEntry;
  const last = { ticket: { key: "A11-232" }, phase: "queued", paths: ["lab:b.ts"], blockers: [{ key: "A11-231", state: "unstarted", status: "Todo" }] } as unknown as ViewEntry;
  assert.deepEqual(heldClaims([planned, middle, last], [planned]).map(({ key }) => key), ["A11-232"]);
});

test("A11-272: the holders of a queued run's files are all counted without the exemption a waiting holder gets: overlapWait lifts the hold on A11-229, overlapHolders still names A11-231", () => {
  const holder = parked("A11-231", [{ kind: "ticket", key: "A11-229", until: "done" }]);
  const other = parked("A11-300", [], { working: undefined });
  const waiting = needsMiddleware("A11-229");
  assert.equal(overlapWait(waiting, [holder, waiting]), null, "the exemption is unchanged");
  assert.equal(overlapWait(waiting, [holder, other, waiting])?.key, "A11-300", "and a holder that does not wait on the ticket still holds it");
  assert.deepEqual(overlapHolders(waiting, [holder, other, waiting]), ["A11-231", "A11-300"], "every run that holds the files, the waiting one too");
});

test("A11-272: a run that holds none of a queued run's files, is its own ticket, or is sequenced with it is no holder", () => {
  const waiting = needsMiddleware("A11-229", { blockers: [{ key: "A11-100", state: "started", status: "In Progress" }] });
  const elsewhere = parked("A11-231", [], { paths: ["lab:docs/"] });
  const blocker = parked("A11-100", []);
  assert.deepEqual(overlapHolders(waiting, [elsewhere, blocker, waiting]), [], "A11-100 is a blocker, sequenced on purpose");
  assert.deepEqual(overlapHolders({ ...waiting, paths: [] }, [parked("A11-231", [])]), [], "a run with no paths contests none");
});

// A11-374: what a queued run claims is its plan's paths, else its open pull requests' files, else its ticket's Region, else its whole repository; a run at work with no files known holds its whole repository.
{
  const REPO = "agent-org";
  const PULL = "https://github.com/a11ign/agent-org/pull/30";
  const queuedRun = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", projectRepo: REPO, ...over }) as unknown as ViewEntry;
  const working = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "running", projectRepo: REPO, ...over }) as unknown as ViewEntry;
  const withPull = { opened: [{ repo: REPO, url: PULL }], pullStates: { [PULL]: "open" }, pullFiles: { [PULL]: ["src/pull.ts"] } };

  test("A11-374: a queued run claims its plan's paths first, then its open pull requests' files, then its Region, then its repository", () => {
    assert.deepEqual(claimOf(queuedRun("A", { paths: [`${REPO}:src/plan.ts`], ...withPull, regionPaths: [":src/region.ts"] })), { paths: [`${REPO}:src/plan.ts`], repoWide: null });
    assert.deepEqual(claimOf(queuedRun("A", { paths: [], ...withPull, regionPaths: [":src/region.ts"] })), { paths: [`${REPO}:src/pull.ts`], repoWide: null }, "a plan that names no path gives way to the pull request");
    assert.deepEqual(claimOf(queuedRun("A", { paths: [], regionPaths: [":src/region.ts", "lab:docs/x.md"] })), { paths: [`${REPO}:src/region.ts`, "lab:docs/x.md"], repoWide: null }, "then the Region, with the run's repository for a bare path");
    assert.deepEqual(claimOf(queuedRun("A", { paths: [] })), { paths: [], repoWide: REPO }, "and, with none of these, the whole repository");
    assert.deepEqual(claimOf(queuedRun("A", { projectRepo: undefined })), { paths: [], repoWide: null }, "a run with no repository known claims nothing");
    assert.deepEqual(claimOf(queuedRun("A", { overlapOverride: { holder: "B", pull: null, path: null, at: 1 } })), { paths: [], repoWide: null }, "nor does one started anyway");
    assert.deepEqual(claimOf(queuedRun("A", { review: [{ url: PULL }] })), { paths: [], repoWide: null }, "nor does a review round");
  });

  test("A11-374: a run at work with no files known holds its whole repository, and two such runs overlap; a run that names files overlaps it, and one in another repository does not", () => {
    assert.deepEqual(holderClaimOf(working("B")), { paths: [], repoWide: REPO });
    assert.deepEqual(holderClaimOf(working("B", { regionPaths: [":src/b.ts"] })), { paths: [`${REPO}:src/b.ts`], repoWide: null }, "its Region, when it has one");
    assert.deepEqual(holderClaimOf(working("B", { plan: { model: "opus", effort: "high" } })), { paths: [], repoWide: null }, "a planning run changes no file");
    assert.equal(overlapWait(queuedRun("A"), [working("B")])?.repoWide, REPO, "two runs that name no file");
    assert.equal(overlapWait(queuedRun("A", { paths: [`${REPO}:src/a.ts`] }), [working("B")])?.repoWide, REPO, "a run that names files meets the run that names none");
    assert.equal(overlapWait(queuedRun("A", { paths: [`${REPO}:src/a.ts`] }), [working("B", { paths: [`${REPO}:src/b.ts`] })]), null, "but not a run that names others");
    assert.equal(overlapWait(queuedRun("A"), [working("B", { projectRepo: "lab" })]), null, "and not a run in another repository");
    assert.equal(overlapHolders(queuedRun("A"), [working("B")]).join(), "B", "the wait cycles see the same overlap");
  });
}
