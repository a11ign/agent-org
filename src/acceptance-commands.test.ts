// no-token: gh -- the reader and the report list are pure over (body, diff, readFile); the one spawn below runs `main()` in an empty temp directory with a body that runs nothing, so nothing reaches `gh`
/**
 * agent-org#666: THE ACCEPTANCE READER IS HANDED THE PULL REQUEST'S AUTHOR; agent-org#519: AND ONLY THE FILE-LESS CASE READS IT.
 *
 * agent-org#666 carried the value through (`PR_AUTHOR` -> `main()` -> `BodyReportInput.author` -> `resolveAcceptanceSource`) and changed no
 * verdict; agent-org#519 removed the body fallback and keyed its one exemption on it (a11ign#4811), so what is pinned is each beside its control:
 *   (a) an unset or empty `PR_AUTHOR` is `undefined` and a set one is itself, read from the environment alone;
 *   (b) the author decides the source ONLY when no file is added (the body for Dependabot, a refusal for anyone else): an added file still wins
 *       and two are still a duplicate whoever wrote them;
 *   (c) the author REACHES the reader at every link, seen through the `resolveSource` seam, so (b) cannot be passing for another reason.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptanceSourceOf, acceptanceSourceOfThisPullRequest, ciInputOf, prAuthorFromEnv, runCiBodyReports, thisPullRequestInput } from "./acceptance-commands/unmet-command-closure-requirements.ts";
import { checkoutPullRequestMerge, installPullRequestCheckout, orgSideAcceptanceEligibility, orgSideAcceptanceVerdict, OUTSIDE_ACCEPTANCE_FLAG, outsideAcceptanceOn, shadowAcceptanceVerdict } from "./acceptance-commands.ts";
import { INSIDE, reviewTrustOf } from "./review-trust.ts";
import { acceptanceGateOf, greenUnarmedOrders } from "./work-gate/pr-orders/red-only-by-superseded-run.ts";
import { ACCEPTANCE_GATE_SWITCH_ENV, gateUnarmedOnAcceptance } from "./work-gate/tick/blocker-cleared-reading.ts";
import { resolveAcceptanceSource } from "./acceptance-file.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

const FILE = ".acceptance/agent~example-666.md";
const OTHER = ".acceptance/agent~example-667.md";
const FILE_TEXT = "## Acceptance\n\n```bash\nnode -e \"process.exit(0)\"\n```\n";
const BODY = "Acceptance: none — the body's own\n\nCloses: none — a test body\n";
const read = (path: string) => (path === FILE ? FILE_TEXT : "");
/** `undefined` is the control: no author is what every caller passed before this row. */
const AUTHORS: (string | undefined)[] = [undefined, "", "dependabot[bot]", "a-person"];

test("(a) PR_AUTHOR: unset and empty are `undefined`, a set one is itself, and nothing else in the environment is read as the author", () => {
  assert.equal(prAuthorFromEnv({}), undefined, "unset");
  assert.equal(prAuthorFromEnv({ PR_AUTHOR: "" }), undefined, "empty is not an author named the empty string");
  assert.equal(prAuthorFromEnv({ PR_AUTHOR: "dependabot[bot]" }), "dependabot[bot]", "POSITIVE CONTROL: a set value comes through whole");
  assert.equal(prAuthorFromEnv({ PR_BODY: "Author: dependabot[bot]", GITHUB_ACTOR: "dependabot[bot]", GITHUB_HEAD_REF: "dependabot/npm/x" }), undefined,
    "the body, the actor and the branch name are the author's to write and are never the author");
});

/** An author the reader exempts from the file rule, and the ones it does not: a person, none given, and an empty one. */
const BOT = "dependabot[bot]";
const NOT_EXEMPT: (string | undefined)[] = [undefined, "", "a-person"];

test("(b) resolveAcceptanceSource: an added file and a duplicate are the same for every author; no file is the body for Dependabot and a refusal for anyone else", () => {
  const authorFree: [string, Parameters<typeof resolveAcceptanceSource>[0]][] = [
    ["one added file wins over the body", { body: BODY, added: ["src/x.ts", FILE], read }],
    ["two added files are a duplicate", { body: BODY, added: [OTHER, FILE], read }],
  ];
  for (const [name, input] of authorFree) {
    const without = resolveAcceptanceSource(input);
    for (const author of AUTHORS) assert.deepEqual(resolveAcceptanceSource({ ...input, author }), without, `${name}: author ${JSON.stringify(author)}`);
  }
  const noFile: [string, Parameters<typeof resolveAcceptanceSource>[0], "no-file" | "diff-unreadable"][] = [
    ["no added file", { body: BODY, added: ["src/x.ts"], read }, "no-file"],
    ["an unreadable diff", { body: BODY, added: undefined, read }, "diff-unreadable"],
  ];
  for (const [name, input, why] of noFile) {
    for (const author of NOT_EXEMPT) assert.deepEqual(resolveAcceptanceSource({ ...input, author }), { kind: "refused", why, author }, `${name}: author ${JSON.stringify(author)}`);
    assert.deepEqual(resolveAcceptanceSource({ ...input, author: BOT }), { kind: "body", text: BODY, why, author: BOT }, `${name}: Dependabot`);
  }
  // The controls that make "the same" mean something: the four outcomes really are four.
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE], read, author: BOT }), { kind: "file", path: FILE, text: FILE_TEXT });
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE, OTHER], read, author: BOT }), { kind: "duplicate", paths: [FILE, OTHER] });
});

test("(b) acceptanceSourceOf: `BodyReportInput.author` reaches the reader and decides the file-less source only", () => {
  const added = { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] };
  const none = { ok: true as const, files: ["src/x.ts"], added: ["src/x.ts"] };
  const unreadable = { ok: false as const, why: "no base" };
  for (const author of AUTHORS) {
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: added, readFile: read, author }), { kind: "file", path: FILE, text: FILE_TEXT }, `file wins: ${author}`);
  }
  for (const author of NOT_EXEMPT) {
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: none, readFile: read, author }), { kind: "refused", why: "no-file", author }, `no file: ${author}`);
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: unreadable, readFile: read, author }), { kind: "refused", why: "diff-unreadable", author }, `unreadable: ${author}`);
  }
  assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: none, readFile: read, author: BOT }), { kind: "body", text: BODY, why: "no-file", author: BOT });
  assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: unreadable, readFile: read, author: BOT }), { kind: "body", text: BODY, why: "diff-unreadable", author: BOT });
});

test("(b) runCiBodyReports: the whole report is byte-for-byte the same with an author as without one", () => {
  const input = { body: BODY, run: () => 0, diff: { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] }, readFile: read };
  const without = runCiBodyReports(input);
  assert.ok(without.lines.some((line) => line.includes(FILE)), "CONTROL: the report names the added file, so it read the file and not the body");
  for (const author of AUTHORS) assert.deepEqual(runCiBodyReports({ ...input, author }), without, `author ${JSON.stringify(author)}`);
});

test("(b) acceptanceSourceOfThisPullRequest takes the author as its third argument: a directory with no pull request is refused without it and read for Dependabot", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-"));
  try {
    for (const author of NOT_EXEMPT) {
      const source = acceptanceSourceOfThisPullRequest(BODY, dir, author);
      assert.equal(source.kind, "refused", `author ${JSON.stringify(author)}: a directory that is no checkout has no added file, and the body is not a source`);
    }
    assert.equal(acceptanceSourceOfThisPullRequest(BODY, dir, BOT).kind, "body", "CONTROL: the same directory, the exempt author");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(b) the CLI entry: PR_AUTHOR unset or empty is refused and exits 1; dependabot[bot] is read and passes; a person naming it in the body is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-cli-"));
  try {
    delete process.env.PR_AUTHOR; // the unset case is unset, whatever this run's own environment holds
    const job = (env: Record<string, string>, body: string = BODY) => spawnSync("node", [new URL("./acceptance-commands.ts", import.meta.url).pathname],
      { cwd: dir, encoding: "utf8", env: sandboxGitEnv({ PR_BODY: body, ...env }) });
    for (const env of [{}, { PR_AUTHOR: "" }, { PR_AUTHOR: "a-person" }] as Record<string, string>[]) {
      const refused = job(env);
      assert.match(refused.stdout, /ACCEPTANCE-SOURCE: none \(/, `${JSON.stringify(env)}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stdout, /ACCEPTANCE: MISSING/);
      assert.notEqual(refused.status, 0, `${JSON.stringify(env)}: a refused source is a red job`);
    }
    const read = job({ PR_AUTHOR: BOT });
    assert.match(read.stdout, /ACCEPTANCE-SOURCE: body \(exempt author dependabot\[bot\]/, read.stdout + read.stderr);
    assert.doesNotMatch(read.stdout, /ACCEPTANCE: MISSING/);
    assert.equal(read.status, 0, `CONTROL: the exempt author's body runs and passes: ${read.stdout}${read.stderr}`);
    // The author is the environment's, never the body's: the body names the bot and its author is someone else.
    const forged = job({ PR_AUTHOR: "a-person" }, `Author: ${BOT}\n${BODY}`);
    assert.match(forged.stdout, /ACCEPTANCE-SOURCE: none \(/, forged.stdout);
    assert.notEqual(forged.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A reader that answers as the real one does and records the input it was handed. */
const spyReader = () => {
  const seen: Parameters<typeof resolveAcceptanceSource>[0][] = [];
  const resolveSource: typeof resolveAcceptanceSource = (input) => { seen.push(input); return resolveAcceptanceSource(input); };
  return { seen, resolveSource };
};
const NO_FILE = { ok: true as const, files: ["src/x.ts"], added: ["src/x.ts"] };

test("(c) acceptanceSourceOf hands the reader the author it was given, and `undefined` when it was given none", () => {
  const given = spyReader();
  acceptanceSourceOf({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, author: "dependabot[bot]", resolveSource: given.resolveSource });
  assert.deepEqual(given.seen.map((input) => input.author), ["dependabot[bot]"]);
  const none = spyReader();
  acceptanceSourceOf({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, resolveSource: none.resolveSource });
  assert.equal(none.seen.length, 1, "CONTROL: the reader was called, so `undefined` below is what it was handed and not a call that never happened");
  assert.equal(none.seen[0].author, undefined);
});

test("(c) runCiBodyReports reads the source once and the reader is handed the author", () => {
  const spy = spyReader();
  runCiBodyReports({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, author: "a-person", resolveSource: spy.resolveSource });
  assert.ok(spy.seen.length >= 1, "the reader ran");
  assert.ok(spy.seen.every((input) => input.author === "a-person"), JSON.stringify(spy.seen.map((input) => input.author)));
});

test("(c) acceptanceSourceOfThisPullRequest and the CLI's own input carry the author: from the third argument, from PR_AUTHOR alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-input-"));
  try {
    const viaArgument = spyReader();
    acceptanceSourceOfThisPullRequest(BODY, dir, "dependabot[bot]", { resolveSource: viaArgument.resolveSource });
    assert.deepEqual(viaArgument.seen.map((input) => input.author), ["dependabot[bot]"]);
    assert.equal(thisPullRequestInput(BODY, dir, "a-person").author, "a-person");

    const fromEnv = ciInputOf({ PR_BODY: BODY, PR_AUTHOR: "dependabot[bot]" }, dir);
    assert.equal(fromEnv.author, "dependabot[bot]");
    assert.equal(fromEnv.body, BODY, "CONTROL: it is the CLI's input, with the body from PR_BODY");
    assert.equal(ciInputOf({ PR_BODY: BODY }, dir).author, undefined, "unset reaches the reader as undefined");
    assert.equal(ciInputOf({ PR_BODY: BODY, PR_AUTHOR: "" }, dir).author, undefined, "empty reaches the reader as undefined, not as \"\"");
    assert.equal(ciInputOf({ PR_BODY: `Author: dependabot[bot]\n${BODY}`, GITHUB_ACTOR: "dependabot[bot]" }, dir).author, undefined, "never the body or the actor");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- agent-org#1502: THE ORG SIDE RUNS AN AGENT PULL REQUEST'S ACCEPTANCE, SAME-REPOSITORY AGENT BRANCHES ONLY, AND ITS VERDICT GATES ARMING ---------------------
//
// WHERE: the host gate, in a checkout of the pull request's merge ref. WHO: not from a fork (GitHub's own flag), head repository the base, branch `agent/*`, author a
// declared identity. Every test below that says "executes nothing" is the same assertion: the `checkout` seam, the only thing that puts the pull request's files on the
// host, and the `report` seam, the only thing that runs its text, were never called.

const BASE = "a11ign/a11ign";
const HEAD = "1111111111111111111111111111111111111111";
const DECLARED = { exact: ["a11ign-worker[bot]"], pattern: [] as RegExp[] };
/** `review-trust.ts`'s decision with a fixed declaration: the one the gate injects. */
const byDeclaredIdentity = (pr: any) => reviewTrustOf(pr, DECLARED) === INSIDE;
const agentPr = (over: Record<string, unknown> = {}) => ({ number: 7, headRefName: "agent/some-row-1502", headRefOid: HEAD, isCrossRepository: false, body: BODY,
  headRepository: { name: "a11ign" }, author: { login: "a11ign-worker[bot]" }, ...over });
const guardedSeams = () => {
  const calls = { checkout: 0, report: 0, release: 0 };
  return { calls, seams: {
    byDeclaredIdentity, baseRepo: BASE,
    checkout: () => { calls.checkout++; return "/nonexistent-checkout"; },
    report: () => { calls.report++; return { ok: true, lines: ["ACCEPTANCE: RAN"] }; },
    release: () => { calls.release++; },
  } };
};

/** Each row breaks exactly ONE rule of an otherwise eligible pull request, so a refusal can only be that rule's. */
const INELIGIBLE: [string, Record<string, unknown>, RegExp][] = [
  ["a fork", { isCrossRepository: true, headRepository: { name: "someone-else" } }, /from a fork/],
  ["a fork's flag that GitHub did not return", { isCrossRepository: undefined }, /did not say whether/],
  ["a fork's flag as the string \"false\"", { isCrossRepository: "false" }, /did not say whether/],
  ["a head repository that is not the base, whatever the flag says", { headRepository: { nameWithOwner: "someone-else/a11ign" } }, /head repository/],
  ["a branch that is not agent/*", { headRefName: "feature/x" }, /not `agent\/\*`/],
  ["a branch that only CONTAINS agent/", { headRefName: "fork/agent/x" }, /not `agent\/\*`/],
  ["an unreadable branch", { headRefName: undefined }, /not `agent\/\*`/],
  ["an author the host does not declare", { author: { login: "a-stranger" } }, /not an identity the host declares/],
  ["no author", { author: null }, /not an identity the host declares/],
];

test("(1502 a) eligibility: an agent branch of this repository by a declared identity is eligible; each rule broken alone makes it not, and says which", () => {
  assert.deepEqual(orgSideAcceptanceEligibility(agentPr(), { byDeclaredIdentity, baseRepo: BASE }), { eligible: true }, "POSITIVE CONTROL");
  assert.deepEqual(orgSideAcceptanceEligibility(agentPr({ headRepository: { nameWithOwner: BASE } }), { byDeclaredIdentity, baseRepo: BASE }), { eligible: true }, "CONTROL: the full name of the base");
  for (const [name, over, why] of INELIGIBLE) {
    const answer = orgSideAcceptanceEligibility(agentPr(over), { byDeclaredIdentity, baseRepo: BASE });
    assert.equal(answer.eligible, false, name);
    assert.match((answer as { reason: string; }).reason, why, name);
  }
  assert.equal(orgSideAcceptanceEligibility(null, { byDeclaredIdentity, baseRepo: BASE }).eligible, false, "no pull request read");
});

test("(1502 b) an ineligible pull request has NOTHING executed: no checkout, no report, no release, and the verdict is not-run", () => {
  for (const [name, over] of INELIGIBLE) {
    const { calls, seams } = guardedSeams();
    const verdict = orgSideAcceptanceVerdict(agentPr(over), seams);
    assert.equal(verdict.kind, "not-run", name);
    assert.deepEqual(calls, { checkout: 0, report: 0, release: 0 }, `${name}: nothing touched the pull request's files or ran its text`);
  }
  const { calls, seams } = guardedSeams();
  assert.equal(orgSideAcceptanceVerdict(agentPr(), seams).kind, "pass", "CONTROL: the same seams DO run for an eligible pull request, so the zeros above are the gate's");
  assert.deepEqual(calls, { checkout: 1, report: 1, release: 1 });
});

test("(1502 c) the verdict is the command's own, at the head named, and every unreadable state is not-run and never pass", () => {
  const seams = (ok: boolean) => ({ ...guardedSeams().seams, report: () => ({ ok, lines: ["ACCEPTANCE: RAN node --test x", "ACCEPTANCE: FAIL exit 1"] }) });
  const pass = orgSideAcceptanceVerdict(agentPr(), seams(true));
  assert.deepEqual([pass.kind, pass.head], ["pass", HEAD]);
  const fail = orgSideAcceptanceVerdict(agentPr(), seams(false));
  assert.deepEqual([fail.kind, fail.head], ["fail", HEAD]);
  assert.deepEqual(fail.lines, ["ACCEPTANCE: RAN node --test x", "ACCEPTANCE: FAIL exit 1"]);
  const throws = { ...guardedSeams().seams, checkout: () => { throw new Error("the merge ref's head is 2222, not 1111\nsecond line"); } };
  const noCheckout = orgSideAcceptanceVerdict(agentPr(), throws);
  assert.equal(noCheckout.kind, "not-run");
  assert.match(noCheckout.why, /no checkout at 11111111 \(the merge ref's head is 2222/);
  assert.doesNotMatch(noCheckout.why, /second line/);
  for (const over of [{ headRefOid: undefined }, { headRefOid: "" }, { number: "x" }, { body: undefined }]) {
    const { calls, seams: s } = guardedSeams();
    assert.equal(orgSideAcceptanceVerdict(agentPr(over), s).kind, "not-run", JSON.stringify(over));
    assert.equal(calls.report, 0, `${JSON.stringify(over)}: nothing ran`);
  }
});

test("(1502 c2) a report that throws still releases the checkout", () => {
  const { calls, seams } = guardedSeams();
  assert.throws(() => orgSideAcceptanceVerdict(agentPr(), { ...seams, report: () => { throw new Error("boom"); } }), /boom/);
  assert.equal(calls.release, 1, "the worktree is removed whatever the command did");
});

test("(1502 c3) a checkout that cannot be prepared is not-run and never fail, runs nothing, and is still released; prepare runs before the report", () => {
  const order: string[] = [];
  const { calls, seams } = guardedSeams();
  const ok = orgSideAcceptanceVerdict(agentPr(), { ...seams, prepare: () => { order.push("prepare"); }, report: () => { order.push("report"); return { ok: true, lines: [] }; } });
  assert.equal(ok.kind, "pass");
  assert.deepEqual(order, ["prepare", "report"], "POSITIVE CONTROL: the install comes first");
  const reports = { n: 0 };
  const broken = orgSideAcceptanceVerdict(agentPr(), { ...seams, prepare: () => { throw new Error("ERR_PNPM_NO_OFFLINE_TARBALL x\nmore"); }, report: () => { reports.n++; return { ok: true, lines: [] }; } });
  assert.equal(broken.kind, "not-run");
  assert.match(broken.why, /could not be prepared \(ERR_PNPM_NO_OFFLINE_TARBALL x\)/);
  assert.equal(reports.n, 0, "nothing ran in an unprepared checkout");
  assert.equal(calls.release, 2, "both checkouts were released, the unprepared one included");
});

test("(1502 c4) installPullRequestCheckout installs only where the checkout has a lockfile", () => {
  const ran: string[] = [];
  installPullRequestCheckout({ run: (cwd) => { ran.push(cwd); }, exists: (path) => path === "/w/pnpm-lock.yaml" })("/w");
  installPullRequestCheckout({ run: (cwd) => { ran.push(cwd); }, exists: () => false })("/x");
  assert.deepEqual(ran, ["/w"]);
});

test("(1502 d) checkoutPullRequestMerge refuses a stale merge ref: its second parent must be the head the gate asked about", () => {
  const log: string[] = [];
  const git = (merged: string, second: string) => (args: string[]) => {
    log.push(args.join(" "));
    if (args[0] === "rev-parse") return `${merged}\n`;
    if (args[0] === "rev-list") return `${merged} basebase ${second}\n`;
    return "";
  };
  const fresh = checkoutPullRequestMerge({ repoRoot: "/r", scratch: "/s", git: git("mmmm", HEAD) });
  assert.equal(fresh(HEAD, 7), `/s/pr-7-${HEAD.slice(0, 12)}`, "POSITIVE CONTROL");
  assert.ok(log.some((line) => line.startsWith("worktree add --detach")), log.join("\n"));
  log.length = 0;
  const stale = checkoutPullRequestMerge({ repoRoot: "/r", scratch: "/s", git: git("mmmm", "2222222222222222222222222222222222222222") });
  assert.throws(() => stale(HEAD, 7), /not 11111111/);
  assert.ok(!log.some((line) => line.startsWith("worktree add")), "a stale merge ref adds no worktree");
});

/** A real repository: `main`, then a branch adding `.acceptance/<name>.md`, then their `--no-ff` merge (what `refs/pull/N/merge` is). Returns the dir and the marker the command writes. */
function mergeFixture(): { dir: string; marker: string; head: string; } {
  const dir = mkdtempSync(join(tmpdir(), "org-side-acceptance-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, encoding: "utf8", env: sandboxGitEnv() }).trim();
  const marker = join(dir, "COMMAND-RAN");
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "agent/some-row-1502");
  mkdirSync(join(dir, ".acceptance"));
  writeFileSync(join(dir, ".acceptance", "agent~some-row-1502.md"), `## Acceptance\n\n\`\`\`bash\nnode -e "require('node:fs').writeFileSync('COMMAND-RAN', 'ran')"\n\`\`\`\n`);
  git("add", "."); git("commit", "-q", "-m", "work");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge", "agent/some-row-1502");
  return { dir, marker, head };
}

test("(1502 e) END TO END, a real process: an agent pull request's command RUNS in the checkout, and the same pull request from a fork executes nothing", () => {
  const { dir, marker, head } = mergeFixture();
  try {
    const checkout = () => dir;
    const eligible = orgSideAcceptanceVerdict(agentPr({ headRefOid: head, body: "Closes: none -- a fixture\n" }), { byDeclaredIdentity, baseRepo: BASE, checkout });
    assert.ok(existsSync(marker), `POSITIVE CONTROL: the command ran in the checkout (${eligible.kind}: ${eligible.lines.join(" | ")})`);
    assert.ok(eligible.lines.some((line) => /^ACCEPTANCE: RAN/.test(line)), eligible.lines.join("\n"));
    rmSync(marker);

    const fork = orgSideAcceptanceVerdict(agentPr({ headRefOid: head, body: "Closes: none -- a fixture\n", isCrossRepository: true, headRepository: { name: "fork" } }),
      { byDeclaredIdentity, baseRepo: BASE, checkout });
    assert.equal(fork.kind, "not-run");
    assert.equal(existsSync(marker), false, "the fork's identical command was never executed");
    assert.deepEqual(fork.lines, [], "and no report of it exists");

    const stranger = orgSideAcceptanceVerdict(agentPr({ headRefOid: head, author: { login: "a-stranger" } }), { byDeclaredIdentity, baseRepo: BASE, checkout });
    assert.equal(stranger.kind, "not-run");
    assert.equal(existsSync(marker), false, "a same-repository agent branch by no org identity executes nothing either");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(1502 f) acceptanceGateOf: arm only on a pass AT THIS HEAD; a fail, a not-run, another head's pass and an unread pull request are withheld; an unrun one passes through", () => {
  const prs: Record<number, { headRefOid: string; }> = { 1: { headRefOid: "a" }, 2: { headRefOid: "b" }, 3: { headRefOid: "c" }, 4: { headRefOid: "d" }, 5: { headRefOid: "e" } };
  const verdicts: Record<number, ReturnType<typeof orgSideAcceptanceVerdict> | null> = {
    1: { kind: "pass", head: "a", lines: [], why: "ok" },
    2: { kind: "fail", head: "b", lines: ["ACCEPTANCE: RAN x", "ACCEPTANCE: FAIL exit 1"], why: "acceptance FAILED at b" },
    3: { kind: "not-run", head: "c", lines: [], why: "not run: no checkout" },
    4: { kind: "pass", head: "OLD", lines: [], why: "ok" },
    5: null,
  };
  const gate = (numbers: number[]) => acceptanceGateOf(numbers, { prOf: (n) => prs[n], gateOf: (pr) => verdicts[Number(Object.keys(prs).find((k) => prs[Number(k)] === pr))] });
  const out = gate([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(out.armable, [1, 5], "the pass at this head, and the one the org does not run");
  assert.deepEqual(out.withheld.map((w) => w.number), [2, 3, 4, 6]);
  assert.match(out.withheld[0].why, /FAILED at b: ACCEPTANCE: FAIL exit 1/);
  assert.match(out.withheld[2].why, /not at the head it is at now/);
  assert.match(out.withheld[3].why, /not in the list/);
  assert.deepEqual([...out.armable, ...out.withheld.map((w) => w.number)].sort(), [1, 2, 3, 4, 5, 6], "a partition: nothing is dropped");
});

test("(1502 g) the order names the withheld ones and says NOT to arm them by hand; with none withheld it is the order as it was", () => {
  const bare = greenUnarmedOrders({ numbers: [8, 9], of: 3, armed: 1, tried: [] });
  assert.doesNotMatch(bare[0].prompt, /ACCEPTANCE HOLDS/, "CONTROL: nothing withheld, nothing said");
  const withheld = greenUnarmedOrders({ numbers: [8, 9], of: 3, armed: 1, tried: [], withheld: [{ number: 9, why: "acceptance FAILED at 1111aaaa" }] });
  assert.match(withheld[0].prompt, /ACCEPTANCE HOLDS .*9.*acceptance FAILED at 1111aaaa/);
  assert.match(withheld[0].prompt, /NOT to be armed by hand/);
  const alone = greenUnarmedOrders({ numbers: [9], withheld: [{ number: 9, why: "acceptance FAILED" }] });
  assert.match(alone[0].prompt, /NOT to be armed by hand/, "a bare list with a withheld one still says so");
});

test("(1502 h) gateUnarmedOnAcceptance: OFF by default reads and runs nothing; ON runs only the eligible ones and never an outside pull request", () => {
  const prs = [agentPr({ number: 1 }), agentPr({ number: 2, headRefName: "feature/y" }), agentPr({ number: 3, isCrossRepository: true }), agentPr({ number: 4, author: { login: "a-stranger" } })];
  const asked: number[] = [];
  const verdictOf = (pr: any) => { asked.push(pr.number); return { kind: "fail" as const, head: pr.headRefOid, lines: ["ACCEPTANCE: FAIL exit 1"], why: "acceptance FAILED" }; };
  // the host's own decisions file may carry `outside.acceptance` (a11ign#5613): this pins the env switch, so the outside switches are handed empty
  const off = gateUnarmedOnAcceptance([1, 2, 3, 4], { openPrs: prs, scope: BASE, env: {}, declared: DECLARED, verdictOf, outsideSwitches: () => ({}) });
  assert.deepEqual(off, { armable: [1, 2, 3, 4], withheld: [] });
  assert.deepEqual(asked, [], "off: no verdict was asked for");
  const on = gateUnarmedOnAcceptance([1, 2, 3, 4], { openPrs: prs, scope: BASE, env: { [ACCEPTANCE_GATE_SWITCH_ENV]: "on" }, declared: DECLARED, verdictOf, log: () => {} });
  assert.deepEqual(asked, [1], "on: only the eligible agent pull request was asked about; the branch, the fork and the stranger were not");
  assert.deepEqual(on.armable, [2, 3, 4], "the org says nothing of what it does not run");
  assert.deepEqual(on.withheld.map((w) => w.number), [1]);
  assert.deepEqual(gateUnarmedOnAcceptance([1], { openPrs: prs, scope: BASE, env: { [ACCEPTANCE_GATE_SWITCH_ENV]: "yes" }, declared: DECLARED, verdictOf, outsideSwitches: () => ({}) }).armable, [1], "only the word `on` turns it on");
});

const ON = { [OUTSIDE_ACCEPTANCE_FLAG]: true };
const reportOf = (ok: boolean) => ({ report: () => ({ ok, lines: ["ACCEPTANCE: RAN node --test x"] }) });

test("(1579 a) the flag is `outside.acceptance`, and only a literal true turns it on: absent, false and every other value are off", () => {
  assert.equal(OUTSIDE_ACCEPTANCE_FLAG, "outside.acceptance");
  assert.equal(outsideAcceptanceOn({ "outside.acceptance": true }), true, "POSITIVE CONTROL");
  for (const off of [{}, { "outside.acceptance": false }, { "outside.acceptance": "true" }, { "outside.acceptance": 1 }, { "duplicate-row": true }, null, undefined]) {
    assert.equal(outsideAcceptanceOn(off as never), false, JSON.stringify(off));
  }
});

test("(1579 b) OFF the home does nothing: no checkout, no report, no release, whatever the pull request", () => {
  for (const switches of [{}, { [OUTSIDE_ACCEPTANCE_FLAG]: false }, undefined]) {
    const { calls, seams } = guardedSeams();
    assert.deepEqual(shadowAcceptanceVerdict(agentPr(), { ...seams, switches }), { on: false });
    assert.deepEqual(calls, { checkout: 0, report: 0, release: 0 });
  }
  const { calls, seams } = guardedSeams();
  assert.equal(shadowAcceptanceVerdict(agentPr(), { ...seams, switches: ON }).on, true, "CONTROL: the same seams run when the flag is on");
  assert.deepEqual(calls, { checkout: 1, report: 1, release: 1 });
});

test("(1579 c) ON is SHADOW: a failing verdict blocks nothing, and is compared with the job's by pass or fail alone", () => {
  const cases: ["pass" | "fail" | null, boolean, string][] = [["pass", true, "agree"], ["fail", false, "agree"], ["pass", false, "disagree"], ["fail", true, "disagree"], [null, true, "not-compared"]];
  for (const [job, ok, agreement] of cases) {
    const shadow = shadowAcceptanceVerdict(agentPr(), { ...guardedSeams().seams, ...reportOf(ok), switches: ON, job });
    assert.ok(shadow.on);
    assert.equal(shadow.blocks, false, "a shadow verdict holds nothing, even a fail");
    assert.equal(shadow.agreement, agreement, `${job} vs ${ok}`);
  }
});

test("(1579 d) a fork or an outside author runs NOTHING from its body even with the flag on, and is never compared", () => {
  for (const [name, over] of INELIGIBLE) {
    const { calls, seams } = guardedSeams();
    const shadow = shadowAcceptanceVerdict(agentPr(over), { ...seams, switches: ON, job: "pass" });
    assert.ok(shadow.on);
    assert.equal(shadow.verdict.kind, "not-run", name);
    assert.equal(shadow.agreement, "not-compared", name);
    assert.deepEqual(calls, { checkout: 0, report: 0, release: 0 }, name);
  }
});

test("(1579 e) the rows' labels reach the report, as the job's class report needs them; none handed is none handed", () => {
  const seen: unknown[] = [];
  const rowLabels = () => ["defect"];
  const report = (input: { rowLabels?: unknown; }) => { seen.push(input.rowLabels); return { ok: true, lines: [] }; };
  orgSideAcceptanceVerdict(agentPr(), { ...guardedSeams().seams, report, rowLabels });
  orgSideAcceptanceVerdict(agentPr(), { ...guardedSeams().seams, report });
  assert.deepEqual(seen, [rowLabels, undefined]);
});
