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
  for (const write of [["pr", "merge", "1"], ["api", "-X", "PATCH", "repos/o/r/issues/1"], ["api", "repos/o/r/issues", "-f", "title=x"], ["auth", "git-credential", "get"], ["some-unknown-verb"]]) {
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
