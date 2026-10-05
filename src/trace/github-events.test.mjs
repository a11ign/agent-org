// a11ign/a11ign#3508 (slice 2 of #3494): the trace store learns what GitHub saw. Fixtures only: nothing here reaches GitHub, and `gh` is an injected table.
// no-token: gh -- every `gh api` answer below is a fixture
// THE FIXTURES ARE IN THE REAL RECORD SHAPES, trimmed from `gh api repos/a11ign/a11ign/issues/3406/timeline` and `commits/0fde473.../check-runs` (read 2026-10-04) and
// from #3508's own timeline for the claim-record comment. What is CONSTRUCTED, because #3406 has none of it: the `pr:hold` pair, the force-push, the second head and its
// run still going, the release comment, the `answer:` pair, and the ejection. They are marked `constructed`.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countingGh, eventsOfCheckRuns, eventsOfTimeline, GITHUB_KINDS, readGithubEvents } from "./github-events.mjs";
import { appendEvents, eventsForRow, readStore } from "./store.mjs";

const REPO = "a11ign/a11ign";
const HEAD = "0fde4737ea065e2d794cfab07b39373e715fede4";
const FORCED = "9999999999999999999999999999999999999999"; // constructed
const at = (iso) => Date.parse(iso);

const PR_TIMELINE = [
  { event: "committed", sha: HEAD, committer: { date: "2026-10-04T11:43:42Z" }, author: { date: "2026-10-04T11:43:42Z" } },
  { id: 32441029391, event: "labeled", created_at: "2026-10-04T11:45:01Z", commit_id: null, label: { name: "session:orchestrator" }, actor: { login: "a11ign-ai-leads" } },
  { id: 1, event: "labeled", created_at: "2026-10-04T11:50:00Z", label: { name: "pr:hold" }, actor: { login: "a11ign-ai-leads" } }, // constructed
  { id: 5405907533, event: "reviewed", submitted_at: "2026-10-04T11:54:54Z", commit_id: HEAD, state: "approved", user: { login: "a11ign-bot" } },
  { id: 2, event: "unlabeled", created_at: "2026-10-04T12:00:00Z", label: { name: "pr:hold" }, actor: { login: "a11ign-ai-leads" } }, // constructed
  { id: 3, event: "head_ref_force_pushed", created_at: "2026-10-04T13:00:00Z", commit_id: FORCED, actor: { login: "a11ign-ai-workers" } }, // constructed
  { id: 32446654569, event: "ready_for_review", created_at: "2026-10-04T14:08:33Z", commit_id: null, actor: { login: "a11ign-ai-workers" } },
  { id: 32446663547, event: "added_to_merge_queue", created_at: "2026-10-04T14:08:49Z", commit_id: null, actor: { login: "a11ign-ci" } },
  { id: 32447041943, event: "merged", created_at: "2026-10-04T14:20:02Z", commit_id: "fa4cc01b40206bf9b6d32948711a3546280365af", actor: { login: "a11ign-ci" } },
  { id: 32447042014, event: "closed", created_at: "2026-10-04T14:20:02Z", commit_id: null, actor: { login: "a11ign-ci" } },
  { id: 32447042017, event: "removed_from_merge_queue", created_at: "2026-10-04T14:20:02Z", commit_id: null, actor: { login: "github-merge-queue[bot]" } },
  { id: 32447042712, event: "head_ref_deleted", created_at: "2026-10-04T14:20:03Z", commit_id: null, actor: { login: "a11ign-ci" } },
  { id: 9, event: "cross-referenced", created_at: "2026-10-04T15:00:00Z", actor: { login: "someone" } },
];
const run = (id, name, status, conclusion, started, completed, sha = HEAD) => ({ id, name, status, conclusion, started_at: started, completed_at: completed, head_sha: sha });
const RUNS = {
  [HEAD]: [
    run(111453737726, "comment", "completed", "success", "2026-10-04T14:10:13Z", "2026-10-04T14:10:18Z"),
    run(111453637082, "mutate", "completed", "success", "2026-10-04T14:08:50Z", "2026-10-04T14:09:09Z"),
    run(111453637025, "arm", "completed", "success", "2026-10-04T14:10:46Z", "2026-10-04T14:11:08Z"),
    run(111453637082 + 1, "gate", "completed", "failure", "2026-10-04T11:51:18Z", "2026-10-04T11:51:22Z"),
  ],
  [FORCED]: [run(5, "gate", "in_progress", null, "2026-10-04T13:01:00Z", null, FORCED)], // constructed
};
const ROW_TIMELINE = [
  { id: 20, event: "milestoned", created_at: "2026-10-04T17:54:45Z", actor: { login: "a11ign-ai-leads" } },
  { id: 21, event: "labeled", created_at: "2026-10-04T17:59:56Z", label: { name: "ready" }, actor: { login: "a11ign-ai-leads" } },
  { id: 22, event: "labeled", created_at: "2026-10-04T18:33:00Z", label: { name: "answer:product-manager" }, actor: { login: "a11ign-ai-workers" } }, // constructed
  { id: 5983103831, event: "commented", created_at: "2026-10-04T18:33:21Z", user: { login: "a11ign-ai-workers" },
    body: "<!-- row-claim: claim record -->\n**Claim record** -- claimed by `worker-3508`.\n\nClaimed-branch: agent/the-trace-store-holds-3508" },
  { id: 23, event: "commented", created_at: "2026-10-04T18:40:00Z", user: { login: "someone" }, body: "a plain comment that quotes `claimed by`" },
  { id: 24, event: "unlabeled", created_at: "2026-10-04T19:00:00Z", label: { name: "answer:product-manager" }, actor: { login: "a11ign-ai-leads" } }, // constructed
  { id: 25, event: "commented", created_at: "2026-10-04T19:30:00Z", user: { login: "a11ign-ai-workers" },
    body: "<!-- row-claim: claim record -->\n**Claim record** -- released by `worker-3508`.\n\nNo branch or worktree is recorded for this row." }, // constructed
];
const ISSUES = {
  3508: { created_at: "2026-10-04T17:54:45Z", user: { login: "a11ign-ai-leads" } },
  3406: { created_at: "2026-10-04T11:44:57Z", user: { login: "a11ign-ai-leads" } },
};

/** A `gh api` answering from the table, as gh does: a path it does not know FAILS. `seen` is every path asked. */
const fakeGh = ({ runs = RUNS, pull = PR_TIMELINE, draft } = {}) => {
  const seen = [];
  const gh = (args) => {
    seen.push(args[0]);
    const path = args[0].split("?")[0];
    const issue = /issues\/(\d+)$/.exec(path);
    if (issue) return issue[1] === "3406" ? { ...ISSUES[3406], created_at: "2026-10-04T11:44:58Z" } : ISSUES[issue[1]]; // a pull request's ISSUE record, a second late as #3575's was
    const ownRecord = /pulls\/(\d+)$/.exec(path);
    if (ownRecord) return draft === undefined ? ISSUES[ownRecord[1]] : { ...ISSUES[ownRecord[1]], draft }; // the pull object's `draft` is the state NOW; absent = not read
    const timeline = /issues\/(\d+)\/timeline$/.exec(path);
    if (timeline) return timeline[1] === "3406" ? pull : ROW_TIMELINE;
    const checks = /commits\/(\w+)\/check-runs$/.exec(path);
    if (checks) return { total_count: (runs[checks[1]] ?? []).length, check_runs: runs[checks[1]] ?? [] };
    throw Object.assign(new Error(`gh: Not Found (HTTP 404): ${path}`), { stderr: "HTTP 404" });
  };
  return Object.assign(countingGh(gh), { seen });
};

const read = (gh = fakeGh()) => readGithubEvents({ rows: [3508], prs: [3406], repo: REPO, gh });
const pullKinds = (events) => events.filter((event) => event.pr === 3406).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((event) => event.kind);
const rowKinds = (events) => events.filter((event) => event.row === 3508).sort((a, b) => a.at - b.at).map((event) => event.kind);

/** What the reader MUST find in the fixture. Every positive control below runs a reader that lacks one source through THIS and expects it to fail. */
function assertComplete(events) {
  assert.deepEqual(rowKinds(events), ["filed", "labeled", "claimed", "unlabeled", "released"]);
  const kinds = pullKinds(events);
  assert.deepEqual([...new Set(kinds)].sort(), ["added_to_merge_queue", "ci_run", "closed", "head_moved", "labeled", "merged", "opened", "ready_for_review", "removed_from_merge_queue",
    "reviewed", "unlabeled"]);
  assert.equal(kinds.filter((kind) => kind === "ci_run").length, 5, "four runs of the first head and one of the second");
  assert.equal(kinds.filter((kind) => kind === "head_moved").length, 2, "the commit, and the force-push");
}

test("READ: the fixture yields every record kind of done-when 1, each with source github and an id", () => {
  const events = read();
  assertComplete(events);
  assert.ok(events.length >= 20, "positive control: the fixture yields records at all");
  assert.equal(events.every((event) => event.source === "github" && typeof event.id === "string" && Number.isFinite(event.at)), true);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length, "ids are unique across the whole read");
  const kinds = new Set(events.map((event) => event.kind));
  assert.deepEqual([...kinds].filter((kind) => !GITHUB_KINDS.includes(kind)), [], "no kind outside the declared list");
  assert.deepEqual(GITHUB_KINDS.filter((kind) => !kinds.has(kind)), [], "and the fixture exercises every declared kind");
});

test("READ: the review is at its head with its state, the queue pair is a merge not an ejection, and the claim names its session", () => {
  const events = read();
  const review = events.find((event) => event.kind === "reviewed");
  assert.deepEqual([review.state, review.headSha, review.actor, review.at], ["APPROVED", HEAD, "a11ign-bot", at("2026-10-04T11:54:54Z")]);
  assert.equal(events.find((event) => event.kind === "removed_from_merge_queue").outcome, "merged");
  assert.equal(events.find((event) => event.kind === "merged").at, at("2026-10-04T14:20:02Z"));
  assert.deepEqual(events.filter((event) => event.row === 3508 && /claimed|released/.test(event.kind)).map((event) => [event.kind, event.claimant]),
    [["claimed", "worker-3508"], ["released", "worker-3508"]]);
  assert.deepEqual(events.filter((event) => /^labeled|unlabeled$/.test(event.kind)).map((event) => event.name), ["answer:product-manager", "answer:product-manager", "pr:hold", "pr:hold"],
    "only waits and orders: session:* and ready are not holds");
});

test("OUTCOME: a queue exit with no merge is `unmerged`, which is how an ejection reads", () => {
  const ejected = [
    { id: 1, event: "added_to_merge_queue", created_at: "2026-10-04T10:00:00Z" },
    { id: 2, event: "removed_from_merge_queue", created_at: "2026-10-04T10:20:00Z" }, // constructed
    { id: 3, event: "added_to_merge_queue", created_at: "2026-10-04T11:00:00Z" },
    { id: 4, event: "merged", created_at: "2026-10-04T11:10:00Z" },
    { id: 5, event: "removed_from_merge_queue", created_at: "2026-10-04T11:10:01Z" },
  ];
  const events = eventsOfTimeline({ subject: { number: 7, isPull: true }, repo: REPO, timeline: ejected });
  assert.deepEqual(events.filter((event) => event.kind === "removed_from_merge_queue").map((event) => event.outcome), ["unmerged", "merged"]);
});

test("POSITIVE CONTROL: the same fixture through a reader that drops the check-runs, or the reviews, or the claim comments, is RED", () => {
  const withoutRuns = fakeGh({ runs: {} });
  assert.throws(() => assertComplete(read(withoutRuns)), /ci_run|\b5\b|Expected values/, "no check-runs: the CI records are missing");
  const withoutReviews = fakeGh({ pull: PR_TIMELINE.filter((raw) => raw.event !== "reviewed") });
  assert.throws(() => assertComplete(read(withoutReviews)), /reviewed/, "no reviews");
  const noClaims = readGithubEvents({ rows: [3508], prs: [3406], repo: REPO, gh: (args) => {
    const reply = fakeGh()(args);
    return /timeline/.test(args[0]) && Array.isArray(reply) ? reply.filter((raw) => raw.event !== "commented") : reply;
  } });
  assert.throws(() => assertComplete(noClaims), "no claim records");
  assertComplete(read()); // and the control is not red for its own sake
});

test("ID: a `reviewed` event at another head is another record; the same read twice is the same ids", () => {
  const review = (commit) => eventsOfTimeline({ subject: { number: 3406, isPull: true }, repo: REPO,
    timeline: PR_TIMELINE.filter((raw) => raw.event === "reviewed").map((raw) => ({ ...raw, commit_id: commit })) })[0];
  assert.notEqual(review(HEAD).id, review(FORCED).id);
  assert.equal(review(HEAD).id, review(HEAD).id);
  assert.deepEqual(read().map((event) => event.id), read().map((event) => event.id));
});

test("STORE: ingesting twice adds nothing; a run seen going and later complete is two records, and nothing is rewritten", () => {
  const path = join(mkdtempSync(join(tmpdir(), "trace-gh-")), "events.ndjson");
  const first = appendEvents(path, read());
  assert.ok(first.added >= 20);
  assert.deepEqual(appendEvents(path, read()), { added: 0, superseded: 0, skipped: first.added });
  const [going] = eventsOfCheckRuns({ subject: { number: 3406, isPull: true }, repo: REPO, checkRuns: RUNS[FORCED] });
  const [done] = eventsOfCheckRuns({ subject: { number: 3406, isPull: true }, repo: REPO, checkRuns: [{ ...RUNS[FORCED][0], status: "completed", conclusion: "success", completed_at: "2026-10-04T13:05:00Z" }] });
  assert.notEqual(going.id, done.id);
  assert.deepEqual([going.state, done.state, done.at], [null, "success", at("2026-10-04T13:05:00Z")]);
  assert.deepEqual(appendEvents(path, [done]), { added: 1, superseded: 0, skipped: 0 });
  assert.equal(readStore(path).filter((event) => event.id === going.id).length, 1);
});

test("KEYS: a row's events carry the row, a pull request's the pull request, so `eventsForRow` finds both and no other", () => {
  const events = read();
  assert.deepEqual([...new Set(events.map((event) => `${event.row}/${event.pr}`))].sort(), ["3508/null", "null/3406"]);
  assert.equal(eventsForRow(events, { rows: [3508], prs: [3406] }).length, events.length);
  assert.equal(eventsForRow(events, { rows: [3508], prs: [] }).every((event) => event.row === 3508), true);
});

test("ORDER: merged, closed and the queue exit share a second; GitHub's own event id keeps them in the order it wrote them", () => {
  const tail = eventsForRow(read(), { rows: [], prs: [3406] }).filter((event) => event.at === at("2026-10-04T14:20:02Z")).map((event) => event.kind);
  assert.deepEqual(tail, ["merged", "closed", "removed_from_merge_queue"], "the ids sort closed < merged alphabetically, so only seq gets this right");
});

test("CALLS: only `gh api` REST paths, counted; the commits asked for are the heads the timeline names", () => {
  const gh = fakeGh();
  read(gh);
  assert.equal(gh.calls, 6, "the row: issue + timeline; the pull request: issue + timeline + one check-runs per head (2)");
  assert.equal(gh.seen.every((path) => /^repos\/a11ign\/a11ign\//.test(path)), true, "REST paths of the repository, never a graphql query");
  assert.deepEqual(gh.seen.filter((path) => /check-runs/.test(path)).map((path) => /commits\/(\w+)/.exec(path)[1]), [HEAD, FORCED]);
});

test("FAILURE: a call that fails THROWS; an empty answer would have printed a trace without the reviews", () => {
  const failing = (needle) => (args) => {
    if (args[0].includes(needle)) throw Object.assign(new Error("HTTP 403 rate limit"), { stderr: "HTTP 403" });
    return fakeGh()(args);
  };
  for (const needle of ["/issues/3406/timeline", "/check-runs", "/issues/3508", "/pulls/3406"]) {
    assert.throws(() => readGithubEvents({ rows: [3508], prs: [3406], repo: REPO, gh: failing(needle) }), /403/, needle);
  }
  assert.throws(() => readGithubEvents({ rows: [], prs: [3406], repo: REPO, gh: (args) => (/timeline/.test(args[0]) ? { message: "x" } : fakeGh()(args)) }), /no list/);
  const unplaceable = PR_TIMELINE.map((raw) => (raw.event === "merged" ? { ...raw, created_at: undefined } : raw));
  assert.throws(() => read(fakeGh({ pull: unplaceable })), /no readable time/);
});

test("PAGES: a list longer than a page is read whole, and one that never ends throws instead of printing half", () => {
  const many = Array.from({ length: 130 }, (_, index) => ({ id: 1000 + index, event: "labeled", created_at: "2026-10-04T10:00:00Z", label: { name: "hold:ceo" }, actor: { login: "x" } }));
  const paged = (args) => {
    const page = Number(/&page=(\d+)/.exec(args[0])?.[1]);
    if (/timeline/.test(args[0])) return many.slice((page - 1) * 100, page * 100);
    return ISSUES[3508];
  };
  const events = readGithubEvents({ rows: [3508], prs: [], repo: REPO, gh: paged });
  assert.equal(events.filter((event) => event.kind === "labeled").length, 130, "both pages");
  const endless = (args) => (/timeline/.test(args[0]) ? many.slice(0, 100) : ISSUES[3508]);
  assert.throws(() => readGithubEvents({ rows: [3508], prs: [], repo: REPO, gh: endless }), /refusing to print a trace that stops part way/);
});

test("A PULL REQUEST IS OPENED AT ITS OWN `created_at` (`pulls/{n}`), not its issue record's, which was a second late for #3575: the outcome clock reads the first (#3517)", () => {
  const opened = read().find((event) => event.kind === "opened" && event.pr === 3406);
  assert.equal(opened.at, at("2026-10-04T11:44:57Z"), "the pull request's own time");
  assert.notEqual(opened.at, at("2026-10-04T11:44:58Z"), "POSITIVE CONTROL: the issue record the fake also holds says another second, so reading it would be caught here");
  assert.equal(read().find((event) => event.kind === "filed" && event.row === 3508).at, at("2026-10-04T17:54:45Z"), "a row has no pull record and is read from its issue");
});

const openedOf = (options) => read(fakeGh(options)).find((event) => event.kind === "opened" && event.pr === 3406);
const stamp = (event, id, created_at) => ({ id, event, created_at, commit_id: null, actor: { login: "a11ign-ai-workers" } });
const NO_SWITCH = PR_TIMELINE.filter((raw) => raw.event !== "ready_for_review");

test("OPENED CARRIES `draft`: true for a draft, false for one opened ready, null when the pull object was not read -- and null is never false (#3670)", () => {
  assert.equal(openedOf({ pull: NO_SWITCH, draft: true }).draft, true, "a pull request still a draft was opened as one");
  assert.equal(openedOf({ pull: NO_SWITCH, draft: false }).draft, false, "one with no ready mark and not a draft was opened ready");
  assert.equal(openedOf({ pull: NO_SWITCH }).draft, null, "the pull object carries no `draft`: unread, which is not `false`");
  assert.ok("draft" in openedOf({ pull: NO_SWITCH }), "the field is there as null, not left off");
  assert.equal(read().find((event) => event.kind === "filed" && event.row === 3508).draft, undefined, "a row is not a pull request and has no draft state");
});

test("THE PULL OBJECT'S `draft` IS THE STATE NOW, so the timeline's first draft/ready event outranks it: a draft marked ready reads draft: true on `opened` (#3670)", () => {
  assert.equal(openedOf({ draft: false }).draft, true, "POSITIVE CONTROL: marked ready later, the pull object says false, and reading it alone would call this PR opened ready");
  const converted = [...NO_SWITCH, stamp("convert_to_draft", 1, "2026-10-04T12:00:00Z"), stamp("ready_for_review", 2, "2026-10-04T12:30:00Z")];
  assert.equal(openedOf({ pull: converted, draft: false }).draft, false, "opened ready, converted to draft and marked ready again: the FIRST switch says it was ready");
  assert.equal(openedOf({ pull: [...NO_SWITCH, stamp("convert_to_draft", 1, "2026-10-04T12:00:00Z")], draft: true }).draft, false, "opened ready, a draft only now");
  assert.equal(openedOf({ draft: undefined }).draft, true, "the timeline alone is enough when the pull object was not read");
});
