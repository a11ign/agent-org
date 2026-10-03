// no-token: GH_TOKEN
// #2358: this file reads auto-arm.yml's TEXT and drives `runArmPr` with an injected `run`; the literal `GH_TOKEN` in
// an assertion message is what charged it, and it never uses a token. Without this the row's own Acceptance
// command was REFUSED by the token-less acceptance job and verified nothing.
/**
 * #416: AUTO-ARM MUST ARM WITH A TOKEN WHOSE EVENTS FIRE.
 *
 * GitHub does not trigger workflows from events created with `GITHUB_TOKEN` -- a merge completed by
 * `github-actions[bot]` fires neither `pull_request: closed` nor a `push`, so `trunk-guard`, `close-rows`
 * and every push watchdog go silent for exactly the merges the pipeline itself performs (measured
 * 2026-09-08, 37 data points, no exceptions). Arming with a real PAT (`A11IGN_BOT_TOKEN`) instead means
 * the completed merge is attributed to that identity and every one of those triggers fires.
 *
 * Creating the token is NOT this row's job -- `ceo` asks the chairman for it. This file asserts the
 * WORKFLOW's own text, because the decision here is bash inside `auto-arm.yml`, not a separate script:
 * both `arm` (the per-PR trigger) and `sweep` (#344's queue sweep) must read the secret when present and
 * fall back to `GITHUB_TOKEN`, with a printed warning, when it is not -- so the pipeline keeps arming
 * before the token exists rather than stopping (#382's own lesson: a job that cannot do its intended work
 * must say which path it took).
 *
 * Scoped to EXACTLY these two jobs' own `run:` text, never the whole file -- C2 (#416's sibling) added a
 * THIRD job, `update-branch`, to this same workflow, and it prints its own `A11IGN_BOT_TOKEN is not set`
 * warning for a deliberately DIFFERENT reason (it skips outright rather than falling back -- see that
 * job's own comment). A whole-file regex count would have made this file's assertions couple to a job
 * this file is not about, and either broken a correct third job or hidden a real regression in the two
 * jobs this file actually specifies. See `auto-arm-update-branch.test.ts` for the third job's own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { parse as parseYaml } from "yaml";
import { SECRET_NAME, SECRET_HOLDER, PERSONAL_ACCOUNTS, NOT_CI_ACCOUNTS } from "./auto-arm-identity.ts";
import { runArmPr, EXIT, looksPoolRefused, refusalScope } from "../arm-pr.mjs";
import { shouldBeMerging, readUnarmed, greenUnarmedOrders, CAUSES }
  from "../work-gate.mjs";

const WORKFLOWS = join(HOME_CHECKOUT, ".github/workflows");
const WORKFLOW = join(WORKFLOWS, "auto-arm.yml");

/** @param {{ jobs: Record<string, { steps: Array<{ env?: Record<string,string>, run?: string }> }> }} doc */
function jobRunText(doc: { jobs: Record<string, { steps: Array<{ run?: string }> }> }, jobName: string): string {
  return (doc.jobs[jobName]?.steps ?? []).map((s) => s.run ?? "").join("\n");
}

test("both arm and sweep read A11IGN_BOT_TOKEN as an env var -- never as a CLI argument or echoed", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Array<{ env?: Record<string, string>, run?: string }> }>,
  };
  for (const jobName of ["arm", "sweep"]) {
    const steps = doc.jobs[jobName]?.steps ?? [];
    const withToken = steps.find((s) => s.env?.A11IGN_BOT_TOKEN === "${{ secrets.A11IGN_BOT_TOKEN }}");
    assert.ok(withToken, `${jobName} must read secrets.A11IGN_BOT_TOKEN through an env: mapping`);
    assert.ok(!(withToken?.run ?? "").includes("secrets.A11IGN_BOT_TOKEN"),
      `${jobName}'s run: script must never reference the secret directly -- only through the env var it `
      + "was mapped into, or the value risks appearing on a command line a log could capture");
  }
});

test("MUTATION TARGET: both jobs actually BRANCH on whether the token is set -- a present secret is used, "
  + "not merely read and ignored", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as Parameters<typeof jobRunText>[0];
  for (const jobName of ["arm", "sweep"]) {
    const branches = [...jobRunText(doc, jobName).matchAll(/if \[ -n "\$A11IGN_BOT_TOKEN" \]/g)];
    assert.equal(branches.length, 1, `expected exactly one such conditional in ${jobName}, found `
      + `${branches.length}`);
  }
});

test("the fallback prints a warning naming what breaks -- trunk.yml's closeRows, the watchdogs, "
  + "and #416 itself, so the next reader knows this path is temporary", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as Parameters<typeof jobRunText>[0];
  for (const jobName of ["arm", "sweep"]) {
    const warnings = [...jobRunText(doc, jobName).matchAll(/::warning::A11IGN_BOT_TOKEN is not set[^\n]*/g)];
    assert.equal(warnings.length, 1, `${jobName} must print exactly one fallback warning`);
    const [[warning]] = warnings;
    // THE NAMES ARE THE WORKFLOW'S CURRENT ONES, and they moved without this moving with them. The
    // warning used to say "trunk-guard" and "close-rows"; it now says "trunk.yml's closeRows ... and
    // trunkGate/trunkBuildTest/trunkRecheck chain", which is strictly more precise and names the jobs a
    // reader can actually go and look at. This asserted the old spellings and turned `main` red -- every
    // pull request inherited it, because `ts` runs this file.
    //
    // WHAT THIS TEST IS FOR is unchanged: the fallback must say WHAT BREAKS and WHERE TO READ ABOUT IT,
    // so nobody treats the GITHUB_TOKEN path as permanent. Asserting on the machinery by name is how it
    // checks that -- and a rename of that machinery is exactly when it should be re-read, not routed
    // around.
    assert.match(warning, /trunk\.yml/);
    assert.match(warning, /closeRows/);
    assert.match(warning, /watchdogs/);
    assert.match(warning, /#416/);
  }
});

test("the fallback token is GITHUB_TOKEN (github.token), never a hard-coded or absent value", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as {
    jobs: Record<string, { steps: Array<{ env?: Record<string, string> }> }>,
  };
  for (const jobName of ["arm", "sweep"]) {
    const steps = doc.jobs[jobName]?.steps ?? [];
    const fallbacks = steps.filter((s) => s.env?.FALLBACK_TOKEN === "${{ github.token }}");
    assert.equal(fallbacks.length, 1, `${jobName} must map github.token as the fallback exactly once`);
  }
});

test("A11IGN_BOT_TOKEN never appears as a bare CLI argument anywhere in the workflow", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  assert.doesNotMatch(text, /gh [^\n]*A11IGN_BOT_TOKEN/,
    "the token must reach `gh` only via the GH_TOKEN environment variable it reads automatically, never "
    + "as an explicit --token flag or similar, which would put the value on a process command line");
});

test("issues: write is NOT added for this -- #333 already measured that granting it changes nothing", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as { permissions: Record<string, string> };
  // The permission already exists for #298's own reason (a bot-merge case predating this fix) and this
  // test does not assert its absence -- only that this PR's own change did not ADD it a second time or
  // widen it further, which would be the "do not widen permissions to make something else easier" the
  // issue's own header warns against.
  assert.equal(doc.permissions.issues, "write");
  assert.equal(doc.permissions.contents, "write");
  assert.equal(doc.permissions["pull-requests"], "write");
  assert.equal(Object.keys(doc.permissions).length, 3,
    "no permission beyond the three already here (contents, pull-requests, issues) should have been "
    + "added for this token change");
});

// --- #2358: WHICH ACCOUNT HOLDS THE SECRET -- and where it lives --------------------------------------
//
// `A11IGN_BOT_TOKEN` was the chairman's PERSONAL token, so CI acted as `DanBeckDev`: 23 of the last 40
// merged PRs were completed by that account (read by `ceo`, 2026-09-24, from `mergedBy`), against the
// ruling that no agent acts as the chairman (#1950/#2333). The chairman swapped it 2026-09-24T19:54:17Z.
//
// WHAT HOLDS IT NOW, and it is a fact about GitHub's settings that no file in this repository can read:
//   - the account is `SECRET_HOLDER` (`auto-arm-identity.ts`), a machine account no session uses. NOT
//     `a11ign-bot` (the reviewer: the account that approves must not be the one that arms and completes the
//     merge, or `main`'s review requirement is decorative -- `.claude/rules/main-review-requirement.md`), and
//     not a session's identity (`a11ign-ai-workers`, `a11ign-ai-leads`), which would attribute CI's merges to
//     a session. The test below enforces the NAMING (the constant is a machine account); the live file
//     compares that same constant with who GitHub says acted.
//   - the secret is ORG-LEVEL. The repository-level copy was deleted on purpose, so there is one place to
//     manage it. A repository-level secret of the same name would SHADOW the org one (GitHub resolves the
//     narrower scope first), so a swap back to a person can be made at either level and only one of them
//     is where the chairman looks. THIS IS NOT ENFORCED ANYWHERE: reading a secret's scope needs admin, which
//     no session and no CI job here holds, so it is recorded as a claim and left out of the constants.
//
// WHAT A TEST CAN AND CANNOT DO ABOUT THAT. The secret's value never reaches the repo, so nothing here
// can read WHO holds it. What can be pinned is (1) the NAME every workflow step reads, so a rename that
// quietly moves CI onto a different credential is red, and (2) below, the constants naming who is
// EXPECTED to hold it, which `auto-arm-token-live.test.ts` reads back from GitHub's own timeline: an
// `auto_merge_enabled` or `merged` actor that is a person is a red test THERE. This file must stay
// token-free (the acceptance job has none), and the live read spawns `gh`, so it is a separate file.

/** Every `secrets.X` a workflow reads, so a step that reads a DIFFERENT secret is visible by name. */
function secretsRead(workflow: string): string[] {
  const text = readFileSync(join(WORKFLOWS, workflow), "utf8");
  return [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
}

test("#2358: the workflows that act as the arming identity read `secrets.A11IGN_BOT_TOKEN` and no other "
  + "credential, at the counts measured 2026-10-02 (auto-arm.yml 2, nightly.yml 2)", () => {
  // auto-arm.yml was 3 until #3046 deleted its `update-branch` job, the third reader (#3070).
  for (const [workflow, uses] of [["auto-arm.yml", 2], ["nightly.yml", 2]] as const) {
    assert.deepEqual(secretsRead(workflow), Array(uses).fill(SECRET_NAME),
      `${workflow} must read exactly ${uses} x secrets.${SECRET_NAME} and nothing else. A rename moves CI onto `
      + `another credential without a red test; \`${SECRET_HOLDER}\` holds ${SECRET_NAME} (#2358), so a `
      + "change of name is a change of who acts, and belongs on a row");
  }
});

test("#2358: the named holder is a machine account -- not a person, not the reviewer, not a session", () => {
  assert.ok(!PERSONAL_ACCOUNTS.includes(SECRET_HOLDER),
    `${SECRET_HOLDER} is a personal account: CI would act as the chairman again (#1950/#2333, #2358)`);
  assert.ok(!NOT_CI_ACCOUNTS.includes(SECRET_HOLDER),
    `${SECRET_HOLDER} is the reviewer's or a session's identity: the approver would arm and complete the merge, `
    + "or a session would be credited with CI's merges");
  // POSITIVE CONTROL for the two refusals above: the lists are not empty, so `!includes` is not vacuous, and
  // the holder is a real name rather than an empty string that no list contains.
  assert.ok(PERSONAL_ACCOUNTS.length > 0 && NOT_CI_ACCOUNTS.length > 0 && /^[\w-]+$/.test(SECRET_HOLDER));
});

test("#2358: trunk.yml no longer reads the arming secret -- the auto-revert path that used it is gone "
  + "(#2356), so the arming identity is not what trunk runs as", () => {
  assert.ok(!secretsRead("trunk.yml").includes(SECRET_NAME),
    "trunk.yml reads the arming secret again: that is the revert path #2356 removed, or a new use of an "
    + "identity that completes merges, and either belongs on a row before it lands");
  assert.ok(secretsRead("auto-arm.yml").length > 0,
    "POSITIVE CONTROL for the two assertions above: the reader finds the secret where it is known to be used");
});

// --- #1969: A TOKEN THAT IS SET BUT REFUSED IS NOT A TOKEN THAT WORKS -------------------------------
//
// The four tests above pin that both jobs BRANCH on whether `A11IGN_BOT_TOKEN` is SET. That branch was
// the whole of the token's story, and on 2026-09-22 it was measured to be the wrong question: the secret
// was set, the branch took the PAT path, and the PAT's GraphQL pool was exhausted from 18:45:53Z to
// 19:13:44Z. Every `pull_request` run of `auto-arm.yml` failed on `arm-pr.mjs`'s label read, and what it
// printed -- `could not read this PR's labels -- REFUSING to arm. Unreadable is not unheld` -- is TRUE,
// COMPLETE, and indistinguishable from the same refusal on a single unreadable pull request.
//
// #1958 and #1949 were approved, convinced, green on every job and `MERGEABLE` for the whole window, and
// NOTHING in the repository could arm either: `arm` and `sweep` are the only two things that arm, and
// both read the one refused credential. They were found because a session was woken about an unrelated
// red check and read the log.
//
// These drive the real entry points rather than asserting on source text -- the rule this file's own
// `MUTATION TARGET` test states, and `a-hold-means-cannot-merge.test.ts` records being caught by.

/** Drives `runArmPr` for #1958 with every `gh` call failing with `message`, capturing what it said. */
function driveRefusal(message: string, stdout?: string) {
  const lines: string[] = [];
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && stdout !== undefined) {
      throw Object.assign(new Error("gh: the pool refused this too"), { stdout });
    }
    throw new Error(message);
  };
  const code = runArmPr({
    argv: ["--pr=1958", "--repo=a11ign/a11ign"], env: {}, run: run as never,
    sleep: () => "ok" as const, log: (l: string) => lines.push(l), error: (l: string) => lines.push(l),
  });
  return { code, said: lines.join("\n"), calls };
}

const POOL_REFUSAL = "GraphQL: API rate limit already exceeded for user ID 46429371.";
const ONE_PR_REFUSAL = "GraphQL: Could not resolve to a PullRequest with the number 1958.";

/**
 * The real 403's own shape. Confirmed 2026-09-23 against a REAL refusal, which is what `ceo`'s ruling
 * required before anything relied on it: the unauthenticated core pool was driven to `403` and the
 * refusing response carried `x-ratelimit-remaining: 0` and `x-ratelimit-reset: 1790156710`. The same day,
 * `gh api ... -i` was confirmed to put the whole response on the thrown error's `stdout`. The reset below
 * is the real outage's own end -- 19:13:44Z, the minute #1958 and #1949 became armable again.
 */
const REFUSED_403 = "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\n"
  + "X-Ratelimit-Reset: 1758568424\r\nX-Ratelimit-Resource: graphql\r\n\r\n"
  + '{"message":"API rate limit exceeded for user ID 46429371."}';

test("#1969 ACCEPTANCE: a token that is SET but REFUSED says the outage is REPOSITORY-WIDE and names "
  + "the minute it returns -- read from X-Ratelimit-Reset on the 403, never inferred", () => {
  const { said } = driveRefusal(POOL_REFUSAL, REFUSED_403);
  assert.match(said, /REPOSITORY-WIDE/,
    "the refusal must say the outage is not about this pull request -- that is the whole defect");
  assert.match(said, /until 19:13Z/,
    "the return time is KNOWABLE, so ceo's ruling requires it NAMED rather than slept through");
  assert.match(said, /2025-09-22T19:13:44\.000Z/, "the absolute instant too -- a reader arriving later "
    + "cannot use a relative minute");
  assert.match(said, /#1969/, "and where to read about it");
});

test("#1969 CONTROL: an ordinary unreadable pull request claims NOTHING repository-wide, and buys no "
  + "probe -- the positive control for the assertion above", () => {
  const { said, calls } = driveRefusal(ONE_PR_REFUSAL);
  assert.doesNotMatch(said, /REPOSITORY-WIDE/i);
  assert.doesNotMatch(said, /until \d{2}:\d{2}/);
  assert.match(said, /SCOPE -- this is about #1958 alone/,
    "it says the opposite explicitly rather than going quiet: silence is what #1969 is about");
  assert.equal(calls.filter((c) => c[0] === "api").length, 0,
    "no pool probe is bought for a refusal that does not implicate the credential -- one point per 502 "
    + "would be a standing cost for an answer nobody needs");
});

test("#1969 MUTATION TARGET: the BEHAVIOUR is byte-identical across the two messages -- ceo's "
  + "constraint that no arming behaviour may branch on matched text", () => {
  const pool = driveRefusal(POOL_REFUSAL, REFUSED_403);
  const onePr = driveRefusal(ONE_PR_REFUSAL);
  assert.equal(pool.code, EXIT.CANNOT_ASK);
  assert.equal(onePr.code, EXIT.CANNOT_ASK,
    "`labels === null` refuses and exits 2 EITHER WAY -- the match may only choose the sentence");
  for (const { calls } of [pool, onePr]) {
    assert.equal(calls.filter((c) => c[0] === "pr" && c[1] === "merge").length, 0,
      "nothing was armed on either path: `Unreadable is not unheld` (#645) is untouched by this row");
    assert.equal(calls.filter((c) => c[0] === "pr" && c[1] === "edit").length, 0, "and nothing labelled");
  }
});

test("#1969: the reset is UNREADABLE rather than guessed when the probe brings no headers back", () => {
  const { said } = driveRefusal(POOL_REFUSAL);
  assert.match(said, /REPOSITORY-WIDE/, "the scope is still known -- it comes from the refusal, not the probe");
  assert.match(said, /could NOT read/, "and the minute is not");
  assert.doesNotMatch(said, /until \d{2}:\d{2}/,
    "an instrument that cannot answer must not answer: a guessed minute sends a reader to wait for a "
    + "return that is not coming (api-pool.mjs's own rule)");
});

test("#1969: the fingerprint is a FINGERPRINT -- it recognises GitHub's wording and nothing else", () => {
  assert.equal(looksPoolRefused("API rate limit already exceeded for user ID 46429371."), true);
  assert.equal(looksPoolRefused("You have exceeded a secondary rate limit"), true,
    "a secondary limit is also the credential refusing, not this pull request");
  assert.equal(looksPoolRefused("Could not resolve to a PullRequest with the number 1958."), false);
  assert.equal(looksPoolRefused("gh: HTTP 502"), false);
  assert.equal(looksPoolRefused(null), false, "and an absent message is not a pool refusal");
});

test("#1969: a pool with budget LEFT is reported as possibly SECONDARY -- the number is never dressed "
  + "up as an exhausted primary pool", () => {
  const said = refusalScope({
    number: "1958", poolRefused: true,
    pool: { remaining: 4_812, limit: 5_000, used: 188, resetInMinutes: 12,
      resource: "graphql", resetAt: "2026-09-22T19:13:44.000Z" },
  });
  assert.match(said, /SECONDARY limit/);
  assert.match(said, /4812 remaining/);
});

// --- #1969: AND THE REPORT THAT NAMES WHAT THE OUTAGE STRANDS ---------------------------------------
//
// `ceo`'s ruling, 2026-09-22: shape 3 only, "it lands as DATA in `work-gate.mjs`, not as a new red
// check", read "under `${{ github.token }}`, never the arming PAT". The gate runs on the agent host
// under the host's own `gh` identity -- measured 2026-09-23 as `a11ign-ai-workers`, while the arming PAT
// is `DanBeckDev`'s (user ID 46429371, the account the outage named) -- and never reads
// `A11IGN_BOT_TOKEN` at all, which exists only inside Actions. `stalled` is the standing proof that the
// separation is what matters: it ran green throughout the outage, on the same six runs.

const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];
const REQUIRED = ["gate"];

test("#1969: the gate's candidate filter is green, unheld and non-draft -- answered from the list it "
  + "already holds, which is what makes the queue read CONDITIONAL", () => {
  const prs = [
    { number: 1958, isDraft: false, labels: [], statusCheckRollup: GREEN },
    { number: 1949, isDraft: false, labels: [{ name: "session:worker-capture" }], statusCheckRollup: GREEN },
    { number: 1900, isDraft: true, labels: [], statusCheckRollup: GREEN },
    { number: 1901, isDraft: false, labels: [{ name: "hold:ceo" }], statusCheckRollup: GREEN },
    { number: 1902, isDraft: false, labels: [], statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }] },
    { number: 1903, isDraft: false, labels: [], statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS" }] },
  ];
  assert.deepEqual(shouldBeMerging(prs, REQUIRED), [1949, 1958],
    "a held PR is refused by the SAME predicate arm-pr and the sweep use (#645), a draft cannot be "
    + "armed at all, a red one is pr-checks-failing's, and a running one is not an answer yet");
  assert.deepEqual(shouldBeMerging([], REQUIRED), [],
    "POSITIVE CONTROL for the emptiness above: no candidates means no queue read is made at all");
});

test("#1969: a red NON-required check does not hide a stranded PR -- the outage itself reddens `sweep` "
  + "on every pull request it strands", () => {
  const prs = [{ number: 1958, isDraft: false, labels: [], statusCheckRollup: [
    { name: "gate", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "sweep", status: "COMPLETED", conclusion: "FAILURE" },
  ] }];
  assert.deepEqual(shouldBeMerging(prs, REQUIRED), [1958],
    "`gate` is the one required context on main, so this PR merges the moment something arms it");
  assert.deepEqual(shouldBeMerging(prs, null), [],
    "and with the required set UNREADABLE it counts every check, which is the existing fail-open rule "
    + "rather than a new one -- stated so the difference is deliberate");
});

test("#1969 ACCEPTANCE: the predicate is armedFromApi's THREE states, so a QUEUED PR is armed although "
  + "its autoMergeRequest reads null", () => {
  const nodes = [
    { number: 1958, isDraft: false, merged: false, autoMergeRequest: null, mergeQueueEntry: null },
    { number: 1949, isDraft: false, merged: false, autoMergeRequest: null,
      mergeQueueEntry: { state: "AWAITING_CHECKS" } },
    { number: 1940, isDraft: false, merged: false, autoMergeRequest: { enabledAt: "2026-09-22T18:00:00Z" },
      mergeQueueEntry: null },
  ];
  const run = () => JSON.stringify(nodes);
  assert.deepEqual(readUnarmed([1958, 1949, 1940], run), [1958],
    "ceo's ruling: the predicate is NOT `autoMergeRequest == null` -- a queued PR reads null (#1729/#2004)");
});

test("#1969: a refused queue read is `null`, never an empty all-clear -- and a candidate the query did "
  + "not return is dropped rather than reported", () => {
  const refuse = () => { throw new Error("GraphQL: API rate limit already exceeded"); };
  assert.equal(readUnarmed([1958], refuse), null, "#1286's rule: refused is not empty");
  assert.equal(readUnarmed([1958], () => "not json at all"), null);
  assert.equal(readUnarmed([1958], () => JSON.stringify({ message: "nope" })), null,
    "a shape that is not a node array is refused, not iterated");
  assert.deepEqual(readUnarmed([1958], () => JSON.stringify([])), [],
    "a candidate the read did not cover is UNKNOWN: reporting it would wake somebody to arm a pull "
    + "request nothing looked at");
  assert.deepEqual(readUnarmed([], refuse), [],
    "and with no candidates the read is never made, so it cannot be refused");
});

test("#1969 ACCEPTANCE: the order names every stranded PR, goes to product-manager, and is keyed on the "
  + "SET so it clears itself", () => {
  const [order] = greenUnarmedOrders([1958, 1949]);
  assert.equal(order.session, "product-manager", "routing: first reader for the queue and merge close-outs");
  assert.equal(order.cause, "pr-green-unarmed");
  assert.ok(CAUSES.includes("pr-green-unarmed"), "or worker-profile refuses it at run time");
  assert.match(order.prompt, /#1958, #1949/, "both, by number -- the shape is the finding");
  assert.match(order.prompt, /SCOPE/,
    "it points at arm-pr's own scope line, which is the one place that says whether this is one PR or all");
  assert.equal(order.causeKey, "product-manager/pr-green-unarmed/1958.1949",
    "keyed on the SET (fleetBatchOrders' rule): a count would collide two different pairs of PRs");
  assert.notEqual(greenUnarmedOrders([1958, 1949])[0].causeKey, greenUnarmedOrders([1958, 1940])[0].causeKey,
    "MUTATION TARGET: two different pairs of the same size must not share a key, or the second is "
    + "swallowed by the wake ledger's dedupe");
});

test("#1969: no order for a refused read and none for an empty one -- the two silences are different "
  + "states and neither may invent an alarm", () => {
  assert.deepEqual(greenUnarmedOrders(null), [], "refused: nothing is known, so nothing is claimed");
  assert.deepEqual(greenUnarmedOrders([]), [], "empty: every green unheld PR is armed, which is healthy");
});
