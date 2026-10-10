// no-token: gh -- every `main` call below is handed `git`, `prHead`, `runAcceptance` and `write` as seams, so nothing reaches the real `gh`
/**
 * a11ign/a11ign#4418, ADR 0044 row 1: THE ACCEPTANCE IS READ FROM THE FILE THE PULL REQUEST ADDS UNDER `.acceptance/`, ELSE THE BODY.
 *
 * Three cases are pinned, each beside the control that makes it mean something:
 *   (a) one added file: its commands run, and the body's own (here a failing one) do not;
 *   (b) none: REFUSED, and the body is not read (agent-org#519, ADR 0044 row 3) -- unless the author is Dependabot, whose body is read;
 *   (c) two: refused as two `Acceptance:` headers in one body are, and nothing is run.
 * The body exemption's three cases (a11ign#4811, condition 3) are pinned below, each with its negative control: a non-bot author with a body
 * `Acceptance:` and no file (refused), a body that NAMES `dependabot[bot]` under someone else's authorship (refused), and a Dependabot pull
 * request with a body `Acceptance:` (read).
 * Then the writer (`pr-open` refuses a diff that adds no file, and writes it from a body that carries the sections) and the three exemptions
 * (the Region check, `ownedPaths`, B4), each with its control: an ordinary path is still counted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBody, main, standingAgainstRegion, EXIT_NOTHING_SENT } from "./pr-open.ts";
import { runCiBodyReports } from "./acceptance-commands.ts";
import { BODY_EXEMPT_AUTHORS, acceptanceFileForBranch, isAcceptancePath, isBodyExemptAuthor, resolveAcceptanceSource, sectionsTextOf, sourceLine } from "./acceptance-file.ts";
import { isOwned } from "./owned-path-signoff.ts";
import { fileOverlapReason } from "./row-claim/file-overlap-rule.ts";

const CLOSES = "Closes: none -- a test body";
const PASSING = 'node -e "process.exit(0)"';
const FAILING = 'node -e "process.exit(1)"';
const acceptanceText = (command: string) => `## Acceptance\n\n\`\`\`bash\n${command}\n\`\`\`\n`;
const FILE = ".acceptance/agent~example-1.md";
const OTHER = ".acceptance/agent~example-2.md";
/** What a runner is asked, recorded, so a test can say WHICH command ran and not only that something did. */
const recorder = () => {
  const ran: string[] = [];
  return { ran, run: (command: string) => { ran.push(command); return command === FAILING ? 1 : 0; } };
};
const diffAdding = (...added: string[]) => ({ ok: true as const, files: ["src/x.ts", ...added], added });

test("(a) one added file: ITS commands run, and a failing command in the body is not an input", () => {
  const { ran, run } = recorder();
  const body = `${acceptanceText(FAILING)}\n${CLOSES}\n`;
  const result = checkBody(body, { run, diff: diffAdding(FILE), readFile: (path: string) => (path === FILE ? acceptanceText(PASSING) : "") });
  assert.equal(result.ok, true, result.lines.join("\n"));
  assert.deepEqual(ran, [PASSING], "only the file's command ran");
  assert.ok(result.lines.includes(`ACCEPTANCE-SOURCE: file ${FILE}`), result.lines.join("\n"));
});

test("(a) control: the same file with a failing command is red, so the file's text is what the verdict reads", () => {
  const { run } = recorder();
  const result = checkBody(`${CLOSES}\n`, { run, diff: diffAdding(FILE), readFile: () => acceptanceText(FAILING) });
  assert.equal(result.ok, false);
});

test("(a) the file may hold `Mutation:`, and the record is read from it, not from the body", () => {
  const diff = { ok: true as const, files: ["src/x.test.ts", FILE], added: [FILE] };
  const file = `${acceptanceText(PASSING)}\nMutation: none -- the example only renames a fixture\n`;
  const result = checkBody(`${CLOSES}\n`, { run: () => 0, diff, readFile: () => file });
  assert.ok(result.lines.some((line) => line.startsWith("MUTATION: NONE")), result.lines.join("\n"));
});

test("(a) a file already on main that the pull request only MODIFIES is not an added file, and is never run or read", () => {
  const { ran, run } = recorder();
  const diff = { ok: true as const, files: ["src/x.ts", FILE], added: [] as string[] };
  const result = checkBody(`${acceptanceText(PASSING)}\n${CLOSES}\n`, { run, diff, readFile: () => { throw new Error("read a modified file"); } });
  assert.equal(result.ok, false, "the body's Acceptance is not read in its place (agent-org#519)");
  assert.deepEqual(ran, [], "nothing was run: not the modified file's commands and not the body's");
  assert.ok(result.lines.some((line) => line.startsWith(`${SOURCE}: none (`)), result.lines.join("\n"));
});

// ---- agent-org#519: the body is no longer a source; Dependabot's is, and only Dependabot's ----

const SOURCE = "ACCEPTANCE-SOURCE";
/** The reports CI runs, with the pull request's author (`PR_AUTHOR`) handed to the reader, as `main()` hands it. `checkBody` has no author: `pr:open` is never Dependabot. */
const ciReport = (body: string, { added = [] as string[], author, readFile = () => acceptanceText(PASSING), run }: {
  added?: string[]; author?: string; readFile?: (path: string) => string; run: (command: string) => number;
}) => runCiBodyReports({ body, run, diff: diffAdding(...added), readFile, author });
const PASSING_BODY = `${acceptanceText(PASSING)}\n${CLOSES}\n`;

test("(b) CONDITION 3a: a non-bot author with a body `Acceptance:` and no file is REFUSED, and nothing is run", () => {
  const { ran, run } = recorder();
  const result = ciReport(PASSING_BODY, { author: "a-person", run });
  assert.equal(result.ok, false, result.lines.join("\n"));
  assert.deepEqual(ran, [], "the body's command was not run");
  assert.ok(result.lines.includes(`${SOURCE}: none (this pull request adds no file under .acceptance/ and its author a-person is not exempt, so the body is not read; add .acceptance/<branch with / as ~>.md)`), result.lines.join("\n"));
  assert.ok(result.lines.includes("ACCEPTANCE: MISSING"), "the verdict is the one an absent Acceptance has always had");
  assert.ok(!result.lines.some((line) => line.includes("(deprecated")), "no line calls the body a deprecated source: it is not one");
  // NEGATIVE CONTROL: the SAME body and author, with the file added, runs: the refusal is the missing file and not the author or the body.
  const control = recorder();
  const withFile = ciReport(PASSING_BODY, { added: [FILE], author: "a-person", run: control.run });
  assert.equal(withFile.ok, true, withFile.lines.join("\n"));
  assert.deepEqual(control.ran, [PASSING]);
});

test("(b) no author given (PR_AUTHOR unset) is no exemption either: absence is not Dependabot", () => {
  const { ran, run } = recorder();
  const result = ciReport(PASSING_BODY, { run });
  assert.equal(result.ok, false, result.lines.join("\n"));
  assert.deepEqual(ran, []);
  assert.ok(result.lines.some((line) => line.includes("no author was given")), result.lines.join("\n"));
});

test("(b) CONDITION 3b: a body that NAMES dependabot[bot] but is authored by someone else is REFUSED", () => {
  // Everything a person can write that looks like Dependabot: the login in the body, its branch name, its label, its commit trailer.
  const forged = [
    "Bumps lodash from 4.17.20 to 4.17.21.", "Author: dependabot[bot]", "Branch: dependabot/npm_and_yarn/lodash-4.17.21", "Labels: dependencies",
    "Signed-off-by: dependabot[bot] <support@github.com>", "", acceptanceText(PASSING), CLOSES, ""].join("\n");
  const { ran, run } = recorder();
  const result = ciReport(forged, { author: "a-person", run });
  assert.equal(result.ok, false, result.lines.join("\n"));
  assert.deepEqual(ran, []);
  assert.match(result.lines.join("\n"), /its author a-person is not exempt/);
  // NEGATIVE CONTROL: the same text from the real author is read, so the text was not what decided it.
  const control = recorder();
  const real = ciReport(forged, { author: "dependabot[bot]", run: control.run });
  assert.equal(real.ok, true, real.lines.join("\n"));
  assert.deepEqual(control.ran, [PASSING]);
});

test("(b) CONDITION 3c: a Dependabot pull request with a body `Acceptance:` is READ, in both spellings of its login, and says whose body it read", () => {
  for (const author of ["dependabot[bot]", "app/dependabot"]) {
    const { ran, run } = recorder();
    const result = ciReport(PASSING_BODY, { author, run });
    assert.equal(result.ok, true, `${author}: ${result.lines.join("\n")}`);
    assert.deepEqual(ran, [PASSING], `${author}: the body's command ran`);
    assert.ok(result.lines.includes(`${SOURCE}: body (exempt author ${author}; this pull request adds no file under .acceptance/; agent-org#519)`), result.lines.join("\n"));
  }
  // The exempt author's own added file still WINS over its body: the exemption is a fallback and not a preference for the body.
  const { ran, run } = recorder();
  const wins = ciReport(`${acceptanceText(FAILING)}\n${CLOSES}\n`, { added: [FILE], author: "dependabot[bot]", run });
  assert.equal(wins.ok, true, wins.lines.join("\n"));
  assert.deepEqual(ran, [PASSING], "the file's command ran, and the body's failing one did not");
  assert.ok(wins.lines.includes(`${SOURCE}: file ${FILE}`));
});

test("(b) CONDITION 2: a command read from a Dependabot body meets the SAME classifier as one read from a file", () => {
  const refused = "gh pr merge 1"; // the classifier refuses it for want of a credential this job does not have
  const fromBody = recorder();
  const body = ciReport(`${acceptanceText(refused)}\n${CLOSES}\n`, { author: "dependabot[bot]", run: fromBody.run });
  const fromFile = recorder();
  const file = ciReport(`${CLOSES}\n`, { added: [FILE], readFile: () => acceptanceText(refused), author: "dependabot[bot]", run: fromFile.run });
  assert.equal(body.ok, false, body.lines.join("\n"));
  assert.deepEqual(fromBody.ran, [], "refused, not run");
  assert.deepEqual(fromFile.ran, []);
  const verdictLines = (lines: string[]) => lines.filter((line) => line.startsWith("ACCEPTANCE:"));
  assert.ok(verdictLines(body.lines).some((line) => line.startsWith("ACCEPTANCE: REFUSED gh pr merge 1")), body.lines.join("\n"));
  assert.deepEqual(verdictLines(body.lines), verdictLines(file.lines), "the verdict lines are byte-for-byte those of the file route");
});

test("(b) the exemption is the author named WHOLE: near misses are refused, and the list is one constant", () => {
  const read = () => "";
  const nearMisses = ["Dependabot[bot]", "DEPENDABOT[BOT]", "dependabot", "dependabot[bot] ", " dependabot[bot]", "dependabot[bot]x", "app/dependabot-preview",
    "app/Dependabot", "dependabot-bot", "github-actions[bot]", "a11ign-ai-workers", ""];
  for (const author of nearMisses) {
    assert.equal(isBodyExemptAuthor(author), false, JSON.stringify(author));
    assert.equal(resolveAcceptanceSource({ body: "b", added: [], read, author }).kind, "refused", JSON.stringify(author));
  }
  assert.equal(isBodyExemptAuthor(undefined), false);
  assert.deepEqual([...BODY_EXEMPT_AUTHORS], ["dependabot[bot]", "app/dependabot"], "POSITIVE CONTROL: the two spellings are the whole list; a third is a ruling");
  for (const author of BODY_EXEMPT_AUTHORS) assert.equal(resolveAcceptanceSource({ body: "b", added: [], read, author }).kind, "body", author);
});

test("(b) a diff that could not be read: refused for anyone else, SAYING the diff was unreadable, and read for Dependabot, saying so", () => {
  const { ran, run } = recorder();
  const input = { body: PASSING_BODY, run, diff: { ok: false as const, why: "git said: boom" }, readFile: () => "" };
  const refused = runCiBodyReports({ ...input, author: "a-person" });
  assert.equal(refused.ok, false);
  assert.deepEqual(ran, []);
  assert.ok(refused.lines.some((line) => /^ACCEPTANCE-SOURCE: none \(the diff could not be read, so no file added under \.acceptance\/ was found and its author a-person is not exempt/.test(line)), refused.lines.join("\n"));
  const exempt = runCiBodyReports({ ...input, author: "dependabot[bot]" });
  assert.ok(exempt.lines.some((line) => /^ACCEPTANCE-SOURCE: body \(exempt author dependabot\[bot\]; the diff could not be read/.test(line)), exempt.lines.join("\n"));
  assert.deepEqual(ran, [PASSING], "CONTROL: the exempt author's body ran, so the refusal above was the author and not the unreadable diff");
});

test("(b) a refused source has EMPTY section text, never null and never the body, so no report falls back to reading the body", () => {
  assert.equal(sectionsTextOf({ kind: "refused", why: "no-file", author: "a-person" }), "");
  assert.equal(sectionsTextOf({ kind: "duplicate", paths: [FILE, OTHER] }), null, "CONTROL: a duplicate is still null, so the two are not one value");
  assert.equal(sectionsTextOf({ kind: "body", text: "t", why: "no-file", author: "dependabot[bot]" }), "t");
  // The report that DOES fall back to the body on `null` (`Mutation:`) reads the refused source as empty, so a record in the body is not honoured.
  const withRecord = `${PASSING_BODY}\nMutation: none -- the body says so\n`;
  const input = { body: withRecord, run: () => 0, diff: { ok: true as const, files: ["src/x.test.ts"], added: [] as string[] }, readFile: () => "" };
  const refused = runCiBodyReports({ ...input, author: "a-person" });
  assert.ok(!refused.lines.some((line) => line.startsWith("MUTATION: NONE")), refused.lines.join("\n"));
  const exempt = runCiBodyReports({ ...input, author: "dependabot[bot]" });
  assert.ok(exempt.lines.some((line) => line.startsWith("MUTATION: NONE")), `CONTROL: the exempt author's body record is honoured\n${exempt.lines.join("\n")}`);
});

test("(c) two added files are refused as two `Acceptance:` headers are, and nothing runs", () => {
  const { ran, run } = recorder();
  const result = checkBody(`${CLOSES}\n`, { run, diff: diffAdding(FILE, OTHER), readFile: () => acceptanceText(PASSING) });
  assert.equal(result.ok, false);
  assert.deepEqual(ran, [], "nothing was run from either file");
  assert.ok(result.lines.some((line) => line.startsWith("ACCEPTANCE: DUPLICATE")), result.lines.join("\n"));
  // The body is read only for an exempt author (agent-org#519), so the body's own duplicate is read as Dependabot's.
  const header = ciReport(`${acceptanceText(PASSING)}\n${acceptanceText(PASSING)}\n${CLOSES}\n`, { author: "dependabot[bot]", run });
  assert.ok(header.lines.some((line) => line.startsWith("ACCEPTANCE: DUPLICATE")), "POSITIVE CONTROL: the body's own duplicate wears the same prefix");
});

test("a leak in the added file is refused before anything in it runs", () => {
  const { ran, run } = recorder();
  const leaky = `${acceptanceText(PASSING)}\nthe box is at ${["10", "20", "30", "40"].join(".")}\n`; // built at run time: the leak scan reads this file too
  const clean = checkBody(`${CLOSES}\n`, { run, diff: diffAdding(FILE), readFile: () => acceptanceText(PASSING) });
  assert.equal(clean.ok, true, "POSITIVE CONTROL: the clean file passes");
  const result = checkBody(`${CLOSES}\n`, { run, diff: diffAdding(FILE), readFile: () => leaky });
  assert.equal(result.ok, false, result.lines.join("\n"));
  assert.match(result.lines.join("\n"), /^REFUSING/);
  assert.equal(ran.length, 1, "only the clean file's run happened");
});

test("the pure reader: the file's name is the branch's with `/` as `~`, and only the first `.acceptance/` segment counts", () => {
  assert.equal(acceptanceFileForBranch("agent/foo-4415"), ".acceptance/agent~foo-4415.md");
  assert.notEqual(acceptanceFileForBranch("agent/foo--bar"), acceptanceFileForBranch("agent/foo/bar"));
  assert.ok(isAcceptancePath(FILE));
  assert.ok(!isAcceptancePath("docs/.acceptance/x.md"));
  assert.equal(resolveAcceptanceSource({ body: "b", added: [], read: () => "" }).kind, "refused");
  assert.equal(resolveAcceptanceSource({ body: "b", added: [], read: () => "", author: "dependabot[bot]" }).kind, "body");
  assert.equal(sourceLine({ kind: "body", text: "", why: "no-file", author: "dependabot[bot]" }), "ACCEPTANCE-SOURCE: body (exempt author dependabot[bot]; this pull request adds no file under .acceptance/; agent-org#519)");
});

test("the reader is importable through the declared public interface, and not only through src/", async () => {
  const specifier = "agent-org/acceptance-file";
  const viaInterface = await import(specifier);
  assert.equal(typeof viaInterface.resolveAcceptanceSource, "function");
  const viaCommands = await import("agent-org/acceptance-commands");
  assert.equal(typeof viaCommands.acceptanceSourceOfThisPullRequest, "function");
});

// ---- pr-open: refuses a diff that adds no file, and writes it from a body that carries the sections ----

const mainWith = (body: string, { added, written, mode = "create" }: { added: string[]; written: [string, string][]; mode?: "create" | "edit" }) => {
  const err: string[] = [];
  const sent: string[][] = [];
  const git = (args: string[]) => {
    if (args.includes("--abbrev-ref")) return "agent/example-1";
    if (args[0] === "diff") return (args.includes("--diff-filter=A") ? added : ["src/x.ts", ...added]).join("\0");
    return "deadbeef";
  };
  const code = main([mode, ...(mode === "edit" ? ["7"] : ["--head", "agent/example-1"]), "--body", body], {
    run: (args) => { sent.push(args); }, git, prHead: () => ({ ref: "agent/example-1", oid: "deadbeef" }), runAcceptance: () => 0, runMutation: () => 0, owner: () => null,
    write: (path, text) => { written.push([path, text]); }, readFile: () => acceptanceText(PASSING), out: () => {}, err: (line) => { err.push(line); },
  });
  return { code, err: err.join(""), sent };
};

test("pr-open: a diff that adds no file is refused, naming the file and writing it from a body that carries the Acceptance", () => {
  const written: [string, string][] = [];
  const body = `${acceptanceText(PASSING)}\n${CLOSES}\n`;
  const { code, err, sent } = mainWith(body, { added: [], written });
  assert.equal(code, EXIT_NOTHING_SENT);
  assert.deepEqual(sent, [], "nothing was sent");
  assert.match(err, /adds no file under \.acceptance\//);
  assert.deepEqual(written, [[".acceptance/agent~example-1.md", body]], "the body's own text moves unchanged: one grammar");
});

test("pr-open: a body with no Acceptance is refused too, and nothing is written from it", () => {
  const written: [string, string][] = [];
  const { code, err } = mainWith(`${CLOSES}\n`, { added: [], written });
  assert.equal(code, EXIT_NOTHING_SENT);
  assert.deepEqual(written, []);
  assert.match(err, /Create \.acceptance\/agent~example-1\.md/);
});

test("pr-open: control -- a diff that adds the file is not refused for that, and an edit sends", () => {
  const written: [string, string][] = [];
  const { code, err, sent } = mainWith(`${CLOSES}\n`, { added: [FILE], written, mode: "edit" });
  assert.equal(code, 0, err);
  assert.doesNotMatch(err, /the diff adds no file under/);
  assert.deepEqual(written, []);
  assert.ok(sent.length > 0, "POSITIVE CONTROL: it reaches `gh`");
});

test("pr-open WIRING: the shipped entry hands `main` the real writer, and `main` runs the file step before `checkBody`", () => {
  const source = readFileSync(fileURLToPath(new URL("./pr-open.ts", import.meta.url)), "utf8");
  assert.match(source, /labelExists: defaultLabelExists, write: writeAcceptanceFile \}\);/, "without it the refusal is off in the CLI, which is the only place it matters");
  const start = source.indexOf("export function main(");
  const step = source.indexOf("acceptanceFileStep(body", start);
  assert.ok(step > 0 && source.indexOf("checkBody(body", start) > step, "the file step precedes checkBody inside main()");
});

test("pr-open: with no writer wired the FILE STEP is off, so a direct caller whose git seam names no file is not refused by it (the body check still is)", () => {
  const run = (git: (args: string[]) => string) => {
    const printed: string[] = [];
    const code = main(["edit", "7", "--body", `${acceptanceText(PASSING)}\n${CLOSES}\n`], {
      run: () => {}, git, prHead: () => ({ ref: "agent/example-1", oid: "deadbeef" }), runAcceptance: () => 0, runMutation: () => 0, owner: () => null,
      readFile: () => acceptanceText(PASSING), out: (line) => { printed.push(line); }, err: (line) => { printed.push(line); },
    });
    return { code, err: printed.join("") };
  };
  const naming = (...files: string[]) => (args: string[]) => (args.includes("--abbrev-ref") ? "agent/example-1" : args[0] === "diff" ? ["src/x.ts", ...files].join("\0") : "deadbeef");
  const none = run(naming());
  assert.doesNotMatch(none.err, /REFUSED -- the diff adds no file under/, "the step is off: its message is not printed");
  assert.equal(none.code, EXIT_NOTHING_SENT, "but the body is no longer an acceptance source (agent-org#519), so the body check refuses it as it does in CI");
  assert.match(none.err, /ACCEPTANCE: MISSING/, none.err);
  // POSITIVE CONTROL: the same call over a diff that names the file is not refused at all.
  const named = run(naming(FILE));
  assert.equal(named.code, 0, named.err);
});

// ---- the exemptions ----

test("Region: `.acceptance/` is exempt by construction, and an ordinary path outside the Region is still outside", () => {
  assert.equal(standingAgainstRegion(FILE, { region: ["src/x.ts"], declared: [] }), "exempt");
  assert.equal(standingAgainstRegion("src/y.ts", { region: ["src/x.ts"], declared: [] }), "outside");
});

test("ownedPaths: an acceptance file is no owner's path even under an owned prefix, and an ordinary path still is", () => {
  assert.equal(isOwned(FILE, [".acceptance/", "docs/"]), false);
  assert.equal(isOwned("docs/x.md", [".acceptance/", "docs/"]), true);
});

test("B4: two pull requests that each add a file under `.acceptance/` do not overlap, and a shared ordinary file still does", () => {
  const other = (files: string[]) => [{ number: 9, files, changedFiles: files.length }];
  assert.equal(fileOverlapReason(["src/x.ts", FILE], other([FILE])).reason, null);
  assert.notEqual(fileOverlapReason(["src/x.ts", FILE], other([FILE, "src/x.ts"])).reason, null, "POSITIVE CONTROL: the same call still finds a real overlap");
});
