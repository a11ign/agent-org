// no-token: gh -- `gh` is never reached: every call is handed a fake `run` over an in-memory pair of repositories.
/**
 * agent-org#575, a11ign/a11ign#4737: A `claim`, `dispatch`, `decline` AND `conflict` IN A DECLARED KEYED TRACKER WRITE THAT TRACKER, never the first
 * tracker's same-numbered issue.
 *
 * Before this row a claim in another tracker was refused at `trackerClaimRefusal` for lack of a write path, and the one-line fix (return `null`)
 * would have been worse than the refusal: `claimOrDispatch` and `declineRow` were never told a tracker, so the claim would have gone on to label
 * the FIRST tracker's issue of that number. So the two halves are tested together, over two repositories that BOTH hold a row 575:
 *   - the refusal: the correctly named claim, dispatch, decline and conflict are not refused; the same claim with the first tracker's
 *     `--worktree=../wt-575` (or `worker-575`) is, and an undeclared key is refused by name;
 *   - the write: `claimRow`, `dispatchRow` and `declineRow` given the tracker read, label, comment on and move the card of THE TRACKER'S issue and
 *     board, and the first tracker's issue of the same number is byte for byte what it was (the control that the claim is not merely writing everywhere);
 *   - the control: the same claim with NO tracker is the first tracker's, and asks its Status move with no tracker at all, as it always did;
 *   - the board move is the one `item-edit` on the tracker's board and no snapshot (`moveProjectStatus`'s own header says why); a tracker that
 *     declares NO board moves nothing, says `no board declared for tracker <key>`, and never falls back to the first tracker's card;
 *   - the worktree is made from the tracker's clone, and a claim that stops half-way is undone in the same call;
 *   - the wiring the CLI adds on top (`--tracker=` to the deps, `<key>#<n>` in the printed line, the clone, the conflict log's key).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { parseProjectDeclaration } from "./project-config.ts";
import { REPO } from "./project-identity.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "./board-snapshot.ts";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import {
  NO_BOARD_DECLARED, claimCloneFor, claimLineFor, claimRecordComment, claimRow, claimWithWorktree, declineRow, dispatchRow, latestCheckFor,
  moveProjectStatus, recordCheck, recordConflict, scopeHash, claimRecordFrom, trackerClaimRefusal, type Tracker,
} from "./row-claim.ts";

const here = dirname(fileURLToPath(import.meta.url));

const FIRST_REPO = REPO;
const SECOND_REPO = "a11ign/agent-org";
const SECOND_BOARD = PROJECT_NUMBER + 1;
const TWO_TRACKERS = parseProjectDeclaration(JSON.stringify({
  schema: 1,
  tracker: [
    { key: "", repo: FIRST_REPO, board: { owner: PROJECT_OWNER, number: PROJECT_NUMBER } },
    { key: "agent-org", repo: SECOND_REPO, board: { owner: PROJECT_OWNER, number: SECOND_BOARD } },
  ],
  code: [{ key: "", repo: FIRST_REPO }, { key: "agent-org", repo: SECOND_REPO }],
}));
const TRACKER: Tracker = { key: "agent-org", repo: SECOND_REPO, board: { owner: PROJECT_OWNER, number: SECOND_BOARD } };

const ROW = 575;
const SESSION = "worker-agent-org-575";
const BODY = "## Region\n\nNo file declared here.\n\n## Acceptance\n\n```bash\ntrue\n```\n\n## Open-check\n\nTRUE ALREADY\n";

// --- 1. the refusal ---------------------------------------------------------------------------------------------------------

test("POSITIVE: a claim and a decline in a declared keyed tracker, named as ADR 0040 decision 2 names them, are not refused", () => {
  assert.equal(trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: SESSION, worktree: "../wt-agent-org-575" }, TWO_TRACKERS), null);
  assert.equal(trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: SESSION, worktree: "/home/agent/repos/wt-agent-org-575/" }, TWO_TRACKERS), null,
    "a trailing slash and an absolute path name the same directory");
  assert.equal(trackerClaimRefusal({ mode: "decline", key: "agent-org", number: ROW, session: SESSION }, TWO_TRACKERS), null);
  assert.equal(trackerClaimRefusal({ mode: "dispatch", key: "agent-org", number: ROW, session: SESSION }, TWO_TRACKERS), null, "a dispatch is the same write without `started`");
  assert.equal(trackerClaimRefusal({ mode: "conflict", key: "agent-org", number: ROW }, TWO_TRACKERS), null, "a conflict is logged under the tracker's key");
});

test("NEGATIVE CONTROLS: the first tracker's names and an undeclared key are still refused, each for its own reason, in every mode", () => {
  const worktree = trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: SESSION, worktree: "../wt-575" }, TWO_TRACKERS) ?? "";
  assert.match(worktree, /names its worktree `wt-agent-org-575`, not `\.\.\/wt-575`/, "`--worktree=../wt-575` is the first tracker's row 575's directory");
  const session = trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: "worker-575", worktree: "../wt-agent-org-575" }, TWO_TRACKERS) ?? "";
  assert.match(session, /`worker-575` is the name of the session that holds the FIRST tracker's row 575/);
  const undeclared = trackerClaimRefusal({ mode: "claim", key: "nope", number: ROW, session: "worker-nope-575", worktree: "../wt-nope-575" }, TWO_TRACKERS) ?? "";
  assert.match(undeclared, /no tracker with key `nope`/, "refused by name, listing what IS declared");
  assert.match(trackerClaimRefusal({ mode: "decline", key: "nope", number: ROW, session: "worker-nope-575" }, TWO_TRACKERS) ?? "", /no tracker with key `nope`/);
  for (const mode of ["dispatch", "claim", "decline", "conflict"] as const) {
    assert.match(trackerClaimRefusal({ mode, key: "agent-org", number: ROW, session: "worker-575" }, TWO_TRACKERS) ?? "", /`worker-575` is the name of the session that holds the FIRST/, mode);
    assert.match(trackerClaimRefusal({ mode, key: "nope", number: ROW }, TWO_TRACKERS) ?? "", /no tracker with key `nope`/, mode);
  }
  assert.doesNotMatch(trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: "worker-575" }, TWO_TRACKERS) ?? "", /not built for a second tracker/,
    "and the stale \"not built yet\" reason is gone, never given for a name that is right");
});

test("the first tracker's claim is never refused for its names -- every claim written before this row is the same claim", () => {
  for (const mode of ["claim", "dispatch", "decline", "conflict"] as const) {
    assert.equal(trackerClaimRefusal({ mode, key: "", number: ROW, session: "worker-575", worktree: "../wt-575" }, TWO_TRACKERS), null, mode);
  }
});

// --- 2. the write -----------------------------------------------------------------------------------------------------------

type Issue = { labels: string[], state: string, body: string, comments: string[] };
type Call = { args: string[], repo: string | null };

/** Two repositories that BOTH have an issue 575, so a write that went to the wrong one is a write to a real, wrong issue. */
function fakeGithub(seed: { first?: string[], second?: string[], bodies?: { first?: string, second?: string } } = {}) {
  const issues = new Map<string, Issue>([
    [`${FIRST_REPO}#${ROW}`, { labels: seed.first ?? ["ready"], state: "OPEN", body: seed.bodies?.first ?? BODY, comments: [] }],
    [`${SECOND_REPO}#${ROW}`, { labels: seed.second ?? ["ready"], state: "OPEN", body: seed.bodies?.second ?? BODY, comments: [] }],
  ]);
  const calls: Call[] = [];
  const writes: Call[] = [];
  const fail = (what: string): never => { throw Object.assign(new Error(`Command failed: gh ${what}`), { status: 1, stdout: "", stderr: what }); };
  const run = (cmd: string, args: string[]): string => {
    if (cmd !== "gh") return fail(`${cmd} is not gh`);
    const flag = args.indexOf("--repo");
    const api = args[0] === "api" ? /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/.exec(args[args.indexOf("PUT") + 1] ?? "") : null;
    const repo = flag >= 0 ? args[flag + 1] : api ? api[1] : null;
    calls.push({ args, repo });
    const number = Number(api ? api[2] : args[2]);
    const issue = issues.get(`${repo}#${number}`);
    if (args[0] === "issue" && args[1] === "view") {
      if (!issue) return fail(`issue view ${number} -- Could not resolve to an issue in ${repo}`);
      const fields = args[args.indexOf("--json") + 1];
      if (fields === "blockedBy") return JSON.stringify({ blockedBy: { nodes: [] } });
      if (fields.split(",").includes("body")) return JSON.stringify({ body: issue.body, labels: issue.labels.map((name) => ({ name })) });
      if (fields === "comments") return JSON.stringify({ comments: issue.comments.map((body) => ({ body })) });
      return JSON.stringify({ number, title: "A row", labels: issue.labels.map((name) => ({ name })), state: issue.state });
    }
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "label" && args[1] === "create") { writes.push({ args, repo }); return ""; }
    if (api && args.includes("PUT")) {
      writes.push({ args, repo });
      if (!issue) return fail(`PUT to ${repo}#${number}`);
      issue.labels = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
      return "";
    }
    if (args[0] === "issue" && args[1] === "edit") {
      writes.push({ args, repo });
      if (!issue) return fail(`edit ${repo}#${number}`);
      for (let at = 0; at < args.length; at += 1) {
        if (args[at] === "--remove-label") issue.labels = issue.labels.filter((l) => l !== args[at + 1]);
        if (args[at] === "--add-label" && !issue.labels.includes(args[at + 1])) issue.labels.push(args[at + 1]);
      }
      return "";
    }
    if (args[0] === "issue" && args[1] === "comment") {
      writes.push({ args, repo });
      if (!issue) return fail(`comment ${repo}#${number}`);
      issue.comments.push(args[args.indexOf("--body") + 1]);
      return "";
    }
    if (args[0] === "project") { writes.push({ args, repo }); return ""; }
    return "[]";
  };
  return { run, calls, writes, issues, first: () => issues.get(`${FIRST_REPO}#${ROW}`) as Issue, second: () => issues.get(`${SECOND_REPO}#${ROW}`) as Issue };
}

const CLAIM_DEPS = { drained: [], instance: { spare: false, rows: [] }, persistent: false };
const issueWrites = (writes: Call[]) => writes.filter((call) => call.args[0] !== "project");

test("PRECONDITION: the two trackers really are two repositories and two boards, so every assertion below can tell them apart", () => {
  assert.notEqual(FIRST_REPO, SECOND_REPO);
  assert.notEqual(PROJECT_NUMBER, SECOND_BOARD);
});

test("`claim` in a keyed tracker labels THAT tracker's issue, comments there and moves ITS card -- and the first tracker's issue 575 is untouched", () => {
  const gh = fakeGithub();
  const result = claimRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, ...CLAIM_DEPS, branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575" });
  assert.deepEqual(result, { claimed: true, statusMoved: true });

  const held = gh.second().labels;
  for (const label of ["in-progress", `session:${SESSION}`, "started"]) assert.ok(held.includes(label), `the tracker's row carries ${label}: ${held.join(", ")}`);
  assert.ok(!held.includes("ready"), "and no longer `ready`");
  assert.deepEqual(gh.first().labels, ["ready"], "the first tracker's issue of the same number is exactly what it was");
  assert.deepEqual(gh.first().comments, []);

  assert.deepEqual(issueWrites(gh.writes).filter((call) => call.repo !== SECOND_REPO), [], "no write of any kind named the first tracker's repository");
  const put = gh.writes.find((call) => call.args[0] === "api") as Call;
  assert.equal(put.args[put.args.indexOf("PUT") + 1], `repos/${SECOND_REPO}/issues/${ROW}/labels`);
  const created = gh.writes.filter((call) => call.args[0] === "label").map((call) => call.args[2]);
  assert.deepEqual(created, ["in-progress", `session:${SESSION}`, "started", "was-ready"],
    "the claim creates the labels the tracker's repository does not have yet, so no vocabulary declaration is needed for them");
  const comments = gh.second().comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0], new RegExp(CLAIM_RECORD_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(comments[0], /agent\/x-agent-org-575/);

  const moves = gh.writes.filter((call) => call.args[0] === "project");
  assert.deepEqual(moves.map((call) => call.args), [["project", "item-edit", String(SECOND_BOARD), "--owner", PROJECT_OWNER,
    "--url", `https://github.com/${SECOND_REPO}/issues/${ROW}`, "--field", "Status", "--value", "In progress"]],
  "ONE item-edit, on the tracker's board, for the tracker's issue");
  assert.deepEqual(gh.calls.filter((call) => call.args[0] === "project" || call.args.includes("graphql")).length, 1,
    "and no board snapshot: the snapshot reads the FIRST tracker's board, so one taken here would guard the wrong board");
});

test("every read the keyed claim makes about the ROW goes to the tracker's repository too", () => {
  const gh = fakeGithub();
  claimRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, ...CLAIM_DEPS });
  const rowReads = gh.calls.filter((call) => call.args[0] === "issue" || call.args[0] === "label" || call.args[0] === "api");
  assert.ok(rowReads.length >= 6, `the claim read the row's labels, body and edge and wrote its labels: ${rowReads.length} calls`);
  assert.deepEqual([...new Set(rowReads.map((call) => call.repo))], [SECOND_REPO]);
});

test("CONTROL: the same claim with NO tracker is the first tracker's -- its issue is labelled, the tracker's is not, and the Status move names no tracker", () => {
  const gh = fakeGithub();
  const moves: object[] = [];
  const result = claimRow(ROW, "worker-575", { run: gh.run, ...CLAIM_DEPS, moveStatus: (_n: number, status: string, opts?: object) => { moves.push({ status, opts: opts ?? {} }); return { moved: true as const }; } });
  assert.equal(result.claimed, true);
  assert.ok(gh.first().labels.includes("in-progress") && gh.first().labels.includes("session:worker-575"));
  assert.deepEqual(gh.second().labels, ["ready"], "the other tracker's same-numbered issue is untouched");
  assert.equal(moves.length, 1);
  assert.equal("tracker" in ((moves[0] as { opts: object }).opts), false, "a first-tracker claim asks moveStatus exactly what it always asked");
});

test("a keyed tracker whose row cannot be read is NOT read as the first tracker's: the claim throws naming the repository and writes nothing", () => {
  const gh = fakeGithub();
  gh.issues.delete(`${SECOND_REPO}#${ROW}`);
  assert.throws(() => claimRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, ...CLAIM_DEPS }), new RegExp(`could not read issue #${ROW} from ${SECOND_REPO}`));
  assert.deepEqual(gh.writes, [], "nothing was written anywhere");
  assert.deepEqual(gh.first().labels, ["ready"], "least of all to the first tracker's row of that number");
});

test("a keyed tracker's row already held by another session is refused, from THAT tracker's labels", () => {
  const gh = fakeGithub({ first: ["ready"], second: ["in-progress", "started", "session:worker-agent-org-9"] });
  const result = claimRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, ...CLAIM_DEPS });
  assert.equal(result.claimed, false);
  assert.deepEqual(gh.writes, [], "refused before any write");
});

// --- 3. decline ---------------------------------------------------------------------------------------------------------------

test("`decline` in a keyed tracker releases THAT tracker's issue -- labels, release record and the card back to Ready -- and not the first's", () => {
  const record = claimRecordComment({ session: SESSION, branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575" });
  const gh = fakeGithub({ first: ["in-progress", "started", "session:worker-575"], second: ["in-progress", "started", "was-ready", `session:${SESSION}`] });
  gh.second().comments.push(record);
  const result = declineRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, keepWorktree: true });
  assert.deepEqual(result, { declined: true, restoredReady: true, blocked: false, closed: false, statusMoved: true });

  assert.deepEqual(gh.second().labels, ["ready"], "the tracker's row is back to `ready` and carries no claim");
  assert.deepEqual(gh.first().labels, ["in-progress", "started", "session:worker-575"], "the first tracker's row 575 -- another session's claim -- is untouched");
  assert.deepEqual(issueWrites(gh.writes).filter((call) => call.repo !== SECOND_REPO), []);
  assert.equal(gh.second().comments.length, 2, "a release record was posted under the claim record, in the tracker's repository");
  assert.match(gh.second().comments[1], /released by/);
  assert.deepEqual(gh.writes.filter((call) => call.args[0] === "project").map((call) => call.args), [["project", "item-edit", String(SECOND_BOARD), "--owner", PROJECT_OWNER,
    "--url", `https://github.com/${SECOND_REPO}/issues/${ROW}`, "--field", "Status", "--value", "Ready"]]);
});

test("a decline in a keyed tracker by a session that does not hold THAT tracker's row is refused, though it holds the first tracker's row of that number", () => {
  const gh = fakeGithub({ first: ["in-progress", "started", "session:worker-575"], second: ["in-progress", "started", `session:${SESSION}`] });
  const result = declineRow(ROW, "worker-575", { run: gh.run, tracker: TRACKER });
  assert.equal(result.declined, false);
  assert.match((result as { reason: string }).reason, new RegExp(`held by ${SESSION}, not worker-575`));
  assert.deepEqual(gh.writes, []);
});

test("CONTROL: a decline with NO tracker releases the first tracker's issue and moves its card with no tracker named", () => {
  const gh = fakeGithub({ first: ["in-progress", "started", "was-ready", "session:worker-575"], second: ["in-progress", "session:worker-agent-org-575"] });
  const moves: object[] = [];
  const result = declineRow(ROW, "worker-575", { run: gh.run, moveStatus: (_n: number, status: string, opts?: object) => { moves.push({ status, opts: opts ?? {} }); return { moved: true as const }; } });
  assert.equal(result.declined, true);
  assert.deepEqual(gh.first().labels, ["ready"]);
  assert.deepEqual(gh.second().labels, ["in-progress", "session:worker-agent-org-575"]);
  assert.equal("tracker" in ((moves[0] as { opts: object }).opts), false);
});

// --- 4. the board move --------------------------------------------------------------------------------------------------------

test("`moveProjectStatus` for a tracker on another board is one item-edit on THAT board with no snapshot; for the first board it is the snapshot's, as before", () => {
  const seen: string[][] = [];
  let snapshots = 0;
  const run = (_cmd: string, args: string[]) => { seen.push(args); return ""; };
  const snapshot = ((act: () => unknown) => { snapshots += 1; return act(); }) as never;
  const moved = moveProjectStatus(ROW, "In progress", { run, snapshot, tracker: TRACKER, log: () => {} });
  assert.deepEqual(moved, { moved: true });
  assert.equal(snapshots, 0, "no snapshot is taken for another tracker's board");
  assert.deepEqual(seen, [["project", "item-edit", String(SECOND_BOARD), "--owner", PROJECT_OWNER,
    "--url", `https://github.com/${SECOND_REPO}/issues/${ROW}`, "--field", "Status", "--value", "In progress"]]);

  seen.length = 0;
  moveProjectStatus(ROW, "In progress", { run, snapshot, log: () => {} });
  assert.equal(snapshots, 1, "CONTROL: with no tracker, the first board's snapshot guards the move as it always did");
  assert.deepEqual(seen, [["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
    "--url", `https://github.com/${FIRST_REPO}/issues/${ROW}`, "--field", "Status", "--value", "In progress"]]);

  seen.length = 0;
  const first = { key: "", repo: FIRST_REPO, board: { owner: PROJECT_OWNER, number: PROJECT_NUMBER } };
  moveProjectStatus(ROW, "Ready", { run, snapshot, tracker: first, log: () => {} });
  assert.equal(snapshots, 2, "a tracker that IS the first board keeps the snapshot");
});

test("a failed move on a keyed tracker's board is reported as the half-applied claim it is, never folded into success", () => {
  const run = () => { throw new Error("HTTP 502"); };
  const moved = moveProjectStatus(ROW, "In progress", { run, tracker: TRACKER, log: () => {} });
  assert.equal(moved.moved, false);
  assert.match((moved as { reason: string }).reason, /could not move #575's Status to "In progress" -- HTTP 502/);
});

// --- 5. what the CLI adds on top ----------------------------------------------------------------------------------------------

test("the printed line names a keyed row `<key>#<n>` as `check` does, and the first tracker's line is the line it always was", () => {
  assert.equal(claimLineFor("claim", ROW, SESSION, { key: "agent-org" }), `STARTED -- agent-org#575 is now in-progress / session:${SESSION} / started`);
  assert.equal(claimLineFor("claim", ROW, "worker-575", {}), "STARTED -- #575 is now in-progress / session:worker-575 / started");
});

test("THE WIRING: `--tracker=` reaches the write through `claimOrDispatch` and `runDecline`, and only a non-empty key adds a tracker to a call", () => {
  const source = readFileSync(resolve(here, "row-claim.ts"), "utf8");
  const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const claim = between("function claimOrDispatch(", "\n/**");
  assert.match(claim, /\.\.\.\(tracker \? \{ tracker \} : \{\}\)/, "the claim's deps carry the tracker only when there is one");
  assert.match(between("function runDispatchOrClaim(", "\n/**"), /tracker: trackerOfKey\(key\)/);
  assert.match(between("function runDecline(", "\n/**"), /declineRow\(issueNumber, mySession, \{[^}]*\.\.\.\(tracker \? \{ tracker \} : \{\}\)/);
  assert.match(between("function trackerOfKey(", "\n}\n"), /if \(key === ""\) return undefined/, "the empty key is no tracker, so a first-tracker call is unchanged");
  // a11ign/a11ign#4737: the clone reaches the tree-making claim, and the conflict log is told the key.
  assert.match(between("function runDispatchOrClaim(", "\n/**"), /claimCloneFor\(key, \{ branch, worktree \}\)[\s\S]*clone: cloned\.clone/);
  assert.match(claim, /claimWithWorktree\(issueNumber, mySession, \{[^}]*claimDeps[^}]*\.\.\.\(clone === undefined \? \{\} : \{ clone \}\)/);
  assert.match(between("function runDeclineOrConflict(", "\n/**"), /runConflict\(issueNumber, rest, trackerKeyOf\(rest\)\)/);
});

// --- 6. a11ign/a11ign#4737: dispatch, a tracker with no board, the conflict log, the clone, and the rollback ------------------------

test("`dispatch` in a keyed tracker writes `in-progress` and `session:` on THAT tracker's issue and not `started`; the first tracker's issue is untouched", () => {
  const gh = fakeGithub();
  const result = dispatchRow(ROW, SESSION, { run: gh.run, tracker: TRACKER });
  assert.equal(result.claimed, true);
  assert.deepEqual([...gh.second().labels].sort(), ["in-progress", `session:${SESSION}`, "was-ready"].sort(), "dispatched, not started");
  assert.deepEqual(gh.first().labels, ["ready"]);
  assert.deepEqual(issueWrites(gh.writes).filter((call) => call.repo !== SECOND_REPO), [], "no write named the first tracker's repository");
});

test("a tracker that declares NO board is claimed with its labels alone: no `gh project` call, the note says so, and the FIRST tracker's card is never moved", () => {
  const gh = fakeGithub();
  const noBoard = { key: "agent-org", repo: SECOND_REPO } as Tracker;
  const said: string[] = [];
  const result = claimRow(ROW, SESSION, { run: gh.run, tracker: noBoard, ...CLAIM_DEPS,
    moveStatus: (n: number, status: string, opts?: object) => moveProjectStatus(n, status, { ...(opts ?? {}), log: (line) => said.push(line) }) });
  assert.equal(result.claimed, true, "the labels are the claim, and they landed");
  assert.equal((result as { statusMoved: boolean }).statusMoved, false);
  assert.equal((result as { notOnBoard: boolean }).notOnBoard, true, "a known, permitted gap: the CLI exits clean on it");
  assert.match((result as { statusReason: string }).statusReason, new RegExp(`^${NO_BOARD_DECLARED} \`agent-org\``));
  assert.ok(gh.second().labels.includes("in-progress") && gh.second().labels.includes(`session:${SESSION}`));
  assert.deepEqual(gh.calls.filter((call) => call.args[0] === "project" || call.args.includes("graphql")), [], "no board call of any kind, so no board of the first tracker's either");
  assert.deepEqual(gh.first().labels, ["ready"]);
  assert.ok(said.some((line) => new RegExp(NO_BOARD_DECLARED).test(line)), "and it is said aloud, not only returned");
});

test("the conflict log keeps a keyed row's `check` and `conflict` under the tracker's key, so row 575 of two trackers is two rows -- and the first tracker's line is the line it was", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "row-claim-log-"));
  const log = resolve(dir, "log.jsonl");
  try {
    recordCheck(log, { issueNumber: ROW, claimed: false, started: false, sessions: [], reachability: null });
    recordCheck(log, { issueNumber: ROW, tracker: "agent-org", claimed: true, started: true, sessions: [SESSION], reachability: null });
    assert.deepEqual(latestCheckFor(log, ROW, "agent-org")?.sessions, [SESSION], "the keyed row's own verdict");
    assert.deepEqual(latestCheckFor(log, ROW)?.sessions, [], "CONTROL: the first tracker's row of that number reads the first tracker's verdict");
    assert.equal(latestCheckFor(log, ROW, "other"), null, "a tracker nothing was checked in has none");
    recordConflict(log, { issueNumber: ROW, tracker: "agent-org", recordedVerdict: latestCheckFor(log, ROW, "agent-org"), found: "x" });
    recordConflict(log, { issueNumber: ROW, recordedVerdict: null, found: "y" });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[2].tracker, "agent-org");
    assert.equal("tracker" in lines[3], false, "the first tracker's conflict line carries no tracker key, as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the clone: a keyed claim's worktree is made from THAT repository's clone, whatever directory the process runs in --------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });

/** Two repositories, each with its own bare origin holding `main`: the keyed one (`agent-org`) and the first tracker's checkout the process runs in. */
function twoCheckouts() {
  const dir = mkdtempSync(resolve(tmpdir(), "row-claim-clone-"));
  const make = (name: string, extraBranch?: string) => {
    const origin = resolve(dir, `${name}-origin.git`);
    const checkout = resolve(dir, name);
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(dir, "clone", "--quiet", origin, checkout);
    for (const [key, value] of [["user.name", "probe"], ["user.email", "probe@example.invalid"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) git(checkout, "config", key, value);
    writeFileSync(resolve(checkout, "f.txt"), `${name}\n`);
    git(checkout, "add", "f.txt");
    git(checkout, "commit", "--quiet", "-m", name);
    git(checkout, "push", "--quiet", "origin", "main");
    if (extraBranch) git(checkout, "push", "--quiet", "origin", `main:refs/heads/${extraBranch}`);
    return checkout;
  };
  // The FIRST tracker's origin already holds a branch ending `-575` -- another repository's row 575, which #2014's rule must not read as this row's.
  return { dir, keyed: make("agent-org"), primary: make("a11y-witness", "agent/someone-elses-575") };
}

test("a keyed claim's worktree is made FROM THE TRACKER'S CLONE, not from the directory the process runs in, and #2014's row-branch rule asks THAT origin", () => {
  const fx = twoCheckouts();
  try {
    const inPrimary = (cmd: string, args: string[]) => {
      if (cmd !== "git") throw new Error(`no ${cmd} here`);
      return execFileSync("git", args, { cwd: fx.primary, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    };
    const claim = ((_n: number, _s: string, deps: { worktree?: string }) => ({ claimed: true, statusMoved: true, seen: deps.worktree })) as never;
    const stamp = () => {};

    // CONTROL: with no clone the process's cwd decides, and the first tracker's origin refuses row 575 for its own, unrelated branch.
    const control = claimWithWorktree(ROW, SESSION, { branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575", run: inPrimary, claim, stamp,
      exists: () => false });
    assert.equal(control.claimed, false);
    assert.match((control as { reason: string }).reason, /origin already holds a branch for row #?575|someone-elses-575/, "the control is refused by the OTHER repository's branch");

    const tree = resolve(fx.dir, "wt-agent-org-575");
    const result = claimWithWorktree(ROW, SESSION, { branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575", run: inPrimary, claim, stamp,
      claimDeps: { tracker: TRACKER }, clone: fx.keyed });
    assert.equal(result.claimed, true, `the keyed claim is not refused by the first tracker's branch: ${JSON.stringify(result)}`);
    assert.equal((result as { seen?: string }).seen, tree, "the claim is handed (and records) the absolute path the tree was made at");
    assert.match(git(fx.keyed, "worktree", "list", "--porcelain"), new RegExp(`worktree ${tree}\\n`), "the tree is a worktree of the KEYED clone");
    assert.match(git(fx.keyed, "branch", "--list", "agent/x-agent-org-575"), /agent\/x-agent-org-575/);
    assert.doesNotMatch(git(fx.primary, "worktree", "list", "--porcelain"), /wt-agent-org-575/, "and not of the checkout the process ran in");
    assert.equal(git(fx.primary, "branch", "--list", "agent/x-agent-org-575").trim(), "", "whose branch list never saw the name");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("`claimCloneFor`: a keyed claim that makes a tree needs `clones.<key>` and is REFUSED BEFORE ANY WRITE without it; the first tracker and a tree-less claim need none", () => {
  const cloneOf = (key: string) => (key === "agent-org" ? { clone: "/home/agent/repos/agent-org" } : { refusal: `/host.json declares no absolute \`clones.${key}\` path` });
  assert.deepEqual(claimCloneFor("agent-org", { branch: "b", worktree: "../wt-agent-org-575" }, { cloneOf }), { clone: "/home/agent/repos/agent-org" });
  const none = claimCloneFor("lab", { branch: "b", worktree: "../wt-lab-1" }, { cloneOf }) as { refusal: string };
  assert.match(none.refusal, /clones\.lab/);
  assert.match(none.refusal, /Nothing was written/);
  assert.equal(claimCloneFor("", { branch: "b", worktree: "../wt-575" }, { cloneOf }), null, "the first tracker keeps the process's own checkout");
  assert.equal(claimCloneFor("agent-org", {}, { cloneOf }), null, "a claim that creates no worktree has no clone to name");
});

// --- the rollback --------------------------------------------------------------------------------------------------------------

test("a keyed claim that throws AFTER its labels landed is undone in the same call: the labels taken back, the tree and branch removed, and the error says so", () => {
  const fx = twoCheckouts();
  try {
    const gh = fakeGithub();
    const run = (cmd: string, args: string[]) => (cmd === "git" ? git(fx.keyed, ...args.filter((a, at) => !(a === "-C" || args[at - 1] === "-C"))) : gh.run(cmd, args));
    // The claim writes its labels through the fake, then fails at the claim record -- the half-way the row names.
    const claim = ((n: number, s: string, deps: object) => {
      const out = claimRow(n, s, { ...deps, ...CLAIM_DEPS, run: (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "issue" && args[1] === "comment") throw new Error("HTTP 502 posting the claim record");
        return gh.run(cmd, args);
      } } as never);
      return out;
    }) as never;
    let thrown: Error | null = null;
    try {
      claimWithWorktree(ROW, SESSION, { branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575", run, claim, stamp: () => {},
        claimDeps: { tracker: TRACKER }, clone: fx.keyed });
    } catch (error) {
      thrown = error as Error;
    }
    assert.ok(thrown, "the failure is still raised");
    assert.match(thrown.message, /HTTP 502 posting the claim record/, "the original failure is kept");
    assert.match(thrown.message, /UNDONE IN THE SAME CALL/);
    assert.match(thrown.message, new RegExp(`labels in ${SECOND_REPO} were taken back`));
    assert.match(thrown.message, /it had just created were removed/);
    assert.deepEqual(gh.second().labels, ["ready"], "the tracker's row is `ready` again");
    assert.deepEqual(gh.first().labels, ["ready"], "and the first tracker's was never touched");
    assert.equal(git(fx.keyed, "branch", "--list", "agent/x-agent-org-575").trim(), "", "the branch is gone");
    assert.doesNotMatch(git(fx.keyed, "worktree", "list", "--porcelain"), /wt-agent-org-575/, "and so is the tree");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("CONTROL: the first tracker's claim that throws leaves what it made for `decline`, exactly as before -- the rollback is the keyed claim's alone", () => {
  const fx = twoCheckouts();
  try {
    const run = (cmd: string, args: string[]) => git(fx.keyed, ...(cmd === "git" ? args : []));
    const claim = (() => { throw Object.assign(new Error("boom"), { landed: ["labels"] }); }) as never;
    assert.throws(() => claimWithWorktree(ROW, "worker-575", { branch: "agent/x-575", worktree: resolve(fx.dir, "wt-575"), run: run as never, claim, stamp: () => {} }),
      (error: Error) => /boom/.test(error.message) && !/UNDONE/.test(error.message));
    assert.match(git(fx.keyed, "worktree", "list", "--porcelain"), /wt-575/, "the tree is still there");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// --- 3. the claim record remembers the scope it was claimed with (#4739, class `row-not-finishable`, #4627) ----------------------

/** A row the way the template writes one: prose, a fenced Region, an Acceptance command, and sections the hash must never read. */
const SCOPED = [
  "## What it is", "", "Prose the hash does not read.", "",
  "## Region", "", "```", "agent-org:src/row-claim.ts", "agent-org:src/row-claim.test.ts", "```", "",
  "## Acceptance", "", "```bash", "npx rstest run src/row-claim.test.ts", "```", "",
  "## Done-when", "", "1. merged", "",
  "## Open-check", "", "```", "true", "```", "",
].join("\n");
const withReplaced = (from: string, to: string, body = SCOPED) => {
  assert.ok(body.includes(from), `the fixture carries ${JSON.stringify(from)}`);
  return body.replace(from, to);
};

test("`scopeHash`: the same two sections give the same hash, however the whitespace and line endings fall -- the positive control for the rest", () => {
  const hash = scopeHash(SCOPED);
  assert.match(hash, /^[0-9a-f]{12}$/, "a short hex hash");
  assert.equal(scopeHash(SCOPED), hash, "and it is deterministic");
  assert.equal(scopeHash(SCOPED.replace(/\n/g, "\r\n")), hash, "CRLF is the same row");
  assert.equal(scopeHash(withReplaced("npx rstest run src/row-claim.test.ts", "  npx   rstest  run  src/row-claim.test.ts  ")), hash, "runs of spaces are the same Acceptance");
  assert.equal(scopeHash(SCOPED.replace(/\n\n/g, "\n\n\n")), hash, "blank lines are not scope");
});

test("`scopeHash`: a Region that gained a path is a different hash, and so is an Acceptance that changed", () => {
  const hash = scopeHash(SCOPED);
  const widened = withReplaced("agent-org:src/row-claim.test.ts\n", "agent-org:src/row-claim.test.ts\nagent-org:src/work-gate.ts\n");
  assert.notEqual(scopeHash(widened), hash, "a path added to the Region");
  assert.notEqual(scopeHash(withReplaced("npx rstest run src/row-claim.test.ts", "npx rstest run src/row-claim.test.ts src/work-gate.test.ts")), hash, "an Acceptance that changed");
  assert.notEqual(scopeHash(withReplaced("```bash\nnpx", "```bash\ncd /home/agent/repos/agent-org && npx")), hash, "an Acceptance that gained a command prefix");
});

test("`scopeHash`: prose outside the two sections is not scope -- the same hash", () => {
  const hash = scopeHash(SCOPED);
  assert.equal(scopeHash(withReplaced("Prose the hash does not read.", "A different paragraph entirely.")), hash, "the introduction");
  assert.equal(scopeHash(withReplaced("1. merged", "1. merged, and the board edition re-read")), hash, "Done-when");
  assert.equal(scopeHash(`${SCOPED}\n## Tier\n\nRouter decides.\n\nFiled-by: product-manager\n`), hash, "a section added after the two");
  assert.equal(scopeHash(withReplaced("```\ntrue\n```", "```\nfalse\n```")), hash, "Open-check, which is not Acceptance");
});

test("`scopeHash`: a NARROWING is a different hash too -- it reports the change and does not say which way it went", () => {
  const widened = withReplaced("agent-org:src/row-claim.test.ts\n", "agent-org:src/row-claim.test.ts\nagent-org:src/work-gate.ts\n");
  const narrowed = withReplaced("agent-org:src/row-claim.test.ts\n", "");
  assert.notEqual(scopeHash(narrowed), scopeHash(SCOPED), "a path taken out of the Region");
  assert.notEqual(scopeHash(narrowed), scopeHash(widened), "and the two directions are not one hash");
});

test("`scopeHash`: a section that is ABSENT is not an empty one", () => {
  const withoutAcceptance = SCOPED.replace(/## Acceptance[\s\S]*?(?=## Done-when)/, "");
  const emptyAcceptance = SCOPED.replace(/## Acceptance[\s\S]*?(?=## Done-when)/, "## Acceptance\n\n");
  assert.ok(!/## Acceptance/.test(withoutAcceptance) && /## Acceptance/.test(emptyAcceptance), "the fixtures are what they say");
  assert.notEqual(scopeHash(withoutAcceptance), scopeHash(emptyAcceptance));
  assert.notEqual(scopeHash(withoutAcceptance), scopeHash(SCOPED));
});

test("the claim comment carries `Claimed-scope:` and `claimRecordFrom` reads it back; a release carries none", () => {
  const hash = scopeHash(SCOPED);
  const claim = claimRecordComment({ session: "worker-1", branch: "agent/x-1", worktree: "../wt-1", scope: hash });
  assert.match(claim, new RegExp(`^Claimed-scope: ${hash}$`, "m"));
  assert.deepEqual(claimRecordFrom([claim]), { branch: "agent/x-1", worktree: "../wt-1", recorded: true, scope: hash });
  const release = claimRecordComment({ session: "worker-1", released: true, scope: hash });
  assert.doesNotMatch(release, /Claimed-scope/, "a release writes the marker with no field lines");
  assert.equal(claimRecordFrom([claim, release]).scope, null, "NEWEST wins, so a released row has no remembered scope");
  assert.match(claimRecordComment({ session: "worker-1", scope: hash }), /No branch or worktree is recorded/, "the scope line is not mistaken for a recorded git object");
});

test("a record with no `Claimed-scope:` line -- every one written before this row -- reads `scope: null` and its other fields are what they were", () => {
  const legacy = [CLAIM_RECORD_MARKER, "**Claim record** -- claimed by `worker-4739`.", "", "Claimed-branch: agent/scope-added-to-a-4739", "Claimed-worktree: ../wt-4739", "",
    "The branch and worktree live here rather than in a `branch:`/`worktree:` label because GitHub caps a label name at 50 characters and an ordinary absolute path does not fit (#987)."].join("\n");
  assert.deepEqual(claimRecordFrom([legacy]), { branch: "agent/scope-added-to-a-4739", worktree: "../wt-4739", recorded: true, scope: null });
  assert.deepEqual(claimRecordFrom([]), { branch: null, worktree: null, recorded: false, scope: null });
  assert.equal(claimRecordComment({ session: "worker-1", branch: "agent/x-1", worktree: "../wt-1" }), claimRecordComment({ session: "worker-1", branch: "agent/x-1", worktree: "../wt-1", scope: null }),
    "a caller that passes no scope writes the comment it always wrote");
});

test("`claim` posts the hash of the row it just READ: the same body and a changed body read back as the same hash and a different one", () => {
  const claimed = (body: string) => {
    const gh = fakeGithub({ bodies: { first: body } });
    const result = claimRow(ROW, "worker-575", { run: gh.run, ...CLAIM_DEPS, branch: "agent/x-575", worktree: "../wt-575", moveStatus: () => ({ moved: true as const }) });
    assert.equal(result.claimed, true);
    assert.equal(gh.first().comments.length, 1);
    return claimRecordFrom(gh.first().comments);
  };
  const body = `${BODY}\n## Tier\n\nRouter decides.\n`;
  const first = claimed(BODY);
  assert.equal(first.scope, scopeHash(BODY), "the record carries the hash of the row's own body");
  assert.equal(claimed(body).scope, first.scope, "prose after the sections is the same claim");
  assert.notEqual(claimed(BODY.replace("No file declared here.", "No file declared here, or here.")).scope, first.scope, "a Region that read differently is another");
  assert.equal(first.branch, "agent/x-575", "and the branch is still recorded beside it");
});

test("a KEYED tracker's claim hashes the TRACKER'S row, not the first tracker's issue of the same number", () => {
  const trackerBody = BODY.replace("No file declared here.", "No file declared here, said the other tracker.");
  const gh = fakeGithub({ bodies: { second: trackerBody } });
  const result = claimRow(ROW, SESSION, { run: gh.run, tracker: TRACKER, ...CLAIM_DEPS, branch: "agent/x-agent-org-575", worktree: "../wt-agent-org-575" });
  assert.equal(result.claimed, true);
  assert.equal(claimRecordFrom(gh.second().comments).scope, scopeHash(trackerBody));
  assert.notEqual(scopeHash(trackerBody), scopeHash(BODY), "PRECONDITION: the two trackers' bodies hash differently, so the assertion above can tell them apart");
  assert.deepEqual(gh.first().comments, [], "and the first tracker's issue is untouched");
});

test("a body that cannot be read leaves the line OUT rather than hashing nothing, and the claim goes on as it did", () => {
  const gh = fakeGithub();
  const run = (cmd: string, args: string[]) => {
    if (args.includes("body") || args.includes("body,labels")) throw Object.assign(new Error("Command failed: gh issue view -- HTTP 502"), { status: 1, stdout: "", stderr: "502" });
    return gh.run(cmd, args);
  };
  const result = claimRow(ROW, "worker-575", { run, ...CLAIM_DEPS, branch: "agent/x-575", worktree: "../wt-575", moveStatus: () => ({ moved: true as const }) });
  assert.equal(result.claimed, true);
  const record = gh.first().comments[0];
  assert.doesNotMatch(record, /Claimed-scope/);
  assert.equal(claimRecordFrom([record]).scope, null, "`null` is could-not-read, never a hash of an empty body");
});
