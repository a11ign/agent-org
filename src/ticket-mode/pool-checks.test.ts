// no-token: gh -- pure functions over a job log's text, and the fake code host that answers each read
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLinesOfLog } from "../ci-log-lines.ts";
import { answerChecks, infrastructureCause } from "./pool-checks.ts";
import { foreignRedsOf, type ForeignReds } from "./pool-foreign-checks.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type Flake, flakesView } from "./flakes.ts";
import type { PoolContext } from "./pool-context.ts";

const stamped = (lines: string[]) => lines.map((line) => `2026-10-20T10:00:00.1234567Z ${line}`).join("\n");

test("A11-154: the lines of a job log that name its failure have no colour, no timestamp, no warning, no echoed command and no exit-code line", () => {
  const log = stamped(["##[group]Run npm test", "\u001b[33mnpm warn deprecated left-pad\u001b[0m", "\u001b[31mnot ok 3 - git spawn classification\u001b[0m", "  AssertionError: expected 1 to equal 2",
    "##[command]npm run failing", "##[error]Process completed with exit code 1.", "all fine"]);
  assert.deepEqual(errorLinesOfLog(log), ["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"]);
});

test("A11-154: only the last 200 lines that name the failure are kept, since a job's summary is at its end", () => {
  const lines = errorLinesOfLog(stamped(Array.from({ length: 500 }, (_, i) => `Error: failure number ${i}`)));
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [200, "Error: failure number 300", "Error: failure number 499"]);
});

test("A11-154: a log is the infrastructure's when a runner was lost, a rate limit was hit, GitHub answered 5xx or the network failed, and the code's otherwise", () => {
  const cases: [string, string[], string | null][] = [
    ["a lost runner", ["##[error]The hosted runner lost communication with the server.", "##[error]Process completed with exit code 143."], "a runner was lost or a rate limit was hit"],
    ["a rate limit", ["gh: API rate limit exceeded for user ID 1"], "a runner was lost or a rate limit was hit"],
    ["a GitHub 5xx", ["Run gh api repos/x/y", "gh: HTTP 502: Server Error"], "GitHub answered with a server error"],
    ["a network error at the end", ["npm error code ECONNRESET", "npm error network aborted", "npm error A complete log of this run can be found in: /home/runner/.npm/_logs/x.log"], "a network error"],
    ["a build whose log mentions a rate limit long before its failure", ["Error: rate limit mentioned by a retry helper", ...Array.from({ length: 6 }, (_, i) => `error TS2322: type error ${i}`)], null],
    ["a failed assertion", ["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"], null],
    ["a 4xx", ["gh: HTTP 404: Not Found"], null],
    ["an early network line the code's failure follows", ["warning: ECONNREFUSED on a retry, then it connected", ...Array.from({ length: 6 }, (_, i) => `Error: test ${i} failed`)], null],
    ["a passing test that prints a rate limit beside a real failure", ["not ok 4 - a real failure", "ok 5 - prints 'rate limit' when throttled"], null],
    ["no error at all", ["done"], null],
  ];
  for (const [why, lines, cause] of cases) assert.equal(infrastructureCause(stamped(lines)), cause, why);
});

// A11-179: the red checks that are not the run's, over the fake code host. `answerChecks` reads the logs of the checks it answers, so a log is seeded for each.
const URL_1 = "https://github.com/a11ign/agent-org/pull/1800";
const URL_2 = "https://github.com/a11ign/agent-org/pull/1801";
const HEAD = "1a2b3c4d".padEnd(40, "0");
const job = (id: number) => `https://github.com/a11ign/agent-org/actions/runs/${id * 10}/job/${id}`;

/** A pull request's feedback at `HEAD`, failing `names` (each with its job's page, none of them required, so all are answered), and the files it changes. */
const feedback = (names: readonly string[], files: readonly string[] = ["src/ticket-mode/pool.ts"], over: Partial<PullFeedback> = {}): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing: names, failures: names.map((name, i) => ({ name, detailsUrl: job(i + 1) })), failedAt: null, conflicting: false,
  mergeable: true, head: HEAD, approvedAtHead: false, base: "main", files, filesComplete: true, ...over,
});
/** The check run's own entry (A11-177's): a required `gate` red over a job of the old org, whose paths are agent-org's `src/ticket-mode/`. */
const own = (key = "A11-177", paths: readonly string[] = ["agent-org:src/ticket-mode/"], url = URL_1) =>
  ({ ticket: { key }, paths, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url }] }, pullStates: { [url]: "open" } }) as unknown as Entry;

/** What a pass reads of the checks red where the run cannot mend them (A11-215): `names` fail on the default branch, and `mainPassing` are the ones it reports passing (null: a host of 1.14, which cannot say); `mainPending` are the ones whose newest run there has not concluded (null: the host does not say, so a check in neither list is taken to be running). */
const redOn = (names: readonly string[], mainPassing: readonly string[] | null = null, mainPending: readonly string[] | null = null): ForeignReds => () => ({ names: new Set(names), onMain: new Set(names), mainPassing: mainPassing === null ? null : new Set(mainPassing), mainPending: mainPending === null ? null : new Set(mainPending), mainBranch: "main" });

const NOW = Date.parse("2026-10-26T12:00:00Z");
const WORKERS = "a11ign-workers";

/** The flake log in memory: what the pool records to `flakes.json`, kept in a list a test reads. */
function memoryFlakes() {
  const recorded: Flake[] = [];
  return { recorded, log: { record: (found: readonly Flake[]) => void recorded.push(...found), view: () => flakesView(recorded, NOW) } };
}

function world(logs: Record<string, string> = {}) {
  const host = createFakeCodeHost();
  for (const [url, text] of Object.entries(logs)) host.checksAndClaims.logs.set(url, text);
  const flakes = memoryFlakes();
  const clock = { at: NOW };
  const ctx = { codeHost: host, now: () => clock.at, flakes: flakes.log, repliesRead: new Set<string>(), ownLogin: { value: WORKERS } } as unknown as PoolContext;
  return { host, ctx, flakes: flakes.recorded, clock };
}
/** The answer a watch gives once the board's rerun of the code's own red checks (A11-300) has come out red again: the watch that reran them, then the one that reads the same head red. Any other first answer is the answer. */
async function answerAfterRerun(ctx: PoolContext, entry: Entry, open: Parameters<typeof answerChecks>[2], reds?: ForeignReds): ReturnType<typeof answerChecks> {
  const first = await answerChecks(ctx, entry, open, reds);
  return open.some(({ url }) => first.heads[url]?.step === "rerun") ? answerChecks(ctx, { ...entry, checkHeads: first.withoutRound } as Entry, open, reds) : first;
}
/** An entry whose red checks at `HEAD` were rerun already, as a worker is asked for them only then (A11-300). */
const rerunAlready = (entry: Entry, url = URL_1): Entry => ({ ...entry, checkHeads: { [url]: { head: HEAD, step: "rerun" as const, note: "reran" } } }) as Entry;
const REFUSAL = stamped(["refusalOwners: REFUSED -- A11-127 retires this check", "##[error]Process completed with exit code 1."]);
const TEST_FAILED = stamped(["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"]);

test("A11-179: a check that fails on the default branch too starts no round and is named red on main / not this run's, and a check main does not fail is still the run's", async () => {
  const { ctx, host } = world({ [job(1)]: REFUSAL, [job(2)]: TEST_FAILED });
  const onMain = () => redOn(["refusalOwners"]);
  const mixed = await answerAfterRerun(ctx, own(), [{ url: URL_1, read: feedback(["refusalOwners", "suite"]) }], onMain());
  assert.match(mixed.feedback ?? "", /^suite failed on the head commit of /m, "the run's own check gets its round");
  assert.match(mixed.feedback ?? "", /refusalOwners also failed on the head commit of .* fails on the default branch or on pull requests that touch none of your files: that is not a fault in your change, so leave it\.$/, "and the brief says the other is not its");
  assert.deepEqual(mixed.heads, { [URL_1]: { head: HEAD, step: "round" } });
  const only = await answerChecks(ctx, own(), [{ url: URL_1, read: feedback(["refusalOwners"]) }], onMain());
  assert.equal(only.feedback, null, "nothing is red that the run can mend: no round");
  assert.deepEqual(only.heads, { [URL_1]: { head: HEAD, step: "not-ours", note: "refusalOwners is red on main / not this run's; owned by A11-127", notOurs: { refusalOwners: "A11-127" }, waitingOnMain: ["refusalOwners"] } });
  assert.deepEqual(only.withoutRound, only.heads, "and the record is kept without a round, so the card names it");
  assert.deepEqual(host.checksAndClaims.reruns, [[job(2)]], "the run's own check is rerun once before its round, and the one that is red elsewhere is never rerun");
});

test("A11-179: a check red on another run's pull request in the same repository that changes none of this run's plan paths is not this run's, and one that touches them is", async () => {
  const { ctx } = world({ [job(1)]: TEST_FAILED });
  const mine = own();
  const other = (files: readonly string[], over: Partial<PullFeedback> = {}) => ({ entry: own("A11-150", ["agent-org:src/other/"], URL_2), open: [{ url: URL_2, read: feedback(["suite"], files, over) }] });
  const answer = (outside: ReturnType<typeof other>) =>
    answerAfterRerun(ctx, mine, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: mine, open: [{ url: URL_1, read: feedback(["suite"]) }] }, outside]));
  assert.deepEqual((await answer(other(["src/other/thing.ts"]))).heads[URL_1]?.step, "not-ours", "the same check is red where this run's files are not");
  assert.deepEqual((await answer(other(["src/ticket-mode/pool-checks.ts"]))).heads[URL_1]?.step, "round", "a pull request that touches the run's region says nothing of it");
  assert.deepEqual((await answer(other(["src/other/thing.ts"], { filesComplete: false }))).heads[URL_1]?.step, "round", "a list of files cut short may touch it");
  const noPaths = own("A11-177", []);
  const free = await answerAfterRerun(ctx, noPaths, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: noPaths, open: [{ url: URL_1, read: feedback(["suite"]) }] }, other(["src/other/thing.ts"])]));
  assert.equal(free.heads[URL_1]?.step, "round", "a run whose plan declares no paths has no region to compare with");
  const elsewhere = { entry: own("A11-150", ["agent-org:src/other/"], "https://github.com/a11ign/control/pull/9"), open: [{ url: "https://github.com/a11ign/control/pull/9", read: feedback(["suite"], ["src/other/thing.ts"]) }] };
  assert.equal((await answer(elsewhere)).heads[URL_1]?.step, "round", "a pull request of another repository says nothing of it");
  const mineAgain = foreignRedsOf(ctx, [{ entry: mine, open: [{ url: URL_1, read: feedback(["suite"]) }] }]);
  assert.deepEqual([...mineAgain(mine, URL_1).names], [], "a run's own pull request is not another's");
});

test("A11-179: the ticket that owns a red check is the one a Blocked-by line names, else one the check's refusal names, never the run's own, and none when none is named", async () => {
  const owned = async (log: string, body: string | undefined, key = "A11-177") => {
    const { ctx } = world({ [job(1)]: log });
    const read = feedback(["refusalOwners"], ["src/ticket-mode/pool.ts"], body === undefined ? {} : { body });
    return (await answerChecks(ctx, own(key), [{ url: URL_1, read }], redOn(["refusalOwners"]))).heads[URL_1]?.note;
  };
  assert.equal(await owned(REFUSAL, undefined), "refusalOwners is red on main / not this run's; owned by A11-127", "the check's refusal text names it");
  assert.equal(await owned(REFUSAL, "Refs A11-177\n\nBlocked-by: A11-130"), "refusalOwners is red on main / not this run's; owned by A11-130", "a Blocked-by line comes first");
  assert.equal(await owned(TEST_FAILED, "Blocked-by: A11-177, NBL-9"), "refusalOwners is red on main / not this run's; owned by NBL-9", "the run's own key is no owner, and a blocker of another team is read");
  assert.equal(await owned(stamped(["REFUSED -- A11-177 itself", "not ok - UTF-8 handling, SHA-256 digest"]), ""), "refusalOwners is red on main / not this run's", "its own key, and words that only look like keys, name no owner");
  assert.equal(await owned(REFUSAL, undefined, "A11-127"), "refusalOwners is red on main / not this run's", "a run that is the owner has no other");
});

test("A11-179: a check red elsewhere is looked at again on every watch: the log that named its owner is not read again, and the record goes once the check is the run's or green", async () => {
  const { ctx, host } = world({ [job(1)]: REFUSAL });
  const entry = own();
  const first = await answerChecks(ctx, entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], redOn(["refusalOwners"]));
  const reads = () => host.calls.filter((call) => call.startsWith("readCheckLog")).length;
  assert.equal(reads(), 1);
  const again = await answerChecks(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], redOn(["refusalOwners"]));
  assert.deepEqual([again.heads, reads()], [first.heads, 1], "the same answer, with no second read of the log");
  const ours = await answerAfterRerun(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], redOn([]));
  assert.deepEqual([ours.heads[URL_1]?.step, ours.feedback !== null], ["round", true], "main is green: the check is the run's, and gets its round");
  const green = await answerChecks(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback([]) }], redOn([]));
  assert.deepEqual([green.heads, green.feedback], [{}, null], "nothing is red: the record is dropped");
  const answered = { [URL_1]: { head: HEAD, step: "round" as const } };
  const kept = await answerChecks(ctx, { ...entry, checkHeads: answered } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], redOn(["refusalOwners"]));
  assert.deepEqual([kept.heads, kept.feedback], [answered, null], "a head the board already answered with a round is answered: it is not looked at again");
});

test("A11-179: a run sequenced with another on purpose, as its blocker or its dependent, is not told a failure is not its own because the other's pull request fails it too", async () => {
  const { ctx } = world({ [job(1)]: TEST_FAILED });
  const mine = { ...own(), blockers: [{ key: "A11-150" }] } as unknown as Entry;
  const stacked = { entry: own("A11-150", ["agent-org:src/other/"], URL_2), open: [{ url: URL_2, read: feedback(["suite"], ["src/other/thing.ts"]) }] };
  const answer = (self: Entry, other: typeof stacked) => answerAfterRerun(ctx, self, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: self, open: [{ url: URL_1, read: feedback(["suite"]) }] }, other]));
  assert.equal((await answer(own(), stacked)).heads[URL_1]?.step, "not-ours", "an independent run's failure of the same check is read as not this run's");
  assert.equal((await answer(mine, stacked)).heads[URL_1]?.step, "round", "a run stacked on the other runs its checks over its code: the other's failure is its own");
  const dependent = { ...stacked, entry: { ...stacked.entry, blockers: [{ key: "A11-177" }] } as unknown as Entry };
  assert.equal((await answer(own(), dependent)).heads[URL_1]?.step, "round", "and so does the run the other is stacked on");
});

test("A11-179: the owner is never read from a failing test's title, which names tickets as well: only a line that says the check refused names one", async () => {
  const titled = stamped(["not ok 3 - A11-154: a red check starts a round", "AssertionError: expected 1 to equal 2"]);
  const { ctx } = world({ [job(1)]: titled });
  const note = (await answerChecks(ctx, own(), [{ url: URL_1, read: feedback(["suite"]) }], redOn(["suite"]))).heads[URL_1]?.note;
  assert.equal(note, "suite is red on main / not this run's", "no owner is named");
});

// A11-215: a pull request held as red on main is brought up to date with main once main reports the checks it waits on passing.
const HELD_UI = { [URL_1]: { head: HEAD, step: "not-ours" as const, note: "ui is red on main / not this run's", notOurs: { ui: null }, waitingOnMain: ["ui"] } };
const heldEntry = (): Entry => ({ ...own(), checkHeads: HELD_UI }) as Entry;
/** A world whose fake holds the pull requests at `URL_1` and `URL_2`, so that an update of either is asked of something. */
function heldWorld() {
  const made = world({ [job(1)]: TEST_FAILED, [job(2)]: TEST_FAILED });
  made.host.seedPull("a11ign/agent-org", 1800, { head: HEAD });
  made.host.seedPull("a11ign/agent-org", 1801, { head: HEAD });
  return made;
}
const answerHeld = (made: ReturnType<typeof heldWorld>, read: PullFeedback, reds: ForeignReds, entry: Entry = heldEntry()) => answerAfterRerun(made.ctx, entry, [{ url: URL_1, read }], reds);
const updatesAsked = (made: ReturnType<typeof heldWorld>) => made.host.branchUpdates.asked.map(({ url, expectedHead }) => [url, expectedHead]);

test("A11-215: a check red on main is recorded as waited on main; one red only on another run's pull request is not", async () => {
  const { ctx, host } = world({ [job(1)]: TEST_FAILED, [job(2)]: TEST_FAILED });
  host.seedDefaultBranch("a11ign/agent-org", ["ui"], { passing: ["typecheck"] });
  const mine = own();
  const read = feedback(["ui", "lint"]);
  const elsewhere = { entry: own("A11-150", ["agent-org:src/other/"], URL_2), open: [{ url: URL_2, read: feedback(["lint"], ["src/other/thing.ts"]) }] };
  const reds = foreignRedsOf(ctx, [{ entry: mine, open: [{ url: URL_1, read }] }, elsewhere]);
  assert.deepEqual([[...reds(mine, URL_1).names], [...reds(mine, URL_1).onMain], [...reds(mine, URL_1).mainPassing!]], [["ui", "lint"], ["ui"], ["typecheck"]], "main's reading is kept apart from the other run's red check");
  const answer = await answerChecks(ctx, mine, [{ url: URL_1, read }], reds);
  assert.deepEqual(Object.keys(answer.heads[URL_1]?.notOurs ?? {}), ["ui", "lint"], "both are held as not this run's");
  assert.deepEqual(answer.heads[URL_1]?.waitingOnMain, ["ui"], "but only the one red on main is waited on main");
});

test("A11-215: main reporting the checks a held pull request waits on passing updates it from main, once, and the card says so", async () => {
  const made = heldWorld();
  const first = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]));
  assert.deepEqual(first.heads, { [URL_1]: { head: HEAD, step: "updated", note: "main is green again: updated from main" } });
  assert.deepEqual([first.feedback, first.withoutRound], [null, first.heads], "no round and no rerun: the record is kept without one");
  assert.deepEqual([updatesAsked(made), made.host.checksAndClaims.reruns], [[[URL_1, HEAD]], []], "the update is asked for the head the pull request was read at");
  const again = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]), { ...own(), checkHeads: first.heads } as Entry);
  assert.deepEqual([again.heads, again.feedback, updatesAsked(made).length], [first.heads, null, 1], "a watch that reads the head before GitHub moved it does not update again");
});

test("A11-215: the record of an update stays on the card while the new head's checks run, and is replaced by what the new head answers or dropped once they have concluded", async () => {
  const made = heldWorld();
  const updated = { ...own(), checkHeads: { [URL_1]: { head: HEAD, step: "updated" as const, note: "main is green again: updated from main" } } } as Entry;
  const NEW_HEAD = "9f8e7d6c".padEnd(40, "0");
  const running = await answerHeld(made, feedback([], ["src/ticket-mode/pool.ts"], { head: NEW_HEAD, pendingRequired: ["ui"] }), redOn([], ["ui"]), updated);
  assert.equal(running.heads[URL_1]?.step, "updated", "the new head's checks are running: the card goes on saying why");
  const red = await answerHeld(made, feedback(["lint"], ["src/ticket-mode/pool.ts"], { head: NEW_HEAD }), redOn([], ["ui"]), updated);
  assert.deepEqual([red.heads[URL_1]?.step, red.heads[URL_1]?.head], ["round", NEW_HEAD], "the new head's own red check is answered, and replaces the record");
  const done = await answerHeld(made, feedback([], ["src/ticket-mode/pool.ts"], { head: NEW_HEAD, pendingRequired: [] }), redOn([], ["ui"]), updated);
  assert.deepEqual(done.heads, {}, "and once nothing runs or fails there it is dropped");
  assert.deepEqual(updatesAsked(made), [], "none of it asks for an update");
});

test("A11-215: an update that conflicts adds the pull request's conflict line to the round and keeps the hold; one that finds nothing to take from main leaves the failure the run's own", async () => {
  const conflicted = heldWorld();
  conflicted.host.branchUpdates.answers.set(URL_1, { kind: "conflict" });
  const conflict = await answerHeld(conflicted, feedback(["ui"]), redOn([], ["ui"]));
  assert.equal(conflict.feedback, `${URL_1} conflicts with its base branch main.`, "the conflict line a conflicting pull request already gets, and nothing about the check");
  assert.deepEqual(conflict.heads, HELD_UI);
  const current = heldWorld();
  current.host.branchUpdates.answers.set(URL_1, { kind: "up-to-date" });
  const upToDate = await answerHeld(current, feedback(["ui"]), redOn([], ["ui"]));
  assert.match(upToDate.feedback ?? "", /^ui failed on the head commit of /, "it already has main's fix and is still red: the check is the run's own");
  assert.equal(upToDate.heads[URL_1]?.step, "round");
});

test("A11-215: an update the host refuses keeps the hold, says why on the card, and is asked for again on the next watch", async () => {
  const made = heldWorld();
  made.host.branchUpdates.answers.set(URL_1, { kind: "refused", reason: "gh: expected head sha didn't match current head ref. (HTTP 422)" });
  const first = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]));
  const note = "ui is red on main / not this run's; could not update from main (gh: expected head sha didn't match current head ref. (HTTP 422)), asked again next watch";
  assert.deepEqual([first.heads[URL_1]?.step, first.heads[URL_1]?.note, first.feedback], ["not-ours", note, null]);
  made.host.branchUpdates.answers.delete(URL_1);
  const next = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]), { ...own(), checkHeads: first.heads } as Entry);
  assert.deepEqual([next.heads[URL_1]?.step, updatesAsked(made).length], ["updated", 2], "the next watch asks again, and the note of the refusal does not stop it");
});

test("A11-215: a pull request with a check of its own red is not updated by this rule, and its own check gets the round", async () => {
  const made = heldWorld();
  const answer = await answerHeld(made, feedback(["ui", "lint"]), redOn([], ["ui"]));
  assert.deepEqual(updatesAsked(made), [], "never asked to update");
  assert.match(answer.feedback ?? "", /^ui failed on the head commit of /m);
  assert.equal(answer.heads[URL_1]?.step, "round");
  const still = await answerHeld(made, feedback(["ui", "lint"]), redOn(["ui"]), { ...own(), checkHeads: { [URL_1]: { ...HELD_UI[URL_1], notOurs: { ui: null, lint: null }, waitingOnMain: ["ui"] } } } as Entry);
  assert.deepEqual(updatesAsked(made), [], "nor while main still fails the one it waits on");
  assert.match(still.feedback ?? "", /^lint failed on the head commit of /m, "the check that is the run's gets its round, as it did");
});

test("A11-215: no positive reading from main, no update: a failed read, a check still running there and a host that cannot say keep or end the hold as they did", async () => {
  const made = heldWorld();
  const kept = async (reds: ForeignReds, why: string) => {
    const answer = await answerHeld(made, feedback(["ui"]), reds);
    assert.deepEqual([answer.heads, answer.feedback, updatesAsked(made)], [HELD_UI, null, []], why);
  };
  await kept(redOn([], []), "main could not be read, or the check is running there: it is neither failing nor passing");
  await kept(redOn([], ["lint"]), "main passes other checks but has not reported this one, and the host does not say whether it is running");
  await kept(redOn([], ["lint"], ["ui"]), "main is running the check");
  const absent = await answerHeld(made, feedback(["ui"]), redOn([], ["lint"], []));
  assert.deepEqual([absent.heads[URL_1]?.step, updatesAsked(made)], ["round", []], "main was read and reports no run of the check at all: it waits on nothing there, and the hold does not last for ever");
  const ended = await answerHeld(made, feedback(["ui"]), redOn([], null));
  assert.deepEqual([ended.heads[URL_1]?.step, updatesAsked(made)], ["round", []], "a host that cannot say which checks pass gives no evidence of one, and the check is the run's once main stops failing it, as in A11-179");
});

test("A11-215: a pull request that conflicts is not sent to update-branch, a host without it ends the hold as before, and a hold recorded before this rule is not updated", async () => {
  const made = heldWorld();
  const conflicting = await answerHeld(made, feedback(["ui"], ["src/ticket-mode/pool.ts"], { conflicting: true }), redOn([], ["ui"]));
  assert.deepEqual([conflicting.heads, conflicting.feedback, updatesAsked(made)], [HELD_UI, null, []], "the conflict round that the watch starts for it is the answer");
  const without = heldWorld();
  const bare = { ...without.ctx, codeHost: { ...without.host, updateBranch: undefined } } as unknown as PoolContext;
  const round = await answerAfterRerun(bare, heldEntry(), [{ url: URL_1, read: feedback(["ui"]) }], redOn([], ["ui"]));
  assert.deepEqual([round.heads[URL_1]?.step, updatesAsked(without)], ["round", []]);
  const old = { ...own(), checkHeads: { [URL_1]: { head: HEAD, step: "not-ours" as const, note: "ui is red on main / not this run's", notOurs: { ui: null } } } } as Entry;
  const unrecorded = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]), old);
  assert.deepEqual([unrecorded.heads[URL_1]?.step, updatesAsked(made)], ["round", []], "a hold that records no main check waits on none");
});

test("A11-215: a pull request stacked on another branch, and a run whose worker holds its workspace, are not updated from main", async () => {
  const made = heldWorld();
  const stacked = await answerHeld(made, feedback(["ui"], ["src/ticket-mode/pool.ts"], { base: "A11-150" }), redOn([], ["ui"]));
  assert.deepEqual([stacked.heads[URL_1]?.step, updatesAsked(made)], ["round", []], "update-branch would merge the stack's base and not main: answered as it was");
  const parked = { ...heldEntry(), workspace: "w2" } as Entry;
  const waits = await answerHeld(made, feedback(["ui"]), redOn([], ["ui"]), parked);
  assert.deepEqual([waits.heads, waits.feedback, updatesAsked(made)], [HELD_UI, null, []], "the worker may be in its pane: the board does not push under it, and the hold stays");
});
