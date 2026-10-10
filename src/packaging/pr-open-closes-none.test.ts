// no-token: gh -- `main` here is handed `claimedRows`, `git`, `run`, `runAcceptance` and `prHead` as seams, so nothing reaches the real `gh`
/**
 * agent-org#744 (chairman, a11ign#4437, 2026-10-10): `pr:open` refuses `Closes: none` on a claimed row's own branch, in ANY declared tracker, before
 * anything is sent. Fifteen worker panes held a slot each, none working, after pull requests written `Closes: none -- <reason>` had merged: the
 * refusal CI makes read only the default tracker's rows, and ran only after the merge could no longer be told apart from the worker's own habit.
 *
 * Its own file, and not a block in `pr-open.test.ts`, for the reason `pr-open-region.test.ts` gives: that file's coverage is not refused by the
 * token-less acceptance job on this row's account.
 *
 * Every fact is injected: the claim records are written by the REAL writer (`claimRecordComment`), so a change to the record's format reaches this
 * test rather than a hand-copied string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, EXIT_NOTHING_SENT } from "../pr-open.ts";
import { claimRecordComment } from "../row-claim.ts";
import { REPO } from "../project-identity.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { lookupClaimedRowsOfTrackers, type ClaimedRow, type ClaimedRows } from "../closes-mismatch-check.ts";

const BRANCH = "agent/a-pull-request-that-agent-org-744";
const OTHER = homeProjectDeclaration().tracker.map((tracker) => tracker.repo).find((repo) => repo !== REPO) ?? "a11ign/agent-org";
const ACCEPTANCE_FILE = ".acceptance/agent~a-pull-request-that-agent-org-744.md";

const claim = (branch: string) => ({ body: claimRecordComment({ session: "worker-agent-org-744", branch, worktree: "../wt" }),
  createdAt: "2026-10-10T09:00:00Z", author: { login: "a11ign-ai-workers" } });
const rowOf = (repo: string, number: number, branch: string): ClaimedRow => ({ number, repo, comments: [claim(branch)], unreadable: false });

const NONE_BODY = "## Acceptance\n\nnode -e \"process.exit(0)\"\n\nCloses: none -- the live reading is a later step\nMutation: none -- these tests drive the claimed-row step\n";
const CLOSES_BODY = NONE_BODY.replace("Closes: none -- the live reading is a later step", `Closes ${OTHER}#744`);

interface Drive { code: number; sent: string[][]; acceptance: number; asked: string[]; out: string; err: string }

/** `main` with every seam injected; `trackers` maps a tracker's repository to its rows, or `null` for one that cannot be read. */
function drive(body: string, { trackers, branch = BRANCH, wired = true }: { trackers: Record<string, ClaimedRow[] | null>; branch?: string; wired?: boolean }): Drive {
  const sent: string[][] = [];
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let acceptance = 0;
  const claimedRows = (prRepo: string): ClaimedRows => {
    asked.push(prRepo);
    return lookupClaimedRowsOfTrackers(Object.keys(trackers), (repo) => trackers[repo]);
  };
  const code = main(["create", "--draft", "--body", body], {
    run: (args: string[]) => { if (!args.includes("--add-label")) sent.push(args); },
    git: (args: string[]) => {
      if (args[0] === "diff") return (args.includes("--diff-filter=A") ? [ACCEPTANCE_FILE] : ["src/pr-open.ts"]).join("\0");
      if (args[0] === "remote") return `git@github.com:${REPO}.git`;
      if (args.includes("--abbrev-ref")) return branch;
      if (args.includes("--short")) return "abc1234";
      return "deadbeef";
    },
    prHead: () => ({ ref: branch, oid: "deadbeef" }),
    runAcceptance: () => { acceptance += 1; return 0; },
    readFile: () => body,
    owner: () => "ceo",
    login: () => "a11ign-ai-workers",
    ...(wired ? { claimedRows } : {}),
    out: (line: string) => { out.push(line); },
    err: (line: string) => { err.push(line); },
  });
  return { code, sent, acceptance, asked, out: out.join(""), err: err.join("") };
}

const BOTH = { [REPO]: [] as ClaimedRow[], [OTHER]: [rowOf(OTHER, 744, BRANCH)] };

test("#744 positive control: `Closes: none` on a branch a claim of the OTHER tracker names is REFUSED at the command, and nothing is sent", () => {
  const r = drive(NONE_BODY, { trackers: BOTH });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, [], "nothing was sent to GitHub");
  assert.equal(r.acceptance, 0, "refused BEFORE the Acceptance ran");
  assert.ok(r.err.includes(`claimed branch of open row ${OTHER}#744`), r.err);
  assert.ok(r.err.includes(`declare \`Closes ${OTHER}#744\``), "the remedy names the row in full");
  assert.match(r.err, /file what remains \(a live reading, a decision, a later step\) as its own row/);
});

test("#744: the same branch declaring `Closes <row>` is not refused, and asks nothing", () => {
  const r = drive(CLOSES_BODY, { trackers: BOTH });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.asked, [], "a body that is not `none` costs no read");
});

test("#744 negative control: `Closes: none` on a branch no claim names is accepted with its `-- <reason>`: a PR that finishes no row is not stopped", () => {
  const r = drive(NONE_BODY, { trackers: BOTH, branch: "dependabot/pnpm/yaml-2.8.0" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.asked.length, 1, "the claim records were asked");
  assert.ok(r.sent.some((args) => args[1] === "create"), "and the pull request was sent");
});

test("#744: an unreadable tracker is `could not tell`, named and never `no claim` -- and a match in a readable one still refuses", () => {
  const unread = drive(NONE_BODY, { trackers: { [REPO]: [], [OTHER]: null }, branch: "agent/an-unrelated-change-9" });
  assert.equal(unread.code, 0, unread.err);
  assert.ok(unread.out.includes(`could not read the open claimed rows of ${OTHER}`), unread.out);
  assert.match(unread.out, /UNCHECKED/);
  const match = drive(NONE_BODY, { trackers: { [REPO]: [rowOf(REPO, 4770, BRANCH)], [OTHER]: null } });
  assert.equal(match.code, EXIT_NOTHING_SENT);
  assert.ok(match.err.includes("claimed branch of open row #4770") || match.err.includes(`${REPO}#4770`), match.err);
});

test("#744: with no `claimedRows` wired (every direct caller of `main`) the step is off and nothing is read", () => {
  const r = drive(NONE_BODY, { trackers: BOTH, wired: false });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.asked, []);
});
