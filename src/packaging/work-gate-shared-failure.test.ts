// no-token: gh -- a fake `run` stands for `gh`; nothing reaches GitHub, git or herdr
/**
 * #5098: A FAILURE SHARED BY OPEN PULL REQUESTS MUST BE ONE THE PRs DID NOT CAUSE, and a hold is a reading of its incident row.
 *
 * THE DEFECT, 2026-10-11 14:04Z-16:05Z: eight `ci-shared-failure` incidents grouped red PRs whose failures were NOT the same failure. control#53 and control#58 each failed
 * ONE test of their own (`fleet-watch.test.ts`, `fleet-layer/entry-points.test.ts`), and were grouped because (a) the `gate` roll-up job fails on every red PR and prints one
 * script, and (b) the `checks` job's "first error line" was a pnpm `WARN Failed to create bin ...` line, identical on every PR. Closing the row then released nothing: the hold was
 * recomputed from the live reds, no OPEN row carried the marker, and a fresh row was filed. control#53's worker heard nothing for two hours.
 *
 * THE FIXTURES BELOW ARE THOSE JOBS' REAL LOGS (a11ign/control runs 38142093391 and 38145327395, `gh api repos/a11ign/control/actions/jobs/<id>/logs`), trimmed to the lines
 * that decide the signature and left byte-for-byte. Every test reaches the code from `sharedFailuresNow`, the gate's own call, with the same rollup shape the gate reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedFailuresNow } from "../work-gate.ts";
import { connectionOf, readsRowsByLabel, type FakeRow } from "./rows-by-label-fixtures.ts";

const NOW = Date.parse("2026-10-11T17:00:00Z");
const MINUTE = 60_000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const CHECKS_53 = [
  "\ufeff2026-10-11T13:10:15.4768302Z Current runner version: '2.337.0'",
  "2026-10-11T13:10:15.4793734Z ##[group]Runner Image Provisioner",
  "2026-10-11T13:10:30.5992054Z \u2009WARN\u2009 Failed to create bin at /home/runner/work/control/control/core/node_modules/.pnpm/@a11ign+judge@0.5.1_@a11ign+scorer@packages+scorer_@anthropic-ai+sdk@0.131.0/node_modules/@a11ign/judge/node_modules/.bin/a11ign-scorer-fetch-encoder. ENOENT: no such file or directory, open '/home/runner/work/control/control/core/node_modules/.pnpm/@a11ign+judge@0.5.1_@a11ign+scorer@packages+scorer_@anthropic-ai+sdk@0.131.0/node_modules/@a11ign/scorer/dist/fetch-encoder.mjs'",
  "2026-10-11T13:10:30.6823504Z \u2009WARN\u2009 Failed to create bin at /home/runner/work/control/control/core/packages/cli/node_modules/.bin/a11ign-scorer-fetch-encoder. ENOENT: no such file or directory, open '/home/runner/work/control/control/core/packages/scorer/dist/fetch-encoder.mjs'",
  "2026-10-11T13:10:52.1506209Z \u2716 930 problems (0 errors, 930 warnings)",
  "2026-10-11T13:11:34.6805921Z  \u001b[1m\u001b[31m\u2717\u001b[39m\u001b[22m \u001b[90mpackages/control/src/\u001b[39m\u001b[36mfleet-watch.test.ts\u001b[39m \u001b[90m(72)\u001b[39m",
  "2026-10-11T13:11:34.6808118Z   \u001b[31m\u2717\u001b[39m postUseOnce: a tick that lands WHILE the first is posting posts nothing (the day is reserved before the post, #53 review)\u001b[90m (39ms)\u001b[39m",
  "2026-10-11T13:13:30.8687351Z ",
  "2026-10-11T13:13:30.8687830Z \u001b[1mSummary of all failing tests:\u001b[22m",
  "2026-10-11T13:13:30.8688101Z ",
  "2026-10-11T13:13:30.8690463Z \u001b[41m\u001b[37m\u001b[1m FAIL \u001b[22m\u001b[39m\u001b[49m \u001b[90mpackages/control/src/\u001b[39m\u001b[36mfleet-watch.test.ts\u001b[39m \u001b[2m>\u001b[22m postUseOnce: a tick that lands WHILE the first is posting posts nothing (the day is reserved before the post, #53 review)",
  "2026-10-11T13:13:30.8692300Z \u001b[31m\u001b[1mAssertionError\u001b[22m\u001b[39m\u001b[31m: the racing tick found the day reserved",
  "2026-10-11T13:13:30.8693049Z + actual - expected",
  "2026-10-11T13:13:30.8693316Z ",
  "2026-10-11T13:13:30.8693478Z + 'posted'",
  "2026-10-11T13:13:30.8693849Z - 'in-progress'",
  "2026-10-11T13:13:30.8943419Z ",
  "2026-10-11T13:13:30.9394105Z JSON report written to: /home/runner/work/control/control/core/node_modules/.cache/rstest-run-records/core-2026-10-11T13-10-57-964Z-2972.json",
  "2026-10-11T13:13:31.0013304Z ##[error]Process completed with exit code 1.",
] as string[];
const CHECKS_58 = [
  "\ufeff2026-10-11T13:59:02.1396018Z Current runner version: '2.337.0'",
  "2026-10-11T13:59:02.1415783Z ##[group]Runner Image Provisioner",
  "2026-10-11T13:59:15.8842757Z \u2009WARN\u2009 Failed to create bin at /home/runner/work/control/control/core/node_modules/.pnpm/@a11ign+judge@0.5.1_@a11ign+scorer@packages+scorer_@anthropic-ai+sdk@0.131.0/node_modules/@a11ign/judge/node_modules/.bin/a11ign-scorer-fetch-encoder. ENOENT: no such file or directory, open '/home/runner/work/control/control/core/node_modules/.pnpm/@a11ign+judge@0.5.1_@a11ign+scorer@packages+scorer_@anthropic-ai+sdk@0.131.0/node_modules/@a11ign/scorer/dist/fetch-encoder.mjs'",
  "2026-10-11T13:59:15.9387711Z \u2009WARN\u2009 Failed to create bin at /home/runner/work/control/control/core/packages/cli/node_modules/.bin/a11ign-scorer-fetch-encoder. ENOENT: no such file or directory, open '/home/runner/work/control/control/core/packages/scorer/dist/fetch-encoder.mjs'",
  "2026-10-11T13:59:34.5068974Z \u2716 912 problems (0 errors, 912 warnings)",
  "2026-10-11T14:00:33.7865291Z  \u001b[1m\u001b[31m\u2717\u001b[39m\u001b[22m \u001b[90mpackages/control/src/fleet-layer/\u001b[39m\u001b[36mentry-points.test.ts\u001b[39m \u001b[90m(7)\u001b[39m",
  "2026-10-11T14:00:33.7867641Z   \u001b[31m\u2717\u001b[39m #1086 RATCHET: the plain-form population may shrink and may not grow\u001b[90m (335ms)\u001b[39m",
  "2026-10-11T14:01:36.5293813Z ",
  "2026-10-11T14:01:36.5294261Z \u001b[1mSummary of all failing tests:\u001b[22m",
  "2026-10-11T14:01:36.5294853Z ",
  "2026-10-11T14:01:36.5314447Z \u001b[41m\u001b[37m\u001b[1m FAIL \u001b[22m\u001b[39m\u001b[49m \u001b[90mpackages/control/src/fleet-layer/\u001b[39m\u001b[36mentry-points.test.ts\u001b[39m \u001b[2m>\u001b[22m #1086 RATCHET: the plain-form population may shrink and may not grow",
  "2026-10-11T14:01:36.5324128Z \u001b[31m\u001b[1mAssertionError\u001b[22m\u001b[39m\u001b[31m: these declare an entry guard in the symlink-blind form and are not in the baseline:",
  "2026-10-11T14:01:36.5324868Z   packages/control/src/fleet-converge.ts",
  "2026-10-11T14:01:36.5326760Z Use import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : \"\").href \u2014 reaching a file through a symlink (npm's .bin, npx's tmpdir staging, or macOS's /tmp -> /private/tmp) otherwise skips main() and exits 0, with no error and no output.",
  "2026-10-11T14:01:36.5328106Z + actual - expected",
  "2026-10-11T14:01:36.5328309Z ",
  "2026-10-11T14:01:36.5328415Z + [",
  "2026-10-11T14:01:36.5402199Z ",
  "2026-10-11T14:01:36.5733287Z JSON report written to: /home/runner/work/control/control/core/node_modules/.cache/rstest-run-records/core-2026-10-11T13-59-38-885Z-2709.json",
  "2026-10-11T14:01:36.6243561Z ##[error]Process completed with exit code 1.",
] as string[];
const GATE = [
  "\ufeff2026-10-11T13:13:37.5241927Z Current runner version: '2.337.0'",
  "2026-10-11T13:13:37.5262319Z ##[group]Runner Image Provisioner",
  "2026-10-11T13:13:37.6738267Z \u001b[36;1m  if [ \"$result\" != \"success\" ]; then\u001b[0m",
  "2026-10-11T13:13:37.6739472Z \u001b[36;1m    echo \"::error::a job reported '$result', not success\"\u001b[0m",
  "2026-10-11T13:13:37.6740658Z \u001b[36;1m    exit 1\u001b[0m",
  "2026-10-11T13:13:37.6741386Z \u001b[36;1m  fi\u001b[0m",
  "2026-10-11T13:13:37.6742065Z \u001b[36;1mdone\u001b[0m",
  "2026-10-11T13:13:38.1357591Z shell: /usr/bin/bash -e {0}",
  "2026-10-11T13:13:38.1358369Z env:",
  "2026-10-11T13:13:38.1358837Z   CORE_REF: b6d3cbd7616dd68d52726a5c63201f453d0ead62",
  "2026-10-11T13:13:38.1359403Z ##[endgroup]",
  "2026-10-11T13:13:38.1562373Z ##[error]a job reported 'failure', not success",
  "2026-10-11T13:13:38.1575045Z ##[error]Process completed with exit code 1.",
  "2026-10-11T13:13:38.1697278Z Cleaning up orphan processes",
] as string[];

type Job = { failed: string; log: string };
const checksJob = (failed: string, ...lines: string[]): Job => ({ failed, log: lines.join("\n") });
const RSTEST = 'Run pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/**/*.test.ts"';
const ROLL_UP = "Every job ran, and ran clean";

const jobUrl = (repo: string, job: number) => `https://github.com/${repo}/actions/runs/${job + 1000}/job/${job}`;
const failing = (repo: string, name: string, job: number) => ({ name, conclusion: "FAILURE", status: "COMPLETED", detailsUrl: jobUrl(repo, job), completedAt: at(30 * MINUTE) });
/** An open PR as the gate's `prs` carry it: `repoKey` names a repository that is not the primary's. */
const pr = (repoKey: string, number: number, checks: ReturnType<typeof failing>[]) =>
  ({ repoKey, number, repo: `a11ign/${repoKey}`, statusCheckRollup: checks });
const order = (repoKey: string, number: number, session: string) =>
  ({ cause: "pr-checks-failing", subject: `pr-${repoKey}#${number}`, session, discriminator: "red", prompt: "A CHECK IS RED." });

/** A `gh` fake: jobs by id, changed files by PR, incident rows by state; every write is recorded. */
function fakeGh({ jobs = {}, changed = {}, rows = [] }: { jobs?: Record<number, Job>; changed?: Record<number, string[]>; rows?: FakeRow[] } = {}) {
  const writes: string[][] = [];
  const store = rows.map((row) => ({ ...row }));
  const run = (args: string[]): string => {
    const read = readsRowsByLabel(args);
    if (read !== null) return connectionOf(store.filter((r) => String(r.state).toUpperCase() === read.state));
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const job = /actions\/jobs\/(\d+)(\/logs)?$/.exec(path);
    if (job !== null) {
      const found = jobs[Number(job[1])];
      if (found === undefined) throw new Error("404");
      return job[2] === undefined ? JSON.stringify({ steps: [{ name: "Set up job", conclusion: "success" }, { name: found.failed, conclusion: "failure" }] }) : found.log;
    }
    const files = /pulls\/(\d+)\/files/.exec(path);
    if (files !== null) return JSON.stringify((changed[Number(files[1])] ?? ["README.md"]).map((filename) => ({ filename })));
    if (/pulls\/\d+$/.test(path)) return JSON.stringify({ state: "open", head: { sha: "abc" }, base: { ref: "main" } });
    // #5405: the Project-membership read a board write makes first. No fixture issue is on the board, so each boarding adds it.
    if (args.includes("graphql") && args.some((a) => a.includes("projectItems"))) return JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    writes.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      store.push({ number: 900 + store.length, state: "OPEN", createdAt: at(0), body: args[args.indexOf("--body") + 1], labels: ["ci-shared-failure"] });
      return "https://github.com/a11ign/a11ign/issues/900";
    }
    return "";
  };
  return { run, writes, store };
}
const tick = (orders: object[], prs: object[], g: ReturnType<typeof fakeGh>) => sharedFailuresNow(orders, prs, { run: g.run, nowMs: NOW }) as { subject: string; prompt: string; session: string }[];
const subjects = (orders: { subject: string }[]) => orders.map((o) => o.subject);
const filed = (g: ReturnType<typeof fakeGh>) => g.writes.filter((w) => w[0] === "issue" && w[1] === "create").length;

/** control#53 and control#58 exactly as the gate saw them: a `checks` job with its own failing test, and the `gate` roll-up. */
const control = () => ({
  jobs: { 1: checksJob(RSTEST, ...CHECKS_53), 2: checksJob(RSTEST, ...CHECKS_58), 3: checksJob(ROLL_UP, ...GATE), 4: checksJob(ROLL_UP, ...GATE) },
  prs: [pr("control", 53, [failing("a11ign/control", "checks", 1), failing("a11ign/control", "gate", 3)]),
    pr("control", 58, [failing("a11ign/control", "checks", 2), failing("a11ign/control", "gate", 4)])],
  orders: [order("control", 53, "worker-5016"), order("control", 58, "worker-5023")],
});

test("#5098 THE REAL LOGS: control#53 and control#58 fail different tests of their own, so neither is held and no incident is filed", () => {
  const { jobs, prs, orders } = control();
  const g = fakeGh({ jobs, changed: { 53: ["packages/control/src/fleet-watch.test.ts"], 58: ["packages/control/src/fleet-converge.ts"] } });
  assert.deepEqual(subjects(tick(orders, prs, g)), ["pr-control#53", "pr-control#58"]);
  assert.equal(filed(g), 0, "no incident row");
  assert.deepEqual(g.writes, [], "nothing is written");
});

test("#5098 THE ROLL-UP: PRs whose only common line is the `gate` job's are not grouped, even when its log is the only one read", () => {
  const { jobs, orders } = control();
  const prs = [pr("control", 53, [failing("a11ign/control", "gate", 3)]), pr("control", 58, [failing("a11ign/control", "gate", 4)])];
  const g = fakeGh({ jobs });
  assert.deepEqual(subjects(tick(orders, prs, g)), ["pr-control#53", "pr-control#58"]);
  assert.equal(filed(g), 0);
  // the roll-up under another name is still no cause: it is recognised by the step it fails and the line its script prints
  const renamed = [pr("control", 53, [failing("a11ign/control", "ci-ok", 3)]), pr("control", 58, [failing("a11ign/control", "ci-ok", 4)])];
  assert.deepEqual(subjects(tick(orders, renamed, fakeGh({ jobs }))), ["pr-control#53", "pr-control#58"]);
});

test("#5098 A WARNING IS NOT THE FAILURE: two PRs whose logs share only a package manager's `WARN` line are not grouped", () => {
  const warn = "2026-10-11T13:10:30.5992054Z  WARN  Failed to create bin at /home/runner/work/control/control/core/node_modules/.bin/a11ign. ENOENT: no such file or directory";
  const exit = "2026-10-11T13:13:31.0013304Z ##[error]Process completed with exit code 1.";
  const jobs = { 1: checksJob(RSTEST, warn, exit), 2: checksJob(RSTEST, warn, exit) };
  const prs = [pr("control", 53, [failing("a11ign/control", "checks", 1)]), pr("control", 58, [failing("a11ign/control", "checks", 2)])];
  const g = fakeGh({ jobs });
  assert.deepEqual(subjects(tick(control().orders, prs, g)), ["pr-control#53", "pr-control#58"]);
  assert.equal(filed(g), 0);
});

const SAME_TEST = "2026-10-11T13:13:30.8690463Z  FAIL  packages/control/src/shared.test.ts > the registry answers";
const SAME_FILES = { jobs: { 1: checksJob(RSTEST, SAME_TEST), 2: checksJob(RSTEST, SAME_TEST) } };
const bothRed = [pr("control", 61, [failing("a11ign/control", "checks", 1)]), pr("control", 62, [failing("a11ign/control", "checks", 2)])];
const bothOrders = [order("control", 61, "worker-61"), order("control", 62, "worker-62")];

test("#5098 OUTSIDE THE DIFF: two PRs failing the SAME test in a file neither changes ARE grouped, and a failure in a file a PR changes never is", () => {
  const outside = fakeGh({ ...SAME_FILES, changed: { 61: ["docs/a.md"], 62: ["docs/b.md"] } });
  assert.deepEqual(tick(bothOrders, bothRed, outside), [], "the shared failure wakes nobody");
  assert.equal(filed(outside), 1, "and is ONE incident");
  // one PR changes the file's source (`shared.ts` is what `shared.test.ts` covers): it is its own failure, and a group of one is no group
  const touched = fakeGh({ ...SAME_FILES, changed: { 61: ["packages/control/src/shared.ts"], 62: ["docs/b.md"] } });
  assert.deepEqual(subjects(tick(bothOrders, bothRed, touched)), ["pr-control#61", "pr-control#62"]);
  assert.equal(filed(touched), 0);
  // the diff cannot be read: the failure is not SHOWN to be outside it
  const unread = fakeGh(SAME_FILES);
  unread.run = ((run) => (args: string[]) => (/\/files/.test(args.join(" ")) ? (() => { throw new Error("403"); })() : run(args)))(unread.run);
  assert.deepEqual(subjects(tick(bothOrders, bothRed, unread)), ["pr-control#61", "pr-control#62"]);
});

const INSTALL = "2026-10-11T09:42:11.123Z ##[error]npm ERR! 404 Not Found - GET https://registry/agent-org-0.155.4.tgz";
const SETUP = { jobs: { 1: checksJob("Install agent-org", INSTALL), 2: checksJob("Install agent-org", INSTALL) } };

test("#5098 SETUP: two PRs failing the same install step ARE grouped, whatever they change", () => {
  const g = fakeGh({ ...SETUP, changed: { 61: ["package.json"], 62: ["pnpm-lock.yaml"] } });
  assert.deepEqual(tick(bothOrders, bothRed, g), []);
  assert.equal(filed(g), 1);
});

const rowFor = (g: ReturnType<typeof fakeGh>) => g.store[0];

test("#5098 CLOSING THE INCIDENT RELEASES THE HOLDS AT ONCE, and the signature is not filed again for 24h", () => {
  const first = fakeGh(SETUP);
  assert.deepEqual(tick(bothOrders, bothRed, first), []);
  const body = String(rowFor(first).body);
  // the row is closed (not boarded): the very next tick delivers both orders, and files nothing
  const closed = fakeGh({ ...SETUP, rows: [{ number: 900, state: "CLOSED", createdAt: at(40 * MINUTE), closedAt: at(1 * MINUTE), body, labels: ["ci-shared-failure"] }] });
  const out = tick(bothOrders, bothRed, closed);
  assert.deepEqual(subjects(out), ["pr-control#61", "pr-control#62"]);
  assert.match(out[0].prompt, /HOLD RELEASED \(#900: its incident row was closed\)/);
  assert.match(out[0].prompt, /Install agent-org/);
  assert.equal(filed(closed), 0, "and no second row is filed for the same signature");
  // a day later it may be filed again
  const stale = fakeGh({ ...SETUP, rows: [{ number: 900, state: "CLOSED", createdAt: at(40 * 60 * MINUTE), closedAt: at(25 * 60 * MINUTE), body, labels: ["ci-shared-failure"] }] });
  assert.deepEqual(tick(bothOrders, bothRed, stale), []);
  assert.equal(filed(stale), 1);
  // a PR the closed row never named joins with the same signature: that IS a new incident
  const third = [...bothRed, pr("control", 63, [failing("a11ign/control", "checks", 3)])];
  const joined = fakeGh({ jobs: { ...SETUP.jobs, 3: SETUP.jobs[1] }, rows: [{ number: 900, state: "CLOSED", createdAt: at(40 * MINUTE), closedAt: at(1 * MINUTE), body, labels: ["ci-shared-failure"] }] });
  assert.deepEqual(tick([...bothOrders, order("control", 63, "worker-63")], third, joined), []);
  assert.equal(filed(joined), 1);
});

test("#5098 A HOLD WAITS FOR ITS ROW (#1557): past 15 minutes, an open row still holds its PRs until it closes, claimed or not", () => {
  const first = fakeGh(SETUP);
  tick(bothOrders, bothRed, first);
  const body = String(rowFor(first).body);
  const row = (ageMin: number, labels: string[]): FakeRow => ({ number: 900, state: "OPEN", createdAt: at(ageMin * MINUTE), body, labels });
  const young = fakeGh({ ...SETUP, rows: [row(14, ["ci-shared-failure"])] });
  assert.deepEqual(tick(bothOrders, bothRed, young), [], "14 minutes: still held");
  const old = fakeGh({ ...SETUP, rows: [row(16, ["ci-shared-failure"])] });
  assert.deepEqual(tick(bothOrders, bothRed, old), [], "16 minutes, unclaimed: still held, no worker is woken");
  const claimed = fakeGh({ ...SETUP, rows: [row(16, ["ci-shared-failure", "in-progress", "session:worker-9"])] });
  assert.deepEqual(tick(bothOrders, bothRed, claimed), [], "16 minutes but CLAIMED: held");
  assert.equal(filed(claimed) + filed(old), 0, "an open row is joined, never refiled");
});

test("#5098 A HOLD WITH NO ROW BEHIND IT IS NOT A HOLD: when the incident row cannot be filed the orders go out", () => {
  const g = fakeGh(SETUP);
  const refusing = (args: string[]) => (args[0] === "issue" && args[1] === "create" ? (() => { throw new Error("rate limited"); })() : g.run(args));
  const out = sharedFailuresNow(bothOrders, bothRed, { run: refusing, nowMs: NOW, }) as { subject: string }[];
  assert.deepEqual(subjects(out), ["pr-control#61", "pr-control#62"]);
});
