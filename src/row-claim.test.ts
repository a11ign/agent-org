// no-token: gh -- `gh` is never reached: every call is handed a fake `run` over an in-memory pair of repositories.
/**
 * agent-org#575: A `claim` AND A `decline` IN A DECLARED KEYED TRACKER WRITE THAT TRACKER, never the first tracker's same-numbered issue.
 *
 * Before this row a claim in another tracker was refused at `trackerClaimRefusal` for lack of a write path, and the one-line fix (return `null`)
 * would have been worse than the refusal: `claimOrDispatch` and `declineRow` were never told a tracker, so the claim would have gone on to label
 * the FIRST tracker's issue of that number. So the two halves are tested together, over two repositories that BOTH hold a row 575:
 *   - the refusal: the correctly named claim and decline are not refused; the same claim with the first tracker's `--worktree=../wt-575` (or
 *     `worker-575`) is, an undeclared key is refused by name, and `dispatch`/`conflict` still say they are not built;
 *   - the write: `claimRow` and `declineRow` given the tracker read, label, comment on and move the card of THE TRACKER'S issue and board, and the
 *     first tracker's issue of the same number is byte for byte what it was (the control that the claim is not merely writing everywhere);
 *   - the control: the same claim with NO tracker is the first tracker's, and asks its Status move with no tracker at all, as it always did;
 *   - the board move is the one `item-edit` on the tracker's board and no snapshot (`moveProjectStatus`'s own header says why);
 *   - the wiring the CLI adds on top (`--tracker=` to the deps, `<key>#<n>` in the printed line).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectDeclaration } from "./project-config.ts";
import { REPO } from "./project-identity.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "./board-snapshot.ts";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import {
  claimLineFor, claimRecordComment, claimRow, declineRow, moveProjectStatus, trackerClaimRefusal, type Tracker,
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
});

test("NEGATIVE CONTROLS: the first tracker's names, an undeclared key and the modes with no keyed write are still refused, each for its own reason", () => {
  const worktree = trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: SESSION, worktree: "../wt-575" }, TWO_TRACKERS) ?? "";
  assert.match(worktree, /names its worktree `wt-agent-org-575`, not `\.\.\/wt-575`/, "`--worktree=../wt-575` is the first tracker's row 575's directory");
  const session = trackerClaimRefusal({ mode: "claim", key: "agent-org", number: ROW, session: "worker-575", worktree: "../wt-agent-org-575" }, TWO_TRACKERS) ?? "";
  assert.match(session, /`worker-575` is the name of the session that holds the FIRST tracker's row 575/);
  const undeclared = trackerClaimRefusal({ mode: "claim", key: "nope", number: ROW, session: "worker-nope-575", worktree: "../wt-nope-575" }, TWO_TRACKERS) ?? "";
  assert.match(undeclared, /no tracker with key `nope`/, "refused by name, listing what IS declared");
  assert.match(trackerClaimRefusal({ mode: "decline", key: "nope", number: ROW, session: "worker-nope-575" }, TWO_TRACKERS) ?? "", /no tracker with key `nope`/);
  for (const mode of ["dispatch", "conflict"] as const) {
    const edge = trackerClaimRefusal({ mode, key: "agent-org", number: ROW, session: SESSION }, TWO_TRACKERS) ?? "";
    assert.match(edge, new RegExp(`\`${mode}\` in tracker \`agent-org\` is not built for a second tracker yet.*Nothing was written\\.`), mode);
  }
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
function fakeGithub(seed: { first?: string[], second?: string[] } = {}) {
  const issues = new Map<string, Issue>([
    [`${FIRST_REPO}#${ROW}`, { labels: seed.first ?? ["ready"], state: "OPEN", body: BODY, comments: [] }],
    [`${SECOND_REPO}#${ROW}`, { labels: seed.second ?? ["ready"], state: "OPEN", body: BODY, comments: [] }],
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
      if (fields === "body") return JSON.stringify({ body: issue.body });
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
});
