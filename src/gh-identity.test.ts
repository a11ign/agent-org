// no-token: gh -- the wrapper is RUN here against a stub `gh-real` (`A11Y_GH_REAL`) and a stub minter (`A11Y_APP_NODE`/`A11Y_APP_TOKEN_SCRIPT`); the stub
// records every call it receives, so "GitHub was not asked" is read off a file the stub did not write, and no `gh` starts and nothing reaches the network.
//
// agent-org#791: `gh api user` UNDER A ROLE'S APP IS ANSWERED FROM THE DECLARATION. An installation token is refused `GET /user` (403), and `pr:open`, the
// review door and the weekly post all ask it who they are. Three things are pinned, each by running the wrapper and not by reading it:
//   1. THE ANSWER: a call that goes out as a role's App, asking `api user` bare or with `.login`, prints `<slug>[bot]` and never reaches the stub;
//   2. THE OTHER DIRECTION: every call that is not that one (a role with an App and no slug, another filter, another endpoint, an explicit token, a
//      mint that failed, a role with no App) still reaches the stub with exactly the arguments it was given;
//   3. THE DECLARATION: `slug` is read, refused by field name when it is not a slug, and rendered into the wrapper beside the app it belongs to.
// The positive control for every "GitHub was not asked" is the same stub receiving a call that SHOULD reach it, so a wrapper that never ran the stub
// at all cannot pass them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLine } from "./gh-ledger.ts";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";

// `host-config.ts` resolves the project's checkout from `$AGENT_ORG_HOST` or the working directory AT IMPORT, so the host file is named first and the
// module imported after it (`app-token.test.ts` does the same); `??=` leaves a host a caller already named alone.
const SETUP = tmpDirForFile("gh-identity-791-setup-");
writeFileSync(join(SETUP, "host.json"), JSON.stringify({ projects: [{ id: "p", checkout: SETUP }], primary: "p" }));
process.env.AGENT_ORG_HOST ??= join(SETUP, "host.json");
const { HostConfigRefusal, parseHostConfig, renderTemplate, roleIdentity, templateValues } = await import("./host-config.ts");
const { SUPPORTED_SCHEMA } = await import("./project-config.ts");

const HOST = {
  schema: SUPPORTED_SCHEMA, home: "/home/h", binDir: "/home/h/bin", primary: "p", projects: [{ id: "p", checkout: "/home/h/p" }],
  gh: { workers: "/home/h/workers", leads: "/home/h/leads", leadsHeader: [], leadsWorkspaces: [] },
};
const UNITS = { prefix: "x-", boardReportWorkflow: "b.yml", own: [] };
const parse = (extra: Record<string, unknown>) => parseHostConfig(JSON.stringify({ ...HOST, ...extra }), "host.json");
const refusalField = (extra: Record<string, unknown>) => {
  try { parse(extra); } catch (error) { return error instanceof HostConfigRefusal ? error.field : `not a refusal: ${error}`; }
  return "not refused";
};
const APP = { mode: "github-apps", appId: "123456", keyPath: "/home/h/.config/agent-org/apps/a.pem" };

// ---- 3. the declaration -----------------------------------------------------------------------------------------------------------

test("#791: `slug` is read when the role declares one and is simply absent when it does not", () => {
  const host = parse({ github: { identity: { workers: { ...APP, slug: "a11ign-workers" }, scheduler: APP } } });
  assert.deepEqual(roleIdentity(host, "workers"), { ...APP, slug: "a11ign-workers" });
  assert.deepEqual(roleIdentity(host, "scheduler"), APP, "no `slug` key at all, not an empty one: a declaration from before this reads as it did");
});

test("#791: a `slug` that is not one is refused BY FIELD NAME: the `[bot]` suffix, a path, a blank, a number; and one under `user-accounts`", () => {
  const role = (value: unknown) => ({ github: { identity: { workers: value } } });
  const named = (slug: unknown) => refusalField(role({ ...APP, slug }));
  assert.equal(named("a11ign-workers[bot]"), "github.identity.workers.slug", "the wrapper appends `[bot]`, so a written one would answer `x[bot][bot]`");
  assert.equal(named("a11ign/workers"), "github.identity.workers.slug");
  assert.equal(named(""), "github.identity.workers.slug");
  assert.equal(named(" a11ign "), "github.identity.workers.slug");
  assert.equal(named("-a11ign"), "github.identity.workers.slug");
  assert.equal(named(5267128), "github.identity.workers.slug");
  assert.equal(refusalField(role({ mode: "user-accounts", slug: "a11ign-workers" })), "github.identity.workers.slug", "a slug named under user-accounts would be ignored");
  assert.equal(named("a11ign-workers"), "not refused", "POSITIVE CONTROL: the valid form is not refused by any of the above");
});

test("#791: the rendered wrapper carries each role's slug beside its app, and an empty one for a role declared without", () => {
  const values = templateValues(parse({ github: { identity: { workers: { ...APP, slug: "a11ign-workers" }, managers: APP } } }), UNITS);
  const arms = values.appDeclared.split("\n");
  assert.match(arms.find((l) => l.includes("workers)")) ?? "", /app_slug='a11ign-workers' ;;$/);
  assert.match(arms.find((l) => l.includes("managers)")) ?? "", /app_slug='' ;;$/);
});

// ---- 1 and 2. the wrapper, run ------------------------------------------------------------------------------------------------------

/** The wrapper RENDERED THROUGH `templateValues`, as the installed one is, from a host declaring an app (and a slug, unless `slug` is null) per role. */
function wrapperFor(slugs: Record<string, string | null>) {
  const text = readFileSync(fileURLToPath(new URL("../host/gh", import.meta.url)), "utf8");
  const identity = Object.fromEntries(["scheduler", "workers", "managers"].map((role) => [role, {
    ...APP, appId: `id-${role}`, keyPath: `/nonexistent-791/${role}.pem`, ...(slugs[role] === null ? {} : { slug: slugs[role] }),
  }]));
  const rendered = join(tmpDirForFile("gh-identity-791-wrapper-"), "gh");
  writeFileSync(rendered, renderTemplate(text, templateValues(parse({ github: { identity } }), UNITS), "gh"), { mode: 0o755 });
  return rendered;
}
const SLUGS = { scheduler: "a11ign-scheduler", workers: "a11ign-workers", managers: "a11ign-managers" };
const WRAPPER = wrapperFor(SLUGS);
const NO_SLUG = wrapperFor({ scheduler: null, workers: null, managers: null });

/** A host: the two account directories, a stub `gh-real` that records its arguments and the token it was given, and a minter that fails when told to. */
function host(wrapper = WRAPPER) {
  const root = tmpDir("gh-identity-791-host-");
  for (const [dir, login] of [["workers", "a11ign-ai-workers"], ["leads", "a11ign-ai-leads"]]) {
    mkdirSync(join(root, dir, "gh"), { recursive: true });
    writeFileSync(join(root, dir, "gh", "hosts.yml"), `github.com:\n    user: ${login}\n    oauth_token: not-a-token\n`);
  }
  writeFileSync(join(root, "leads", "workspaces.txt"), "# w6 ceo\nw6\n");
  const reached = join(root, "reached");
  const stub = join(root, "gh-real");
  // the stub's stdout names the token it was handed, so a call that reached it is told apart by what it printed and by the file
  writeFileSync(stub, ["#!/bin/sh", // (agent-org#1395) the wrapper asks an `api graphql` call for its response head (`-i`, to read the pool's counter) and takes the head out again; the stub
    // answers with the args the CALLER gave, so the `-i` is not among them and "reaches GitHub as given" still reads the caller's own argv
    `args=$(printf '%s' "$*" | sed 's/^api graphql -i /api graphql /')`,
    `echo "token=\${GH_TOKEN:-none} args=$args" >> "${reached}"`,
    `echo "stub: token=\${GH_TOKEN:-none} args=$args"`, `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  const minter = join(root, "mint.sh");
  writeFileSync(minter, ["cat > /dev/null", `[ -n "$MINT_FAIL" ] && { echo "$MINT_FAIL" >&2; exit 1; }`,
    `echo "$(( $(date +%s) + 3600 )) $MINT_TOKEN" > "$A11Y_APP_TOKEN_DIR/$1.token"`, `printf %s "$MINT_TOKEN"`, ""].join("\n"));
  const tokens = join(root, "tokens");
  mkdirSync(tokens, { recursive: true });
  const ledger = join(root, "workers", "gh", "gh-calls.tsv");
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const env = {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: join(root, "workers"), A11Y_LEADS_DIR: join(root, "leads"),
      A11Y_GH_LEDGER_NOW: "2026-10-11T00:00:00Z", A11Y_GH_READ_CACHE: "off", A11Y_APP_ROLES: "scheduler workers managers", A11Y_APP_TOKEN_DIR: tokens,
      A11Y_APP_NODE: "sh", A11Y_APP_TOKEN_SCRIPT: minter, MINT_TOKEN: "ghs_minted", ...extra,
    };
    const r = spawnSync("sh", [wrapper, ...args], { encoding: "utf8", env, input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const seed = (role: string, token: string) => writeFileSync(join(tokens, `${role}.token`), `${Math.floor(Date.now() / 1000) + 3600} ${token}\n`);
  /** What reached `gh-real`, one `token=… args=…` per call. */
  const calls = () => (existsSync(reached) ? readFileSync(reached, "utf8").split("\n").filter(Boolean) : []);
  const entries = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => parseLine(l)) : []);
  return { root, run, seed, calls, entries };
}
const WORKER = { HERDR_WORKSPACE_ID: "w3" };

test("#791: a worker under the workers App asking `api user --jq .login` is answered `<slug>[bot]` and GitHub is not asked", () => {
  const h = host();
  h.seed("workers", "ghs_workers");
  const control = h.run(WORKER, "pr", "list");
  assert.equal(control.stdout, "stub: token=ghs_workers args=pr list\n", "POSITIVE CONTROL: the stub is reachable, and the call went out under the App's token");
  assert.equal(h.calls().length, 1);

  const answered = h.run(WORKER, "api", "user", "--jq", ".login");
  assert.deepEqual([answered.status, answered.stdout, answered.stderr], [0, "a11ign-workers[bot]\n", ""]);
  assert.equal(h.calls().length, 1, "the answer came from the declaration: the stub saw no second call");
  const [, line] = h.entries();
  assert.deepEqual([line?.account, line?.resource, line?.command, line?.status], ["app:workers", "declared", "api user", 0],
    "the ledger names the App and records a call that spent no pool");
});

test("#791: every spelling the callers use is answered: bare is `{login}`, and `.login` through any of the five flag forms, `user` or `/user`", () => {
  const h = host();
  h.seed("workers", "ghs_workers");
  const bare = h.run(WORKER, "api", "user");
  assert.deepEqual([bare.status, JSON.parse(bare.stdout)], [0, { login: "a11ign-workers[bot]" }], "bare `api user` is JSON, as gh prints it");
  for (const args of [["--jq", ".login"], ["-q", ".login"], ["--jq=.login"], ["-q.login"], ["-q=.login"]]) {
    for (const path of ["user", "/user"]) {
      assert.equal(h.run(WORKER, "api", path, ...args).stdout, "a11ign-workers[bot]\n", `api ${path} ${args.join(" ")}`);
    }
  }
  assert.equal(h.calls().length, 0, "not one of them reached the stub");
});

test("#791: each role is answered with ITS OWN App's login: the gate's scheduler, a worker, a manager and a spawned seat on the leads config", () => {
  const h = host();
  for (const role of ["scheduler", "workers", "managers"]) h.seed(role, `ghs_${role}`);
  const asked = (extra: Record<string, string>) => h.run(extra, "api", "user", "--jq", ".login").stdout;
  assert.deepEqual([
    asked({ GH_CONFIG_DIR: join(h.root, "workers", "gh") }), asked(WORKER), asked({ HERDR_WORKSPACE_ID: "w6" }),
    asked({ HERDR_WORKSPACE_ID: "w9", GH_CONFIG_DIR: join(h.root, "leads", "gh") }), asked({ ...WORKER, AGENT_ORG_GH_ROLE: "scheduler" }),
  ], ["a11ign-scheduler[bot]\n", "a11ign-workers[bot]\n", "a11ign-managers[bot]\n", "a11ign-managers[bot]\n", "a11ign-scheduler[bot]\n"]);
  assert.equal(h.calls().length, 0);
});

test("#791: UNCHANGED: a role with an App and NO slug goes through to GitHub with the App's token, as before this row", () => {
  const h = host(NO_SLUG);
  h.seed("workers", "ghs_workers");
  const r = h.run(WORKER, "api", "user", "--jq", ".login");
  assert.equal(r.stdout, "stub: token=ghs_workers args=api user --jq .login\n", "the wrapper has no login to give and does not guess one");
  assert.deepEqual(h.calls(), ["token=ghs_workers args=api user --jq .login"]);
});

test("#791: UNCHANGED: a question this cannot answer exactly is sent through: another filter, a header, `-i`, a host, another endpoint, a write", () => {
  const h = host();
  h.seed("workers", "ghs_workers");
  const sent = [
    ["api", "user", "--jq", ".id"], ["api", "user", "--jq", ".login", "-i"], ["api", "user", "-i"], ["api", "user", "-H", "Accept: x"],
    ["api", "user", "--hostname", "ghe.example"], ["api", "user", "--jq", ".login,.id"], ["api", "user", "--method", "PATCH"],
    ["api", "users/someone"], ["api", "user/emails"], ["api", "repos/a/b", "--jq", ".login"], ["api", "graphql", "-f", "query={viewer{login}}"], ["pr", "view", "user"],
  ];
  for (const args of sent) {
    const r = h.run(WORKER, ...args);
    assert.equal(r.stdout, `stub: token=ghs_workers args=${args.join(" ")}\n`, `${args.join(" ")} must reach GitHub as given`);
  }
  assert.equal(h.calls().length, sent.length, "every one of them reached the stub exactly once");
});

test("#791: UNCHANGED: an explicit GH_TOKEN, a role with no App, and a mint that failed are each the account's own `api user`", () => {
  const h = host();
  h.seed("workers", "ghs_workers");
  const ask = ["api", "user", "--jq", ".login"];
  const explicit = h.run({ ...WORKER, GH_TOKEN: "ghp_person" }, ...ask);
  assert.equal(explicit.stdout, "stub: token=ghp_person args=api user --jq .login\n", "a caller that named a credential is not answered for");
  const noApp = h.run({ ...WORKER, A11Y_APP_ROLES: "" }, ...ask);
  assert.equal(noApp.stdout, "stub: token=none args=api user --jq .login\n", "a host declaring no App is routed exactly as before");
  const only = h.run({ ...WORKER, A11Y_APP_ROLES: "scheduler" }, ...ask);
  assert.equal(only.stdout, "stub: token=none args=api user --jq .login\n", "a role the host declares no App for");

  const failing = host();
  const fell = failing.run({ ...WORKER, MINT_FAIL: "app token: key: cannot be read" }, ...ask);
  assert.equal(fell.stdout, "stub: token=none args=api user --jq .login\n",
    "the call is the account's (the mint failed), so its login is what GitHub says, and the App's is NOT claimed");
  assert.equal(failing.calls().length, 1);
  assert.equal(h.calls().length, 3);
});
