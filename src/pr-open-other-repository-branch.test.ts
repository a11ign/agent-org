// no-token: gh -- `main` is handed `rowBody`, `git`, `run`, `runAcceptance` and `branchHead` as seams, so nothing reaches the real `gh`
/**
 * agent-org#753 (a11ign#4889): A ROW WHOSE REGION NAMES ANOTHER REPOSITORY OPENS ITS PULL REQUEST THERE. `worker-4889` pushed its branch to
 * a11ign/agent-org and `pr:open` refused it -- it read `refs/remotes/origin/<head>` in THIS tree, which is not that repository's remote, so the
 * answer was "unreadable -- push the branch first" whatever was pushed, and `ceo` opened the draft by hand. The branch is now read from the
 * repository the Region names (`branchHead`, `gh api repos/<repo>/branches/<branch>`) and compared with the commit the Acceptance ran on.
 *
 * POSITIVE: the repository holds the branch at the tested commit, and the create goes out aimed at it. NEGATIVE: it holds no such branch, or
 * holds another commit, or cannot be read -- each refuses before the Acceptance runs, naming the repository and the branch. CONTROLS: a Region
 * of the tree's own repository still reads `origin/<head>` and never asks GitHub, and so does a call with no `branchHead` wired.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { main, EXIT_NOTHING_SENT } from "./pr-open.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";

// The code host is the fake one (A11-160, step 9): what `pr-open` asks of it is a named operation of its rows, and a fake answers `fake-...` argument lists that name the step.
beforeEach(() => substituteCodeHost(createFakeCodeHost()));
afterEach(() => forgetActivation());

const TRACKER = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";
const CODE = [{ key: "", repo: TRACKER }, { key: "agent-org", repo: OTHER }, { key: "lab", repo: "a11ign/lab" }];
const BRANCH = "agent/wake-triage-digests-0-4889";
const LOCAL = "293de90a1111111111111111111111111111111111";
const ELSEWHERE = "5555555555555555555555555555555555555555";
const ACCEPTANCE_FILE = ".acceptance/agent~wake-triage-1.md";
const CHANGED = ["src/row-file.ts"];

const row = (paths: string[]) => `## Region\n\n\`\`\`\n${paths.join("\n")}\n\`\`\`\n\n## Acceptance\n\nx\n`;
const body = `## Acceptance\n\nnode -e "process.exit(0)"\n\nCloses: ${TRACKER}#4889\nMutation: none -- these tests drive the head check\n`;

/** A tree whose `origin` is the tracker and whose own `origin/<head>` was never fetched: unreadable, as in a11ign#4889. */
const gitFor = (origin = `https://github.com/${TRACKER}`, trackingRef: string | null = null) => (args: string[]) => {
  if (args[0] === "diff") return (args.includes("--diff-filter=A") ? [ACCEPTANCE_FILE] : CHANGED).join("\0");
  if (args[0] === "remote") return origin;
  if (args.includes("--abbrev-ref")) return BRANCH;
  if (args.includes("--short")) return "293de90a";
  if (args[0] === "rev-parse" && args[1] === `refs/remotes/origin/${BRANCH}`) {
    if (trackingRef === null) throw new Error("fatal: bad revision");
    return trackingRef;
  }
  return LOCAL;
};

interface Drive { code: number; sent: string[][]; acceptance: number; asked: [string, string][]; out: string; err: string }

function drive({ region, head = LOCAL, rest = [], wired = true, git = gitFor() }: {
  region: string[]; head?: string | null | Error; rest?: string[]; wired?: boolean; git?: (args: string[]) => string;
}): Drive {
  const sent: string[][] = [];
  const asked: [string, string][] = []; // the label step (`fake-label`) is not the create, so `sent` leaves it out
  const out: string[] = [];
  const err: string[] = [];
  let acceptance = 0;
  const argv = ["create", "--draft", "--head", BRANCH, ...rest, "--body", `${body}\nDraft-because: a test of the wrapper, not a review\n`];
  const code = main(argv, {
    run: (args: string[]) => { if (args[0] !== "fake-label") sent.push(args); },
    git,
    prHead: () => ({ ref: BRANCH, oid: LOCAL }),
    runAcceptance: () => { acceptance += 1; return 0; },
    readFile: () => body,
    rowBody: () => row(region),
    rootFiles: new Set<string>(),
    code: CODE,
    owner: () => "ceo",
    login: () => "a11ign-ai-workers",
    branchHead: wired ? (repo: string, branch: string) => {
      asked.push([repo, branch]);
      if (head instanceof Error) throw head;
      return head;
    } : undefined,
    out: (line: string) => { out.push(line); },
    err: (line: string) => { err.push(line); },
  });
  return { code, sent, acceptance, asked, out: out.join(""), err: err.join("") };
}

const OTHER_REGION = ["agent-org:src/row-file.ts"];

test("agent-org#753 positive: a Region naming another repository, which holds the branch at the tested commit, opens the PR THERE", () => {
  const r = drive({ region: OTHER_REGION });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.asked, [[OTHER, BRANCH]], "the branch was read from the Region's repository, once");
  assert.equal(r.acceptance, 1, "the Acceptance ran");
  assert.equal(r.sent.length, 1, "the create went out");
  assert.deepEqual(r.sent[0].slice(0, 2), ["fake-pull-write", "create"]);
  assert.equal(r.sent[0][r.sent[0].indexOf("--repo") + 1], OTHER, "aimed at the repository that holds the branch");
});

test("agent-org#753 positive: a bare path of a row that STATES the other repository is that repository's too", () => {
  const stated = `The repository is **\`${OTHER}\`**; paths are relative to its root.\n\n${row(["src/row-file.ts"])}`;
  const sent: string[][] = [];
  const asked: string[] = [];
  const code = main(["create", "--draft", "--head", BRANCH, "--body", `${body}\nDraft-because: a test of the wrapper, not a review\n`], {
    run: (args: string[]) => { if (args[0] !== "fake-label") sent.push(args); },
    git: gitFor(), prHead: () => null, runAcceptance: () => 0, readFile: () => body, rowBody: () => stated,
    rootFiles: new Set<string>(), code: CODE, owner: () => "ceo", login: () => "a11ign-ai-workers",
    branchHead: (repo: string) => { asked.push(repo); return LOCAL; }, out: () => {}, err: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, [OTHER]);
  assert.ok(sent[0].includes(OTHER));
});

test("agent-org#753 positive: an explicit `--repo` is not doubled, and still names the repository asked", () => {
  const r = drive({ region: OTHER_REGION, rest: ["--repo", OTHER] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.sent[0].filter((a) => a === "--repo").length, 1);
  assert.deepEqual(r.asked, [[OTHER, BRANCH]]);
});

test("agent-org#753 negative: a repository that holds NO such branch refuses, naming the repository and the branch -- nothing runs, nothing is sent", () => {
  const r = drive({ region: OTHER_REGION, head: null });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, []);
  assert.equal(r.acceptance, 0, "refused BEFORE the Acceptance ran");
  assert.ok(r.err.includes(OTHER) && r.err.includes(BRANCH), r.err);
  assert.match(r.err, /holds no branch/);
});

test("agent-org#753 negative: a repository that holds the branch at ANOTHER commit refuses, naming both commits", () => {
  const r = drive({ region: OTHER_REGION, head: ELSEWHERE });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, []);
  assert.equal(r.acceptance, 0);
  assert.ok(r.err.includes(LOCAL) && r.err.includes(ELSEWHERE) && r.err.includes(OTHER), r.err);
});

test("agent-org#753 negative: a read that FAILS is a refusal, never a match", () => {
  const r = drive({ region: OTHER_REGION, head: new Error("HTTP 502: Bad Gateway\nsecond line") });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, []);
  assert.equal(r.acceptance, 0);
  assert.match(r.err, /could not read branch/);
  assert.match(r.err, /HTTP 502/);
  assert.doesNotMatch(r.err, /second line/);
});

test("agent-org#753 control: a Region of the TREE's own repository reads `origin/<head>` and never asks GitHub", () => {
  const unreadable = drive({ region: ["src/row-file.ts"] });
  assert.equal(unreadable.code, EXIT_NOTHING_SENT);
  assert.deepEqual(unreadable.asked, []);
  assert.match(unreadable.err, /unreadable -- push the branch first/);
  const fetched = drive({ region: ["src/row-file.ts"], git: gitFor(undefined, LOCAL) });
  assert.equal(fetched.code, 0, fetched.err);
  assert.deepEqual(fetched.asked, []);
  assert.equal(fetched.sent[0].includes("--repo"), false, "no repository is added to a tree's own pull request");
});

test("agent-org#753 control: a tree whose `origin` IS the Region's repository reads its own `origin/<head>`, as before", () => {
  // `--repo` is still the caller's to say (#3149), so the tree is read as that repository's; the head is the tree's own either way.
  const r = drive({ region: OTHER_REGION, rest: ["--repo", OTHER], git: gitFor(`git@github.com:${OTHER}.git`, LOCAL) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.asked, []);
  const stale = drive({ region: OTHER_REGION, rest: ["--repo", OTHER], git: gitFor(`git@github.com:${OTHER}.git`) });
  assert.equal(stale.code, EXIT_NOTHING_SENT);
  assert.match(stale.err, /unreadable -- push the branch first/);
});

test("agent-org#753 control: a Region spread over two repositories names none, so the tree's own head is read", () => {
  const r = drive({ region: [...OTHER_REGION, "src/x.ts"] });
  assert.deepEqual(r.asked, []);
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.match(r.err, /unreadable -- push the branch first/);
});

test("agent-org#753 control: with no `branchHead` wired (every direct caller of `main`) the tree's own head is read, as before", () => {
  const r = drive({ region: OTHER_REGION, wired: false });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.match(r.err, /unreadable -- push the branch first/);
});
