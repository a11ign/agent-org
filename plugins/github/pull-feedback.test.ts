// no-token: gh -- `readPullFeedback` and `readOwnLogin` are handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import { MAX_FILE_PAGES, pullOf, readOwnLogin, readPullFeedback as read } from "./pull-feedback.ts";

/** The read, with core's own policy for which checks are red: what the plugin is given in a host. */
const readPullFeedback = (url: string, self: string, run: (args: string[]) => string, alsoIgnore: readonly string[] = []) => read(url, self, run, corePolicy(), alsoIgnore);

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;
const ms = (minute: number) => Date.parse(at(minute));

/** A `run` that answers the feedback read with `pull` as the pull request, and records each call. */
function answering(pull: unknown) {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return JSON.stringify({ data: { repository: { pullRequest: pull } } }); } };
}

const pullWith = ({ state = "OPEN", reviews = [] as unknown[], comments = [] as unknown[], threads = [] as unknown[], checks = [] as unknown[], mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN", base = "main", files = [] as string[], head = undefined as string | undefined, reviewDecision = undefined as string | null | undefined, body = undefined as string | undefined } = {}) => ({
  state, headRefOid: head, reviewDecision, body, mergeable, mergeStateStatus, baseRefName: base, files: { nodes: files.map((path) => ({ path })), pageInfo: { hasNextPage: false, endCursor: null } },
  reviews: { nodes: reviews }, comments: { nodes: comments }, reviewThreads: { nodes: threads.map((c) => ({ comments: { nodes: [c] } })) },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
});

test("the newest review, conversation comment or inline comment by anyone but the workers' account is the feedback, its authors newest first", () => {
  const { run, calls } = answering(pullWith({
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
    verdictAtHead: null, pendingRequired: [], body: "" },
    "an approval and the workers' own comments are not feedback");
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(calls[0].includes("owner=netboxlabs") && calls[0].includes("repo=nbl-ui-netbox") && calls[0].includes("number=806"));
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
  const paged = (pages: Record<string, unknown>) => (args: string[]) => {
    const cursor = args.find((arg) => arg.startsWith("cursor="))?.slice("cursor=".length);
    if (cursor === undefined) return JSON.stringify({ data: { repository: { pullRequest: { ...pullWith(), files: pages.first } } } });
    if (cursor === "c1") return JSON.stringify({ data: { repository: { pullRequest: { files: pages.second } } } });
    throw new Error("gh exited 1");
  };
  const page = (paths: string[], hasNextPage: boolean, endCursor: string | null) => ({ nodes: paths.map((path) => ({ path })), pageInfo: { hasNextPage, endCursor } });
  const paging = readPullFeedback(URL, "me", paged({ first: page(["a.ts"], true, "c1"), second: page(["b.ts"], false, null) }));
  assert.deepEqual([paging?.files, paging?.filesComplete], [["a.ts", "b.ts"], true], "every page is read, and the list is then complete");
  let calls = 0;
  const forever = () => {
    calls += 1;
    return JSON.stringify({ data: { repository: { pullRequest: { ...pullWith(), files: page(["a.ts"], true, "c1") } } } });
  };
  const cut = readPullFeedback(URL, "me", forever);
  assert.deepEqual([cut?.filesComplete, calls], [false, MAX_FILE_PAGES], "pages past the cap are not read, and the list says it is cut short");
  assert.equal(readPullFeedback(URL, "me", paged({ first: page(["a.ts"], true, "c1") })), null, "a page that cannot be read is no reading at all");
  const answered = (files: unknown) => readPullFeedback(URL, "me", () => JSON.stringify({ data: { repository: { pullRequest: { ...pullWith(), files } } } }));
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
  const refused = (_args: string[]): string => { throw new Error("gh exited 1"); };
  assert.equal(readPullFeedback(URL, "me", refused), null);
  assert.equal(readPullFeedback(URL, "me", answering(null).run), null, "no such pull request");
  assert.equal(readPullFeedback(URL, "me", () => "not json"), null);
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
