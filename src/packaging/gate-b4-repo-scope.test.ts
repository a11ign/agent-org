// no-token: gh -- imports `work-gate.ts` and `row-claim/file-overlap-rule.ts`, whose default readers spawn `gh`; the claim and the gate's rows read the fake code host's world, the gate's executor is handed a `run` that records its argument lists, and every per-tick read is a stub, so nothing is spawned (#3095)
/**
 * #3095: THE GATE'S B4 PRE-FILTER COMPARES A ROW WITH THE OPEN PULL REQUESTS OF EVERY DECLARED CODE REPOSITORY, AS THE CLAIM DOES.
 *
 * `row-claim` and the spawn check read `lookupOpenPrFiles`, which maps over `homeProjectDeclaration().code` (#2617). The gate read only the
 * scope's own repository, so a row overlapping a pull request in `a11ign/agent-org` was never shelved: offered every tick, refused by the
 * spawn check every tick, and counted as idle time (99 of the 346 `ready-row-unclaimed` lines of 2026-10-02 -- the daily retrospective's
 * measurement, not this file's). A gate that offers what the claim refuses produces an order per tick that cannot be delivered.
 *
 * THE POPULATION IS THE DECLARATION'S, not a list typed here: one pull request and one Ready row per declared code repository, so a third
 * repository is covered the day it is declared. POSITIVE CONTROLS, each named where it is asserted:
 *   - the population holds a KEYED repository (otherwise "for each" would be the primary alone, the defect's own blind spot);
 *   - a row overlapping nothing IS offered, so "shelved" is not what this harness says of every row;
 *   - a row overlapping a PR in the scope's OWN repository is shelved by a refusal that does not name a repository, as before.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { scopesOf } from "../work-gate/vocabulary.ts";
import { readLanes, scopeTick, pullRequestsOfOthers, unreadLanes } from "../work-gate/tick/tick-decisions-and-flags.ts";
import { readOtherScopes } from "../work-gate.ts";
import { fileOverlapReason, lookupOpenPrFiles } from "../row-claim/file-overlap-rule.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { declaredRegionFiles } from "../region-paths.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { FakeRowPull } from "../plugins/fakes/code-host-rows.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

type Code = { key: string, repo: string };
const DECLARED_CODE: readonly Code[] = homeProjectDeclaration().code;
const PRIMARY = DECLARED_CODE[0];
const PRIMARY_SCOPE = scopesOf([homeProjectDeclaration()]).find((scope) => scope.key === "")!;

/** The path a row and a pull request of repository `n` collide on: a slash in it, so no root-file read is needed to parse the Region. */
const fileOf = (index: number) => `src/collides-${index}.mjs`;
/** A Region entry for that file in the repository `code` -- bare for the first repository, `<key>:` otherwise (#2617). */
const entryOf = ({ key }: Code, index: number) => (key === "" ? fileOf(index) : `${key}:${fileOf(index)}`);
const rowBody = (...entries: string[]) => `## Region\n\n\`\`\`\n${entries.join("\n")}\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\ntrue\n\`\`\`\n\n## Open-check\n\n\`\`\`\ntrue\n\`\`\`\n`;
const READY_ROW_BASE = 9000;
const PR_BASE = 700;
const readyRow = (number: number, ...entries: string[]) => ({ number, title: `row ${number}`, labels: [{ name: "ready" }], body: rowBody(...entries) });
const openPr = (number: number, files: string[]) => ({ number, isDraft: false, headRefOid: "abc", statusCheckRollup: [], author: { login: "a11ign-ai-workers" },
  comments: [], labels: [], body: "", files: files.map((path) => ({ path })), changedFiles: files.length });

/** What each declared repository's open pull requests are (number and the files each changes), or `Error` when the list cannot be read; absent is an empty list. */
type PrsByRepo = Record<string, { number: number; files: string[] }[] | Error>;

afterEach(() => forgetActivation());

/**
 * The world the claim AND the gate read: one table of pull requests per declared repository, laid in the fake code host (the first repository's are the world's own pull requests, another's are `rules.otherRepos`),
 * and the Ready rows in the tracker's. The CLAIM's reader asks the code host (`openPullsWithFilesOf`); the gate's own executor still reads the open list through the `run` it is handed, which answers the list of the
 * repository it was aimed at from the same table (the code host's stand-in for the list's arguments, which the call records) and cannot be shown a different world.
 */
function fakeWorld(rows: { number: number; body: string }[], prs: PrsByRepo) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = PRIMARY.repo;
  for (const row of rows) world.rows.set(row.number, { number: row.number, title: `row ${row.number}`, body: row.body, state: "OPEN", labels: ["ready"], createdAt: "2026-10-01T00:00:00Z", closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null });
  for (const [repo, listed] of Object.entries(prs)) {
    if (listed instanceof Error) { world.rules.listRefused.set(repo, listed); continue; }
    const held = repo === PRIMARY.repo ? world.pulls : world.rules.otherRepos.set(repo, new Map()).get(repo)!;
    for (const pr of listed) {
      held.set(pr.number, { number: pr.number, body: "", headRefName: `agent/pr-${pr.number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-01T00:00:00Z", comments: [], author: "a11ign-ai-workers", files: pr.files } satisfies FakeRowPull);
    }
  }
  substituteCodeHost(host);
  const calls: { args: string[]; repo: string | undefined }[] = [];
  const run = (args: string[], aimed?: string) => {
    calls.push({ args, repo: aimed });
    const repo = aimed ?? PRIMARY.repo;
    // the gate's open list, asked with the arguments the code host builds (the fake's are a stand-in line)
    if (args[0] === "fake-open-pull-list") {
      const answer = prs[repo] ?? [];
      if (answer instanceof Error) throw answer;
      return JSON.stringify(answer.map((pr) => openPr(pr.number, pr.files)));
    }
    return "[]";
  };
  return Object.assign(run, { host, calls });
}

/** A fake of the per-tick reads, deliberately partial: the real ones return more fields than these tests read. */
type Readings = NonNullable<Parameters<typeof scopeTick>[3]>;
const NO_READINGS = { code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
  tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null }) } as unknown as Readings;

type Order = { cause: string, discriminator: string };

/** THE PRIMARY'S TICK, composed as `main` composes it: its own lanes, the OTHER scopes' lanes read once, and their pull requests as siblings. */
function primaryTick(run: ReturnType<typeof fakeWorld>) {
  const others = readOtherScopes(run);
  const lanes = { ...readLanes(PRIMARY_SCOPE, run), siblingPrs: pullRequestsOfOthers(others) };
  return { tick: scopeTick(PRIMARY_SCOPE, { drain: false }, lanes, NO_READINGS), others };
}

const offered = (orders: unknown[], row: number) => (orders as Order[]).some((o) => o.cause === "ready-row-unclaimed" && o.discriminator === String(row));

/** What the CLAIM says of the row: `fileOverlapReason` over every declared repository's pull requests, as `row-claim` reads them. */
function claimReason(row: ReturnType<typeof readyRow>) {
  const others = lookupOpenPrFiles({ run: noGh, log: () => {} });
  const mine = declaredRegionFiles(row.body, { rootFiles: new Set() });
  assert.ok(others !== null && mine !== null, "the claim's own reads must succeed for its verdict to be a comparison");
  return fileOverlapReason(mine, others, { rowNumber: row.number }).reason;
}

const noGh = (args: string[]): string => { throw new Error(`the claim reads the fake code host's world: no gh is run for ${args.join(" ")}`); };

/** One row and one pull request per declared repository, row `i` naming exactly the file PR `i` touches. */
function population() {
  const rows = DECLARED_CODE.map((code, i) => readyRow(READY_ROW_BASE + i, entryOf(code, i)));
  const prs: PrsByRepo = Object.fromEntries(DECLARED_CODE.map((code, i) => [code.repo, [{ number: PR_BASE + i, files: [fileOf(i)] }]]));
  return { rows, prs };
}

test("the population is the declaration's, and POSITIVE CONTROL: it holds a repository besides the primary's", () => {
  assert.ok(DECLARED_CODE.length >= 2, "with one declared repository 'every declared repository' is the scope's own, and this file would prove nothing");
  assert.ok(DECLARED_CODE.some((code) => code.key !== ""), "a KEYED repository is the pair the gate was blind to");
});

test("DONE-WHEN 1: a row overlapping a pull request in ANY declared repository is shelved, with the reason `fileOverlapReason` gives", () => {
  const { rows, prs } = population();
  const run = fakeWorld(rows, prs);
  const { tick } = primaryTick(run);
  for (const [i, code] of DECLARED_CODE.entries()) {
    const row = rows[i];
    const shelved = tick.blocked.find((b: { number: number }) => b.number === row.number);
    assert.ok(shelved, `row ${row.number} overlaps PR ${PR_BASE + i} in ${code.repo} and must be shelved`);
    assert.equal(offered(tick.orders, row.number), false, `and not offered as ready-row-unclaimed (${code.repo})`);
    const expected = fileOverlapReason([entryOf(code, i)], [{ number: PR_BASE + i, files: [fileOf(i)], changedFiles: 1,
      ...(code.key === "" ? {} : { repo: code.repo, repoKey: code.key }) }], { rowNumber: row.number }).reason;
    assert.equal(shelved.reason, expected, `the gate's reason is the rule's own, naming ${code.key === "" ? "#N" : `#N in ${code.repo}`}`);
  }
});

test("DONE-WHEN 2: the gate's B4 answer and the claim's agree, row by row, over the whole population", () => {
  const { rows, prs } = population();
  const run = fakeWorld(rows, prs);
  const { tick } = primaryTick(run);
  const pairs = rows.map((row) => ({ row: row.number,
    gate: tick.blocked.find((b: { number: number }) => b.number === row.number)?.reason ?? null, claim: claimReason(row) }));
  assert.ok(pairs.length >= 2 && pairs.every((p) => p.claim !== null), "POSITIVE CONTROL: the claim refuses EVERY row of this population, so agreement is not two nulls");
  assert.deepEqual(pairs.map((p) => p.gate), pairs.map((p) => p.claim), "one verdict per row, whichever repository its pull request is in");
});

test("POSITIVE CONTROL: a row overlapping no pull request in any declared repository IS still offered", () => {
  const { rows, prs } = population();
  const clear = readyRow(READY_ROW_BASE + 99, "src/collides-nothing.mjs");
  const { tick } = primaryTick(fakeWorld([...rows, clear], prs));
  assert.equal(offered(tick.orders, clear.number), true, "the harness can offer a row, so 'shelved' above is the filter's doing");
  assert.equal(tick.blocked.some((b: { number: number }) => b.number === clear.number), false);
});

test("POSITIVE CONTROL: a row overlapping a pull request in the SCOPE'S OWN repository is shelved exactly as before", () => {
  const { rows, prs } = population();
  const { tick } = primaryTick(fakeWorld(rows, prs));
  const own = tick.blocked.find((b: { number: number }) => b.number === rows[0].number);
  assert.match(own!.reason, new RegExp(`overlaps #${PR_BASE}, which already touches`), "the first repository's PR is named by its bare number");
  assert.doesNotMatch(own!.reason, / in [\w.-]+\/[\w.-]+/, "and names no repository, which is what every refusal said before a second one was declared");
});

test("DONE-WHEN 4: a declared repository whose pull-request list cannot be read does NOT shelve, and the tick says WHICH repository", () => {
  const { rows, prs } = population();
  const keyed = DECLARED_CODE.map((code, i) => ({ code, i })).filter(({ code }) => code.key !== "");
  for (const { code, i } of keyed) {
    const run = fakeWorld(rows, { ...prs, [code.repo]: new Error(`HTTP 502 reading ${code.repo}`) });
    const { tick, others } = primaryTick(run);
    assert.equal(offered(tick.orders, rows[i].number), true, `the gate fails open: with ${code.repo} unreadable, row ${rows[i].number} is offered and the claim decides`);
    const ticks = others.map(({ scope, read }) => scopeTick(scope, { drain: false }, read, NO_READINGS));
    const refused = unreadLanes({ prs: [], readyRows: [], others: ticks });
    assert.ok(refused.some((line) => line.includes(code.repo)), `and the refusal names the repository: ${JSON.stringify(refused)}`);
    const intact = DECLARED_CODE.map((c, j) => ({ c, j })).filter(({ c }) => c.repo !== code.repo);
    for (const { j } of intact) {
      assert.ok(tick.blocked.some((b: { number: number }) => b.number === rows[j].number), `POSITIVE CONTROL: row ${rows[j].number}, whose repository IS readable, is still shelved`);
    }
  }
  assert.ok(keyed.length > 0, "POSITIVE CONTROL for the loop above: it ran over at least one keyed repository");
});

test("the PRIMARY's own tick (`main`, which `scopeTick` does not run) reads the same siblings, and reads each other scope ONCE", () => {
  // `main` calls `process.exit` and appends to the host's ledgers, so it cannot be run here; what a test CAN hold is that its one B4 line
  // is the composition `primaryTick` above makes, and that the lanes it read are the ones it ticks (no second `pr list` per repository: DONE-WHEN 3).
  const source = workGateSource();
  const main = source.slice(source.indexOf("\nfunction main()"));
  assert.ok(main.length > 0, "POSITIVE CONTROL: `main` was found, so the two matches below are searches of it");
  assert.match(main, /comparablePrFiles\(\[\.\.\.openPrs, \.\.\.pullRequestsOfOthers\(otherScopes\)\]\)/, "main's B4 list holds the other repositories' pull requests");
  assert.match(main, /otherScopeTicks\(\{ drain \}, otherScopes, openPrs, homeRowsOf\(allOpen\)\)/, "and the other scopes are ticked from the lanes it already read");
  // #3566 slice 6: they are read through the one wave that also reads the tracker lanes, so "once" is that call, and `readOtherScopes` is not asked beside it.
  assert.equal((main.match(/readLanesAfterOutageCheck\(/g) ?? []).length, 1, "which are read exactly once");
  assert.doesNotMatch(main, /readOtherScopes\(/, "and not a second time on their own");
});
