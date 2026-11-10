// no-token: gh -- the fake code host answers each read and update; the board's fix record is a file in a temporary directory, and the queue is in memory
// A11-428: a check red on main with no owner gets a fix ticket, named on every pull request it holds, and the held pull requests are brought up to date with main once the fix merges
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import type { PullFeedback } from "../../plugins/contracts/code-host.ts";
import { answerChecks } from "../pool-checks.ts";
import type { ForeignReds } from "../pool-foreign-checks.ts";
import type { PoolContext } from "../pool-context.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "../queue.ts";
import { saveState, type Entry as DependencyEntry } from "../dependency-updates/filed.ts";
import { fixReadsOf } from "./fix-owners.ts";
import { fixRequests } from "./fix-request.ts";
import { currentFix, fixKey } from "./fix-record.ts";

const REPO = "a11ign/agent-org";
const URL_1 = `https://github.com/${REPO}/pull/1800`;
const URL_2 = `https://github.com/${REPO}/pull/1801`;
const HEAD = "1a2b3c4d".padEnd(40, "0");
const NEW_HEAD = "9f8e7d6c".padEnd(40, "0");
const CHECK = "checks (unit)";
const KEY = fixKey(REPO, CHECK);
const job = (id: number) => `https://github.com/${REPO}/actions/runs/${id * 10}/job/${id}`;
const stamped = (lines: string[]) => lines.map((line) => `2026-10-20T10:00:00.1234567Z ${line}`).join("\n");
const ERROR_LINES = ["not ok 3 - migrate-host collects no tests", "AssertionError: expected 1 to equal 0"];
const LOG = stamped(ERROR_LINES);

/** A pull request's feedback at `head`, failing `names`, each with its job's page. */
const feedback = (names: readonly string[], over: Partial<PullFeedback> = {}): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing: names, failures: names.map((name, i) => ({ name, detailsUrl: job(i + 1) })), failedAt: null, conflicting: false,
  mergeable: true, head: HEAD, approvedAtHead: false, base: "main", files: ["src/ticket-mode/pool.ts"], filesComplete: true, ...over,
});
/** A finished run of `key` with one open pull request at `url`, whose plan's paths are agent-org's `src/ticket-mode/`. */
const run = (key: string, url: string, over: Partial<Entry> = {}) =>
  ({ ticket: { key }, paths: ["agent-org:src/ticket-mode/"], phase: "finished", outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url }] }, pullStates: { [url]: "open" }, ...over }) as unknown as Entry;
/** The fix ticket's own run, finished with its pull request in `state`. */
const fixRun = (key: string, state: "open" | "merged") => {
  const url = `https://github.com/${REPO}/pull/1900`;
  return { ...run(key, url), outcome: { kind: state === "merged" ? "ready-pr" : "needs-human", reason: "r", prs: [{ repo: "agent-org", url }] }, pullStates: { [url]: state } } as unknown as Entry;
};
/** `names` red on the default branch, which reports no passing check and none running (a repository with no CI on main reads the same for the checks it does not run). */
const redOn = (names: readonly string[]): ForeignReds => async () => ({ names: new Set(names), onMain: new Set(names), mainPassing: new Set(), mainPending: new Set(), mainBranch: "main" });

/** A pool context over the fake code host, the queue `queue` holds, and the fix record at a temporary path; `fixes: false` is a machine whose `tickets.fixRedMain` is off. */
function world(options: { fixes?: boolean; records?: Record<string, DependencyEntry> } = {}) {
  const host = createFakeCodeHost();
  host.checksAndClaims.logs.set(job(1), LOG);
  for (const number of [1800, 1801]) host.seedPull(REPO, number, { head: HEAD });
  const path = join(tmpDir("main-red-"), "dependency-tickets.json");
  saveState(path, { tickets: options.records ?? {}, reruns: {} });
  const box: { queue: Queue } = { queue: emptyQueue(2) };
  const said: string[] = [];
  const ctx = {
    codeHost: host, now: () => Date.parse("2026-11-10T12:00:00Z"), flakes: { record: () => {}, view: () => [] }, repliesRead: new Set<string>(), ownLogin: { value: "a11ign-workers" },
    ...(options.fixes === false ? {} : { fixes: fixReadsOf(path, () => box.queue, (line) => said.push(line)) }),
  } as unknown as PoolContext;
  return { host, ctx, box, path, said, set: (records: Record<string, DependencyEntry>) => saveState(path, { tickets: records, reruns: {} }) };
}

/** The watch's answer for one held pull request, recorded on its run as the watch records it. */
async function hold(made: ReturnType<typeof world>, entry: Entry, url: string, read: PullFeedback = feedback([CHECK]), reds: ForeignReds = redOn([CHECK])): Promise<Entry> {
  const answer = await answerChecks(made.ctx, entry, [{ url, read }], reds);
  return { ...entry, checkHeads: answer.withoutRound } as Entry;
}

test("A11-428: a check held as red on main with no owner is recorded with its error lines, and the board asks the writer for one fix ticket that quotes them", async () => {
  const made = world();
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  assert.deepEqual(held.checkHeads?.[URL_1], {
    head: HEAD, step: "not-ours", note: `${CHECK} is red on main / not this run's`, notOurs: { [CHECK]: null }, waitingOnMain: [CHECK], unowned: { [CHECK]: ERROR_LINES },
  }, "the card reads as it did, and the check is recorded as no one's, with the lines of its log");
  made.box.queue = { ...made.box.queue, entries: [held] };
  const requests = fixRequests(made.box.queue, {});
  assert.deepEqual(requests.map(({ key, repository }) => [key, repository]), [[KEY, REPO]], "one request, for the repository and the check");
  const text = await requests[0]!.request("A11");
  assert.match(text, /^unattended: file one ticket/, "the writer takes the unattended create");
  assert.ok(text.includes("```text\nnot ok 3 - migrate-host collects no tests\nAssertionError: expected 1 to equal 0\n```"), "the check's error lines are quoted as data");
  assert.ok(text.includes(`- **Check:** \`${CHECK}\``) && text.includes(`  - ${URL_1}`) && text.includes("- **Team:** `A11`"), "it names the check, the pull request it holds and the team");
});

test("A11-428: one fix ticket serves every pull request held on the same check: one request for both, and both cards name the fix once it is asked for and once it is filed", async () => {
  const made = world();
  const first = await hold(made, run("A11-500", URL_1), URL_1);
  const second = await hold(made, run("A11-501", URL_2), URL_2);
  made.box.queue = { ...made.box.queue, entries: [first, second] };
  const requests = fixRequests(made.box.queue, {});
  assert.equal(requests.length, 1, "one request for the repository and the check");
  assert.ok((await requests[0]!.request("A11")).includes(`  - ${URL_1}\n  - ${URL_2}`), "naming both pull requests it holds");
  made.set({ [KEY]: { state: "requested", writerRun: "wdep-1", at: 1, attempts: 0 } });
  const asked = await hold(made, first, URL_1);
  assert.equal(asked.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's; a fix ticket is being filed`);
  made.set({ [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } });
  for (const [entry, url] of [[first, URL_1], [second, URL_2]] as const) {
    const named = (await hold(made, entry, url)).checkHeads?.[url];
    assert.equal(named?.note, `${CHECK} is red on main / not this run's; owned by A11-600`, `${url}'s card names the fix ticket`);
    assert.deepEqual(named?.fixes, { [CHECK]: "A11-600" });
  }
  const filed = [await hold(made, first, URL_1), await hold(made, second, URL_2)];
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: filed }, { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } }), [], "no second request");
});

test("A11-428: a named owner still wins: a Blocked-by line names the owner, and no fix ticket is asked for that check", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const held = await hold(made, run("A11-500", URL_1), URL_1, feedback([CHECK], { body: "Refs A11-500\n\nBlocked-by: A11-381" }));
  const record = held.checkHeads?.[URL_1];
  assert.equal(record?.note, `${CHECK} is red on main / not this run's; owned by A11-381`);
  assert.deepEqual([record?.unowned, record?.fixes], [undefined, undefined], "the check is recorded as owned, and names no fix of the board's");
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [held] }, {}), [], "nothing is asked for");
});

test("A11-428: a fix ticket that does not land stays the owner: its run ended needs-human, and the held cards still name it, with no new request", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "open")] };
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  assert.equal(held.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's; owned by A11-600`);
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [...made.box.queue.entries, held] }, { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } }), []);
  assert.deepEqual(made.host.branchUpdates.asked, [], "and nothing is updated");
});

test("A11-428: when the fix ticket's pull request merges, every pull request held on the check is brought up to date with main, though main runs no CI, and the card says why its checks run again", async () => {
  const made = world({ records: { [fixKey("a11ign/toolchain", "gate")]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const toolchain = (number: number) => `https://github.com/a11ign/toolchain/pull/${number}`;
  for (const number of [40, 41]) made.host.seedPull("a11ign/toolchain", number, { head: HEAD });
  // Each is held on `gate` because the other fails it too; toolchain's main has no run of it at all.
  const elsewhere: ForeignReds = async () => ({ names: new Set(["gate"]), onMain: new Set(), mainPassing: new Set(), mainPending: new Set(), mainBranch: "main" });
  const runs = [run("A11-510", toolchain(40)), run("A11-511", toolchain(41))].map((entry) => ({ ...entry, paths: ["toolchain:src/"] }) as unknown as Entry);
  const held = [await hold(made, runs[0]!, toolchain(40), feedback(["gate"]), elsewhere), await hold(made, runs[1]!, toolchain(41), feedback(["gate"]), elsewhere)];
  assert.deepEqual(held.map((entry, at) => entry.checkHeads?.[toolchain(40 + at)]?.fixes), [{ gate: "A11-600" }, { gate: "A11-600" }], "both are held on gate, owned by the board's fix");
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "open")] };
  await hold(made, held[0]!, toolchain(40), feedback(["gate"]), elsewhere);
  assert.deepEqual(made.host.branchUpdates.asked, [], "nothing is updated while the fix is open");
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  const updated = [await hold(made, held[0]!, toolchain(40), feedback(["gate"]), elsewhere), await hold(made, held[1]!, toolchain(41), feedback(["gate"]), elsewhere)];
  assert.deepEqual(made.host.branchUpdates.asked.map(({ url, expectedHead }) => [url, expectedHead]), [[toolchain(40), HEAD], [toolchain(41), HEAD]], "both are updated from main, at the heads they were read at");
  for (const [at, entry] of updated.entries()) {
    assert.deepEqual(entry.checkHeads?.[toolchain(40 + at)], { head: HEAD, step: "updated", note: "A11-600 merged with the fix for gate: updated from main, so the checks run again", applied: ["A11-600"] });
  }
  assert.deepEqual(made.host.calls.filter((call) => /merge/i.test(call)), [], "the board merges nothing of its own: the fix merged through the repository's flow");
});

test("A11-428: red again on the new head, and red nowhere else, is the pull request's own: rerun once, then a worker round with its log lines", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const updated = run("A11-500", URL_1, { checkHeads: { [URL_1]: { head: HEAD, step: "updated", note: "A11-600 merged with the fix for checks (unit): updated from main, so the checks run again" } } });
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  const read = feedback([CHECK], { head: NEW_HEAD });
  const first = await answerChecks(made.ctx, updated, [{ url: URL_1, read }], redOn([]));
  assert.deepEqual([first.heads[URL_1]?.step, made.host.checksAndClaims.reruns], ["rerun", [[job(1)]]], "rerun once, as A11-300 does");
  const again = await answerChecks(made.ctx, { ...updated, checkHeads: first.withoutRound } as Entry, [{ url: URL_1, read }], redOn([]));
  assert.equal(again.heads[URL_1]?.step, "round");
  assert.ok((again.feedback ?? "").includes(`${CHECK} failed on the head commit of ${URL_1}:\n  ${ERROR_LINES[0]}`), "the round has the check's log lines");
  assert.deepEqual(made.host.branchUpdates.asked, [], "and nothing is updated again");
});

test("A11-428: a pull request the board cannot update after the fix merged keeps the fix as its owner, says why, and asks for no new fix", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  const stacked = await hold(made, held, URL_1, feedback([CHECK], { base: "admin/a11-150" }));
  assert.equal(stacked.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's; owned by A11-600; A11-600 merged, but the board cannot update from main (it is based on admin/a11-150, not on main): a person updates it`);
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [stacked] }, { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } }), [], "the check is not asked for again while it waits for its update");
  made.host.branchUpdates.answers.set(URL_1, { kind: "refused", reason: "HTTP 422" });
  const refused = await hold(made, held, URL_1);
  assert.equal(refused.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's; owned by A11-600; A11-600 merged, but the board could not update from main (HTTP 422), asked again next watch`);
});

test("A11-428: the fix after a merged fix is a new key, so a check red on main again is asked for again; a writer run that filed nothing is the same key, asked again by the sweep's own rule", () => {
  const merged = (ticket: string) => ticket === "A11-600";
  const filed: DependencyEntry = { state: "filed", ticket: "A11-600", queue: true, queued: true };
  assert.deepEqual(currentFix({ [KEY]: filed }, REPO, CHECK, merged), { key: `${KEY} after A11-600`, entry: undefined, lastMerged: "A11-600" });
  assert.deepEqual(currentFix({ [KEY]: filed }, REPO, CHECK, () => false), { key: KEY, entry: filed, lastMerged: null });
  const failed: DependencyEntry = { state: "failed", attempts: 1, at: 1, reason: "the run made no ticket" };
  assert.deepEqual(currentFix({ [KEY]: failed }, REPO, CHECK, merged), { key: KEY, entry: failed, lastMerged: null });
});

test("A11-428: with tickets.fixRedMain off, a held check is recorded and read as it was before: no error lines, no fix, and nothing to ask for", async () => {
  const made = world({ fixes: false, records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  assert.deepEqual(held.checkHeads?.[URL_1], { head: HEAD, step: "not-ours", note: `${CHECK} is red on main / not this run's`, notOurs: { [CHECK]: null }, waitingOnMain: [CHECK] });
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [held] }, {}), []);
});

test("A11-428: a fix record that cannot be read names no fix, and says why once", async () => {
  const made = world();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(made.path, "{ not json");
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  await hold(made, held, URL_1);
  assert.equal(held.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's`);
  assert.equal(made.said.length, 1);
  assert.match(made.said[0]!, /fix tickets for checks red on main cannot be read/);
});

test("A11-428: a stale record asks for nothing: a held pull request that merged or closed, or a run that left finished, keeps its last record, which names no check to fix", async () => {
  const made = world();
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  assert.equal(fixRequests({ ...made.box.queue, entries: [held] }, {}).length, 1, "the open, finished run's hold is asked for");
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [{ ...held, pullStates: { [URL_1]: "closed" } } as Entry] }, {}), [], "its pull request closed: nothing");
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [{ ...held, phase: "running" } as Entry] }, {}), [], "its run is answering a round: nothing");
});

test("A11-428: a pull request held afresh after the fix merged names that fix and is brought up to date for it, and no second fix is asked for until it is red again after taking it", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  const fresh = await hold(made, run("A11-501", URL_2), URL_2);
  assert.equal(fresh.checkHeads?.[URL_2]?.note, `${CHECK} is red on main / not this run's; owned by A11-600`, "the merged fix it has not taken is its owner");
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [fresh] }, { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } }), [], "no second fix is asked for");
  const updated = await hold(made, fresh, URL_2);
  assert.deepEqual([updated.checkHeads?.[URL_2]?.step, made.host.branchUpdates.asked.map(({ url }) => url)], ["updated", [URL_2]], "the next watch brings it up to date with main");
  const again = await hold(made, updated, URL_2, feedback([CHECK], { head: NEW_HEAD }));
  const record = again.checkHeads?.[URL_2];
  assert.deepEqual([record?.note, record?.fixes, record?.applied], [`${CHECK} is red on main / not this run's`, undefined, ["A11-600"]], "red on main again after taking the fix: it is no one's");
  assert.deepEqual(fixRequests({ ...made.box.queue, entries: [...made.box.queue.entries, again] }, { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } }).map(({ key }) => key), [`${KEY} after A11-600`], "so a new fix is asked for, under the next key");
  assert.equal(made.host.branchUpdates.asked.length, 1, "and the pull request is not updated again for the fix it took");
});

test("A11-428: an update that finds the branch already has the fix takes the fix, and the hold is read afresh: no update on every watch", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const held = await hold(made, run("A11-500", URL_1), URL_1);
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  made.host.branchUpdates.answers.set(URL_1, { kind: "up-to-date" });
  const first = await hold(made, held, URL_1);
  assert.deepEqual([first.checkHeads?.[URL_1]?.step, first.checkHeads?.[URL_1]?.applied, first.checkHeads?.[URL_1]?.fixes], ["not-ours", ["A11-600"], undefined]);
  await hold(made, first, URL_1);
  assert.equal(made.host.branchUpdates.asked.length, 1, "asked once");
});

test("A11-428: a held pull request whose fix merged while its run holds a workspace is answered as any hold is, on every watch: a check no longer red elsewhere goes back to the run", async () => {
  const made = world({ records: { [KEY]: { state: "filed", ticket: "A11-600", queue: true, queued: true } } });
  const held = { ...(await hold(made, run("A11-500", URL_1), URL_1)), workspace: "w2" } as Entry;
  made.box.queue = { ...made.box.queue, entries: [fixRun("A11-600", "merged")] };
  const stillHeld = await hold(made, held, URL_1);
  assert.equal(stillHeld.checkHeads?.[URL_1]?.note, `${CHECK} is red on main / not this run's; owned by A11-600`, "it still names the fix, and is not updated under the worker");
  const own = await answerChecks(made.ctx, held, [{ url: URL_1, read: feedback([CHECK]) }], redOn([]));
  assert.equal(own.heads[URL_1]?.step, "rerun", "red nowhere else: the A11-300 rerun, as before");
  assert.deepEqual(made.host.branchUpdates.asked, []);
});
