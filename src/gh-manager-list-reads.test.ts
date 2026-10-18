// no-token: gh -- the wrapper is RUN here against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and nothing reaches the
// network or any account's config.
//
// (#1517) A MANAGER'S LIST IS READ FROM THE GATE'S SNAPSHOT, AND ITS ALLOWED FORM IS PRICED. Five claims, each with its positive control beside it:
//   a. `pr list --json` naming a heavy field (`statusCheckRollup`, `body`, ...) from a manager's workspace is refused by the wrapper: exit 1, the
//      message names `agent-org gate-snapshot-read`, the stub is never reached and no ledger line is written;
//   b. `pr list --json number,title --limit 30` from a manager reaches the stub, and its ledger line is priced off the pool's counter: resource
//      `graphql` (not `graphql?`, not 0) with the counter after the call, so `settle` reads the points one call cost,
//   c. `pr list` and `issue list` with no `--limit`, or with `--limit 51`, are refused the same way, and so is a heavy `issue list`;
//   d. the same heavy `pr list` from a worker's workspace and from the gate's own process (no workspace) reaches the stub: the guard is for managers,
//   e. the alarm: a session whose priced calls sum to over 500 points in ten minutes is named by `recordPoolAlarms`; a session at 500 or under, or
//      spread over more than ten minutes, is named by nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";
import { parseLedger, recordPoolAlarms, settle, sessionAlarms } from "./gh-ledger.ts";

const WRAPPER_TEXT = readFileSync(fileURLToPath(new URL("../host/gh", import.meta.url)), "utf8");
const WRAPPER = (() => {
  const rendered = join(tmpDirForFile("gh-manager-list-reads-render-"), "gh");
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const RESET = 1792096579;
const PIN = "2026-10-15T20:01:00Z";
const HEAVY = ["statusCheckRollup", "body", "comments", "reviews", "files", "commits", "timelineItems"];
const SNAPSHOT = "agent-org gate-snapshot-read";

/** The debug head `GH_DEBUG=api` prints for a list: two requests, the last one's counter `used`. */
const debugHead = (used: number) => [
  "* Request at 2026-10-15 20:37:23.410730272 +0100 BST m=+0.077036412",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: graphql",
  "< X-Ratelimit-Used: 3",
  `< X-Ratelimit-Reset: ${RESET}`,
  "",
  "{\"data\":{\"viewer\":{\"login\":\"a11ign\"}}}",
  "* Request took 276.596551ms",
  "* Request at 2026-10-15 20:37:23.687753566 +0100 BST m=+0.354059726",
  "* Request to https://api.github.com/graphql",
  "> POST /graphql HTTP/1.1",
  "< HTTP/2.0 200 OK",
  "< X-Ratelimit-Resource: graphql",
  `< X-Ratelimit-Used: ${used}`,
  `< X-Ratelimit-Reset: ${RESET}`,
  "",
  "{\"data\":{\"repository\":{\"pullRequests\":{\"nodes\":[]}}}}",
  "* Request took 1.540438101s",
  "",
].join("\n");

/**
 * A host with a stub `gh-real`, run as one of three callers: a `manager` (a leads workspace in the leads config directory, which `app_role` names
 * `managers`), a `worker` (a worker workspace in the workers' directory), or the `gate` (no workspace: the scheduler's process). The stub logs each
 * call and the `GH_DEBUG` it ran with; under `GH_DEBUG=api` it prints the debug head `used` names to stderr.
 */
const host = ({ who = "manager", used = 54 }: { who?: "manager" | "worker" | "gate"; used?: number; } = {}) => {
  const root = tmpDir("gh-manager-list-reads-1517-");
  const leads = join(root, "leads");
  const workers = join(root, "workers");
  const cfg = who === "manager" ? join(leads, "gh") : join(workers, "gh");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${who === "manager" ? "a11ign-ai-leads" : "a11ign-ai-workers"}\n    oauth_token: not-a-token\n`);
  const calls = join(root, "calls");
  const debug = join(root, "debug");
  writeFileSync(debug, debugHead(used));
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    `{ printf 'ARGS'; for a in "$@"; do printf '<%s>' "$a"; done; printf '\\nGH_DEBUG=%s\\n--\\n' "$GH_DEBUG"; } >> "${calls}"`,
    `if [ "$GH_DEBUG" = api ]; then cat "${debug}" >&2; fi`,
    "printf 'LIST\\n'",
    "exit 0", ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_LEADS_DIR: leads, A11Y_WORKERS_DIR: workers, GH_CONFIG_DIR: cfg,
    A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: ledger, A11Y_GH_LEDGER_NOW: PIN };
  if (who === "manager") env.HERDR_WORKSPACE_ID = "w6";
  if (who === "worker") env.HERDR_WORKSPACE_ID = "w9";
  const runWith = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: { ...env, ...extra }, input: "", cwd: root });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  };
  return {
    run: (...args: string[]) => runWith({}, ...args),
    runWith,
    ledger,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    lines: () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")) : []),
  };
};

const listArgs = (command: "pr" | "issue", ...flags: string[]) => [command, "list", "--repo", "a11ign/agent-org", ...flags];

test("(a) a manager's pr list naming a heavy --json field is refused: the snapshot reader is named, no call, no ledger line", () => {
  for (const field of HEAVY) {
    const h = host();
    const r = h.run(...listArgs("pr", "--json", `number,${field}`, "--limit", "30"));
    assert.notEqual(r.status, 0, `refused: ${field}`);
    assert.match(r.stderr, new RegExp(`${field}.*${SNAPSHOT} prs`), `the refusal names the field and the reader: ${field}`);
    assert.equal(h.calls(), "", `the stub must never be reached: ${field}`);
    assert.deepEqual(h.lines(), [], `a refused call writes no ledger line: ${field}`);
    assert.equal(r.stdout, "");
  }
  const h = host();
  const eq = h.run(...listArgs("pr", "--json=number,statusCheckRollup", "--limit", "30"));
  assert.notEqual(eq.status, 0, "the --json=<fields> spelling is read too");
  assert.equal(h.calls(), "");
});

test("(b) a manager's pr list --json number,title --limit 30 reaches the stub, and its line is priced off the pool's counter", () => {
  const h = host({ used: 103 });
  // a reading of the same pool 3 points before the list (an `api graphql` line, which the wrapper records with its counter)
  writeFileSync(h.ledger, `${["2026-10-15T20:00:00Z", "a11ign-ai-leads", "graphql", "", "0", "api graphql", "w6", "-", "-", "-", "100", String(RESET)].join("\t")}\n`);
  const r = h.run(...listArgs("pr", "--json", "number,title", "--limit", "30"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "LIST\n", "the stdout is the stub's, unchanged");
  assert.equal(r.stderr, "", "the debug head is taken out of the caller's stderr");
  assert.match(h.calls(), /ARGS<pr><list><--repo><a11ign\/agent-org><--json><number,title><--limit><30>\nGH_DEBUG=api\n/);
  const listing = h.lines().find((l) => l[5].startsWith("pr list"));
  assert.ok(listing, "the list has a line");
  assert.equal(listing[2], "graphql", "priced as graphql, not graphql?");
  assert.equal(listing[10], "103", "the pool's counter after the call");
  assert.equal(listing[11], String(RESET));
  const [priced] = settle(parseLedger(readFileSync(h.ledger, "utf8"))).filter((e) => e.command === "pr list");
  assert.equal(priced.cost, 3, "the counter moved 100 -> 103 across the call (a fixture: the live cost is measured on the PR, not here)");
  assert.equal(priced.settled, "read");
});

test("(b) a manager's allowed list keeps its own GH_DEBUG=api head on stderr, and is priced the same", () => {
  const h = host({ used: 7 });
  const r = h.runWith({ GH_DEBUG: "api" }, ...listArgs("pr", "--json", "number,title", "--limit", "30"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, debugHead(7), "the caller's own head is not taken out of its stderr");
  assert.equal(h.lines()[0][10], "7");
});

test("(c) a manager's pr list or issue list with no --limit, or with --limit 51, is refused before any call", () => {
  const refused: string[][] = [
    listArgs("pr", "--json", "number,title"),
    listArgs("pr", "--json", "number,title", "--limit", "51"),
    listArgs("issue", "--json", "number,title"),
    listArgs("issue", "--json", "number,title", "--limit", "51"),
    listArgs("issue", "--json", "number,title", "--limit=100"),
    listArgs("issue", "--json", "number,title", "-L", "0"),
  ];
  for (const args of refused) {
    const h = host();
    const r = h.run(...args);
    assert.notEqual(r.status, 0, `refused: ${args.join(" ")}`);
    assert.match(r.stderr, new RegExp(`refusing '${args[0]} list' for a manager.*${SNAPSHOT}`), args.join(" "));
    assert.equal(h.calls(), "", `no call: ${args.join(" ")}`);
    assert.deepEqual(h.lines(), [], `no line: ${args.join(" ")}`);
  }
  const h = host();
  const ok = h.run(...listArgs("issue", "--json", "number,title", "--limit", "50"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.notEqual(h.calls(), "", "a limit of 50 is allowed");
});

test("(c) a heavy issue list is refused for a manager, and a manager's GH_DEBUG other than api is refused before the call", () => {
  const heavy = host();
  const r = heavy.run(...listArgs("issue", "--json", "number,body", "--limit", "30"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`--json body.*${SNAPSHOT}`));
  assert.equal(heavy.calls(), "");

  const debugged = host();
  const d = debugged.runWith({ GH_DEBUG: "http" }, ...listArgs("pr", "--json", "number,title", "--limit", "30"));
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /refusing 'pr list' with GH_DEBUG=http/);
  assert.equal(debugged.calls(), "", "the stub must never be reached");
  assert.deepEqual(debugged.lines(), [], "a refused call writes no ledger line");
});

test("(d) the same heavy pr list from a worker's workspace and from the gate's own process reaches the stub, and keeps its unpriced line", () => {
  for (const who of ["worker", "gate"] as const) {
    const h = host({ who });
    const r = h.run(...listArgs("pr", "--json", "number,statusCheckRollup"));
    assert.equal(r.status, 0, `${who} is not refused: ${r.stderr}`);
    assert.equal(r.stdout, "LIST\n", `${who} reaches the stub`);
    assert.match(h.calls(), /ARGS<pr><list><--repo>.*<--json><number,statusCheckRollup>\nGH_DEBUG=\n/, `${who}: no GH_DEBUG is set for the call`);
    assert.deepEqual(h.lines().map((l) => [l[2], l[10]]), [["graphql?", "-"]], `${who}: the line is what it was (graphql?, no counter)`);
  }
});

test("(d) a manager's own issue list with a limit of 30 and the default fields is not priced into a second copy: the stub is reached once", () => {
  const h = host();
  assert.equal(h.run(...listArgs("issue", "--json", "number,title", "--limit", "30")).status, 0);
  assert.equal(h.calls().split("ARGS").length - 1, 1, "one call reached gh-real");
});

// ---- (e) the alarm: one session's points in ten minutes -----------------------------------------------------------------------------

const NOW = Date.parse("2026-10-15T20:10:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A priced line of one session: the cost the response carried, and the session's id in the session column (nine columns). */
const spent = (minutesAgo: number, points: number, session = "s-manager", caller = "node /x/src/work-gate.ts") =>
  [at(minutesAgo), "a11ign-ai-leads", "graphql", points, 0, "pr list", "w6", caller, session].join("\t");
/** A priced line by the counter alone: no cost, the pool's counter after the call (twelve columns). */
const counted = (minutesAgo: number, used: number, session = "s-manager") =>
  [at(minutesAgo), "a11ign-ai-leads", "graphql", "", 0, "pr list", "w6", "node /x/src/work-gate.ts", session, "-", String(used), String(RESET)].join("\t");

test("(e) a session that spends over 500 points in ten minutes is named by the alarm, with its callers, and written once an hour", () => {
  const entries = parseLedger([spent(9, 200), spent(5, 200), spent(1, 201)].join("\n"));
  const [alarm] = sessionAlarms(entries, { nowMs: NOW });
  assert.equal(alarm.session, "s-manager");
  assert.equal(alarm.used, 601, "every call in the window: 200 + 200 + 201");

  const dir = tmpDirForFile("gh-session-alarm-");
  const ledger = join(dir, "gh-calls.tsv");
  writeFileSync(ledger, `${[spent(9, 200), spent(5, 200), spent(1, 201)].join("\n")}\n`);
  const lines = recordPoolAlarms(ledger, NOW);
  assert.equal(lines.length, 1, "one line: the session, and no pool (601 points is far under the hour's 70%)");
  assert.match(lines[0], /\tincident\t/);
  assert.match(lines[0], /session s-manager spent 601 points in the ten minutes ending/);
  assert.equal(recordPoolAlarms(ledger, NOW + 5 * 60_000).length, 0, "not again within the hour, one per session");
});

test("(e) a session at 500 points or under in any ten minutes is named by nothing", () => {
  const exactly = parseLedger([spent(9, 250), spent(1, 250)].join("\n"));
  assert.deepEqual(sessionAlarms(exactly, { nowMs: NOW }), [], "500 is not over 500");
  const under = parseLedger([spent(9, 200), spent(1, 200)].join("\n"));
  assert.deepEqual(sessionAlarms(under, { nowMs: NOW }), []);
  const spread = parseLedger([spent(21, 300), spent(9, 300)].join("\n"));
  assert.deepEqual(sessionAlarms(spread, { nowMs: NOW }), [], "600 in twelve minutes is not in any ten");
  const unnamed = parseLedger([spent(9, 400, "-"), spent(1, 400, "-")].join("\n"));
  assert.deepEqual(sessionAlarms(unnamed, { nowMs: NOW }), [], "a line with no session is no session");
  const dir = tmpDirForFile("gh-session-alarm-under-");
  const ledger = join(dir, "gh-calls.tsv");
  writeFileSync(ledger, `${[spent(9, 250), spent(1, 250)].join("\n")}\n`);
  assert.deepEqual(recordPoolAlarms(ledger, NOW), [], "a ledger of 500 or fewer points in a window writes no alarm");
});

test("(e) a session priced by the counter alone is counted at its movement, and another session's points are its own", () => {
  // baseline 1000, then 1200 and 1600 from the same pool: the calls moved 200 and 400, the baseline is its floor of one
  const entries = parseLedger([counted(20, 1000), counted(9, 1200), counted(2, 1600), spent(2, 300, "s-other")].join("\n"));
  const alarms = sessionAlarms(entries, { nowMs: NOW });
  assert.deepEqual(alarms.map((a) => [a.session, a.used]), [["s-manager", 600]], "600 for the session that moved the counter; the other session's 300 is under 500 and names nothing");
});
