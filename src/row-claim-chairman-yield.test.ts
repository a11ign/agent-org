// no-token: none -- the fake code host's rows hold the world in memory; nothing here reaches `gh` or the network (a11ign/a11ign#4793)
/**
 * a11ign/a11ign#4793: THE CLAIM HONOURS THE CHAIRMAN'S YIELD, SO THE ROW THE GATE OFFERS IS THE ROW THE CLAIM ACCEPTS.
 *
 * The defect (read by worker-4524, 2026-10-10 08:16-08:26Z): the gate's `overlapVerdict` offered #4764, a `priority:chairman` row, over a holder that
 * is not itself a chairman row (the chairman's direction on a11ign#4524: "B4 overlap does NOT shelve a `priority:chairman` row when the overlapping holder is
 * not itself a chairman row"), and B4 at the claim then refused the same row for the same overlap, six ticks running. Neither half of B4 at the claim read
 * whether the row being claimed was the chairman's.
 *
 * POSITIVE CONTROLS: every case that asserts a REFUSAL differs from the case that asserts a CLAIM in ONE fact, and (1)/(2) run the claiming case's inputs
 * beside their unlabelled twin, so the refusal read there is the refusal that a plain row still gets. The emptiness of `walked` for a plain row is read
 * against (1) and (2), which are non-empty for the same Region.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { forgetActivation } from "./plugins/active.ts";
import { type WatchedCall } from "./plugins/fakes/watched-rows.test.support.ts";
import { holdYieldWorld, type YieldWorld } from "./plugins/fakes/yield-world.test.support.ts";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE, as `claimed-region-overlap.test.ts` does it: the host file first, the tool imported after it.
const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-chairman-yield-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
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

const { sessionEligibility, sessionEligibilityReason, claimRow } = await import("./row-claim.ts");
const { CHAIRMAN_LOGINS } = await import("./work-gate/vocabulary.ts");

const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const CHAIRMAN = CHAIRMAN_LOGINS[0];
const ASKER = 4764;
const HOLDER = 4738;
const SHARED = "agent-org:src/row-claim.ts";
const TEMPLATE = "\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\n```\n$ true\n```\n";
const bodyOf = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n${TEMPLATE}`;

type World = YieldWorld;

/** The fake code host holding `world` (A11-160, step 7), watched: the calls are the operations the claim asked of it, with their requests, in order. */
const fakeGh = (world: World): WatchedCall[] => holdYieldWorld(world, { asker: ASKER, tracker: TRACKER, otherRepo: AGENT_ORG.repo, bodyOf, askerFiles: SHARED });

/** The claim's `run`: for `git` and the board snapshot, so a `gh` through it is a loud mistake. */
const noGh = (cmd: string): string => { throw new Error(`a claim reached \`${cmd}\` through its run: GitHub is the code host's`); };

afterEach(() => forgetActivation());

const verdict = (world: World, calls?: WatchedCall[][]) => {
  const watched = fakeGh(world);
  calls?.push(watched);
  return sessionEligibility(ASKER, `worker-${ASKER}`, { repo: TRACKER, repos: [AGENT_ORG] });
};

// --- (1) a chairman row over a plain claimed row ------------------------------------------------------------------------------------

test("(1) a chairman row overlapping a plain CLAIMED row is not refused, and the holder is named", () => {
  const world: World = { labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  const { reason, walked } = verdict(world);
  assert.equal(reason, null);
  assert.deepEqual(walked, [{ kind: "row", number: HOLDER }]);
});

test("(1) the control: the SAME overlap on a row nobody labelled is refused with today's message", () => {
  const { reason, walked } = verdict({ claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}, a row already claimed`));
  assert.deepEqual(walked, []);
});

// --- (2) a chairman row over a plain open pull request --------------------------------------------------------------------------------

test("(2) a chairman row overlapping a plain open PULL REQUEST is not refused, and the pull request is named", () => {
  const world: World = { labelled: { [ASKER]: CHAIRMAN }, prs: [{ number: 900, path: "src/row-claim.ts", closes: 4800 }] };
  const { reason, walked } = verdict(world);
  assert.equal(reason, null);
  assert.deepEqual(walked, [{ kind: "pr", number: 900, repo: AGENT_ORG.repo }]);
});

test("(2) the control: the SAME pull request refuses a row nobody labelled", () => {
  const { reason } = verdict({ prs: [{ number: 900, path: "src/row-claim.ts", closes: 4800 }] });
  assert.match(reason ?? "", /overlaps #900 in a11ign\/agent-org/);
});

// --- (3), (4), (5) two chairman rows still exclude each other ------------------------------------------------------------------------

test("(3) a chairman row overlapping a claimed CHAIRMAN row is refused, naming it", () => {
  const { reason, walked } = verdict({ labelled: { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(walked, []);
});

test("(4) a chairman row overlapping a pull request that declares `Closes` on a chairman row is refused, naming it", () => {
  const { reason } = verdict({ labelled: { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN }, prs: [{ number: 900, path: "src/row-claim.ts", closes: HOLDER }] });
  assert.match(reason ?? "", /overlaps #900 in a11ign\/agent-org/);
});

test("(5) a plain holder beside a chairman one does not make the chairman row's refusal vanish: the chairman holder is the one named", () => {
  const { reason } = verdict({ labelled: { [ASKER]: CHAIRMAN, [HOLDER]: CHAIRMAN },
    claimed: [{ number: HOLDER, files: [SHARED] }, { number: 4500, files: [SHARED] }] });
  assert.match(reason ?? "", new RegExp(`#${HOLDER}`));
  assert.doesNotMatch(reason ?? "", /#4500/);
});

// --- (6) every other check still applies ----------------------------------------------------------------------------------------------

test("(6) a chairman row with an open `blockedBy` edge is refused for the edge, whatever it overlaps", () => {
  const world: World = { labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }], blockedBy: [4001] };
  const { reason } = verdict(world);
  assert.match(reason ?? "", /blockedBy/);
  assert.match(reason ?? "", /#4001/);
  assert.equal(verdict({ ...world, blockedBy: [] }).reason, null, "the control: without the edge, the same world proceeds");
});

test("(6) a claimed-row list that could not be read refuses a chairman row, as it refuses every row", () => {
  const { reason } = verdict({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }], claimedUnreadable: true });
  assert.match(reason ?? "", /COULD NOT BE ASKED which rows are already claimed/);
});

// --- (7) the label is the chairman's or it is nothing -----------------------------------------------------------------------------------

test("(7) a `priority:chairman` somebody else added buys nothing", () => {
  const { reason } = verdict({ labelled: { [ASKER]: "a11ign-ai-workers" }, claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

test("(7) a history that cannot be read FAILS CLOSED: the row is refused, and says why it was not the chairman's", () => {
  const { reason } = verdict({ labelled: { [ASKER]: null }, claimed: [{ number: HOLDER, files: [SHARED] }] });
  assert.match(reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
});

// --- (8) a claim that overlaps nothing asks nothing new --------------------------------------------------------------------------------

test("(8) with no overlap the claim does not read the chairman's rows at all", () => {
  const calls: WatchedCall[][] = [];
  const { reason } = verdict({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: ["agent-org:src/elsewhere.ts"] }] }, calls);
  assert.equal(reason, null);
  // The claimed rows are read by label too (#5039), so it is told apart by the label it asks for: only the chairman's rows and the label history are not wanted.
  const asksChairman = (call: WatchedCall) => call.op === "newestLabellerOf" || (call.op === "readRowsByLabel" && call.request.label === "priority:chairman");
  assert.deepEqual(calls[0].filter(asksChairman), []);
  const overlapping = [] as WatchedCall[][];
  verdict({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] }, overlapping);
  assert.ok(overlapping[0].some(asksChairman), "the control: an overlap DOES ask, so the emptiness above is a reading");
});

test("(8) `sessionEligibilityReason` is the same verdict as `sessionEligibility`'s reason", () => {
  const world: World = { labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] };
  fakeGh(world);
  assert.equal(sessionEligibilityReason(ASKER, `worker-${ASKER}`, { repo: TRACKER, repos: [AGENT_ORG] }), null);
  fakeGh({ claimed: world.claimed });
  assert.notEqual(sessionEligibilityReason(ASKER, `worker-${ASKER}`, { repo: TRACKER, repos: [AGENT_ORG] }), null);
});

// --- (9) THE CLAIM ITSELF: the seam above is driven, and so is the call site that says so on the row ------------------------------------

const claimWith = (world: World, calls: WatchedCall[][]) => {
  calls.push(fakeGh(world));
  return claimRow(ASKER, `worker-${ASKER}`, {
    run: noGh as never, moveStatus: () => ({ moved: true }), drained: [], instance: { spare: false, rows: [] }, persistent: false,
    tracker: { key: "", repo: TRACKER },
  } as never);
};
const commentsOn = (calls: WatchedCall[][]) => calls[0].filter((call) => call.op === "postRowComment").map((call) => call.request.body as string);

test("(9) a chairman row's claim goes ahead and leaves a comment naming the holder it walked past", () => {
  const calls: WatchedCall[][] = [];
  const result = claimWith({ labelled: { [ASKER]: CHAIRMAN }, claimed: [{ number: HOLDER, files: [SHARED] }] }, calls) as { claimed: boolean; };
  assert.equal(result.claimed, true);
  const notes = commentsOn(calls).filter((body) => /B4 yielded/.test(body));
  assert.equal(notes.length, 1, "one note, on the row");
  assert.match(notes[0], new RegExp(`row #${HOLDER}`));
});

test("(9) the control: a plain row is NOT claimed over the same holder, and no note is written", () => {
  const calls: WatchedCall[][] = [];
  const result = claimWith({ claimed: [{ number: HOLDER, files: [SHARED] }] }, calls) as { claimed: boolean; reason?: string; };
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? "", new RegExp(`overlaps the Region of #${HOLDER}`));
  assert.deepEqual(commentsOn(calls).filter((body) => /B4 yielded/.test(body)), []);
});
