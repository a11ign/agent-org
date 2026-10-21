// no-token: gh -- the wrapper is RUN against a stub `gh-real` the test writes (`A11Y_GH_REAL`) and the gate's readers are handed a stub `run` and `batch`; no real `gh` starts and nothing reaches the network or any account's config.
/**
 * a11ign/a11ign#4899: THE GATE ASKS GITHUB FOR NO ROW TWICE, AND A READ GITHUB SAYS IS UNCHANGED COSTS NO POINT.
 *
 * The call ledger of the hour to 2026-10-10 20:40Z held 8,374 calls, 3,204 of them GraphQL, and the gate's tick asks the same open rows three ways: every open row
 * (`readOpenRows`, 500), and beside it the `backlog`, `needs:chairman` (and, for another repository's tracker, `ready`) rows, each a GraphQL read of rows the first
 * already carries. #5050 made those three label reads CONNECTION reads (`repository.issues(labels:)` over `gh api graphql`, no search); the fold is the same and its fakes
 * answer that shape. Two halves, each pinned where it lives:
 *
 *   (1) THE WAVE (`readWithFirstWaveTogether`, `foldIntoOpenRows`): a label's list is made from the open list when the open list is COMPLETE and names every field
 *       the label's read asked for. The control is shown first: the folded readers' answers equal the answers a server-side by-label read gives, row for row,
 *       and the number of calls a wave sends is counted, not remembered. A full open list (it may have been cut) is NOT folded, and a row beyond the cut is still found.
 *   (2) THE WRAPPER (`plugins/github/wrapper/gh`, `etag_eligible`/`etag_settle`): a plain `gh api <path>` GET past its 20 s entry is asked with `If-None-Match`; a 304 is replayed
 *       from the stored body with exit 0, nothing on stderr and a `etag` line in the ledger (which spends no point). A second identical read INSIDE the 20 s is
 *       a `cache` hit and makes no request at all. A call the wrapper cannot strip a header block off byte for byte is left exactly as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";
import { testEach } from "./lib/test-each.ts";
import { OPEN_ROWS_LIMIT, readWithFirstWaveTogether } from "./work-gate/reads/read-memo-and-exit.ts";
import { readChairmanBlocked } from "./work-gate/causes/rows-chairman.ts";
import { readOpenRows, readPromotableRows, readReadyRows } from "./work-gate/reads.ts";
import { readTrackerLanes } from "./work-gate/tick.ts";
import { READY_LABEL } from "./claim-labels.ts";
import { BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.ts";
import { connectionOfSelected, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";
import { readRowsByLabel } from "./ticket-port/rows-by-label.ts";

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// (1) THE WAVE
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const row = (number: number, labels: string[]) => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: "## Region\n\n```\nsrc/x.ts\n```\n", blockedBy: [], milestone: null,
  updatedAt: "2026-10-10T12:00:00Z", subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 },
  createdAt: `2026-10-09T12:${String(60 - Math.min(number, 59)).padStart(2, "0")}:00Z`,
});

/** Open rows, newest first, as `gh issue list` orders them. */
const FIXTURE = [row(9, [READY_LABEL]), row(8, [BACKLOG_LABEL]), row(7, [NEEDS_CHAIRMAN_LABEL]), row(6, []), row(5, [BACKLOG_LABEL, "lane:any"]), row(4, [READY_LABEL, BACKLOG_LABEL]), row(3, [])];

/**
 * The server's two answers: `gh issue list --state open --limit N --json F` (the whole list; the page size and the fields are GitHub's) and, since #5050, the by-label
 * CONNECTION read (`repository.issues(labels:)`, which is no search) cut to the fields it selected. `gh issue list --label` is not answered: the gate no longer sends one.
 */
function serverSide(open: ReturnType<typeof row>[]) {
  return (args: string[]): string => {
    const byLabel = readsRowsByLabel(args);
    if (byLabel !== null) {
      assert.equal(byLabel.state, "OPEN", `an unexpected by-label read: gh ${args.join(" ")}`);
      return connectionOfSelected(open.filter((r) => r.labels.some((l) => l.name === byLabel.label)) as never, args);
    }
    if (args[0] === "api") return args.some((a) => a.endsWith("/events")) ? "2026-10-10T11:00:00Z\n" : "";
    assert.deepEqual(args.slice(0, 2), ["issue", "list"], `an unexpected call: gh ${args.join(" ")}`);
    assert.ok(!args.includes("--label") && !args.includes("--search"), `a SEARCH-backed list is no longer asked (#5050): gh ${args.join(" ")}`);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    const fields = at("--json").split(",");
    const rows = open.slice(0, Number(at("--limit")));
    return JSON.stringify(rows.map((r) => Object.fromEntries(fields.map((f) => [f, (r as any)[f]]))));
  };
}

/** A `batch` that answers as the server does and keeps what it was asked. */
function countingBatch(server: (args: string[]) => string) {
  const asked: string[][] = [];
  const batch = (calls: { args: string[]; repo: string | undefined }[]) => {
    for (const call of calls) asked.push(call.args);
    return calls.map((call) => ({ stdout: server(call.args) }));
  };
  return { asked, batch };
}

/** The reference: each reader asked of the server, one by one, as the gate did before the fold. */
const reference = (server: (args: string[]) => string) => ({
  promotableRows: readPromotableRows(server), chairmanBlocked: readChairmanBlocked(server), openRowsRead: readOpenRows(server),
});

test("(1a) THE CONTROL: the folded lanes are the server-side lanes, row for row, and the wave sends ONE call where it sent three", () => {
  const server = serverSide(FIXTURE);
  const unfolded = reference(server);
  assert.ok((unfolded.promotableRows ?? []).length > 0, "POSITIVE CONTROL: the fixture has backlog rows, so an empty lane would not pass for equal");
  assert.ok((unfolded.chairmanBlocked ?? []).length > 0, "POSITIVE CONTROL: and a chairman row");
  const { asked, batch } = countingBatch(server);
  const folded = readTrackerLanes(server, batch);
  assert.deepEqual(folded, unfolded, "the same rows, in the same order, with the same fields");
  assert.equal(asked.length, 1, `one call for three lanes: ${asked.map((a) => a.slice(0, 5).join(" ")).join(" | ")}`);
  assert.deepEqual(asked[0].slice(0, 4), ["issue", "list", "--state", "open"]);
  assert.ok(!asked[0].includes("--label"), "the one call is the whole open list");
  assert.deepEqual(asked.filter((a) => readsRowsByLabel(a) !== null), [], "and no by-label connection read was sent beside it: all three are made from it (#5050)");
});

test("(1b) a FULL open list may have been cut, so nothing is made from it: the label reads are asked as they were (together, in a second batch), and a row beyond the cut is found", () => {
  const filler = Array.from({ length: OPEN_ROWS_LIMIT + 20 }, (_, at) => row(1000 + at, []));
  const beyond = row(2000, [BACKLOG_LABEL]);
  const open = [...FIXTURE, ...filler, beyond];
  const server = serverSide(open);
  assert.ok(JSON.parse(server(["issue", "list", "--state", "open", "--limit", String(OPEN_ROWS_LIMIT), "--json", "number,labels"])).length === OPEN_ROWS_LIMIT, "POSITIVE CONTROL: the open list does come back full");
  const unfolded = reference(server);
  const direct: string[][] = [];
  const answeringAlone = (args: string[]) => { direct.push(args); return server(args); };
  // the wave is `readWithFirstWaveTogether`'s own: what the batch did not answer goes to `run`, one call each
  const { asked, batch } = countingBatch(server);
  const folded = readWithFirstWaveTogether((read) => ({ promotableRows: readPromotableRows(read), chairmanBlocked: readChairmanBlocked(read), openRowsRead: readOpenRows(read) }), answeringAlone, batch);
  assert.deepEqual(folded, unfolded);
  assert.ok((folded.promotableRows ?? []).some((r: any) => r.number === 2000), "the backlog row beyond the 500 is in the lane");
  assert.equal(readsRowsByLabel(asked[0]), null, "the batch sent the whole list first");
  assert.deepEqual(asked.slice(1).map((a) => readsRowsByLabel(a)?.label).sort(), [BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL].sort(), "and then the two by-label reads, together, as they were asked before the fold");
  assert.equal(direct.filter((a) => a[0] === "issue" || readsRowsByLabel(a) !== null).length, 0, "none of them one by one");
});

test("(1c) a read that asks for a field the open list does not carry is not folded", () => {
  const server = serverSide(FIXTURE.map((r) => ({ ...r, assignees: [] })) as any);
  const { asked, batch } = countingBatch(server);
  // as the gate's own readers: the rehearsal answers `[]`, which is no connection, and a reader turns that into `null` and not into a crash
  const byLabel = (select: string, read: (args: string[]) => string) => {
    try { return readRowsByLabel({ label: BACKLOG_LABEL, state: "OPEN", select, run: read }); } catch { return null; }
  };
  const wave = (read: (args: string[]) => string) => ({
    open: read(["issue", "list", "--state", "open", "--limit", String(OPEN_ROWS_LIMIT), "--json", "number,labels"]),
    narrower: byLabel("number assignees", read),
    same: byLabel("number", read),
  });
  const answered = readWithFirstWaveTogether(wave, server, batch);
  assert.equal(asked.length, 2, `the open list and the read with the extra field; the read of \`number\` alone is made from the list: ${asked.map((a) => a.join(" ")).join(" | ")}`);
  assert.deepEqual(asked.map((a) => readsRowsByLabel(a) !== null), [false, true], "the one by-label read sent is the one the list could not answer");
  assert.ok((answered.narrower ?? []).length > 0 && answered.narrower!.every((r: any) => Array.isArray(r.assignees)), "POSITIVE CONTROL: the sent read has the field the list lacks");
  assert.deepEqual(answered.same, [{ number: 8 }, { number: 5 }, { number: 4 }], "and the folded one is the list's backlog rows, newest first");
});

test("(1d) each repository's tracker is folded into its OWN open list: two trackers, two calls where it was eight", () => {
  const serverA = serverSide(FIXTURE);
  const serverB = serverSide([row(31, [READY_LABEL]), row(30, [BACKLOG_LABEL])]);
  const bySide = (repo: string | undefined) => (repo === "o/b" ? serverB : serverA);
  const asked: { args: string[]; repo: string | undefined }[] = [];
  const batch = (calls: { args: string[]; repo: string | undefined }[]) => {
    asked.push(...calls);
    return calls.map((call) => ({ stdout: bySide(call.repo)(call.args) }));
  };
  const lanes = (read: (args: string[], repo?: string) => string) => ["o/a", "o/b"].map((repo) => {
    const aim = (args: string[]) => read(args, repo);
    return { readyRows: readReadyRows(aim), promotableRows: readPromotableRows(aim), chairmanBlocked: readChairmanBlocked(aim), openRows: readOpenRows(aim) };
  });
  const run = (args: string[], repo?: string) => bySide(repo)(args);
  const folded = readWithFirstWaveTogether(lanes, run, batch);
  const unfolded = lanes(run);
  assert.deepEqual(folded, unfolded);
  assert.deepEqual(asked.map((c) => c.repo).sort(), ["o/a", "o/b"], "one call per repository");
  assert.ok(asked.every((c) => readsRowsByLabel(c.args) === null && c.args[0] === "issue"), "and each is the whole open list, with no by-label read beside it (#5050)");
  assert.ok(unfolded[1].readyRows!.length === 1 && unfolded[1].promotableRows!.length === 1, "POSITIVE CONTROL: the second repository's lanes are not empty, so a lane made from the FIRST repository's list would differ");
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// (2) THE WRAPPER
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const WORKERS = "a11ign-ai-workers";
const NOW = "2026-10-10T20:00:00Z";

const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../plugins/github/wrapper/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-etag-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

/**
 * A stub `gh-real` that behaves as `gh api` does with and without `-i`: with it, a header block, a blank line and the body; a request holding the current
 * ETag answers 304 with `gh: HTTP 304` on stderr and exit 1. Without `-i` it prints the body alone. Its version is a file, so a test changes the resource.
 */
const host = () => {
  const root = tmpDir("gh-etag-4899-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${WORKERS}\n    oauth_token: not-a-token\n`);
  const log = join(root, "calls.log");
  const version = join(root, "version");
  writeFileSync(version, "1");
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    `echo "$*" >> "${log}"`,
    `ver=$(cat "${version}")`,
    "inm=; prev=",
    'for a; do [ "$prev" = -H ] && case "$a" in "If-None-Match: "*) inm=${a#"If-None-Match: "} ;; esac; prev=$a; done',
    'case " $* " in *" -i "*) ;; *) printf "plain-body-v%s\\n" "$ver"; exit 0 ;; esac',
    'if [ -n "$STUB_FORCE_304" ] || [ "$inm" = "\\"v$ver\\"" ]; then',
    '  printf "HTTP/2.0 304 Not Modified\\r\\nEtag: W/\\"v%s\\"\\r\\n\\r\\n" "$ver"; echo "gh: HTTP 304" >&2; exit 1',
    "fi",
    'if [ -n "$STUB_404" ]; then printf "HTTP/2.0 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{\\"message\\":\\"Not Found\\"}\\n"; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
    'printf "HTTP/2.0 200 OK\\r\\nEtag: W/\\"v%s\\"\\r\\nContent-Type: application/json\\r\\n\\r\\nbody-v%s\\n" "$ver" "$ver"', ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const rc = join(cfg, "read-cache");
  const call = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", input: "", cwd: root,
      env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, A11Y_GH_LEDGER_NOW: NOW, ...extra } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const resources = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[2]) : []);
  /** Age every 20 s entry past its time, so the next read is not a hit and has to ask. */
  const age = () => {
    for (const name of existsSync(join(rc, "e")) ? readdirSync(join(rc, "e")) : []) {
      const path = join(rc, "e", name);
      const [first, ...rest] = readFileSync(path, "utf8").split("\n");
      writeFileSync(path, [`${Math.floor(Date.now() / 1000) - 600} ${first.split(" ")[1] ?? ""}`, ...rest].join("\n"));
    }
  };
  const setVersion = (v: number) => writeFileSync(version, String(v));
  return { root, rc, call, calls, resources, age, setVersion };
};

const PATH = "repos/o/r/issues";

test("(2a) a second identical read inside 20 s is a `cache` hit and makes no request; past it, the request carries the ETag and a 304 is replayed as the first answer", () => {
  const h = host();
  const first = h.call({}, "api", PATH);
  assert.equal(first.stdout, "body-v1\n", "the body alone: the header block is cut off");
  assert.equal(first.status, 0);
  assert.match(h.calls()[0], /^api -i repos\/o\/r\/issues$/, "the first read asks for headers, with no condition (nothing is held)");

  const inside = h.call({}, "api", PATH);
  assert.equal(inside.stdout, "body-v1\n");
  assert.equal(h.calls().length, 1, "INSIDE the entry's 20 s: no second request");

  h.age();
  const past = h.call({}, "api", PATH);
  assert.equal(past.stdout, "body-v1\n", "the first answer's bytes");
  assert.equal(past.status, 0, "gh exits 1 on a 304; the caller got an answer and is told so");
  assert.equal(past.stderr, "", "and `gh: HTTP 304` is not leaked");
  assert.equal(h.calls().length, 2, "a request was made...");
  assert.match(h.calls()[1], /-H If-None-Match: "v1"/, "...carrying the tag, WITHOUT its `W/` prefix (a prefixed tag came back 200 and cost a point)");
  assert.deepEqual(h.resources(), ["core", "cache", "etag"], "...and the ledger says which: a 304 is `etag`, which spends no point");
});

test("(2b) the resource changing is a 200: the new body replaces the held one and the next read validates against the NEW tag", () => {
  const h = host();
  h.call({}, "api", PATH);
  h.setVersion(2);
  h.age();
  const changed = h.call({}, "api", PATH);
  assert.equal(changed.stdout, "body-v2\n");
  assert.deepEqual(h.resources().slice(-1), ["core"], "a 200 is a read that spent a point, and is recorded as one");
  h.age();
  const again = h.call({}, "api", PATH);
  assert.match(h.calls().at(-1)!, /If-None-Match: "v2"/, "the tag held is the new one");
  assert.equal(again.stdout, "body-v2\n");
  assert.deepEqual(h.resources().slice(-1), ["etag"]);
});

test("(2c) `--jq`, `-q` and a named GET are plain reads and revalidate; the form is part of the entry's key", () => {
  const h = host();
  h.call({}, "api", PATH, "--jq", ".[0]");
  h.call({}, "api", "--method", "GET", PATH, "-q", ".[1]");
  h.age();
  h.call({}, "api", PATH, "--jq", ".[0]");
  h.call({}, "api", "--method", "GET", PATH, "-q", ".[1]");
  const conditional = h.calls().filter((c) => c.includes("If-None-Match"));
  assert.equal(conditional.length, 2, "each form held its own tag");
  assert.deepEqual(h.resources().slice(-2), ["etag", "etag"]);
});

test("(2d) a call whose printed bytes the wrapper could not cut a header block off is left exactly as it was: no `-i`, no condition, and a write is never conditional", () => {
  const h = host();
  const cases: string[][] = [
    ["api", PATH, "--paginate"],
    ["api", PATH, "-H", "Accept: application/vnd.github.diff"],
    ["api", PATH, "--template", "{{.}}"],
    ["api", PATH, "-f", "state=closed"],
    ["api", "--method", "PATCH", PATH],
    ["api", "graphql", "-f", "query={viewer{login}}"],
    ["api", PATH, "-i"],
    ["api", "rate_limit"],
  ];
  for (const args of cases) { h.age(); h.call({}, ...args); h.age(); h.call({}, ...args); }
  const withCondition = h.calls().filter((c) => c.includes("If-None-Match"));
  assert.deepEqual(withCondition, [], "none of these asks conditionally");
  assert.ok(h.calls().every((c) => c.split(" ").filter((a) => a === "-i").length <= 1 && !/^api -i .*(--paginate|--method PATCH|graphql)/.test(c)), `no \`-i\` was added to them: ${h.calls().join(" | ")}`);
  assert.ok(h.calls().length >= cases.length, "POSITIVE CONTROL: every one of them reached the stub");
});

test("(2e) a 304 with nothing held to replay is NOT an answer: gh's own status and message stand, and nothing is invented", () => {
  const h = host();
  h.call({}, "api", PATH);
  h.age();
  rmSync(join(h.rc, "c"), { recursive: true, force: true });
  const lost = h.call({ STUB_FORCE_304: "1" }, "api", PATH);
  assert.equal(lost.status, 1);
  assert.equal(lost.stdout, "");
  assert.match(lost.stderr, /HTTP 304/);
});

type MissingRead = ReturnType<ReturnType<typeof host>["call"]>;

const MISSING_READ_CHECKS: { name: string; check: (missing: MissingRead, h: ReturnType<typeof host>) => void }[] = [
  { name: "exits 1", check: (missing) => assert.equal(missing.status, 1) },
  { name: "prints the body gh printed", check: (missing) => assert.equal(missing.stdout, '{"message":"Not Found"}\n') },
  { name: "prints the message gh printed", check: (missing) => assert.match(missing.stderr, /Not Found \(HTTP 404\)/) },
  {
    name: "stores nothing",
    check: (_missing, h) => assert.ok(!existsSync(join(h.rc, "c")) || readdirSync(join(h.rc, "c")).length === 0, "an error is never stored as the answer to the next read"),
  },
];

testEach("(2f) an error is what gh printed: the header block is cut off, the body and the message and the exit status stay, and nothing is held", MISSING_READ_CHECKS, (c) => {
  const h = host();
  c.check(h.call({ STUB_404: "1" }, "api", PATH), h);
});

test("(2g) `A11Y_GH_READ_CACHE=off` turns it off with the rest: the call is the caller's, byte for byte", () => {
  const h = host();
  h.call({ A11Y_GH_READ_CACHE: "off" }, "api", PATH);
  h.call({ A11Y_GH_READ_CACHE: "off" }, "api", PATH);
  assert.deepEqual(h.calls(), [`api ${PATH}`, `api ${PATH}`]);
  assert.equal(h.call({ A11Y_GH_READ_CACHE: "off" }, "api", PATH).stdout, "plain-body-v1\n");
});
