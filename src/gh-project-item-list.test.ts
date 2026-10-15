// no-token: gh -- the wrapper is RUN here against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and nothing reaches the
// network or any account's config.
//
// (#1510) A WHOLE-BOARD LISTING CANNOT DRAIN THE POOL UNPRICED. Four claims, each with its positive control beside it:
//   a. `gh project item-list` with no `--limit` is refused by the wrapper: exit 1, the message names the helper that reads one row or the whole
//      board, the stub is never reached and no ledger line is written;
//   b. with `--limit 50` the call reaches the stub, and its ledger line is priced: resource `graphql` (not `graphql?`) with the pool's counter
//      after the call, so `settle` reads the points one call cost;
//   c. `--limit` over 50 (in every spelling), a `--limit` of 0 and a `--limit` with no value are refused the same way;
//   d. `project item-add` and `issue view` are untouched: they reach the stub with no `GH_DEBUG`, and their lines are what they were.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";
import { parseLedger, settle } from "./gh-ledger.ts";

const WRAPPER_TEXT = readFileSync(fileURLToPath(new URL("../host/gh", import.meta.url)), "utf8");
const WRAPPER = (() => {
  const rendered = join(tmpDirForFile("gh-project-item-list-render-"), "gh");
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const RESET = 1792096579;
const PIN = "2026-10-15T20:01:00Z";

/** The debug head `GH_DEBUG=api` prints for a listing: two requests (the project lookup, then the items), the last one's counter `used`. */
const debugHead = (used: number) => [
  "* Request at 2026-10-15 20:37:23.410730272 +0100 BST m=+0.077036412",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "> Authorization: token ████████████████████",
  "GraphQL query:",
  "query UserOrgOwner($login:String!){user(login: $login){login,id}}",
  "GraphQL variables: {\"login\":\"a11ign\"}",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: graphql",
  "< X-Ratelimit-Used: 3",
  `< X-Ratelimit-Reset: ${RESET}`,
  "",
  "{\"data\":{\"user\":{\"login\":\"a11ign\"}}}",
  "* Request took 276.596551ms",
  "* Request at 2026-10-15 20:37:23.687753566 +0100 BST m=+0.354059726",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: graphql",
  `< X-Ratelimit-Used: ${used}`,
  `< X-Ratelimit-Reset: ${RESET}`,
  "",
  "{\"data\":{\"node\":{\"items\":{\"nodes\":[]}}}}",
  "* Request took 1.540438101s",
  "",
].join("\n");

/**
 * A host with a stub `gh-real`. The stub logs each call (its arguments and the `GH_DEBUG` it was run with) to `calls`; under `GH_DEBUG=api` it prints
 * the debug head `debug` holds to stderr, and otherwise prints `reply` to stderr; it prints `ITEMS` on stdout and exits with `status`.
 */
const host = ({ used = 54, reply = "", status = 0 }: { used?: number; reply?: string; status?: number; } = {}) => {
  const root = tmpDir("gh-project-item-list-1510-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), "github.com:\n    user: a11ign-ai-workers\n    oauth_token: not-a-token\n");
  const calls = join(root, "calls");
  const debug = join(root, "debug");
  const replyFile = join(root, "reply");
  writeFileSync(debug, debugHead(used));
  writeFileSync(replyFile, reply);
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    `{ printf 'ARGS'; for a in "$@"; do printf '<%s>' "$a"; done; printf '\\nGH_DEBUG=%s\\n--\\n' "$GH_DEBUG"; } >> "${calls}"`,
    `if [ "$GH_DEBUG" = api ]; then cat "${debug}" >&2; fi`,
    `cat "${replyFile}" >&2`,
    "printf 'ITEMS\\n'",
    `exit ${status}`, ""].join("\n"), { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: join(cfg, "gh-calls.tsv"), A11Y_GH_LEDGER_NOW: PIN };
  const runWith = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: { ...env, ...extra }, input: "", cwd: root });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  };
  const run = (...args: string[]) => runWith({}, ...args);
  return {
    run,
    runWith,
    env,
    ledger: env.A11Y_GH_LEDGER,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    lines: () => (existsSync(env.A11Y_GH_LEDGER) ? readFileSync(env.A11Y_GH_LEDGER, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : []),
  };
};

const HELPERS = ["row-file --promote=<n>", "board-snapshot"];

test("(a) a listing with no --limit is refused: named helper, no call, no ledger line", () => {
  const h = host();
  const r = h.run("project", "item-list", "1", "--owner", "a11ign");
  assert.notEqual(r.status, 0);
  for (const helper of HELPERS) assert.match(r.stderr, new RegExp(helper.replace(/[<>+*?]/g, "\\$&")));
  assert.equal(h.calls(), "", "the stub must never be reached");
  assert.deepEqual(h.lines(), [], "a refused call writes no ledger line");
  assert.equal(r.stdout, "");
});

test("(b) --limit 50 reaches the stub with the debug head, and its line is priced off the pool's counter", () => {
  const h = host({ used: 54 });
  const r = h.run("project", "item-list", "1", "--owner", "a11ign", "--limit", "50", "--format", "json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ITEMS\n", "the stdout is the stub's, unchanged");
  assert.equal(r.stderr, "", "the debug head is taken out of the caller's stderr");
  assert.match(h.calls(), /ARGS<project><item-list><1><--owner><a11ign><--limit><50><--format><json>\nGH_DEBUG=api\n/);
  const lines = h.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0][2], "graphql", "priced as graphql, not graphql?");
  assert.equal(lines[0][10], "54", "the pool's counter after the call");
  assert.equal(lines[0][11], String(RESET));
});

test("(b) the ledger reads the points one --limit 50 call cost: the counter's movement since the reading before it", () => {
  const h = host({ used: 54 });
  // a reading of the same pool, 2 points, before the listing (an `api graphql` line, which the wrapper records with its counter)
  const before = ["2026-10-15T20:00:00Z", "a11ign-ai-workers", "graphql", "", "0", "api graphql", "w9", "-", "-", "-", "2", String(RESET)].join("\t");
  writeFileSync(h.ledger, `${before}\n`);
  const r = h.run("project", "item-list", "1", "--owner", "a11ign", "--limit", "50");
  assert.equal(r.status, 0, r.stderr);
  const entries = settle(parseLedger(readFileSync(h.ledger, "utf8")));
  const listing = entries.find((e) => e.command.startsWith("project item-list"));
  assert.ok(listing, "the listing has a line");
  assert.equal(listing.settled, "read");
  assert.equal(listing.cost, 52, "54 - 2");
});

test("(b) a caller who set GH_DEBUG=api still gets its line priced, and keeps its own debug head on stderr", () => {
  const h = host({ used: 54 });
  const r = h.runWith({ GH_DEBUG: "api" }, "project", "item-list", "1", "--owner", "a11ign", "--limit", "50");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, debugHead(54), "the caller's own debug head is not taken out of its stderr");
  assert.match(h.calls(), /\nGH_DEBUG=api\n--\n/);
  const lines = h.lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0][2], "graphql");
  assert.equal(lines[0][10], "54", "the pool's counter after the call, read off the caller's own head");
});

test("(c) a caller who set GH_DEBUG to anything but api is refused before the call: its head would hide the pool's counter", () => {
  const h = host();
  const r = h.runWith({ GH_DEBUG: "http" }, "project", "item-list", "1", "--owner", "a11ign", "--limit", "50");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing 'gh project item-list' with GH_DEBUG=http/);
  assert.equal(h.calls(), "", "the stub must never be reached");
  assert.deepEqual(h.lines(), [], "a refused call writes no ledger line");
});

test("(b) the caller's stderr is kept when the debug head is not in it: a plain error passes through", () => {
  const h = host({ reply: "gh: something else went wrong\n", status: 1 });
  const r = h.run("project", "item-list", "1", "--owner", "a11ign", "--limit", "50");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "gh: something else went wrong\n");
});

test("(c) --limit over 50 (every spelling), 0 and a missing value are refused before any call", () => {
  const refused: string[][] = [
    ["--limit", "51"], ["--limit=51"], ["-L", "51"], ["-L51"], ["--limit", "1000"], ["--limit", "0"], ["--limit", "-5"], ["--limit", "abc"],
    ["--limit", "50", "--limit", "51"], ["--limit"], ["-L"],
  ];
  for (const flags of refused) {
    const h = host();
    const r = h.run("project", "item-list", "1", "--owner", "a11ign", ...flags);
    assert.notEqual(r.status, 0, `refused: ${flags.join(" ")}`);
    assert.match(r.stderr, /refusing 'gh project item-list'/, flags.join(" "));
    assert.equal(h.calls(), "", `no call: ${flags.join(" ")}`);
    assert.deepEqual(h.lines(), [], `no line: ${flags.join(" ")}`);
  }
});

test("(c) a limit of 50 or less in every spelling is allowed", () => {
  const allowed: string[][] = [["--limit", "50"], ["--limit=50"], ["-L", "50"], ["-L50"], ["--limit", "1"], ["--limit=050"]];
  for (const flags of allowed) {
    const h = host();
    const r = h.run("project", "item-list", "1", "--owner", "a11ign", ...flags);
    assert.equal(r.status, 0, `allowed: ${flags.join(" ")}: ${r.stderr}`);
    assert.notEqual(h.calls(), "", `reached the stub: ${flags.join(" ")}`);
  }
});

test("(d) project item-add and issue view are untouched: they reach the stub without GH_DEBUG and keep their lines", () => {
  const h = host();
  const add = h.run("project", "item-add", "1", "--owner", "a11ign", "--url", "https://github.com/a11ign/agent-org/issues/1510");
  assert.equal(add.status, 0, add.stderr);
  const view = h.run("issue", "view", "1510", "--repo", "a11ign/agent-org");
  assert.equal(view.status, 0, view.stderr);
  assert.match(h.calls(), /ARGS<project><item-add>.*\nGH_DEBUG=\n--\n/);
  assert.match(h.calls(), /ARGS<issue><view><1510><--repo><a11ign\/agent-org>\nGH_DEBUG=\n--\n/);
  const lines = h.lines();
  assert.deepEqual(lines.map((l) => [l[2], l[10], l[11]]), [["graphql?", "-", "-"], ["graphql?", "-", "-"]]);
});
