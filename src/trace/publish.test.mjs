// a11ign/a11ign#3515: the trace pages' publisher. Fixtures only: no `gh`, no `trace` child, no host directory; a temp directory is the output and a stub is the renderer.
// no-token: gh -- `readHead` and the renderer are injected; the two `gh` seams (`readHead`, `recentClosedRows`) are exercised through a fake `gh` that records its arguments.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_AGE_MINUTES, indexPage, MAP_PAGE, parseArgs, publish, readStamp, recentClosedRows, STAMP_FILE, whyRun } from "./publish.mjs";

const MINUTE = 60 * 1000;
const T0 = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 60 * MINUTE;
const repos = ["a11ign/a11ign", "a11ign/agent-org"];

const scratch = () => mkdtempSync(join(tmpdir(), "trace-publish-"));
/** A renderer that writes a recognisable page and counts its calls, so "does nothing" is a count and not an inference. */
function renderer() {
  const calls = [];
  const render = ({ kind, row, out }) => {
    calls.push(kind === "map" ? "map" : `row ${row}`);
    writeFileSync(out, `<!doctype html><title>${kind === "map" ? "Across-rows process map" : `Swimlane row #${row}`}</title>`);
  };
  return { render, calls };
}
const heads = (a, b) => (repo) => (repo === repos[0] ? a : b);
const run = (out, over = {}) => publish({ out, repos, rows: () => [3406, 3512], readHead: heads("aaa111111", "bbb222222"), render: renderer().render, now: T0, maxAgeMs: HOUR, ...over });

test("a run into an empty directory leaves both pages, an index that links them, and the stamp (#3515)", () => {
  const out = join(scratch(), "pages");
  const result = run(out);
  assert.equal(result.ran, true);
  assert.deepEqual(readdirSync(out).sort(), ["index.html", MAP_PAGE, "row-3406.html", "row-3512.html", STAMP_FILE].sort(), "the map, one swimlane per row, the index and the stamp, and no staging directory left behind");
  assert.match(readFileSync(join(out, MAP_PAGE), "utf8"), /<title>Across-rows process map<\/title>/);
  assert.match(readFileSync(join(out, "row-3406.html"), "utf8"), /<title>Swimlane row #3406<\/title>/);
  const index = readFileSync(join(out, "index.html"), "utf8");
  for (const link of [MAP_PAGE, "row-3406.html", "row-3512.html"]) assert.ok(index.includes(`href="${link}"`), `the index links ${link}`);
  assert.deepEqual(readStamp(out), { at: T0, heads: { "a11ign/a11ign": "aaa111111", "a11ign/agent-org": "bbb222222" } });
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
  assert.deepEqual(calls, ["map", "row 3406", "row 3512"]);
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
  const flaky = (page) => (page.row === 3512 ? (() => { throw new Error("trace exited 1: gh: HTTP 403"); })() : render(page));
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
  run(out, { rows: () => [3512], readHead: heads("new", "bbb222222"), now: T0 + MINUTE });
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

test("recentClosedRows asks for rows CLOSED in the window, newest closing first, and drops pull requests; --recent 0 asks nothing (#3515)", () => {
  const asked = [];
  const since = Date.parse("2026-09-28T12:00:00Z");
  const item = (number, closed_at, extra = {}) => ({ number, closed_at, ...extra });
  const gh = (args) => (asked.push(args), { items: [item(7, "2026-10-02T00:00:00Z"), item(9, "2026-10-04T00:00:00Z", { pull_request: {} }), item(8, "2026-10-03T00:00:00Z"), item(6, "2026-09-12T04:42:49Z"), item(5, "2026-10-01T00:00:00Z")] });
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 4, since, gh), [8, 7, 5], "newest closing first, #9 is a pull request and #6, the record issue closed a month ago and commented on all day, is not in the window");
  assert.ok(asked[0].includes("q=repo:a11ign/a11ign is:issue is:closed closed:>=2026-09-28"), "the query is by closing date");
  assert.deepEqual(recentClosedRows("a11ign/a11ign", 0, since, gh), []);
  assert.equal(asked.length, 1, "POSITIVE CONTROL: the first call asked, so the zero case asking nothing is the count and not an unwired seam");
});

test("parseArgs: defaults, repeated --row, and an unknown flag refused (#3515)", () => {
  const given = parseArgs(["--out", "/srv/x", "--row", "3406", "--row", "3512", "--recent", "2", "--max-age-minutes", "30"]);
  assert.deepEqual({ out: given.out, rows: given.rows, recent: given.recent, maxAgeMs: given.maxAgeMs }, { out: "/srv/x", rows: [3406, 3512], recent: 2, maxAgeMs: 30 * MINUTE });
  assert.equal(parseArgs([]).maxAgeMs, HOUR);
  assert.match(parseArgs([]).out, /\.cache\/a11ign\/trace-pages$/);
  assert.throws(() => parseArgs(["--recnet", "3"]), /unknown flag --recnet/);
  assert.throws(() => parseArgs(["--recent", "-1"]), /whole number/);
});
