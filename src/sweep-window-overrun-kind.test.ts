// no-token: gh -- the code host is the fake's (A11-160, step 9); nothing here reaches the network (agent-org#1314)
/**
 * agent-org#1314: AN OVERRUN THAT RELEASED ITS SWEEP LOCK IS THE GUARD WORKING, so it is NOT a failure. `reportSweepWindows` writes the released overrun under
 * `sweep-window-released` -- a counter that is no class and no repeat -- and `sweep-overrun` is kept for the failure that follows it: a claim REFUSED on a swept Region after the
 * sweep's overrun notice (`recordOverrunRefusal`, ref = the refused row).
 *
 * POSITIVE AND NEGATIVE CONTROLS, NAMED: the release is read back from a ledger file (`parseFailureLedger`) and through `class-repeat` (`repeatsIn` + `groupByClass`) -- three
 * released overruns make NO `sweep-overrun` group, while the same three lines under `sweep-overrun` make one. The refusal control is the same claim with and without the notice.
 *
 * THE CLAIM IS THE REAL ONE: `sessionEligibilityReason` over the fake code host's rows, as in `sweep-window.test.ts`, so the refusal text is the one `row-claim` prints.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

// THE PROJECT IS A RECORDED ONE, as in `sweep-window.test.ts`: the host file is set FIRST and the tool imported AFTER it.
const SCRATCH = mkdtempSync(join(tmpdir(), "sweep-window-overrun-kind-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const STATE_DIR = join(SCRATCH, "state");
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), stateDir: STATE_DIR, primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
for (const dir of ["packages", "scripts", "docs", ".github", ".claude"]) {
  mkdirSync(join(PROJECT, dir), { recursive: true });
  writeFileSync(join(PROJECT, dir, "tracked"), "");
}
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
execFileSync("git", ["add", "-A"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { OVERRUN_MARKER, SWEEP_OVERRUN_KIND, readSweepWindows, recordOverrunRefusal, reportSweepWindows } = await import("./sweep-window.ts");
const { claimRow, sessionEligibilityReason } = await import("./row-claim.ts");
const { forgetActivation, substituteCodeHost } = await import("./plugins/active.ts");
const { FAILURE_LEDGER_FILE, SWEEP_WINDOW_RELEASED_KIND, parseFailureLedger, repeatsIn } = await import("./failure-ledger.ts");
const { groupByClass } = await import("./class-repeat.ts");
const { stateEntryPath } = await import("./host-config.ts");
const { CHAIRMAN_LOGINS } = await import("./work-gate/vocabulary.ts");

const MIN = 60_000;
const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const SWEEP = 4389;
const ASKER = 5000;
const NOW = Date.UTC(2026, 9, 9, 18, 0, 0);
const WINDOW_MS = 7 * 24 * 60 * MIN;

// THE FAKE LEDGER: one scratch file per test, written by the real `recordFailures` and read back as text. The default ledger is the host's, which these tests never touch.
let ledgerFiles = 0;
const ledgerPath = () => join(SCRATCH, `ledger-${(ledgerFiles += 1)}`);
const readBack = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const linesOf = (text: string, kind: string) => text.split("\n").filter((line) => line.startsWith(`${kind}\t`));

// A sweep whose box is spent: claimed 200 minutes ago, no pull request, so the box started at the deadline for opening one (15 minutes after the claim).
const overrunSweep = (number: number) => ({ number, session: "worker-4389", files: ["agent-org:src/"], claimedAt: NOW - 200 * MIN, prOpenedAt: null, reported: { stalled: false, overrun: false } });

// --- the release: `reportSweepWindows` writes `sweep-window-released`, never `sweep-overrun` -------------------------------------------------------------------------

test("(1) an overrun that released its lock writes NO sweep-overrun line; it writes sweep-window-released, read back from the ledger", () => {
  const path = ledgerPath();
  const notes: string[] = [];
  reportSweepWindows([overrunSweep(SWEEP)], { now: NOW, repo: TRACKER, io: { logPath: () => path, comment: (_row, body) => void notes.push(body), report: () => {} } });
  const text = readBack(path);
  assert.equal(linesOf(text, SWEEP_OVERRUN_KIND).length, 0, `a released overrun is no failure:\n${text}`);
  assert.equal(linesOf(text, SWEEP_WINDOW_RELEASED_KIND).length, 1, `the release is counted once:\n${text}`);
  assert.match(text, new RegExp(`^${SWEEP_WINDOW_RELEASED_KIND}\\t\\d+\\t${TRACKER}#${SWEEP}\\n$`));
  assert.equal(notes.length, 1, "the holder is told once");
  assert.ok(notes[0].startsWith(OVERRUN_MARKER), "and the overrun comment on the row keeps its marker");
});

test("(1) CONTROL: the same reporting, with the sweep still INSIDE its box, writes no ledger line at all", () => {
  const path = ledgerPath();
  const open = { ...overrunSweep(SWEEP), claimedAt: NOW - 120 * MIN, prOpenedAt: NOW - 30 * MIN };
  reportSweepWindows([open], { now: NOW, repo: TRACKER, io: { logPath: () => path, comment: () => {}, report: () => {} } });
  assert.equal(readBack(path), "", "an open window is not an overrun");
});

test("(1) three released overruns make NO sweep-overrun group in class-repeat, while three sweep-overrun lines make one (the control)", () => {
  const path = ledgerPath();
  reportSweepWindows([overrunSweep(4389), overrunSweep(4390), overrunSweep(4391)], { now: NOW, repo: TRACKER, io: { logPath: () => path, comment: () => {}, report: () => {} } });
  const text = readBack(path);
  assert.equal(linesOf(text, SWEEP_WINDOW_RELEASED_KIND).length, 3, `three releases, three refs:\n${text}`);

  const repeatsOf = (body: string) => repeatsIn(parseFailureLedger(body), { windowMs: WINDOW_MS, now: NOW }).map(({ classKey, refs }) => ({ classKey, refs, newestAt: NOW }));
  assert.deepEqual(groupByClass([], [], repeatsOf(text)), [], "a released overrun is no class and no repeat");
  const asFailures = text.replaceAll(SWEEP_WINDOW_RELEASED_KIND, SWEEP_OVERRUN_KIND);
  assert.deepEqual(groupByClass([], [], repeatsOf(asFailures)).map(({ id }) => id), [SWEEP_OVERRUN_KIND], "control: the same three lines as failures repeat");
});

// --- the failure: a claim REFUSED on a swept Region after the notice writes one sweep-overrun line -----------------------------------------------------------

const rowBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n\nSweep: one rename, or concurrent edits conflict\n`;
const plainBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n`;
const claimRecord = (minutesAgo: number, session = "worker-4389") => ({
  body: `<!-- row-claim: claim record -->\n**Claim record** -- claimed by \`${session}\`.`, createdAt: new Date(NOW - minutesAgo * MIN).toISOString(), author: { login: "a11ign-ai-workers" },
});

/** The fake code host a claim reads: the sweep row, its comments, and the asker's Region. No pull request, so the sweep's Region is counted by its claim, as B4 does. */
function claimWorld({ comments, asker = ["agent-org:src/b.ts"] }: { comments: { body: string; createdAt: string; author?: { login: string } }[]; asker?: string[] }) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = TRACKER;
  world.rows.set(ASKER, fakeRow(world, ASKER, { title: "A row", body: plainBody(...asker) }));
  world.rows.set(SWEEP, fakeRow(world, SWEEP, { body: rowBody("agent-org:src/"), labels: ["in-progress", "session:worker-4389"],
    comments: comments.map((comment, i) => ({ id: i + 1, body: comment.body, createdAt: comment.createdAt, author: comment.author?.login })) }));
  substituteCodeHost(host);
  return world;
}
const claimFor = () => sessionEligibilityReason(ASKER, "worker-5000", { repo: TRACKER, repos: [AGENT_ORG] });
// THE READS THE RECORDER MAKES, as `row-claim` makes them: the code host is the fake's, so a conclusive read is what the control reads.
const reads = { repo: TRACKER, repos: [AGENT_ORG] };

test("(2) POSITIVE CONTROL: a claim REFUSED on the swept Region after the overrun notice writes ONE sweep-overrun line, ref = the refused row", () => {
  claimWorld({ comments: [claimRecord(200), { body: `${OVERRUN_MARKER}\nnotice`, createdAt: new Date(NOW - 1 * MIN).toISOString() }] });
  const reason = claimFor();
  assert.ok(reason !== null, "the released area still refuses the claim by B4");
  assert.match(reason, new RegExp(`overlaps the Region of #${SWEEP}`));

  assert.equal(readSweepWindows(reads)?.[0]?.reported.overrun, true, "control: the read is conclusive and the notice is on the row");
  const path = ledgerPath();
  recordOverrunRefusal(reason, { issueNumber: ASKER, reads: reads, io: { logPath: () => path, report: () => {} } });
  const text = readBack(path);
  assert.equal(linesOf(text, SWEEP_OVERRUN_KIND).length, 1, `one failure:\n${text}`);
  assert.match(text, new RegExp(`^${SWEEP_OVERRUN_KIND}\\t\\d+\\t${TRACKER}#${ASKER}\\n$`), "ref is the REFUSED row, not the sweep");
});

test("(2) NEGATIVE CONTROL: the same refusal with NO overrun notice on the sweep's row writes nothing", () => {
  const world = claimWorld({ comments: [claimRecord(200)] });
  const reason = claimFor();
  // The claim reports the overrun it finds on the row, as it does for a real one (a `claim` call is not read-only); the control is the row as the REFUSAL found it, without that notice.
  world.rows.get(SWEEP)!.comments.length = 1;
  assert.ok(reason !== null, "the refusal is the same");
  assert.equal(readSweepWindows(reads)?.[0]?.reported.overrun, false, "control: the read is conclusive and NO notice is on the row");
  const path = ledgerPath();
  recordOverrunRefusal(reason, { issueNumber: ASKER, reads: reads, io: { logPath: () => path, report: () => {} } });
  assert.equal(readBack(path), "", "no notice, no failure: the sweep was not yet reported as released");
});

test("(2) NEGATIVE CONTROL: a refusal that names no swept row writes nothing, whatever the notice says", () => {
  const path = ledgerPath();
  claimWorld({ comments: [claimRecord(200), { body: OVERRUN_MARKER, createdAt: new Date(NOW).toISOString() }] });
  assert.equal(readSweepWindows(reads)?.length, 1, "control: the sweep is there and read, so the name is what refuses");
  recordOverrunRefusal("overlaps the Region of #77, a row already claimed", { issueNumber: ASKER, reads: reads, io: { logPath: () => path, report: () => {} } });
  assert.equal(readBack(path), "", "#77 is not a sweep on the board");
});

test("(2) a read that throws records nothing and never throws into the claim that asked", () => {
  const path = ledgerPath();
  const lines: string[] = [];
  const world = claimWorld({ comments: [claimRecord(200), { body: OVERRUN_MARKER, createdAt: new Date(NOW).toISOString() }] });
  world.failures.set("readClaimedRows", new Error("the code host is down"));
  recordOverrunRefusal("overlaps the Region of #4389, a declared SWEEP", { issueNumber: ASKER, reads, io: { logPath: () => path, report: (line) => void lines.push(line) } });
  assert.equal(readBack(path), "");
  assert.equal(lines.length, 0, "an unread holder is inconclusive: nothing is recorded, and nothing is reported as an error");
});

// --- the claim itself: `claimRow` refuses, and the call at row-claim.ts:1298 writes the line to the DEFAULT ledger (agent-org#1314's verdict) ------------------

// `claimRow` reads the real clock, so the sweep's claim and its notice are placed against `Date.now()`, not the fixed NOW above.
const live = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN).toISOString();
// The asker's body carries the sections `claimRow` requires (the issue template's Acceptance and Open-check), as the chairman-yield test's `bodyOf` does.
const TEMPLATE = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\n```\n$ true\n```\n";
const liveClaim = (minutesAgo: number) => ({ ...claimRecord(0), createdAt: live(minutesAgo) });
const notice = (minutesAgo: number) => ({ body: `${OVERRUN_MARKER}\nnotice`, createdAt: live(minutesAgo) });
// THE DEFAULT LEDGER, which the host file places in SCRATCH: the test reads the path the claim writes, and asserts it is never the real one.
const LEDGER = stateEntryPath(FAILURE_LEDGER_FILE);
const freshLedger = () => { assert.ok(LEDGER.startsWith(SCRATCH), `the default ledger is the scratch one: ${LEDGER}`); rmSync(LEDGER, { force: true }); };

/**
 * The world a claim reads: the asker's Region and labels, the sweep row and its comments. A chairman asker carries the label, put there by the chairman. The code host is the fake (A11-160, step 9): the claim's own `run`
 * is for `git` alone, and a claim that reaches `gh` through it is a defect this test names.
 */
function claimGhWorld(comments: { body: string; createdAt: string; author?: { login: string } }[], { chairman = false } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = TRACKER;
  world.rows.set(ASKER, fakeRow(world, ASKER, { title: "A row", body: plainBody("agent-org:src/b.ts") + TEMPLATE, labels: chairman ? ["ready", "priority:chairman"] : ["ready"] }));
  world.rows.set(SWEEP, fakeRow(world, SWEEP, { body: rowBody("agent-org:src/"), labels: ["in-progress", "session:worker-4389"],
    comments: comments.map((comment, i) => ({ id: i + 1, body: comment.body, createdAt: comment.createdAt, author: comment.author?.login })) }));
  if (chairman) world.gate.events.set(ASKER, [{ event: "labeled", label: "priority:chairman", actor: CHAIRMAN_LOGINS[0], at: live(600) }]);
  substituteCodeHost(host);
  return { world, run: (cmd: string): string => { throw new Error(`a claim reached \`${cmd}\` through its run: GitHub is the code host's`); } };
}
afterEach(() => forgetActivation());

const claimLive = (comments: { body: string; createdAt: string; author?: { login: string } }[], { chairman = false, noticeRefused = false } = {}) => claimRow(ASKER, `worker-${ASKER}`, {
  run: ((held) => { if (noticeRefused) held.world.failures.set("commentOnIssue", new Error("HTTP 502")); return held.run; })(claimGhWorld(comments, { chairman })) as never, moveStatus: () => ({ moved: true }), drained: [], instance: { spare: false, rows: [] }, persistent: false,
  tracker: { key: "", repo: TRACKER },
} as never) as { claimed: boolean; reason?: string };
/** The claim on the swept Region, on a cleared default ledger: its verdict, and the ledger text it left. */
function claimOnSweep(comments: { body: string; createdAt: string; author?: { login: string } }[], noticeRefused = false) {
  freshLedger();
  const result = claimLive(comments, { noticeRefused });
  return { result, text: readBack(LEDGER) };
}

test("(3) THROUGH claimRow: a claim REFUSED on the swept Region after the overrun notice writes ONE sweep-overrun line to the default ledger, ref = the refused row", () => {
  const { result, text } = claimOnSweep([liveClaim(200), notice(1)]);
  assert.equal(result.claimed, false, "the released area still refuses the claim");
  assert.match(result.reason ?? "", new RegExp(`overlaps the Region of #${SWEEP}`));
  assert.equal(linesOf(text, SWEEP_OVERRUN_KIND).length, 1, `one failure from the claim:\n${text}`);
  assert.match(text, new RegExp(`^${SWEEP_OVERRUN_KIND}\\t\\d+\\t${TRACKER}#${ASKER}\\n$`), "ref is the REFUSED row");
});

test("(3) CONTROL: the same refused claim with NO overrun notice on the sweep writes no ledger line", () => {
  const { result, text } = claimOnSweep([liveClaim(200)], true);
  assert.equal(result.claimed, false, "the refusal is the same");
  assert.match(result.reason ?? "", new RegExp(`overlaps the Region of #${SWEEP}`));
  // The claim reports the overrun it finds (one release, and the holder is told); here the notice cannot be WRITTEN (the code host refuses the comment, which the claim reports and goes on past), so the refusal that
  // follows has no notice to name, and it is no failure. Were the notice written, the refusal after it would be the failure the first case holds.
  assert.equal(linesOf(text, SWEEP_OVERRUN_KIND).length, 0, `no notice, no failure:\n${text}`);
  assert.equal(linesOf(text, SWEEP_WINDOW_RELEASED_KIND).length, 1, `the claim's own release, once:\n${text}`);
});

test("(3) CONTROL: a chairman row that B4 yields past the same notified holder is claimed and writes no sweep-overrun line", () => {
  freshLedger();
  const result = claimLive([liveClaim(200), notice(1)], { chairman: true });
  assert.equal(result.claimed, true, "the chairman's yield lets the claim past");
  assert.equal(readBack(LEDGER), "", "a yielded claim is no refusal, so the final verdict writes nothing");
});
