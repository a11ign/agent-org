// no-token: gh -- every `main` call below is handed `git`, `prHead`, `runAcceptance` and `write` as seams, so nothing reaches the real `gh`
/**
 * a11ign/a11ign#4418, ADR 0044 row 1: THE ACCEPTANCE IS READ FROM THE FILE THE PULL REQUEST ADDS UNDER `.acceptance/`, ELSE THE BODY.
 *
 * Three cases are pinned, each beside the control that makes it mean something:
 *   (a) one added file: its commands run, and the body's own (here a failing one) do not;
 *   (b) none: the body is read and `ACCEPTANCE-SOURCE: body (deprecated)` is printed;
 *   (c) two: refused as two `Acceptance:` headers in one body are, and nothing is run.
 * Then the writer (`pr-open` refuses a diff that adds no file, and writes it from a body that carries the sections) and the three exemptions
 * (the Region check, `ownedPaths`, B4), each with its control: an ordinary path is still counted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBody, main, standingAgainstRegion, EXIT_NOTHING_SENT } from "./pr-open.ts";
import { acceptanceFileForBranch, isAcceptancePath, resolveAcceptanceSource, sourceLine } from "./acceptance-file.ts";
import { isOwned } from "./owned-path-signoff.ts";
import { fileOverlapReason } from "./row-claim/file-overlap-rule.mjs";

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

test("(a) a file already on main that the pull request only MODIFIES is not an added file, and is never run", () => {
  const { ran, run } = recorder();
  const diff = { ok: true as const, files: ["src/x.ts", FILE], added: [] as string[] };
  const result = checkBody(`${acceptanceText(PASSING)}\n${CLOSES}\n`, { run, diff, readFile: () => { throw new Error("read a modified file"); } });
  assert.equal(result.ok, true, result.lines.join("\n"));
  assert.deepEqual(ran, [PASSING]);
  assert.ok(result.lines.includes("ACCEPTANCE-SOURCE: body (deprecated)"));
});

test("(b) none added: the body is read, and the source line says it is the deprecated one", () => {
  const { ran, run } = recorder();
  const result = checkBody(`${acceptanceText(PASSING)}\n${CLOSES}\n`, { run, diff: diffAdding() });
  assert.equal(result.ok, true, result.lines.join("\n"));
  assert.deepEqual(ran, [PASSING]);
  assert.ok(result.lines.includes("ACCEPTANCE-SOURCE: body (deprecated)"), result.lines.join("\n"));
});

test("(b) a diff that could not be read falls back to the body and SAYS the diff was unreadable, never 'no file'", () => {
  const result = checkBody(`${acceptanceText(PASSING)}\n${CLOSES}\n`, { run: () => 0, diff: { ok: false, why: "git said: boom" } });
  assert.ok(result.lines.some((line) => /^ACCEPTANCE-SOURCE: body \(deprecated; the diff could not be read/.test(line)), result.lines.join("\n"));
});

test("(c) two added files are refused as two `Acceptance:` headers are, and nothing runs", () => {
  const { ran, run } = recorder();
  const result = checkBody(`${CLOSES}\n`, { run, diff: diffAdding(FILE, OTHER), readFile: () => acceptanceText(PASSING) });
  assert.equal(result.ok, false);
  assert.deepEqual(ran, [], "nothing was run from either file");
  assert.ok(result.lines.some((line) => line.startsWith("ACCEPTANCE: DUPLICATE")), result.lines.join("\n"));
  const header = checkBody(`${acceptanceText(PASSING)}\n${acceptanceText(PASSING)}\n${CLOSES}\n`, { run, diff: diffAdding() });
  assert.ok(header.lines.some((line) => line.startsWith("ACCEPTANCE: DUPLICATE")), "POSITIVE CONTROL: the body's own duplicate wears the same prefix");
});

test("a leak in the added file is refused before anything in it runs", () => {
  const { ran, run } = recorder();
  const leaky = acceptanceText(PASSING) + "\nthe box is at 10.20.30.40\n";
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
  assert.equal(resolveAcceptanceSource({ body: "b", added: [], read: () => "" }).kind, "body");
  assert.equal(sourceLine({ kind: "body", text: "", why: "no-file" }), "ACCEPTANCE-SOURCE: body (deprecated)");
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
  assert.doesNotMatch(err, /adds no file under/);
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

test("pr-open: with no writer wired the step is off, so a direct caller whose git seam names no file is not refused for it", () => {
  const err: string[] = [];
  const code = main(["edit", "7", "--body", `${acceptanceText(PASSING)}\n${CLOSES}\n`], {
    run: () => {}, git: (args) => (args.includes("--abbrev-ref") ? "agent/example-1" : args[0] === "diff" ? "src/x.ts" : "deadbeef"),
    prHead: () => ({ ref: "agent/example-1", oid: "deadbeef" }), runAcceptance: () => 0, runMutation: () => 0, owner: () => null,
    out: () => {}, err: (line) => { err.push(line); },
  });
  assert.equal(code, 0, err.join(""));
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
