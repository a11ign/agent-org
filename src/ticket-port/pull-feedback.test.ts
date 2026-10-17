// no-token: gh -- `readPullFeedback` and `readOwnLogin` are handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_PAGES, pullOf, readOwnLogin, readPullFeedback } from "./pull-feedback.ts";

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;
const ms = (minute: number) => Date.parse(at(minute));

/** A `run` that answers the feedback read with `pull` as the pull request, and records each call. */
function answering(pull: unknown) {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return JSON.stringify({ data: { repository: { pullRequest: pull } } }); } };
}

const pullWith = ({ state = "OPEN", reviews = [] as unknown[], comments = [] as unknown[], threads = [] as unknown[], checks = [] as unknown[], mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN", base = "main", files = [] as string[] } = {}) => ({
  state, mergeable, mergeStateStatus, baseRefName: base, files: { nodes: files.map((path) => ({ path })) },
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
  assert.deepEqual(read, { state: "open", feedbackAt: ms(20), authors: ["carol", "bob", "a11ign-reviewer"], failing: [], failedAt: null, conflicting: false, base: "main", files: [], filesComplete: true },
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
