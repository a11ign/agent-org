// no-token: gh -- the reader and the report list are pure over (body, diff, readFile); the one spawn below runs `main()` in an empty temp directory with a body that runs nothing, so nothing reaches `gh`
/**
 * agent-org#666: THE ACCEPTANCE READER IS HANDED THE PULL REQUEST'S AUTHOR; agent-org#519: AND ONLY THE FILE-LESS CASE READS IT.
 *
 * agent-org#666 carried the value through (`PR_AUTHOR` -> `main()` -> `BodyReportInput.author` -> `resolveAcceptanceSource`) and changed no
 * verdict; agent-org#519 removed the body fallback and keyed its one exemption on it (a11ign#4811), so what is pinned is each beside its control:
 *   (a) an unset or empty `PR_AUTHOR` is `undefined` and a set one is itself, read from the environment alone;
 *   (b) the author decides the source ONLY when no file is added (the body for Dependabot, a refusal for anyone else): an added file still wins
 *       and two are still a duplicate whoever wrote them;
 *   (c) the author REACHES the reader at every link, seen through the `resolveSource` seam, so (b) cannot be passing for another reason.
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

/** An author the reader exempts from the file rule, and the ones it does not: a person, none given, and an empty one. */
const BOT = "dependabot[bot]";
const NOT_EXEMPT: (string | undefined)[] = [undefined, "", "a-person"];

test("(b) resolveAcceptanceSource: an added file and a duplicate are the same for every author; no file is the body for Dependabot and a refusal for anyone else", () => {
  const authorFree: [string, Parameters<typeof resolveAcceptanceSource>[0]][] = [
    ["one added file wins over the body", { body: BODY, added: ["src/x.ts", FILE], read }],
    ["two added files are a duplicate", { body: BODY, added: [OTHER, FILE], read }],
  ];
  for (const [name, input] of authorFree) {
    const without = resolveAcceptanceSource(input);
    for (const author of AUTHORS) assert.deepEqual(resolveAcceptanceSource({ ...input, author }), without, `${name}: author ${JSON.stringify(author)}`);
  }
  const noFile: [string, Parameters<typeof resolveAcceptanceSource>[0], "no-file" | "diff-unreadable"][] = [
    ["no added file", { body: BODY, added: ["src/x.ts"], read }, "no-file"],
    ["an unreadable diff", { body: BODY, added: undefined, read }, "diff-unreadable"],
  ];
  for (const [name, input, why] of noFile) {
    for (const author of NOT_EXEMPT) assert.deepEqual(resolveAcceptanceSource({ ...input, author }), { kind: "refused", why, author }, `${name}: author ${JSON.stringify(author)}`);
    assert.deepEqual(resolveAcceptanceSource({ ...input, author: BOT }), { kind: "body", text: BODY, why, author: BOT }, `${name}: Dependabot`);
  }
  // The controls that make "the same" mean something: the four outcomes really are four.
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE], read, author: BOT }), { kind: "file", path: FILE, text: FILE_TEXT });
  assert.deepEqual(resolveAcceptanceSource({ body: BODY, added: [FILE, OTHER], read, author: BOT }), { kind: "duplicate", paths: [FILE, OTHER] });
});

test("(b) acceptanceSourceOf: `BodyReportInput.author` reaches the reader and decides the file-less source only", () => {
  const added = { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] };
  const none = { ok: true as const, files: ["src/x.ts"], added: ["src/x.ts"] };
  const unreadable = { ok: false as const, why: "no base" };
  for (const author of AUTHORS) {
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: added, readFile: read, author }), { kind: "file", path: FILE, text: FILE_TEXT }, `file wins: ${author}`);
  }
  for (const author of NOT_EXEMPT) {
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: none, readFile: read, author }), { kind: "refused", why: "no-file", author }, `no file: ${author}`);
    assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: unreadable, readFile: read, author }), { kind: "refused", why: "diff-unreadable", author }, `unreadable: ${author}`);
  }
  assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: none, readFile: read, author: BOT }), { kind: "body", text: BODY, why: "no-file", author: BOT });
  assert.deepEqual(acceptanceSourceOf({ body: BODY, run: () => 0, diff: unreadable, readFile: read, author: BOT }), { kind: "body", text: BODY, why: "diff-unreadable", author: BOT });
});

test("(b) runCiBodyReports: the whole report is byte-for-byte the same with an author as without one", () => {
  const input = { body: BODY, run: () => 0, diff: { ok: true as const, files: ["src/x.ts", FILE], added: ["src/x.ts", FILE] }, readFile: read };
  const without = runCiBodyReports(input);
  assert.ok(without.lines.some((line) => line.includes(FILE)), "CONTROL: the report names the added file, so it read the file and not the body");
  for (const author of AUTHORS) assert.deepEqual(runCiBodyReports({ ...input, author }), without, `author ${JSON.stringify(author)}`);
});

test("(b) acceptanceSourceOfThisPullRequest takes the author as its third argument: a directory with no pull request is refused without it and read for Dependabot", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-"));
  try {
    for (const author of NOT_EXEMPT) {
      const source = acceptanceSourceOfThisPullRequest(BODY, dir, author);
      assert.equal(source.kind, "refused", `author ${JSON.stringify(author)}: a directory that is no checkout has no added file, and the body is not a source`);
    }
    assert.equal(acceptanceSourceOfThisPullRequest(BODY, dir, BOT).kind, "body", "CONTROL: the same directory, the exempt author");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("(b) the CLI entry: PR_AUTHOR unset or empty is refused and exits 1; dependabot[bot] is read and passes; a person naming it in the body is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "acceptance-author-cli-"));
  try {
    delete process.env.PR_AUTHOR; // the unset case is unset, whatever this run's own environment holds
    const job = (env: Record<string, string>, body: string = BODY) => spawnSync("node", [new URL("./acceptance-commands.ts", import.meta.url).pathname],
      { cwd: dir, encoding: "utf8", env: sandboxGitEnv({ PR_BODY: body, ...env }) });
    for (const env of [{}, { PR_AUTHOR: "" }, { PR_AUTHOR: "a-person" }] as Record<string, string>[]) {
      const refused = job(env);
      assert.match(refused.stdout, /ACCEPTANCE-SOURCE: none \(/, `${JSON.stringify(env)}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stdout, /ACCEPTANCE: MISSING/);
      assert.notEqual(refused.status, 0, `${JSON.stringify(env)}: a refused source is a red job`);
    }
    const read = job({ PR_AUTHOR: BOT });
    assert.match(read.stdout, /ACCEPTANCE-SOURCE: body \(exempt author dependabot\[bot\]/, read.stdout + read.stderr);
    assert.doesNotMatch(read.stdout, /ACCEPTANCE: MISSING/);
    assert.equal(read.status, 0, `CONTROL: the exempt author's body runs and passes: ${read.stdout}${read.stderr}`);
    // The author is the environment's, never the body's: the body names the bot and its author is someone else.
    const forged = job({ PR_AUTHOR: "a-person" }, `Author: ${BOT}\n${BODY}`);
    assert.match(forged.stdout, /ACCEPTANCE-SOURCE: none \(/, forged.stdout);
    assert.notEqual(forged.status, 0);
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
