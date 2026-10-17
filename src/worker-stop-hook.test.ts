// no-token: gh -- no `gh`, `herdr` or `git` is run: the pull requests, the session and the tracker list are seams, and the only files written are a temporary state directory's
// a11ign#4957 cause 4: a claimed worker that ends its turn with no open pull request and no declaration is REFUSED the stop, by name, twice at most (agent-org#853).
//
// EVERY ALLOWANCE HAS A TWIN: the refusal fixture with ONE thing changed. A hook that refuses nothing turns the refusal case red, and one that refuses everything turns the
// allowances red. THE REFUSAL CASE IS THE POSITIVE CONTROL for the four allowances: it is what proves the allowances are not "the hook never fires". The mutations, both
// directions, are in the pull request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "./failure-ledger.ts";
import type { Gh } from "./worker-state.ts";
import type { Seams, StopPr } from "./worker-stop-hook.ts";

// agent-org#1147: THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health.test.ts`'s #3233 rule). The hook's imports reach `board-snapshot-scope.ts`, which reads the
// project's declaration when it is imported, and with no `$AGENT_ORG_HOST` that is wherever the suite happens to be run from: the file passed in the project's tree (CI) and the
// program run below exited 1 anywhere else. The host file is set FIRST and the hook imported AFTER it, dynamically, and the program is handed the same file.
const SCRATCH = mkdtempSync(join(tmpdir(), "worker-stop-hook-project-"));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { WORKER_STATE_DIR, readDeclarations, writeDeclaration } = await import("./worker-state.ts");
const { ANSWER_PREFIX, SESSION_PREFIX } = await import("./project-vocabulary.ts");
const { MAX_REFUSALS, STOP_HOOK_BOUND_KIND, STOP_HOOK_DIR, claimedRowOf, main, runHook } = await import("./worker-stop-hook.ts");

const T0 = Date.parse("2026-10-11T09:00:00Z");
const MIN = 60_000;
const SESSION = "worker-agent-org-853";
const TRACKERS = [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }];
const REPO = "a11ign/agent-org";
const PR_OF_THE_ROW: StopPr = { number: 901, state: "OPEN", headRefName: "agent/a-stop-hook-in-agent-org-853", title: "A Stop hook (agent-org#853)", labels: [{ name: `session:${SESSION}` }] };
/** `ownsPr`'s rungs that matter here, restated so the pure half needs no project declaration: the head ends `-<row>`, or the title ends with the reference, or the body
 * closes the row by it (`Closes <repo>#<row>`, the rung `liveSeams` adds to `ownsPr`). */
const owns: Seams["owns"] = (claim, pr) => (pr.headRefName ?? "").endsWith(`-${claim.row}`) || (pr.title ?? "").trimEnd().endsWith(`${claim.trackerRepo}#${claim.row})`)
  || new RegExp(`^Closes ${claim.trackerRepo}#${claim.row}$`, "m").test(pr.body ?? "");

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-stop-hook-"));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** The refusal fixture, with `over` changed. `prs` is what the repository lists. */
function seams(dir: string, over: Omit<Partial<Seams>, "prs"> & { prs?: StopPr[] } = {}): Seams {
  const { prs = [], ...rest } = over;
  return { session: SESSION, trackers: TRACKERS, stateDir: dir, now: T0, prs: () => prs, owns, regionRepos: () => [], gh: fakeGh([]), answerPrefix: ANSWER_PREFIX, sessionPrefix: SESSION_PREFIX, ...rest };
}
/** The `gh` the bound writes through, every call recorded in `calls`: the row is read OPEN, CLOSED, or not at all (`row`) with `comments` and `labels` on it, and the writes answer nothing. */
function fakeGh(calls: string[][], row: "open" | "closed" | "unreadable" = "open", comments: object[] = [], labels: string[] = []): Gh {
  return (args) => {
    calls.push(args);
    if (args[0] !== "issue" || args[1] !== "view") return "";
    if (row === "unreadable") throw Object.assign(new Error("HTTP 502"), { stderr: "HTTP 502" });
    return JSON.stringify({ state: row === "open" ? "OPEN" : "CLOSED", labels: labels.map((name) => ({ name })), comments });
  };
}
const declaredOf = (dir: string) => readDeclarations(`${dir}/${WORKER_STATE_DIR}`)?.byClaimant.get(SESSION);
const declare = (dir: string, atMinutes: number, state: "done" | "waiting-ci" = "waiting-ci") =>
  writeDeclaration(`${dir}/${WORKER_STATE_DIR}`, { session: SESSION, state, at: T0 + atMinutes * MIN, ...(state === "done" ? {} : { pr: { number: 901 } }) });
const countFile = (dir: string) => `${dir}/${STOP_HOOK_DIR}/${SESSION}.json`;
const ledgerEntries = (dir: string) => (existsSync(`${dir}/${FAILURE_LEDGER_FILE}`) ? parseFailureLedger(readFileSync(`${dir}/${FAILURE_LEDGER_FILE}`, "utf8")) : []);
const OFF = {};

test("POSITIVE CONTROL: a claimed worker with no open pull request and no declaration is refused, and the message names both commands", () => {
  const dir = stateDir();
  const result = runHook(OFF, seams(dir));
  assert.equal(result.code, 2);
  const said = result.say.join("\n");
  assert.match(said, /agent-org pr:open/, "the command for pushed work");
  assert.match(said, /agent-org worker:state blocked agent-org#853 <reason>/, "the command for work that cannot go on, with the row spelt as worker:state reads it");
  assert.match(said, /STOP REFUSED \(1 of 2\)/);
  assert.equal(JSON.parse(readFileSync(countFile(dir), "utf8")).refusals, 1, "the refusal is counted");
});

test("a fresh declaration, an open pull request, a merged one, stop_hook_active and a non-worker each stop normally (each twin is the refusal fixture with one thing changed)", () => {
  const declared = stateDir();
  declare(declared, -5);
  assert.deepEqual(runHook(OFF, seams(declared)), { code: 0, say: [] }, "a declaration made since the turn began (no delivery on record)");
  assert.deepEqual(runHook(OFF, seams(stateDir(), { prs: [PR_OF_THE_ROW] })), { code: 0, say: [] }, "an open pull request of the row");
  assert.deepEqual(runHook(OFF, seams(stateDir(), { prs: [{ ...PR_OF_THE_ROW, state: "MERGED" }] })), { code: 0, say: [] }, "a merged one: the deliverable landed");
  assert.deepEqual(runHook({ stop_hook_active: true }, seams(stateDir())), { code: 0, say: [] }, "Claude Code is already continuing because of the last refusal");
  assert.deepEqual(runHook(OFF, seams(stateDir(), { session: "ceo" })), { code: 0, say: [] }, "a standing seat is not a worker");
  assert.deepEqual(runHook(OFF, seams(stateDir(), { session: null })), { code: 0, say: [] }, "an unknown caller is no session");
  assert.deepEqual(runHook(OFF, seams(stateDir(), { session: "worker-capture-2407" })), { code: 0, say: [] }, "a worker name that carries no declared tracker's row holds no claim here");
});

test("the twins of the allowances still refuse: a declaration older than the turn, a closed pull request, another row's", () => {
  const stale = stateDir();
  declare(stale, -30);
  writeFileSync(`${stale}/wake-ledger`, `${T0 - 10 * MIN}\t${SESSION}/claim-stalled/row-853\n`);
  assert.equal(runHook(OFF, seams(stale)).code, 2, "a delivery to the session after the declaration: it describes an earlier turn");
  const fresh = stateDir();
  declare(fresh, -5);
  writeFileSync(`${fresh}/wake-ledger`, `${T0 - 10 * MIN}\t${SESSION}/claim-stalled/row-853\n`);
  assert.equal(runHook(OFF, seams(fresh)).code, 0, "twin: the same ledger, a declaration made after the delivery");
  assert.equal(runHook(OFF, seams(stateDir(), { prs: [{ ...PR_OF_THE_ROW, state: "CLOSED" }] })).code, 2, "closed without merging is not a deliverable");
  assert.equal(runHook(OFF, seams(stateDir(), { prs: [{ number: 7, state: "OPEN", headRefName: "agent/other-row-852", title: "Other (agent-org#852)", labels: [] }] })).code, 2, "another row's pull request");
});

test("BOUNDED: the third consecutive refusal for one row is not issued; the stop is allowed, ONE failure-ledger line is written, and the row is declared blocked for product-manager", () => {
  const dir = stateDir();
  const calls: string[][] = [];
  const gh = fakeGh(calls);
  assert.equal(MAX_REFUSALS, 2);
  assert.equal(runHook(OFF, seams(dir, { gh })).code, 2);
  assert.equal(runHook(OFF, seams(dir, { gh })).code, 2);
  assert.deepEqual(ledgerEntries(dir), [], "nothing is on the ledger while the hook is still refusing");
  assert.equal(calls.length, 0, "nothing is written to GitHub while the hook is still refusing");
  const third = runHook(OFF, seams(dir, { now: T0 + 5 * MIN, gh }));
  assert.equal(third.code, 0, "the bound");
  assert.match(third.say.join("\n"), /ALLOWED/);
  const lines = ledgerEntries(dir);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { classKey: STOP_HOOK_BOUND_KIND, at: T0 + 5 * MIN, ref: `${REPO}#853` });
  assert.deepEqual(declaredOf(dir), { session: SESSION, state: "blocked", at: T0 + 5 * MIN, row: 853, repo: REPO, to: "product-manager", reason: `ended its turn after ${MAX_REFUSALS} refusals of worker:stop-hook with no pull request and no declaration; nothing says what it was waiting for` }, "the declaration the refusal named, made for the worker");
  assert.ok(calls.some((args) => args.join(" ") === `issue edit 853 --repo ${REPO} --add-label ${ANSWER_PREFIX}product-manager`), "the answer label is put on the row");
  assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "comment" && args[2] === "853"), "the reason is posted on the row");
});

/** The reason the bound declares, as `declareAtBound` writes it: the worker's own `BLOCKED` comment for it is what a repeat is checked against. */
const BOUND_REASON = `ended its turn after ${MAX_REFUSALS} refusals of worker:stop-hook with no pull request and no declaration; nothing says what it was waiting for`;
const commentAt = (createdAt: number, id: number, body: string) => ({ id: `IC_${id}`, url: `https://github.com/${REPO}/issues/853#issuecomment-${id}`, createdAt: new Date(createdAt).toISOString(), body });
const ownBoundComment = (createdAt: number) => commentAt(createdAt, 1, `BLOCKED (\`${SESSION}\`, declared with \`worker:state\`): ${BOUND_REASON}\n\nOwed by \`product-manager\`; the row carries \`${ANSWER_PREFIX}product-manager\`.`);
const seatComment = (createdAt: number, seat: string) => commentAt(createdAt, 2, `Ruled: wait for the pull request.\n\n<!-- decided-by: ${seat} run: 01 -->`);

test("at the bound, a reason a manager has ALREADY RULED ON restores no label: the declaration is written, and nothing is labelled or commented", () => {
  const dir = stateDir();
  const calls: string[][] = [];
  const gh = fakeGh(calls, "open", [ownBoundComment(T0 - 60 * MIN), seatComment(T0 - 30 * MIN, "product-manager")]);
  runHook(OFF, seams(dir, { gh }));
  runHook(OFF, seams(dir, { gh }));
  const third = runHook(OFF, seams(dir, { now: T0 + 5 * MIN, gh }));
  assert.equal(third.code, 0, "the bound");
  assert.ok(!calls.some((args) => args.includes("--add-label")), "no answer label is put back on the row");
  assert.ok(!calls.some((args) => args[0] === "issue" && args[1] === "comment"), "no comment is posted");
  assert.equal(declaredOf(dir)?.state, "blocked", "the declaration itself is still written");
});

test("negative controls for the ruling at the bound: a ruling older than the worker's own comment, and a ruling by a seat that is not a manager, each still restore the label", () => {
  const older = stateDir();
  const olderCalls: string[][] = [];
  const olderGh = fakeGh(olderCalls, "open", [seatComment(T0 - 90 * MIN, "product-manager"), ownBoundComment(T0 - 60 * MIN)]);
  runHook(OFF, seams(older, { gh: olderGh }));
  runHook(OFF, seams(older, { gh: olderGh }));
  runHook(OFF, seams(older, { now: T0 + 5 * MIN, gh: olderGh }));
  assert.ok(olderCalls.some((args) => args.join(" ") === `issue edit 853 --repo ${REPO} --add-label ${ANSWER_PREFIX}product-manager`), "a ruling older than the own comment answers nothing new");
  const reviewer = stateDir();
  const reviewerCalls: string[][] = [];
  const reviewerGh = fakeGh(reviewerCalls, "open", [ownBoundComment(T0 - 60 * MIN), seatComment(T0 - 30 * MIN, "reviewer-agent-org-853")]);
  runHook(OFF, seams(reviewer, { gh: reviewerGh }));
  runHook(OFF, seams(reviewer, { gh: reviewerGh }));
  runHook(OFF, seams(reviewer, { now: T0 + 5 * MIN, gh: reviewerGh }));
  assert.ok(reviewerCalls.some((args) => args.join(" ") === `issue edit 853 --repo ${REPO} --add-label ${ANSWER_PREFIX}product-manager`), "a reviewer's comment is not a ruling");
});

/** A `BLOCKED` comment the worker left on the row, owing an answer to `to`, with the reason as `applyLabel` writes it. */
const blockedComment = (createdAt: number, id: number, reason: string, to = "product-manager") =>
  commentAt(createdAt, id, `BLOCKED (\`${SESSION}\`, declared with \`worker:state\`): ${reason}\n\nOwed by \`${to}\`; the row carries \`${ANSWER_PREFIX}${to}\`.`);
const answeredReason = (earlier: string) => `second bound after an answered block (${earlier}); the turn ended again with no pull request and no declaration`;

test("POSITIVE CONTROL (agent-org#1687): at the bound, a block the answer has since cleared is named in the declared reason, and the repeat says so on the row", () => {
  const dir = stateDir();
  const calls: string[][] = [];
  const gh = fakeGh(calls, "open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step")]);
  runHook(OFF, seams(dir, { gh }));
  runHook(OFF, seams(dir, { gh }));
  assert.equal(runHook(OFF, seams(dir, { now: T0 + 5 * MIN, gh })).code, 0, "the bound");
  assert.equal(declaredOf(dir)?.reason, answeredReason("row-file refuses the milestone step"), "the declared reason names the answered block");
  assert.ok(calls.some((args) => args.join(" ") === `issue edit 853 --repo ${REPO} --add-label ${ANSWER_PREFIX}product-manager`), "no ruling on that block, so the answer is owed again");
  const posted = calls.find((args) => args[0] === "issue" && args[1] === "comment");
  assert.ok(String(posted?.at(-1)).includes(answeredReason("row-file refuses the milestone step")), "the row's comment carries the same reason");
});

test("the answered-block reason quotes the first line of a longer reason only, and keeps today's text for a block still owed an answer and for one whose time cannot be read", () => {
  const longer = stateDir();
  const longerGh = fakeGh([], "open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step\nthe second line of the reason")]);
  runHook(OFF, seams(longer, { gh: longerGh }));
  runHook(OFF, seams(longer, { gh: longerGh }));
  runHook(OFF, seams(longer, { now: T0 + 5 * MIN, gh: longerGh }));
  assert.equal(declaredOf(longer)?.reason, answeredReason("row-file refuses the milestone step"), "only the first line is quoted");
  const owed = stateDir();
  const owedCalls: string[][] = [];
  const owedGh = fakeGh(owedCalls, "open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step")], [`${ANSWER_PREFIX}product-manager`]);
  runHook(OFF, seams(owed, { gh: owedGh }));
  runHook(OFF, seams(owed, { gh: owedGh }));
  runHook(OFF, seams(owed, { now: T0 + 5 * MIN, gh: owedGh }));
  assert.equal(declaredOf(owed)?.reason, BOUND_REASON, "the label is still on the row: no answer has come, so today's text");
  const unread = stateDir();
  const unreadGh = fakeGh([], "open", [{ ...blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step"), createdAt: "not a time" }]);
  runHook(OFF, seams(unread, { gh: unreadGh }));
  runHook(OFF, seams(unread, { gh: unreadGh }));
  const third = runHook(OFF, seams(unread, { now: T0 + 5 * MIN, gh: unreadGh }));
  assert.equal(third.code, 0, "the declaration is still made: an unreadable earlier block withholds only the enrichment");
  assert.equal(declaredOf(unread)?.reason, BOUND_REASON, "its time cannot be read, so today's text");
  assert.equal(ledgerEntries(unread).length, 1, "the ledger line is still written");
});

test("at the bound, a row that cannot be read or is closed gets no declaration: the stop is still allowed, the ledger line is still written, and the failure is said", () => {
  for (const row of ["unreadable", "closed"] as const) {
    const dir = stateDir();
    const calls: string[][] = [];
    const gh = fakeGh(calls, row);
    runHook(OFF, seams(dir, { gh }));
    runHook(OFF, seams(dir, { gh }));
    const third = runHook(OFF, seams(dir, { now: T0 + 5 * MIN, gh }));
    assert.equal(third.code, 0, row);
    assert.match(third.say.join("\n"), /NOT DECLARED/, row);
    assert.equal(declaredOf(dir), undefined, `${row}: nothing is declared`);
    assert.equal(ledgerEntries(dir).length, 1, `${row}: the ledger line is still written`);
    assert.ok(!calls.some((args) => args[0] === "label" || args.includes("--add-label") || args[1] === "comment"), `${row}: nothing is labelled or commented`);
  }
});

test("the bound writes NO declaration when the worker has an open pull request at the same count", () => {
  const dir = stateDir();
  mkdirSync(`${dir}/${STOP_HOOK_DIR}`, { recursive: true });
  writeFileSync(countFile(dir), `${JSON.stringify({ row: "agent-org#853", refusals: MAX_REFUSALS })}\n`);
  const calls: string[][] = [];
  assert.deepEqual(runHook(OFF, seams(dir, { prs: [PR_OF_THE_ROW], gh: fakeGh(calls) })), { code: 0, say: [] });
  assert.deepEqual(calls, [], "nothing is written to GitHub");
  assert.equal(declaredOf(dir), undefined, "no declaration");
});

test("a satisfied turn clears the run, a different row starts one, and a refusal never touches worker-state/", () => {
  const dir = stateDir();
  assert.equal(runHook(OFF, seams(dir)).code, 2);
  assert.equal(runHook(OFF, seams(dir, { prs: [PR_OF_THE_ROW] })).code, 0, "a pull request opened between the two turns");
  assert.equal(JSON.parse(readFileSync(countFile(dir), "utf8")).refusals, 0, "the run ended");
  assert.match(runHook(OFF, seams(dir)).say.join("\n"), /\(1 of 2\)/, "so the next loose end is the FIRST refusal again, not the second");
  const other = stateDir();
  mkdirSync(`${other}/${STOP_HOOK_DIR}`, { recursive: true });
  writeFileSync(countFile(other), `${JSON.stringify({ row: "agent-org#852", refusals: 2 })}\n`);
  assert.equal(runHook(OFF, seams(other)).code, 2, "another row's exhausted count is not this row's");
  const read = readDeclarations(`${other}/${WORKER_STATE_DIR}`);
  assert.deepEqual(read, { byClaimant: new Map(), unreadable: [] }, "no count file sits where the gate reads declarations");
  assert.deepEqual(readdirSync(other).sort(), [STOP_HOOK_DIR]);
});

test("it fails open and says so: unreadable declarations, an unreadable board, an unreadable count, a payload that is not JSON", async () => {
  const noDeclarations = stateDir();
  writeFileSync(`${noDeclarations}/${WORKER_STATE_DIR}`, "a file where the directory should be");
  const first = runHook(OFF, seams(noDeclarations));
  assert.equal(first.code, 0);
  assert.match(first.say.join("\n"), /could not be read/);
  const board = runHook(OFF, { ...seams(stateDir()), prs: () => { throw new Error("HTTP 502"); } });
  assert.equal(board.code, 0);
  assert.match(board.say.join("\n"), /HTTP 502/);
  const corrupt = stateDir();
  mkdirSync(`${corrupt}/${STOP_HOOK_DIR}`, { recursive: true });
  writeFileSync(countFile(corrupt), "{not json");
  assert.equal(runHook(OFF, seams(corrupt)).code, 0, "a count that cannot be read cannot bound a refusal, so none is issued");
  const garbled = await main("not json", [], {}, async () => { throw new Error("the seams must not be asked for"); });
  assert.equal(garbled.code, 0);
  assert.match(garbled.say.join("\n"), /payload could not be read/);
});

test("driven through the entry with the hook payload as stdin text: refused, then allowed on stop_hook_active without reading anything", async () => {
  const dir = stateDir();
  const live = async () => seams(dir);
  const refused = await main(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, session_id: "x" }), [], {}, live);
  assert.equal(refused.code, 2);
  assert.match(refused.say.join("\n"), /agent-org pr:open/);
  const continuing = await main(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }), [], {}, async () => { throw new Error("must not be read"); });
  assert.deepEqual(continuing, { code: 0, say: [] });
});

test("the program itself, run as the hook is: stop_hook_active ends in exit 0 and says nothing, and a payload that is not JSON exits 0 and says why", () => {
  const program = fileURLToPath(new URL("./worker-stop-hook.ts", import.meta.url));
  const run = (input: string) => spawnSync(process.execPath, [program], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "", AGENT_ORG_HOST: HOST_FILE } });
  const continuing = run(JSON.stringify({ stop_hook_active: true }));
  assert.deepEqual([continuing.status, continuing.stderr], [0, ""]);
  const garbled = run("not json");
  assert.equal(garbled.status, 0);
  assert.match(garbled.stderr, /ALLOWED/);
});

// agent-org#1713: a deliverable whose `## Region` names a file of another code repository is a pull request THERE. The row here is agent-org#853; its Region names the first
// repository (`a11ign/a11ign`), and the pull request is in that repository and closes the row by its reference.
const ELSEWHERE = "a11ign/a11ign";
const CLOSES_THE_ROW: StopPr = { number: 77, state: "OPEN", headRefName: "agent/stop-hook-in-the-hook-repo", title: "Stop hook, in the hook repository", labels: [], body: `Closes ${REPO}#853` };
/** `prs` answering only for the repositories named in `listed`, every repository asked recorded in `read`. */
function listing(read: string[], listed: Record<string, StopPr[]>, unreadable: string[] = []): Seams["prs"] {
  return (repo) => {
    read.push(repo);
    if (unreadable.includes(repo)) throw Object.assign(new Error("HTTP 502"), { stderr: "HTTP 502" });
    return listed[repo] ?? [];
  };
}

test("a pull request in another repository of the row's Region satisfies the stop: the Region's repository is read, and the row's own pull request closing the row is found there", () => {
  const dir = stateDir();
  const read: string[] = [];
  const result = runHook(OFF, { ...seams(dir), regionRepos: () => [ELSEWHERE], prs: listing(read, { [ELSEWHERE]: [CLOSES_THE_ROW] }) });
  assert.deepEqual(result, { code: 0, say: [] }, "no refusal and no bound line");
  assert.deepEqual(read, [REPO, ELSEWHERE], "the row's tracker, then the repository its Region names");
  assert.equal(existsSync(countFile(dir)), false, "a satisfied turn writes no refusal count");
  assert.deepEqual(ledgerEntries(dir), [], "no ledger line");
});

test("a pull request in a repository the Region does not name does not satisfy the stop, and that repository is never read (positive control for the one above)", () => {
  const dir = stateDir();
  const read: string[] = [];
  const result = runHook(OFF, { ...seams(dir), regionRepos: () => [ELSEWHERE], prs: listing(read, { "a11ign/unnamed": [CLOSES_THE_ROW] }) });
  assert.equal(result.code, 2, "refused: the row's pull request is not in a repository its Region names");
  assert.deepEqual(read, [REPO, ELSEWHERE], "the unnamed repository is never asked");
});

test("an unreadable repository the Region names is a said allowance: the stop is allowed with UNREAD, and it is neither a refusal nor a ledger line", () => {
  const dir = stateDir();
  const read: string[] = [];
  const result = runHook(OFF, { ...seams(dir), regionRepos: () => [ELSEWHERE], prs: listing(read, {}, [ELSEWHERE]) });
  assert.equal(result.code, 0, "allowed, not refused");
  assert.match(result.say.join("\n"), /UNREAD/);
  assert.match(result.say.join("\n"), new RegExp(ELSEWHERE));
  assert.equal(existsSync(countFile(dir)), false, "no refusal is counted");
  assert.deepEqual(ledgerEntries(dir), [], "no ledger line");
});

test("a Region that cannot be read is a said allowance too: the stop is allowed with UNREAD, with no refusal and no ledger line", () => {
  const dir = stateDir();
  const result = runHook(OFF, { ...seams(dir), regionRepos: () => { throw Object.assign(new Error("HTTP 502"), { stderr: "HTTP 502" }); } });
  assert.equal(result.code, 0, "allowed, not refused");
  assert.match(result.say.join("\n"), /UNREAD/);
  assert.equal(existsSync(countFile(dir)), false, "no refusal is counted");
  assert.deepEqual(ledgerEntries(dir), [], "no ledger line");
});

test("a row whose Region names only its own tracker reads that one repository, as today", () => {
  const dir = stateDir();
  const read: string[] = [];
  const result = runHook(OFF, { ...seams(dir), regionRepos: () => [REPO], prs: listing(read, {}) });
  assert.equal(result.code, 2, "refused: nothing of the row is open anywhere");
  assert.deepEqual(read, [REPO], "the own tracker is the only repository read");
});

test("claimedRowOf: the first tracker's row, another tracker's, and the names that are none", () => {
  assert.deepEqual(claimedRowOf("worker-4202", TRACKERS), { key: "", row: 4202, repo: "a11ign/a11ign" });
  assert.deepEqual(claimedRowOf(SESSION, TRACKERS), { key: "agent-org", row: 853, repo: REPO });
  assert.equal(claimedRowOf("worker-capture-2407", TRACKERS), null, "an undeclared key");
  assert.equal(claimedRowOf("worker-agent-org", TRACKERS), null, "no row number");
  assert.equal(claimedRowOf("worker-agent-org-7-853", TRACKERS), null, "a key that ends in digits parses two ways, so it is none");
});
