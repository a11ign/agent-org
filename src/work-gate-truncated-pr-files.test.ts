// no-token: gh -- imports `work-gate.mjs`, whose default reader spawns `gh`; every read here is handed an injected `run`, so nothing is spawned (#3365)
/**
 * #3365: THE GATE PAGES THE FILES OF A PULL REQUEST `gh pr list` TRUNCATED, INSTEAD OF DROPPING IT.
 *
 * `gh pr list --json files` returns a PR's first 100 files and never says so. `comparablePrFiles` refuses a list shorter than `changedFiles`, so
 * a row overlapping the release workflow's 146-file version PR was never shelved: offered every tick and refused at the spawn check, which pages
 * (`pagedPrFiles`). These tests hold the two readers of one question to one answer:
 *   1. a truncated PR's 146th file is compared, and the row that names it is `blocked`;
 *   2. a PR whose paging fails stays dropped (fail open), says so, and the row is offered;
 *   3. a PR whose list is complete costs no REST call and no disk read.
 * POSITIVE CONTROLS: (1) is the assertion that fails on a `readPrs` that does not page (the row is offered); a truncated PR that does not
 * overlap the row is still offerable after paging, so "blocked" is not what this harness says of every row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrs, comparablePrFiles, partitionUnclaimed, withPagedFiles } from "./work-gate.ts";

/** Under a top-level directory both this repository and a11ign's track, or `declaredRegionFiles` reads the Region as declaring nothing (#3073). */
const REGION_FILE = "docs/messaging.md";
const LISTED = 100;
const REPORTED = 146;
const VERSION_PR = 3353;
const HEAD = "a".repeat(40);

const row = (n: number, file: string) =>
  ({ number: n, body: `## Region\n\n- \`${file}\`\n\n## Acceptance\n\nnone\n\n## Open-check\n\nnone\n`, labels: [{ name: "ready" }] });

/** A 146-file pull request as `gh pr list` reports it: 100 listed, the file `last` being the 146th and so never listed. */
const reportedPr = (head = HEAD) => ({ number: VERSION_PR, headRefOid: head, changedFiles: REPORTED,
  files: Array.from({ length: LISTED }, (_, i) => ({ path: `packages/p${i}/CHANGELOG.md` })), body: "", labels: [] });
const allFiles = (last: string) => [...Array.from({ length: REPORTED - 1 }, (_, i) => `packages/p${i}/CHANGELOG.md`), last];

/** A `gh` that answers `pr list` with `prs` and the files endpoint with `pages` (a string, or an Error to fail with), and counts every call. */
function fakeGh(prs: unknown[], pages: string | Error) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") return JSON.stringify(prs);
    if (pages instanceof Error) throw pages;
    return pages;
  };
  return { run, calls, paged: () => calls.filter((args) => args[0] === "api") };
}

/** The tick's own composition: read the lanes, compare. Cache goes to a directory this test owns, never the host's. */
function offeredAfterReading(prs: unknown[], pages: string | Error, region: string) {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  const said: string[] = [];
  try {
    const gh = fakeGh(prs, pages);
    const read = withPagedFiles(JSON.parse(gh.run(["pr"])), { run: gh.run, cachePath: join(dir, "cache.json"), log: (line) => said.push(line) });
    return { ...partitionUnclaimed([row(3357, region)], comparablePrFiles(read), { rowBranches: null, openRows: [] }), said, gh };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a row naming the 146th file of a truncated pull request is BLOCKED by it, not offered", () => {
  const { offerable, blocked } = offeredAfterReading([reportedPr()], allFiles(REGION_FILE).join("\n"), REGION_FILE);
  assert.deepEqual(offerable, []);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, new RegExp(`overlaps #${VERSION_PR}`));
});

test("POSITIVE CONTROL: paging does not shelve a row the truncated pull request really does not touch", () => {
  const { offerable, blocked } = offeredAfterReading([reportedPr()], allFiles("docs/elsewhere.md").join("\n"), REGION_FILE);
  assert.deepEqual(blocked, []);
  assert.deepEqual(offerable.map((r: { number: number }) => r.number), [3357]);
});

test("CONTROL: without paging the same row IS offered (today's behaviour), so the first test fails on the old reader", () => {
  const unpaged = comparablePrFiles([reportedPr()]);
  assert.deepEqual(unpaged, [], "100 of 146 listed -- not comparable, which is what dropped the version PR");
  const { offerable } = partitionUnclaimed([row(3357, REGION_FILE)], unpaged, { rowBranches: null, openRows: [] });
  assert.equal(offerable.length, 1);
});

test("a failing page read leaves the pull request dropped, offers the row, and names the PR on stderr", () => {
  const { offerable, blocked, said } = offeredAfterReading([reportedPr()], new Error("HTTP 502\nbad gateway"), REGION_FILE);
  assert.deepEqual(blocked, []);
  assert.equal(offerable.length, 1);
  assert.equal(said.length, 1, "one line, not one per attempt");
  assert.match(said[0], new RegExp(`#${VERSION_PR}`));
  assert.match(said[0], /HTTP 502/);
});

test("a page that comes back with the wrong count is dropped and said, not compared on a list that may be partial", () => {
  const { offerable, said } = offeredAfterReading([reportedPr()], allFiles(REGION_FILE).slice(1).join("\n"), REGION_FILE);
  assert.equal(offerable.length, 1);
  assert.match(said.join(""), new RegExp(`#${VERSION_PR} lists ${REPORTED - 1} files`));
});

test("a pull request whose list is complete is read without a REST call or a cache read", () => {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  try {
    const cachePath = join(dir, "cache.json");
    writeFileSync(cachePath, "not json");
    const whole = { number: 7, headRefOid: HEAD, changedFiles: 2, files: [{ path: "a" }, { path: "b" }] };
    const gh = fakeGh([whole], new Error("must not be called"));
    const said: string[] = [];
    const read = withPagedFiles(JSON.parse(gh.run(["pr"])), { run: gh.run, cachePath, log: (line) => said.push(line) });
    assert.deepEqual(gh.paged(), []);
    assert.deepEqual(said, [], "the unreadable cache was never opened, so it was never complained of");
    assert.deepEqual(comparablePrFiles(read).map((p: { number: number }) => p.number), [7]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the paged list is cached by number + head: one REST read per head, and a new head pages again", () => {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  try {
    const cachePath = join(dir, "state", "cache.json");
    const pages = allFiles(REGION_FILE).join("\n");
    const tick = (head: string) => {
      const gh = fakeGh([reportedPr(head)], pages);
      withPagedFiles(JSON.parse(gh.run(["pr"])), { run: gh.run, cachePath, log: () => {} });
      return gh.paged().length;
    };
    assert.equal(tick(HEAD), 1, "first sight of the head pages once");
    assert.equal(tick(HEAD), 0, "the next tick (a new process) reads the cache");
    assert.equal(tick("b".repeat(40)), 1, "a push moves the head and the list is read again");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(cachePath, "utf8"))), [`${VERSION_PR}@${HEAD}`, `${VERSION_PR}@${"b".repeat(40)}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache keeps only the newest entries, so a version PR open for weeks does not grow it", () => {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  try {
    const cachePath = join(dir, "cache.json");
    const pages = allFiles(REGION_FILE).join("\n");
    const heads = Array.from({ length: 25 }, (_, i) => String(i).padStart(40, "0"));
    for (const head of heads) {
      const gh = fakeGh([reportedPr(head)], pages);
      withPagedFiles(JSON.parse(gh.run(["pr"])), { run: gh.run, cachePath, log: () => {} });
    }
    const keys = Object.keys(JSON.parse(readFileSync(cachePath, "utf8")));
    assert.equal(keys.length, 20);
    assert.equal(keys.at(-1), `${VERSION_PR}@${heads.at(-1)}`, "the newest survived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable cache and an unwritable cache path are said aloud and never stop the read", () => {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  try {
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    const said: string[] = [];
    for (const cachePath of [corrupt, join(blocker, "nested", "cache.json")]) {
      const gh = fakeGh([reportedPr()], allFiles(REGION_FILE).join("\n"));
      const read = withPagedFiles(JSON.parse(gh.run(["pr"])), { run: gh.run, cachePath, log: (line) => said.push(line) });
      assert.deepEqual(comparablePrFiles(read).map((p: { number: number }) => p.number), [VERSION_PR], "the pull request is still compared");
    }
    assert.match(said.join(""), /is unreadable/);
    assert.match(said.join(""), /could not remember the paged file lists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`readPrs` is the reader that pages, so every lane and every sibling repository gets complete lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "paged-files-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".shadow-copy"), "");
  const previous = process.env.A11IGN_SHADOW_STATE_DIR;
  process.env.A11IGN_SHADOW_STATE_DIR = dir;
  try {
    const gh = fakeGh([reportedPr()], allFiles(REGION_FILE).join("\n"));
    const prs = readPrs(gh.run) ?? [];
    assert.equal(comparablePrFiles(prs).length, 1);
    assert.ok(existsSync(join(dir, "truncated-pr-files.json")), "POSITIVE CONTROL: the cache went where the state directory says, not to the host's");
  } finally {
    if (previous === undefined) delete process.env.A11IGN_SHADOW_STATE_DIR; else process.env.A11IGN_SHADOW_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
