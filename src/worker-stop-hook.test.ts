// no-token: gh -- no `gh`, `herdr` or `git` is run: the pull requests, the session and the tracker list are seams, the row the bound declares on is the fake code host's, and the only files written are a temporary state directory's
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
import { afterEach, test } from "node:test";
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
const { MAX_REFUSALS, STOP_HOOK_BOUND_KIND, STOP_HOOK_DIR, claimedRowOf, main, pullsOfRepository, runHook } = await import("./worker-stop-hook.ts");
// The fake code host is imported after the host file is named, as the hook is.
const { forgetActivation, substituteCodeHost } = await import("./plugins/active.ts");
const { createFakeCodeHost } = await import("./plugins/fakes/code-host.ts");
const { fakeRow } = await import("./plugins/fakes/code-host-rows.ts");
const { fakePull } = await import("./plugins/fakes/code-host-pulls.ts");

afterEach(() => forgetActivation());

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
  return { session: SESSION, trackers: TRACKERS, stateDir: dir, now: T0, prs: () => prs, owns, regionRepos: () => [], gh: NO_RUN, answerPrefix: ANSWER_PREFIX, sessionPrefix: SESSION_PREFIX, ...rest };
}
/** What the bound writes goes to the code host, whose fake acts on its own state: the executor the hook hands it is never run. */
const NO_RUN: Gh = () => {
  throw new Error("the fake acts on its own state: no run is made");
};
/** A comment as the row carries it: the fake numbers it, and its address is the one the fake renders. */
type RowCommentSeed = { id: string; url: string; createdAt: string; body: string };
/**
 * The fake code host, installed, holding the row the bound declares on (`agent-org#853`): OPEN or CLOSED (`row`) with `comments` and `labels` on it, or one the read of which is refused (`unreadable`, as a 502).
 * `asked` is the writes the bound asked of the code host (a label made, a label put on, a comment posted), recorded when they are called.
 */
function boundHost(row: "open" | "closed" | "unreadable" = "open", comments: RowCommentSeed[] = [], labels: string[] = []) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = REPO;
  world.rows.set(853, fakeRow(world, 853, { state: row === "closed" ? "CLOSED" : "OPEN", labels: [...labels], comments: comments.map(({ body, createdAt }, i) => ({ id: i + 1, body, createdAt })) }));
  if (row === "unreadable") world.failures.set("rowWithCommentsOf", Object.assign(new Error("HTTP 502"), { stderr: "HTTP 502" }));
  const asked: string[] = [];
  const operations = host.rows as unknown as Record<string, (request: unknown) => unknown>;
  for (const op of ["ensureTriageLabel", "addLabelToRowIn", "commentOnIssue"]) {
    const real = operations[op];
    operations[op] = (request) => { asked.push(op); return real(request); };
  }
  substituteCodeHost(host);
  const held = world.rows.get(853)!;
  return { asked, labels: () => held.labels, comments: () => held.comments.map(({ body }) => body) };
}
const declaredOf = (dir: string) => readDeclarations(`${dir}/${WORKER_STATE_DIR}`)?.byClaimant.get(SESSION);
const declare = (dir: string, atMinutes: number, state: "done" | "waiting-ci" = "waiting-ci") =>
  writeDeclaration(`${dir}/${WORKER_STATE_DIR}`, { session: SESSION, state, at: T0 + atMinutes * MIN, ...(state === "done" ? {} : { pr: { number: 901 } }) });
const countFile = (dir: string) => `${dir}/${STOP_HOOK_DIR}/${SESSION}.json`;
const ledgerEntries = (dir: string) => (existsSync(`${dir}/${FAILURE_LEDGER_FILE}`) ? parseFailureLedger(readFileSync(`${dir}/${FAILURE_LEDGER_FILE}`, "utf8")) : []);
/** The hook's verdict on a stop, with the session's declaration made `atMinutes` from the clock and a delivery ten minutes before it. */
const stopVerdictAfterDelivery = (atMinutes: number): number => {
  const dir = stateDir();
  declare(dir, atMinutes);
  writeFileSync(`${dir}/wake-ledger`, `${T0 - 10 * MIN}\t${SESSION}/claim-stalled/row-853\n`);
  return runHook(OFF, seams(dir)).code;
};
/** A row's third consecutive stop, `T0 + 5 min`, after two refusals: the verdict on the third. */
const thirdStopAtBound = (dir: string) => {
  runHook(OFF, seams(dir));
  runHook(OFF, seams(dir));
  return runHook(OFF, seams(dir, { now: T0 + 5 * MIN }));
};
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
  assert.equal(stopVerdictAfterDelivery(-30), 2, "a delivery to the session after the declaration: it describes an earlier turn");
  assert.equal(stopVerdictAfterDelivery(-5), 0, "twin: the same ledger, a declaration made after the delivery");
  assert.equal(runHook(OFF, seams(stateDir(), { prs: [{ ...PR_OF_THE_ROW, state: "CLOSED" }] })).code, 2, "closed without merging is not a deliverable");
  assert.equal(runHook(OFF, seams(stateDir(), { prs: [{ number: 7, state: "OPEN", headRefName: "agent/other-row-852", title: "Other (agent-org#852)", labels: [] }] })).code, 2, "another row's pull request");
});

test("BOUNDED: the third consecutive refusal for one row is not issued; the stop is allowed, ONE failure-ledger line is written, and the row is declared blocked for product-manager", () => {
  const dir = stateDir();
  const row = boundHost();
  assert.equal(MAX_REFUSALS, 2);
  assert.equal(runHook(OFF, seams(dir)).code, 2);
  assert.equal(runHook(OFF, seams(dir)).code, 2);
  assert.deepEqual(ledgerEntries(dir), [], "nothing is on the ledger while the hook is still refusing");
  assert.deepEqual(row.asked, [], "nothing is written to GitHub while the hook is still refusing");
  const third = runHook(OFF, seams(dir, { now: T0 + 5 * MIN }));
  assert.equal(third.code, 0, "the bound");
  assert.match(third.say.join("\n"), /ALLOWED/);
  const lines = ledgerEntries(dir);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { classKey: STOP_HOOK_BOUND_KIND, at: T0 + 5 * MIN, ref: `${REPO}#853` });
  assert.deepEqual(declaredOf(dir), { session: SESSION, state: "blocked", at: T0 + 5 * MIN, row: 853, repo: REPO, to: "product-manager", reason: `ended its turn after ${MAX_REFUSALS} refusals of worker:stop-hook with no pull request and no declaration; nothing says what it was waiting for` }, "the declaration the refusal named, made for the worker");
  assert.deepEqual(row.labels(), [`${ANSWER_PREFIX}product-manager`], "the answer label is put on the row");
  assert.deepEqual(row.comments().length, 1, "the reason is posted on the row");
});

/** The reason the bound declares, as `declareAtBound` writes it: the worker's own `BLOCKED` comment for it is what a repeat is checked against. */
const BOUND_REASON = `ended its turn after ${MAX_REFUSALS} refusals of worker:stop-hook with no pull request and no declaration; nothing says what it was waiting for`;
const commentAt = (createdAt: number, id: number, body: string) => ({ id: `IC_${id}`, url: `https://github.com/${REPO}/issues/853#issuecomment-${id}`, createdAt: new Date(createdAt).toISOString(), body });
const ownBoundComment = (createdAt: number) => commentAt(createdAt, 1, `BLOCKED (\`${SESSION}\`, declared with \`worker:state\`): ${BOUND_REASON}\n\nOwed by \`product-manager\`; the row carries \`${ANSWER_PREFIX}product-manager\`.`);
const seatComment = (createdAt: number, seat: string) => commentAt(createdAt, 2, `Ruled: wait for the pull request.\n\n<!-- decided-by: ${seat} run: 01 -->`);

test("at the bound, a reason a manager has ALREADY RULED ON restores no label: the declaration is written, and nothing is labelled or commented", () => {
  const dir = stateDir();
  const row = boundHost("open", [ownBoundComment(T0 - 60 * MIN), seatComment(T0 - 30 * MIN, "product-manager")]);
  const third = thirdStopAtBound(dir);
  assert.equal(third.code, 0, "the bound");
  assert.deepEqual(row.labels(), [], "no answer label is put back on the row");
  assert.equal(row.comments().length, 2, "no comment is posted: the row holds the two it had");
  assert.deepEqual(row.asked, [], "and the code host was asked to write nothing");
  assert.equal(declaredOf(dir)?.state, "blocked", "the declaration itself is still written");
});

test("negative controls for the ruling at the bound: a ruling older than the worker's own comment, and a ruling by a seat that is not a manager, each still restore the label", () => {
  const older = boundHost("open", [seatComment(T0 - 90 * MIN, "product-manager"), ownBoundComment(T0 - 60 * MIN)]);
  thirdStopAtBound(stateDir());
  assert.deepEqual(older.labels(), [`${ANSWER_PREFIX}product-manager`], "a ruling older than the own comment answers nothing new");
  const reviewer = boundHost("open", [ownBoundComment(T0 - 60 * MIN), seatComment(T0 - 30 * MIN, "reviewer-agent-org-853")]);
  thirdStopAtBound(stateDir());
  assert.deepEqual(reviewer.labels(), [`${ANSWER_PREFIX}product-manager`], "a reviewer's comment is not a ruling");
});

/** A `BLOCKED` comment the worker left on the row, owing an answer to `to`, with the reason as `applyLabel` writes it. */
const blockedComment = (createdAt: number, id: number, reason: string, to = "product-manager") =>
  commentAt(createdAt, id, `BLOCKED (\`${SESSION}\`, declared with \`worker:state\`): ${reason}\n\nOwed by \`${to}\`; the row carries \`${ANSWER_PREFIX}${to}\`.`);
const answeredReason = (earlier: string) => `second bound after an answered block (${earlier}); the turn ended again with no pull request and no declaration`;

test("POSITIVE CONTROL (agent-org#1687): at the bound, a block the answer has since cleared is named in the declared reason, and the repeat says so on the row", () => {
  const dir = stateDir();
  const row = boundHost("open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step")]);
  runHook(OFF, seams(dir));
  runHook(OFF, seams(dir));
  assert.equal(runHook(OFF, seams(dir, { now: T0 + 5 * MIN })).code, 0, "the bound");
  assert.equal(declaredOf(dir)?.reason, answeredReason("row-file refuses the milestone step"), "the declared reason names the answered block");
  assert.deepEqual(row.labels(), [`${ANSWER_PREFIX}product-manager`], "no ruling on that block, so the answer is owed again");
  assert.ok(String(row.comments().at(-1)).includes(answeredReason("row-file refuses the milestone step")), "the row's comment carries the same reason");
});

test("the answered-block reason quotes the first line of a longer reason only, and keeps today's text for a block still owed an answer and for one whose time cannot be read", () => {
  const longer = stateDir();
  boundHost("open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step\nthe second line of the reason")]);
  thirdStopAtBound(longer);
  assert.equal(declaredOf(longer)?.reason, answeredReason("row-file refuses the milestone step"), "only the first line is quoted");
  const owed = stateDir();
  boundHost("open", [blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step")], [`${ANSWER_PREFIX}product-manager`]);
  thirdStopAtBound(owed);
  assert.equal(declaredOf(owed)?.reason, BOUND_REASON, "the label is still on the row: no answer has come, so today's text");
  const unread = stateDir();
  boundHost("open", [{ ...blockedComment(T0 - 60 * MIN, 1, "row-file refuses the milestone step"), createdAt: "not a time" }]);
  const third = thirdStopAtBound(unread);
  assert.equal(third.code, 0, "the declaration is still made: an unreadable earlier block withholds only the enrichment");
  assert.equal(declaredOf(unread)?.reason, BOUND_REASON, "its time cannot be read, so today's text");
  assert.equal(ledgerEntries(unread).length, 1, "the ledger line is still written");
});

test("at the bound, a row that cannot be read or is closed gets no declaration: the stop is still allowed, the ledger line is still written, and the failure is said", () => {
  for (const row of ["unreadable", "closed"] as const) {
    const dir = stateDir();
    const held = boundHost(row);
    const third = thirdStopAtBound(dir);
    assert.equal(third.code, 0, row);
    assert.match(third.say.join("\n"), /NOT DECLARED/, row);
    assert.equal(declaredOf(dir), undefined, `${row}: nothing is declared`);
    assert.equal(ledgerEntries(dir).length, 1, `${row}: the ledger line is still written`);
    assert.deepEqual([held.labels(), held.comments(), held.asked], [[], [], []], `${row}: nothing is labelled or commented`);
  }
});

test("the bound writes NO declaration when the worker has an open pull request at the same count", () => {
  const dir = stateDir();
  mkdirSync(`${dir}/${STOP_HOOK_DIR}`, { recursive: true });
  writeFileSync(countFile(dir), `${JSON.stringify({ row: "agent-org#853", refusals: MAX_REFUSALS })}\n`);
  const row = boundHost();
  assert.deepEqual(runHook(OFF, seams(dir, { prs: [PR_OF_THE_ROW] })), { code: 0, say: [] });
  assert.deepEqual(row.asked, [], "nothing is written to GitHub");
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

// A11-160, step 9: the live hook lists a repository's pull requests through the code host's rows (`pullsOfRepository`), with the `Gh` it runs `gh` through for everything else. These cases hold what the hook DOES with the listing:
// the repository is stamped on each pull request (a bare `#1713` in a body names the repository it was listed from), every state is listed, and a listing the code host cannot make THROWS, which the hook turns into an
// allowance that says it could not read them. The arguments and the answer's parse (`--state all --limit 100`, an object that is not a list) are `plugins/github/rows/pullwork-rows.test.ts`.
test("the pull requests of a repository are listed in any state, each stamped with the repository it was listed from", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  fakePull(host.rowsWorld, 901, { headRefName: "agent/a-stop-hook-in-agent-org-853", title: "A Stop hook", labels: [`session:${SESSION}`], body: "Closes #853" });
  fakePull(host.rowsWorld, 902, { headRefName: "agent/merged", merged: true, mergedAt: "2026-10-11T08:00:00Z" });
  substituteCodeHost(host);
  const listed = pullsOfRepository(REPO, () => { throw new Error("the listing runs on the code host's rows, not on the hook's program"); });
  assert.deepEqual(listed.map((pr) => [pr.number, pr.state, pr.repo]), [[901, "OPEN", REPO], [902, "MERGED", REPO]]);
  assert.deepEqual(listed[0].labels, [{ name: `session:${SESSION}` }]);
  assert.equal(listed[0].body, "Closes #853");
});

test("a listing the code host cannot make throws, and the hook then ALLOWS the stop and says the pull requests could not be read", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.failures.set("pullsListedForStop", Object.assign(new Error("Command failed: gh pr list"), { stderr: "HTTP 502" }));
  substituteCodeHost(host);
  assert.throws(() => pullsOfRepository(REPO, () => ""), /Command failed/);
  const dir = stateDir();
  const result = runHook(OFF, { ...seams(dir), prs: (repo) => pullsOfRepository(repo, () => "") });
  assert.equal(result.code, 0, "allowed, not refused");
  assert.match(result.say.join("\n"), /could not be read \(HTTP 502\).*UNREAD/s);
  assert.equal(existsSync(countFile(dir)), false, "no refusal is counted");
});
