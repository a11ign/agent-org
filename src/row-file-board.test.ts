// no-token: gh
//
// Imports `row-file.mjs`, which spawns `gh`; true of the IMPORT and false of the CALL. Every dependency
// below is injected (`run`, the board and label readers, `moveStatus`, `ensureLabels`, the lanes), so no
// test lets a real spawn happen -- the same arrangement as `packaging/row-file.test.ts`.
/**
 * #3330: `row-file --board=<n> --lane=<owner>` boards a row that ALREADY EXISTS (a11ign/a11ign#3328's sweep
 * of `regression` rows filed under `github.token`, which cannot resolve Project 1) and leaves a boarded
 * row alone.
 *
 * The fake row is a small state machine, so each assertion reads what the act WROTE rather than a
 * hand-written second fixture: `item-add` puts it on the board, `moveStatus` sets the Status, and
 * `gh issue edit --add-label` adds to the labels it already had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardArgvRefusal, boardFromArgv, boardRow, createIssue, fetchIssueBoardStatus, moveTrackerStatus, unverifiedFilingFields } from "./row-file.mjs";
import { PROJECT_NUMBER } from "./board-snapshot-scope.mjs";
import { CLAIM_LABEL } from "./claim-labels.mjs";

/** Region says the deliverable is not a commit, so the body passes the filing rule in any checkout. */
const CLAIMABLE_BODY = "## Region\n\nits deliverable is not a commit\n\n"
  + "## Acceptance\n\n```\nnode --import tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 3329 --json state\n```\n";
const NO_OPEN_CHECK = CLAIMABLE_BODY.replace(/## Open-check[\s\S]*$/, "");

const LANES = () => ({ lanes: [{ lane: "ceo", owner: "ceo", branchPrefixes: [], paths: [] }] }) as never;

function fakeRow(options: {
  labels?: string[];
  state?: "OPEN" | "CLOSED";
  body?: string;
  /** `null` is off the board; a string is the Status the row already carries. */
  status?: string | null;
  unreadableBoard?: boolean;
  statusMoveFails?: boolean;
} = {}) {
  const row = { labels: [...(options.labels ?? ["regression", "out-of-release"])],
    status: options.status === undefined ? null : options.status, onBoard: options.status != null,
    writes: [] as string[] };
  const deps = {
    run: (_cmd: string, args: string[]) => {
      if (args[0] === "project" && args[1] === "item-add") { row.writes.push("item-add"); row.onBoard = true; return ""; }
      if (args[0] === "issue" && args[1] === "edit") {
        row.writes.push("labels");
        row.labels.push(...args.flatMap((a, i) => (args[i - 1] === "--add-label" ? [a] : [])));
        return "";
      }
      if (args[0] === "api" && args.includes("PUT")) { row.writes.push("label-set"); return ""; }
      if (args.includes("body")) return options.body ?? CLAIMABLE_BODY;
      return "";
    },
    fetchBoardStatus: () => {
      if (options.unreadableBoard) throw new Error("HTTP 502");
      return row.onBoard ? row.status : null;
    },
    fetchLabels: () => ({ number: 3329, title: "a regression", state: options.state ?? "OPEN", labels: [...row.labels] }),
    moveStatus: (_n: number, status: string) => {
      if (options.statusMoveFails) return { moved: false as const, reason: "GraphQL 500" };
      row.writes.push(`status:${status}`);
      row.status = status;
      return { moved: true as const };
    },
    ensureLabels: () => {},
    loadLanesConfig: LANES,
  };
  return { row, deps };
}

/** Runs `boardRow` and returns its exit code with what it printed. */
function board(argv: string[], deps: ReturnType<typeof fakeRow>["deps"]) {
  let out = "";
  let err = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    return { code: boardRow(argv, deps as never), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("#3330 ACCEPTANCE 1: an existing row NOT on the board is boarded -- item-add, then Status Ready, then "
  + "`ready` and `lane:<owner>` ADDED to the labels it had, in that order, and the read-back confirms all three", () => {
  const { row, deps } = fakeRow();
  const r = board(["--board=3329", "--lane=ceo", "--session=worker-3328"], deps);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(row.writes, ["item-add", "status:Ready", "labels"],
    "the label goes on LAST (#844): `ready` before a Status trips #747's floor on the row itself");
  assert.deepEqual(row.labels, ["regression", "out-of-release", "ready", "lane:ceo"],
    "the labels it already carried are kept: an additive edit, never the full-set PUT");
  assert.equal(row.status, "Ready");
  assert.match(r.out, /#3329 boarded/);
});

for (const status of ["Backlog", "Ready", "In progress"]) {
  test(`#3330 ACCEPTANCE 2: a row already on the board in Status "${status}" is left alone -- no item-add, `
    + "no Status write, no label write, exit 0, and it says so", () => {
    const { row, deps } = fakeRow({ status, labels: ["regression", "in-progress"] });
    const r = board(["--board=3329", "--lane=any"], deps);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(row.writes, []);
    assert.equal(row.status, status);
    assert.deepEqual(row.labels, ["regression", "in-progress"]);
    assert.match(r.out, new RegExp(`already boarded .*Status "${status}"`));
  });
}

test("#3330 ACCEPTANCE 2: a CLAIMED row that is already on the board is left alone, not refused", () => {
  const { row, deps } = fakeRow({ status: "In progress", labels: [CLAIM_LABEL] });
  assert.equal(board(["--board=3329", "--lane=any"], deps).code, 0);
  assert.deepEqual(row.writes, []);
});

const REFUSED_ROWS: [string, NonNullable<Parameters<typeof fakeRow>[0]>][] = [
  ["a closed row", { state: "CLOSED" }],
  ["a claimed row", { labels: ["regression", CLAIM_LABEL] }],
  ["a body the claim side would refuse (no Open-check)", { body: NO_OPEN_CHECK }],
];
for (const [name, options] of REFUSED_ROWS) {
  test(`#3330 ACCEPTANCE 3: ${name} changes nothing and exits 1`, () => {
    const { row, deps } = fakeRow(options);
    const r = board(["--board=3329", "--lane=any"], deps);
    assert.equal(r.code, 1);
    assert.deepEqual(row.writes, []);
    assert.match(r.err, /refused by the same claimability rules as `--promote=`/);
  });
}

test("#3330 ACCEPTANCE 3: a board status that CANNOT BE READ refuses rather than boards", () => {
  const { row, deps } = fakeRow({ unreadableBoard: true });
  const r = board(["--board=3329", "--lane=any"], deps);
  assert.equal(r.code, 1);
  assert.deepEqual(row.writes, [], "absent and unreadable are different states");
  assert.match(r.err, /could not be read/);
});

test("#3330: a write that fails AFTER boarding began exits 2 and does not call a row somebody else filed 'FILED'", () => {
  const { deps } = fakeRow({ statusMoveFails: true });
  const r = board(["--board=3329", "--lane=any"], deps);
  assert.equal(r.code, 2);
  assert.match(r.err, /^row-file: Row #3329 \(filed by somebody else\) and added to Project/);
  assert.doesNotMatch(r.err, /FILED as/);
});

test("#3330: `--lane=` is required and must name a lane owner (or `any`); a typo is refused before ensureLabels can mint it", () => {
  for (const argv of [["--board=3329"], ["--board=3329", "--lane="], ["--board=3329", "--lane=typo"]]) {
    const { row, deps } = fakeRow();
    const r = board(argv, deps);
    assert.equal(r.code, 1, argv.join(" "));
    assert.deepEqual(row.writes, []);
  }
});

test("#3330: `--board=` takes no flag but --lane= and --session=, and a malformed number refuses -- never files", () => {
  assert.equal(boardArgvRefusal(["--board=1", "--lane=any", "--session=s"]), null);
  assert.match(boardArgvRefusal(["--board=1", "--lane=any", "--title", "x"]) ?? "", /2 other\(s\) were given: --title, x/);
  assert.equal(boardFromArgv(["--board=3329"]), 3329);
  for (const bad of ["--board=", "--board=abc", "--board=0", "--board=-3"]) {
    assert.equal(boardFromArgv([bad]), null, bad);
    const { row, deps } = fakeRow();
    assert.equal(board([bad, "--lane=any"], deps).code, 1);
    assert.deepEqual(row.writes, []);
  }
  const stray = board(["--board=3329", "--lane=any", "--label=ready"], fakeRow().deps);
  assert.equal(stray.code, 1);
  assert.match(stray.err, /FILES NOTHING/);
});

// --- fetchIssueBoardStatus pages (reviewer-agent-org-121's blocker on de971e06) ---

const node = (number: number, status = "Ready") => ({ project: { number }, fieldValueByName: { name: status } });
// Like GitHub, a LAST page still carries an `endCursor`; only `hasNextPage` says it is the last.
const pageOf = (nodes: unknown[], hasNextPage: boolean) => JSON.stringify({ data: { repository: { issue: {
  projectItems: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : "last" }, nodes } } } } });
const tenElsewhere = Array.from({ length: 10 }, (_, i) => node(100 + i, "Done"));

test("#3330 BLOCKER: Project 1 AFTER ten other project items is found on the next page, not read as off-board", () => {
  const afters: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    const query = args[args.length - 1];
    afters.push(/after: "([^"]+)"/.exec(query)?.[1] ?? "");
    return afters.length === 1 ? pageOf(tenElsewhere, true) : pageOf([node(1, "In progress")], false);
  };
  assert.equal(fetchIssueBoardStatus(3329, { run }), "In progress");
  assert.deepEqual(afters, ["", "c1"], "the second request carries the first page's cursor");
});

test("#3330 BLOCKER: boardRow leaves such a row alone -- no item-add, so no duplicate Project 1 item", () => {
  const { row, deps } = fakeRow();
  const pages = [pageOf(tenElsewhere, true), pageOf([node(1)], false)];
  const run = deps.run;
  const paged = { ...deps, fetchBoardStatus: fetchIssueBoardStatus, run: (cmd: string, args: string[]) =>
    (args[0] === "api" && args[1] === "graphql" ? pages.shift() ?? "" : run(cmd, args)) };
  const r = board(["--board=3329", "--lane=any"], paged as never);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(row.writes, []);
  assert.match(r.out, /already boarded/);
});

test("#3330: absent from EVERY page is null; a page that says there is more but gives no cursor throws", () => {
  const pages = [pageOf(tenElsewhere, true), pageOf([node(7)], false)];
  assert.equal(fetchIssueBoardStatus(3329, { run: () => pages.shift() ?? "" }), null);
  const noCursor = JSON.stringify({ data: { repository: { issue: { projectItems: {
    pageInfo: { hasNextPage: true, endCursor: null }, nodes: tenElsewhere } } } } });
  assert.throws(() => fetchIssueBoardStatus(3329, { run: () => noCursor }), /no cursor/);
});

// --- #4078: a row is filed in the tracker its Region names, and boarded on THAT tracker's board ---

const HOME_TRACKER = { key: "", repo: "a11ign/a11ign", board: { owner: "a11ign", number: 1 } };
const ORG_TRACKER = { key: "agent-org", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 7 } };
const DORA = [
  { repo: "a11ign/a11ign", release: { kind: "tag" as const }, releasablePaths: ["packages/cli/"] },
  { repo: "a11ign/agent-org", release: { kind: "tag" as const }, releasablePaths: ["src/"] },
];
const CODE = [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }];
const TWO_TRACKERS = { tracker: [HOME_TRACKER, ORG_TRACKER], code: CODE, dora: DORA };
const ONE_TRACKER = { tracker: [HOME_TRACKER], code: CODE, dora: DORA };

const rowBody = (region: string) => `## Region\n\n\`\`\`\n${region}\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnode --test src/x.test.mjs\n\`\`\`\n\n`
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const ORG_ROW = rowBody("agent-org:src/row-tracker.mjs");
const PRODUCT_ROW = rowBody("packages/cli/src/index.ts");
const OUT_OF_RELEASE_FLAGS = ["--label", "out-of-release"];
const CI_RESET = ["--milestone", "CI reset"];

/**
 * A fake GitHub that is a small state machine, so each assertion reads what the filing WROTE: `item-add` puts the issue on the board it
 * names, `item-edit` sets that board's Status, label creates and edits are recorded per repository, and the GraphQL read-back answers from
 * the boards the issue is really on. Every gh call lands in `calls`; `createIssue` is given the DEFAULT `moveStatus`, `ensureLabels`,
 * `fetchLabels` and `fetchBoardStatus`, so what runs is the code a real filing runs.
 */
function fakeGitHub(options: { itemAddLandsOn?: { owner: string; number: number } } = {}) {
  const gh = { calls: [] as string[][], spawned: [] as string[][], boards: new Map<string, { repo: string; status: string | null }>(),
    ensured: [] as string[], edits: [] as string[][], milestoneReads: [] as string[] };
  const boardKey = (owner: string, number: string | number) => `${owner}/${number}`;
  const repoOfUrl = (url: string) => /github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1] ?? "";
  const created = new Map<string, string[]>();
  const milestoneIn = new Map<string, string>();
  const labelsIn = (repo: string) => [...(created.get(repo) ?? []), ...gh.edits.filter((e) => e[e.indexOf("--repo") + 1] === repo)
    .flatMap((e) => e.flatMap((a, i) => (e[i - 1] === "--add-label" ? [a] : [])))];
  const run = (_cmd: string, args: string[]): string => {
    gh.calls.push(args);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    if (args[0] === "issue" && args[1] === "list") return "[]"; // #4294: the duplicate-title read -- no open row has the title
    if (args[0] === "project" && args[1] === "item-add") {
      const landed = options.itemAddLandsOn ?? { owner: flag("--owner"), number: Number(args[2]) };
      gh.boards.set(boardKey(landed.owner, landed.number), { repo: repoOfUrl(flag("--url")), status: null });
      return "";
    }
    if (args[0] === "project" && args[1] === "item-edit") {
      const board = gh.boards.get(boardKey(flag("--owner"), args[2]));
      if (board === undefined) throw new Error("is not an item in project");
      board.status = flag("--value");
      return "";
    }
    if (args[0] === "label" && args[1] === "create") { gh.ensured.push(`${flag("--repo")}:${args[2]}`); return ""; }
    if (args[0] === "issue" && args[1] === "edit") { gh.edits.push(args); return ""; }
    if (args[0] === "api" && args[1] === "graphql") return graphql(args[args.length - 1]);
    if (args[0] === "issue" && args[1] === "view" && args.includes("body")) return "## Region\n\nFiled-by: worker-4078\n";
    if (args[0] === "issue" && args[1] === "view" && args.includes("milestone")) return milestoneIn.get(flag("--repo")) ?? "";
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({ number: 900, title: "t", state: "OPEN", labels: labelsIn(flag("--repo")).map((name) => ({ name })) });
    }
    return "";
  };
  const graphql = (query: string) => {
    const repo = `${/owner: "([^"]+)"/.exec(query)?.[1]}/${/name: "([^"]+)"/.exec(query)?.[1]}`;
    const nodes = [...gh.boards.entries()].filter(([, board]) => board.repo === repo).map(([key, board]) => {
      const [owner, number] = key.split("/");
      return { project: { number: Number(number), owner: { login: owner } }, fieldValueByName: board.status === null ? null : { name: board.status } };
    });
    return JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
  };
  /** The home tracker's move is `moveProjectStatus`, whose board snapshot reads GitHub; another tracker's runs the REAL `moveTrackerStatus`. */
  const moveStatus = (n: number, status: string, options: { run: typeof run; tracker: typeof HOME_TRACKER }) => {
    if (options.tracker.board.number !== HOME_TRACKER.board.number) return moveTrackerStatus(n, status, options);
    const board = gh.boards.get(`${options.tracker.board.owner}/${options.tracker.board.number}`);
    if (board === undefined) return { moved: false as const, reason: "not on the board", notOnBoard: true };
    board.status = status;
    return { moved: true as const };
  };
  const deps = (extra: Record<string, unknown> = {}) => ({ run, moveStatus, spawnGh: (argv: string[]) => {
    gh.spawned.push(argv);
    const repo = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : HOME_TRACKER.repo;
    created.set(repo, argv.flatMap((a, i) => (argv[i - 1] === "--label" ? [a] : [])));
    milestoneIn.set(repo, argv[argv.indexOf("--milestone") + 1] ?? "");
    return `https://github.com/${repo}/issues/900`;
  }, loadLanesConfig: () => ({ lanes: [] }), ...extra,
    milestones: ({ repo }: { repo: string }) => { gh.milestoneReads.push(`repos/${repo}/milestones`); return ["CI reset"]; } });
  return { gh, deps, labelsIn };
}

/** `createIssue` with stdout and stderr captured. */
function fileRow(argv: string[], declaration: typeof TWO_TRACKERS | typeof ONE_TRACKER, github = fakeGitHub(), extra: Record<string, unknown> = {}) {
  let out = "";
  let err = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, { ...github.deps(extra), declaration } as never);
    return { code, out, err, ...github };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
const filing = (body: string, ...more: string[]) => ["--title", "a row", "--body", body, "--session=worker-4078", ...more];
const touched = (gh: ReturnType<typeof fakeGitHub>["gh"], verb: string) => gh.calls.filter((a) => a.slice(0, 2).join(" ") === verb);

test("#4078 ACCEPTANCE: an ORG row (a Region of only agent-org paths) is filed in the agent-org tracker -- `gh issue create`, the label writes and the "
  + "read-back all name a11ign/agent-org, and the URL printed is that repository's", () => {
  const r = fileRow(filing(ORG_ROW, ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.gh.spawned.length, 1);
  const argv = r.gh.spawned[0];
  assert.equal(argv[argv.indexOf("--repo") + 1], ORG_TRACKER.repo, "gh is told the repository, or it files where the checkout's remote points");
  assert.ok(!argv.some((a) => a.startsWith("--tracker")), "our own flag never reaches gh");
  assert.match(r.out, /^https:\/\/github\.com\/a11ign\/agent-org\/issues\/900\n$/);
  assert.deepEqual(r.gh.edits.map((e) => e[e.indexOf("--repo") + 1]), [ORG_TRACKER.repo]);
  const everyRepoNamed = r.gh.calls.flatMap((a) => (a.includes("--repo") ? [a[a.indexOf("--repo") + 1]] : []));
  assert.ok(everyRepoNamed.length > 0 && everyRepoNamed.every((repo) => repo === ORG_TRACKER.repo), `repositories named: ${everyRepoNamed}`);
});

test("#4078 ACCEPTANCE: a PRODUCT row (one entry under a product releasable path, the others agent-org's) is filed in the product tracker, "
  + "and gh is not told a repository -- the home tracker runs as it always did", () => {
  const r = fileRow(filing(rowBody("agent-org:src/row-file.mjs\npackages/cli/src/index.ts"), ...CI_RESET), TWO_TRACKERS);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.gh.spawned[0].includes("--repo"));
  assert.match(r.out, /a11ign\/a11ign\/issues\/900/);
  assert.deepEqual([...r.gh.boards.keys()], ["a11ign/1"]);
});

test("#4078 ACCEPTANCE: the row is added to THAT tracker's board -- `gh project item-add <number> --owner <owner>` from the tracker entry -- "
  + "and the Status move and the read-back use the same board, never the home one", () => {
  const r = fileRow(filing(ORG_ROW, ...OUT_OF_RELEASE_FLAGS, "--ready"), TWO_TRACKERS);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(touched(r.gh, "project item-add").map((a) => a.slice(2, 5)), [["7", "--owner", "a11ign"]]);
  assert.deepEqual(touched(r.gh, "project item-edit").map((a) => a[2]), ["7"]);
  assert.deepEqual([...r.gh.boards.entries()], [["a11ign/7", { repo: "a11ign/agent-org", status: "Ready" }]], "on board 7 only, in Ready");
});

test("#4078 ACCEPTANCE: a read-back of the OTHER board does not satisfy it -- an item-add that landed on board 1 leaves the filing UNCONFIRMED (exit 2)", () => {
  // The Status move is told it succeeded, so the read-back is the only thing standing between the filing and a false "filed and boarded".
  const r = fileRow(filing(ORG_ROW, ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS, fakeGitHub({ itemAddLandsOn: { owner: "a11ign", number: 1 } }),
    { moveStatus: () => ({ moved: true }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /missing: Project 7 membership/, "it names the board it asked, not the one the item is on");
});

test("#4078: the board is its owner AND its number -- another owner's Project 7 is not this tracker's", () => {
  const node = (login: string) => ({ project: { number: 7, owner: { login } }, fieldValueByName: { name: "Ready" } });
  const read = (login: string, tracker: typeof ORG_TRACKER) => fetchIssueBoardStatus(900, { tracker, run: () => JSON.stringify({ data: {
    repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(login)] } } } } }) });
  assert.equal(read("a11ign", ORG_TRACKER), "Ready");
  assert.equal(read("someone-else", ORG_TRACKER), null);
  assert.equal(read("a11ign", { ...ORG_TRACKER, board: { owner: "a11ign", number: 8 } }), null, "the same owner's other board");
});

test("#4078 ACCEPTANCE: the labels the filing writes (out-of-release, backlog/ready, lane:*) are ensured on the TARGET repository, and not on the first", () => {
  const r = fileRow(filing(ORG_ROW, ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.gh.ensured, ["a11ign/agent-org:out-of-release", "a11ign/agent-org:backlog", "a11ign/agent-org:lane:any"],
    "out-of-release first: `gh issue create` refuses a label its repository does not have");
  assert.deepEqual(r.labelsIn(ORG_TRACKER.repo), ["out-of-release", "backlog", "lane:any"]);
  assert.deepEqual(r.labelsIn(HOME_TRACKER.repo), []);
});

test("#4078 ACCEPTANCE (milestone: SKIPPED for an org row): `--label out-of-release` IS the release -- no milestone is read, none is passed to gh, "
  + "and none is expected back", () => {
  const r = fileRow(filing(ORG_ROW, ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.gh.milestoneReads, []);
  assert.ok(!r.gh.spawned[0].includes("--milestone"), "the home tracker would add `--milestone \"Out of release\"`, which agent-org does not have");
});

test("#4078 ACCEPTANCE (milestone: READ for a product row): a product row declaring no release reads the HOME repository's milestones for the refusal", () => {
  const r = fileRow(filing(PRODUCT_ROW), TWO_TRACKERS);
  assert.equal(r.code, 1);
  assert.deepEqual(r.gh.milestoneReads, ["repos/a11ign/a11ign/milestones"]);
  assert.deepEqual(r.gh.spawned, [], "refused before anything is filed");
});

test("#4078: an org row that declares no release is refused with the label-only message, reading nothing", () => {
  const r = fileRow(filing(ORG_ROW), TWO_TRACKERS);
  assert.equal(r.code, 1);
  assert.match(r.err, /a11ign\/agent-org has no release milestone: .*--label out-of-release/);
  assert.deepEqual([r.gh.milestoneReads, r.gh.spawned], [[], []]);
});

test("#4078 ACCEPTANCE: `--tracker=<key>` overrides the function, both ways, and the empty key names the home tracker", () => {
  const toOrg = fileRow(filing(PRODUCT_ROW, "--tracker=agent-org", ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(toOrg.code, 0, toOrg.err);
  assert.match(toOrg.out, /a11ign\/agent-org\/issues\/900/);
  assert.equal(toOrg.err.includes("could not be read"), false, "an explicit key has not read the Region and says nothing about it");
  const toHome = fileRow(filing(ORG_ROW, "--tracker=", ...CI_RESET), TWO_TRACKERS);
  assert.equal(toHome.code, 0, toHome.err);
  assert.match(toHome.out, /a11ign\/a11ign\/issues\/900/);
  assert.deepEqual([...toHome.gh.boards.keys()], ["a11ign/1"]);
});

test("#4078 ACCEPTANCE: an unknown `--tracker=` is refused, naming the declared keys, with NOTHING filed or written", () => {
  const r = fileRow(filing(ORG_ROW, "--tracker=typo", ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(r.code, 1);
  assert.match(r.err, /`--tracker=typo` names no declared tracker\. Declared keys: "" \(a11ign\/a11ign\), "agent-org" \(a11ign\/agent-org\)/);
  assert.deepEqual([r.gh.spawned, r.gh.calls], [[], []]);
});

test("#4078 ACCEPTANCE: a Region that could not be read goes to the org tracker AND says so in ONE line -- and says nothing with one tracker, where there was no choice", () => {
  const unreadable = "## Region\n\nits deliverable is not a commit\n\n## Acceptance\n\n```\nnode --test src/x.test.mjs\n```\n\n"
    + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
  const two = fileRow(filing(unreadable, ...OUT_OF_RELEASE_FLAGS), TWO_TRACKERS);
  assert.equal(two.code, 0, two.err);
  assert.match(two.out, /a11ign\/agent-org\/issues\/900/);
  const lines = two.err.split("\n").filter((line) => /Region could not be read/.test(line));
  assert.equal(lines.length, 1, two.err);
  assert.match(lines[0], /went to the org tracker, a11ign\/agent-org/);
  const one = fileRow(filing(unreadable, ...CI_RESET), ONE_TRACKER);
  assert.equal(one.code, 0, one.err);
  assert.equal(/Region could not be read/.test(one.err), false);
});

test("#4078 ACCEPTANCE: with ONE declared tracker every Region files exactly as before -- the home repository, board 1, no `--repo`, a milestone read", () => {
  for (const region of ["agent-org:src/row-tracker.mjs", "packages/cli/src/index.ts"]) {
    const r = fileRow(filing(rowBody(region), ...OUT_OF_RELEASE_FLAGS), ONE_TRACKER);
    assert.equal(r.code, 0, `${region}: ${r.err}`);
    assert.ok(!r.gh.spawned[0].includes("--repo"), region);
    assert.ok(r.gh.spawned[0].includes("--milestone"), `${region}: out-of-release still brings its milestone to the home tracker`);
    assert.deepEqual([...r.gh.boards.keys()], ["a11ign/1"], region);
    assert.deepEqual(r.gh.ensured, ["a11ign/a11ign:backlog", "a11ign/a11ign:lane:any"], region);
  }
});

test("#4078: `unverifiedFilingFields` names the board the filing asked, and the home board when none is said", () => {
  const after = { labels: ["backlog"], body: null, boardStatus: null };
  const expected = { session: null, label: "backlog", status: "Backlog", laneLabels: [] };
  assert.deepEqual(unverifiedFilingFields(after, { ...expected, projectNumber: 7 }), ["Project 7 membership"]);
  assert.deepEqual(unverifiedFilingFields(after, expected), [`Project ${PROJECT_NUMBER} membership`]);
});
