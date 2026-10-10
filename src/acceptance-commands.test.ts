// no-token: gh -- the reader and the report list are pure over (body, diff, readFile); the one spawn below runs `main()` in an empty temp directory with a body that runs nothing, so nothing reaches `gh`
/**
 * agent-org#666: THE ACCEPTANCE READER IS HANDED THE PULL REQUEST'S AUTHOR AND CHANGES NO VERDICT BY IT.
 *
 * agent-org#519 builds a narrow exemption keyed on the author (a11ign#4811) and needs the value at the reader; this row only carries it through
 * (`PR_AUTHOR` -> `main()` -> `BodyReportInput.author` -> `resolveAcceptanceSource`), so two things are pinned, each beside its control:
 *   (a) an unset or empty `PR_AUTHOR` is `undefined` and a set one is itself, read from the environment alone;
 *   (b) every existing verdict is the same with an author, with an empty one and with none: the body fallback still reads, the added file still wins;
 *   (c) the author REACHES the reader at every link, seen through the `resolveSource` seam, because (b) cannot see it: the reader ignores it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptanceSourceOf, acceptanceSourceOfThisPullRequest, ciInputOf, prAuthorFromEnv, runCiBodyReports, thisPullRequestInput } from "./acceptance-commands.ts";
import { resolveAcceptanceSource } from "./acceptance-file.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";

const FILE = ".acceptance/agent~example-666.md";
const OTHER = ".acceptance/agent~example-667.md";
const FILE_TEXT = "## Acceptance\n\n```bash\nnode -e \"process.exit(0)\"\n```\n";
const BODY = "Acceptance: none — the body's own\n\nCloses: none — a test body\n";
const read = (path: string) => (path === FILE ? FILE_TEXT : "");
/** `undefined` is the control: no author is what every caller passed before this row. */
const AUTHORS: (string | undefined)[] = [undefined, "", "dependabot[bot]", "a-person"];

test("(a) PR_AUTHOR: unset and empty are `undefined`, a set one is itself, and nothing else in the environment is read as the author", () => {
  assert.equal(prAuthorFromEnv({}), undefined, "unset");
  assert.equal(prAuthorFromEnv({ PR_AUTHOR: "" }), undefined, "empty is not an author named the empty string");
  assert.equal(prAuthorFromEnv({ PR_AUTHOR: "dependabot[bot]" }), "dependabot[bot]", "POSITIVE CONTROL: a set value comes through whole");
  assert.equal(prAuthorFromEnv({ PR_BODY: "Author: dependabot[bot]", GITHUB_ACTOR: "dependabot[bot]", GITHUB_HEAD_REF: "dependabot/npm/x" }), undefined,
    "the body, the actor and the branch name are the author's to write and are never the author");
});

test("(b) resolveAcceptanceSource: the same source with an author, an empty one and none, for each of its four outcomes", () => {
  const cases: [string, Parameters<typeof resolveAcceptanceSource>[0]][] = [
    ["no added file reads the body", { body: BODY, added: ["src/x.ts"], read }],
    ["an unreadable diff reads the body", { body: BODY, added: undefined, read }],
    ["one added file wins over the body", { body: BODY, added: ["src/x.ts", FILE], read }],
    ["two added files are a duplicate", { body: BODY, added: [OTHER, FILE], read }],
  ];
  for (const [name, input] of cases) {
    const without = resolveAcceptanceSource(input);
    for (const author of AUTHORS) assert.deepEqual(resolveAcceptanceSource({ ...input, author }), without, `${name}: author ${JSON.stringify(author)}`);
  }
  // The controls that make "unchanged" mean something: the four outcomes really are four.
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [], read, author: "dependabot[bot]" }), { kind: "body", text: BODY, why: "no-file" });
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: undefined, read, author: "dependabot[bot]" }), { kind: "body", text: BODY, why: "diff-unreadable" });
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE], read, author: "dependabot[bot]" }), { kind: "file", path: FILE, text: FILE_TEXT });
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE, OTHER], read, author: "dependabot[bot]" }), { kind: "duplicate", paths: [FILE, OTHER] });
});

test("(b) acceptanceSourceOf: `BodyReportInput.author` reaches the reader and the same source comes out", () => {
  const added = { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] };
  const none = { ok: true as const, files: ["src/x.ts"], added: ["src/x.ts"] };
  const unreadable = { ok: false as const, why: "no base" };
  for (const author of AUTHORS) {
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: added, readFile: read, author }), { kind: "file", path: FILE, text: FILE_TEXT }, `file wins: ${author}`);
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: none, readFile: read, author }), { kind: "body", text: BODY, why: "no-file" }, `body fallback: ${author}`);
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: unreadable, readFile: read, author }), { kind: "body", text: BODY, why: "diff-unreadable" }, `unreadable: ${author}`);
  }
});

test("(b) runCiBodyReports: the whole report is byte-for-byte the same with an author as without one", () => {
  const input = { body: BODY, run: () => 0, diff: { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] }, readFile: read };
  const without = runCiBodyReports(input);
  assert.ok(without.lines.some((line) => line.includes(FILE)), "CONTROL: the report names the added file, so it read the file and not the body");
  for (const author of AUTHORS) assert.deepEqual(runCiBodyReports({ ...input, author }), without, `author ${JSON.stringify(author)}`);
});

test("(b) acceptanceSourceOfThisPullRequest takes the author as its third argument, and a directory with no pull request reads the body with or without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-"));
  try {
    const without = acceptanceSourceOfThisPullRequest(BODY, dir);
    assert.equal(without.kind, "body", "CONTROL: a directory that is no checkout has no added file to read");
    for (const author of AUTHORS) assert.deepEqual(acceptanceSourceOfThisPullRequest(BODY, dir, author), without, `author ${JSON.stringify(author)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(b) the CLI entry: PR_AUTHOR set, empty or unset prints the same lines and exits the same", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-cli-"));
  try {
    delete process.env.PR_AUTHOR; // the unset case is unset, whatever this run's own environment holds
    const job = (env: Record<string, string>) => spawnSync("node", [new URL("./acceptance-commands.ts", import.meta.url).pathname],
      { cwd: dir, encoding: "utf8", env: sandboxGitEnv({ PR_BODY: BODY, ...env }) });
    const without = job({});
    assert.match(without.stdout, /ACCEPTANCE-SOURCE: body \(deprecated/, without.stdout + without.stderr);
    for (const PR_AUTHOR of ["", "dependabot[bot]"]) {
      const withAuthor = job({ PR_AUTHOR });
      assert.equal(withAuthor.status, without.status, `PR_AUTHOR=${JSON.stringify(PR_AUTHOR)}: ${withAuthor.stdout}${withAuthor.stderr}`);
      assert.equal(withAuthor.stdout, without.stdout);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A reader that answers as the real one does and records the input it was handed. */
const spyReader = () => {
  const seen: Parameters<typeof resolveAcceptanceSource>[0][] = [];
  const resolveSource: typeof resolveAcceptanceSource = (input) => { seen.push(input); return resolveAcceptanceSource(input); };
  return { seen, resolveSource };
};
const NO_FILE = { ok: true as const, files: ["src/x.ts"], added: ["src/x.ts"] };

test("(c) acceptanceSourceOf hands the reader the author it was given, and `undefined` when it was given none", () => {
  const given = spyReader();
  acceptanceSourceOf({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, author: "dependabot[bot]", resolveSource: given.resolveSource });
  assert.deepEqual(given.seen.map((input) => input.author), ["dependabot[bot]"]);
  const none = spyReader();
  acceptanceSourceOf({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, resolveSource: none.resolveSource });
  assert.equal(none.seen.length, 1, "CONTROL: the reader was called, so `undefined` below is what it was handed and not a call that never happened");
  assert.equal(none.seen[0].author, undefined);
});

test("(c) runCiBodyReports reads the source once and the reader is handed the author", () => {
  const spy = spyReader();
  runCiBodyReports({ body: BODY, run: () => 0, diff: NO_FILE, readFile: read, author: "a-person", resolveSource: spy.resolveSource });
  assert.ok(spy.seen.length >= 1, "the reader ran");
  assert.ok(spy.seen.every((input) => input.author === "a-person"), JSON.stringify(spy.seen.map((input) => input.author)));
});

test("(c) acceptanceSourceOfThisPullRequest and the CLI's own input carry the author: from the third argument, from PR_AUTHOR alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-input-"));
  try {
    const viaArgument = spyReader();
    acceptanceSourceOfThisPullRequest(BODY, dir, "dependabot[bot]", { resolveSource: viaArgument.resolveSource });
    assert.deepEqual(viaArgument.seen.map((input) => input.author), ["dependabot[bot]"]);
    assert.equal(thisPullRequestInput(BODY, dir, "a-person").author, "a-person");

    const fromEnv = ciInputOf({ PR_BODY: BODY, PR_AUTHOR: "dependabot[bot]" }, dir);
    assert.equal(fromEnv.author, "dependabot[bot]");
    assert.equal(fromEnv.body, BODY, "CONTROL: it is the CLI's input, with the body from PR_BODY");
    assert.equal(ciInputOf({ PR_BODY: BODY }, dir).author, undefined, "unset reaches the reader as undefined");
    assert.equal(ciInputOf({ PR_BODY: BODY, PR_AUTHOR: "" }, dir).author, undefined, "empty reaches the reader as undefined, not as \"\"");
    assert.equal(ciInputOf({ PR_BODY: `Author: dependabot[bot]\n${BODY}`, GITHUB_ACTOR: "dependabot[bot]" }, dir).author, undefined, "never the body or the actor");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
