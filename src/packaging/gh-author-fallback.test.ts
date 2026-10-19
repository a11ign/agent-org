// no-token: gh -- the wrapper is RUN here against a stub `gh-real` (`A11Y_GH_REAL`) and a stub minter; no `gh` starts and nothing reaches the network or any account's config.
// agent-org#1666 (a11ign/agent-org tracker row): a failed App-token mint must not AUTHOR (`pr create`, `pr merge`, `pr review`) as the shared account.
//
// The rule has two switches' worth of sides, each pinned by RUNNING the installed wrapper:
//   1. `gh.refuseFallbackAuthor` ON, and a mint that keeps failing: the authoring call is minted again (`A11Y_APP_AUTHOR_MINTS`, default 3), then REFUSED:
//      non-zero, nothing sent (the stub that would have authored never ran), the reason on stderr, one incident line per failed mint. A READ still goes out as
//      the account, as it always has.
//   2. ON and the mint works on a later try: the call goes out on the App's token.
//   3. OFF (the default, and every host until the switch is thrown): the failing mint falls back, exactly as before.
// And the health signal `gh-author-fallback` trips on an account-attributed authoring call that is at most ten minutes old, and not on a read or an app's call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountAuthoringTimes, authorFallbackRefusalOn, AUTHOR_FALLBACK_MINUTES, isAuthoringCall, REFUSE_AUTHOR_FALLBACK_FLAG } from "../gh-author-fallback.ts";
import { parseLine } from "../gh-ledger.ts";
import { CANARY_STATE_FILE } from "../org-health/claim-refusal.ts";
import { machineryValues } from "../org-health.ts";
import { MACHINERY_SIGNALS } from "../org-health/hold-count.ts";
import { STANDARD_MACHINERY_SIGNALS } from "../org-health/fleet-build-readings.ts";
import { parseHostConfig, renderTemplate, templateValues } from "../host-config.ts";
import { authorFallbackTimes } from "../work-gate/causes/org-health-github-incident.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";
import { SUPPORTED_SCHEMA } from "../project-config.ts";

const HOST = {
  schema: SUPPORTED_SCHEMA, home: "/home/h", binDir: "/home/h/bin", primary: "p", projects: [{ id: "p", checkout: "/home/h/p" }],
  gh: { workers: "/home/h/workers", leads: "/home/h/leads", leadsHeader: [], leadsWorkspaces: [] },
};
const UNITS = { prefix: "x-", boardReportWorkflow: "b.yml", own: [] };
const parse = (extra: Record<string, unknown>) => parseHostConfig(JSON.stringify({ ...HOST, ...extra }), "host.json");
const LEAF = fileURLToPath(new URL("../gh-author-fallback.ts", import.meta.url));
const WORKERS_APP = { mode: "github-apps", appId: "id-workers", keyPath: "/nonexistent-1666/workers.pem", installationId: "777" };
const MINT_401 = "app token: token: POST answered 401";
const LEDGER_NOW = "2026-10-16T21:20:00Z";
const ACCOUNT = "a11ign-ai-workers";

/** The wrapper RENDERED through `templateValues` from a host that declares the workers' App, as the installed one is. */
const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-author-fallback-wrapper-"), "gh");
  writeFileSync(rendered, renderTemplate(text, templateValues(parse({ github: { identity: { workers: WORKERS_APP } } }), UNITS), "gh"), { mode: 0o755 });
  return rendered;
})();

/**
 * A host: the workers' config directory (the account `a11ign-ai-workers`), a stub `gh-real` that prints the token it was given, and a stub minter that counts its
 * runs and fails while `MINT_FAIL` is set (for the first `MINT_FAIL_TIMES` runs when that is set, for every run when it is not).
 * `run` is the wrapper as a worker reaches it; `canary` writes the canary state the switch is read from.
 */
function host() {
  const root = tmpDir("gh-author-fallback-host-");
  const workers = join(root, "workers", "gh");
  mkdirSync(workers, { recursive: true });
  writeFileSync(join(workers, "hosts.yml"), `github.com:\n    user: ${ACCOUNT}\n    oauth_token: not-a-token\n`);
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh", `echo "token=\${GH_TOKEN:-none} args=$*"`, `exit 0`, ""].join("\n"), { mode: 0o755 });
  const minter = join(root, "mint.sh");
  const count = join(root, "mint-count");
  writeFileSync(minter, [
    `echo run >> "${count}"`, "cat > /dev/null",
    `echo "$A11Y_APP_ID|$A11Y_APP_KEY_PATH|$A11Y_APP_INSTALLATION_ID|$1" > "${join(root, "handed")}"`,
    `if [ -n "$MINT_FAIL" ] && { [ -z "\${MINT_FAIL_TIMES:-}" ] || [ "$(wc -l < "${count}")" -le "$MINT_FAIL_TIMES" ]; }; then echo "$MINT_FAIL" >&2; exit 1; fi`,
    `echo "$(( $(date +%s) + 3600 )) $MINT_TOKEN" > "$A11Y_APP_TOKEN_DIR/$1.token"`,
    `printf %s "$MINT_TOKEN"`, ""].join("\n"));
  const canaryPath = join(root, CANARY_STATE_FILE);
  const ledgerPath = join(workers, "gh-calls.tsv");
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const env = {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: join(root, "workers"), A11Y_LEADS_DIR: join(root, "leads"),
      A11Y_GH_LEDGER_NOW: LEDGER_NOW, A11Y_GH_READ_CACHE: "off", A11Y_APP_ROLES: "scheduler workers managers", A11Y_APP_TOKEN_DIR: join(root, "tokens"),
      A11Y_APP_NODE: "sh", A11Y_APP_TOKEN_SCRIPT: minter, MINT_TOKEN: "ghs_minted", MINT_FAIL: MINT_401, A11Y_APP_AUTHOR_PAUSE: "0",
      A11Y_GH_CANARY_STATE: canaryPath, A11Y_GH_FLAG_SCRIPT: LEAF, A11Y_GH_NODE: process.execPath,
      GH_CONFIG_DIR: workers, HERDR_WORKSPACE_ID: "w3", A11Y_PR_OPEN: "1", ...extra,
    };
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env, input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const canary = (on: boolean | null) => {
    if (on === null) return;
    const flags = { [REFUSE_AUTHOR_FALLBACK_FLAG]: { on, signals: [], onAt: null, verdict: null, decidedAt: null, readings: [], incident: null } };
    writeFileSync(canaryPath, JSON.stringify({ flags, samples: [], memo: {} }));
  };
  const mints = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const lines = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : []);
  const handed = () => readFileSync(join(root, "handed"), "utf8").trim();
  return { root, run, canary, mints, lines, handed };
}
const tokenOf = (stdout: string) => /^token=(\S+)/.exec(stdout)?.[1];

// ---- the switch's reading ----------------------------------------------------------------------------------------------------------

test("#1666: the switch is the flag `machinery:flag` names, and it reads ON only when the record says `on: true`", () => {
  assert.equal(REFUSE_AUTHOR_FALLBACK_FLAG, "gh.refuseFallbackAuthor");
  assert.equal(CANARY_STATE_FILE, "machinery-canary.json");
  assert.equal(templateValues(parse({}), UNITS).canaryStateFile.split("/").at(-1), CANARY_STATE_FILE, "the wrapper reads the file `org-health` writes");
  const record = (on: unknown) => JSON.stringify({ flags: { [REFUSE_AUTHOR_FALLBACK_FLAG]: { on } }, samples: [], memo: {} });
  assert.equal(authorFallbackRefusalOn(null), false, "an absent state is OFF");
  assert.equal(authorFallbackRefusalOn(""), false);
  assert.equal(authorFallbackRefusalOn("not json"), false, "a state it cannot read is OFF, and the fallback is today's behaviour");
  assert.equal(authorFallbackRefusalOn(record(false)), false);
  assert.equal(authorFallbackRefusalOn(record("true")), false, "only the boolean true turns it on");
  assert.equal(authorFallbackRefusalOn(record(true)), true, "POSITIVE CONTROL: the record says on");
});

test("#1666: an authoring call is `pr create`, `pr merge` or `pr review`, and nothing else (a read is not one)", () => {
  for (const [a, b] of [["pr", "create"], ["pr", "merge"], ["pr", "review"]]) assert.equal(isAuthoringCall(a, b), true, `${a} ${b} authors`);
  for (const [a, b] of [["pr", "view"], ["pr", "list"], ["pr", "checks"], ["api", "user"], ["pr", "edit"], ["issue", "create"], ["pr", "create-x"]]) {
    assert.equal(isAuthoringCall(a, b), false, `${a} ${b} is not an authoring call`);
  }
});

// ---- 1. flag ON, every mint fails: the authoring call is minted again, then refused, nothing sent ---------------------------------

test("#1666 POSITIVE CONTROL: switch ON and a mint that keeps failing REFUSES `pr create`: retried 3 times, non-zero, nothing sent, the reason on stderr, one incident per mint", () => {
  const h = host();
  h.canary(true);
  const call = h.run({}, "pr", "create", "--title", "t", "--body-file", "-");
  assert.deepEqual([call.status, call.stdout], [1, ""], "REFUSED: non-zero, and the stub that would have authored the pull request never ran");
  assert.equal(h.mints(), 3, "the mint was asked the default 3 times before the refusal");
  assert.match(call.stderr, /^gh: refused: the workers call is NOT sent as the account\. app-token workers failed for App id-workers: app token: token: POST answered 401 \(exit 1\)\n$/,
    "the caller reads the role, the App and the mint failure on stderr");
  assert.deepEqual(h.lines().map((l) => parseLine(l)?.resource), ["incident", "incident", "incident"], "no call line: the only ledger lines are the three incidents");
  assert.match(h.lines()[0], /app-token workers failed, retrying, not sent as the account: app token: token: POST answered 401/);
  assert.match(h.lines()[1], /app-token workers failed, retrying, not sent as the account/);
  assert.match(h.lines()[2], /app-token workers failed, refused, not sent as the account: app token: token: POST answered 401 \(exit 1\)/);
});

test("#1666: switch ON refuses `pr merge` and `pr review` the same way (the review is the approval), and a read still goes out as the account", () => {
  const h = host();
  h.canary(true);
  for (const args of [["pr", "merge", "955", "--squash"], ["pr", "review", "955", "--approve"]]) {
    const call = h.run({}, ...args);
    assert.deepEqual([call.status, call.stdout], [1, ""], `${args.join(" ")} is refused, and nothing was sent`);
    assert.match(call.stderr, /^gh: refused: the workers call is NOT sent as the account/);
  }
  const read = h.run({}, "pr", "view", "955");
  assert.equal(read.status, 0, "NOT REFUSED: a read authors nothing");
  assert.equal(read.stdout, `token=none args=pr view 955\n`, "POSITIVE CONTROL: the read went out as the account, as before");
  assert.equal(read.stderr, "");
  assert.deepEqual(h.lines().slice(-1).map((l) => parseLine(l)?.account), [ACCOUNT], "and its line names the account it went out as");
});

test("#1666: the retry count is `A11Y_APP_AUTHOR_MINTS`: five mints before the refusal when it says five", () => {
  const h = host();
  h.canary(true);
  const call = h.run({ A11Y_APP_AUTHOR_MINTS: "5" }, "pr", "create", "--title", "t");
  assert.equal(call.status, 1);
  assert.equal(h.mints(), 5);
  assert.equal(h.lines().length, 5, "one incident line per failed mint");
});

// ---- 2. flag ON, a mint that works on a later try: the call goes out on the App's token ---------------------------------------------

test("#1666 POSITIVE CONTROL: switch ON and a mint that fails twice then works sends `pr create` on the App's token, as `app:workers`", () => {
  const h = host();
  h.canary(true);
  const call = h.run({ MINT_FAIL_TIMES: "2" }, "pr", "create", "--title", "t");
  assert.equal(call.status, 0);
  assert.equal(tokenOf(call.stdout), "ghs_minted", "the call reached gh-real on the App's token: the retry worked");
  assert.equal(h.mints(), 3, "two failed mints, then the one that worked");
  assert.equal(h.handed(), "id-workers|/nonexistent-1666/workers.pem|777|workers", "the minter is handed the workers' declared App");
  const lines = h.lines().map((l) => parseLine(l));
  assert.deepEqual(lines.slice(0, 2).map((p) => p?.resource), ["incident", "incident"], "two incidents, one per failed mint");
  assert.deepEqual(lines.slice(2).map((p) => p?.account), ["app:workers"], "the call's own line names the App, so the pool is not charged to the account");
});

// ---- 3. flag OFF: the failing mint falls back, as before -----------------------------------------------------------------------------

test("#1666 NEGATIVE CONTROL: switch OFF (no canary state at all) and a failing mint: `pr create` falls back to the account, as today, and says nothing on stderr", () => {
  const h = host();
  h.canary(null);
  const call = h.run({}, "pr", "create", "--title", "t");
  assert.equal(call.status, 0, "NOT REFUSED: the call goes through, as it did before this row");
  assert.equal(call.stdout, "token=none args=pr create --title t\n", "it went out as the account");
  assert.equal(call.stderr, "");
  assert.equal(h.mints(), 1, "one mint, which failed: no retry is made while the switch is off");
  assert.match(h.lines()[0], /app-token workers failed, fell back to the account: app token: token: POST answered 401 \(exit 1\)/);
  assert.equal(parseLine(h.lines()[1])?.account, ACCOUNT, "the call is recorded against the account it went out as");
});

test("#1666 NEGATIVE CONTROL: a switch written OFF is the same as an absent one", () => {
  const h = host();
  h.canary(false);
  const call = h.run({}, "pr", "merge", "955");
  assert.deepEqual([call.status, call.stdout], [0, "token=none args=pr merge 955\n"], "the merge falls back: the switch is off");
  assert.equal(h.mints(), 1);
});

// ---- 4. the signal: an account-attributed authoring call, within ten minutes ----------------------------------------------------------

test("#1666: the signal is on the standard list, and the wrapper's own switch lines do not count toward it", () => {
  assert.ok(STANDARD_MACHINERY_SIGNALS.includes(MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK), "`--signals` may name it, and a flag turned on watches it by default");
  assert.equal(MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK, "gh-author-fallback");
});

test("#1666 POSITIVE CONTROL: the signal trips on an account-attributed authoring call at ten minutes old, and not at eleven", () => {
  const at = Date.parse("2026-10-16T21:19:30Z");
  const facts = (authorFallbacks: number[]) => ({ claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, authorFallbacks });
  const read = (now: number) => machineryValues({ facts: facts([at]), since: at - 60_000, now, memo: {} }).values[MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK];
  assert.equal(read(at + 1 * 60_000), 1, "a minute old: counted");
  assert.equal(read(at + AUTHOR_FALLBACK_MINUTES * 60_000), 1, "exactly ten minutes old: still counted");
  assert.equal(read(at + 11 * 60_000), 0, "NOT at eleven minutes: the window is ten minutes, and the call is no longer the tick's to count");
});

test("#1666: the signal is UNREAD (null) when the ledgers could not be read, and is never a clean zero", () => {
  const values = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, authorFallbacks: null }, since: 0, now: 1, memo: {} });
  assert.equal(values.values[MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK], null);
});

test("#1666: a read, an app's call, and an incident line are NOT authoring calls for the signal", () => {
  const ts = "2026-10-16T21:19:30Z";
  const lines = [
    `${ts}\t${ACCOUNT}\tcore\t1\t0\tpr view 955\tw3\tcaller`,
    `${ts}\t${ACCOUNT}\tcore\t1\t0\tpr list --json number\tw3\tcaller`,
    `${ts}\tapp:workers\tcore\t1\t0\tpr create --title t\tw3\tcaller`,
    `${ts}\t${ACCOUNT}\tincident\t-\t1\tapp-token workers\tw3\tcaller`,
  ];
  const workers = (ledger: string[]) => [{ home: "workers" as const, lines: ledger }];
  assert.deepEqual(accountAuthoringTimes(workers(lines), ["workers"]), [], "POSITIVE CONTROLS ABOVE: none of these is an account's authoring call");
  assert.deepEqual(accountAuthoringTimes(workers([`${ts}\t${ACCOUNT}\tcore\t1\t0\tpr create --title t\tw3\tcaller`]), ["workers"]), [Date.parse(ts)], "and an account's authoring call is");
});

test("#1666: the wrapper's OFF-switch authoring call is the one the signal counts: the account's line is in the ledger the signal reads", () => {
  const h = host();
  h.canary(null);
  h.run({}, "pr", "create", "--title", "t");
  const times = accountAuthoringTimes([{ home: "workers", lines: h.lines() }], ["workers"]);
  assert.equal(times.length, 1, "POSITIVE CONTROL: the fallen-back authoring call is counted, so the signal would trip on it");
  const values = machineryValues({ facts: { claimRefusals: [], unread: [], deferredWakes: 0, unarmed: [], releaseRuns: null, authorFallbacks: times }, since: times[0] - 1, now: times[0] + 60_000, memo: {} });
  assert.equal(values.values[MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK], 1);
});

// ---- 5. the reader that feeds the signal: the three ledgers, the roles the host declares `github-apps`, and unread --------------------------------------------

const AT = "2026-10-16T21:19:30Z";
const AT_MS = Date.parse(AT);
const WORKERS_LEDGER = "/home/h/workers/gh/gh-calls.tsv";
const LEADS_LEDGER = "/home/h/leads/gh/gh-calls.tsv";
const REVIEWER_LEDGER = "/home/h/reviewer/gh/gh-calls.tsv";
const APP = (role: string) => ({ mode: "github-apps", appId: `id-${role}`, keyPath: `/nonexistent-1666/${role}.pem` });
/** A `read` that serves the files it is given, fails with the code given for the paths named in `fail`, and throws ENOENT for any other path. */
const ledgerReader = (files: Record<string, string>, fail: Record<string, string> = {}) => ((path: string) => {
  if (path in fail) throw Object.assign(new Error(`${fail[path]}: ${path}`), { code: fail[path] });
  if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return files[path];
}) as unknown as typeof readFileSync;
/** An account's authoring line in a workspace (`-` is a call with no workspace id: the scheduler's). */
const accountCall = (workspace: string, command = "pr create --title t") => `${AT}\t${ACCOUNT}\tcore\t1\t0\t${command}\t${workspace}\tcaller`;

test("#1666: the reader counts an account's authoring call only for a role the host declares github-apps, in each of the three ledgers", () => {
  const files = {
    [WORKERS_LEDGER]: [accountCall("w3"), accountCall("-"), `${AT}\tapp:workers\tcore\t1\t0\tpr create --title t\tw3\tcaller`, accountCall("w3", "pr view 9")].join("\n"),
    [LEADS_LEDGER]: accountCall("w9"),
    [REVIEWER_LEDGER]: accountCall("w1", "pr review 5 --approve"),
  };
  const workersOnly = parse({ github: { identity: { workers: APP("workers") } } });
  // POSITIVE CONTROL: the workers' account call is a fallback. The scheduler's, the leads' and the reviewer's are user-accounts roles: their account is their own.
  assert.deepEqual(authorFallbackTimes({ host: workersOnly, reviewerDir: "/home/h/reviewer/gh", read: ledgerReader(files) }), [AT_MS]);
  const everyRole = parse({ github: { identity: { workers: APP("workers"), managers: APP("managers"), reviewer: APP("reviewer"), scheduler: APP("scheduler") } } });
  assert.deepEqual(authorFallbackTimes({ host: everyRole, reviewerDir: "/home/h/reviewer/gh", read: ledgerReader(files) }), [AT_MS, AT_MS, AT_MS, AT_MS], "declare the others and each of their account calls is counted: the workers', the scheduler's, the leads' and the reviewer's");
});

test("#1666: a ledger nobody wrote is no calls, and a ledger that exists and cannot be read is UNREAD (null), never a zero", () => {
  const h = parse({ github: { identity: { workers: APP("workers") } } });
  assert.deepEqual(authorFallbackTimes({ host: h, reviewerDir: "/home/h/reviewer/gh", read: ledgerReader({}) }), [], "no ledger written: no calls");
  assert.equal(authorFallbackTimes({ host: h, reviewerDir: "/home/h/reviewer/gh", read: ledgerReader({}, { [WORKERS_LEDGER]: "EACCES" }) }), null, "an unreadable ledger makes the reading unread");
});
