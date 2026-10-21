// no-token: gh -- the wrapper is RUN here against a stub `gh-real` (`A11Y_GH_REAL`) and a stub minter (`A11Y_APP_NODE`/`A11Y_APP_TOKEN_SCRIPT`);
// the GitHub API is a recorder handed to `mintInstallationToken`, so no `gh` starts and nothing reaches the network or any account's config.
//
// #4900: A GITHUB APP PER ROLE, moved from `src/app-token.test.ts` with the minter and the wrapper (A11-160). Four things are pinned, each by running the thing and not by reading it:
//   1. MINTING: the JWT verifies against the app's public key, the installation is the declared one or the app's only one, and every
//      refusal names the stage that failed;
//   2. REFRESH: a token with more than the margin left is served from the file, one with less is replaced, a torn file is a miss;
//   3. FALLBACK: a mint that fails sends the call through as today's account and leaves ONE `incident` ledger line, then is not asked
//      again inside the window;
//   4. ROUTING BY ROLE: the wrapper rendered for hosts that declare Apps, run.
// The positive control for every "the app was NOT used" assertion is the stub's own marker, so a wrapper that never reached the stub
// cannot pass them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WrapperInputs } from "../../src/plugins/contracts/code-host.ts";
import { parseLine } from "../../src/gh-ledger.ts";
import { tmpDir, tmpDirForFile } from "../../src/lib/tmp-fixture.ts";
import {
  AppTokenFailure, REFRESH_MARGIN_SECONDS, appJwt, appToken, formatTokenFile, mintInstallationToken, parseTokenFile, tokenPath,
  type AppIdentity, type Fetch,
} from "./app-token.ts";
import { createWrapper, wrapperRoles } from "./wrapper.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP: AppIdentity = { appId: "123456", keyPath: "/keys/scheduler.pem" };
const NOW = 1_800_000_000;
const HOUR = 3600;
const expiresAtOf = (secondsFromNow: number) => new Date((NOW + secondsFromNow) * 1000).toISOString();

type Call = { url: string, method: string, authorization: string };
/** A GitHub that answers the two calls a mint makes and records them. `installations` is what `GET /app/installations` lists. */
function fakeGithub(opts: { installations?: number[], tokenStatus?: number, token?: string, lifetime?: number, reject?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.authorization });
    if (opts.reject) throw new Error("ECONNRESET");
    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (init.method === "GET") return reply(200, (opts.installations ?? [42]).map((id) => ({ id })));
    return reply(opts.tokenStatus ?? 201, { token: opts.token ?? "ghs_minted", expires_at: expiresAtOf(opts.lifetime ?? HOUR) });
  };
  return { fetch, calls };
}

// ---- 1. minting -------------------------------------------------------------------------------------------------------------------

test("#4900: the app's JWT is RS256, issued by the app id, lives under ten minutes and verifies against its public key", () => {
  const jwt = appJwt({ appId: APP.appId, privateKey, now: NOW });
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const body = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(body.iss, "123456");
  assert.ok(body.exp - body.iat <= 600, `GitHub refuses a JWT living past ten minutes; this one lives ${body.exp - body.iat}s`);
  assert.ok(body.iat < NOW && body.exp > NOW, "iat is backdated for clock skew and exp is ahead");
  const verified = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"));
  assert.equal(verified, true, "POSITIVE CONTROL: a signature that does not verify would make every other assertion about the JWT vacuous");
});

test("#4900: minting trades the JWT for an installation token: the only installation is discovered, the token and its expiry come back", async () => {
  const api = fakeGithub({ installations: [42], token: "ghs_abc" });
  const minted = await mintInstallationToken({ app: APP, privateKey, fetch: api.fetch, now: NOW });
  assert.deepEqual(minted, { token: "ghs_abc", expiresAt: NOW + HOUR });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["GET /app/installations", "POST /app/installations/42/access_tokens"]);
  assert.ok(api.calls.every((c) => c.authorization.startsWith("Bearer ") && c.authorization.split(".").length === 3), "both calls carry the app JWT");
});

test("#4900: a declared installation id skips discovery; two installations and none are refused naming `installationId`", async () => {
  const declared = fakeGithub();
  await mintInstallationToken({ app: { ...APP, installationId: "77" }, privateKey, fetch: declared.fetch, now: NOW });
  assert.deepEqual(declared.calls.map((c) => new URL(c.url).pathname), ["/app/installations/77/access_tokens"]);
  for (const installations of [[1, 2], []]) {
    await assert.rejects(mintInstallationToken({ app: APP, privateKey, fetch: fakeGithub({ installations }).fetch, now: NOW }),
      (error: unknown) => error instanceof AppTokenFailure && error.stage === "installation" && /installationId/.test(error.message));
  }
});

test("#4900: every failure names its stage and none puts a token or key byte in the message", async () => {
  const stage = (run: () => Promise<unknown>) => run().then(() => "no failure", (error: unknown) => (error instanceof AppTokenFailure ? error.stage : "wrong error"));
  assert.equal(await stage(() => mintInstallationToken({ app: APP, privateKey: "not a key", fetch: fakeGithub().fetch, now: NOW })), "key");
  assert.equal(await stage(() => mintInstallationToken({ app: APP, privateKey, fetch: fakeGithub({ tokenStatus: 403 }).fetch, now: NOW })), "token");
  assert.equal(await stage(() => mintInstallationToken({ app: APP, privateKey, fetch: fakeGithub({ reject: true }).fetch, now: NOW })), "installation");
  const refused = await mintInstallationToken({ app: APP, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nSECRET", fetch: fakeGithub().fetch, now: NOW })
    .then(() => "minted", (error: Error) => error.message + String(error.cause));
  assert.ok(!refused.includes("SECRET"), "the key's bytes are not in what a failure says");
});

// ---- 2. refresh before expiry -----------------------------------------------------------------------------------------------------

test("#4900: a cached token with more than the margin left is served without a mint; with less it is replaced; both are the file's bytes", async () => {
  const dir = tmpDir("app-token-4900-");
  const api = fakeGithub({ token: "ghs_fresh" });
  const deps = { now: () => NOW, fetch: api.fetch, readKey: () => privateKey };
  const first = await appToken({ role: "scheduler", app: APP, cacheDir: dir, deps });
  assert.deepEqual([first.source, first.token], ["minted", "ghs_fresh"]);
  assert.equal(api.calls.length, 2, "POSITIVE CONTROL: the first call minted (discovery + token)");
  assert.equal(statSync(tokenPath(dir, "scheduler")).mode & 0o777, 0o600, "the token file is private");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "and so is its directory");

  const again = await appToken({ role: "scheduler", app: APP, cacheDir: dir, deps: { ...deps, now: () => NOW + HOUR - REFRESH_MARGIN_SECONDS - 1 } });
  assert.deepEqual([again.source, again.token], ["cache", "ghs_fresh"]);
  assert.equal(api.calls.length, 2, "no call was made for a token with more than the margin left");

  const refreshed = await appToken({ role: "scheduler", app: APP, cacheDir: dir, deps: { ...deps, now: () => NOW + HOUR - REFRESH_MARGIN_SECONDS } });
  assert.equal(refreshed.source, "minted", "at the margin the token is replaced BEFORE it expires, not after");
  assert.equal(api.calls.length, 4);
});

test("#4900: a torn, foreign or absent cache file is a miss and never a token; one role's refresh does not touch another's file", async () => {
  assert.equal(parseTokenFile(formatTokenFile({ token: "ghs_x", expiresAt: 5 }))?.token, "ghs_x");
  for (const text of ["", "garbage", "123", "abc ghs_x\n", "123 ghs_x extra\n"]) assert.equal(parseTokenFile(text), null, JSON.stringify(text));
  const dir = tmpDir("app-token-4900-");
  writeFileSync(tokenPath(dir, "workers"), formatTokenFile({ token: "ghs_workers", expiresAt: NOW + HOUR }));
  writeFileSync(tokenPath(dir, "scheduler"), "torn");
  const api = fakeGithub({ token: "ghs_sched" });
  const got = await appToken({ role: "scheduler", app: APP, cacheDir: dir, deps: { now: () => NOW, fetch: api.fetch, readKey: () => privateKey } });
  assert.equal(got.source, "minted");
  assert.equal(readFileSync(tokenPath(dir, "workers"), "utf8"), `${NOW + HOUR} ghs_workers\n`, "the other role's file is untouched");
});

test("#4900: an unreadable key is a failure at the `key` stage, and nothing is written", async () => {
  const dir = tmpDir("app-token-4900-");
  const unreadable = () => { throw new Error("EACCES"); };
  await assert.rejects(appToken({ role: "scheduler", app: APP, cacheDir: dir, deps: { now: () => NOW, fetch: fakeGithub().fetch, readKey: unreadable } }),
    (error: unknown) => error instanceof AppTokenFailure && error.stage === "key" && error.message.includes(APP.keyPath));
  assert.equal(existsSync(tokenPath(dir, "scheduler")), false);
});

// ---- 3. the wrapper's rendering ---------------------------------------------------------------------------------------------------

/** The roles, in the order the wrapper lists them. */
const ROLES = ["scheduler", "workers", "managers", "reviewer"];
/** A host whose tool is not installed (`tool` undefined), so the programs are found under the primary project's `packages/agent-org`, and whose state directory is undeclared. */
const PLACE = { binDir: "/home/h/bin", tool: undefined, checkout: "/home/h/p", stateEntry: (name: string) => `/home/h/.cache/a11ign/${name}` };
const inputsFor = (identity: Record<string, unknown>, place: WrapperInputs["place"] = PLACE): WrapperInputs => ({
  place, accounts: { workers: "/home/h/workers", leads: "/home/h/leads" },
  identity: Object.fromEntries(ROLES.map((role) => [role, identity[role] ?? { mode: "user-accounts" }])) as WrapperInputs["identity"],
});
const wrapper = createWrapper({ exec: () => ({ status: null, stdout: "", stderr: "no program" }), readFile: (path) => readFileSync(path, "utf8"), env: {} });
/** The wrapper as the plugin renders it for a host that declares `identity`. */
const textFor = (identity: Record<string, unknown>, place?: WrapperInputs["place"]): string => wrapper.file(inputsFor(identity, place)).expected as string;
const SCHEDULER_APP = { mode: "github-apps", appId: "123456", keyPath: "/home/h/.config/agent-org/apps/a11ign-scheduler.pem" };

test("#4900: the shipped wrapper renders with the host's values, and `APP_ROLES` lists exactly the app-backed roles", () => {
  const none = textFor({});
  assert.match(none, /^APP_ROLES=\$\{A11Y_APP_ROLES-\}$/m, "no app declared: the wrapper takes none of the new paths");
  assert.equal(none.includes("@@"), false, "every placeholder the wrapper carries has a value");
  const some = textFor({ managers: SCHEDULER_APP, scheduler: SCHEDULER_APP });
  assert.deepEqual(wrapperRoles(some), ["scheduler", "managers"]);
  assert.match(some, /^  app_dir=\$\{A11Y_APP_TOKEN_DIR:-\/home\/h\/\.cache\/a11ign\/app-tokens\}$/m, "undeclared stateDir: the directory the units have always used");
  assert.match(some, /^  app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-\/home\/h\/p\/packages\/agent-org\/plugins\/github\/app-token\.ts\}$/m, "the minter is the plugin's, under the primary project's tool");
  const installed = textFor({}, { binDir: "/home/h/bin", tool: "/home/h/agent-org", checkout: "/home/h/p", stateEntry: (name) => `/home/h/state/${name}` });
  assert.match(installed, /app_dir=\$\{A11Y_APP_TOKEN_DIR:-\/home\/h\/state\/app-tokens\}/);
  assert.match(installed, /app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-\/home\/h\/agent-org\/plugins\/github\/app-token\.ts\}/);
});

// ---- 4. the wrapper, run ---------------------------------------------------------------------------------------------------

/**
 * The wrapper RENDERED by the plugin from a host that declares an app for every role, so the table the minter is handed is the one
 * the installed wrapper would carry. Every directory the wrapper takes from the host is overridden by an environment variable in every call.
 */
const wrapperFor = (identity: Record<string, unknown>) => {
  const rendered = join(tmpDirForFile("app-token-4900-wrapper-"), "gh");
  writeFileSync(rendered, textFor(identity), { mode: 0o755 });
  return rendered;
};
const THREE_APPS = Object.fromEntries(["scheduler", "workers", "managers"].map((role) => [role, {
  mode: "github-apps", appId: `id-${role}`, keyPath: `/nonexistent-4900/${role}.pem`, ...(role === "workers" ? { installationId: "777" } : {}),
}]));
const WRAPPER = wrapperFor(THREE_APPS);
const LEDGER_NOW = "2026-10-10T22:00:00Z";
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A host: two account directories (workers, leads) with a `hosts.yml` each, a stub `gh-real`, and a stub minter that counts its runs. */
function host(wrapper = WRAPPER) {
  const root = tmpDir("app-token-4900-host-");
  for (const [dir, login] of [["workers", "a11ign-ai-workers"], ["leads", "a11ign-ai-leads"]]) {
    mkdirSync(join(root, dir, "gh"), { recursive: true });
    writeFileSync(join(root, dir, "gh", "hosts.yml"), `github.com:\n    user: ${login}\n    oauth_token: not-a-token\n`);
  }
  writeFileSync(join(root, "leads", "workspaces.txt"), "# w6 ceo\nw6\n");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh", `echo "token=\${GH_TOKEN:-none} args=$*"`, `[ -n "$STUB_STDIN" ] && printf 'stdin=%s\\n' "$(cat)"`, `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  const minter = join(root, "mint.sh");
  const count = join(root, "mint-count");
  writeFileSync(minter, [
    `echo run >> "${count}"`, "cat > /dev/null",
    `echo "$A11Y_APP_ID|$A11Y_APP_KEY_PATH|$A11Y_APP_INSTALLATION_ID|$1" > "${join(root, "handed")}"`,
    `[ -n "$MINT_FAIL" ] && { echo "$MINT_FAIL" >&2; exit 1; }`,
    `echo "$(( $(date +%s) + 3600 )) $MINT_TOKEN" > "$A11Y_APP_TOKEN_DIR/$1.token"`,
    `printf %s "$MINT_TOKEN"`, ""].join("\n"));
  const tokens = join(root, "tokens");
  const ledger = join(root, "workers", "gh", "gh-calls.tsv");
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const env = {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: join(root, "workers"), A11Y_LEADS_DIR: join(root, "leads"),
      A11Y_GH_LEDGER_NOW: LEDGER_NOW, A11Y_GH_READ_CACHE: "off", A11Y_APP_ROLES: "scheduler workers managers", A11Y_APP_TOKEN_DIR: tokens,
      A11Y_APP_NODE: "sh", A11Y_APP_TOKEN_SCRIPT: minter, MINT_TOKEN: "ghs_minted", ...extra,
    };
    const r = spawnSync("sh", [wrapper, ...args], { encoding: "utf8", env, input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const handed = () => readFileSync(join(root, "handed"), "utf8").trim();
  const seed = (role: string, token: string, secondsLeft = HOUR) => {
    mkdirSync(tokens, { recursive: true });
    writeFileSync(join(tokens, `${role}.token`), `${nowSeconds() + secondsLeft} ${token}\n`);
  };
  const mints = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const lines = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean) : []);
  return { root, tokens, run, seed, mints, lines, ledger, handed };
}

/** A host with the given app tokens seeded, as `[role, token]` pairs. */
function seededHost(...seeds: [string, string][]) {
  const h = host();
  for (const [role, token] of seeds) h.seed(role, token);
  return h;
}
const tokenOf = (stdout: string) => /^token=(\S+)/.exec(stdout)?.[1];
const WORKERS_CFG = (h: { root: string }) => join(h.root, "workers", "gh");
const LEADS_CFG = (h: { root: string }) => join(h.root, "leads", "gh");

test("#4900: ROUTING BY ROLE: no workspace is the scheduler, a workspace is a worker, the leads list is a manager, each on its own app's token", () => {
  const h = host();
  h.seed("scheduler", "ghs_scheduler"); h.seed("workers", "ghs_workers"); h.seed("managers", "ghs_managers");
  const gate = h.run({ GH_CONFIG_DIR: WORKERS_CFG(h) }, "pr", "list");
  const worker = h.run({ HERDR_WORKSPACE_ID: "w3" }, "pr", "list");
  // a manager's list is the gate's snapshot unless it names a --limit of 50 or less and a light --json (#1517): the managers' calls are that form
  const manager = h.run({ HERDR_WORKSPACE_ID: "w6" }, "pr", "list", "--json", "number", "--limit", "30");
  const spawned = h.run({ HERDR_WORKSPACE_ID: "w9", GH_CONFIG_DIR: LEADS_CFG(h) }, "pr", "list", "--json", "number", "--limit", "30");
  assert.deepEqual([gate, worker, manager, spawned].map((r) => tokenOf(r.stdout)), ["ghs_scheduler", "ghs_workers", "ghs_managers", "ghs_managers"]);
  assert.equal(h.mints(), 0, "every token was served from the file: no process was started");
});

/** A third config directory standing for the reviewer's own (`/home/agent/reviewer/gh`): its account is `a11ign-bot`, its ledger is its own. */
function reviewerConfig(h: { root: string }) {
  const dir = join(h.root, "reviewer", "gh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hosts.yml"), "github.com:\n    user: a11ign-bot\n    oauth_token: not-a-token\n");
  return dir;
}

test("#817: an explicit GH_CONFIG_DIR that is neither the workers' nor the leads' gets NO app: a reviewer acts as its own account", () => {
  const h = host();
  h.seed("workers", "ghs_workers"); h.seed("managers", "ghs_managers");
  const reviewer = reviewerConfig(h);
  const asWorkers = h.run({ HERDR_WORKSPACE_ID: "w3", GH_CONFIG_DIR: WORKERS_CFG(h) }, "pr", "view");
  const asLeads = h.run({ HERDR_WORKSPACE_ID: "w3", GH_CONFIG_DIR: LEADS_CFG(h) }, "pr", "view");
  const asReviewer = h.run({ HERDR_WORKSPACE_ID: "w3", GH_CONFIG_DIR: reviewer }, "pr", "view");
  assert.deepEqual([asWorkers, asLeads].map((r) => tokenOf(r.stdout)), ["ghs_workers", "ghs_managers"],
    "POSITIVE CONTROL: the two directories the wrapper names still get their app, so the third's `none` is the rule and not a dead app");
  assert.equal(tokenOf(asReviewer.stdout), "none", "a reviewer given the workers' token is the author of the PR it reviews, and GitHub refuses its approval");
  assert.equal(h.mints(), 0, "no process was started for any of the three");
  const reviewerLines = readFileSync(join(reviewer, "gh-calls.tsv"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(reviewerLines.map((l) => parseLine(l)?.account), ["a11ign-bot"], "the ledger names the account the call went out as, and no `app:` role");
});

test("#817: `AGENT_ORG_GH_ROLE` still wins over a config of its own, and a unit's own config with no workspace is no app either", () => {
  const h = seededHost(["scheduler", "ghs_scheduler"], ["workers", "ghs_workers"]);
  const own = reviewerConfig(h);
  assert.equal(tokenOf(h.run({ HERDR_WORKSPACE_ID: "w3", GH_CONFIG_DIR: own, AGENT_ORG_GH_ROLE: "scheduler" }, "pr", "list").stdout), "ghs_scheduler",
    "a caller that declares its role is not second-guessed by its directory");
  assert.equal(tokenOf(h.run({ GH_CONFIG_DIR: own }, "pr", "list").stdout), "none", "no workspace and a directory of its own: the account the directory names");
  assert.equal(tokenOf(h.run({ GH_CONFIG_DIR: WORKERS_CFG(h) }, "pr", "list").stdout), "ghs_scheduler", "no workspace and the workers' directory is still the scheduler");
});

test("#4900: a role a caller declares (`AGENT_ORG_GH_ROLE`) outranks the workspace, and an unknown value is ignored", () => {
  const h = host();
  h.seed("scheduler", "ghs_scheduler"); h.seed("workers", "ghs_workers");
  assert.equal(tokenOf(h.run({ HERDR_WORKSPACE_ID: "w3", AGENT_ORG_GH_ROLE: "scheduler" }, "pr", "list").stdout), "ghs_scheduler");
  assert.equal(tokenOf(h.run({ HERDR_WORKSPACE_ID: "w3", AGENT_ORG_GH_ROLE: "root" }, "pr", "list").stdout), "ghs_workers");
});

test("#4900: THE DEFAULT IS TODAY'S: no app roles, or a role without one, reaches `gh-real` with no token and the account in the ledger", () => {
  const h = host();
  h.seed("scheduler", "ghs_scheduler"); h.seed("workers", "ghs_workers");
  const off = h.run({ A11Y_APP_ROLES: "", HERDR_WORKSPACE_ID: "w3" }, "pr", "list");
  assert.equal(off.stdout, "token=none args=pr list\n", "POSITIVE CONTROL: the stub ran, and it saw no token");
  const mixed = h.run({ A11Y_APP_ROLES: "scheduler", HERDR_WORKSPACE_ID: "w3" }, "pr", "list");
  assert.equal(tokenOf(mixed.stdout), "none", "the per-role mix: workers stays on its account while the scheduler is on an app");
  assert.deepEqual(h.lines().map((l) => parseLine(l)?.account), ["a11ign-ai-workers", "a11ign-ai-workers"]);
  assert.equal(h.mints(), 0);
});

test("#4900: an explicit GH_TOKEN or GITHUB_TOKEN is not re-routed, and the ledger names the app for a call made as one", () => {
  const h = host();
  h.seed("workers", "ghs_workers");
  assert.equal(tokenOf(h.run({ HERDR_WORKSPACE_ID: "w3", GH_TOKEN: "ghp_explicit" }, "pr", "list").stdout), "ghp_explicit");
  assert.equal(tokenOf(h.run({ HERDR_WORKSPACE_ID: "w3", GITHUB_TOKEN: "ghp_other" }, "pr", "list").stdout), "none", "GITHUB_TOKEN is the runner's: gh-real reads it, the wrapper stays out");
  h.run({ HERDR_WORKSPACE_ID: "w3" }, "pr", "list");
  assert.equal(parseLine(h.lines()[2])?.account, "app:workers", "the pool is charged to the app that spent it");
});

test("#4900: a stale token (under the margin) is replaced by ONE mint and the next call is served from the file", () => {
  const h = host();
  h.seed("workers", "ghs_old", REFRESH_MARGIN_SECONDS - 1);
  const first = h.run({ HERDR_WORKSPACE_ID: "w3", MINT_TOKEN: "ghs_new" }, "pr", "list");
  const second = h.run({ HERDR_WORKSPACE_ID: "w3", MINT_TOKEN: "ghs_never" }, "pr", "list");
  assert.deepEqual([tokenOf(first.stdout), tokenOf(second.stdout), h.mints()], ["ghs_new", "ghs_new", 1]);
});

test("#4900: FALLBACK: a mint that fails sends the call through as the account, leaves ONE incident line, and is not retried inside the window", () => {
  const h = host();
  const fail = { HERDR_WORKSPACE_ID: "w3", MINT_FAIL: "app token: key: /keys/w.pem cannot be read" };
  const first = h.run({ ...fail, STUB_STATUS: "0" }, "pr", "list");
  assert.deepEqual([first.status, tokenOf(first.stdout)], [0, "none"], "the call went through, as today's account");
  assert.equal(first.stderr, "", "the minter's complaint is not the caller's stderr");
  const incidents = h.lines().map((l) => parseLine(l)).filter((e) => e?.resource === "incident");
  assert.equal(incidents.length, 1, "one incident");
  assert.deepEqual([incidents[0]?.status, incidents[0]?.command], [1, "app-token workers"]);
  assert.match(incidents[0]?.caller ?? "", /cannot be read/, "the stage and reason are on the line");
  assert.ok(!existsSync(join(h.tokens, "workers.token")), "no token file came of it");
  const calls = h.lines().map((l) => parseLine(l)).filter((e) => e !== null && e.resource !== "incident");
  assert.deepEqual(calls.map((e) => e?.account), ["a11ign-ai-workers"], "the call that fell back is charged to the account it spent, not to an app that never answered");

  h.run(fail, "pr", "list");
  assert.deepEqual([h.mints(), h.lines().filter((l) => l.includes("\tincident\t")).length], [1, 1], "inside the window: no second mint, no second incident");

  writeFileSync(join(h.tokens, "workers.failed"), `${nowSeconds() - 61}\n`);
  h.run(fail, "pr", "list");
  assert.deepEqual([h.mints(), h.lines().filter((l) => l.includes("\tincident\t")).length], [2, 2], "after the window the role is asked again");
});

// #1347: THE REVIEWER IS REFUSED, NOT FALLEN BACK. A reviewer's call sent as the account counts as the account's approval on `main` (agent-org#1242),
// so when its App's token cannot be minted the call is refused: non-zero, nothing sent, the reason on stderr. Every other role keeps the fallback.
// #1399: the refusal is behind `AGENT_ORG_REVIEWER_REFUSAL=1`, OFF by default; this test runs with it ON.
test("#1347 (switch on by #1399): a reviewer whose App token cannot be minted is REFUSED: nothing is sent, the reason is on stderr; another role still falls back", () => {
  const reviewerApp = { mode: "github-apps", appId: "id-reviewer", keyPath: "/nonexistent-4900/reviewer.pem" };
  const h = host(wrapperFor({ ...THREE_APPS, reviewer: reviewerApp }));
  const roles = "scheduler workers managers reviewer";
  const cause = "app token: key: /keys/reviewer.pem cannot be read";
  const reviewerDir = reviewerConfig(h);
  const asReviewer = { AGENT_ORG_GH_ROLE: "reviewer", GH_CONFIG_DIR: reviewerDir, A11Y_APP_ROLES: roles, MINT_FAIL: cause, TMPDIR: h.root, AGENT_ORG_REVIEWER_REFUSAL: "1" };
  const refused = h.run(asReviewer, "pr", "review", "42", "--approve");
  assert.deepEqual([refused.status, refused.stdout], [1, ""], "REFUSED: non-zero, and the stub that would have sent the call never ran");
  assert.match(refused.stderr, /^gh: refused: the reviewer call is NOT sent as the account\. app-token reviewer failed for App id-reviewer: app token: key: \/keys\/reviewer\.pem cannot be read \(exit 1\)\n$/,
    "the stderr line names the role, the App and the mint failure");
  assert.equal(h.mints(), 1, "the minter was asked once");
  const reviewerLedger = readFileSync(join(reviewerDir, "gh-calls.tsv"), "utf8").split("\n").filter(Boolean).map((l) => parseLine(l));
  assert.ok(reviewerLedger.some((e) => e?.resource === "incident" && /cannot be read \(exit 1\)$/.test(e.caller ?? "")), "the incident is on the reviewer's ledger as well as on stderr");

  const again = h.run(asReviewer, "pr", "review", "42", "--approve");
  assert.deepEqual([again.status, again.stdout], [1, ""], "inside the 60-second window the reviewer is still refused, with no second mint");
  assert.match(again.stderr, /cannot be read \(exit 1\)\n$/, "the reason is kept for the window too");
  assert.equal(h.mints(), 1);

  const fallback = h.run({ HERDR_WORKSPACE_ID: "w3", MINT_FAIL: cause }, "pr", "list");
  assert.deepEqual([fallback.status, tokenOf(fallback.stdout), fallback.stderr], [0, "none", ""],
    "POSITIVE CONTROL: the same failure for a worker still goes through as the account, so the refusal is the reviewer's and not a dead wrapper");
});

test("#4900: the call's status and stdin are the caller's own through an app, and the minter never sees the stdin", () => {
  const h = host();
  const spawnWithStdin = spawnSync("sh", [WRAPPER, "issue", "create", "--body-file", "-"], {
    encoding: "utf8", input: "the body\n",
    env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: join(h.root, "gh-real"), A11Y_WORKERS_DIR: join(h.root, "workers"), A11Y_LEADS_DIR: join(h.root, "leads"),
      A11Y_GH_READ_CACHE: "off", A11Y_APP_ROLES: "workers", A11Y_APP_TOKEN_DIR: h.tokens, A11Y_APP_NODE: "sh", A11Y_APP_TOKEN_SCRIPT: join(h.root, "mint.sh"),
      MINT_TOKEN: "ghs_minted", HERDR_WORKSPACE_ID: "w3", STUB_STDIN: "1", STUB_STATUS: "7" },
  });
  assert.equal(spawnWithStdin.status, 7, "gh-real's own status");
  assert.match(spawnWithStdin.stdout, /^token=ghs_minted args=issue create --body-file -\nstdin=the body\n$/, "the mint ran (it consumes its stdin) and the body still arrived");
  assert.equal(h.mints(), 1, "POSITIVE CONTROL: the minter did run, so its `cat` had a stdin to take");
});

test("#4900: the minter is handed the role's declared app, quoted for `sh`: an id, a key path with a space and a quote, and an installation", () => {
  const awkward = "/home/h/it's here/workers.pem";
  const h = host(wrapperFor({ ...THREE_APPS, workers: { mode: "github-apps", appId: "4242", keyPath: awkward, installationId: "99" } }));
  h.run({ HERDR_WORKSPACE_ID: "w3" }, "pr", "list");
  assert.equal(h.handed(), `4242|${awkward}|99|workers`);
  h.run({ HERDR_WORKSPACE_ID: "w6", GH_CONFIG_DIR: "" }, "pr", "list", "--json", "number", "--limit", "30");
  assert.equal(h.handed(), "id-managers|/nonexistent-4900/managers.pem||managers", "the other role's app, and no installation when none is declared");
});

test("#4900: the REAL minter, run by the wrapper from a directory in no project: a missing key falls back and says `key` on the incident line", () => {
  const h = host();
  const r = h.run({ A11Y_APP_NODE: process.execPath, A11Y_APP_TOKEN_SCRIPT: fileURLToPath(new URL("./app-token.ts", import.meta.url)),
    HERDR_WORKSPACE_ID: "w3", TMPDIR: h.root }, "pr", "list");
  assert.deepEqual([r.status, tokenOf(r.stdout)], [0, "none"]);
  const incident = h.lines().map((l) => parseLine(l)).find((e) => e?.resource === "incident");
  assert.match(incident?.caller ?? "", /app token: key: \/nonexistent-4900\/workers\.pem cannot be read/, "the minter ran, read the app the wrapper handed it and named the stage");
});
