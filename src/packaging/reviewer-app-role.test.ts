// no-token: gh -- the wrapper is RUN here against a stub `gh-real` (`A11Y_GH_REAL`) and a stub minter (`A11Y_APP_NODE`/`A11Y_APP_TOKEN_SCRIPT`); no `gh` starts and nothing reaches the network or any account's config.
// a11ign/a11ign#5044 step 1 (agent-org#955): `reviewer` IS A FOURTH ROLE IN `github.identity`, AND NOTHING CHANGES UNTIL A HOST DECLARES IT.
//
// The reviewer's approvals are authored by the machine USER `a11ign-bot` because no code path let a role other than `scheduler`, `workers` and
// `managers` be an App. This file pins the two halves of the row, each by RUNNING the thing:
//   1. DECLARED: a host that names `reviewer` as `github-apps` makes a call carrying `AGENT_ORG_GH_ROLE=reviewer` (the value `reviewerEnvironment`
//      sets, read from there and not retyped) go out on the stub minter's token.
//   2. NOT DECLARED (the default, and the whole of the row's blast radius): the same call goes out as the reviewer's own config account, with no
//      minter started and the ledger line the byte-for-byte one a call without the variable leaves.
// The wrapper is RENDERED through `templateValues` from the declaration, so `@@appRoles@@` and the `case` of declared apps are the installed
// ones, and `A11Y_APP_ROLES` is deliberately NOT overridden: overriding it would test the override and not what the host rendered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../app-token-cache.ts";
import { createWrapper, wrapperRoles } from "../../plugins/github/wrapper.ts";
import { wrapperInputsOf } from "../plugins/host-place.ts";
import { APP_ROLE_LANE_OWNER } from "../lane-ownership.ts";
import { parseLine } from "../gh-ledger.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// No `$AGENT_ORG_HOST` of this file's own: `wake.ts` reads the host through `work-gate.ts` at import, a host file this file wrote would have to be a
// whole valid one (CI, where the variable is unset and the project is found from the working directory, refused the bare one it first wrote), and
// `wake-reviewer-instance.test.ts` imports the same modules as they are. The host here is what the run was given.
import { GITHUB_ROLES, HostConfigRefusal, parseHostConfig, roleIdentity } from "../host-config.ts";
import { SUPPORTED_SCHEMA } from "../project-config.ts";
import { reviewerEnvironment } from "../wake/pull-request-spawn-orders.ts";

const HOST = {
  schema: SUPPORTED_SCHEMA, home: "/home/h", binDir: "/home/h/bin", primary: "p", projects: [{ id: "p", checkout: "/home/h/p" }],
  gh: { workers: "/home/h/workers", leads: "/home/h/leads", leadsHeader: [], leadsWorkspaces: [] },
};
const parse = (extra: Record<string, unknown>) => parseHostConfig(JSON.stringify({ ...HOST, ...extra }), "host.json");
const refusalField = (extra: Record<string, unknown>) => {
  try { parse(extra); } catch (error) { return error instanceof HostConfigRefusal ? error.field : `not a refusal: ${error}`; }
  return "not refused";
};
/** The wrapper as the GitHub plugin renders it for a host (A11-160: the renderer is the plugin's). */
const renderedFor = (host: ReturnType<typeof parse>) => createWrapper({ exec: () => ({ status: null, stdout: "", stderr: "no program" }), readFile: (path) => readFileSync(path, "utf8"), env: {} }).file(wrapperInputsOf(host)).expected as string;
const REVIEWER_APP = { mode: "github-apps", appId: "424242", keyPath: "/home/h/.config/agent-org/apps/a11ign-reviewer.pem", slug: "a11ign-reviewer" };
/** The value the wake side puts in the reviewer instance's environment: the wrapper is driven with THIS, so the two halves cannot drift apart. */
const REVIEWER_ROLE = reviewerEnvironment("reviewer-7").AGENT_ORG_GH_ROLE;

// ---- 1. the declaration ----------------------------------------------------------------------------------------------------------

test("#955: `reviewer` is a role `github.identity` accepts, `user-accounts` unless a host says otherwise, and the other three are unmoved", () => {
  assert.deepEqual([...GITHUB_ROLES], ["scheduler", "workers", "managers", "reviewer"]);
  assert.equal(REVIEWER_ROLE, "reviewer", "the wake side names the role the declaration spells");
  assert.deepEqual(GITHUB_ROLES.map((role) => roleIdentity(parse({}), role).mode), ["user-accounts", "user-accounts", "user-accounts", "user-accounts"],
    "a host that says nothing is user-accounts for the reviewer, as for every role");
  const declared = parse({ github: { identity: { reviewer: REVIEWER_APP } } });
  assert.deepEqual(roleIdentity(declared, "reviewer"), REVIEWER_APP);
  assert.deepEqual(GITHUB_ROLES.filter((role) => roleIdentity(declared, role).mode === "github-apps"), ["reviewer"], "only the role that was named moved");
  assert.deepEqual(wrapperRoles(renderedFor(declared)), ["reviewer"]);
  assert.deepEqual(wrapperRoles(renderedFor(parse({}))), [], "NEGATIVE CONTROL: nothing declared renders no app role, so the wrapper takes none of the app paths");
});

test("#955: a typo of the role is still refused by FIELD NAME, and a half-flipped reviewer is refused as any role's is", () => {
  const role = (value: unknown, name: string) => ({ github: { identity: { [name]: value } } });
  assert.equal(refusalField(role(REVIEWER_APP, "reviewers")), "github.identity.reviewers", "a typo would leave the reviewer on the account while looking migrated");
  assert.equal(refusalField(role(REVIEWER_APP, "Reviewer")), "github.identity.Reviewer");
  assert.equal(refusalField(role({ mode: "user-accounts", appId: "1" }, "reviewer")), "github.identity.reviewer.appId");
  assert.equal(refusalField(role({ mode: "github-apps", appId: "1" }, "reviewer")), "github.identity.reviewer.keyPath");
  assert.equal(refusalField(role(REVIEWER_APP, "reviewer")), "not refused", "POSITIVE CONTROL: the valid form is not refused by any of the above");
  try {
    parse(role(REVIEWER_APP, "reviewers"));
    assert.fail("the typo was accepted");
  } catch (error) {
    assert.match((error as Error).message, /scheduler, workers, managers, reviewer\b/, "the refusal's text names all four roles");
  }
});

test("#955: the reviewer App owns no review-only lane, and its token is cached in a file of its own beside the other roles'", () => {
  assert.equal(APP_ROLE_LANE_OWNER.reviewer, null, "a reviewer App only reviews; it authors no pull request");
  assert.equal(tokenPath("/cache", "reviewer"), "/cache/reviewer.token");
  assert.notEqual(tokenPath("/cache", "reviewer"), tokenPath("/cache", "workers"), "one role's refresh never races another's");
});

// ---- 2. the wrapper, run ---------------------------------------------------------------------------------------------------------

const wrapperFor = (identity: Record<string, unknown>) => {
  const rendered = join(tmpDirForFile("reviewer-app-role-wrapper-"), "gh");
  writeFileSync(rendered, renderedFor(parse(Object.keys(identity).length === 0 ? {} : { github: { identity } })), { mode: 0o755 });
  return rendered;
};
// Built inside each test, never at import: a role the reader refuses must turn THAT test red and not take the whole file down with it.
const DECLARED = () => wrapperFor({ reviewer: { ...REVIEWER_APP, installationId: "9001" } });
const UNDECLARED = () => wrapperFor({});
const WORKERS_ONLY = () => wrapperFor({ workers: { mode: "github-apps", appId: "id-workers", keyPath: "/nonexistent-955/workers.pem" } });
const LEDGER_NOW = "2026-10-11T12:00:00Z";
const BOT = "a11ign-bot";

/**
 * A host: the workers' and leads' config directories, the REVIEWER's own (`/home/agent/reviewer/gh`, whose account is `a11ign-bot`), a stub `gh-real`
 * that prints the token it was given, and a stub minter that counts its runs. `run` is the wrapper as a reviewer instance reaches it: the
 * reviewer's config, a workspace id, and the role the wake side declares.
 */
function host(wrapper: string) {
  const root = tmpDir("reviewer-app-role-host-");
  for (const [dir, login] of [["workers", "a11ign-ai-workers"], ["leads", "a11ign-ai-leads"], ["reviewer", BOT]]) {
    mkdirSync(join(root, dir, "gh"), { recursive: true });
    writeFileSync(join(root, dir, "gh", "hosts.yml"), `github.com:\n    user: ${login}\n    oauth_token: not-a-token\n`);
  }
  writeFileSync(join(root, "leads", "workspaces.txt"), "# w6 ceo\nw6\n");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh", `echo "token=\${GH_TOKEN:-none} args=$*"`, `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  const minter = join(root, "mint.sh");
  const count = join(root, "mint-count");
  writeFileSync(minter, [
    `echo run >> "${count}"`, "cat > /dev/null",
    `echo "$A11Y_APP_ID|$A11Y_APP_KEY_PATH|$A11Y_APP_INSTALLATION_ID|$1" > "${join(root, "handed")}"`,
    `[ -n "$MINT_FAIL" ] && { echo "$MINT_FAIL" >&2; exit 1; }`,
    `echo "$(( $(date +%s) + 3600 )) $MINT_TOKEN" > "$A11Y_APP_TOKEN_DIR/$1.token"`,
    `printf %s "$MINT_TOKEN"`, ""].join("\n"));
  const reviewerDir = join(root, "reviewer", "gh");
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const env = {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: join(root, "workers"), A11Y_LEADS_DIR: join(root, "leads"),
      A11Y_GH_LEDGER_NOW: LEDGER_NOW, A11Y_GH_READ_CACHE: "off", A11Y_APP_TOKEN_DIR: join(root, "tokens"), A11Y_APP_NODE: "sh",
      A11Y_APP_TOKEN_SCRIPT: minter, MINT_TOKEN: "ghs_reviewer_minted", GH_CONFIG_DIR: reviewerDir, HERDR_WORKSPACE_ID: "w9", ...extra,
    };
    const r = spawnSync("sh", [wrapper, ...args], { encoding: "utf8", env, input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const mints = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const ledgerPath = join(reviewerDir, "gh-calls.tsv");
  const lines = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : []);
  const handed = () => readFileSync(join(root, "handed"), "utf8").trim();
  return { root, run, mints, lines, handed };
}
const asReviewer = { AGENT_ORG_GH_ROLE: REVIEWER_ROLE };

test("#955 POSITIVE CONTROL: a host that declares `reviewer` as `github-apps` sends a call carrying the role out on the reviewer App's minted token", () => {
  const h = host(DECLARED());
  const call = h.run(asReviewer, "pr", "view", "955");
  assert.equal(call.stdout, "token=ghs_reviewer_minted args=pr view 955\n", "the stub's OWN marker is seen: the call reached gh-real as the App's");
  assert.equal(call.status, 0);
  assert.equal(h.mints(), 1, "one mint, for the role");
  assert.equal(h.handed(), `424242|${REVIEWER_APP.keyPath}|9001|reviewer`, "the minter is handed the reviewer's declared app, id, key and installation, and the role");
  assert.deepEqual(h.lines().map((l) => parseLine(l)?.account), ["app:reviewer"], "the ledger names the App, so its pool is not charged to a11ign-bot");
  const second = h.run(asReviewer, "pr", "list");
  assert.equal(second.stdout, "token=ghs_reviewer_minted args=pr list\n", "the next call is served from the cache file");
  assert.equal(h.mints(), 1, "and starts no second process");
  assert.ok(existsSync(join(h.root, "tokens", "reviewer.token")), "the token is cached under the role's own name");
});

test("#955 NEGATIVE CONTROL: a host that declares nothing sends the same call out as the config's account, with no minter started, byte for byte", () => {
  const h = host(UNDECLARED());
  const withRole = h.run(asReviewer, "pr", "view", "955");
  assert.equal(withRole.stdout, "token=none args=pr view 955\n", "the stub ran and saw NO token: the call is the reviewer config's own");
  assert.equal(h.mints(), 0, "no minter was started");
  assert.equal(existsSync(join(h.root, "tokens")), false, "and no token directory was made");
  assert.deepEqual(h.lines().map((l) => parseLine(l)?.account), [BOT], "the ledger names the account the call went out as, as it always did");
  const without = host(UNDECLARED());
  const bare = without.run({}, "pr", "view", "955");
  assert.deepEqual([withRole.status, withRole.stdout, withRole.stderr], [bare.status, bare.stdout, bare.stderr], "the variable changes nothing the caller can see");
  assert.deepEqual(h.lines(), without.lines(), "nor the ledger line, byte for byte");
  assert.ok(h.lines().length === 1, "POSITIVE CONTROL: there is a line to compare, so the equality above is not two empty lists");
});

test("#955: an App declared for ANOTHER role never reaches the reviewer: no token, no minter (the #817 failure, which `reviewer` must not reopen)", () => {
  const h = host(WORKERS_ONLY());
  const call = h.run(asReviewer, "pr", "view", "955");
  assert.equal(call.stdout, "token=none args=pr view 955\n", "the reviewer was handed no workers token: it would author the PR it reviews");
  assert.equal(h.mints(), 0);
  assert.deepEqual(h.lines().map((l) => parseLine(l)?.account), [BOT]);
  const worker = h.run({ GH_CONFIG_DIR: join(h.root, "workers", "gh"), MINT_TOKEN: "ghs_workers_minted" }, "pr", "view", "955");
  assert.match(worker.stdout, /^token=ghs_workers_minted /, "POSITIVE CONTROL: the workers' App is live in this host, so the reviewer's `none` is the rule and not a dead App");
});

test("#955: the reviewer config alone names no role: a declared reviewer App is reached by `AGENT_ORG_GH_ROLE`, never by the directory (#817)", () => {
  const h = host(DECLARED());
  const bare = h.run({}, "pr", "view", "955");
  assert.equal(bare.stdout, "token=none args=pr view 955\n", "an instance started without the role is the account, not an App");
  assert.equal(h.mints(), 0);
  const named = h.run(asReviewer, "pr", "view", "955");
  assert.match(named.stdout, /^token=ghs_reviewer_minted /, "POSITIVE CONTROL: the same host, the role named");
});

// #1347 (ruling on agent-org#1343): the reviewer's call is REFUSED when its App's token cannot be minted, never sent as `a11ign-bot`.
// #1399: that refusal ships behind `AGENT_ORG_REVIEWER_REFUSAL`, OFF; the two tests after this one are the two sides of the switch.
const SWITCH_ON = { AGENT_ORG_REVIEWER_REFUSAL: "1" };
const MINT_401 = "app token: token: POST answered 401";

test("#955 (ruled by #1347, switch on by #1399): a mint that fails REFUSES the reviewer's call: nothing goes out as `a11ign-bot`, the reason is on stderr, and ONE incident is recorded", () => {
  const h = host(DECLARED());
  const call = h.run({ ...asReviewer, ...SWITCH_ON, MINT_FAIL: MINT_401 }, "pr", "view", "955");
  assert.deepEqual([call.status, call.stdout], [1, ""], "REFUSED: non-zero, and the stub that would have sent the review never ran");
  assert.match(call.stderr, /^gh: refused: the reviewer call is NOT sent as the account\. app-token reviewer failed for App .+: app token: token: POST answered 401 \(exit 1\)\n$/,
    "the caller reads the role, the App and the mint failure on stderr");
  const parsed = h.lines().map((l) => parseLine(l));
  assert.deepEqual(parsed.map((p) => p?.resource), ["incident"], "the incident is the only line: no call was sent");
  assert.match(h.lines()[0], /app-token reviewer failed, refused, not sent as the account: app token: token: POST answered 401 \(exit 1\)/);
  h.run({ ...asReviewer, ...SWITCH_ON, MINT_FAIL: "again" }, "pr", "view", "955");
  assert.equal(h.mints(), 1, "the failed role is not asked again inside the window, and is still refused there");
});

// #1399 (the switch ships OFF): until the reviewer's token cache is writable (agent-org#1342), a refusal stops every review, so a failed mint FALLS BACK.
test("#1399: with the switch OFF (the default) a mint that fails falls back: the reviewer's call goes out as the config's account, and the incident is still recorded", () => {
  const h = host(DECLARED());
  const call = h.run({ ...asReviewer, MINT_FAIL: MINT_401 }, "pr", "view", "955");
  assert.equal(call.status, 0, "NOT REFUSED: the call goes through, as it did before #1347");
  assert.equal(call.stdout, "token=none args=pr view 955\n", "the stub ran and saw NO token: the call is the reviewer config's own account");
  assert.equal(call.stderr, "", "and nothing is said on stderr");
  assert.equal(h.mints(), 1, "the one mint was asked, and it failed");
  assert.equal(parseLine(h.lines()[0])?.resource, "incident");
  assert.equal(h.lines().length, 2, "the incident, then the call's own line");
  assert.match(h.lines()[0], /app-token reviewer failed, fell back to the account: app token: token: POST answered 401 \(exit 1\)/, "POSITIVE CONTROL: the incident is written, and it names the fallback");
  assert.equal(parseLine(h.lines()[1])?.account, BOT, "the call is recorded against the account it went out as");
});

test("#1399: only the value `1` turns the switch on: any other value, or an empty one, falls back as the default does", () => {
  for (const value of ["0", "true", "yes", ""]) {
    const h = host(DECLARED());
    const call = h.run({ ...asReviewer, AGENT_ORG_REVIEWER_REFUSAL: value, MINT_FAIL: MINT_401 }, "pr", "view", "955");
    assert.deepEqual([call.status, call.stdout], [0, "token=none args=pr view 955\n"], `AGENT_ORG_REVIEWER_REFUSAL=${JSON.stringify(value)} is not the switch`);
  }
});
