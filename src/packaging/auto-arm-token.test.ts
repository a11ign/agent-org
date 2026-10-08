// no-token: GH_TOKEN
// #2358: this file reads auto-arm.yml's TEXT and drives `runArmPr` with an injected `run`; the literal `GH_TOKEN` in
// an assertion message is what charged it, and it never uses a token. Without this the row's own Acceptance
// command was REFUSED by the token-less acceptance job and verified nothing.
/**
 * #416 / #4200: AUTO-ARM MUST ARM WITH A TOKEN WHOSE EVENTS FIRE, AND THAT TOKEN IS MINTED, NOT STORED.
 *
 * GitHub does not trigger workflows from events created with `GITHUB_TOKEN` -- a merge completed by
 * `github-actions[bot]` fires neither `pull_request: closed` nor a `push`, so `trunk-guard`, `close-rows`
 * and every push watchdog go silent for exactly the merges the pipeline itself performs (measured
 * 2026-09-08, 37 data points, no exceptions). Arming with a real identity instead means the completed merge is
 * attributed to that identity and every one of those triggers fires.
 *
 * Until #4198 that identity was a stored PAT (`A11IGN_BOT_TOKEN`) and this file pinned that both jobs read it and
 * FELL BACK to `GITHUB_TOKEN` with a warning. It is now the Octo STS GitHub App, minted per job by `octo-sts/action`
 * against `.github/chainguard/auto-arm.sts.yaml`, and a stored-token read put back is what this file now refuses.
 * What it pins, and the guarantee each pin carries (#4200):
 *   1. the token reaches the repository on the write side  -> the policy's grant, and a mint that is a red step
 *      at the point of use (no fallback), so a token that does not reach is not a quiet degradation;
 *   2. the arming token is the one that fires events       -> `arm` and `sweep` act with the MINTED token only,
 *      and the `GITHUB_TOKEN` fallback that restores #416's defect is absent;
 *   3. no stored token                                     -> no workflow reads one, bar the named gap.
 * Whether a merge it arms really fires `close-rows` is measured on a real merge (#4198, Done-when 2), never here.
 *
 * Scoped to EXACTLY the `arm` and `sweep` jobs' own steps, never the whole file: `auto-arm-update-branch.test.ts`
 * and the other workflows have their own jobs and their own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { parse as parseYaml } from "yaml";
import { runArmPr, EXIT, looksPoolRefused, refusalScope } from "../arm-pr.mjs";
import { shouldBeMerging, readUnarmed, greenUnarmedOrders, CAUSES }
  from "../work-gate.mjs";

const WORKFLOWS = join(HOME_CHECKOUT, ".github/workflows");
const WORKFLOW = join(WORKFLOWS, "auto-arm.yml");
const POLICY = join(HOME_CHECKOUT, ".github/chainguard/auto-arm.sts.yaml");

/** The jobs that arm, and so the only ones that mint the arming token. */
const ARMING_JOBS = ["arm", "sweep"];

/** The stored tokens the Octo STS rows (#4194 to #4198) replace; the end state is that no workflow reads either. */
const STORED_TOKENS = ["A11IGN_BOT_TOKEN", "ORG_SECRETS_READ_TOKEN"];

/**
 * THE NAMED GAP: workflow -> the stored tokens it still reads, each with the row that ends it. `nightly.yml`'s ruleset read has to
 * ask AS the identity that completes a merge here and across nine repositories (#4195). When that row lands the entry goes, and this
 * test is RED until it does: a gap that closed and stayed listed would let the next stored read in unnoticed.
 */
const NAMED_GAPS: Record<string, string[]> = { "nightly.yml": ["A11IGN_BOT_TOKEN"] };

type Step = { id?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string>; run?: string };
type Job = { permissions?: Record<string, string>; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

const parseWorkflow = (text: string): Workflow => parseYaml(text) as Workflow;
const armingJob = (name: string): Job => parseWorkflow(readFileSync(WORKFLOW, "utf8")).jobs[name] ?? {};
const MINTED = "${{ steps.octo-sts.outputs.token }}";

test("arm and sweep each mint the arming token with octo-sts/action and read it in the one step that acts, never in a run: script", () => {
  for (const jobName of ARMING_JOBS) {
    const job = armingJob(jobName);
    const steps = job.steps ?? [];
    assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" },
      `${jobName} holds contents: read and id-token: write (the request Octo STS needs) and nothing more; the writes come from the minted token`);
    const mints = steps.flatMap((step, index) => step.uses?.startsWith("octo-sts/action@") ? [{ step, index }] : []);
    assert.equal(mints.length, 1, `${jobName} must mint exactly once, found ${mints.length}`);
    const [{ step: mint, index: mintAt }] = mints;
    assert.match(mint.uses ?? "", /^octo-sts\/action@[0-9a-f]{40}$/, `${jobName}: the Action is pinned to a commit (the version rides in a comment)`);
    assert.equal(mint.id, "octo-sts");
    assert.equal(mint.with?.identity, "auto-arm", `${jobName}: the identity names the policy file auto-arm.sts.yaml`);
    assert.equal(mint.with?.scope, "${{ github.repository }}", `${jobName}: the token is scoped to this repository`);
    const readers = steps.flatMap((step, index) => Object.values(step.env ?? {}).includes(MINTED) ? [{ step, index }] : []);
    assert.equal(readers.length, 1, `${jobName}: one step reads the minted token, and it is the step that arms`);
    assert.ok(readers[0].index > mintAt, `${jobName}: the token is minted before it is read`);
    assert.equal(readers[0].step.env?.GH_TOKEN, MINTED, `${jobName}: it reaches \`gh\` as GH_TOKEN, the variable it reads by itself`);
    assert.doesNotMatch(readers[0].step.run ?? "", /octo-sts|secrets\./, `${jobName}: the run: script names neither the mint nor a secret, so the value cannot reach a command line`);
  }
});

/** The text a fallback to the token that fires nothing would leave in a job: #416's defect, restored quietly. */
const FALLBACK = /FALLBACK_TOKEN|github\.token|secrets\.GITHUB_TOKEN|GH_TOKEN:\s*\$\{\{\s*github\./;
const jobText = (job: Job): string => JSON.stringify(job);

test("NO FALLBACK: neither arming job can arm with GITHUB_TOKEN, because that is the token whose merges fire no event (#416)", () => {
  for (const jobName of ARMING_JOBS) {
    assert.doesNotMatch(jobText(armingJob(jobName)), FALLBACK, `${jobName} falls back to a token that fires nothing`);
  }
  // POSITIVE CONTROL: the scan finds the PAT-era shape, so a clean result above is not a pattern that matches nothing.
  const patEra: Job = { steps: [{ env: { FALLBACK_TOKEN: "${{ github.token }}" }, run: 'if [ -n "$A11IGN_BOT_TOKEN" ]; then :; fi' }] };
  assert.match(jobText(patEra), FALLBACK);
  assert.match(jobText({ steps: [{ env: { GH_TOKEN: "${{ github.token }}" } }] }), FALLBACK);
});

test("the policy grants the arm and the merge on this repository and nothing else, to the workflow as on main", () => {
  const policy = parseYaml(readFileSync(POLICY, "utf8")) as { issuer?: string; repositories?: unknown; permissions?: Record<string, string>; claim_pattern?: Record<string, string> };
  assert.deepEqual(policy.permissions, { pull_requests: "write", contents: "write" },
    "pull-request write (enable auto-merge) and contents write (the merge itself); `issues` is not needed (#333: native `Closes #N` closure is the merging identity's)");
  assert.equal(policy.repositories, undefined, "a repository policy reaches its own repository and says nothing wider");
  assert.equal(policy.issuer, "https://token.actions.githubusercontent.com");
  assert.match(policy.claim_pattern?.job_workflow_ref ?? "", /auto-arm\\\.yml@refs\/heads\/main$/,
    "bound to auto-arm.yml AS ON main, so a branch that edits it cannot mint");
  assert.match(policy.claim_pattern?.event_name ?? "", /^pull_request_target\|push\|workflow_dispatch$/, "the three triggers the minting jobs run on, and not `pull_request`");
});

/** The stored tokens each workflow reads on a LIVE line: a comment that names one, and `secrets: inherit`, are not reads. */
function storedReads(text: string): string[] {
  const live = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  return [...live.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).filter((name) => STORED_TOKENS.includes(name));
}

function storedReadsByWorkflow(read: (name: string) => string, names: string[]): Record<string, string[]> {
  const found = names.map((name) => [name, storedReads(read(name))] as const).filter(([, reads]) => reads.length > 0);
  return Object.fromEntries(found);
}

test("no workflow reads a stored token, bar the named gap -- and a read put back anywhere else is red (#4200)", () => {
  const names = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(names.includes("auto-arm.yml") && names.includes("trunk.yml"), "POSITIVE CONTROL: the walk sees the workflows it is about");
  assert.deepEqual(storedReadsByWorkflow((name) => readFileSync(join(WORKFLOWS, name), "utf8"), names), NAMED_GAPS,
    "a stored token is read somewhere not named (move it to Octo STS, or name the gap with its row), or a named gap closed and must leave NAMED_GAPS");
  // POSITIVE CONTROL for the emptiness above: the same scan DOES find a live read, and does not count a comment or `secrets: inherit`.
  const fixture: Record<string, string> = {
    "reader.yml": "jobs:\n  j:\n    env:\n      GH_TOKEN: ${{ secrets.A11IGN_BOT_TOKEN }}\n",
    "org.yml": "jobs:\n  j:\n    env:\n      T: ${{ secrets.ORG_SECRETS_READ_TOKEN }}\n",
    "quiet.yml": "# was ${{ secrets.A11IGN_BOT_TOKEN }}\njobs:\n  j:\n    secrets: inherit\n    env:\n      T: ${{ secrets.GITHUB_TOKEN }}\n",
  };
  assert.deepEqual(storedReadsByWorkflow((name) => fixture[name], Object.keys(fixture)),
    { "reader.yml": ["A11IGN_BOT_TOKEN"], "org.yml": ["ORG_SECRETS_READ_TOKEN"] });
});

test("issues: write is NOT added for this -- #333 already measured that granting it changes nothing", () => {
  const doc = parseYaml(readFileSync(WORKFLOW, "utf8")) as { permissions: Record<string, string> };
  // The permission already exists for #298's own reason (a bot-merge case predating this fix) and this
  // test does not assert its absence -- only that no change ADDED it a second time or widened it further,
  // which would be the "do not widen permissions to make something else easier" the issue's own header warns against.
  assert.equal(doc.permissions.issues, "write");
  assert.equal(doc.permissions.contents, "write");
  assert.equal(doc.permissions["pull-requests"], "write");
  assert.equal(Object.keys(doc.permissions).length, 3,
    "no permission beyond the three already here (contents, pull-requests, issues) should have been "
    + "added for this token change");
});

// --- #1969: A TOKEN THAT IS SET BUT REFUSED IS NOT A TOKEN THAT WORKS -------------------------------
//
// The PAT-era tests that stood above (#4200 replaced them) pinned that both jobs BRANCH on whether `A11IGN_BOT_TOKEN`
// is SET. That branch was the whole of the token's story, and on 2026-09-22 it was measured to be the wrong question: the secret
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
