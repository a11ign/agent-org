// no-token: gh -- pure functions over a job log's text, and the fake code host that answers each read
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLinesOfLog } from "../ci-log-lines.ts";
import { answerChecks, infrastructureCause } from "./pool-checks.ts";
import { foreignRedsOf } from "./pool-foreign-checks.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
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

function world(logs: Record<string, string> = {}) {
  const host = createFakeCodeHost();
  for (const [url, text] of Object.entries(logs)) host.checksAndClaims.logs.set(url, text);
  return { host, ctx: { codeHost: host } as unknown as PoolContext };
}
const REFUSAL = stamped(["refusalOwners: REFUSED -- A11-127 retires this check", "##[error]Process completed with exit code 1."]);
const TEST_FAILED = stamped(["not ok 3 - git spawn classification", "AssertionError: expected 1 to equal 2"]);

test("A11-179: a check that fails on the default branch too starts no round and is named red on main / not this run's, and a check main does not fail is still the run's", () => {
  const { ctx, host } = world({ [job(1)]: REFUSAL, [job(2)]: TEST_FAILED });
  const onMain = () => (_entry: Entry, _url: string) => new Set(["refusalOwners"]);
  const mixed = answerChecks(ctx, own(), [{ url: URL_1, read: feedback(["refusalOwners", "suite"]) }], onMain());
  assert.match(mixed.feedback ?? "", /^suite failed on the head commit of /m, "the run's own check gets its round");
  assert.match(mixed.feedback ?? "", /refusalOwners also failed on the head commit of .* fails on the default branch or on pull requests that touch none of your files: that is not a fault in your change, so leave it\.$/, "and the brief says the other is not its");
  assert.deepEqual(mixed.heads, { [URL_1]: { head: HEAD, step: "round" } });
  const only = answerChecks(ctx, own(), [{ url: URL_1, read: feedback(["refusalOwners"]) }], onMain());
  assert.equal(only.feedback, null, "nothing is red that the run can mend: no round");
  assert.deepEqual(only.heads, { [URL_1]: { head: HEAD, step: "not-ours", note: "refusalOwners is red on main / not this run's; owned by A11-127", notOurs: { refusalOwners: "A11-127" } } });
  assert.deepEqual(only.withoutRound, only.heads, "and the record is kept without a round, so the card names it");
  assert.deepEqual(host.checksAndClaims.reruns, [], "it is not rerun");
});

test("A11-179: a check red on another run's pull request in the same repository that changes none of this run's plan paths is not this run's, and one that touches them is", () => {
  const { ctx } = world({ [job(1)]: TEST_FAILED });
  const mine = own();
  const other = (files: readonly string[], over: Partial<PullFeedback> = {}) => ({ entry: own("A11-150", ["agent-org:src/other/"], URL_2), open: [{ url: URL_2, read: feedback(["suite"], files, over) }] });
  const answer = (outside: ReturnType<typeof other>) =>
    answerChecks(ctx, mine, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: mine, open: [{ url: URL_1, read: feedback(["suite"]) }] }, outside]));
  assert.deepEqual(answer(other(["src/other/thing.ts"])).heads[URL_1]?.step, "not-ours", "the same check is red where this run's files are not");
  assert.deepEqual(answer(other(["src/ticket-mode/pool-checks.ts"])).heads[URL_1]?.step, "round", "a pull request that touches the run's region says nothing of it");
  assert.deepEqual(answer(other(["src/other/thing.ts"], { filesComplete: false })).heads[URL_1]?.step, "round", "a list of files cut short may touch it");
  const noPaths = own("A11-177", []);
  const free = answerChecks(ctx, noPaths, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: noPaths, open: [{ url: URL_1, read: feedback(["suite"]) }] }, other(["src/other/thing.ts"])]));
  assert.equal(free.heads[URL_1]?.step, "round", "a run whose plan declares no paths has no region to compare with");
  const elsewhere = { entry: own("A11-150", ["agent-org:src/other/"], "https://github.com/a11ign/control/pull/9"), open: [{ url: "https://github.com/a11ign/control/pull/9", read: feedback(["suite"], ["src/other/thing.ts"]) }] };
  assert.equal(answer(elsewhere).heads[URL_1]?.step, "round", "a pull request of another repository says nothing of it");
  const mineAgain = foreignRedsOf(ctx, [{ entry: mine, open: [{ url: URL_1, read: feedback(["suite"]) }] }]);
  assert.deepEqual([...mineAgain(mine, URL_1)], [], "a run's own pull request is not another's");
});

test("A11-179: the ticket that owns a red check is the one a Blocked-by line names, else one the check's refusal names, never the run's own, and none when none is named", () => {
  const owned = (log: string, body: string | undefined, key = "A11-177") => {
    const { ctx } = world({ [job(1)]: log });
    const read = feedback(["refusalOwners"], ["src/ticket-mode/pool.ts"], body === undefined ? {} : { body });
    return answerChecks(ctx, own(key), [{ url: URL_1, read }], () => new Set(["refusalOwners"])).heads[URL_1]?.note;
  };
  assert.equal(owned(REFUSAL, undefined), "refusalOwners is red on main / not this run's; owned by A11-127", "the check's refusal text names it");
  assert.equal(owned(REFUSAL, "Refs A11-177\n\nBlocked-by: A11-130"), "refusalOwners is red on main / not this run's; owned by A11-130", "a Blocked-by line comes first");
  assert.equal(owned(TEST_FAILED, "Blocked-by: A11-177, NBL-9"), "refusalOwners is red on main / not this run's; owned by NBL-9", "the run's own key is no owner, and a blocker of another team is read");
  assert.equal(owned(stamped(["REFUSED -- A11-177 itself", "not ok - UTF-8 handling, SHA-256 digest"]), ""), "refusalOwners is red on main / not this run's", "its own key, and words that only look like keys, name no owner");
  assert.equal(owned(REFUSAL, undefined, "A11-127"), "refusalOwners is red on main / not this run's", "a run that is the owner has no other");
});

test("A11-179: a check red elsewhere is looked at again on every watch: the log that named its owner is not read again, and the record goes once the check is the run's or green", () => {
  const { ctx, host } = world({ [job(1)]: REFUSAL });
  const entry = own();
  const first = answerChecks(ctx, entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], () => new Set(["refusalOwners"]));
  const reads = () => host.calls.filter((call) => call.startsWith("readCheckLog")).length;
  assert.equal(reads(), 1);
  const again = answerChecks(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], () => new Set(["refusalOwners"]));
  assert.deepEqual([again.heads, reads()], [first.heads, 1], "the same answer, with no second read of the log");
  const ours = answerChecks(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], () => new Set());
  assert.deepEqual([ours.heads[URL_1]?.step, ours.feedback !== null], ["round", true], "main is green: the check is the run's, and gets its round");
  const green = answerChecks(ctx, { ...entry, checkHeads: first.heads } as Entry, [{ url: URL_1, read: feedback([]) }], () => new Set());
  assert.deepEqual([green.heads, green.feedback], [{}, null], "nothing is red: the record is dropped");
  const answered = { [URL_1]: { head: HEAD, step: "round" as const } };
  const kept = answerChecks(ctx, { ...entry, checkHeads: answered } as Entry, [{ url: URL_1, read: feedback(["refusalOwners"]) }], () => new Set(["refusalOwners"]));
  assert.deepEqual([kept.heads, kept.feedback], [answered, null], "a head the board already answered with a round is answered: it is not looked at again");
});

test("A11-179: a run sequenced with another on purpose, as its blocker or its dependent, is not told a failure is not its own because the other's pull request fails it too", () => {
  const { ctx } = world({ [job(1)]: TEST_FAILED });
  const mine = { ...own(), blockers: [{ key: "A11-150" }] } as unknown as Entry;
  const stacked = { entry: own("A11-150", ["agent-org:src/other/"], URL_2), open: [{ url: URL_2, read: feedback(["suite"], ["src/other/thing.ts"]) }] };
  const answer = (self: Entry, other: typeof stacked) => answerChecks(ctx, self, [{ url: URL_1, read: feedback(["suite"]) }], foreignRedsOf(ctx, [{ entry: self, open: [{ url: URL_1, read: feedback(["suite"]) }] }, other]));
  assert.equal(answer(own(), stacked).heads[URL_1]?.step, "not-ours", "an independent run's failure of the same check is read as not this run's");
  assert.equal(answer(mine, stacked).heads[URL_1]?.step, "round", "a run stacked on the other runs its checks over its code: the other's failure is its own");
  const dependent = { ...stacked, entry: { ...stacked.entry, blockers: [{ key: "A11-177" }] } as unknown as Entry };
  assert.equal(answer(own(), dependent).heads[URL_1]?.step, "round", "and so does the run the other is stacked on");
});

test("A11-179: the owner is never read from a failing test's title, which names tickets as well: only a line that says the check refused names one", () => {
  const titled = stamped(["not ok 3 - A11-154: a red check starts a round", "AssertionError: expected 1 to equal 2"]);
  const { ctx } = world({ [job(1)]: titled });
  const note = answerChecks(ctx, own(), [{ url: URL_1, read: feedback(["suite"]) }], () => new Set(["suite"])).heads[URL_1]?.note;
  assert.equal(note, "suite is red on main / not this run's", "no owner is named");
});
