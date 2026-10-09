// no-token: gh -- the wrapper is RUN here against a stub `gh-real` the test writes (`A11Y_GH_REAL`), and `defaultGh` against a stub `gh` first on PATH;
// no real `gh` starts and nothing reaches the network or any account's config.
//
// #4397: `host/gh` REFUSES `gh pr create` unless `A11Y_PR_OPEN` is set, and `pr:open` sets it on its own `gh` child. A raw create skips the
// session label, the `Acceptance:`/`Closes` check and the Region check (agent-org#436 was opened that way). The positive control for every
// "never reached gh-real" assertion is the stub's own marker file: the same call WITH the variable must leave it, so a wrapper that
// refuses everything, or a stub that never runs, cannot pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PR_OPEN_ENV } from "./pr-open.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const STUB_EXIT = 7; // a status nothing else here returns, so it can only have come from the stub
const WRAPPER_TEXT = readFileSync(fileURLToPath(new URL("../host/gh", import.meta.url)), "utf8");
const WRAPPER = (() => {
  const rendered = join(tmpDirForFile("pr-open-only-creates-render-"), "gh");
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

/** A host whose `gh-real` leaves `reached` behind and exits `STUB_EXIT`. */
const host = () => {
  const root = mkdtempSync(join(tmpdir(), "pr-open-only-creates-4397-"));
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), "github.com:\n    user: a11ign-ai-workers\n    oauth_token: not-a-token\n");
  const reached = join(root, "reached");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh", `echo "$*" > "${reached}"`, `exit ${STUB_EXIT}`, ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const env = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", ...extra };
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env, input: "" });
    return { status: r.status, stderr: r.stderr, reached: existsSync(reached) ? readFileSync(reached, "utf8").trim() : null };
  };
  return { root, run, ledgerExists: () => existsSync(ledger) };
};

test("#4397: `gh pr create` without A11Y_PR_OPEN exits non-zero, names `pnpm run pr:open`, and never reaches gh-real or the ledger", () => {
  const h = host();
  try {
    const r = h.run({}, "pr", "create", "--title", "x");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pnpm run pr:open/);
    assert.equal(r.reached, null, "gh-real must not have run");
    assert.equal(h.ledgerExists(), false, "a refusal writes no ledger line");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#4397: POSITIVE CONTROL -- the same call WITH A11Y_PR_OPEN reaches gh-real and returns its status", () => {
  const h = host();
  try {
    const r = h.run({ [PR_OPEN_ENV]: "1" }, "pr", "create", "--title", "x");
    assert.equal(r.status, STUB_EXIT, "the stub's own status came back");
    assert.equal(r.reached, "pr create --title x");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#4397: an empty A11Y_PR_OPEN is absent, and the refusal holds for another repository (-R) too", () => {
  const h = host();
  try {
    const r = h.run({ [PR_OPEN_ENV]: "" }, "pr", "create", "-R", "a11ign/agent-org");
    assert.equal(r.status, 1);
    assert.equal(r.reached, null);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#4397: `pr list`, `pr view`, `pr edit` and `pr merge` are untouched without the variable", () => {
  for (const verb of ["list", "view", "edit", "merge"]) {
    const h = host();
    try {
      const r = h.run({}, "pr", verb, "12");
      assert.equal(r.status, STUB_EXIT, `pr ${verb} must reach gh-real`);
      assert.equal(r.reached, `pr ${verb} 12`);
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  }
});

test("#4397: `defaultGh` (pr:open's own child) carries A11Y_PR_OPEN=1, and its parent's environment does not", async () => {
  const { defaultGh } = await import("./pr-open.ts");
  const root = mkdtempSync(join(tmpdir(), "pr-open-only-creates-4397-bin-"));
  const seen = join(root, "seen");
  writeFileSync(join(root, "gh"), ["#!/bin/sh", `echo "\${${PR_OPEN_ENV}:-unset}" > "${seen}"`, ""].join("\n"), { mode: 0o755 });
  const { PATH, [PR_OPEN_ENV]: before } = process.env;
  try {
    delete process.env[PR_OPEN_ENV];
    process.env.PATH = `${root}:${PATH ?? ""}`;
    defaultGh(["pr", "create"]);
    assert.equal(readFileSync(seen, "utf8").trim(), "1");
    assert.equal(process.env[PR_OPEN_ENV], undefined, "the variable is on the child only, so the row's Acceptance command never inherits it");
  } finally {
    process.env.PATH = PATH;
    if (before !== undefined) process.env[PR_OPEN_ENV] = before;
    rmSync(root, { recursive: true, force: true });
  }
});
