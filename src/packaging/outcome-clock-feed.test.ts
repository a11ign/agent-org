// no-token: gh -- the gate runs as a process with a stub `gh` on PATH under a scratch HOME; nothing here reaches the real one
/**
 * THE ROW CLOCK IS FED (#3486, slice 2). `outcome-clock.test.ts` proves the clock on facts handed to it; THIS file proves the tick hands it the facts. The
 * gate's `orgHealthNow({ ... })` call used to omit `claimedComments`, so production clocked PRs and was silent about every claimed row -- and every test of the
 * clock still passed, because each of them called the clock directly. So these tests run THE GATE (`work-gate.mjs` as a process), whose own `orgHealthNow`
 * call is the thing under test, against a stub `gh` that answers the three reads the row clock depends on: the open PRs, the open rows, and the claimed rows'
 * comments.
 *
 * THE BOUND IS WRITTEN OUT AS 135 MINUTES, NEVER AS `OVERDUE_ROW_MINUTES`, for the reason `outcome-clock.test.ts` gives. The fixtures sit two minutes either
 * side of it, so a gate that takes a few seconds to run cannot move one across.
 *
 * POSITIVE CONTROL: "a claimed row past the bound is named" is the non-empty case that "just under is not named" and "nothing is claimed" are read against, and
 * the first is RED against the call as it stood (the mutation is in the PR).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.mjs";

// The project this file runs against is the recorded one `org-health.test.ts` explains (#3233): the host file is set FIRST and the tool imported AFTER it.
const PROJECT_SCRATCH = mkdtempSync(join(tmpdir(), "outcome-clock-feed-project-"));
after(() => rmSync(PROJECT_SCRATCH, { recursive: true, force: true }));
const PROJECT = join(PROJECT_SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(PROJECT_SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: PROJECT_SCRATCH, binDir: join(PROJECT_SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(PROJECT_SCRATCH, "workers"), leads: join(PROJECT_SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { SIGNALS } = await import("../org-health.mjs");
const { claimRecordComment } = await import("../row-claim.mjs");

const GATE_ENTRY = fileURLToPath(new URL("../work-gate.mjs", import.meta.url));
const STUB_MODE = 0o755;
const MINUTE_MS = 60_000;
const OVER_ROW_BOUND_MS = 137 * MINUTE_MS;
const UNDER_ROW_BOUND_MS = 133 * MINUTE_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const label = (...names: string[]) => names.map((name) => ({ name }));
const BOT = { login: "a11ign-ai-workers" };

type Order = { session: string; cause: string; subject: string; discriminator: string; prompt: string };
type Row = { number: number; labels: { name: string }[] };

/** A claim record as the REAL writer words it, so the reader is tested against the writer and not a copy of it. */
const claimComment = (session: string, at: number) => ({ body: claimRecordComment({ session, branch: `agent/x-${session}`, worktree: `../wt-${session}`, nothing: null }),
  createdAt: iso(at), author: BOT });
const claimedRow = (number: number): Row => ({ number, labels: label("in-progress", `session:worker-${number}`) });

/**
 * Run the gate against these reads and return what it offered for the clock and what it said on stderr. `claimed: "refused"` makes the claimed-rows read
 * fail the way an exhausted API pool does. The stub answers the claimed-rows read BEFORE the generic open-rows read, whose arguments it is a prefix of.
 */
function gate({ prs = [], rows = [], claimed = [] }: { prs?: Record<string, unknown>[]; rows?: Row[]; claimed?: Record<string, unknown>[] | "refused" }) {
  const dir = mkdtempSync(join(tmpdir(), "outcome-clock-feed-gate-"));
  try {
    writeFileSync(join(dir, "prs.json"), JSON.stringify(prs));
    writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
    writeFileSync(join(dir, "claimed.json"), JSON.stringify(claimed === "refused" ? [] : claimed));
    const claimedCase = claimed === "refused" ? `  "issue list --state open --label in-progress"*) exit 1 ;;\n`
      : `  "issue list --state open --label in-progress"*) cat "${dir}/claimed.json" ;;\n`;
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$*" in\n  "pr list --state open"*) cat "${dir}/prs.json" ;;\n${claimedCase}`
      + `  "issue list --state open --limit 500"*) cat "${dir}/rows.json" ;;\n  "pr list"*|"issue list"*) printf '%s' '[]' ;;\n  *) exit 1 ;;\nesac\n`);
    writeFileSync(join(dir, "journalctl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    chmodSync(join(dir, "journalctl"), STUB_MODE);
    const ran = spawnSync(process.execPath, [GATE_ENTRY], { encoding: "utf8", env: { ...process.env, A11IGN_ORG_HEALTH_SUPPRESSION: "off", HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
    const orders = ran.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Order);
    return { clock: orders.filter((o) => o.cause === "org-health" && o.subject === SIGNALS.OVERDUE), stderr: ran.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNREAD = /org-health: overdue UNKNOWN -- the claimed rows' comments could not be read/;

test("(1) A CLAIMED ROW PAST THE BOUND IS NAMED by the gate's own tick, its claim comment carried in `claimedComments`, the claimant commenting all the while", () => {
  const now = Date.now();
  const { clock, stderr } = gate({ rows: [claimedRow(3465)],
    claimed: [{ number: 3465, comments: [claimComment("worker-3465", now - OVER_ROW_BOUND_MS), { body: "still on it", createdAt: iso(now - MINUTE_MS), author: BOT }] }] });
  assert.equal(clock.length, 1, stderr);
  assert.equal(clock[0].session, "ceo");
  assert.match(clock[0].prompt, /#3465 \(row, claimed, open 2\.3 h, owner worker-3465\)/);
  assert.match(clock[0].discriminator, /^overdue@row#3465:claimed$/);
});

test("(2) THE SAME ROW JUST UNDER THE BOUND IS NOT NAMED, and the read that said so was not a refusal (the control: (1) is the same row two minutes older)", () => {
  const now = Date.now();
  const { clock, stderr } = gate({ rows: [claimedRow(3465)], claimed: [{ number: 3465, comments: [claimComment("worker-3465", now - UNDER_ROW_BOUND_MS)] }] });
  assert.deepEqual(clock, []);
  assert.doesNotMatch(stderr, UNREAD, "a row that is young is clear, not unknown");
});

test("(3) A REFUSED READ OF THE CLAIMED ROWS' COMMENTS IS REPORTED AS UNREAD, never as nothing overdue and never as a trip", () => {
  const { clock, stderr } = gate({ rows: [claimedRow(3465)], claimed: "refused" });
  assert.deepEqual(clock, [], "nothing can be named from a read that did not happen");
  assert.match(stderr, UNREAD, "the clock says it did not look, which is what keeps the refusal from reading as 'nothing overdue'");
});

test("NO ROW IS CLAIMED: the claimed rows' comments are not asked for, and that is NOT reported as unread (null for 'not asked' is not null for 'refused')", () => {
  const { clock, stderr } = gate({ rows: [{ number: 7, labels: label("ready") }] });
  assert.deepEqual(clock, []);
  assert.doesNotMatch(stderr, UNREAD);
});

test("A CLAIMED ROW IS CLOCKED WHILE A PR IS TOO: the one order names both, the PR from `pr list` and the row from the claim comment", () => {
  const now = Date.now();
  const pr = { number: 3472, isDraft: false, statusCheckRollup: [], headRefOid: "0123456789abcdef0123456789abcdef01234567", labels: [], reviews: [], comments: [],
    createdAt: iso(now - 3 * 60 * MINUTE_MS), headRefName: "agent/x-1", author: BOT };
  const { clock, stderr } = gate({ prs: [pr], rows: [claimedRow(3465)], claimed: [{ number: 3465, comments: [claimComment("worker-3465", now - OVER_ROW_BOUND_MS)] }] });
  assert.equal(clock.length, 1, stderr);
  assert.match(clock[0].prompt, /#3472 \(PR, /);
  assert.match(clock[0].prompt, /#3465 \(row, claimed, /);
});

test("THE CLEANUP: nothing in `src` reads a head commit for the clock any more (`readHeadCommittedAt` and its `GH_READS` entry are deleted, not left beside it)", async () => {
  const gateModule = await import("../work-gate.mjs");
  const orgHealthModule = await import("../work-gate/org-health.mjs");
  assert.equal("readHeadCommittedAt" in gateModule, false);
  assert.equal("readHeadCommittedAt" in orgHealthModule, false);
  assert.equal("conditionalOnQuietStalledPr" in gateModule.GH_READS, false);
});
