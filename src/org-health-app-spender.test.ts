// no-token: gh -- ledgers are files this test writes under a scratch directory; no `gh` starts and nothing reaches the network or any account's config.
//
// #4916: `api-pool-low` NAMES AN APP'S CALLS. A pool read off an App's token reports the login `<slug>[bot]`, and `host/gh` ledgers that App's calls under
// `app:<role>`, so the filter by the pool's login matched nothing and the sentence read "no graphql point is recorded" over a ledger holding 2,320 of them. And the
// reader looked in ONE config directory, where the scheduler's calls are in the workers'. Each case carries its control: the positive names a caller and the
// negatives are the same ledger with the identity moved or a directory unreadable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerAccountOf, parseLedger, spenderPhraseFor, topSpender } from "./gh-ledger.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

// `org-health.ts` resolves the checkout it serves when it is imported (`org-health-auto-off-refusal.test.ts` says why): the host file is set FIRST, the tool imported AFTER it.
const SCRATCH = tmpDirForFile("org-health-app-spender-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST = {
  schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] },
  github: { identity: {
    scheduler: { mode: "github-apps", appId: 1, installationId: 11, keyPath: join(SCRATCH, "scheduler.pem") },
    workers: { mode: "github-apps", appId: 2, installationId: 22, keyPath: join(SCRATCH, "workers.pem") },
  } },
};
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify(HOST));
process.env.AGENT_ORG_HOST = HOST_FILE;
const WORKERS_DIR = join(SCRATCH, "workers", "gh");
const LEADS_DIR = join(SCRATCH, "leads", "gh");
process.env.GH_CONFIG_DIR = WORKERS_DIR; // what a11ign-work-tick.service declares: the gate's own directory IS the workers'
const { ledgerPathsOf, ledgerSpender, poolLowReading, reviewerGhDir, spenderOfAccount } = await import("./org-health.ts");
const { REVIEWER_GH_CONFIG_DIR } = await import("./wake.ts");
const { parseHostConfig } = await import("./host-config.ts");

const HOST_CONFIG = parseHostConfig(JSON.stringify(HOST));
const SCHEDULER_BOT = "a11ign-scheduler[bot]";
const TICK = "/usr/bin/node /x/src/work-tick.ts";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
/** One ledger line as `host/gh` writes it (nine fields). */
const line = (account: string, { ago = 5, command = "issue list", caller = TICK } = {}) => [minutesAgo(ago), account, "graphql", "", "0", command, "-", caller, "-"].join("\t");
const ledgerOf = (dir: string, lines: string[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "gh-calls.tsv"), `${lines.join("\n")}\n`); };
const poolOf = (account: string) => [{ account, resource: "graphql", remaining: 920, limit: 5000, resetAt: "2026-10-11T00:00:00Z" }];
const spenderDetail = (account: string) => poolLowReading({ pools: poolOf(account) }).detail.split(". Spender: ")[1];

test("#4916: a [bot] pool is read from the app:<role> lines, which the pool's own login never matched", () => {
  const lines = [line("app:scheduler"), line("app:scheduler"), line("app:scheduler", { command: "pr list", caller: "/usr/bin/node /x/src/work-gate.ts" })];
  ledgerOf(WORKERS_DIR, lines);
  const now = Date.now();
  assert.equal(topSpender(parseLedger(lines.join("\n")), { account: SCHEDULER_BOT, now }), null, "CONTROL: filtered by the login, as it was, the ledger reads as nobody's");
  assert.equal(topSpender(parseLedger(lines.join("\n")), { account: "app:scheduler", now })?.total, 3, "CONTROL: the lines ARE there, under the role's name");
  assert.match(spenderDetail(SCHEDULER_BOT), /^a11ign-scheduler\[bot\]'s last hour \(3 floor points, read from app:scheduler ledger lines; the pool's own used points are 4080 and the ledger accounts for 0% of them, under 90%, so 4077 points were spent by calls this ledger does not hold\): top caller work-tick\.ts \[issue list\], 2 points \(67%\)$/);
});

test("#4916: 'no graphql point is recorded' needs every ledger read, and an unread one is UNREADABLE", () => {
  ledgerOf(WORKERS_DIR, [line("app:nobody")]); // the lines are under a role no declaration owns
  ledgerOf(LEADS_DIR, []);
  assert.equal(spenderDetail(SCHEDULER_BOT), "no graphql point is recorded for a11ign-scheduler[bot] in the last hour", "every ledger was read and none holds the role");
  mkdirSync(join(LEADS_DIR, "gh-calls.tsv.d"), { recursive: true });
  writeFileSync(join(LEADS_DIR, "gh-calls.tsv"), ""); // readable again for the cases below
  const unreadable = spenderPhraseFor({ ledgers: [join(WORKERS_DIR, "gh-calls.tsv"), join(LEADS_DIR, "gh-calls.tsv.d")], login: SCHEDULER_BOT, appRoles: ["scheduler"] });
  assert.match(unreadable ?? "", /could not be read, so the spender is UNREADABLE/);
  assert.doesNotMatch(unreadable ?? "", /^no graphql point is recorded for a11ign-scheduler\[bot\] in the last hour$/);
  assert.equal(spenderPhraseFor({ ledgers: [join(LEADS_DIR, "gh-calls.tsv.d")], login: SCHEDULER_BOT, appRoles: ["scheduler"] }), null, "no ledger read at all is the caller's UNREADABLE, never 'none recorded'");
});

test("#4916: a [bot] login no declared role owns reads UNREADABLE, whatever the ledger holds", () => {
  ledgerOf(WORKERS_DIR, [line("app:managers"), line("dependabot[bot]")]);
  assert.equal(ledgerAccountOf("a11ign-managers[bot]", ["scheduler", "workers"]), null, "managers declares no app here");
  assert.equal(ledgerAccountOf("a11ign-workers[bot]", ["scheduler", "workers"]), "app:workers", "CONTROL: a declared role's slug is owned");
  assert.equal(ledgerAccountOf("a11ign-ai-workers", ["scheduler", "workers"]), "a11ign-ai-workers", "CONTROL: an ordinary account is unchanged");
  for (const login of ["a11ign-managers[bot]", "dependabot[bot]"]) {
    assert.match(spenderDetail(login), /is an App no declared role owns \(declared: scheduler, workers\), so its spender is UNREADABLE/);
  }
});

test("#4916: lines split across the workers' and leads' ledgers are summed, each ledger once", () => {
  ledgerOf(WORKERS_DIR, [line("app:scheduler"), line("app:scheduler")]);
  ledgerOf(LEADS_DIR, [line("app:scheduler", { command: "pr view", caller: "/usr/bin/node /x/src/row-claim.ts" })]);
  assert.match(spenderDetail(SCHEDULER_BOT), /\(3 floor points, read from app:scheduler ledger lines; the pool's own used points are 4080 and the ledger accounts for 0% of them, under 90%, so 4077 points were spent by calls this ledger does not hold\): top caller work-tick\.ts \[issue list\], 2 points \(67%\)$/);
  const path = join(WORKERS_DIR, "gh-calls.tsv");
  assert.match(spenderPhraseFor({ ledgers: [path, path], login: SCHEDULER_BOT, appRoles: ["scheduler"] }) ?? "", /\(2 floor points,/, "a ledger named twice is read once");
  const paths = ledgerPathsOf({ host: HOST_CONFIG, ownDir: WORKERS_DIR });
  assert.deepEqual(paths, [join(WORKERS_DIR, "gh-calls.tsv"), join(LEADS_DIR, "gh-calls.tsv")], "this process's own directory IS the workers': one path, and a reviewer directory that is absent is no ledger");
  mkdirSync(join(SCRATCH, "reviewer", "gh"), { recursive: true });
  assert.equal(ledgerPathsOf({ host: HOST_CONFIG, ownDir: WORKERS_DIR }).at(-1), join(SCRATCH, "reviewer", "gh", "gh-calls.tsv"), "CONTROL: it joins once it exists");
  assert.equal(reviewerGhDir({ ...HOST_CONFIG, home: "/home/agent" }), REVIEWER_GH_CONFIG_DIR, "the reviewer's directory is wake.ts's constant, derived from home because wake.ts imports org-health.ts");
});

test("#4916: an ordinary account is read as it always was, and an unreadable host declaration is said for an App only", () => {
  ledgerOf(WORKERS_DIR, [line("a11ign-ai-workers"), line("a11ign-ai-workers")]);
  assert.match(spenderOfAccount({ account: "a11ign-ai-workers", host: HOST_CONFIG, ownDir: WORKERS_DIR }) ?? "", /^a11ign-ai-workers's last hour \(2 floor points\): top caller work-tick\.ts \[issue list\], 2 points \(100%\)/);
  const refused = () => { throw new Error("no host.json"); };
  assert.match(ledgerSpender(SCHEDULER_BOT, refused) ?? "", /host declaration that names its role could not be read \(no host\.json\), so its spender is UNREADABLE/);
  assert.match(ledgerSpender("a11ign-ai-workers", refused) ?? "", /^a11ign-ai-workers's last hour \(2 floor points\)/, "CONTROL: an account needs no declaration");
});

// --- agent-org#1395: THE SENTENCE ACCOUNTS FOR THE POOL, WITHIN 10% --------------------------------------------------------------------------------------------------------
//
// MEASURED 2026-10-13 (`a11ign-scheduler[bot]`, tripped at 20:08Z): the pool read 5 of 5000 and this sentence read 1,557 floor points, 30%, because no line carried a `cost`.
// The lines now carry the pool's own counter (`host/gh`, 11th and 12th fields), and the sentence names the points the counter moved, by whom it could say.

/** One ledger line with the pool's counter after it (twelve fields); `used` left out is a call whose response the wrapper did not ask the counter of. */
const counted = (account: string, { ago, command = "api graphql", caller = "/usr/bin/node /x/src/work-gate.ts", used }: { ago: number; command?: string; caller?: string; used?: number }) =>
  [minutesAgo(ago), account, "graphql", "", "0", command, "-", caller, "-", "-", used === undefined ? "-" : String(used), used === undefined ? "-" : "1791925000"].join("\t");

test("agent-org#1395: a pool that spent 4,900 points is accounted for by a sentence of 4,900, and the floor-only ledger of the same calls is not", () => {
  const lines = [
    counted("app:scheduler", { ago: 30, used: 1 }),                                  // the window's first reading: a baseline
    counted("app:scheduler", { ago: 25, used: 1801 }),                               // 1,800 read
    counted("app:scheduler", { ago: 20, command: "pr list", caller: TICK }),         // a call whose head was not asked for
    counted("app:scheduler", { ago: 15, used: 3500 }),                               // 1,699 between the `pr list` and this call: shared, 850 and 849
    counted("app:scheduler", { ago: 10, used: 4800 }),                               // 1,300 read
    counted("app:scheduler", { ago: 5, used: 4900 }),                                // 100 read
  ];
  ledgerOf(WORKERS_DIR, lines);
  ledgerOf(LEADS_DIR, []);
  const POOL = { account: SCHEDULER_BOT, resource: "graphql", remaining: 100, limit: 5000, resetAt: "2026-10-13T21:00:00Z" };
  const USED = POOL.limit - POOL.remaining;
  const detail = poolLowReading({ pools: [POOL] }).detail.split(". Spender: ")[1];
  const said = Number(/\((\d+) points by the pool's own counter/.exec(detail)?.[1]);
  assert.ok(Math.abs(said - USED) <= USED * 0.1, `the sentence names ${said} of the pool's ${USED} used points, within 10%: ${detail}`);
  assert.match(detail, /\(4900 points by the pool's own counter: 3200 read off it, 1699 shared between calls it was not read for, 1 floor, read from app:scheduler ledger lines; the pool's own used points are 4900 and the ledger accounts for 100% of them\): top caller work-gate\.ts \[api graphql\], 4051 points \(83%\)$/);
  // THE CONTROL: the same six calls as the ledger was before the counter, nine fields
  ledgerOf(WORKERS_DIR, lines.map((l) => l.split("\t").slice(0, 9).join("\t")));
  const before = poolLowReading({ pools: [POOL] }).detail.split(". Spender: ")[1];
  assert.match(before, /\(6 floor points, read from app:scheduler ledger lines; the pool's own used points are 4900 and the ledger accounts for 0% of them, under 90%/, "CONTROL: without the counter the sentence is the floor, and says so: 6 of 4900");
  assert.ok(Math.abs(6 - USED) > USED * 0.1, "CONTROL: and that is not within 10%, which is what the row was opened for");
});

test("agent-org#1395: a movement no ledgered call accounts for is said, and is not handed to a call", () => {
  ledgerOf(WORKERS_DIR, [
    counted("app:scheduler", { ago: 20, used: 100 }),
    [minutesAgo(10), "app:scheduler", "graphql", "3", "0", "api graphql", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", "110", "1791925000"].join("\t"),
  ]);
  ledgerOf(LEADS_DIR, []);
  const detail = poolLowReading({ pools: [{ account: SCHEDULER_BOT, resource: "graphql", remaining: 100, limit: 5000, resetAt: "2026-10-13T21:00:00Z" }] }).detail.split(". Spender: ")[1];
  assert.match(detail, /\(4 points by the pool's own counter: 3 read off it, 0 shared between calls it was not read for, 1 floor, and 7 more that no ledgered call accounts for, read from app:scheduler ledger lines; the pool's own used points are 4900 and the ledger accounts for 0% of them, under 90%, so 4896 points were spent by calls this ledger does not hold\): top caller work-gate\.ts \[api graphql\], 4 points \(100%\)$/);
});

// --- agent-org#1420: THE SENTENCE STATES THE POOL'S OWN USED POINTS BESIDE THE LEDGER'S TOTAL ------------------------------------------------------------------------------

test("agent-org#1420: a pool of 4,900 used points is stated beside a ledger accounting for 4,900, and for 3,000 it says 61% and that it is under 90%", () => {
  const POOL = { account: SCHEDULER_BOT, resource: "graphql", remaining: 100, limit: 5000, resetAt: "2026-10-13T21:00:00Z" };
  const spender = (lines: string[], pool = POOL) => {
    ledgerOf(WORKERS_DIR, lines);
    ledgerOf(LEADS_DIR, []);
    return poolLowReading({ pools: [pool] }).detail.split(". Spender: ")[1];
  };
  const whole = spender([counted("app:scheduler", { ago: 20, used: 1 }), counted("app:scheduler", { ago: 10, used: 4900 })]);
  assert.match(whole, /\(4900 points by the pool's own counter: .*; the pool's own used points are 4900 and the ledger accounts for 100% of them\)/);
  assert.doesNotMatch(whole, /under 90%/, "CONTROL: a ledger that accounts for all of it is not said to be short");
  const part = spender([counted("app:scheduler", { ago: 20, used: 1 }), counted("app:scheduler", { ago: 10, used: 3000 })]);
  assert.match(part, /\(3000 points by the pool's own counter: .*; the pool's own used points are 4900 and the ledger accounts for 61% of them, under 90%, so 1900 points were spent by calls this ledger does not hold\)/);
  // a floor-only ledger (no counter) is stated the same way: the share is what shows it is a floor
  const floor = spender([1, 2, 3].map((n) => counted("app:scheduler", { ago: 5 * n })).map((l) => l.split("\t").slice(0, 9).join("\t")));
  assert.match(floor, /\(3 floor points, read from app:scheduler ledger lines; the pool's own used points are 4900 and the ledger accounts for 0% of them, under 90%/);
  // a pool with nothing used has no divisor, so the sentence stays as it was
  ledgerOf(WORKERS_DIR, [counted("app:scheduler", { ago: 5, used: 1 })]);
  assert.doesNotMatch(spenderPhraseFor({ ledgers: [join(WORKERS_DIR, "gh-calls.tsv")], login: SCHEDULER_BOT, appRoles: ["scheduler"], used: 0 }) ?? "", /used points/);
});
