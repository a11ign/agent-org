// no-token: gh -- `gatherChanges` and `main` here take `git` and `gh` as seams, so nothing reaches the real `gh`; the
// defaults (`defaultGh`) are never called from this file.
/**
 * #2939 (chairman, 2026-10-01): a hand fix by the chairman's session is an org defect, and the count has a home.
 * The ledger counts changes by TWO mechanisms (the author field, and a declared `Hand-fix:` line), once each, and
 * says UNKNOWN when it could not read -- never zero.
 *
 * THE BASELINE FIXTURE IS REAL, not invented: the PR numbers, authors and merge times are what
 * `gh pr list --state merged --json number,author,title,mergedAt` returned on 2026-10-01, four of the chairman's
 * account's PRs (the last four it authored, all 2026-09-24) and four of the workers' account's (#2927-#2934, the
 * last hour of that day).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORG_LOGINS, AUTOMATION_LOGINS, buildLedger, classifyLogin, declarationsIn, declarationRefusal, gatherChanges,
  judgeChange, ledgerLine, readLedger, trendOf, HAND_FIX_FORMAT,
} from "../hand-fix-ledger.ts";
import { main as prOpen, EXIT_NOTHING_SENT } from "../pr-open.ts";

const EM = "—";
const NOW = new Date("2026-10-01T22:00:00Z");

interface ChangeInput { key?: string; number?: number | null; author?: string | null; actors?: (string | null)[];
  body?: string | null; at?: string; title?: string }

/** A Change as `gatherChanges` builds it: the PR's author is the first actor, then one actor per carried commit. */
const change = ({ number = 1, author = "a11ign-ai-workers", actors = [], body = "", at = "2026-09-30T00:00:00Z",
  title = "t", key }: ChangeInput = {}) => ({
  key: key ?? `pr:${number}`, number, title, at, author, actors: [author, ...actors], body,
});

// --- the baseline: what 14 days of `main` contain ------------------------------------------------------------------

const BASELINE = [
  { n: 2321, author: "DanBeckDev", at: "2026-09-24T16:02:35Z", title: "test(#2280): pin the composed wake path; record the re-hand re-measurement" },
  { n: 2315, author: "DanBeckDev", at: "2026-09-24T11:32:53Z", title: "fix(#2212): the Ofgem calibration entry follows the publisher's second move" },
  { n: 2311, author: "DanBeckDev", at: "2026-09-24T10:23:43Z", title: "feat(#2212): the calibration fit reports the capture-protocol census of what it fitted on" },
  { n: 2290, author: "DanBeckDev", at: "2026-09-24T09:38:55Z", title: "docs: what a capture costs on the fleet and on the Action, and the multi-page cap basis (#2271)" },
  { n: 2934, author: "a11ign-ai-workers", at: "2026-10-01T21:24:05Z", title: "pr:open says at opening that CI has not run (#2929)" },
  { n: 2932, author: "a11ign-ai-workers", at: "2026-10-01T21:26:11Z", title: "Finish the move to pnpm (#2923): the private packages' READMEs say pnpm" },
  { n: 2930, author: "a11ign-ai-workers", at: "2026-10-01T21:16:46Z", title: "scripts/coverage.mjs header says pnpm run coverage; regenerate docs/commands.md (#2922)" },
  { n: 2927, author: "a11ign-ai-workers", at: "2026-10-01T21:20:10Z", title: "The split, move 5 (#69): packages/pdf is @a11ign/documents" },
];
const baselineChanges = () => BASELINE.map((p) => change({ number: p.n, author: p.author, at: p.at, title: p.title }));

test("#2939 POSITIVE CONTROL: the baseline's PRs the chairman's account authored are counted, and the workers' are not", () => {
  const ledger = buildLedger(baselineChanges());
  assert.deepEqual(ledger.entries.map((e) => e.number).sort(), [2290, 2311, 2315, 2321],
    "exactly the four DanBeckDev-authored PRs");
  assert.equal(ledger.count, 4, "the control is non-empty, so the emptiness assertions below mean something");
  assert.equal(ledger.humanAuthored, 4);
  assert.equal(ledger.latest, "2026-09-24T16:02:35Z");
});

// --- a commit by a non-org identity is counted and an org one is not ------------------------------------------------

test("#2939 a commit by a non-org identity is counted; an org one is not -- including every account the row names", () => {
  const human = judgeChange(change({ actors: ["DanBeckDev"] }));
  assert.equal(human.verdict, "counted");
  assert.deepEqual(human.verdict === "counted" && human.entry.humans, ["DanBeckDev"]);
  for (const login of ORG_LOGINS) {
    assert.equal(judgeChange(change({ author: login, actors: [login] })).verdict, "clean", `${login} is the org`);
  }
  assert.deepEqual([...ORG_LOGINS], ["a11ign-ai-workers", "a11ign-ai-leads", "a11ign-bot"], "the row's three, pinned");
});

test("#2939 a bot is the org's: `a11ign-bot` is not a hand fix, and neither is the automation that merges and runs", () => {
  assert.equal(classifyLogin("a11ign-bot"), "org");
  for (const login of AUTOMATION_LOGINS) assert.equal(classifyLogin(login), "automation", login);
  assert.equal(buildLedger([change({ author: "a11ign-bot", actors: ["a11ign-ci", "claude"] })]).count, 0);
});

test("#2939 an author GitHub could not resolve is UNREAD, which is neither counted nor clean; `web-flow` names nobody", () => {
  assert.equal(classifyLogin(null), "unknown");
  assert.equal(classifyLogin("web-flow"), "unknown");
  const ledger = buildLedger([change({ number: 7, actors: [null] }), change({ number: 8, actors: ["web-flow"] })]);
  assert.equal(ledger.count, 0);
  assert.deepEqual(ledger.unread.map((u) => u.key), ["pr:7", "pr:8"]);
});

// --- counted once ---------------------------------------------------------------------------------------------------

test("#2939 a PR is counted ONCE however many commits it carries: three human commits are one hand fix", () => {
  const three = change({ number: 40, actors: ["DanBeckDev", "DanBeckDev", "DanBeckDev"] });
  const ledger = buildLedger([three]);
  assert.equal(ledger.count, 1);
  assert.deepEqual(ledger.entries[0].humans, ["DanBeckDev"]);
  assert.equal(buildLedger([three, three]).count, 1, "and the same change handed in twice is still one");
});

test("#2939 a `Hand-fix:` line is counted ONCE even when the author field counts it too, and says it was both", () => {
  const body = `## What\n\nHand-fix: the gate should have filed the stale row ${EM} work-gate.ts's stale-row question\n`;
  const both = buildLedger([change({ number: 50, author: "DanBeckDev", actors: ["DanBeckDev"], body })]);
  assert.equal(both.count, 1);
  assert.equal(both.both, 1);
  assert.equal(both.derived + both.declared, 0, "one mechanism per entry, not two entries");
  const declaredOnly = buildLedger([change({ number: 51, body })]);
  assert.equal(declaredOnly.count, 1, "an org account's PR is counted by its declaration, which the author field cannot see");
  assert.equal(declaredOnly.declared, 1);
  assert.deepEqual(declaredOnly.entries[0].declared, [
    { did: "the gate should have filed the stale row", gate: "work-gate.ts's stale-row question" }]);
});

// --- the format -----------------------------------------------------------------------------------------------------

test("#2939 the Hand-fix line's shape: an em dash and both halves, in any of the body's usual dressings", () => {
  const ok = [`Hand-fix: a ${EM} b`, `- Hand-fix: a ${EM} b`, `**Hand-fix:** a ${EM} b`, `> hand-fix: a ${EM} b`];
  for (const line of ok) assert.equal(declarationsIn(line).handFixes.length, 1, line);
  const bad = ["Hand-fix: a - b", "Hand-fix: a -- b", `Hand-fix: ${EM} b`, `Hand-fix: a ${EM}`, "Hand-fix:", "Hand-fix: just prose"];
  for (const line of bad) {
    const read = declarationsIn(line);
    assert.equal(read.handFixes.length, 0, `${line} does not count`);
    assert.deepEqual(read.malformed, [line], `${line} is REPORTED, not silently dropped`);
  }
  assert.deepEqual(declarationsIn("the Hand-fix: word mid-line is prose"), { handFixes: [], notHandFixes: [], malformed: [] });
});

test("#2939 pr-open REFUSES a malformed Hand-fix line, naming the format, and sends nothing", () => {
  for (const mode of ["create", "edit"]) {
    const sent: string[][] = [];
    const out: string[] = [];
    const err: string[] = [];
    let acceptance = 0;
    const body = "## Acceptance\n\nnode -e \"process.exit(0)\"\n\nCloses #2939\nHand-fix: the gate did not file it - hyphen\n";
    const code = prOpen([mode, ...(mode === "create" ? ["--draft"] : ["7"]), "--body", body], {
      run: (a: string[]) => { sent.push(a); }, git: () => "x", prHead: () => ({ ref: "x", oid: "x" }),
      runAcceptance: () => { acceptance += 1; return 0; }, owner: () => "ceo",
      out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); },
    });
    const said = err.join("");
    assert.equal(code, EXIT_NOTHING_SENT, mode);
    assert.deepEqual(sent, [], `${mode}: nothing was sent`);
    assert.equal(acceptance, 0, `${mode}: refused before the Acceptance ran`);
    assert.ok(said.includes(HAND_FIX_FORMAT), "the exact format is printed");
    assert.ok(said.includes("IGNORED: Hand-fix: the gate did not file it - hyphen"), "the offending line is quoted");
  }
});

test("#2939 pr-open ACCEPTS a well-formed Hand-fix line, and a body with none is untouched", () => {
  assert.equal(declarationRefusal("Closes #1\n"), null);
  assert.equal(declarationRefusal(`Closes #1\nHand-fix: a ${EM} b\n`), null);
  const sent: string[][] = [];
  const body = `## Acceptance\n\nnode -e "process.exit(0)"\n\nCloses #2939\nHand-fix: the gate should have filed it ${EM} work-gate.ts\n`;
  const code = prOpen(["create", "--draft", "--body", body], {
    run: (a: string[]) => { sent.push(a); }, git: () => "x", prHead: () => ({ ref: "x", oid: "x" }),
    runAcceptance: () => 0, runMutation: () => 0, owner: () => "ceo", out: () => {}, err: () => {},
  });
  assert.equal(code, 0);
  assert.ok(sent.some((a) => a[0] === "pr" && a[1] === "create"), "the PR was created");
});

// --- what is not a hand fix -----------------------------------------------------------------------------------------

test("#2939 a decision, a credential or a publish is not a hand fix: the line excludes it, and the report says how many", () => {
  const body = `Not-a-hand-fix: publish ${EM} the ceo's publish order, which only a person can give\n`;
  const ledger = buildLedger([change({ number: 60, author: "DanBeckDev", actors: ["DanBeckDev"], body }),
    change({ number: 61, author: "DanBeckDev", actors: ["DanBeckDev"] })]);
  assert.equal(ledger.count, 1, "the unmarked human PR still counts");
  assert.deepEqual(ledger.excluded.map((e) => [e.key, e.kind]), [["pr:60", "publish"]]);
  assert.match(ledgerLine({ status: "read", count: 1, previous: 0, trend: "rising", why: null, days: 14, current: ledger }),
    /1 excluded as decision\/credential\/publish/);
  assert.deepEqual(declarationsIn(`Not-a-hand-fix: whim ${EM} because\n`).malformed.length, 1, "a kind outside the three is malformed");
  const wins = buildLedger([change({ number: 62, author: "DanBeckDev", actors: ["DanBeckDev"],
    body: `${body}Hand-fix: a ${EM} b\n` })]);
  assert.equal(wins.count, 1, "a declared hand fix is never excluded by a second line of the same body");
});

// --- unknown is not zero --------------------------------------------------------------------------------------------

test("#2939 a refused read is UNKNOWN, never zero; an empty read is a real zero, and the two read differently", () => {
  const refused = readLedger({ read: () => { throw new Error("gh: HTTP 403 rate limit exceeded\nsecond line"); }, now: NOW });
  assert.equal(refused.status, "unknown");
  assert.equal(refused.count, null);
  assert.equal(refused.previous, null);
  assert.equal(refused.trend, "unknown");
  assert.equal(refused.why, "gh: HTTP 403 rate limit exceeded");
  assert.match(ledgerLine(refused), /UNKNOWN -- the read was refused \(gh: HTTP 403 rate limit exceeded\)\. This is not zero\./);
  const zero = readLedger({ read: () => [], now: NOW });
  assert.equal(zero.status, "read");
  assert.equal(zero.count, 0, "an empty population is a ZERO, and is a different value from unknown");
  assert.doesNotMatch(ledgerLine(zero), /UNKNOWN/);
  assert.match(ledgerLine(zero), /HAND FIXES \(last 14d, target 0\): 0 /);
});

test("#2939 the gatherer lets a refused `gh` reach the reading as unknown, not as an empty list", () => {
  const refusing = () => { throw new Error("gh: authentication required"); };
  const read = gatherChanges({ git: () => "", gh: refusing, repo: "o/r" });
  const reading = readLedger({ read, now: NOW });
  assert.equal(reading.count, null);
  assert.match(reading.why ?? "", /authentication required/);
});

// --- the window and the trend ---------------------------------------------------------------------------------------

test("#2939 the count is the last 14 days and the trend compares it with the 14 before", () => {
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const changes = [
    change({ number: 1, author: "DanBeckDev", at: day(1) }), change({ number: 2, author: "DanBeckDev", at: day(13) }),
    change({ number: 3, author: "DanBeckDev", at: day(15) }), change({ number: 4, author: "DanBeckDev", at: day(20) }),
    change({ number: 5, author: "DanBeckDev", at: day(27) }), change({ number: 6, author: "DanBeckDev", at: day(40) }),
  ];
  const reading = readLedger({ read: () => changes, now: NOW });
  assert.equal(reading.count, 2, "days 1 and 13");
  assert.equal(reading.previous, 3, "days 15, 20 and 27; day 40 is out of both");
  assert.equal(reading.trend, "falling");
  assert.deepEqual([trendOf(3, 2), trendOf(2, 2), trendOf(2, 3), trendOf(null, 3), trendOf(3, null)],
    ["falling", "flat", "rising", "unknown", "unknown"]);
});

// --- the gatherer: merges are not authors ---------------------------------------------------------------------------

test("#2939 the MERGER is never read: a merge commit by the chairman's account over org commits is not a hand fix", () => {
  const MERGE = "m".repeat(40);
  const OLD = "a".repeat(40);
  const BRANCH = "b".repeat(40);
  const git = (args: string[]) => {
    if (args[0] === "rev-parse") return "h".repeat(40);
    if (args[0] === "log" && args.includes("--first-parent")) {
      return `${MERGE}\t${OLD} ${BRANCH}\t2026-09-30T10:00:00+00:00\tMerge pull request #77 from a11ign/agent/x\n`;
    }
    if (args[0] === "log" && args[1] === `${OLD}..${BRANCH}`) return `${BRANCH}\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const fakeGh = (args: string[]) => {
    if (args[0] === "api" && args[1] === "repos/o/r/commits/main") return "h".repeat(40);
    if (args[0] === "api") return `${MERGE}\tDanBeckDev\n${BRANCH}\ta11ign-ai-workers\n`;
    if (args[0] === "pr") return JSON.stringify([{ number: 77, author: { login: "a11ign-ai-workers" }, title: "x", body: "" }]);
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const changes = gatherChanges({ git, gh: fakeGh, repo: "o/r" })({ from: new Date("2026-09-03T00:00:00Z"), to: NOW });
  assert.deepEqual(changes.map((c) => [c.key, c.actors]), [["pr:77", ["a11ign-ai-workers", "a11ign-ai-workers"]]]);
  assert.equal(buildLedger(changes).count, 0);
  const human = gatherChanges({ git, gh: (a) => (a[0] === "api" && a[1] !== "repos/o/r/commits/main" ? `${MERGE}\tDanBeckDev\n${BRANCH}\tDanBeckDev\n` : fakeGh(a)), repo: "o/r" })(
    { from: new Date("2026-09-03T00:00:00Z"), to: NOW });
  assert.equal(buildLedger(human).count, 1, "positive control: the same change with a human commit on the branch IS counted");
});
