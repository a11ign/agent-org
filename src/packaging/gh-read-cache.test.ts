// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and nothing reaches the network or any account's config.
//
// #4148: THE SAME READ, ASKED AGAIN, IS ANSWERED FROM DISK. `host/gh` keeps an entry for an identical read for N seconds (20, never more than 30), and for a process the TICK started
// it stays good while the repository's generation has not moved. THE POSITIVE CONTROL for every "answered from the cache" assertion is the stub's own call log: a hit is a call the
// log does not have, and a cache that never stored anything is caught by the first test's second call reading the first call's counter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

const WORKERS = "a11ign-ai-workers";
const NOW = "2026-10-08T15:00:00Z";
const MAX_TTL = 30;
const HIT = "stdout-of-call-";

const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-read-cache-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

/** A stub `gh-real` that numbers its calls, so the SECOND answer of an uncached read differs from the first and a cache hit is the first one repeated. */
const host = () => {
  const root = tmpDir("gh-read-cache-4148-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${WORKERS}\n    oauth_token: not-a-token\n`);
  const log = join(root, "calls.log");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    `echo "$*" >> "${log}"`,
    `n=$(wc -l < "${log}" | tr -d ' ')`,
    `printf '${HIT}%s\\n' "$n"`,
    `echo "stderr-of-call-$n" >&2`,
    `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const rc = join(cfg, "read-cache");
  const call = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", input: "", cwd: extra.CWD ?? root,
      env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, A11Y_GH_LEDGER_NOW: NOW, ...extra } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const ledgerLines = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean) : []);
  /** Rewrite an entry's stored time, to age it without waiting. */
  const age = (seconds: number) => {
    for (const name of readdirSync(join(rc, "e"))) {
      const path = join(rc, "e", name);
      const [first, ...rest] = readFileSync(path, "utf8").split("\n");
      const [, gen] = first.split(" ");
      writeFileSync(path, [`${Math.floor(Date.now() / 1000) - seconds} ${gen}`, ...rest].join("\n"));
    }
  };
  return { root, cfg, rc, call, calls, ledgerLines, age };
};

test("#4148: an identical read inside N seconds is answered from disk: same bytes, no second call, nothing on stderr, a `cache` line in the ledger", () => {
  const h = host();
  const first = h.call({}, "pr", "list", "--json", "number");
  const second = h.call({}, "pr", "list", "--json", "number");
  assert.equal(first.stdout, `${HIT}1\n`);
  assert.equal(second.stdout, first.stdout, "the bytes of the first answer");
  assert.equal(second.stderr, "", "a hit prints nothing on stderr (the first call's stderr was gh's own, and is not replayed)");
  assert.match(first.stderr, /stderr-of-call-1/, "POSITIVE CONTROL: the first call did reach the stub");
  assert.equal(h.calls().length, 1, "the stub was called once");
  const resources = h.ledgerLines().map((l) => l.split("\t")[2]);
  assert.deepEqual(resources, ["graphql?", "cache"], "a hit is recorded, as `cache`, which spends no point");
});

test("#4148: a different argument, directory or repository is a different read", () => {
  const h = host();
  h.call({}, "pr", "list", "--json", "number");
  h.call({}, "pr", "list", "--json", "number,title");
  h.call({ GH_REPO: "a11ign/agent-org" }, "pr", "list", "--json", "number");
  mkdirSync(join(h.root, "sub"));
  h.call({ CWD: join(h.root, "sub") }, "pr", "list", "--json", "number");
  assert.equal(h.calls().length, 4, "four distinct reads, four calls");
});

test("#4148: ANY write by this account drops the cache: the read after it goes to GitHub", () => {
  const h = host();
  h.call({}, "issue", "view", "7");
  assert.equal(h.call({}, "issue", "view", "7").stdout, `${HIT}1\n`, "POSITIVE CONTROL: it was cached");
  h.call({}, "issue", "edit", "7", "--add-label", "x");
  const after = h.call({}, "issue", "view", "7");
  assert.equal(after.stdout, `${HIT}3\n`, "the read after the write is a new call");
  for (const write of [["pr", "merge", "1"], ["api", "-X", "PATCH", "repos/o/r/issues/1"], ["api", "repos/o/r/issues", "-f", "title=x"], ["auth", "login"], ["some-unknown-verb"]]) {
    h.call({}, "issue", "view", "7"); // fill
    const before = h.calls().length;
    h.call({}, ...write);
    h.call({}, "issue", "view", "7");
    assert.equal(h.calls().length, before + 2, `${write.join(" ")}: the write and the re-read both ran`);
  }
  h.call({}, "api", "graphql", "-f", "query=mutation { addLabel }");
  h.call({}, "issue", "view", "8");
  h.call({}, "api", "graphql", "-f", "query=mutation { addLabel }");
  assert.equal(h.call({}, "issue", "view", "8").stdout.startsWith(HIT), true);
  assert.equal(h.calls().filter((c) => c === "issue view 8").length, 2, "a graphql MUTATION is a write too");
});

test("#4148: what is never cached: -i, -H, rate_limit, graphql, --web, --watch, and a failed read", () => {
  const h = host();
  const never: string[][] = [["api", "-i", "repos/o/r/pulls"], ["api", "-H", "If-None-Match: x", "repos/o/r/pulls"], ["api", "rate_limit"], ["api", "repos/o/r/rate_limit"],
    ["api", "graphql", "-f", "query=query { viewer { login } }"], ["pr", "view", "1", "--web"], ["pr", "checks", "1", "--watch"]];
  for (const args of never) {
    const before = h.calls().length;
    h.call({}, ...args);
    h.call({}, ...args);
    assert.equal(h.calls().length, before + 2, `${args.join(" ")} ran both times`);
  }
  const failing = { STUB_STATUS: "1" };
  h.call(failing, "issue", "view", "99");
  h.call({}, "issue", "view", "99");
  assert.equal(h.calls().filter((c) => c === "issue view 99").length, 2, "an exit 1 is not stored");
});

test("#4148: N is 30 or less whatever is asked, and an aged entry is read again", () => {
  const h = host();
  const env = { A11Y_GH_READ_CACHE_SECONDS: "999" };
  h.call(env, "pr", "view", "1");
  h.age(MAX_TTL - 5);
  assert.equal(h.call(env, "pr", "view", "1").stdout, `${HIT}1\n`, "25 s old: still answered");
  h.age(MAX_TTL + 5);
  assert.equal(h.call(env, "pr", "view", "1").stdout, `${HIT}2\n`, "35 s old, with 999 asked: read again, so the bound is 30");
  const off = host();
  off.call({ A11Y_GH_READ_CACHE: "off" }, "pr", "view", "1");
  off.call({ A11Y_GH_READ_CACHE: "off" }, "pr", "view", "1");
  assert.equal(off.calls().length, 2, "A11Y_GH_READ_CACHE=off skips it");
  assert.ok(!existsSync(join(off.rc, "e")), "and stores nothing");
});

const writeGeneration = (rc: string, slug: string, counter: number, verifiedSecondsAgo: number) => {
  mkdirSync(join(rc, "gen"), { recursive: true });
  writeFileSync(join(rc, "gen", slug), `${counter} ${Math.floor(Date.now() / 1000) - verifiedSecondsAgo}\n`);
};

test("#4148: the TICK's snapshot: an old entry is served to a tick process while the generation holds, and never to a session", () => {
  const stored = (h: ReturnType<typeof host>) => {
    writeGeneration(h.rc, "a11ign_agent-org", 1, 5);
    h.call({ A11Y_TICK_SNAPSHOT: "1", GH_REPO: "a11ign/agent-org" }, "pr", "list", "--json", "number");
    h.age(120); // far past the 20 s of the plain cache
  };
  const session = host();
  stored(session);
  assert.equal(session.call({ GH_REPO: "a11ign/agent-org" }, "pr", "list", "--json", "number").stdout, `${HIT}2\n`, "a SESSION (no A11Y_TICK_SNAPSHOT) is read afresh");
  const tick = host();
  stored(tick);
  assert.equal(tick.call({ A11Y_TICK_SNAPSHOT: "1", GH_REPO: "a11ign/agent-org" }, "pr", "list", "--json", "number").stdout, `${HIT}1\n`, "the tick's own process is served the 120 s old entry");
  assert.equal(tick.calls().length, 1);
});

test("#4148: the generation decides: unchanged is served, moved is read again, and a stale verification is not believed", () => {
  const h = host();
  const tick = { A11Y_TICK_SNAPSHOT: "1", GH_REPO: "a11ign/agent-org" };
  writeGeneration(h.rc, "a11ign_agent-org", 1, 5);
  h.call(tick, "pr", "list"); // call 1, stored under generation 1
  h.age(200);
  writeGeneration(h.rc, "a11ign_agent-org", 1, 5);
  assert.equal(h.call(tick, "pr", "list").stdout, `${HIT}1\n`, "generation 1 still, verified 5 s ago: the entry from 200 s ago is served");
  assert.equal(h.calls().length, 1);
  h.age(200);
  writeGeneration(h.rc, "a11ign_agent-org", 2, 5);
  assert.equal(h.call(tick, "pr", "list").stdout, `${HIT}2\n`, "the repository CHANGED (generation 2): read again");
  h.age(200);
  writeGeneration(h.rc, "a11ign_agent-org", 2, 400);
  assert.equal(h.call(tick, "pr", "list").stdout, `${HIT}3\n`, "generation 2 but last verified 400 s ago: a tick that stopped refreshing is not believed");
  const other = host();
  other.call({ ...tick, GH_REPO: "a11ign/lab" }, "pr", "list");
  other.age(200);
  assert.equal(other.call({ ...tick, GH_REPO: "a11ign/lab" }, "pr", "list").stdout, `${HIT}2\n`, "no generation file for the repository: no snapshot, only the 20 s");
});

// #4148 part 6: a11ign#4616 measured 561 store-dropping calls in 41.9 minutes, a median of 1 s apart, so the cache the tick's snapshot vouches for was empty when the next reader arrived.
// Two causes are pinned here: calls CLASSED as writes that write nothing, and a write that dropped every repository's entries. The first test is the classification, the second the scope.

const readOf = (h: ReturnType<typeof host>, repo: string) => h.call({}, "issue", "view", "7", "-R", repo);
const countOf = (h: ReturnType<typeof host>, repo: string) => h.calls().filter((c) => c === `issue view 7 -R ${repo}`).length;

test("#4148 part 6: a call that writes nothing to GitHub does not drop the cache: git-credential, and `api` with a named GET method", () => {
  const notWrites: Array<{ name: string; args: string[] }> = [
    { name: "auth git-credential get (the helper behind every git fetch and push)", args: ["auth", "git-credential", "get"] },
    { name: "api --method GET -f k=v", args: ["api", "--method", "GET", "-f", "k=v", "repos/o/x/issues"] },
    { name: "api -X GET", args: ["api", "-X", "GET", "repos/o/x/issues"] },
    { name: "api -XGET and a lower-case method", args: ["api", "-XGET", "--method=get", "repos/o/x/issues"] },
    { name: "api --method GET -F k=v", args: ["api", "repos/o/x/issues", "--method", "GET", "-F", "per_page=5"] },
  ];
  for (const { name, args } of notWrites) {
    const h = host();
    readOf(h, "o/x");
    h.call({}, ...args);
    assert.equal(readOf(h, "o/x").stdout, `${HIT}1\n`, `${name}: the second identical read is a cache hit`);
    assert.equal(countOf(h, "o/x"), 1, `${name}: the read reached the stub once`);
  }
  // THE CONTROL, pointed the other way: a method that is not GET, or a body flag with no method (gh sends a POST), is still a write.
  const stillWrites = [["api", "-X", "PATCH", "repos/o/x/issues/1"], ["api", "--method", "POST", "-f", "k=v", "repos/o/x/issues"], ["api", "repos/o/x/issues", "-f", "k=v"],
    ["api", "-X", "GET", "--input", "-", "repos/o/x/issues"], ["auth", "login"]];
  for (const args of stillWrites) {
    const h = host();
    readOf(h, "o/x");
    h.call({}, ...args);
    readOf(h, "o/x");
    assert.equal(countOf(h, "o/x"), 2, `${args.join(" ")}: a write, and the read after it went to GitHub`);
  }
});

test("#4148 part 6: a write to repository X drops X's reads and leaves Y's; a write that names no repository drops both", () => {
  const writes: Array<{ name: string; env: Record<string, string>; args: string[] }> = [
    { name: "issue edit -R o/x", env: {}, args: ["issue", "edit", "7", "-R", "o/x", "--add-label", "l"] },
    { name: "issue edit with GH_REPO=o/x", env: { GH_REPO: "o/x" }, args: ["issue", "edit", "7", "--add-label", "l"] },
    { name: "api -X PATCH repos/o/x/...", env: {}, args: ["api", "-X", "PATCH", "repos/o/x/issues/1", "-f", "state=closed"] },
    { name: "api -X PATCH /repos/O/X/... (a leading slash, and GitHub's names are case-insensitive)", env: {}, args: ["api", "-X", "PATCH", "/repos/O/X/issues/1"] },
    { name: "a graphql mutation with GH_REPO=o/x", env: { GH_REPO: "o/x" }, args: ["api", "graphql", "-f", "query=mutation { addLabelsToLabelable }"] },
  ];
  for (const { name, env, args } of writes) {
    const h = host();
    readOf(h, "o/x");
    readOf(h, "o/y");
    h.call(env, ...args);
    assert.equal(readOf(h, "o/y").stdout.startsWith(HIT), true);
    assert.equal(countOf(h, "o/y"), 1, `${name}: repository Y's cached read is still a hit`);
    readOf(h, "o/x");
    assert.equal(countOf(h, "o/x"), 2, `${name}: repository X's read was dropped and went to GitHub`);
  }
  // A read that named no repository could be X's (gh takes it from the directory's remote), so a write to X drops it too.
  const unknown = host();
  unknown.call({}, "issue", "view", "7");
  unknown.call({}, "issue", "edit", "7", "-R", "o/x", "--add-label", "l");
  unknown.call({}, "issue", "view", "7");
  assert.equal(unknown.calls().filter((c) => c === "issue view 7").length, 2, "a read naming no repository is dropped by a write to a named one");
  // THE CONTROL (the fail-safe): a write that names no repository may have changed any of them.
  for (const args of [["issue", "edit", "7", "--add-label", "l"], ["api", "-X", "PATCH", "user"], ["api", "graphql", "-f", "query=mutation { x }"], ["some-unknown-verb"]]) {
    const h = host();
    readOf(h, "o/x");
    readOf(h, "o/y");
    h.call({}, ...args);
    readOf(h, "o/x");
    readOf(h, "o/y");
    assert.equal(countOf(h, "o/x") + countOf(h, "o/y"), 4, `${args.join(" ")}: names no repository, so both X and Y were read again`);
  }
});
