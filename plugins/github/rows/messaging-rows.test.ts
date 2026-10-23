// no-token: none -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 8): THE ARGUMENTS AND READINGS OF THE OPERATIONS THE CHAIRMAN'S WATCH AND ANSWERS ASK (`messaging-rows.ts`), which core's tests of those callers used to assert over a stubbed `gh` and which are the plugin's now
 * (core's tests run on the fake code host's rows: `src/messaging/github-writer.test.ts`, `placeholders.test.ts`, `reply.test.ts`, `reply-cli.test.ts`, `sources/requests.test.ts`, `sources/readers.test.ts`). What is held here can
 * only be asserted against GitHub's own words: the argument lists, `--paginate`, the 404 that says `Label does not exist`, how a raw answer is read. The last cases run the real operations under core's read-only allowlists, since
 * those allowlists judge exactly the argument lists built here.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "../../../src/plugins/active.ts";
import { createFakeCodeHost } from "../../../src/plugins/fakes/code-host.ts";
import { createGhReaders } from "../../../src/messaging/placeholders.ts";
import { assertReadOnlyGh as assertReadOnlyReply } from "../../../src/messaging/reply-cli.ts";
import { assertReadOnlyGh as assertReadOnlyWatch, createGhReader } from "../../../src/messaging/watch.ts";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { sinceAnswer, readsRowsSince } from "../../../src/packaging/rows-by-label-fixtures.ts";
import { createRows } from "./index.ts";
import { addLabelAsync, commentOnRowAsync, issueCommentsAsync, messagingRows, openPullChecksAsync, pullReviewDecisionAsync, readRowAsync, removeLabelAsync, restGetAsync } from "./messaging-rows.ts";

afterEach(() => forgetActivation());

const REPO = "a11ign/a11ign";
const NEEDS_CHAIRMAN = "needs:chairman";
const ANSWER_LABEL = "answer:ceo";
const ROW = { repo: REPO, number: 3062 };
const brief = (question: string) => `**Brief for the chairman**\n${question}\n<!-- chairman-options: A=publish now; B=hold -->`;

type FixtureRow = { state: string; labels: string[]; comments: { body: string; created_at: string; author_association: string }[] };

/**
 * A fixture `gh api`: records every argv and serves REST shaped like GitHub's (lowercase state, `created_at`, `author_association`), applying the writes to `rows`. `--paginate` is the platform's, so the fixture answers it
 * with every comment, as `gh` does after following the pages.
 */
function fixtureGh(rows: Map<number, FixtureRow>, { fail = () => null }: { fail?: (argv: readonly string[]) => Error | null } = {}) {
  const calls: (readonly string[])[] = [];
  async function run(argv: readonly string[]): Promise<string> {
    calls.push(argv);
    const failure = fail(argv);
    if (failure !== null) throw failure;
    const [, ...rest] = argv;
    const method = rest[0] === "--method" ? rest[1] : "GET";
    const path = rest.find((token) => token.startsWith("repos/")) as string;
    const [, number, tail, label] = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)(?:\/(comments|labels)(?:\/(.+))?)?$/) as RegExpMatchArray;
    const row = rows.get(Number(number)) as FixtureRow;
    if (method === "GET" && tail === undefined) return `${JSON.stringify({ state: row.state, labels: row.labels })}\n`;
    if (method === "GET") return row.comments.map((comment) => JSON.stringify({ body: comment.body, createdAt: comment.created_at, authorAssociation: comment.author_association })).join("\n");
    if (tail === "comments") row.comments.push({ body: String(rest.find((token) => token.startsWith("body="))).slice("body=".length), created_at: "2026-10-02T12:00:00Z", author_association: "MEMBER" });
    else if (method === "DELETE") row.labels = row.labels.filter((existing) => existing !== decodeURIComponent(label));
    else row.labels.push(String(rest.find((token) => token.startsWith("labels[]="))).slice("labels[]=".length));
    return "";
  }
  return { run, calls };
}

/** `count` comments, the newest a brief of its own. */
const manyComments = (count: number) => Array.from({ length: count }, (_, index) => ({
  body: index === count - 1 ? brief("The newest ask") : `comment ${index}`,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
  author_association: index === count - 1 ? "OWNER" : "NONE",
}));

const helpers = () => rowsReadHelpers() as unknown as RowsHelpers;

/** The fake code host with the GitHub plugin's operations of this group (and its connection reader, `readRowsSinceAsync`) in place of the fake's: the readers of the watch and of the answers then run the argument lists the plugin builds. */
function withRealMessagingRows() {
  const host = createFakeCodeHost();
  const { readRowsSinceAsync } = createRows(helpers);
  return { ...host, rows: { ...host.rows!, ...messagingRows, readRowsSinceAsync } as NonNullable<typeof host.rows> };
}

test("each of the four calls on a row is one `gh api` with the argv a person would type, and the row is changed", async () => {
  const rows = new Map([[3062, { state: "open", labels: ["ready", NEEDS_CHAIRMAN], comments: [] } as FixtureRow]]);
  const gh = fixtureGh(rows);
  await commentOnRowAsync({ ...ROW, body: "hello\n> quoted", run: gh.run });
  await removeLabelAsync({ ...ROW, label: NEEDS_CHAIRMAN, run: gh.run });
  await addLabelAsync({ ...ROW, label: ANSWER_LABEL, run: gh.run });
  assert.deepEqual(gh.calls, [
    ["api", "--method", "POST", `repos/${REPO}/issues/3062/comments`, "-f", "body=hello\n> quoted"],
    ["api", "--method", "DELETE", `repos/${REPO}/issues/3062/labels/needs%3Achairman`],
    ["api", "--method", "POST", `repos/${REPO}/issues/3062/labels`, "-f", `labels[]=${ANSWER_LABEL}`],
  ]);
  assert.deepEqual(rows.get(3062)?.labels, ["ready", ANSWER_LABEL]);
  assert.equal(rows.get(3062)?.comments[0].body, "hello\n> quoted");
});

test("readRowAsync returns the shape answers reads: state, label names and each comment's body, createdAt and authorAssociation, from two `gh api` calls", async () => {
  const rows = new Map([[3062, { state: "open", labels: ["ready", NEEDS_CHAIRMAN], comments: manyComments(2) } as FixtureRow]]);
  const gh = fixtureGh(rows);
  const read = await readRowAsync({ ...ROW, run: gh.run });
  assert.deepEqual(read.labels, ["ready", NEEDS_CHAIRMAN]);
  assert.equal(read.state, "open");
  assert.deepEqual(read.comments.map(({ body, authorAssociation }) => ({ body, authorAssociation })), [
    { body: "comment 0", authorAssociation: "NONE" }, { body: brief("The newest ask"), authorAssociation: "OWNER" },
  ]);
  assert.equal(read.comments[1].createdAt, "2026-10-01T00:00:01.000Z");
  assert.deepEqual(gh.calls[0], ["api", `repos/${REPO}/issues/3062`, "--jq", "{state: .state, labels: [.labels[].name]}"]);
});

test("readRowAsync pages past 100 comments: 250 are read, the newest is the 250th, and the call asks `gh` to paginate", async () => {
  const rows = new Map([[3062, { state: "open", labels: [NEEDS_CHAIRMAN], comments: manyComments(250) } as FixtureRow]]);
  const gh = fixtureGh(rows);
  const read = await readRowAsync({ ...ROW, run: gh.run });
  assert.equal(read.comments.length, 250);
  assert.equal(read.comments[249].body, brief("The newest ask"));
  const commentsCall = gh.calls.find((argv) => argv.some((token) => token.endsWith("/comments"))) as readonly string[];
  assert.ok(commentsCall.includes("--paginate"), `argv was ${JSON.stringify(commentsCall)}: without --paginate gh returns the OLDEST thirty`);
});

test("readRowAsync reads one comment per line however `gh` formats an object: `--jq` ends in `tojson`, and blank lines between pages are skipped", async () => {
  const run = async (argv: readonly string[]) => (argv.includes("--paginate")
    ? `${JSON.stringify({ body: "a", createdAt: "t1", authorAssociation: "OWNER" })}\n\n${JSON.stringify({ body: "b", createdAt: "t2", authorAssociation: "NONE" })}\n`
    : JSON.stringify({ state: "closed", labels: [] }));
  assert.deepEqual((await readRowAsync({ ...ROW, run })).comments.map(({ body }) => body), ["a", "b"]);
  const seen: (readonly string[])[] = [];
  await readRowAsync({ ...ROW, run: async (argv) => { seen.push(argv); return run(argv); } });
  assert.match(String(seen[1][seen[1].indexOf("--jq") + 1]), /\| tojson$/);
});

test("removeLabelAsync resolves when the label is already absent, and ONLY then: any other failure is thrown", async () => {
  const rows = new Map([[3062, { state: "open", labels: [], comments: [] } as FixtureRow]]);
  const absent = Object.assign(new Error("Command failed: gh api"), { stderr: 'gh: Label does not exist (HTTP 404)\n{"message":"Label does not exist"}' });
  await removeLabelAsync({ ...ROW, label: NEEDS_CHAIRMAN, run: fixtureGh(rows, { fail: () => absent }).run });
  for (const other of [
    Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" }),
    Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Service Unavailable (HTTP 503)" }),
    new Error("spawn gh ENOENT"),
  ]) {
    await assert.rejects(removeLabelAsync({ ...ROW, label: NEEDS_CHAIRMAN, run: fixtureGh(rows, { fail: () => other }).run }), other);
  }
});

test("a repository or number that is not a row builds no path and runs nothing, for each of the four calls", async () => {
  const gh = fixtureGh(new Map());
  for (const row of [{ repo: "a11ign/a11ign/../../user", number: 1 }, { repo: "a11ign", number: 1 }, { repo: REPO, number: 0 }, { repo: REPO, number: 1.5 }]) {
    await assert.rejects(commentOnRowAsync({ ...row, body: "x", run: gh.run }), TypeError);
    await assert.rejects(removeLabelAsync({ ...row, label: "x", run: gh.run }), TypeError);
    await assert.rejects(addLabelAsync({ ...row, label: "x", run: gh.run }), TypeError);
    await assert.rejects(readRowAsync({ ...row, run: gh.run }), TypeError);
  }
  assert.deepEqual(gh.calls, []);
});

test("issueCommentsAsync is one `gh issue view --json comments` of the row, and a row whose answer carries no comments list reads as none", async () => {
  const seen: (readonly string[])[] = [];
  const comments = [{ id: "IC_1", body: "x", createdAt: "2026-10-02T09:00:00Z", authorAssociation: "OWNER", author: { login: "a11ign-ceo" } }];
  assert.deepEqual(await issueCommentsAsync({ repo: REPO, number: 2623, run: async (argv) => { seen.push(argv); return JSON.stringify({ comments }); } }), comments);
  assert.deepEqual(seen, [["issue", "view", "2623", "-R", REPO, "--json", "comments"]]);
  assert.deepEqual(await issueCommentsAsync({ repo: REPO, number: 1, run: async () => "{}" }), [], "CONTROL: not a list is none");
  await assert.rejects(issueCommentsAsync({ repo: REPO, number: 1, run: async () => { throw new Error("HTTP 502"); } }), /HTTP 502/);
});

test("openPullChecksAsync is one `gh pr list` of the OPEN pull requests asking for number, labels and the check rollup, at the limit it is given", async () => {
  const seen: (readonly string[])[] = [];
  const pulls = [{ number: 1, labels: [{ name: "hold:ceo" }], statusCheckRollup: [{ name: "gate", conclusion: "FAILURE" }] }];
  assert.deepEqual(await openPullChecksAsync({ repo: REPO, limit: 100, run: async (argv) => { seen.push(argv); return JSON.stringify(pulls); } }), pulls);
  assert.deepEqual(seen, [["pr", "list", "-R", REPO, "--state", "open", "--json", "number,labels,statusCheckRollup", "--limit", "100"]]);
  assert.match(seen[0][seen[0].indexOf("--json") + 1], /(^|,)labels(,|$)/, "without `labels` no hold can be seen, and `gh` would not send them (#3014)");
  await assert.rejects(openPullChecksAsync({ repo: REPO, limit: 5, run: async () => "not json" }));
});

test("restGetAsync is `gh api <path>` with nothing after the path (a GET), parsed; an answer that is not JSON and a refused call both reject", async () => {
  const seen: (readonly string[])[] = [];
  const path = `repos/${REPO}/actions/runs/7`;
  assert.deepEqual(await restGetAsync({ path, run: async (argv) => { seen.push(argv); return '{"workflow_runs": []}'; } }), { workflow_runs: [] });
  assert.deepEqual(seen, [["api", path]]);
  await assert.rejects(restGetAsync({ path, run: async () => "<html>" }));
  await assert.rejects(restGetAsync({ path, run: async () => { throw new Error("HTTP 404: Not Found"); } }), /404/);
});

test("pullReviewDecisionAsync is `gh pr view N --repo R --json reviewDecision`: the decision, an EMPTY one as it is, and none as null", async () => {
  const seen: (readonly string[])[] = [];
  const decide = (answer: unknown) => pullReviewDecisionAsync({ repo: REPO, number: 2881, run: async (argv) => { seen.push(argv); return JSON.stringify(answer); } });
  assert.equal(await decide({ reviewDecision: "APPROVED" }), "APPROVED");
  assert.equal(await decide({ reviewDecision: "" }), "", "the base requires no approval: a reading, left to the caller to word");
  assert.equal(await decide({}), null);
  assert.deepEqual(seen[0], ["pr", "view", "2881", "--repo", REPO, "--json", "reviewDecision"]);
});

test("the watch's read-only allowlist admits every argument list the watch's operations build, through the reader the watch builds (and refuses none of them)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const asked: (readonly string[])[] = [];
  const reader = createGhReader({ run: async (argv) => { asked.push(argv); return argv[0] === "issue" ? '{"comments": []}' : argv[0] === "pr" ? "[]" : "{}"; } });
  await reader.issueComments({ repo: REPO, number: 2623 });
  await reader.redPulls({ repo: REPO });
  await reader.api(`repos/${REPO}/actions/runs?status=completed&per_page=20`);
  assert.deepEqual(asked, [
    ["issue", "view", "2623", "-R", REPO, "--json", "comments"],
    ["pr", "list", "-R", REPO, "--state", "open", "--json", "number,labels,statusCheckRollup", "--limit", "100"],
    ["api", `repos/${REPO}/actions/runs?status=completed&per_page=20`],
  ]);
  for (const argv of asked) assert.doesNotThrow(() => assertReadOnlyWatch(argv), argv.join(" "));
});

test("the reply command's allowlist admits every argument list the readers of the answers build, one placeholder of each kind", async () => {
  substituteCodeHost(withRealMessagingRows());
  const asked: string[] = [];
  const gh = async (argv: readonly string[]): Promise<string> => {
    assertReadOnlyReply(argv);
    asked.push(argv.join(" "));
    if (argv[0] === "pr") return JSON.stringify({ reviewDecision: "APPROVED" });
    const path = argv[1];
    if (path.startsWith(`repos/${REPO}/pulls/`)) return JSON.stringify({ number: 2881, state: "closed", merged_at: "2026-10-02T11:00:00Z" });
    if (path.startsWith(`repos/${REPO}/pulls?`)) return JSON.stringify([{ merged_at: "2026-10-02T11:00:00Z" }]);
    if (path.startsWith(`repos/${REPO}/issues?`)) return JSON.stringify([{ number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "ready" }] }]);
    if (path.startsWith(`repos/${REPO}/issues/comments/`)) return JSON.stringify({ body: "Ruled: hold.", html_url: "https://github.com/x/y#c" });
    if (path.startsWith(`repos/${REPO}/issues/`)) return JSON.stringify({ number: 3071, state: "open", labels: [{ name: "ready" }] });
    if (path.startsWith(`repos/${REPO}/actions/runs/`)) return JSON.stringify({ conclusion: "success", status: "completed" });
    if (path.startsWith(`repos/${REPO}/releases/latest`)) return JSON.stringify({ tag_name: "v1.4.0" });
    throw new Error(`fixture gh: unexpected ${argv.join(" ")}`);
  };
  const readers = createGhReaders({ gh, systemctl: async () => "ActiveState=active\nLoadState=loaded\n", repo: REPO, now: () => Date.parse("2026-10-02T14:05:30Z") });
  assert.deepEqual(await readers.issue(3071), { number: 3071, state: "open", labels: ["ready"] });
  assert.deepEqual(await readers.pr(2881), { number: 2881, state: "merged", review: "APPROVED" });
  assert.deepEqual(await readers.run(36891064128), { status: "completed", conclusion: "success" });
  assert.deepEqual(await readers.ready(), { count: 2 });
  assert.deepEqual(await readers.lastMerge(), { at: Date.parse("2026-10-02T11:00:00Z") });
  assert.deepEqual(await readers.comment(5), { body: "Ruled: hold.", url: "https://github.com/x/y#c" });
  assert.deepEqual(await readers.release(REPO), { tag: "v1.4.0" });
  assert.deepEqual(asked, [
    `api repos/${REPO}/issues/3071`,
    `api repos/${REPO}/pulls/2881`, `pr view 2881 --repo ${REPO} --json reviewDecision`,
    `api repos/${REPO}/actions/runs/36891064128`,
    `api repos/${REPO}/issues?labels=ready&state=open&per_page=100`,
    `api repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30`,
    `api repos/${REPO}/issues/comments/5`,
    `api repos/${REPO}/releases/latest`,
  ]);
});

// ---- the connection reads of the watch (`readRowsSinceAsync`), moved from `src/messaging/sources/requests.test.ts` (A11-160, step 8) ----------------------------------------------------------------------------------------------

const SINCE = Date.parse("2026-10-01T07:00:00Z");
/** A `run` that answers every page of a rows-since read with `sinceAnswer` over `rows` (the connection's own paging), and keeps each argv. */
const pagesOf = (commands: string[][], rows: readonly any[] = []) => async (argv: readonly string[]): Promise<string> => {
  commands.push([...argv]);
  return sinceAnswer(argv, rows);
};

test("readRowsSinceAsync sends EVERY page's argv through the caller's guard before the page is run, and a refused page is thrown with nothing run", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ number: index + 1, title: `Row ${index + 1}`, labels: ["ready"] }));
  const ask = { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", label: "ready", repo: REPO, select: "number title" } as const;
  const { readRowsSinceAsync } = createRows(helpers);
  const guarded: string[][] = [];
  const ran: string[][] = [];
  const run = async (argv: readonly string[]): Promise<string> => {
    guarded.push([...argv]);
    assertReadOnlyWatch(argv);
    ran.push([...argv]);
    return sinceAnswer(argv, rows);
  };
  assert.equal((await readRowsSinceAsync({ ask, run })).length, 150);
  assert.equal(guarded.length, 2, "two pages of a hundred and fifty rows");
  assert.deepEqual(guarded.map((argv) => readsRowsSince(argv)?.after), [null, "c100"], "the second page carries the first's cursor");
  assert.deepEqual(ran, guarded, "POSITIVE CONTROL: every page the guard admits is run");
  const refusing = async (argv: readonly string[]): Promise<string> => {
    assertReadOnlyWatch([...argv, "--method", "POST"]);
    ran.push([...argv]);
    return "";
  };
  await assert.rejects(readRowsSinceAsync({ ask, run: refusing }), /reads only/);
  assert.equal(ran.length, 2, "and the refused page was never run");
});

test("a window longer than the pages the read may walk rejects with core's WindowCutShort, never a list cut short; a window that fits is read whole (#5076)", async () => {
  const rows = Array.from({ length: 450 }, (_, index) => ({ number: index + 1, mergedAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T08:00:00Z" }));
  const ask = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: REPO, select: "number mergedAt", since: new Date(SINCE).toISOString(), maxPages: 2 } as const;
  const { readRowsSinceAsync } = createRows(helpers);
  const commands: string[][] = [];
  await assert.rejects(readRowsSinceAsync({ ask, run: pagesOf(commands, rows) }), (error) => error instanceof helpers().WindowCutShort && /cut short/.test((error as Error).message));
  assert.ok(commands.length <= 3, `the read stopped near its bound (${commands.length} pages)`);
  assert.equal((await readRowsSinceAsync({ ask, run: pagesOf([], rows.slice(0, 150)) })).length, 150, "CONTROL: a window of two pages is read");
});

test("an admitted connection read whose answer is not a connection throws, never an empty list", async () => {
  const { readRowsSinceAsync } = createRows(helpers);
  const commands: string[][] = [];
  await assert.rejects(readRowsSinceAsync({ ask: { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", label: "ready", repo: REPO, select: "number" }, run: async (argv) => { commands.push([...argv]); return "[]"; } }), /did not come back as a connection/);
  assert.equal(commands.length, 1);
});

test("the watch's reader builds only lists: every connection command passes the read-only allowlist, none is a search, and the comments are selected only when asked for (#5076)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const commands: string[][] = [];
  const reader = createGhReader({ run: pagesOf(commands) });
  await reader.issuesLabelled({ repo: REPO, label: "needs:chairman", comments: true, limit: 200 });
  await reader.issuesLabelled({ repo: REPO, label: "ready" });
  await reader.mergedPullsSince({ repo: REPO, sinceMs: SINCE });
  assert.equal(commands.length, 3);
  for (const argv of commands) assert.doesNotThrow(() => assertReadOnlyWatch(argv), argv.join(" "));
  for (const argv of commands) assert.ok(!argv.includes("--label") && !argv.includes("--search"), `a search-backed list: ${argv.join(" ")}`);
  const [first, second, merged] = commands.map((argv) => readsRowsSince(argv));
  assert.deepEqual(first, { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", label: "needs:chairman", repo: REPO, after: null });
  assert.equal(second?.label, "ready");
  assert.deepEqual(merged, { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", label: null, repo: REPO, after: null });
  assert.match(commands[0].find((arg) => arg.startsWith("query=")) ?? "", /comments\(first:100\)\{nodes\{body createdAt authorAssociation\}\}/, "the comments are selected only when asked for");
  assert.doesNotMatch(commands[1].find((arg) => arg.startsWith("query=")) ?? "", /comments/);
});

test("the allowlist admits a GraphQL QUERY with variables and refuses a mutation, a second document, and a variable read from a file (#5076)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const commands: string[][] = [];
  await createGhReader({ run: pagesOf(commands) }).issuesLabelled({ repo: REPO, label: "ready" });
  const built = commands[0];
  assert.doesNotThrow(() => assertReadOnlyWatch(built), "POSITIVE CONTROL: the argv the reader really builds");
  const document = built.find((arg) => arg.startsWith("query=")) as string;
  const refused: [string, string[]][] = [
    ["a mutation", built.map((arg) => (arg === document ? document.replace("query=query(", "query=mutation(") : arg))],
    ["a mutation after the query", built.map((arg) => (arg === document ? `${document} mutation { x }` : arg))],
    ["a subscription", built.map((arg) => (arg === document ? document.replace("query=query(", "query=subscription(") : arg))],
    ["a second document", [...built, "-f", "query=mutation { x }"]],
    ["a variable read from a file", [...built, "-F", "x=@/etc/passwd"]],
    ["a flag that is not a variable", [...built, "--method", "POST"]],
    ["no document", ["api", "graphql", "-F", "owner=a"]],
    ["the document not first", ["api", "graphql", "-F", "owner=a", "-f", document]],
  ];
  for (const [what, argv] of refused) assert.throws(() => assertReadOnlyWatch(argv), /reads only/, what);
});

test("a label that looks like a flag is a VARIABLE's value, never a flag: the value is not a token of its own (#5076)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const commands: string[][] = [];
  await createGhReader({ run: pagesOf(commands) }).issuesLabelled({ repo: REPO, label: "--web" });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("label=--web"), "carried as `-F label=--web`");
  assert.ok(!commands[0].includes("--web"), "and never as a token that `gh` could read as a flag");
  assert.equal(commands[0][commands[0].indexOf("label=--web") - 1], "-F");
});

test("the merged filter drops a merge older than the window even if the connection returned it (it was UPDATED inside the window)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const rows = [
    { number: 1, mergedAt: "2026-10-01T07:00:00Z", updatedAt: "2026-10-01T07:00:00Z" },
    { number: 2, mergedAt: "2026-09-30T23:00:00Z", updatedAt: "2026-10-01T08:00:00Z" },
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  assert.deepEqual((await createGhReader({ run: pagesOf([], rows) }).mergedPullsSince({ repo: REPO, sinceMs: SINCE })).map((pull) => pull.number), [1]);
});

test("the watch's merged window the pages cannot hold THROWS, never a count cut short (#5076)", async () => {
  substituteCodeHost(withRealMessagingRows());
  const rows = Array.from({ length: 450 }, (_, i) => ({ number: i + 1, mergedAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T08:00:00Z" }));
  await assert.rejects(() => createGhReader({ run: pagesOf([], rows) }).mergedPullsSince({ repo: REPO, sinceMs: SINCE, limit: 100 }), /cut short/);
  assert.equal((await createGhReader({ run: pagesOf([], rows.slice(0, 150)) }).mergedPullsSince({ repo: REPO, sinceMs: SINCE, limit: 100 })).length, 150, "control: a window of two pages is read");
});
