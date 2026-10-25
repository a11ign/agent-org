// no-token: none -- `gh` is a stub that answers from a table and records each call: no network
// A11-249: what a pull request closed without merging still held, as the code host reads it
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPARE_FILE_CAP, readClosedWork } from "./closed-work.ts";
import type { Gh } from "./gh.ts";

const URL = "https://github.com/o/r/pull/14";
const HEAD = "b".repeat(40);
const FIRST = "a".repeat(40);
const pull = (over: Record<string, unknown> = {}) => JSON.stringify({ number: 14, state: "CLOSED", baseRefName: "main", headRefName: "admin/a11-229-x", headRefOid: HEAD, ...over });
const commit = (sha: string, subject: string) => `C ${JSON.stringify({ sha, subject })}`;
const file = (path: string) => `F ${JSON.stringify(path)}`;

/** A `gh` that answers the pull request read with `view` and the compare with `compare`, and records each call. */
function github(view: string, compare: string, calls: string[][] = []): Gh {
  return (args) => {
    calls.push(args);
    if (args[0] === "pr") return view;
    if (args[0] === "api") return compare;
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
}

test("A11-249: a closed pull request's commits and files are read from the compare of its base with its head COMMIT, never its branch", () => {
  const calls: string[][] = [];
  const found = readClosedWork(URL, github(pull(), [`T 2`, commit(FIRST, "feat(check-report): refuse unknown options"), commit(HEAD, "test: a browser.newContext() suite"), file("src/check-report.ts"), file("test/context.test.ts"), ""].join("\n"), calls));
  assert.deepEqual(found, { number: 14, url: URL, base: "main", branch: "admin/a11-229-x", head: HEAD, filesComplete: true,
    commits: [{ sha: FIRST, subject: "feat(check-report): refuse unknown options" }, { sha: HEAD, subject: "test: a browser.newContext() suite" }], files: ["src/check-report.ts", "test/context.test.ts"] });
  assert.deepEqual(calls[0], ["pr", "view", URL, "--json", "number,state,baseRefName,headRefName,headRefOid"]);
  assert.deepEqual(calls[1]!.slice(0, 3), ["api", "--paginate", `repos/o/r/compare/main...${HEAD}?per_page=100`], "the head's SHA, so a deleted branch is still read");
  assert.ok(!calls.flat().some((arg) => arg.includes("admin/a11-229-x")), "the branch's name is never asked about");
});

test("A11-249: a pull request whose compare finds no commit ahead of its base holds nothing unique, and is not null", () => {
  assert.deepEqual(readClosedWork(URL, github(pull(), "T 0\n"))?.commits, []);
  assert.deepEqual(readClosedWork(URL, github(pull(), "T 0\n"))?.files, []);
});

test("A11-249: the pages of a long compare are joined, a commit or a file that two pages repeat is kept once, and a branch with a slash in its base is read", () => {
  const second = "c".repeat(40);
  const calls: string[][] = [];
  const found = readClosedWork(URL, github(pull({ baseRefName: "release/1.x" }), ["T 2", commit(FIRST, "one"), file("a.ts"), "T 2", commit(second, "two"), file("a.ts"), file("b.ts")].join("\n"), calls));
  assert.deepEqual([found?.commits.map(({ sha }) => sha), found?.files], [[FIRST, second], ["a.ts", "b.ts"]]);
  assert.equal(calls[1]![2], `repos/o/r/compare/release/1.x...${HEAD}?per_page=100`);
});

test("A11-249: a list of files that reaches GitHub's cap is read in part, and says so", () => {
  const capped = readClosedWork(URL, github(pull(), ["T 1", commit(FIRST, "one"), ...Array.from({ length: COMPARE_FILE_CAP }, (_, at) => file(`f${at}.ts`))].join("\n")));
  const under = readClosedWork(URL, github(pull(), ["T 1", commit(FIRST, "one"), ...Array.from({ length: COMPARE_FILE_CAP - 1 }, (_, at) => file(`f${at}.ts`))].join("\n")));
  assert.deepEqual([capped?.files.length, capped?.filesComplete, under?.filesComplete], [COMPARE_FILE_CAP, false, true]);
});

test("A11-249: a commit message or a path with a tab, a quote or a colon is read whole, as each line is JSON", () => {
  const found = readClosedWork(URL, github(pull(), ["T 1", commit(FIRST, 'fix: "quote"\tand: colon'), file("dir with space/a\tb.ts")].join("\n")));
  assert.deepEqual([found?.commits[0]?.subject, found?.files], ['fix: "quote"\tand: colon', ["dir with space/a\tb.ts"]]);
});

test("A11-249: a pull request that is open or merged is null, since its work is not final or is on its base", () => {
  for (const state of ["OPEN", "MERGED"]) assert.equal(readClosedWork(URL, github(pull({ state }), "T 0\n")), null, state);
});

test("A11-249: a read that cannot be made is null, never an empty list: a refused gh, an answer that does not parse, a missing field, an address that is no pull request and a compare shorter than its own total", () => {
  const refuse: Gh = () => { throw new Error("HTTP 404"); };
  assert.equal(readClosedWork(URL, refuse), null, "a refused gh");
  assert.equal(readClosedWork(URL, github("not json", "T 0")), null, "an answer that does not parse");
  assert.equal(readClosedWork(URL, github(pull({ headRefOid: null }), "T 0")), null, "no head");
  assert.equal(readClosedWork(URL, github(pull({ baseRefName: "" }), "T 0")), null, "no base");
  assert.equal(readClosedWork(URL, github(pull({ number: 15 }), "T 0")), null, "another pull request's answer");
  assert.equal(readClosedWork("https://github.com/o/r/issues/14", github(pull(), "T 0")), null, "an address that is no pull request");
  assert.equal(readClosedWork(URL, github(pull(), ["T 3", commit(FIRST, "one")].join("\n"))), null, "a page of commits the host did not give");
  assert.equal(readClosedWork(URL, github(pull(), "T many")), null, "a total that is no number");
  assert.equal(readClosedWork(URL, github(pull(), "X what")), null, "a line of no kind");
  assert.equal(readClosedWork(URL, github(pull(), "")), null, "no total at all");
});
