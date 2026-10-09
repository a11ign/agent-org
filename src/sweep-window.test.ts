// no-token: gh -- every `gh` call is an injected `run`; nothing here reaches the network (#4603)
/**
 * #4603: THE SWEEP PROTOCOL -- a declared freeze window for a repo-wide mechanical change, a 60-minute CI box that releases the lock on overrun, and follow-ups filed only
 * after the merge (lock-gridlock fix 2 of 4, epic #4437). The incident: a11ign#4389 (110 `.mjs` renamed) opened a 100-file pull request with red CI and its holder then filed
 * follow-up rows while 28 ready rows were shelved behind it.
 *
 * POSITIVE CONTROLS, NAMED: every emptiness below is read against a refusal in the SAME test that differs in ONE fact -- a claim on a Region that shares no file, a sweep at 59
 * minutes beside the one at 61, a session that does not hold the sweep beside the one that does, a row that is not a sweep beside the one that is.
 *
 * THE CLAIM IS THE REAL ONE: `sessionEligibilityReason` over a `gh` mock, so the wiring in `row-claim.ts` is what is under test, not only the pure rule. Times there are relative to
 * the real clock with minutes to spare either side of every threshold; the exact boundaries are pinned on the pure `sweepWindowState`, whose clock is an argument.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE (`claimed-region-overlap.test.ts`'s shape): the host file is set FIRST and the tool imported AFTER it, so the acceptance command as
// written -- no `$AGENT_ORG_HOST` -- runs. `stateDir` is declared so the overrun's ledger line lands in the scratch directory and never in the host's own.
const SCRATCH = mkdtempSync(join(tmpdir(), "sweep-window-"));
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

const {
  OVERRUN_ADVICE, OVERRUN_MARKER, STALLED_MARKER, SWEEP_CI_BOX_MINUTES, SWEEP_OVERRUN_KIND, SWEEP_PR_OPEN_MINUTES,
  readSweepWindows, reportSweepWindows, sweepFilingReason, sweepFreezeReason, sweepMinutesLeft, sweepWindowState,
} = await import("./sweep-window.ts");
const { reportB4, sessionEligibilityReason } = await import("./row-claim.ts");
const { createIssue } = await import("./row-file.ts");
const { FAILURE_LEDGER_FILE } = await import("./failure-ledger.ts");

const MIN = 60_000;
const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const SWEEP = 4389;
const ASKER = 5000;
const NOW = Date.UTC(2026, 9, 9, 18, 0, 0);

// --- the pure state --------------------------------------------------------------------------------------------------------------

test("the constants are the numbers the row fixes", () => {
  assert.equal(SWEEP_CI_BOX_MINUTES, 60);
  assert.equal(SWEEP_PR_OPEN_MINUTES, 15);
});

test("a sweep at 59 minutes of CI is OPEN, and 61 is OVERRUN; the box is spent only STRICTLY past 60", () => {
  const at = (minutes: number) => sweepWindowState({ claimedAt: NOW - 120 * MIN, prOpenedAt: NOW - minutes * MIN, now: NOW });
  assert.equal(at(59), "open");
  assert.equal(at(60), "open", "at exactly 60 the holder still has the box");
  assert.equal(at(61), "overrun");
});

test("a sweep with no pull request at 15 minutes is STALLED, and at 14 it is still open", () => {
  const at = (minutes: number) => sweepWindowState({ claimedAt: NOW - minutes * MIN, prOpenedAt: null, now: NOW });
  assert.equal(at(14), "open");
  assert.equal(at(15), "stalled");
  assert.equal(sweepWindowState({ claimedAt: NOW - 15 * MIN, prOpenedAt: NOW - 1 * MIN, now: NOW }), "open", "control: the same claim with a pull request is not stalled");
});

test("a sweep that never opens a pull request is still released: its box runs from the moment the pull request was due", () => {
  const at = (minutes: number) => sweepWindowState({ claimedAt: NOW - minutes * MIN, prOpenedAt: null, now: NOW });
  assert.equal(at(75), "stalled", "15 + 60 minutes is the last minute of the box");
  assert.equal(at(76), "overrun");
});

test("minutes left count down to the release and never read 0 while the window still holds", () => {
  const left = (minutes: number) => sweepMinutesLeft({ claimedAt: NOW - 120 * MIN, prOpenedAt: NOW - minutes * MIN, now: NOW });
  assert.equal(left(0), 60);
  assert.equal(left(59), 1);
  assert.equal(left(59.5), 1, "30 seconds left rounds UP to a minute");
  assert.equal(left(61), 0);
});

// --- the fixtures for the real claim ----------------------------------------------------------------------------------------------

const rowBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n\nSweep: one rename, or concurrent edits conflict\n`;
const plainBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n`;
const listed = (number: number, body: string, session: string) => ({
  number, labels: [{ name: "in-progress" }, { name: `session:${session}` }], body, blockedBy: { nodes: [] },
});
const claimRecord = (minutesAgo: number, session = "worker-4389") => ({
  body: `<!-- row-claim: claim record -->\n**Claim record** -- claimed by \`${session}\`.`, createdAt: new Date(Date.now() - minutesAgo * MIN).toISOString(), author: { login: "a11ign-ai-workers" },
});
const sweepPr = (minutesAgo: number, files = ["src/a.ts"]) => ({
  number: 529, changedFiles: files.length, headRefName: "agent/rename-4389", body: `Closes ${TRACKER}#${SWEEP}`, createdAt: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  files: files.map((path) => ({ path })), labels: [],
});

/** One `gh` mock routed by subcommand shape; it RECORDS the writes (`issue comment`) so a row write can be counted. */
function ghFor({ sweeps, comments, prs = [], asker = ["agent-org:src/b.ts"] }: {
  sweeps: ReturnType<typeof listed>[]; comments: unknown[]; prs?: unknown[]; asker?: string[];
}) {
  const written: string[][] = [];
  const run = (_cmd: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "comment") { written.push(args); return ""; }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("comments")) return JSON.stringify({ comments });
      return JSON.stringify({ number: ASKER, title: "A row", body: plainBody(...asker), labels: [], blockedBy: { nodes: [] } });
    }
    if (args[0] === "issue" && args[1] === "list") return args.includes("number,labels,body,blockedBy") ? JSON.stringify(sweeps) : "[]";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prs);
    return "[]";
  };
  return { run, written };
}
const claimFor = (run: ReturnType<typeof ghFor>["run"]) => sessionEligibilityReason(ASKER, "worker-5000", { run, repo: TRACKER, repos: [AGENT_ORG] });
const ledger = () => { try { return readFileSync(join(STATE_DIR, FAILURE_LEDGER_FILE), "utf8"); } catch { return ""; } };

const sweepRow = listed(SWEEP, rowBody("agent-org:src/"), "worker-4389");

// --- (1) THE CLAIM RULE refuses inside a declared window ---------------------------------------------------------------------------

test("(1) a claim INSIDE a declared window is refused, naming the sweep row and the minutes left -- though the sweep's pull request touches none of the asker's files", () => {
  const { run } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(90)], prs: [sweepPr(30)] });
  const reason = claimFor(run) ?? "";
  assert.match(reason, /overlaps the Region of #4389, a declared SWEEP/);
  assert.match(reason, /30 minutes left/);
  assert.match(reason, /merge or stand down/);
});

test("(1) CONTROL: the same sweep, a claim on a Region that shares no file with it, is not refused", () => {
  const { run } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(90)], prs: [sweepPr(30)], asker: ["agent-org:docs/other.md"] });
  assert.equal(claimFor(run), null);
});

test("(1) CONTROL: the same Region held by a row that DECLARES NO SWEEP is not frozen by this rule (only B4's, which a pull request that misses the file does not trigger)", () => {
  const { run } = ghFor({ sweeps: [listed(SWEEP, plainBody("agent-org:src/"), "worker-4389")], comments: [claimRecord(90)], prs: [sweepPr(30)] });
  assert.equal(claimFor(run), null);
});

test("(1) a sweep at 59 minutes of CI still refuses", () => {
  const { run } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(120)], prs: [sweepPr(59)] });
  assert.match(claimFor(run) ?? "", /#4389, a declared SWEEP/);
});

test("(1) `check` predicts the claim: the same refusal through `reportB4`, and it writes nothing", () => {
  const { run, written } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(90)], prs: [sweepPr(30)] });
  const say = (sweeps?: () => ReturnType<typeof readSweepWindows>) => {
    const out: string[] = [];
    reportB4(ASKER, { write: (t: string) => out.push(t), mine: () => ["agent-org:src/b.ts"], others: () => [], claimed: () => [], repo: TRACKER, ...(sweeps === undefined ? {} : { sweeps }) });
    return out.join("");
  };
  const read = () => readSweepWindows({ run: (args) => run("gh", args), repo: TRACKER, repos: [AGENT_ORG] });
  assert.match(say(read), /B4 REFUSES THIS CLAIM: overlaps the Region of #4389, a declared SWEEP/);
  assert.deepEqual(written, [], "check is read-only");
  assert.match(say(() => null), /B4 REFUSES THIS CLAIM: .*INCONCLUSIVE/, "an unread sweep list is said, never silence");
  assert.match(say(() => []), /no row already claimed holds any file/, "control: the same check with no sweep claimed is clear");
  assert.match(say(), /no row already claimed holds any file/, "and a check that injects `claimed` reads no sweep of its own, so it never reaches `gh`");
});

test("(1) a sweep that could not be read refuses as INCONCLUSIVE, never as clear", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ number: ASKER, body: plainBody("agent-org:src/b.ts"), labels: [], blockedBy: { nodes: [] } });
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([sweepRow]);
    return "[]"; // no comments on the sweep: it has no claim record, so its window has no start
  };
  assert.match(claimFor(run) ?? "", /INCONCLUSIVE/);
});

// --- (2) OVERRUN: released by construction, recorded once, the holder told -----------------------------------------------------------

test("(2) a sweep that OVERRAN is RELEASED: the claim is no longer refused, the overrun is recorded ONCE and the holder is told to revert or split", () => {
  const { run, written } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(200)], prs: [sweepPr(61)] });
  assert.equal(claimFor(run), null, "past the box the freeze stops refusing");
  assert.equal(ledger().split("\n").filter((line) => line.startsWith(`${SWEEP_OVERRUN_KIND}\t`)).length, 1, `the overrun is on the ledger once:\n${ledger()}`);
  assert.match(ledger(), new RegExp(`${SWEEP_OVERRUN_KIND}\\t\\d+\\t${TRACKER}#${SWEEP}\\n`));
  assert.equal(written.length, 1, "and told once");
  assert.match(String(written[0].at(-1)), new RegExp(OVERRUN_ADVICE));
  assert.match(String(written[0].at(-1)), /revert or split; do not hold the lock/);

  // a second claim, with the holder's notice now on the row: nothing is written again, and the ledger dedupes the same ref.
  const second = ghFor({ sweeps: [sweepRow], comments: [claimRecord(200), { body: `${OVERRUN_MARKER}\nnotice`, createdAt: new Date().toISOString() }], prs: [sweepPr(61)] });
  assert.equal(claimFor(second.run), null);
  assert.deepEqual(second.written, [], "the marker on the row keeps the notice to one");
  assert.equal(ledger().split("\n").filter((line) => line.startsWith(`${SWEEP_OVERRUN_KIND}\t`)).length, 1, "still one line");
});

test("(2) the pure rule agrees: the same sweep refuses at 59 minutes and releases at 61", () => {
  const sweep = (minutes: number) => ({ number: SWEEP, session: "worker-4389", files: ["agent-org:src/"], claimedAt: NOW - 120 * MIN, prOpenedAt: NOW - minutes * MIN, reported: { stalled: false, overrun: false } });
  const ask = (minutes: number) => sweepFreezeReason({ myFiles: ["agent-org:src/b.ts"], issueNumber: ASKER, sweeps: [sweep(minutes)], now: NOW });
  assert.match(ask(59) ?? "", /1 minute left/);
  assert.equal(ask(61), null);
});

// --- (3) STALLED: a row write, once ---------------------------------------------------------------------------------------------

test("(3) a sweep with NO pull request 15 minutes after its claim is reported as stalled on the row, once, and its freeze still holds", () => {
  const { run, written } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(16)], prs: [] });
  assert.match(claimFor(run) ?? "", /#4389, a declared SWEEP .*freeze window is stalled/);
  assert.equal(written.length, 1);
  assert.match(String(written[0].at(-1)), /STALLED/);
  const again = ghFor({ sweeps: [sweepRow], comments: [claimRecord(16), { body: `${STALLED_MARKER}\nx`, createdAt: new Date().toISOString() }], prs: [] });
  assert.match(claimFor(again.run) ?? "", /stalled/);
  assert.deepEqual(again.written, [], "reported once");
});

test("(3) CONTROL: at 14 minutes with no pull request the sweep is open and nothing is reported", () => {
  const { run, written } = ghFor({ sweeps: [sweepRow], comments: [claimRecord(14)], prs: [] });
  assert.match(claimFor(run) ?? "", /freeze window is open/);
  assert.deepEqual(written, []);
});

test("(3) a report that cannot be written is one stderr line and never stops the claim that asked", () => {
  const lines: string[] = [];
  const sweep = { number: SWEEP, session: null, files: ["agent-org:src/"], claimedAt: NOW - 20 * MIN, prOpenedAt: null, reported: { stalled: false, overrun: false } };
  reportSweepWindows([sweep], { now: NOW, io: { comment: () => { throw new Error("HTTP 502"); }, report: (line: string) => lines.push(line) } });
  assert.match(lines.join("\n"), /could not report #4389 stalled \(HTTP 502\)/);
});

// --- (4) FOLLOW-UPS ARE FILED ONLY AFTER THE MERGE --------------------------------------------------------------------------------

const sweepsAt = (minutes: number | null) => [{ number: SWEEP, session: "worker-4389", files: ["agent-org:src/"], claimedAt: NOW - 120 * MIN, prOpenedAt: minutes === null ? null : NOW - minutes * MIN, reported: { stalled: false, overrun: false } }];

test("(4) the pure filing rule refuses the sweep's holder a row overlapping the sweep's Region, naming the sweep row; another session, and a disjoint Region, file", () => {
  const filing = (session: string, region: string, minutes: number | null = 30) => sweepFilingReason({ session, body: plainBody(region), sweeps: sweepsAt(minutes), now: NOW });
  assert.match(filing("worker-4389", "agent-org:src/follow-up.ts") ?? "", /worker-4389 holds #4389, a claimed SWEEP/);
  assert.equal(filing("worker-9999", "agent-org:src/follow-up.ts"), null, "control: a session that does not hold the sweep");
  assert.equal(filing("worker-4389", "agent-org:docs/note.md"), null, "control: a Region outside the sweep's");
  assert.equal(filing("worker-4389", "agent-org:src/follow-up.ts", 61), null, "an overrun releases the holder: `revert or split` needs rows filed");
  assert.equal(sweepFilingReason({ session: "worker-4389", body: plainBody("agent-org:src/follow-up.ts"), sweeps: [], now: NOW }), null, "control: after the merge the row is no longer claimed, so nothing is read");
});

const FILING_BODY = (region: string) => `${plainBody(region)}\n## Acceptance\n\n\`\`\`\nnpx tsx --test x\n\`\`\`\n\n## Open-check\n\n\`\`\`\ngh issue view 735 --json state\n\`\`\`\n`;

/** `run` for a whole filing, with the sweep held by `worker-4389` and its pull request opened `prMinutesAgo` ago. */
function filingRun(prMinutesAgo: number, body: string) {
  return (_cmd: string, args: string[]) => {
    if (args[0] === "api") return "src/a.ts\nsrc/follow-up.ts";
    if (args[0] === "issue" && args[1] === "view" && args.includes("comments")) return JSON.stringify({ comments: [claimRecord(200)] });
    if (args[0] === "issue" && args[1] === "list") return args.includes("number,labels,body,blockedBy") ? JSON.stringify([sweepRow]) : "[]";
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([sweepPr(prMinutesAgo)]);
    if (args.includes("milestone")) return "CI reset";
    return args.includes("body") ? body : "";
  };
}

function fileThroughCreateIssue({ session, region, prMinutesAgo }: { session: string; region: string; prMinutesAgo: number }) {
  const created: string[][] = [];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const body = FILING_BODY(region);
    const code = createIssue(["--title", "a follow-up", "--body", body, `--session=${session}`, "--milestone", "CI reset"], {
      spawnGh: (argv) => { created.push(argv); return "https://github.com/a11ign/a11ign/issues/900"; },
      run: filingRun(prMinutesAgo, `${body}\nFiled-by: ${session}\n`), loadLanesConfig: () => ({ lanes: [] }),
      ensureLabels: () => {}, fetchBoardStatus: () => "Backlog", fetchLabels: () => ({ number: 900, title: "", labels: ["backlog", "lane:any"] }),
      moveStatus: () => ({ moved: true as const }),
    });
    return { code, created, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("(4) WIRING: `row-file` refuses the holder of a claimed sweep a follow-up into its area, with nothing created -- and files it for another session, and once the window overran", () => {
  const refused = fileThroughCreateIssue({ session: "worker-4389", region: "agent-org:src/follow-up.ts", prMinutesAgo: 30 });
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /worker-4389 holds #4389, a claimed SWEEP/);
  assert.equal(refused.created.length, 0, "a refusal leaves nothing behind");
  const other = fileThroughCreateIssue({ session: "worker-9999", region: "agent-org:src/follow-up.ts", prMinutesAgo: 30 });
  assert.equal(other.created.length, 1, `control: a session not holding the sweep files: ${other.stderr}`);
  const elsewhere = fileThroughCreateIssue({ session: "worker-4389", region: "agent-org:docs/note.md", prMinutesAgo: 30 });
  assert.equal(elsewhere.created.length, 1, `control: the holder files outside the sweep's area: ${elsewhere.stderr}`);
  const overran = fileThroughCreateIssue({ session: "worker-4389", region: "agent-org:src/follow-up.ts", prMinutesAgo: 61 });
  assert.equal(overran.created.length, 1, `the holder of an overrun sweep files (revert or split): ${overran.stderr}`);
});

test("(4) a read that fails refuses the filing as INCONCLUSIVE, never as clear", () => {
  assert.equal(readSweepWindows({ run: () => { throw new Error("HTTP 502"); }, repo: TRACKER, repos: [AGENT_ORG] }), null);
});
