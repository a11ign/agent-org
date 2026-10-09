// a11ign/a11ign#3515: the trace pages' publisher. Fixtures only: no `gh`, no `trace` child, no host directory; a temp directory is the output and a stub is the renderer.
// no-token: gh -- `readHead` and the renderer are injected; the `gh` seam (`ask`) is a fake GitHub that answers a 304 to the ETag it last gave, so what the publisher SENDS is what the tests read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync as rmSyncOf, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLOSED_ROWS_MAX_PAGES, conditionalReader, DEFAULT_MAX_AGE_MINUTES, indexPage, MAP_PAGE, pageStillHolds, parseArgs, parseReply, publish, readStamp, readValidators, recentClosedRows, ROW_PAGE_MAX_AGE_MS, runPublisher, saveValidators, Stamp, STAMP_FILE, VALIDATORS_FILE, WantedRow, whyRun } from "./publish.mjs";
import { tmpDir } from "../lib/tmp-fixture.ts";

const MINUTE = 60 * 1000;
const T0 = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 60 * MINUTE;
const repos = ["a11ign/a11ign", "a11ign/agent-org"];

const scratch = () => tmpDir("trace-publish-");
/** A renderer that writes a recognisable page and counts its calls, so "does nothing" is a count and not an inference. */
function renderer() {
  const calls: string[] = [];
  const render = ({ kind, row, out }) => {
    calls.push(kind === "map" ? "map" : `row ${row}`);
    writeFileSync(out, `<!doctype html><title>${kind === "map" ? "Across-rows process map" : `Swimlane row #${row}`}</title>`);
  };
  return { render, calls };
}
const heads = (a: string, b: string) => (repo: string) => (repo === repos[0] ? a : b);
const wantedRows = [{ row: 3406, input: "2026-10-04T00:00:00Z" }, { row: 3512, input: "2026-10-05T00:00:00Z" }];
const run = (out: string, over = {}) => publish({ out, repos, rows: () => wantedRows, readHead: heads("aaa111111", "bbb222222"), render: renderer().render, now: T0, maxAgeMs: HOUR, ...over });

test("a run into an empty directory leaves both pages, an index that links them, and the stamp (#3515)", () => {
  const out = join(scratch(), "pages");
  const result = run(out);
  assert.equal(result.ran, true);
  assert.deepEqual(readdirSync(out).sort(), ["index.html", MAP_PAGE, "row-3406.html", "row-3512.html", STAMP_FILE].sort(), "the map, one swimlane per row, the index and the stamp, and no staging directory left behind");
  assert.match(readFileSync(join(out, MAP_PAGE), "utf8"), /<title>Across-rows process map<\/title>/);
  assert.match(readFileSync(join(out, "row-3406.html"), "utf8"), /<title>Swimlane row #3406<\/title>/);
  const index = readFileSync(join(out, "index.html"), "utf8");
  for (const link of [MAP_PAGE, "row-3406.html", "row-3512.html"]) assert.ok(index.includes(`href="${link}"`), `the index links ${link}`);
  assert.deepEqual(readStamp(out), { at: T0, heads: { "a11ign/a11ign": "aaa111111", "a11ign/agent-org": "bbb222222" }, rows: { 3406: { input: wantedRows[0].input, at: T0 }, 3512: { input: wantedRows[1].input, at: T0 } } });
});

test("a run with no merge since the last one does nothing: no render, no write (no regeneration loop) (#3515)", () => {
  const out = join(scratch(), "pages");
  run(out);
  const { render, calls } = renderer();
  const before = readFileSync(join(out, "index.html"), "utf8");
  const again = run(out, { render, now: T0 + 10 * MINUTE });
  assert.equal(again.ran, false);
  assert.deepEqual(calls, [], "POSITIVE CONTROL: the renderer counts its calls (the first test's run made some), and it was not called");
  assert.equal(readFileSync(join(out, "index.html"), "utf8"), before, "the index is byte-identical: nothing was written");
  assert.equal(run(out, { render, now: T0 + 10 * MINUTE, readHead: heads("aaa111111", "ccc333333") }).ran, true, "POSITIVE CONTROL: a moved head in the SECOND repository does regenerate, so the case above is the stamp deciding");
  assert.deepEqual(calls, ["map"], "the map is drawn again, and the rows are not: nothing they were drawn from moved (#4077)");
});

test("the pages are regenerated at least hourly even when no merge moved a head, and not a minute before (#3515)", () => {
  const stamp = { at: T0, heads: { "a11ign/a11ign": "a", "a11ign/agent-org": "b" } };
  const same = { "a11ign/a11ign": "a", "a11ign/agent-org": "b" };
  assert.equal(whyRun({ heads: same, stamp, now: T0 + HOUR - 1, maxAgeMs: HOUR }), null);
  assert.match(whyRun({ heads: same, stamp, now: T0 + HOUR, maxAgeMs: HOUR }), /60 minutes old \(at most 60\)/);
  assert.match(whyRun({ heads: { ...same, "a11ign/agent-org": "z" }, stamp, now: T0 + 1, maxAgeMs: HOUR }), /main moved in a11ign\/agent-org/);
  assert.match(whyRun({ heads: same, stamp: null, now: T0, maxAgeMs: HOUR }), /no earlier publication/);
  assert.equal(DEFAULT_MAX_AGE_MINUTES, 60, "the default is the hour the row asks for");
});

test("a failure to write is an error, not an empty directory (#3515)", () => {
  const dir = scratch();
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "a file where the output directory should be");
  assert.throws(() => run(join(blocker, "pages")), /ENOTDIR|EEXIST/, "the output cannot be created, and that is thrown");
  assert.equal(existsSync(join(blocker, "pages")), false);

  const out = join(dir, "pages");
  const silent = () => { /* returns having written nothing */ };
  assert.throws(() => run(out, { render: silent }), /3 of 3 pages were not regenerated/, "a renderer that exits cleanly without writing is an error too");
  assert.equal(existsSync(join(out, STAMP_FILE)), false, "and no stamp is written, so the next run retries");
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Not regenerated/, "the page says which were not regenerated rather than looking complete");
});

test("one failed row does not hold back the others, and the run still fails and does not stamp (#3515)", () => {
  const out = join(scratch(), "pages");
  const { render } = renderer();
  const flaky = (page: { row: any; kind?: any; out?: any; }) => (page.row === 3512 ? (() => { throw new Error("trace exited 1: gh: HTTP 403"); })() : render(page));
  assert.throws(() => run(out, { render: flaky }), /1 of 3 pages were not regenerated[\s\S]*row-3512\.html: trace exited 1: gh: HTTP 403/);
  assert.ok(existsSync(join(out, MAP_PAGE)) && existsSync(join(out, "row-3406.html")), "the pages that rendered are published");
  assert.equal(existsSync(join(out, "row-3512.html")), false);
  assert.equal(readStamp(out), null);
  assert.equal(run(out, { render }).ran, true, "the next run regenerates, because nothing was stamped");
});

test("a head that cannot be read is an error, never 'nothing moved' (#3515)", () => {
  const out = join(scratch(), "pages");
  run(out);
  const unreachable = () => { throw new Error("gh: HTTP 502"); };
  assert.throws(() => run(out, { readHead: unreachable, now: T0 + MINUTE }), /HTTP 502/);
});

test("a row that has fallen out of the recent set is retired, and nothing else in the directory is touched (#3515)", () => {
  const out = join(scratch(), "pages");
  run(out);
  writeFileSync(join(out, "notes.txt"), "not ours");
  run(out, { rows: () => [wantedRows[1]], readHead: heads("new", "bbb222222"), now: T0 + MINUTE });
  assert.deepEqual(readdirSync(out).sort(), ["index.html", MAP_PAGE, "notes.txt", "row-3512.html", STAMP_FILE].sort());
});

test("an unreadable stamp regenerates, and an index escapes what it prints (#3515)", () => {
  const out = join(scratch(), "pages");
  mkdirSync(out);
  writeFileSync(join(out, STAMP_FILE), "{not json");
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(readStamp(out), null);
  } finally {
    console.error = quiet;
  }
  const page = indexPage({ generatedAt: T0, reason: "<b>x</b>", heads: { "a/b": "abcdefghijkl" }, pages: [{ file: "row-1.html", label: "a & b" }], failed: [] });
  assert.ok(page.includes("&lt;b&gt;x&lt;/b&gt;") && page.includes("a &amp; b") && page.includes("<code>abcdefghi</code>"));
});

/** `read` as the publisher gives it, over a fake that answers every path with `reply(path)` and records the paths. */
const reading = (reply: { (): { number: any; closed_at: any; updated_at: string; }[]; (path: any): { number: any; updated_at: string; closed_at: string; }[]; (path: any): { number: any; updated_at: string; closed_at: string; }[]; (path: any): { pull_request?: {}|undefined; number: number; closed_at: string; updated_at: string; }[]; (path: any): { number: any; closed_at: string; updated_at: string; }[]; (): { number: any; closed_at: string; updated_at: string; }[]; (): { items: never[]; }; (arg0: any): any; }) => {
  const asked: any[] = [];
  return { asked, read: (path: any, reduce: (arg0: any) => any) => (asked.push(path), reduce(reply(path))) };
};

test("recentClosedRows reads the issues LIST for rows closed in the window, newest closing first, drops pull requests and a row only commented on; --recent 0 asks nothing (#3515, #3695)", () => {
  const since = Date.parse("2026-09-28T12:00:00Z");
  const item = (number: number, closed_at: string|any[], extra = {}) => ({ number, closed_at, updated_at: `${closed_at.slice(0, 10)}T09:00:00Z`, ...extra });
  // #6 is the record issue: closed a month ago, commented on all day, so the list `since` (by update) returns it and only `closed_at` keeps it out.
  const { asked, read } = reading(() => [item(7, "2026-10-02T00:00:00Z"), item(9, "2026-10-04T00:00:00Z", { pull_request: {} }), item(8, "2026-10-03T00:00:00Z"), item(6, "2026-09-12T04:42:49Z", { updated_at: "2026-10-05T11:59:00Z" }), item(5, "2026-10-01T00:00:00Z")]);
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 4, since, read), [{ row: 8, input: "2026-10-03T09:00:00Z" }, { row: 7, input: "2026-10-02T09:00:00Z" }, { row: 5, input: "2026-10-01T09:00:00Z" }], "newest closing first, each with its updated_at; #9 is a pull request and #6, closed long before `since` and commented on all day, is not returned");
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 2, since, read).map(({ row }) => row), [8, 7], "at most `count`");
  assert.ok(asked[0].startsWith("repos/a11ign/a11ign/issues?") && asked[0].includes("state=closed"), "the issues list, on the core pool");
  assert.ok(!asked.some((path) => /search/.test(path)), "no search call");
  const before = asked.length;
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 0, since, read), []);
  assert.equal(asked.length, before, "--recent 0 asks nothing");
  assert.ok(before > 0, "POSITIVE CONTROL: the earlier calls asked, so the zero case asking nothing is the count and not an unwired seam");
});

test("recentClosedRows reads newest-UPDATED first and stops once nothing unread can displace the answer; it reads on when something could (#4077)", () => {
  const since = Date.parse("2026-09-28T12:00:00Z");
  const hours = (n: number) => new Date(Date.parse("2026-10-05T12:00:00Z") - n * 60 * MINUTE).toISOString();
  // A page of 100 issues, updated newest first, one hour apart; row n is closed 10 minutes before it was last updated.
  const page = (first: number) => Array.from({ length: 100 }, (_, index) => ({ number: first + index, updated_at: hours(first + index - 1000), closed_at: hours(first + index - 1000 + 1 / 6) }));
  const first = reading((path: string) => (path.endsWith("page=1") ? page(1000) : page(1100)));
  const rows = recentClosedRows("a11ign/a11ign", 3, since, first.read).map(({ row }) => row);
  assert.deepEqual(rows, [1000, 1001, 1002]);
  assert.equal(first.asked.length, 1, "three rows are in hand and the page ends on an issue updated long before the third closing: nothing further down can be newer, so one page");
  assert.ok(first.asked[0].includes("sort=updated") && first.asked[0].includes("direction=desc"));
  const more = reading((path: string) => (path.endsWith("page=1") ? page(1000) : [{ number: 5, updated_at: hours(2000), closed_at: hours(2000) }]));
  recentClosedRows("a11ign/a11ign", 100, since, more.read);
  assert.equal(more.asked.length, 2, "NEGATIVE CONTROL: asking for 100 rows, the page's last issue is not older than the 100th closing, so the next page is read");
});

test("the early stop returns exactly what reading the whole list would, over many shapes of list (#4077)", () => {
  const since = Date.parse("2026-09-28T12:00:00Z");
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let stoppedEarly = 0;
  let readOn = 0;
  for (let trial = 0; trial < 300; trial += 1) {
    const length = Math.floor(next() * 450);
    const slots = Array.from({ length }, (_, index) => index).sort(() => next() - 0.5); // distinct closing times, in no order
    const issues = slots.map((slot, index) => {
      const closed = since - 2 * 24 * 60 * MINUTE + slot * 11 * MINUTE;
      return { number: index + 1, closed_at: new Date(closed).toISOString(), updated_at: new Date(closed + Math.floor(next() * 3) * 7 * 60 * MINUTE + Math.floor(next() * 5) * MINUTE).toISOString(), ...(next() < 0.3 ? { pull_request: {} } : {}) };
    });
    issues.push({ number: 0, closed_at: "2026-09-12T04:42:49Z", updated_at: new Date(since + 90 * 24 * 60 * MINUTE).toISOString() }); // the record issue: old closing, updated after everything
    const served = [...issues].sort((one, other) => Date.parse(other.updated_at) - Date.parse(one.updated_at));
    for (const count of [1, 3, 6, 40]) {
      const { asked, read } = reading((path: string) => { const at = Number(path.split("&page=")[1]); return served.slice((at - 1) * 100, at * 100); });
      const got = recentClosedRows("a11ign/a11ign", count, since, read).map(({ row }) => row);
      const whole = issues.filter((one) => !one.pull_request && Date.parse(one.closed_at) >= since).sort((one, other) => Date.parse(other.closed_at) - Date.parse(one.closed_at)).slice(0, count).map(({ number }) => number);
      assert.deepEqual(got, whole, `trial ${trial}, count ${count}`);
      if (asked.length < Math.ceil(served.length / 100)) stoppedEarly += 1;
      if (asked.length > 1) readOn += 1;
    }
  }
  assert.ok(stoppedEarly > 100 && readOn > 100, `POSITIVE CONTROL: the stop fired in ${stoppedEarly} cases and was held back in ${readOn}, so the equality above is not one page-sized list`);
});

test("recentClosedRows pages the list until a short page, and REFUSES a list it cannot finish rather than cutting it short (#3695)", () => {
  const since = Date.parse("2026-09-28T12:00:00Z");
  const full = (from: number) => Array.from({ length: 100 }, (_, index) => ({ number: from + index, closed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }));
  const twoPages = reading((path: string) => (path.endsWith("page=1") ? full(1000) : [{ number: 2000, closed_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" }]));
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 2, since, twoPages.read).map(({ row }) => row), [2000, 1000], "a row on the second page is found, and ties keep list order");
  assert.deepEqual(twoPages.asked.map((path) => path.split("&").pop()), ["page=1", "page=2"]);
  const endless = reading(() => full(1));
  assert.throws(() => recentClosedRows("a11ign/a11ign", 3, since, endless.read), /more than \d+ issues closed and updated since 2026-09-28T12:00:00.000Z/);
  assert.equal(endless.asked.length, CLOSED_ROWS_MAX_PAGES, "the bound is the page limit, and every page up to it was read");
  assert.throws(() => recentClosedRows("a11ign/a11ign", 3, since, reading(() => ({ items: [] })).read), /no list where one was expected/);
});

/**
 * A fake GitHub: `ask` answers a 304 to the ETag it gave for the CURRENT body and a 200 with a new ETag otherwise, as GitHub does, and records what each request sent. `heads` and `closed` are what it holds and a test changes them.
 * The issues list is served as pages of 100 from `closed[repo]`, whatever `since` says (the publisher filters by the exact time itself).
 */
function github({ heads: held, closed }) {
  const log: { path: any; sent: any; status: number; }[] = [];
  const etagOf = (body: any[]|{ commit: { sha: any; extra: string; }; }) => `W/"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
  const bodyOf = (path: string) => {
    const head = /^repos\/(.+)\/branches\/main$/.exec(path);
    if (head) return { commit: { sha: held[head[1]], extra: "not kept" } };
    const list = /^repos\/(.+)\/issues\?.*page=(\d+)$/.exec(path);
    if (list) return [...(closed[list[1]] ?? [])].sort((one, other) => Date.parse(other.updated_at) - Date.parse(one.updated_at)).slice((Number(list[2]) - 1) * 100, Number(list[2]) * 100);
    throw new Error(`gh api ${path}: HTTP 404`);
  };
  const ask = (path: any, sent: string) => {
    const body = bodyOf(path);
    const current = etagOf(body);
    const status = sent === current ? 304 : 200;
    log.push({ path, sent, status });
    return status === 304 ? { status, etag: sent, body: null } : { status, etag: current, body };
  };
  return { ask, log, heads: held, closed };
}

const issue = (number: number, closedAt: string, updatedAt = closedAt) => ({ number, closed_at: closedAt, updated_at: updatedAt, title: "x".repeat(400), body: "not kept" });
const fixture = () => github({ heads: { [repos[0]]: "aaa111111", [repos[1]]: "bbb222222" }, closed: { [repos[0]]: [issue(3406, "2026-10-03T00:00:00Z"), issue(3512, "2026-10-04T00:00:00Z")] } });
/** A renderer whose pages carry the number of the render that made them, so "was not rewritten" is a page that still says the OLD number. */
function numbered() {
  const calls: string[] = [];
  const render = ({ kind, row, out }) => {
    calls.push(kind === "map" ? "map" : `row ${row}`);
    writeFileSync(out, `<title>${kind} ${row ?? ""}</title><!-- render ${calls.length} -->`);
  };
  return { render, calls };
}
const go = (out: string, gh: { ask: any; log?: any[]; heads?: any; closed?: any; }, { render }: { render: (({ kind,row,out }: { kind: any; row: any; out: any; }) => void)|(() => never); calls?: any[]; }, at = T0, over = {}) => runPublisher({ out, repos, trackerRepo: repos[0], recent: 6, rows: [], ask: gh.ask, render, now: at, maxAgeMs: HOUR, ...over });
const page = (out: string, file: string) => readFileSync(join(out, file), "utf8");

test("a second run over unchanged responses sends the stored validators and, on a 304, rewrites no page (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  const first = numbered();
  go(out, gh, first);
  assert.ok(gh.log.length > 0 && gh.log.every(({ sent }) => sent === null), "NEGATIVE CONTROL: the first run had nothing stored and sent no validator");
  assert.deepEqual(first.calls, ["map", "row 3512", "row 3406"], "the first run draws everything, newest closing first");
  const before = readdirSync(out).sort().map((name) => [name, page(out, name)]);
  gh.log.length = 0;
  const second = numbered();
  const result = go(out, gh, second, T0 + 10 * MINUTE);
  assert.equal(result.ran, false);
  assert.equal(gh.log.length, repos.length, "an idle run asks for the heads and nothing else");
  assert.ok(gh.log.every(({ sent, status }) => sent !== null && status === 304), "every request carried the stored validator and was answered 304");
  assert.deepEqual({ asked: result.reads.asked, notModified: result.reads.notModified }, { asked: gh.log.length, notModified: gh.log.length });
  assert.deepEqual(second.calls, [], "no page was rendered");
  assert.deepEqual(readdirSync(out).sort().map((name) => [name, page(out, name)]), before.map(([name, text]) => [name, name === VALIDATORS_FILE ? page(out, name) : text]), "and no page was rewritten, the index included");
});

test("a changed input rewrites exactly the pages that read it, and a day later everything is drawn again (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  go(out, gh, numbered());
  const rowBefore = { 3406: page(out, "row-3406.html"), 3512: page(out, "row-3512.html") };
  gh.closed[repos[0]][0] = issue(3406, "2026-10-03T00:00:00Z", "2026-10-05T11:00:00Z"); // a comment on #3406 only
  gh.log.length = 0;
  const edited = numbered();
  go(out, gh, edited, T0 + 20 * MINUTE + HOUR);
  assert.deepEqual(edited.calls, ["map", "row 3406"], "the map (the hour is up) and the one row whose issue moved");
  assert.equal(page(out, "row-3512.html"), rowBefore[3512], "POSITIVE CONTROL for the cache: the untouched row's page is byte-identical, so a 'held' page is not a render that happened to write the same bytes");
  assert.notEqual(page(out, "row-3406.html"), rowBefore[3406], "and the moved row's page is new");
  assert.equal(gh.log.filter(({ status }) => status === 200).length, 1, "the list (one page, asked without a validator) is the only 200: both heads were 304");
  const later = numbered();
  go(out, gh, later, T0 + 20 * MINUTE + HOUR + ROW_PAGE_MAX_AGE_MS);
  assert.deepEqual(later.calls, ["map", "row 3512", "row 3406"], "a day on, a page is drawn again whatever its input says: what a validator cannot see is bounded");
});

test("a moved head redraws the map and no row whose own input did not move; a new row is drawn; one that left is retired (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  go(out, gh, numbered());
  gh.heads[repos[1]] = "ccc333333";
  gh.closed[repos[0]].push(issue(3600, "2026-10-05T10:00:00Z"));
  const second = numbered();
  const result = go(out, gh, second, T0 + 5 * MINUTE);
  assert.deepEqual(second.calls, ["map", "row 3600"], "the map, and the row that was not on the page before");
  assert.deepEqual(result.held.sort(), ["row-3406.html", "row-3512.html"]);
  assert.deepEqual(readdirSync(out).filter((name) => name.startsWith("row-")).sort(), ["row-3406.html", "row-3512.html", "row-3600.html"]);
});

test("a missing or corrupt validator store falls back to an unconditional request and never to a skipped page (#4077)", () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [name, stored] of [["missing", null], ["not JSON", "{not json"], ["wrong shape", JSON.stringify({ "repos/a11ign/a11ign/branches/main": { etag: 5 }, "repos/a11ign/agent-org/branches/main": { etag: "W/\"x\"" } })]]) {
      const out = join(scratch(), "pages");
      mkdirSync(out, { recursive: true });
      if (stored !== null) writeFileSync(join(out, VALIDATORS_FILE), stored);
      assert.deepEqual(readValidators(out), {}, `${name}: no validator survives`);
      const gh = fixture();
      const drawn = numbered();
      const result = go(out, gh, drawn);
      assert.ok(gh.log.length > 0 && gh.log.every(({ sent }) => sent === null), `${name}: every request was unconditional`);
      assert.equal(result.ran, true);
      assert.deepEqual(drawn.calls, ["map", "row 3512", "row 3406"], `${name}: every page was drawn, none skipped`);
      assert.equal(Object.keys(readValidators(out)).length, repos.length, `${name}: and the store holds a head for each repository again, for the next run`);
    }
  } finally {
    console.error = quiet;
  }
  assert.throws(() => conditionalReader({ held: {}, ask: () => ({ status: 304, etag: null, body: null }), now: T0 }).read("repos/x/branches/main", () => 1), /HTTP 304 to a request that carried no validator/, "a 304 to a request that asked for nothing is refused, not answered with a value it does not have");
});

test("a stamp from before rows were remembered draws every row, and a page deleted from the directory is drawn again (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  go(out, gh, numbered());
  const stamp = JSON.parse(readFileSync(join(out, STAMP_FILE), "utf8"));
  writeFileSync(join(out, STAMP_FILE), JSON.stringify({ at: stamp.at, heads: stamp.heads }));
  assert.deepEqual(readStamp(out).rows, {});
  const old = numbered();
  go(out, gh, old, T0 + HOUR);
  assert.deepEqual(old.calls, ["map", "row 3512", "row 3406"], "no remembered row, so no row is held");
  rmSyncOf(join(out, "row-3406.html"));
  const gone = numbered();
  go(out, gh, gone, T0 + 2 * HOUR);
  assert.deepEqual(gone.calls, ["map", "row 3406"], "POSITIVE CONTROL: with the stamp intact the only row drawn is the one whose file is gone");
});

test("a row named by --row that is not in the recent set is always drawn; one that is, is held (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  go(out, gh, numbered(), T0, { rows: [4001, 3406] });
  const again = numbered();
  go(out, gh, again, T0 + HOUR, { rows: [4001, 3406] });
  assert.deepEqual(again.calls, ["map", "row 4001"], "4001 has no input and is drawn each time; 3406 is in the list, so its input holds");
});

test("the validators are written back when the publication fails, and an entry unused for two days is left out (#4077)", () => {
  const out = join(scratch(), "pages");
  const gh = fixture();
  const broken = () => { throw new Error("trace exited 1"); };
  assert.throws(() => go(out, gh, { render: broken }), /3 of 3 pages were not regenerated/);
  const kept = readValidators(out);
  assert.ok(Object.keys(kept).length > 0, "what GitHub said is kept though no page was");
  assert.equal(existsSync(join(out, `${VALIDATORS_FILE}.tmp`)), false, "and no temporary file is left behind");
  saveValidators({ out, held: { ...kept, "repos/old/branches/main": { etag: "W/\"o\"", value: "o", used: T0 - 3 * ROW_PAGE_MAX_AGE_MS } }, now: T0 });
  assert.deepEqual(Object.keys(readValidators(out)).sort(), Object.keys(kept).sort(), "the stale entry was dropped, the fresh ones kept");
});

test("pageStillHolds: the same input, a young page and a file on disk, and nothing less (#4077)", () => {
  const out = join(scratch(), "pages");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "row-7.html"), "<title>7</title>");
  const stamp = { at: T0, heads: {}, rows: { 7: { input: "u1", at: T0 } } };
  const holds = (over: { wanted?: WantedRow|{ row: number; input: string; }|{ row: number; input: null; }|{ row: number; input: string; }; now?: number; stamp?: Stamp|null; out?: string; }) => pageStillHolds({ wanted: { row: 7, input: "u1" }, stamp, out, now: T0 + HOUR, ...over });
  assert.equal(holds({}), true);
  assert.equal(holds({ wanted: { row: 7, input: "u2" } }), false, "a moved input");
  assert.equal(holds({ wanted: { row: 7, input: null } }), false, "an unknown input");
  assert.equal(holds({ now: T0 + ROW_PAGE_MAX_AGE_MS }), false, "a day old");
  assert.equal(holds({ stamp: null }), false, "no stamp");
  assert.equal(holds({ wanted: { row: 8, input: "u1" } }), false, "a row never drawn");
  writeFileSync(join(out, "row-7.html"), "");
  assert.equal(holds({}), false, "an empty file is not a page");
});

test("parseReply reads the status line and not the exit code: a 200 with its ETag, a 304, and a failure (#4077)", () => {
  const ok = parseReply({ stdout: 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-Ratelimit-Resource: core\r\n\r\n{"commit":{"sha":"d34db33f"}}', stderr: "", path: "repos/x/branches/main", sent: null });
  assert.deepEqual(ok, { status: 200, etag: 'W/"abc"', body: { commit: { sha: "d34db33f" } } });
  assert.deepEqual(parseReply({ stdout: 'HTTP/2.0 304 Not Modified\r\nX-Ratelimit-Resource: core\r\n\r\n', stderr: "gh: HTTP 304", path: "p", sent: 'W/"abc"' }), { status: 304, etag: 'W/"abc"', body: null });
  assert.throws(() => parseReply({ stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)", path: "repos/x/branches/main", sent: null }), /repos\/x\/branches\/main: gh: Not Found \(HTTP 404\)/);
  assert.throws(() => parseReply({ stdout: "", stderr: "dial tcp: lookup api.github.com", path: "p", sent: null }), /dial tcp/, "no reply at all is a failure, never a 304");
});

test("parseArgs: defaults, repeated --row, and an unknown flag refused (#3515)", () => {
  const given = parseArgs(["--out", "/srv/x", "--row", "3406", "--row", "3512", "--recent", "2", "--max-age-minutes", "30"]);
  assert.deepEqual({ out: given.out, rows: given.rows, recent: given.recent, maxAgeMs: given.maxAgeMs }, { out: "/srv/x", rows: [3406, 3512], recent: 2, maxAgeMs: 30 * MINUTE });
  assert.equal(parseArgs([]).maxAgeMs, HOUR);
  assert.match(parseArgs([]).out, /\.cache\/a11ign\/trace-pages$/);
  assert.throws(() => parseArgs(["--recnet", "3"]), /unknown flag --recnet/);
  assert.throws(() => parseArgs(["--recent", "-1"]), /whole number/);
});
