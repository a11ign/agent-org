// no-token: gh -- the reader reads files the gate wrote; the one CLI test puts a `gh` on PATH that records any call, and no account or network is touched.
//
// (agent-org#1517) THE GATE'S SNAPSHOT READER, claim (f): it prints the age of what it read and makes no `gh` call. Also: a store that cannot be read
// is said with its reason and exits 1, never answered as an empty list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { KEPT_READS_STORE, ageText, main, readBoard, readOpenPrs, readOpenRows, renderRead, renderRowsJson } from "./gate-snapshot-read.ts";
import { GATE_VALIDATORS_DIR } from "./gh-conditional.ts";

const READER = fileURLToPath(new URL("./gate-snapshot-read.ts", import.meta.url));
const REPO = "a11ign/agent-org";
const NOW = Date.parse("2026-10-15T20:10:00Z");

/** A state directory the gate wrote: the open list (read whole 4 min 12 s before NOW) and the kept open rows (read 30 s before NOW). */
const gateState = () => {
  const state = tmpDir("gate-snapshot-read-state-");
  writeFileSync(join(state, "open-prs-memory.json"), JSON.stringify({ version: 1, repos: { [REPO]: { readAtMs: NOW - 252_000, prs: [{ number: 1520, title: "Manager reads", headRefOid: "abc" }, { number: 1514, title: "Guard the item-list" }] } } }));
  mkdirSync(join(state, GATE_VALIDATORS_DIR));
  writeFileSync(join(state, GATE_VALIDATORS_DIR, "kept-reads.json"), JSON.stringify({ [REPO]: { rows: { signature: "s", readAt: NOW - 30_000, rows: [{ number: 1517, title: "A manager re-reads" }] } } }));
  return state;
};

test("(f) the header says the age of the read, from the stored instant, and the items follow it", () => {
  const state = gateState();
  const prs = readOpenPrs({ path: join(state, "open-prs-memory.json"), repo: REPO, nowMs: NOW });
  assert.equal(prs.ok, true);
  assert.deepEqual(renderRead("prs", prs, NOW).slice(1), ["#1520 Manager reads", "#1514 Guard the item-list"]);
  assert.match(renderRead("prs", prs, NOW)[0], /read 2026-10-15T20:05:48Z, 4 min 12 s ago, 2 item\(s\)$/);

  const rows = readOpenRows({ path: join(state, GATE_VALIDATORS_DIR, "kept-reads.json"), repo: REPO });
  assert.match(renderRead("rows", rows, NOW)[0], /, 30 s ago, 1 item\(s\)$/);
  assert.equal(ageText(59_999), "59 s");
  assert.equal(ageText(-5_000), "0 s", "a read after this instant is said to be 0 s old, never a negative age");
});

test("(f) a missing, unreadable or unnamed store is said with its reason and is never an empty list", () => {
  const state = gateState();
  assert.deepEqual(readOpenPrs({ path: join(state, "none.json"), repo: REPO, nowMs: NOW }), { ok: false, source: join(state, "none.json"), reason: "missing: no memory file" });
  assert.equal(readOpenPrs({ path: join(state, "open-prs-memory.json"), repo: "other/repo", nowMs: NOW }).ok, false, "a repository the gate never read has no list");
  writeFileSync(join(state, "bad.json"), "{not json");
  const bad = readOpenPrs({ path: join(state, "bad.json"), repo: REPO, nowMs: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.reason, /^unreadable: not JSON/);
  assert.equal(readOpenRows({ path: join(state, GATE_VALIDATORS_DIR, "kept-reads.json"), repo: "other/repo" }).ok, false);
  const lines = renderRead("prs", bad, NOW);
  assert.equal(lines.length, 1, "a refused read prints its reason and no items");
});

test("(f) the board is the newest snapshot by its file's time, named by path", () => {
  const root = tmpDir("gate-snapshot-read-board-");
  assert.equal(readBoard({ dir: join(root, "runs", "board-snapshots") }).ok, false);
  const dir = join(root, "runs", "board-snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.json"), "{}");
  writeFileSync(join(dir, "new.json"), "{}");
  utimesSync(join(dir, "old.json"), new Date(NOW - 600_000), new Date(NOW - 600_000));
  utimesSync(join(dir, "new.json"), new Date(NOW - 60_000), new Date(NOW - 60_000));
  const board = readBoard({ dir });
  assert.deepEqual(board.ok && board.items, [join(dir, "new.json")]);
  assert.equal(board.ok && board.readAtMs, NOW - 60_000);
});

test("(f) the command runs with no gh call: a gh on PATH that records a call is never reached", () => {
  const state = gateState();
  const bin = tmpDir("gate-snapshot-read-bin-");
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho called >> "${calls}"\nexit 9\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const run = (args: string[]) => spawnSync(process.execPath, [READER, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, cwd: state });

  const prs = run(["prs", "--repo", REPO, "--state", state]);
  assert.equal(prs.status, 0, prs.stderr);
  assert.match(prs.stdout, /ago, 2 item\(s\)/);
  assert.match(prs.stdout, /#1520 Manager reads/);
  assert.equal(run(["rows", "--repo", REPO, "--state", state]).status, 0);
  assert.equal(existsSync(calls), false, "the reader made no gh call");
});

test("(f) the command names what it cannot read, and refuses a missing repository or subcommand with usage", () => {
  const state = tmpDir("gate-snapshot-read-empty-");
  const missing = spawnSync(process.execPath, [READER, "prs", "--repo", REPO, "--state", state], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no snapshot \(missing: no memory file\)/);
  assert.equal(missing.stdout, "");
  assert.equal(main(["prs"], { env: {} }), 2, "a read needs a repository");
  assert.equal(main(["issues"]), 2);
});

/** The kept open rows as the gate writes them: `gh issue list` labels as `{ name }`, and a body only where the row had one. */
const rowsState = () => {
  const state = tmpDir("gate-snapshot-read-rows-");
  mkdirSync(join(state, GATE_VALIDATORS_DIR));
  writeFileSync(join(state, GATE_VALIDATORS_DIR, KEPT_READS_STORE), JSON.stringify({ [REPO]: { rows: { signature: "s", readAt: NOW - 30_000, rows: [
    { number: 5155, title: "Fleet hold", labels: [{ name: "fleet-gated" }, { name: "lane:orchestrator" }], body: "Fleet-hold-until: 2026-10-20" },
    { number: 1517, title: "No body key", labels: [{ name: "lane:any" }] },
    { number: 1539, title: "No label list", body: "Plain body" },
  ] } } }));
  return state;
};

test("(a)-(c) rows --json prints each stored row whole: its body and labels as stored, null where the store has none, and the age from the stored instant", () => {
  const state = rowsState();
  const read = readOpenRows({ path: join(state, GATE_VALIDATORS_DIR, KEPT_READS_STORE), repo: REPO });
  const out = JSON.parse(renderRowsJson(read.ok ? read : assert.fail("the rows must read"), NOW));
  assert.deepEqual(out, {
    source: join(state, GATE_VALIDATORS_DIR, KEPT_READS_STORE),
    readAt: "2026-10-15T20:09:30.000Z",
    ageMs: 30_000,
    rows: [
      { number: 5155, title: "Fleet hold", labels: ["fleet-gated", "lane:orchestrator"], body: "Fleet-hold-until: 2026-10-20" },
      { number: 1517, title: "No body key", labels: ["lane:any"], body: null },
      { number: 1539, title: "No label list", labels: null, body: "Plain body" },
    ],
  });
});

test("(e) rows without --json prints the lines it printed before: the header, then number and title only", () => {
  const state = rowsState();
  const read = readOpenRows({ path: join(state, GATE_VALIDATORS_DIR, KEPT_READS_STORE), repo: REPO });
  const lines = renderRead("rows", read, NOW);
  assert.match(lines[0], /, 30 s ago, 3 item\(s\)$/);
  assert.deepEqual(lines.slice(1), ["#5155 Fleet hold", "#1517 No body key", "#1539 No label list"]);
});

test("(a)-(d) the command: rows --json writes one JSON object to stdout and exits 0; a missing store says its reason on stderr, prints nothing on stdout, and exits 1", () => {
  const state = rowsState();
  const ok = spawnSync(process.execPath, [READER, "rows", "--repo", REPO, "--state", state, "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  const parsed = JSON.parse(ok.stdout);
  assert.deepEqual(Object.keys(parsed), ["source", "readAt", "ageMs", "rows"]);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[1].body, null);

  const empty = tmpDir("gate-snapshot-read-json-empty-");
  const missing = spawnSync(process.execPath, [READER, "rows", "--repo", REPO, "--state", empty, "--json"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /no snapshot \(missing: no kept reads\)/);
});

test("(f) prs and board take no --json: the flag is refused with the usage line and exit 2, never ignored", () => {
  const state = gateState();
  for (const args of [["prs", "--repo", REPO, "--state", state, "--json"], ["board", "--json"]]) {
    const refused = spawnSync(process.execPath, [READER, ...args], { encoding: "utf8" });
    assert.equal(refused.status, 2, args.join(" "));
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /^gate-snapshot-read \w+: --json is for rows only\nusage: agent-org gate-snapshot-read /);
  }
});
