// no-token: gh -- `readPullFeedback` and `readOwnLogin` are handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import { MAX_FILE_PAGES, pullOf, readOwnLogin, readPullFeedback as read } from "./pull-feedback.ts";
import type { PullSnapshots } from "./pull-snapshot.ts";
import { snapshotsHolding, snapshotsOf } from "./pull-snapshot-fixture.ts";

/** The read, with core's own policy for which checks are red: what the plugin is given in a host. */
const readPullFeedback = (url: string, self: string, snapshots: PullSnapshots, alsoIgnore: readonly string[] = []) => read(url, self, snapshots, corePolicy(), alsoIgnore);

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;
const ms = (minute: number) => Date.parse(at(minute));

/** Snapshots that hold `pull` as the pull request (`null`: the repository has none), as `run`, which the read is handed. */
function answering(pull: Record<string, unknown> | null) {
  return { run: pull === null ? snapshotsOf({ "netboxlabs/nbl-ui-netbox": [] }) : snapshotsHolding(pull) };
}

const pullWith = ({ state = "OPEN", reviews = [] as unknown[], comments = [] as unknown[], threads = [] as unknown[], checks = [] as unknown[], mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN", base = "main", files = [] as string[], head = undefined as string | undefined, reviewDecision = undefined as string | null | undefined, body = undefined as string | undefined, autoMergeRequest = undefined as { enabledAt: string } | null | undefined } = {}) => ({
  state, headRefOid: head, reviewDecision, body, autoMergeRequest, mergeable, mergeStateStatus, baseRefName: base, files: { nodes: files.map((path) => ({ path })), pageInfo: { hasNextPage: false, endCursor: null } },
  reviews: { nodes: reviews }, comments: { nodes: comments }, reviewThreads: { nodes: threads.map((c) => ({ comments: { nodes: [c] } })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
});

test("the newest review, conversation comment or inline comment by anyone but the workers' account is the feedback, its authors newest first", () => {
  const { run } = answering(pullWith({
    reviews: [
      { state: "CHANGES_REQUESTED", submittedAt: at(5), author: { login: "a11ign-reviewer" } },
      { state: "APPROVED", submittedAt: at(40), author: { login: "alice" } },
      { state: "COMMENTED", submittedAt: at(50), author: { login: "worker-bot" } },
    ],
    comments: [{ createdAt: at(10), author: { login: "bob" } }, { createdAt: at(55), author: { login: "worker-bot" } }],
    threads: [{ createdAt: at(20), author: { login: "carol" } }],
  }));
  const read = readPullFeedback(URL, "worker-bot", run);
  assert.deepEqual(read, { state: "open", feedbackAt: ms(20), authors: ["carol", "bob", "a11ign-reviewer"], failing: [], failures: [], failedAt: null, conflicting: false, behind: false, mergeable: true, head: null, approvedAtHead: false, base: "main", files: [], filesComplete: true,
    verdictAtHead: null, pendingRequired: [], body: "", blocked: false, cancelledRequired: [] },
    "an approval and the workers' own comments are not feedback");
  assert.deepEqual(run.reads.pulls, [["netboxlabs/nbl-ui-netbox", 806]], "the pull request is read once, from the snapshot of its repository");
});

test("the failing checks are the required ones, or every one where none is required, newest per name, and a cancelled run is not a failure", () => {
  const run = (name: string, conclusion: string | null, minute: number, isRequired = false) => ({ __typename: "CheckRun", name, conclusion, completedAt: at(minute), isRequired });
  const unrequired = readPullFeedback(URL, "me", answering(pullWith({ checks: [
    run("typecheck", "FAILURE", 10), run("typecheck", "SUCCESS", 20), run("suite", "TIMED_OUT", 30), run("lint", "CANCELLED", 40),
    { __typename: "StatusContext", context: "netlify", state: "ERROR", createdAt: at(35), isRequired: false },
  ] })).run);
  assert.deepEqual([unrequired?.failing, unrequired?.failedAt], [["suite", "netlify"], ms(35)], "a re-run that passed replaces the failure it re-ran");
  const required = readPullFeedback(URL, "me", answering(pullWith({ checks: [run("gate", "SUCCESS", 10, true), run("suite", "FAILURE", 30)] })).run);
  assert.deepEqual([required?.failing, required?.failedAt], [[], null], "with a required check, only the required ones count");
});

test("A11-286: BEHIND reads as behind, and CLEAN, DIRTY and a pull request still being computed as not", () => {
  const behindOf = (mergeStateStatus: string) => readPullFeedback(URL, "me", answering(pullWith({ mergeStateStatus })).run)?.behind;
  assert.equal(behindOf("BEHIND"), true);
  assert.deepEqual(["CLEAN", "DIRTY", "BLOCKED", "UNKNOWN"].map(behindOf), [false, false, false, false]);
});

test("A11-82: a pull request that conflicts with its base is conflicting, whichever GitHub says it by, and one still being computed is not", () => {
  const conflicting = (fields: Parameters<typeof pullWith>[0]) => readPullFeedback(URL, "me", answering(pullWith(fields)).run);
  assert.deepEqual([conflicting({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })?.conflicting, conflicting({ mergeable: "CONFLICTING" })?.conflicting], [true, true]);
  assert.equal(conflicting({ mergeStateStatus: "DIRTY" })?.conflicting, true, "a DIRTY pull request with a mergeable of its own is still conflicting");
  for (const state of [{ mergeable: "MERGEABLE" }, { mergeStateStatus: "BEHIND" }, { mergeStateStatus: "BLOCKED" }, { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }]) {
    assert.equal(conflicting(state)?.conflicting, false, `${JSON.stringify(state)} is no conflict`);
  }
  const read = conflicting({ base: "release/2", files: ["src/ticket-mode/pool.ts", "src/ticket-mode/server.ts"] });
  assert.deepEqual([read?.base, read?.files], ["release/2", ["src/ticket-mode/pool.ts", "src/ticket-mode/server.ts"]], "the base and the files it changes are read");
  const page = (paths: string[], hasNextPage: boolean, endCursor: string | null) => ({ nodes: paths.map((path) => ({ path })), pageInfo: { hasNextPage, endCursor } });
  const paged = (pages: { first: unknown; second?: unknown }) => snapshotsHolding({ ...pullWith(), files: pages.first }, { files: pages.second === undefined ? {} : { c1: pages.second } });
  const paging = readPullFeedback(URL, "me", paged({ first: page(["a.ts"], true, "c1"), second: page(["b.ts"], false, null) }));
  assert.deepEqual([paging?.files, paging?.filesComplete], [["a.ts", "b.ts"], true], "every page is read, and the list is then complete");
  let calls = 0;
  const forever = snapshotsHolding({ ...pullWith(), files: page(["a.ts"], true, "c1") }, { files: () => { calls += 1; return page(["a.ts"], true, "c1"); } });
  const cut = readPullFeedback(URL, "me", forever);
  assert.deepEqual([cut?.filesComplete, calls], [false, MAX_FILE_PAGES - 1], "pages past the cap are not read (the first page came with the pull request), and the list says it is cut short");
  assert.equal(readPullFeedback(URL, "me", paged({ first: page(["a.ts"], true, "c1") })), null, "a page that cannot be read is no reading at all");
  const answered = (files: unknown) => readPullFeedback(URL, "me", snapshotsHolding({ ...pullWith(), files }));
  for (const [why, files] of [
    ["missing", undefined], ["null", null], ["not an object", "all of them"], ["without its nodes", { pageInfo: { hasNextPage: false, endCursor: null } }],
    ["without its pageInfo", { nodes: [{ path: "a.ts" }] }], ["with a pageInfo that does not say if more follow", { nodes: [], pageInfo: {} }],
    ["with a node that has no path", { nodes: [{}], pageInfo: { hasNextPage: false, endCursor: null } }],
  ] as const) {
    assert.equal(answered(files)?.filesComplete, false, `a first page ${why} leaves the files unknown, not none`);
  }
  assert.deepEqual([answered(page([], false, null))?.files, answered(page([], false, null))?.filesComplete], [[], true], "a page of no files that says no more follow is a complete, empty list");
  const brokenSecond = readPullFeedback(URL, "me", paged({ first: page(["a.ts"], true, "c1"), second: { nodes: [{ path: "b.ts" }] } }));
  assert.deepEqual([brokenSecond?.files, brokenSecond?.filesComplete], [["a.ts"], false], "a later page of another shape adds nothing and leaves the list incomplete");
});

test("a pull request that cannot be read is null, never no feedback, and a merged or closed one says so", () => {
  assert.equal(readPullFeedback(URL, "me", snapshotsOf({})), null, "a repository the snapshots cannot read");
  assert.equal(readPullFeedback(URL, "me", answering(null).run), null, "no such pull request");
  assert.equal(readPullFeedback(URL, "me", snapshotsHolding({ number: 806, state: undefined })), null, "an answer without a state");
  assert.equal(readPullFeedback("https://linear.app/x/issue/NBF-1", "me", answering(pullWith()).run), null, "not a pull request's address");
  assert.equal(readPullFeedback(URL, "me", answering(pullWith({ state: "MERGED" })).run)?.state, "merged");
  assert.equal(readPullFeedback(URL, "me", answering(pullWith({ state: "CLOSED" })).run)?.state, "closed");
  assert.deepEqual(pullOf(URL), { owner: "netboxlabs", repo: "nbl-ui-netbox", number: 806 });
});

test("the workers' account is the login gh acts as, and null when gh cannot say", () => {
  assert.equal(readOwnLogin((args) => (args.join(" ") === "api user --jq .login" ? "worker-bot\n" : "")), "worker-bot");
  assert.equal(readOwnLogin(() => { throw new Error("not logged in"); }), null);
  assert.equal(readOwnLogin(() => "\n"), null);
});

test("A11-153: the head commit, whether GitHub says the pull request is mergeable, and whether a reviewer other than the workers' account approved that head are read", () => {
  const read = (fields: Parameters<typeof pullWith>[0]) => readPullFeedback(URL, "worker-bot", answering(pullWith(fields)).run);
  const review = (state: string, minute: number, oid: string, login = "a11ign-reviewer") => ({ state, submittedAt: at(minute), author: { login }, commit: { oid } });
  assert.equal(read({ head: "h2" })?.head, "h2");
  assert.equal(read({})?.head, null, "a pull request GitHub gives no head for has none");
  assert.deepEqual(["MERGEABLE", "UNKNOWN", "CONFLICTING"].map((mergeable) => read({ mergeable })?.mergeable), [true, false, false], "UNKNOWN is not mergeable");
  assert.equal(read({ head: "h2", reviews: [review("APPROVED", 5, "h2")] })?.approvedAtHead, true);
  assert.equal(read({ head: "h2", reviews: [review("APPROVED", 5, "h1")] })?.approvedAtHead, false, "an approval of an earlier commit says nothing of the head");
  assert.equal(read({ head: "h2", reviews: [review("APPROVED", 5, "h2"), review("CHANGES_REQUESTED", 9, "h2")] })?.approvedAtHead, false, "the newest verdict on the head decides");
  assert.equal(read({ head: "h2", reviews: [review("CHANGES_REQUESTED", 5, "h2"), review("APPROVED", 9, "h2")] })?.approvedAtHead, true);
  assert.equal(read({ head: "h2", reviews: [review("APPROVED", 5, "h2", "worker-bot")] })?.approvedAtHead, false, "the workers' own account does not approve its own work");
  assert.equal(read({ head: "h2", reviews: [review("COMMENTED", 9, "h2"), review("APPROVED", 5, "h2")] })?.approvedAtHead, true, "a comment takes no side");
  assert.equal(read({ reviews: [review("APPROVED", 5, "h2")] })?.approvedAtHead, false, "with no head to approve there is no approval");
});

test("A11-154: each failing check carries the address of its job's page, from the newest run of its name, and a check with none carries null", () => {
  const job = (id: number) => `https://github.com/netboxlabs/nbl-ui-netbox/actions/runs/${id}/job/${id + 1}`;
  const run = (name: string, conclusion: string, minute: number, detailsUrl: string | null) => ({ __typename: "CheckRun", name, conclusion, completedAt: at(minute), detailsUrl, isRequired: false });
  const read = readPullFeedback(URL, "me", answering(pullWith({ head: "a".repeat(40), checks: [
    run("suite", "FAILURE", 10, job(100)), run("suite", "FAILURE", 20, job(200)), run("typecheck", "SUCCESS", 5, job(300)), run("typecheck", "FAILURE", 1, job(150)),
    run("lint", "FAILURE", 30, null), { __typename: "StatusContext", context: "netlify", state: "FAILURE", createdAt: at(35), isRequired: false },
  ] })).run);
  assert.deepEqual(read?.failures, [{ name: "suite", detailsUrl: job(200) }, { name: "lint", detailsUrl: null }, { name: "netlify", detailsUrl: null }],
    "the newest run of a name, its address or none; a commit status has no job page; a name that passed since is not failing");
  assert.deepEqual(read?.failing, ["suite", "lint", "netlify"], "the names are the ones the board has always read");
  assert.equal(read?.head, "a".repeat(40), "the head the checks ran on is the head they are answered at");
  assert.deepEqual(readPullFeedback(URL, "me", answering(pullWith({ head: "b".repeat(40) })).run)?.failures, [], "a green head has none");
});

test("A11-154: a job behind a required roll-up that failed is listed with the checks, though the board answers only the required one", () => {
  const run = (name: string, minute: number, isRequired: boolean) => ({ __typename: "CheckRun", name, conclusion: "FAILURE", completedAt: at(minute), detailsUrl: `https://github.com/x/y/actions/runs/${minute}/job/${minute + 1}`, isRequired });
  const read = readPullFeedback(URL, "me", answering(pullWith({ head: "a".repeat(40), checks: [run("gate", 30, true), run("suite", 20, false), run("lint", 10, false)] })).run);
  assert.deepEqual(read?.failing, ["gate"], "only the required check is answered");
  assert.deepEqual(read?.failures?.map(({ name }) => name), ["gate", "suite", "lint"], "and the jobs behind it are listed with it");
  const passing = readPullFeedback(URL, "me", answering(pullWith({ checks: [{ ...run("gate", 30, true), conclusion: "SUCCESS" }, run("suite", 20, false)] })).run);
  assert.deepEqual([passing?.failing, passing?.failures?.map(({ name }) => name)], [[], ["suite"]], "a non-required check that is red beside a required one that passed answers nothing");
});

test("A11-179: the verdict at the head counts the reviewer's account as well as anyone's, and leaves out the workers' own, where approvedAtHead leaves out the accounts it is told to", () => {
  const review = (state: string, minute: number, oid: string, login: string) => ({ state, submittedAt: at(minute), author: { login }, commit: { oid } });
  const read = (reviews: unknown[]) => readPullFeedback(URL, "worker-bot", answering(pullWith({ head: "h2", reviews })).run, ["a11ign-reviewer"]);
  const approved = read([review("APPROVED", 5, "h2", "a11ign-reviewer")]);
  assert.deepEqual([approved?.approvedAtHead, approved?.verdictAtHead], [false, "approved"], "the reviewer's approval is the board's verdict, and not a person's answer to its feedback");
  assert.equal(read([review("APPROVED", 5, "h1", "alice")])?.verdictAtHead, null, "an approval of an earlier commit says nothing of the head");
  assert.equal(read([review("APPROVED", 5, "h2", "alice"), review("CHANGES_REQUESTED", 9, "h2", "a11ign-reviewer")])?.verdictAtHead, "changes-requested", "the newest verdict on the head decides");
  assert.equal(read([review("APPROVED", 5, "h2", "worker-bot")])?.verdictAtHead, null, "the workers' own account does not approve its own work");
  assert.equal(read([review("COMMENTED", 9, "h2", "alice")])?.verdictAtHead, null, "a comment takes no side");
  const headless = readPullFeedback(URL, "worker-bot", answering(pullWith({ reviews: [review("APPROVED", 5, "h2", "alice")] })).run);
  assert.equal(headless?.verdictAtHead, null, "with no head there is nothing to approve");
});

test("A11-179: GitHub's review decision is read in the board's words, null for a branch that requires no review, and left out when GitHub does not say", () => {
  const decision = (reviewDecision: string | null | undefined) => readPullFeedback(URL, "me", answering(pullWith({ reviewDecision })).run);
  assert.deepEqual(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null].map((value) => decision(value)?.reviewDecision), ["approved", "changes-requested", "review-required", null]);
  assert.equal("reviewDecision" in (decision(undefined) ?? {}), false, "an answer without it is no answer: absent is not null");
  assert.equal("reviewDecision" in (decision("SOMETHING_NEW") ?? {}), false, "nor is a word this does not know");
});

test("A11-179: the checks that have not passed are named, newest run per name: running, cancelled or stale ones, and only the required ones where any is required", () => {
  const run = (name: string, conclusion: string | null, minute: number, isRequired: boolean) => ({ __typename: "CheckRun", name, conclusion, startedAt: at(minute), completedAt: conclusion === null ? null : at(minute), isRequired });
  const pending = (checks: unknown[]) => readPullFeedback(URL, "me", answering(pullWith({ checks })).run)?.pendingRequired;
  assert.deepEqual(pending([run("gate", null, 10, true), run("suite", null, 11, false), run("lint", "SUCCESS", 12, true)]), ["gate"], "a required check with no conclusion is pending; one that is not required, or has passed, is not");
  assert.deepEqual(pending([run("gate", "CANCELLED", 10, true), run("lint", "STALE", 11, true), run("docs", "SKIPPED", 12, true), run("types", "NEUTRAL", 13, true)]), ["gate", "lint"], "GitHub holds a merge on a cancelled or stale required check, and not on a skipped or neutral one");
  assert.deepEqual(pending([run("gate", "FAILURE", 10, true)]), [], "a failure is red, which `failing` says, and not pending");
  assert.deepEqual(pending([run("gate", "FAILURE", 10, true), run("gate", null, 20, true)]), ["gate"], "a rerun that is under way replaces the failure it re-runs");
  assert.deepEqual(pending([run("gate", null, 10, true), run("gate", "SUCCESS", 20, true)]), [], "and a run that finished after it replaces one still shown running");
  assert.deepEqual(pending([run("suite", null, 10, false), run("lint", "SUCCESS", 11, false), run("docs", "CANCELLED", 12, false)]), ["suite", "docs"], "with no required check every check counts, as it does for the red ones");
  assert.deepEqual(pending([{ __typename: "StatusContext", context: "netlify", state: "PENDING", createdAt: at(5), isRequired: true }, { __typename: "StatusContext", context: "audit", state: "SUCCESS", createdAt: at(5), isRequired: true }]), ["netlify"], "a commit status is pending while it says so");
  assert.deepEqual(pending([]), [], "a head with no checks has none pending");
});

test("A11-179: the pull request's body is read, for the `Blocked-by:` line that names the ticket owning what it waits on", () => {
  const read = (body: string | undefined) => readPullFeedback(URL, "me", answering(pullWith({ body })).run);
  assert.equal(read("Refs A11-179\n\nBlocked-by: A11-127")?.body, "Refs A11-179\n\nBlocked-by: A11-127");
  assert.equal(read(undefined)?.body, "", "a body GitHub does not give is empty");
});

test("A11-291: `armed` says whether auto-merge is on for the pull request, and is left out when the answer does not carry the field", () => {
  const armedOf = (autoMergeRequest: { enabledAt: string } | null | undefined) => readPullFeedback(URL, "worker-bot", answering(pullWith({ autoMergeRequest })).run);
  assert.equal(armedOf({ enabledAt: at(5) })?.armed, true, "auto-merge is enabled");
  assert.equal(armedOf(null)?.armed, false, "GitHub answers null for a pull request with auto-merge off");
  assert.equal(Object.hasOwn(armedOf(undefined) ?? {}, "armed"), false, "an answer without the field is the host not saying, which is not 'off'");
});

const RUN_URL = (run: number, job: number) => `https://github.com/a11ign/announcement-emulator/actions/runs/${run}/job/${job}`;
const gateRun = (conclusion: string | null, run: number, minute: number, isRequired = true, name = "gate") => ({ __typename: "CheckRun", name, conclusion, completedAt: at(minute), detailsUrl: RUN_URL(run, run + 1), isRequired });

test("A11-342: BLOCKED reads as blocked, and CLEAN, BEHIND and a pull request still being computed as not", () => {
  const blockedOf = (mergeStateStatus: string) => readPullFeedback(URL, "me", answering(pullWith({ mergeStateStatus })).run)?.blocked;
  assert.deepEqual(["BLOCKED", "CLEAN", "BEHIND", "DIRTY", "UNKNOWN"].map(blockedOf), [true, false, false, false, false]);
});

test("A11-342: a required check whose runs on the head are one green and one cancelled lists the cancelled run, which the other run's green does not excuse", () => {
  const read = readPullFeedback(URL, "me", answering(pullWith({ mergeStateStatus: "BLOCKED", checks: [gateRun("SUCCESS", 40438392487, 30), gateRun("CANCELLED", 40438392613, 31)] })).run);
  assert.deepEqual(read?.cancelledRequired, [{ name: "gate", detailsUrl: RUN_URL(40438392613, 40438392614) }], "only the cancelled run is listed, with the address of its job");
  assert.deepEqual([read?.blocked, read?.failing, read?.pendingRequired], [true, [], ["gate"]], "it is not a failure; it is a required check that has not passed");
});

test("A11-342: a required run that failed or is still running, beside a cancelled one, leaves the list empty: the pull request waits on something else", () => {
  const listed = (checks: unknown[]) => readPullFeedback(URL, "me", answering(pullWith({ mergeStateStatus: "BLOCKED", checks })).run)?.cancelledRequired;
  assert.deepEqual(listed([gateRun("CANCELLED", 1, 30), gateRun("FAILURE", 3, 31, true, "suite")]), [], "a red required check");
  assert.deepEqual(listed([gateRun("CANCELLED", 1, 30), gateRun(null, 3, 31, true, "suite")]), [], "a required check still running");
  assert.deepEqual(listed([gateRun("CANCELLED", 1, 30), { __typename: "StatusContext", context: "netlify", state: "PENDING", createdAt: at(32), isRequired: true }]), [], "a required commit status that has not passed");
  assert.deepEqual(listed([gateRun("CANCELLED", 1, 30, false), gateRun("SUCCESS", 3, 31)]), [], "a cancelled run of a check that is not required blocks nothing");
  assert.deepEqual(listed([gateRun("SUCCESS", 1, 30), gateRun("SKIPPED", 3, 31, true, "docs"), gateRun("NEUTRAL", 5, 32, true, "types")]), [], "all green, skipped and neutral: nothing is cancelled");
});

test("A11-342: a rollup cut at 100 entries says nothing is only cancelled, since a red or running required run may be past the cut", () => {
  const pull = pullWith({ mergeStateStatus: "BLOCKED", checks: [gateRun("SUCCESS", 1, 30), gateRun("CANCELLED", 3, 31)] });
  const cut = (hasNextPage: boolean) => ({ ...pull, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage }, nodes: pull.commits.nodes[0].commit.statusCheckRollup.contexts.nodes } } } }] } });
  assert.deepEqual(readPullFeedback(URL, "me", answering(cut(false)).run)?.cancelledRequired?.map(({ name }) => name), ["gate"]);
  assert.deepEqual(readPullFeedback(URL, "me", answering(cut(true)).run)?.cancelledRequired, []);
});

/** The feedback read of a pull request in a repository that is `private` and holds the merge bot on its default branch (`bot`) or on the pull request's head (`headBot`) or not; the snapshots it is read from are returned beside it. */
const readInRepository = (repository: { isPrivate?: boolean; bot?: unknown; headBot?: unknown }, checks: unknown[], hasNextPage = false) => {
  const pull = pullWith({ checks, head: "b".repeat(40) });
  pull.commits.nodes[0].commit.statusCheckRollup.contexts = { pageInfo: { hasNextPage }, nodes: checks } as never;
  const snapshots = snapshotsHolding(pull, { flow: { private: repository.isPrivate === true, mergeBot: repository.bot != null }, headBots: repository.headBot == null ? {} : { [`806@${"b".repeat(40)}`]: true } });
  return Object.assign(readPullFeedback(URL, "me", snapshots) ?? {}, { snapshots }) as NonNullable<ReturnType<typeof readPullFeedback>> & { snapshots: typeof snapshots };
};
const check = (name: string, conclusion: string | null, minute: number, isRequired = false) => ({ __typename: "CheckRun", name, conclusion, completedAt: at(minute), isRequired });
const MERGE_BOT = { isPrivate: true, bot: { __typename: "Blob" } };

test("A11-341: in a merge-bot repository with no required check, `gate` is the one the pull request waits on: a red check that is not the merge condition is listed and holds nothing", () => {
  const read = readInRepository(MERGE_BOT, [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)]);
  assert.deepEqual([read?.failing, read?.failedAt, read?.pendingRequired], [[], null, []], "gate is green: nothing is counted, so no feedback round is opened for capture");
  assert.deepEqual(read?.failures.map(({ name }) => name), ["capture"], "it is still listed, so a round can name the job behind a roll-up that failed");
});

test("A11-341: in a merge-bot repository a red `gate` reads red, and a gate still running or not reported is what the pull request waits on", () => {
  const red = readInRepository(MERGE_BOT, [check("gate", "FAILURE", 10), check("capture", "FAILURE", 20)]);
  assert.deepEqual([red?.failing, red?.failedAt], [["gate"], ms(10)], "only the gate counts, as today a required check does");
  const running = readInRepository(MERGE_BOT, [check("gate", null, 10), check("capture", "FAILURE", 20)]);
  assert.deepEqual([running?.failing, running?.pendingRequired], [[], ["gate"]]);
  const missing = readInRepository(MERGE_BOT, [check("capture", null, 20)]);
  assert.deepEqual(missing?.pendingRequired, [], "a gate with no run on the head is not in the rollup, as a required check of a ruleset is not");
});

test("A11-341: a repository with neither a ruleset nor the merge bot counts every check as before, and a ruleset's required checks win over the merge bot", () => {
  const checks = [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)];
  for (const repository of [{ isPrivate: false, bot: null }, { isPrivate: true, bot: null }, { isPrivate: false, bot: { __typename: "Blob" } }, {}]) {
    assert.deepEqual(readInRepository(repository, checks)?.failing, ["capture"], JSON.stringify(repository));
  }
  const ruleset = readInRepository(MERGE_BOT, [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20, true)]);
  assert.deepEqual(ruleset?.failing, ["capture"], "GitHub names capture required: that is the condition, not gate");
});

test("A11-341: a rollup of more than one page is not read in full, so `gate` is not taken as the one required check: the checks seen count as before", () => {
  const checks = [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)];
  assert.deepEqual(readInRepository(MERGE_BOT, checks, true)?.failing, ["capture"]);
  assert.deepEqual(readInRepository(MERGE_BOT, checks, false)?.failing, []);
});

test("A11-344: the pull request that adds the merge bot waits on `gate` alone: the default branch has none, its head holds it", () => {
  const checks = [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)];
  const adding = readInRepository({ isPrivate: true, bot: null, headBot: { __typename: "Blob" } }, checks);
  assert.deepEqual([adding?.failing, adding?.failedAt, adding?.pendingRequired], [[], null, []], "gate is green: capture opens no feedback round");
  assert.deepEqual(adding?.failures.map(({ name }) => name), ["capture"], "it is still listed");
  assert.deepEqual(readInRepository({ isPrivate: true, bot: null, headBot: { __typename: "Blob" } }, [check("gate", "FAILURE", 10), check("capture", "FAILURE", 20)])?.failing, ["gate"], "a red gate reads red");
});

test("A11-344: a private repository with the bot on neither its default branch nor its head, and a public one whose head holds it, count every check as before", () => {
  const checks = [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)];
  for (const repository of [{ isPrivate: true, bot: null, headBot: null }, { isPrivate: false, bot: null, headBot: { __typename: "Blob" } }]) {
    assert.deepEqual(readInRepository(repository, checks)?.failing, ["capture"], JSON.stringify(repository));
  }
});

test("A11-344: the head's file is asked only for a private repository without the bot on its default branch, whose pull request has no required check, and once for that head", () => {
  const checks = [check("gate", "SUCCESS", 10), check("capture", "FAILURE", 20)];
  assert.deepEqual(readInRepository({ isPrivate: true, bot: null }, checks).snapshots.reads.heads, [`806@${"b".repeat(40)}`]);
  assert.deepEqual(readInRepository(MERGE_BOT, checks).snapshots.reads.heads, [], "the default branch holds the bot: the head is not asked");
  assert.deepEqual(readInRepository({ isPrivate: false, bot: null }, checks).snapshots.reads.heads, [], "a public repository has no merge bot flow");
  assert.deepEqual(readInRepository({ isPrivate: true, bot: null }, [check("gate", "SUCCESS", 10, true)]).snapshots.reads.heads, [], "a required check decides: the head is not asked");
  assert.deepEqual(readInRepository({ isPrivate: true, bot: null }, checks, true).snapshots.reads.heads, [], "a rollup cut at a page counts the checks seen: the head is not asked");
});
