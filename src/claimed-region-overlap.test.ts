// no-token: gh -- every `gh` call is an injected `run`; nothing here reaches the network (#3475)
/**
 * #3475: B4 COMPARES A ROW'S REGION WITH THE REGIONS OF THE ROWS ALREADY CLAIMED, not only with open pull requests' files.
 *
 * The defect: `worker-3423` claimed #3423 at 13:02:04Z with `watch.mjs`, `event.mjs` and `core.mjs` in its Region; `worker-3414`
 * claimed #3414 at 13:29:55Z with the same three; no pull request existed to compare with (#148 opened at 13:34:33Z), so B4 passed on
 * an empty list, truthfully, and the two rows ran into three conflicting pull requests. The Regions below are those two rows' real ones.
 *
 * POSITIVE CONTROL: test (1) is the non-empty case that the emptiness of (2), (4), (5) and (6) is read against -- each of those
 * differs from (1) in ONE fact and each also asserts that the changed fact is the only one, by running (1)'s inputs beside it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.mjs";

// THE PROJECT THIS RUNS AGAINST IS A RECORDED ONE (#3233's shape, `packaging/row-claim-file-overlap-rule.test.ts`): the host file is set FIRST and
// the tool imported AFTER it, so the acceptance command as written -- no `$AGENT_ORG_HOST` -- runs, and a project changing its declaration
// cannot move this file's verdict. The fixture declares the two code repositories this file's Regions are keyed for (`""` and `agent-org`).
const SCRATCH = mkdtempSync(join(tmpdir(), "claimed-region-overlap-"));
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

const { claimedRegionOverlapReason, claimedRegionsOf, lookupClaimedRegions } = await import("./row-claim/file-overlap-rule.mjs");
const { declaredRegionFiles } = await import("./region-paths.mjs");
const { reportB4, sessionEligibilityReason } = await import("./row-claim.mjs");
const { partitionUnclaimed } = await import("./work-gate.mjs");

const TRACKER = "a11ign/a11ign";
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };

/** #3414's Region, as filed (measured 2026-10-04 off the row's body). */
const REGION_3414 = [
  "agent-org:src/messaging/sources/milestones.mjs", "agent-org:src/messaging/sources/milestones.test.mjs",
  "agent-org:src/messaging/config.mjs", "agent-org:src/messaging/config.test.mjs", "agent-org:src/messaging/check.mjs",
  "agent-org:src/messaging/watch.mjs", "agent-org:src/messaging/event.mjs", "agent-org:src/messaging/core.mjs",
];
/** #3423's Region, as filed: 17 entries. */
const REGION_3423 = [
  "agent-org:src/messaging/providers/telegram/send.mjs", "agent-org:src/messaging/providers/telegram/send.test.mjs",
  "agent-org:src/messaging/answers.mjs", "agent-org:src/messaging/answers.test.mjs", "agent-org:src/messaging/inbound.mjs",
  "agent-org:src/messaging/inbound.test.mjs", "agent-org:src/messaging/watch.mjs", "agent-org:src/messaging/event.mjs",
  "agent-org:src/messaging/core.mjs", "agent-org:src/messaging/core.test.mjs", "agent-org:src/messaging/listen.mjs",
  "agent-org:src/messaging/listen.test.mjs", "agent-org:src/messaging/converse.mjs", "agent-org:src/messaging/converse.test.mjs",
  "agent-org:src/messaging/providers/telegram/poll.test.mjs", "agent-org:src/messaging/watch-buttons.test.mjs",
  "agent-org:docs/messaging.md",
];
const SHARED = ["agent-org:src/messaging/core.mjs", "agent-org:src/messaging/event.mjs", "agent-org:src/messaging/watch.mjs"];

const claimed3423 = { number: 3423, files: REGION_3423, blockedBy: [] as number[] };

/** The entries a refusal says the two Regions share: the text between `declares: ` and the sentence that follows. */
const namedIn = (reason: string | null): string[] => (/declares: (.*?)\. B4:/.exec(reason ?? "")?.[1] ?? "").split(", ").filter(Boolean).sort();

const rowBody = (...files: string[]) => `## Region\n\n\`\`\`\n${files.join("\n")}\n\`\`\`\n`;
/** A Ready row's body with the template sections the gate shelves a row for lacking (#2791), so only B4 can shelve it. */
const readyRow = (number: number, files: string[]) => ({
  number, labels: [{ name: "ready" }], body: `${rowBody(...files)}\n## Acceptance\n\n\`\`\`bash\ntrue\n\`\`\`\n\n## Open-check\n\n\`\`\`\n$ true\n\`\`\`\n`,
});
const claimedRow = (number: number, files: string[], { blockedBy = [] as number[], labels = ["in-progress"] } = {}) => ({
  number, labels: labels.map((name) => ({ name })), body: rowBody(...files), blockedBy: { nodes: blockedBy.map((n) => ({ number: n })) },
});

/** One `gh` mock routed by subcommand shape, the way `row-claim-session-eligibility.test.ts` does it. */
function ghFor({ own, claimedRows, prs = [], claimedRead }: {
  own: { number: number; region: string[] }; claimedRows: unknown[]; prs?: unknown[]; claimedRead?: () => string;
}) {
  return (_cmd: string, args: string[]): string => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: own.number, title: "A row", body: rowBody(...own.region), labels: [], blockedBy: { nodes: [] } });
    }
    if (args[0] === "issue" && args[1] === "list") {
      return args.includes("number,labels,body,blockedBy") ? (claimedRead ? claimedRead() : JSON.stringify(claimedRows)) : "[]";
    }
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prs);
    return "[]";
  };
}
const claimFor = (number: number, session: string, run: ReturnType<typeof ghFor>) =>
  sessionEligibilityReason(number, session, { run, repo: TRACKER, repos: [AGENT_ORG] });

// --- (1) the #3414 fixture ----------------------------------------------------------------------------------------------------------

test("(1) the #3414 fixture: #3423 is claimed with no pull request, and B4 REFUSES #3414, naming #3423 and exactly core, event and watch", () => {
  const reason = claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414, openPrs: [] });
  assert.match(reason ?? "", /#3423/);
  assert.deepEqual(namedIn(reason), [...SHARED].sort());
  assert.match(reason ?? "", /stack/, "the other way out is named in the refusal: stacking is a person's choice");
});

test("(1) AT THE CLAIM: the same inputs through `sessionEligibilityReason` refuse #3414 with an empty open-PR list", () => {
  const run = ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [claimedRow(3423, REGION_3423)] });
  const reason = claimFor(3414, "worker-3414", run);
  assert.match(reason ?? "", /overlaps the Region of #3423/);
  assert.deepEqual(namedIn(reason), [...SHARED].sort());
});

// --- (2) the negative control: one fact different -----------------------------------------------------------------------------------

test("(2) #3423 released (no `in-progress`) or closed (not listed): no refusal -- at the claim, and in the pure rule", () => {
  const released = ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [claimedRow(3423, REGION_3423, { labels: ["ready"] })] });
  const closed = ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [] });
  assert.equal(claimFor(3414, "worker-3414", released), null);
  assert.equal(claimFor(3414, "worker-3414", closed), null);
  assert.equal(claimedRegionOverlapReason(REGION_3414, [], { rowNumber: 3414 }), null);
  assert.notEqual(claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414 }), null, "the control: one claimed row is the only difference");
});

test("(2) a claimed row that shares NO file is no competitor, whatever else it holds", () => {
  const elsewhere = { number: 3500, files: ["agent-org:src/other/thing.mjs"], blockedBy: [] };
  assert.equal(claimedRegionOverlapReason(REGION_3414, [elsewhere], { rowNumber: 3414 }), null);
});

// --- (3) a claimed row WITH an open pull request is counted once, by the pull request ------------------------------------------------

test("(3) #3423 WITH an open pull request declaring `Closes`: refused once, naming the pull request, and the row is not named twice", () => {
  const pr148 = { number: 148, changedFiles: 3, headRefName: "agent/x-3423", body: "Closes a11ign/a11ign#3423",
    files: SHARED.map((entry) => ({ path: entry.replace("agent-org:", "") })), labels: [] };
  const run = ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [claimedRow(3423, REGION_3423)], prs: [pr148] });
  const reason = claimFor(3414, "worker-3414", run);
  assert.match(reason ?? "", /overlaps #148 in a11ign\/agent-org/);
  assert.doesNotMatch(reason ?? "", /already claimed/, "the PR's files are the truth once they exist; the row is not named as well");
});

test("(3) the pull request's files are the truth: a PR that declares `Closes #3423` and touches none of the shared files frees the row's Region", () => {
  const openPrs = [{ closes: [3423] }];
  assert.equal(claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414, openPrs }), null);
  assert.notEqual(claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414, openPrs: [{ closes: [9999] }] }), null,
    "control: a pull request closing ANOTHER row excuses nothing");
  assert.notEqual(claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414, openPrs: [{ closes: [] }] }), null,
    "control: `Closes: none` closes no row, so the row is still counted by its Region");
});

// --- (4) the asking row is never its own competitor ---------------------------------------------------------------------------------

test("(4) the asking row is never its own competitor", () => {
  const itself = { number: 3414, files: REGION_3414, blockedBy: [] };
  assert.equal(claimedRegionOverlapReason(REGION_3414, [itself], { rowNumber: 3414 }), null);
  assert.notEqual(claimedRegionOverlapReason(REGION_3414, [itself], { rowNumber: 9999 }), null, "control: the same list, asked by another row");
});

test("(4) two rows BOTH already `in-progress` (dispatched together) do not refuse each other forever: the lower number proceeds", () => {
  const both = [claimedRow(3414, REGION_3414), claimedRow(3423, REGION_3423)];
  assert.equal(claimFor(3414, "worker-3414", ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: both })), null);
  assert.match(claimFor(3423, "worker-3423", ghFor({ own: { number: 3423, region: REGION_3423 }, claimedRows: both })) ?? "", /Region of #3414/);
});

// --- (5) a blockedBy edge in either direction excuses -------------------------------------------------------------------------------

test("(5) a `blockedBy` edge excuses, whichever row names the other -- and an unrelated edge excuses nothing", () => {
  const edges = new Map<number, number[]>();
  const blockersOf = (row: number) => edges.get(row) ?? null;
  const ask = () => claimedRegionOverlapReason(REGION_3414, [claimed3423], { rowNumber: 3414, blockersOf });
  edges.set(3423, [1]);
  assert.notEqual(ask(), null, "control: an edge that names neither row");
  edges.set(3423, [3414]);
  assert.equal(ask(), null, "the claimed row is blocked by the asker");
  edges.clear();
  edges.set(3414, [3423]);
  assert.equal(ask(), null, "the asker is blocked by the claimed row");
});

test("(5) at the claim, the claimed row's own `blockedBy` edge on the asker excuses", () => {
  const blockedOnAsker = claimedRow(3423, REGION_3423, { blockedBy: [3414] });
  assert.equal(claimFor(3414, "worker-3414", ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [blockedOnAsker] })), null);
});

// --- (6) a changeset-only overlap is no overlap -------------------------------------------------------------------------------------

test("(6) a changeset-only overlap is no overlap, and a shared source file beside it still is", () => {
  const mine = [".changeset/mine.md"];
  const theirs = { number: 3423, files: [".changeset/mine.md"], blockedBy: [] };
  assert.equal(claimedRegionOverlapReason(mine, [theirs], { rowNumber: 3414 }), null);
  assert.notEqual(claimedRegionOverlapReason([...mine, "src/a.mjs"], [{ ...theirs, files: [...theirs.files, "src/a.mjs"] }], { rowNumber: 3414 }), null);
});

// --- (7) FAILS CLOSED ---------------------------------------------------------------------------------------------------------------

test("(7) the claimed-row read failing is `null`, never `[]`: a throw, a bad payload and a full page are each unreadable", () => {
  assert.equal(lookupClaimedRegions({ run: () => { throw new Error("gh: 502"); }, repo: TRACKER }), null);
  assert.equal(lookupClaimedRegions({ run: () => "not json", repo: TRACKER }), null);
  const fullPage = Array.from({ length: 200 }, (_, i) => claimedRow(1000 + i, [`src/f${i}.mjs`]));
  assert.equal(lookupClaimedRegions({ run: () => JSON.stringify(fullPage), repo: TRACKER }), null, "200 may be a truncated page");
  assert.deepEqual(lookupClaimedRegions({ run: () => JSON.stringify(fullPage.slice(0, 199)), repo: TRACKER })?.length, 199, "control: one fewer reads");
  assert.equal(claimedRegionsOf(null), null);
});

test("(7) the claim REFUSES as INCONCLUSIVE when it cannot read who holds what -- and only when it had a Region to compare", () => {
  const unreadable = (): string => { throw new Error("gh: rate limited"); };
  const run = ghFor({ own: { number: 3414, region: REGION_3414 }, claimedRows: [], claimedRead: unreadable });
  assert.match(claimFor(3414, "worker-3414", run) ?? "", /COULD NOT BE ASKED which rows are already claimed.*INCONCLUSIVE/);
  const noRegion = ghFor({ own: { number: 3414, region: [] }, claimedRows: [], claimedRead: unreadable });
  assert.equal(claimFor(3414, "worker-3414", noRegion), null, "control: a row declaring no file has nothing to compare, so no read is asked of it");
});

test("(7) `check` says the same: refused, could-not-ask, or clear -- never silence", () => {
  const say = (claimed: () => unknown) => {
    const out: string[] = [];
    reportB4(3414, { write: (t: string) => out.push(t), mine: () => REGION_3414, others: () => [], claimed, repo: TRACKER });
    return out.join("");
  };
  assert.match(say(() => [claimed3423]), /B4 REFUSES THIS CLAIM: overlaps the Region of #3423/);
  assert.match(say(() => null), /COULD NOT BE ASKED which rows are already claimed.*refuses on it/);
  assert.match(say(() => []), /no row already claimed holds any file/);
});

test("(7) THE GATE treats an unread list as today: nothing is shelved, the row is offered, and the claim still asks", () => {
  const ready = readyRow(3414, REGION_3414);
  for (const openRows of [undefined, null]) {
    const { offerable, blocked } = partitionUnclaimed([ready], [], { rootFiles: new Set(), openRows });
    assert.deepEqual([offerable.length, blocked.length], [1, 0]);
  }
});

// --- (8) a keyed Region entry compares only with keyed entries of the same repository -----------------------------------------------

test("(8) `agent-org:` compares only with `agent-org:`, a bare entry only with bare ones (#2617's rule)", () => {
  const ask = (mine: string, theirs: string) => claimedRegionOverlapReason([mine], [{ number: 7, files: [theirs], blockedBy: [] }], { rowNumber: 1 });
  assert.notEqual(ask("agent-org:src/a.mjs", "agent-org:src/a.mjs"), null, "control: the same key and path");
  assert.notEqual(ask("src/a.mjs", "src/a.mjs"), null, "control: two bare entries");
  assert.equal(ask("agent-org:src/a.mjs", "src/a.mjs"), null);
  assert.equal(ask("src/a.mjs", "agent-org:src/a.mjs"), null);
  assert.equal(ask("nvda-worker:src/a.mjs", "agent-org:src/a.mjs"), null);
});

test("(8) a directory entry meets every entry under it, and the refusal names the more specific of the two", () => {
  const reason = claimedRegionOverlapReason(["agent-org:src/messaging/"], [{ number: 7, files: ["agent-org:src/messaging/core.mjs"], blockedBy: [] }], { rowNumber: 1 });
  assert.deepEqual(namedIn(reason), ["agent-org:src/messaging/core.mjs"]);
  assert.equal(claimedRegionOverlapReason(["agent-org:src/messaging/"], [{ number: 7, files: ["agent-org:src/other.mjs"], blockedBy: [] }], { rowNumber: 1 }), null);
});

// --- (9) THE GATE -------------------------------------------------------------------------------------------------------------------

test("(9) a Ready row whose Region shares a file with an `in-progress` row is SHELVED with that row's number, and offered once the holder is gone", () => {
  const ready = readyRow(3414, REGION_3414);
  const options = (openRows: unknown[]) => ({ rootFiles: new Set<string>(), openRows });

  const held = partitionUnclaimed([ready], [], options([claimedRow(3423, REGION_3423)]));
  assert.deepEqual(held.offerable, []);
  assert.equal(held.blocked.length, 1);
  assert.equal(held.blocked[0].number, 3414);
  assert.match(held.blocked[0].reason, /#3423/);

  const gone = partitionUnclaimed([ready], [], options([claimedRow(3423, REGION_3423, { labels: ["ready"] })]));
  assert.deepEqual([gone.offerable.length, gone.blocked.length], [1, 0], "released: the same row is offered");
  const closed = partitionUnclaimed([ready], [], options([]));
  assert.deepEqual([closed.offerable.length, closed.blocked.length], [1, 0], "closed: likewise");
});

test("(9) the gate counts a claimed row once: its open pull request's files decide, and its `blockedBy` edge excuses", () => {
  const ready = readyRow(3414, REGION_3414);
  const holder = claimedRow(3423, REGION_3423);
  const rootFiles = new Set<string>();
  const clear = partitionUnclaimed([ready], [{ number: 148, files: ["somewhere/else.mjs"], changedFiles: 1, closes: [3423] }], { rootFiles, openRows: [holder] });
  assert.deepEqual([clear.offerable.length, clear.blocked.length], [1, 0]);
  const excused = partitionUnclaimed([ready], [], { rootFiles, openRows: [claimedRow(3423, REGION_3423, { blockedBy: [3414] })] });
  assert.deepEqual([excused.offerable.length, excused.blocked.length], [1, 0]);
  const refused = partitionUnclaimed([ready], [], { rootFiles, openRows: [holder] });
  assert.equal(refused.blocked.length, 1, "control: without the pull request or the edge, the same holder shelves the row");
});

test("the Regions in this file are read by the tree's own parser as the rules read them (the fixtures are not a second dialect)", () => {
  assert.deepEqual(declaredRegionFiles(rowBody(...REGION_3414), { rootFiles: new Set() }), REGION_3414);
  assert.deepEqual(declaredRegionFiles(rowBody(...REGION_3423), { rootFiles: new Set() }), REGION_3423);
});
