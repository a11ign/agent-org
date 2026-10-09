// no-token: gh -- importing `work-gate.ts` reaches `defaultRun`, and this file never lets it run: the tick is handed a fake `run` and a fake `release`, and the one test that runs the real
// release puts a fake `gh` first on its PATH.
/**
 * #4189: A KEYED PULL REQUEST HELD AFTER ITS `Waiting-for: merged` WAS ALREADY TRUE IS LIFTED BY THE NEXT TICK, through the path the tick takes (`waitTickFacts`, then
 * `liftedWaits` inside `orgHealthNow`) and not through `liftableHolds` alone, which `gate-lifts-resolved-holds.test.ts` already covers.
 *
 * THE INCIDENT (2026-10-08): agent-org#401 was labelled `hold:worker-4175` at 17:21:14Z with `Waiting-for: merged a11ign/agent-org#400`, and #400 had merged at 17:20:57Z, so the wait was
 * true BEFORE the hold existed. It stood 77 minutes until `ceo` lifted it by hand. The shape is `holdAfterMerge` below: the hold comment is dated after the blocker's merge.
 *
 * `HOST` is the declaration `declaredRepoKeys()` reads (`AGENT_ORG_HOST`, as the row's Acceptance sets it); a host that declares no `agent-org` key makes every keyed case below red for a
 * reason that has nothing to do with the gate, which is why `the host declares the key the cases use` is a test of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WAIT_MARKER } from "../wait-condition.ts";
import { decide, withPrOwners, waitTickFacts, orgHealthNow } from "../work-gate.ts";
import { homeProjectDeclaration } from "../project-config.ts";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-08T18:00:00Z");
const MERGED_AT = NOW - 40 * MINUTE_MS;
const ISO = (ms: number) => new Date(ms).toISOString();

const KEY = "agent-org";
const REPO = "a11ign/agent-org";
const BLOCKER = 400;
const HELD = 401;

type Release = { number: number; session: string; repoKey: string | undefined };

/** The hold comment `pr-hold.ts` writes, dated `at`, declaring `lines`. */
const marker = (at: number, lines: string[]) => ({ author: { login: "a11ign-ai-workers" }, createdAt: ISO(at), body: `${WAIT_MARKER}\nHeld by \`worker-4175\`.\n${lines.map((l) => `Waiting-for: ${l}`).join("\n")}` });

/** A pull request of the keyed repository, as `tagged` (work-gate.ts) leaves it: `repoKey` and `repo` on the raw item. */
function keyedPr(labels: string[], waits: string[], { heldAt, extra = {} }: { heldAt: number; extra?: Record<string, unknown> }) {
  return { number: HELD, repoKey: KEY, repo: REPO, labels: labels.map((name) => ({ name })), body: "", comments: [marker(heldAt, waits)], updatedAt: ISO(heldAt), ...extra };
}

type Issue = { state: "open" | "closed"; merged_at: string | null; closed_at: string | null };
const MERGED: Issue = { state: "closed", merged_at: ISO(MERGED_AT), closed_at: ISO(MERGED_AT) };
const OPENED: Issue = { state: "open", merged_at: null, closed_at: null };

/** A `gh` that answers `repos/<owner>/<repo>/issues/<n>` from `issues` and refuses anything else, as an unreadable reference. */
function fakeRun(issues: Record<string, Issue>) {
  const reads: string[] = [];
  const run = (args: string[]) => {
    reads.push(args[1]);
    const issue = issues[String(args[1]).replace(/^repos\//, "")];
    if (!issue) throw new Error(`refused: ${args[1]}`);
    return JSON.stringify({ ...issue, updated_at: ISO(MERGED_AT), labels: [] });
  };
  return { run, reads };
}

/**
 * One tick of `orgHealthNow`, with `release` recording what it was asked to release and answering `ok`. `keyed` is the declared repositories' open pull requests, which the gate hands
 * over as `keyedPrsRead` and never inside `prsRead`, the first repository's own list (work-gate.ts `pullRequestsOfOthers`).
 */
function tick({ prs = [], keyed = [] }: { prs?: Record<string, unknown>[]; keyed?: Record<string, unknown>[] }, issues: Record<string, Issue>, { ok = true }: { ok?: boolean } = {}) {
  const asked: Release[] = [];
  const { run, reads } = fakeRun(issues);
  const rows = [{ number: 11, labels: [{ name: "in-progress" }, { name: "session:worker-11" }] }];
  const owned = withPrOwners(prs as never, rows as never, () => null);
  const decideArgs = { prs: owned, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const decided = decide({ prs: owned, readyRows: [], openRows: rows } as never);
  const orders = orgHealthNow({ prsRead: prs, keyedPrsRead: keyed, readyRead: [], openRowsRead: [], decideArgs, decided } as never,
    { now: NOW, lastMergedAt: () => NOW - MINUTE_MS, log: () => {}, readCopies: (() => []) as never, readCaptures: (() => undefined) as never,
      readWaits: ((args: never) => waitTickFacts({ ...(args as Parameters<typeof waitTickFacts>[0]), run })) as never,
      release: ((number: number, session: string, repoKey?: string) => { asked.push({ number, session, repoKey }); return ok; }) as never,
      teamAccess: () => undefined });
  return { asked, reads, orders: orders as { session: string; subject: string }[] };
}

const staleOrders = <T extends { subject: string }>(orders: T[]) => orders.filter((o) => o.subject.startsWith("stale-wait"));
const FULL = `${REPO}#${BLOCKER}`;
const LIFTED: Release[] = [{ number: HELD, session: "worker-4175", repoKey: KEY }];

test("the host declares the key the cases use (positive control for every keyed case below)", () => {
  assert.ok(homeProjectDeclaration().code.some((entry) => entry.key === KEY), `the host's declaration has no \`${KEY}\` code key; the Acceptance sets AGENT_ORG_HOST`);
});

// --- the failing case, and its positive control ---------------------------------------------------------------------------------

test("THE INCIDENT: a keyed PR labelled AFTER its blocker merged is lifted by the next tick, with its key", () => {
  const holdAfterMerge = keyedPr(["hold:worker-4175"], [`merged ${FULL}`], { heldAt: MERGED_AT + 17_000 });
  const { asked, orders } = tick({ keyed: [holdAfterMerge] }, { [`${REPO}/issues/${BLOCKER}`]: MERGED });
  assert.deepEqual(asked, LIFTED);
  assert.deepEqual(staleOrders(orders), [], "and no order wakes the setter to do it again");
  assert.deepEqual(staleOrders(tick({ keyed: [{ ...holdAfterMerge, labels: [] }] }, { [`${REPO}/issues/${BLOCKER}`]: MERGED }).orders), [], "nor does the next tick, when the label is gone");
});

test("POSITIVE CONTROL: a keyed PR labelled BEFORE the blocker merged is lifted once it merges (the shape the existing test holds)", () => {
  const holdBeforeMerge = keyedPr(["hold:worker-4175"], [`merged ${FULL}`], { heldAt: MERGED_AT - 30 * MINUTE_MS });
  assert.deepEqual(tick({ keyed: [holdBeforeMerge] }, { [`${REPO}/issues/${BLOCKER}`]: MERGED }).asked, LIFTED);
});

test("the bare spelling on a keyed PR names the PR's own repository, and is lifted the same way", () => {
  const bare = keyedPr(["hold:worker-4175"], [`merged #${BLOCKER}`], { heldAt: MERGED_AT + 17_000 });
  assert.deepEqual(tick({ keyed: [bare] }, { [`${REPO}/issues/${BLOCKER}`]: MERGED }).asked, LIFTED);
});

// --- negative controls, each silent -----------------------------------------------------------------------------------------------

const NEGATIVES: { name: string; pr: Record<string, unknown>; issues: Record<string, Issue> }[] = [
  { name: "the blocker is still open", pr: keyedPr(["hold:worker-4175"], [`merged ${FULL}`], { heldAt: MERGED_AT }), issues: { [`${REPO}/issues/${BLOCKER}`]: OPENED } },
  { name: "the PR also carries an `answer:*` label", pr: keyedPr(["hold:worker-4175", "answer:ceo"], [`merged ${FULL}`], { heldAt: MERGED_AT }), issues: { [`${REPO}/issues/${BLOCKER}`]: MERGED } },
  { name: "the PR's repository is one the project does NOT declare", pr: keyedPr(["hold:worker-4175"], [`merged other/repo#${BLOCKER}`], { heldAt: MERGED_AT, extra: { repoKey: "other", repo: "other/repo" } }),
    issues: { [`other/repo/issues/${BLOCKER}`]: MERGED } },
  { name: "the wait names a first-repository `#n` that is merged while the keyed one is open (the wrong-repository read)", pr: keyedPr(["hold:worker-4175"], [`merged a11ign/a11ign#${BLOCKER}`], { heldAt: MERGED_AT }),
    issues: { [`a11ign/a11ign/issues/${BLOCKER}`]: OPENED, [`${REPO}/issues/${BLOCKER}`]: MERGED } },
  { name: "the bare `#n` is merged in the FIRST repository and open in the PR's own", pr: keyedPr(["hold:worker-4175"], [`merged #${BLOCKER}`], { heldAt: MERGED_AT }),
    issues: { [`a11ign/a11ign/issues/${BLOCKER}`]: MERGED, [`${REPO}/issues/${BLOCKER}`]: OPENED } },
];

for (const { name, pr, issues } of NEGATIVES) {
  test(`NEGATIVE CONTROL, no lift: ${name}`, () => {
    assert.deepEqual(tick({ keyed: [pr] }, issues).asked, []);
  });
}

// --- the release is aimed at the PR's repository ----------------------------------------------------------------------------------

test("the lift calls `release` with the item's `repoKey`, and a first-repository PR of the same number is released without one", () => {
  const first = { number: HELD, labels: [{ name: "hold:worker-9" }], body: "", comments: [marker(MERGED_AT + 17_000, [`merged #${BLOCKER}`])], updatedAt: ISO(MERGED_AT) };
  const keyed = keyedPr(["hold:worker-4175"], [`merged ${FULL}`], { heldAt: MERGED_AT + 17_000 });
  const { asked } = tick({ prs: [first], keyed: [keyed] }, { "a11ign/a11ign/issues/400": MERGED, [`${REPO}/issues/${BLOCKER}`]: MERGED });
  assert.deepEqual(asked.sort((a, b) => a.session.localeCompare(b.session)), [{ number: HELD, session: "worker-4175", repoKey: KEY }, { number: HELD, session: "worker-9", repoKey: undefined }]);
});

test("a keyed lift that FAILS falls back to the order, so a silent skip cannot recur", () => {
  const holdAfterMerge = keyedPr(["hold:worker-4175"], [`merged ${FULL}`], { heldAt: MERGED_AT + 17_000 });
  const { asked, orders } = tick({ keyed: [holdAfterMerge] }, { [`${REPO}/issues/${BLOCKER}`]: MERGED }, { ok: false });
  assert.deepEqual(asked, LIFTED, "it was attempted");
  assert.deepEqual(staleOrders(orders).filter((o) => o.subject === `stale-wait-${KEY}#${HELD}`).map((o) => o.session), ["worker-4175"], "and the setter is still ordered");
});

test("THE CALL SITE: the gate hands `orgHealthNow` the declared repositories' pull requests as `keyedPrsRead`, not merged into the first repository's `prsRead`", () => {
  const gate = readFileSync(new URL("../work-gate.ts", import.meta.url), "utf8");
  assert.match(gate, /orgHealthNow\(\{ prsRead: prs, keyedPrsRead: pullRequestsOfOthers\(otherScopes\),/, "a call that omits it never reads a keyed hold: that is #4189");
  const health = readFileSync(new URL("../work-gate/org-health.ts", import.meta.url), "utf8");
  assert.match(health, /readWaits\(\{ prsRead: prsRead === null \? null : \[\.\.\.prsRead, \.\.\.keyedPrsRead\], openRowsRead, now \}\)/, "and only the wait read sees them");
});
