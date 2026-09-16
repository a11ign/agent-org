// @ts-check
// #1275: THE SCOPED HALF OF A BOARD SNAPSHOT, PURE OF `gh` -- and that is placement rather than style.
//
// `board-snapshot.mjs` runs `gh`, so every test importing it needs a `token` that CI's acceptance job does not
// have. #1275's first Acceptance command was refused for exactly that: "board-snapshot.test.ts requires token via
// fetchBoardItems → board-snapshot.mjs:361". #1009 and #1219 (`board-status-health.mjs`) record the fix: the logic
// lives where a pure test can reach it, the request is injected, and the one `gh` call the scoped read needs is
// made in `board-snapshot.mjs`. NOTHING HERE MAY IMPORT `board-snapshot.mjs`, not even a constant, or this file
// inherits its requirement again -- so the constants both halves need live here, and that file re-exports them.
//
// What the scoped half is: a mutation that names the item it touches snapshots that item, not the board. Every
// board mutation in `scripts/` is one item's Status (`row-claim.mjs`'s `moveProjectStatus`); #399's accident was a
// FIELD rewrite that no script sends. A full sweep before each one-item edit cost 6 GraphQL pages at 555 items plus
// the ready-issue list, and the account's GraphQL budget ran out twice on 2026-09-13.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO } from "../../../scripts/repo-identity.mjs";
// #1425: the classifier the close path already uses. That module imports nothing, so this file stays free of `gh`.
import { refusalCause, PROJECT_UNREADABLE } from "./settle-closed-status.mjs";

export const PROJECT_OWNER = REPO.split("/")[0];
export const PROJECT_NUMBER = 2;
/**
 * #1352: the filesystem reads `commonGitDirOf` and `primaryLaunchRefusal` make, injectable so a test drives them with
 * the shapes git writes. No spawn: git's worktree files are plain text, and reading them keeps this module free of
 * every command, not only `gh`.
 * @typedef {{ exists: (path: string) => boolean, isDirectory: (path: string) => boolean, read: (path: string) => string }} GitFs
 */
/** @type {GitFs} */
const LIVE_FS = {
  exists: existsSync,
  isDirectory: (path) => lstatSync(path).isDirectory(),
  read: (path) => readFileSync(path, "utf8"),
};

/**
 * #1352: THE REPOSITORY'S COMMON GIT DIRECTORY, as seen from the checkout at `root` -- the same answer from every
 * worktree of one repository. A `.git` DIRECTORY is the common dir itself: the primary checkout, or a plain clone.
 * A `.git` FILE is a linked worktree's `gitdir: <path>` line; that gitdir's `commondir` file names the common dir
 * relative to it (`../..` for `git worktree add`). Measured on this host: wt-1352's `.git` names
 * `…/a11y-witness/.git/worktrees/wt-1352`, whose `commondir` is `../..` -- `/home/agent/repos/a11y-witness/.git`,
 * exactly what `git rev-parse --git-common-dir` answers from both trees. `null` when `root` holds no `.git` at all.
 * @param {string} root @param {GitFs} [fs]
 * @returns {string | null}
 */
export function commonGitDirOf(root, fs = LIVE_FS) {
  const dotGit = join(root, ".git");
  if (!fs.exists(dotGit)) return null;
  if (fs.isDirectory(dotGit)) return dotGit;
  const match = /^gitdir:\s*(.+)$/m.exec(fs.read(dotGit));
  if (!match) return null;
  const gitDir = resolve(root, match[1].trim());
  const commondir = join(gitDir, "commondir");
  return fs.exists(commondir) ? resolve(gitDir, fs.read(commondir).trim()) : gitDir;
}

/**
 * #1352: WHERE BOARD SNAPSHOTS LIVE -- the common dir's checkout, plus `runs/board-snapshots`. So a policy script run
 * from ANY worktree writes into ONE directory, the primary checkout's (gitignored, and the lifetime of the repository
 * rather than of whichever worktree ran the script). It was the cwd-relative literal `runs/board-snapshots`: 77 files
 * in the primary, 52 in wt-pm-rows, 4 in wt-1315, 2 in wt-orch-rows and one each in wt-tooling-rows and wt-1482 at
 * 00:41Z on 2026-09-14, and a removed worktree took its snapshots with it (#1373). A plain clone -- CI, the lab --
 * resolves to its own root, which is where it wrote before. With no `.git` found, the checkout root itself.
 * @param {string} root @param {GitFs} [fs]
 * @returns {string}
 */
export function snapshotDirFor(root, fs = LIVE_FS) {
  const common = commonGitDirOf(root, fs);
  return join(common === null ? root : dirname(common), "runs", "board-snapshots");
}

/** Resolved once, from THIS script's own checkout -- never from the directory a caller happened to launch in. */
export const SNAPSHOT_DIR = snapshotDirFor(fileURLToPath(new URL("../../../", import.meta.url)));

/** #1352: the local git config key `npm run primary:mark` sets on the fleet-driving checkout. */
export const PRIMARY_MARK_KEY = "a11y.primaryCheckout";

/**
 * The nearest directory at or above `cwd` holding a `.git`, or null outside any checkout.
 * @param {string} cwd @param {GitFs} [fs]
 * @returns {string | null}
 */
export function launchCheckoutOf(cwd, fs = LIVE_FS) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (fs.exists(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Pure: whether git config text sets `a11y.primaryCheckout` true -- section and key case-insensitive, as git reads them.
 * @param {string} configText
 * @returns {boolean}
 */
function primaryMarkSet(configText) {
  let inA11y = false;
  for (const line of configText.split("\n")) {
    const section = /^\s*\[\s*([^\]\s]+)\s*\]\s*$/.exec(line);
    if (section) { inA11y = section[1].toLowerCase() === "a11y"; continue; }
    if (inA11y && /^\s*primarycheckout\s*=\s*true\s*$/i.test(line)) return true;
  }
  return false;
}

/**
 * #1352: A POLICY SCRIPT REFUSES WHEN LAUNCHED OUTSIDE A LINKED WORKTREE -- ceo's ruling, detection (i). The launch
 * directory's checkout has a `.git` DIRECTORY: the primary checkout, or a plain clone. Both are shared or not a
 * session's own, and the 2026-09-11 rule says policy scripts run from a worktree; three sessions had been told it and
 * the primary still held 77 snapshots. When the checkout also carries the `a11y.primaryCheckout` mark, the refusal
 * says so as a second reason, so the mark's ABSENCE (this host's primary is unmarked) never weakens it.
 * @param {string} command the entry point's name, for the message
 * @param {{ cwd?: string, fs?: GitFs }} [deps]
 * @returns {string | null} the refusal, or null to go ahead
 */
export function primaryLaunchRefusal(command, { cwd = process.cwd(), fs = LIVE_FS } = {}) {
  return launchCheckRefusal(command, { cwd, fs });
}

/** #1352: the printed override, named the way this repository names every other one (`A11Y_*_REASON`). */
export const POLICY_LAUNCH_REASON_ENV = "A11Y_POLICY_LAUNCH_REASON";

/**
 * #1352: THE REFUSAL OR ITS PRINTED OVERRIDE. A non-empty `A11Y_POLICY_LAUNCH_REASON` lets a launch outside a linked
 * worktree proceed, and the reason is PRINTED rather than merely allowed, so a deliberate exception is in the log rather
 * than in somebody's memory -- the same shape as `A11Y_PRIMARY_COMMIT_REASON`. An empty or blank reason is no reason.
 * Its first users are the tests that drive a real CLI from CI's plain clone, which the refusal would otherwise stop
 * before the check they were written to reach.
 * @param {string} command
 * @param {{ cwd?: string, fs?: GitFs, env?: Record<string, string | undefined> }} [deps]
 * @returns {{ refusal: string | null, notice: string | null }}
 */
export function primaryLaunchDecision(command, { cwd = process.cwd(), fs = LIVE_FS, env = process.env } = {}) {
  const refusal = launchCheckRefusal(command, { cwd, fs });
  const reason = (env[POLICY_LAUNCH_REASON_ENV] ?? "").trim();
  if (refusal === null || reason === "") return { refusal, notice: null };
  return { refusal: null, notice: `${command}: launched outside a linked worktree, proceeding anyway -- `
    + `${POLICY_LAUNCH_REASON_ENV}="${reason}"` };
}

/**
 * #1352: THE GATE EACH POLICY SCRIPT'S ENTRY POINT CALLS -- one call, so an entry point pays one branch for it (row-claim's
 * `main` sits at the complexity limit). Writes the override notice or the refusal, and says whether to stop.
 * @param {string} command
 * @param {{ write?: (text: string) => void, cwd?: string, fs?: GitFs, env?: Record<string, string | undefined> }} [deps]
 * @returns {boolean} true when the launch was refused and the caller must exit
 */
export function launchGate(command, { write = (text) => { process.stderr.write(text); }, ...deps } = {}) {
  const { refusal, notice } = primaryLaunchDecision(command, deps);
  if (notice) write(`${notice}\n`);
  if (refusal) write(`${refusal}\n`);
  return refusal !== null;
}

/**
 * The refusal itself, before any override is considered.
 * @param {string} command @param {{ cwd: string, fs: GitFs }} deps
 * @returns {string | null}
 */
function launchCheckRefusal(command, { cwd, fs }) {
  const top = launchCheckoutOf(cwd, fs);
  if (top === null) return null;
  const dotGit = join(top, ".git");
  if (!fs.isDirectory(dotGit)) return null;
  const config = join(dotGit, "config");
  const marked = fs.exists(config) && primaryMarkSet(fs.read(config));
  return `${command}: REFUSED -- launched from ${top}, which is not a linked worktree: its .git is a directory`
    + (marked ? `, and it carries ${PRIMARY_MARK_KEY}=true, the fleet-driving primary checkout` : "")
    + ". Policy scripts run from your own worktree, never the primary checkout or a plain clone (the 2026-09-11 "
    + "rule, #1352): what they write -- a board snapshot, an Acceptance run -- would land in a tree other sessions "
    + "share. Nothing was read or written. Run it from a worktree (`git worktree list` names them).";
}

/**
 * One `gh` invocation without `gh` itself: its arguments in, its stdout out. `board-snapshot.mjs` supplies a request
 * that runs `gh` with these arguments. A failure throws with the failed process's stdout on `.stdout`, as
 * `execFileSync` does, so GraphQL's own error is still read (#555).
 * @typedef {(args: string[]) => string} GhRequest
 */

/**
 * #1275: ONE ISSUE'S ITEM ON THIS PROJECT, AND THE PROJECT ITSELF, IN ONE REQUEST.
 *
 * `user.projectV2` is asked for although only its presence is read. CI's token cannot read the user-owned
 * Project (#546), and the close path classifies that refusal by GraphQL's own
 * `NOT_FOUND (user.projectV2): Could not resolve to a ProjectV2 with the number N` (`settle-closed-status.mjs`'s
 * `refusalCause`). Measured live 2026-09-13 with project 999: exit 1, `data.user.projectV2: null`, and exactly
 * that error, while `repository.issue` still answered. What a token that cannot see the Project gets back for
 * `projectItems` ALONE is not measured -- this host's token can read it -- so the Project is named in the request,
 * where its refusal is already classified, rather than inferred from an item list.
 *
 * `totalCount` is asked for so a list shorter than its own count refuses rather than reads as "not on the board".
 */
export const TOUCHED_ITEM_QUERY = `
  query($owner: String!, $name: String!, $project: Int!, $issue: Int!) {
    user(login: $owner) { projectV2(number: $project) { id } }
    repository(owner: $owner, name: $name) {
      issue(number: $issue) {
        number title state
        projectItems(first: 10) {
          totalCount
          nodes {
            id
            project { number }
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
      }
    }
  }
`;

/**
 * @typedef {{ itemId: string, number: number | null, title: string | null, status: string | null,
 *   state: string | null }} BoardItem
 *
 * #1219: `state` was NOT fetched until this row, and that is why the health check could never have
 * asked whether a CLOSED row advertises live work. It is not that the check was one-directional --
 * the field that would answer the other direction was never requested, so the question could not be
 * asked at all. A filter on a field nobody fetched, in the instrument watching for exactly this.
 */

/**
 * @typedef {{ type: string, message: string, path: string | null }} GraphqlError
 */

/**
 * Extracts GraphQL's own `errors` array from a parsed response, if present -- #555. `type`/`message`/
 * `path` are the three fields that distinguish FOUR different causes (no permission, wrong project id,
 * user-vs-org shape, a query the schema rejects) which otherwise all read as the identical, unactionable
 * "could not read Project N items" -- #546 sat three hours on exactly that sentence.
 *
 * Returns `null` for an absent, non-array, or empty `errors` field -- so a caller can `if (errors)` rather
 * than checking `.length` itself at every call site.
 *
 * @param {unknown} parsed
 * @returns {GraphqlError[] | null}
 */
export function graphqlErrors(parsed) {
  const errors = /** @type {any} */ (parsed)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((/** @type {any} */ e) => ({
    type: typeof e?.type === "string" ? e.type : "UNKNOWN",
    message: typeof e?.message === "string" ? e.message : JSON.stringify(e).slice(0, 200),
    path: Array.isArray(e?.path) ? e.path.join(".") : null,
  }));
}

/** One `type: message (path)` line per error, joined -- the string every refusal below actually prints. */
export function describeGraphqlErrors(/** @type {GraphqlError[]} */ errors) {
  return errors.map((e) => `${e.type}${e.path ? ` (${e.path})` : ""}: ${e.message}`).join("; ");
}

/**
 * `execFileSync` throws on a non-zero exit, but `gh api graphql` still writes the full response body --
 * `errors` included -- to stdout first, and Node's thrown error carries it verbatim on `.stdout` (a plain
 * string, since `board-snapshot.mjs`'s `defaultRun` passes `encoding: "utf8"`). Measured directly: a request naming a repository
 * that does not resolve exits 1 with `{"data":{...},"bad":null},"errors":[{"type":"NOT_FOUND",...}]}` on
 * `.stdout`. So a non-zero exit does not mean the API's own answer is lost -- only that nobody had read it
 * yet. Returns `null` (never throws) for anything that is not a parseable GraphQL error body, so the
 * caller can fall back to the plain exit failure honestly rather than inventing a cause.
 * @param {unknown} failure the thrown value from a failed `run()` call
 * @returns {string | null}
 */
export function graphqlErrorFromFailedRun(failure) {
  const stdout = /** @type {any} */ (failure)?.stdout;
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const errors = graphqlErrors(parsed);
  return errors ? describeGraphqlErrors(errors) : null;
}

/**
 * #1275: one touched issue's raw response, parsed, with GraphQL's own `errors` refused before `data` is trusted
 * -- a 200 can carry both (#555), and so can the non-zero exit's stdout.
 * @param {string} raw @param {number} issueNumber
 * @returns {unknown}
 */
function parseTouchedResponse(raw, issueNumber) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`board-snapshot: gh's response for #${issueNumber} was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const errors = graphqlErrors(parsed);
  if (errors) {
    throw new Error(`board-snapshot: could not read Project ${PROJECT_NUMBER}'s item for #${issueNumber} -- `
      + "GraphQL returned an error alongside its response, and a partial answer is not a snapshot. "
      + describeGraphqlErrors(errors));
  }
  return parsed;
}

/**
 * #1275: the `repository.issue` node of one touched issue's response, its `projectItems` complete. THROWS on
 * anything else, with `parsePage`'s discipline (#555): `errors` beside `data` is refused before `data` is
 * trusted, and the answer must be about the issue that was asked for.
 * @param {string} raw @param {number} issueNumber
 * @returns {any}
 */
function touchedIssue(raw, issueNumber) {
  const parsed = parseTouchedResponse(raw, issueNumber);
  const data = /** @type {any} */ (parsed)?.data;
  const issue = data?.repository?.issue;
  const itemsNode = issue?.projectItems;
  if (typeof data?.user?.projectV2?.id !== "string" || issue?.number !== issueNumber
    || !Array.isArray(itemsNode?.nodes) || typeof itemsNode.totalCount !== "number") {
    throw new Error(`board-snapshot: gh's response for #${issueNumber} did not have the shape `
      + "data.user.projectV2 + data.repository.issue.projectItems for that issue -- refusing to guess. "
      + `Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  if (itemsNode.nodes.length < itemsNode.totalCount) {
    throw new Error(`board-snapshot: #${issueNumber}'s project items came back ${itemsNode.nodes.length} of `
      + `${itemsNode.totalCount} -- refusing to read a partial list as "not on the board".`);
  }
  return issue;
}

/**
 * #1275: one touched issue's item on this Project, or `null` when the issue is not on it. `null` is a recorded
 * outcome, not a refusal: the mutation still runs, and `gh` names the row as not on the board, which
 * `moveProjectStatus` already reads as `notOnBoard`.
 * @param {string} raw @param {number} issueNumber
 * @returns {BoardItem | null}
 */
function parseTouchedItem(raw, issueNumber) {
  const issue = touchedIssue(raw, issueNumber);
  const node = issue.projectItems.nodes.find((/** @type {any} */ n) => n?.project?.number === PROJECT_NUMBER);
  if (node === undefined) return null;
  if (typeof node?.id !== "string") {
    throw new Error(`board-snapshot: #${issueNumber}'s item has no id -- refusing to guess. `
      + `Got: ${JSON.stringify(node).slice(0, 300)}`);
  }
  return {
    itemId: node.id,
    number: issue.number,
    title: typeof issue.title === "string" ? issue.title : null,
    status: typeof node.fieldValueByName?.name === "string" ? node.fieldValueByName.name : null,
    state: typeof issue.state === "string" ? issue.state : null,
  };
}

/**
 * A filesystem-safe stamp for a snapshot filename, derived from a real timestamp so two snapshots taken
 * seconds apart never collide and a reader can sort them by name.
 * @param {Date} date
 * @returns {string}
 */
export function snapshotStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Writes a snapshot, or THROWS the refusal every caller relies on: no snapshot on disk, no mutation (#399).
 * @param {string} path @param {object} snapshot
 * @param {{ writeFile: (path: string, data: string) => void, mkdir: (path: string) => void }} io
 */
export function persistSnapshot(path, snapshot, { writeFile, mkdir }) {
  try {
    mkdir(SNAPSHOT_DIR);
    writeFile(path, JSON.stringify(snapshot, null, 2));
  } catch (cause) {
    throw new Error(`board-snapshot: could not write the snapshot to ${path} -- refusing to proceed with `
      + `an unsnapshotted board mutation. ${/** @type {Error} */ (cause).message}`, { cause });
  }
}

/**
 * #1275: the SCOPED snapshots this process has taken, by the issue each one covers. Kept apart from
 * `processSnapshot` because a scoped file describes its own items and must never license a mutation of another.
 * #1360: each entry also carries the item's `status` as that read saw it, so a caller deciding whether a move is
 * needed reads the same snapshot the move then reuses.
 * @type {Map<number, { path: string, takenAt: Date, status: string | null }>}
 */
const scopedSnapshots = new Map();

/**
 * #1425: THE ONE READ FAILURE THAT ANSWERS EVERY LATER READ IN THIS PROCESS, or `null`. A read refused because the
 * token cannot read the Project (#546) is a fact about the token and the Project, not about the item or page asked
 * for, so asking again for the next item spends a request to learn the same thing. Measured on main before this: 7
 * rows settled against an unreadable Project made 7 requests on the scoped route, and 7 full-route mutations made 7.
 * ONLY THAT REFUSAL IS RECORDED. Any other failure, a transient exit or a bad answer about one item, is read again,
 * because it says nothing about the next read. Both routes share it: `board-snapshot.mjs` reads through
 * `readUnlessProjectUnreadable` too.
 * @type {Error | null}
 */
let projectUnreadable = null;

/**
 * #1425: RUN `read`, UNLESS THIS PROCESS HAS ALREADY BEEN REFUSED THE PROJECT. A recorded refusal throws without
 * calling `read`, and quotes the first refusal, so `settle-closed-status.mjs`'s `refusalCause` still classifies it as
 * project-unreadable -- the cause #546's DEGRADED bridge reads. The classification is that function's own anchor,
 * imported, never a second copy of it.
 * @template T
 * @param {() => T} read @param {string} subject what the read was for, in the refusal's words
 * @returns {T}
 */
export function readUnlessProjectUnreadable(read, subject) {
  if (projectUnreadable !== null) {
    throw new Error(`board-snapshot: not reading Project ${PROJECT_NUMBER} again for ${subject} -- an earlier read in `
      + "this process was refused because this token cannot read the Project, so no request was made (#1425). "
      + `The earlier refusal: ${projectUnreadable.message}`, { cause: projectUnreadable });
  }
  try {
    return read();
  } catch (error) {
    if (refusalCause(/** @type {Error} */ (error).message) === PROJECT_UNREADABLE) {
      projectUnreadable = /** @type {Error} */ (error);
    }
    throw error;
  }
}

/**
 * #1275: the arguments for one touched issue's read. The caller adds `gh`: this file never names it, because the
 * closure walk charges a `token` to any file that spawns `gh`, and this file must not carry one.
 * @param {number} issueNumber
 * @returns {string[]}
 */
export function touchedItemRequest(issueNumber) {
  return ["api", "graphql", "-f", `query=${TOUCHED_ITEM_QUERY}`, "-f", `owner=${PROJECT_OWNER}`,
    "-f", `name=${REPO.split("/")[1]}`, "-F", `project=${PROJECT_NUMBER}`, "-F", `issue=${issueNumber}`];
}

/**
 * #1275: THE ITEMS A MUTATION TOUCHES, ONE REQUEST EACH, AND NOTHING ELSE ON THE BOARD. No #747 floor here: that
 * floor exists because `fieldValues` is narrowed to a budget shared with the other items in a 100-item page, and a
 * single issue's `fieldValueByName` shares its request with nothing. A failed request THROWS, quoting GraphQL's own
 * error when the failed process printed one (#555).
 * @param {number[]} issueNumbers
 * @param {{ request: GhRequest }} deps
 * @returns {{ items: BoardItem[], notOnBoard: number[] }}
 */
export function readTouchedItems(issueNumbers, { request }) {
  /** @type {BoardItem[]} */
  const items = [];
  /** @type {number[]} */
  const notOnBoard = [];
  for (const issue of issueNumbers) {
    /** @type {string} */
    let raw;
    try {
      raw = request(touchedItemRequest(issue));
    } catch (cause) {
      const graphqlDetail = graphqlErrorFromFailedRun(cause);
      throw new Error(`board-snapshot: could not read Project ${PROJECT_NUMBER}'s item for #${issue} -- refusing `
        + `to mutate without a snapshot. ${graphqlDetail ?? /** @type {Error} */ (cause).message}`, { cause });
    }
    const item = parseTouchedItem(raw, issue);
    if (item) items.push(item);
    else notOnBoard.push(issue);
  }
  return { items, notOnBoard };
}

/**
 * #1275: the items `issueNumbers` name, written to `runs/board-snapshots/<stamp>-issue-<n>.json` -- the issue in the
 * name so two moves a millisecond apart never overwrite each other. THROWS if the read or the write fails, exactly as
 * the full snapshot does: the guarantee is #399's, scoped to the write it covers.
 * @param {number[]} issueNumbers
 * @param {{ request: GhRequest, maxAgeMs: number, writeFile?: (path: string, data: string) => void,
 *   mkdir?: (path: string) => void, now?: () => Date }} deps
 * @returns {string} the path written
 */
export function writeScopedSnapshot(issueNumbers, {
  request,
  maxAgeMs,
  writeFile = (path, data) => writeFileSync(path, data, "utf8"),
  mkdir = (path) => mkdirSync(path, { recursive: true }),
  now = () => new Date(),
}) {
  return snapshotTouched(issueNumbers, { request, maxAgeMs, writeFile, mkdir, now }).path;
}

/**
 * #1360: WRITE A SCOPED SNAPSHOT AND RETURN WHAT IT READ, so a caller that needs an item's Status takes it from the same
 * read the file records instead of reading the file back. `writeScopedSnapshot` is this, returning the path only.
 * @param {number[]} issueNumbers
 * @param {{ request: GhRequest, maxAgeMs: number, writeFile: (path: string, data: string) => void,
 *   mkdir: (path: string) => void, now: () => Date }} deps
 * @returns {{ path: string, items: BoardItem[] }}
 */
function snapshotTouched(issueNumbers, { request, maxAgeMs, writeFile, mkdir, now }) {
  const { items, notOnBoard } = readUnlessProjectUnreadable(() => readTouchedItems(issueNumbers, { request }),
    `#${issueNumbers.join(", #")}`);
  const takenAt = now();
  const path = `${SNAPSHOT_DIR}/${snapshotStamp(takenAt)}-issue-${issueNumbers.join("-")}.json`;
  persistSnapshot(path, {
    takenAt: takenAt.toISOString(),
    // SAYS WHAT IT IS, as #852's file does: a reader must not take a scoped file for the board.
    takenBefore: `the board mutation of #${issueNumbers.join(", #")} -- SCOPED to the item(s) that mutation `
      + "touches, not the whole board (#1275). A later mutation of the same item(s) in this process within "
      + `${maxAgeMs / 1000}s reuses it; a mutation of any other item takes its own`,
    scope: { issues: issueNumbers },
    project: { owner: PROJECT_OWNER, number: PROJECT_NUMBER },
    items,
    notOnBoard,
  }, { writeFile, mkdir });
  return { path, items };
}

/** @param {BoardItem[]} items @param {number} issue @returns {string | null} */
function statusIn(items, issue) {
  return items.find((item) => item.number === issue)?.status ?? null;
}

/**
 * #1275: the issues a mutation names in `touches`, or `null` when it names none. Anything else REFUSES: a mutation
 * cannot touch nothing, and a reuse check over no issues is vacuously "every one held" -- a mutation with no
 * snapshot behind it.
 * @param {unknown} touches
 * @returns {number[] | null}
 */
export function touchedIssues(touches) {
  if (touches === undefined) return null;
  const issues = [touches].flat();
  if (issues.length === 0 || !issues.every((issue) => Number.isInteger(issue))) {
    throw new Error("board-snapshot: `touches` must name the issue(s) this mutation changes, got "
      + `${JSON.stringify(touches)} -- refusing to guess what it touches. Nothing was mutated.`);
  }
  return /** @type {number[]} */ (issues);
}

/**
 * #1275: WHICH SNAPSHOT A MUTATION GETS -- the decision `withBoardSnapshot` follows, pure so the row's own acceptance
 * can hold it. A full snapshot this process still holds covers every item (#852's reuse). A mutation that names its
 * items gets just those. One that names none gets the full sweep, as every mutation did before this row.
 * @param {{ touchedIssues: number[] | null, fullSnapshotValid: boolean }} state
 * @returns {"reuse-full" | "scoped" | "full"}
 */
export function snapshotRoute({ touchedIssues: issues, fullSnapshotValid }) {
  if (fullSnapshotValid) return "reuse-full";
  return issues === null ? "full" : "scoped";
}

/**
 * #1275: THE SCOPED SNAPSHOT, THEN THE MUTATION. Reuses this process's snapshot of EVERY touched issue while each is
 * still valid, and otherwise reads and writes just those items. `stillValid` is the caller's, so the disk re-read and
 * the age bound are the ones #852 applies to the full snapshot -- here per item.
 * @template T
 * @param {() => T} mutate @param {number[]} issues
 * @param {{ request: GhRequest, log: (line: string) => void, at: Date, now: () => Date, maxAgeMs: number,
 *   stillValid: (snapshot: { path: string, takenAt: Date } | undefined) => boolean,
 *   writeFile?: (path: string, data: string) => void, mkdir?: (path: string) => void }} context
 * @returns {T}
 */
export function withScopedSnapshot(mutate, issues, { request, log, at, now, maxAgeMs, stillValid, writeFile, mkdir }) {
  const touched = /** @type {number[]} */ (touchedIssues(issues));
  const held = touched.map((issue) => scopedSnapshots.get(issue));
  if (held.every((snapshot) => stillValid(snapshot))) {
    const paths = [...new Set(held.map((snapshot) => /** @type {{ path: string }} */ (snapshot).path))];
    log(`board-snapshot: reusing ${paths.join(", ")} for #${touched.join(", #")}, taken before an earlier `
      + "mutation of the same item(s) in this process (#1275)");
    return mutate();
  }
  const { path, items } = snapshotTouched(touched, { request, maxAgeMs, writeFile: writeFile ?? defaultWriteFile,
    mkdir: mkdir ?? defaultMkdir, now });
  for (const issue of touched) scopedSnapshots.set(issue, { path, takenAt: at, status: statusIn(items, issue) });
  log(`board-snapshot: wrote ${path} before mutating #${touched.join(", #")} -- scoped to the item(s) this `
    + "mutation touches, not the whole board (#1275)");
  return mutate();
}

/**
 * #1360: THE STATUS A MOVE'S OWN SCOPED READ WOULD SEE, TAKEN ONE STEP EARLY -- `ceo`'s ruling on #1360.
 *
 * Since #1275 every Status move reads the one item it edits before it mutates (`withScopedSnapshot` above), so the
 * Status a caller needs to decide whether a move is needed is already being read. This takes that read first and
 * records it in the per-issue cache, and the move that follows reuses it inside the same bound. So a row already at
 * its target costs one request and no mutation, and a row that is not costs one request and one mutation: the same
 * as a move alone. A held entry is answered without a request.
 *
 * A failed read THROWS, exactly as the move's own read would, quoting GraphQL's error (#555), so the caller refuses
 * with that cause instead of letting the move read again.
 * @param {number} issue
 * @param {{ request: GhRequest, log: (line: string) => void, at: Date, now: () => Date, maxAgeMs: number,
 *   stillValid: (snapshot: { path: string, takenAt: Date } | undefined) => boolean,
 *   writeFile?: (path: string, data: string) => void, mkdir?: (path: string) => void }} context
 * @returns {string | null} the item's Status, or null when it is not on the board or has none set
 */
export function scopedStatusOf(issue, { request, log, at, now, maxAgeMs, stillValid, writeFile, mkdir }) {
  const held = scopedSnapshots.get(issue);
  if (held !== undefined && stillValid(held)) return held.status;
  const { path, items } = snapshotTouched([issue], { request, maxAgeMs, writeFile: writeFile ?? defaultWriteFile,
    mkdir: mkdir ?? defaultMkdir, now });
  const status = statusIn(items, issue);
  scopedSnapshots.set(issue, { path, takenAt: at, status });
  log(`board-snapshot: wrote ${path} to read #${issue}'s Status before moving it -- the move reuses it (#1360)`);
  return status;
}

/** @param {string} path @param {string} data */
function defaultWriteFile(path, data) { writeFileSync(path, data, "utf8"); }

/** @param {string} path */
function defaultMkdir(path) { mkdirSync(path, { recursive: true }); }

/**
 * FORGET THE SCOPED SNAPSHOTS. For tests, and `board-snapshot.mjs`'s `forgetProcessSnapshot` calls it: a scoped file
 * one case took must not become another case's silent precondition.
 */
export function forgetScopedSnapshots() {
  scopedSnapshots.clear();
  projectUnreadable = null; // #1425: a refusal one case recorded must not refuse another case's readable board
}
