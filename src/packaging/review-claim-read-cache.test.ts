// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and nothing reaches the network or any account's config.
//
// A11-172: THE REVIEW CLAIM'S READ-BACK WAS ANSWERED FROM THE WRAPPER'S READ CACHE. The claim is written by the `reviewer` App and read by the `scheduler` App, and the wrapper keeps one read-cache store per account
// (`$GH_CONFIG_DIR/read-cache`): a write drops only the writing account's store, so the scheduler's read straight after the reviewer's write listed the head as it was before the claim, and the claim was
// released on every sweep. This runs the REAL wrapper with the cache on, two accounts over one stub GitHub, and reads the claim with `claimEntriesOf` and writes it with `writeClaimStatus`.
// THE POSITIVE CONTROL is the same sequence with a plain GET of the same path, which does return the list from before the write: that proves the cache is on, and is what the header gets past.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";
import { claimDescriptionOf, claimEntriesOf, writeClaimStatus, type Gh } from "../ticket-port/review-claim.ts";

const NOW = Date.UTC(2026, 9, 22, 12);
const REPO = "a11ign/agent-org";
const SHA = "abc123";
const STATUSES_PATH = `repos/${REPO}/commits/${SHA}/statuses?per_page=100`;

const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../plugins/github/wrapper/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("review-claim-read-cache-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

/**
 * One stub GitHub and two accounts that reach it through the real wrapper, each with its own `GH_CONFIG_DIR` (so its own read-cache store). The stub keeps a head's statuses in a file: a
 * `POST` appends one, and a listing prints them as `gh --jq` would (`id`, `created_at`, `description`, tab-separated) with the call's number first, so a cached answer is the earlier call's.
 */
function github() {
  const root = tmpDir("review-claim-read-cache-");
  const statuses = join(root, "statuses.tsv");
  const log = join(root, "calls.log");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    `echo "$*" >> "${log}"`,
    'case "$*" in',
    `  *"--method POST"*) for a; do case "$a" in description=*) n=$(wc -l < "${statuses}" 2>/dev/null | tr -d ' '); printf '%s\\t2026-10-22T12:00:00Z\\t%s\\n' "$((\${n:-0} + 1))" "\${a#description=}" >> "${statuses}" ;; esac; done ;;`,
    `  *) cat "${statuses}" 2>/dev/null ;;`,
    "esac", ""].join("\n"), { mode: 0o755 });
  writeFileSync(statuses, "");
  const account = (name: string): Gh => {
    const cfg = join(root, name);
    mkdirSync(cfg);
    writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${name}\n    oauth_token: not-a-token\n`);
    return (args) => execFileSync("sh", [WRAPPER, ...args], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, A11Y_GH_LEDGER_NOW: "2026-10-22T12:00:00Z" } });
  };
  const listings = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.includes("statuses?per_page")).length : 0);
  return { scheduler: account("scheduler"), reviewer: account("reviewer"), listings };
}

test("A11-172: a claim read straight after a write by another identity sees the write, with the wrapper's read cache on", () => {
  const { scheduler, reviewer, listings } = github();
  assert.deepEqual(claimEntriesOf({ repo: REPO, sha: SHA, gh: scheduler }), [], "the first read, as the scheduler: the head has no claim");
  writeClaimStatus({ repo: REPO, sha: SHA, description: claimDescriptionOf({ instance: "work", now: NOW }), gh: reviewer });
  const after = claimEntriesOf({ repo: REPO, sha: SHA, gh: scheduler });
  assert.deepEqual(after.map((entry) => entry.description), [claimDescriptionOf({ instance: "work", now: NOW })], "the read-back, as the scheduler, straight after the reviewer's write, lists the claim");
  assert.equal(listings(), 2, "both reads reached GitHub: neither was served from the store");
  assert.equal(claimEntriesOf({ repo: REPO, sha: SHA, gh: scheduler }).length, 1, "and an identical read inside the cache's seconds is read again too");
  assert.equal(listings(), 3);
});

test("A11-172: POSITIVE CONTROL: a plain GET of the same path, as the claim used to read it, returns the list from before the write", () => {
  const { scheduler, reviewer, listings } = github();
  const plain = () => scheduler(["api", "--paginate", STATUSES_PATH]);
  assert.equal(plain(), "", "the first read: nothing is claimed");
  writeClaimStatus({ repo: REPO, sha: SHA, description: claimDescriptionOf({ instance: "work", now: NOW }), gh: reviewer });
  assert.equal(plain(), "", "the cache is on: the scheduler's second read is the first one's answer, though the head now holds a claim");
  assert.equal(listings(), 1, "and it never reached GitHub");
});
