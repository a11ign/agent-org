// no-token: gh -- every read of a consumer's file is an injected function, or a fake `gh` first on PATH that answers from files; nothing here reaches GitHub
// agent-org#873 (class `closed-on-merge-not-outcome`, a11ign/a11ign#4953). THE GRAMMAR (`consumer-declaration.ts`) AND THE REFUSAL
// (`consumerDeclarationReport` in `closes-mismatch-check.ts`) THAT READS IT.
//
// agent-org#782 is the shape: a pull request that added `routing.question`, said in its acceptance file that a11ign's declaration was "not in this
// change", and closed a11ign/a11ign#4904 on merge, while a11ign's `.agent-org/project.json` held no such key. The POSITIVE CONTROL below is exactly that
// shape and must be refused; every other case is a variation of it, so a check that cannot refuse cannot pass this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConsumerDeclarations, valueAtKey, valueMatches } from "./consumer-declaration.ts";
import { consumerDeclarationReport, consumerDeclarationStep, consumerDeclarationVerdict, type ConsumerFileReader } from "./closes-mismatch-check.ts";
import { extractClosesDeclaration } from "./acceptance-commands/acceptance-report-and-closure.ts";
import { type ClosesDeclaration } from "./acceptance-commands/command-classes-and-declarations.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const LABEL = "Consumer-declaration:";
const CONSUMER = "a11ign/a11ign";
const FILE = ".agent-org/project.json";
const LINE = `${LABEL} ${CONSUMER}:${FILE} routing.question=choice`;

/** The acceptance file of agent-org#782, in the lines that matter here: the prose that let #4904 close, and the structured line that now refuses it. */
const ACCEPTANCE_782 = [
  "The engineer route is ONE choice put to Jev (a11ign#4904).",
  "",
  "- **Not in this change:** `wake.ts`, `decision-provider.ts` and a11ign's own `.agent-org/project.json` (see below).",
  LINE,
  "",
].join("\n");

const CLOSES_4904 = extractClosesDeclaration("Closes a11ign/a11ign#4904");
const NONE: ClosesDeclaration = extractClosesDeclaration("Closes: none -- the consumer's switch row closes it");

/** A reader over an in-memory consumer, recording every ask. `files` is keyed `owner/repo:path`; a missing key is a file that cannot be read. */
function reader(files: Record<string, string>): { read: ConsumerFileReader, asked: string[] } {
  const asked: string[] = [];
  return { asked, read: (repo, path) => { asked.push(`${repo}:${path}`); return files[`${repo}:${path}`] ?? null; } };
}
const WITHOUT_KEY = JSON.stringify({ schema: 1, routing: { routes: ["haiku/high"] }, github: { identity: "a11ign-ai-workers" } });
const WITH_KEY = JSON.stringify({ schema: 1, routing: { question: "choice" } });
const failedText = (report: ReturnType<typeof consumerDeclarationReport>) => (report.ok ? "" : report.reasons.join("\n"));

// --- the grammar ---

test("the grammar: one line per option, several lines, each with its own line number", () => {
  const text = ["# a heading", `${LABEL} a/b:.agent-org/project.json routing.question=choice`, "prose", `- ${LABEL} c/d:conf/x.json github.identity=a11ign-ai-workers`].join("\n");
  const parsed = parseConsumerDeclarations(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.declarations.map(({ repo, path, key, value, line }) => ({ repo, path, key, value, line })), [
    { repo: "a/b", path: ".agent-org/project.json", key: "routing.question", value: "choice", line: 2 },
    { repo: "c/d", path: "conf/x.json", key: "github.identity", value: "a11ign-ai-workers", line: 4 },
  ]);
});

test("the grammar: no line reads exactly as before, a value may hold `=`, and a mention inside prose is not a line", () => {
  assert.deepEqual(parseConsumerDeclarations("Acceptance: `node --test x`\nCloses a/b#1\n"), { declarations: [], errors: [] });
  assert.deepEqual(parseConsumerDeclarations(`The line \`${LINE}\` is how it is said.`), { declarations: [], errors: [] }, "a backticked mention is prose");
  assert.equal(parseConsumerDeclarations(`${LABEL} a/b:p.json k.j=x=y`).declarations[0]?.value, "x=y");
});

test("the grammar: `none -- <reason>` is not a declaration and not an error; `none` alone is an error; a `Closes: none` line is nobody's here", () => {
  assert.deepEqual(parseConsumerDeclarations(`${LABEL} none -- a11ign carries it already`), { declarations: [], errors: [] });
  assert.deepEqual(parseConsumerDeclarations("Closes: none -- the consumer's switch row closes it"), { declarations: [], errors: [] });
  const bare = parseConsumerDeclarations(`${LABEL} none`);
  assert.equal(bare.declarations.length, 0);
  assert.equal(bare.errors.length, 1);
  assert.equal(bare.errors[0].line, 1);
});

test("the grammar: a malformed line is an error that names the line and its text, never skipped", () => {
  const bad: [string, RegExp][] = [
    [`${LABEL} a/b:p.json routing.question`, /no `=`/],
    [`${LABEL} a/b:p.json routing.question=`, /names no value/],
    [`${LABEL} a/b.p.json k=v`, /no `:`/],
    [`${LABEL} justone:p.json k=v`, /not an `owner\/repo`/],
    [`${LABEL} a/b:../secrets.json k=v`, /not a file path/],
    [`${LABEL} a/b:/etc/passwd k=v`, /not a file path/],
    [`${LABEL} a/b:p.json?x k=v`, /not a file path/],
    [`${LABEL} a/b:p.json routing..question=v`, /not a dotted key path/],
    [`${LABEL} a/b:p.json k1 k2=v`, /one target, one space, one key/],
    [`${LABEL}`, /no `=`/],
  ];
  for (const [line, why] of bad) {
    const parsed = parseConsumerDeclarations(`first line\n${line}\n`);
    assert.deepEqual(parsed.declarations, [], line);
    assert.equal(parsed.errors.length, 1, line);
    assert.equal(parsed.errors[0].line, 2, line);
    assert.equal(parsed.errors[0].text, line.trim());
    assert.match(parsed.errors[0].reason, why, line);
  }
});

test("valueAtKey and valueMatches: absent is not null, a path through a non-object is absent, spellings are JSON's", () => {
  const json = { a: { b: "x", n: 0.7, t: true, z: null, list: [1, 2] } };
  assert.deepEqual(valueAtKey(json, "a.b"), { found: true, value: "x" });
  assert.deepEqual(valueAtKey(json, "a.z"), { found: true, value: null });
  assert.deepEqual(valueAtKey(json, "a.missing"), { found: false });
  assert.deepEqual(valueAtKey(json, "a.b.c"), { found: false }, "through a string");
  assert.deepEqual(valueAtKey(json, "a.list.0"), { found: false }, "an array is not walked by index");
  assert.deepEqual(valueAtKey(json, "a.constructor"), { found: false }, "an inherited name is not a key the file wrote");
  assert.ok(valueMatches("x", "x"));
  assert.ok(valueMatches(0.7, "0.7") && valueMatches(true, "true") && valueMatches(null, "null") && valueMatches([1, 2], "[1,2]"));
  assert.ok(!valueMatches("x", "y") && !valueMatches(0.7, "0.70") && !valueMatches(undefined, "undefined"));
});

// --- the refusal ---

test("POSITIVE CONTROL: the exact shape of agent-org#782 -- a `routing.question=choice` line, `Closes a11ign/a11ign#4904`, the consumer's file without the key -- is REFUSED", () => {
  const { read } = reader({ [`${CONSUMER}:${FILE}`]: WITHOUT_KEY });
  const report = consumerDeclarationReport(CLOSES_4904, ACCEPTANCE_782, read);
  assert.equal(report.ok, false, "a check that cannot refuse is the defect this row exists to remove");
  const text = failedText(report);
  assert.match(text, /a11ign\/a11ign:\.agent-org\/project\.json/, "names the file");
  assert.match(text, /`routing\.question`/, "names the key");
  assert.match(text, /\(absent\)/, "says what it holds now");
  assert.match(text, /`choice`/, "and what it must hold");
  const verdict = consumerDeclarationVerdict(report);
  assert.equal(verdict?.exit, 1);
  const printed = verdict?.lines.join("\n") ?? "";
  assert.match(printed, /\(a\) write `Closes: none -- <reason>`/);
  assert.match(printed, /\(b\) land the consumer's declaration first/);
});

test("the refusal names what the key holds when it holds another value", () => {
  const { read } = reader({ [`${CONSUMER}:${FILE}`]: JSON.stringify({ routing: { question: "traits" } }) });
  const text = failedText(consumerDeclarationReport(CLOSES_4904, ACCEPTANCE_782, read));
  assert.match(text, /`routing\.question` = "traits" and must hold `choice`/);
});

test("it PASSES with no line: asked nothing of the consumer, and the verdict has nothing to say", () => {
  const { read, asked } = reader({});
  const report = consumerDeclarationReport(CLOSES_4904, "The engineer route is ONE choice.\n\nCloses a11ign/a11ign#4904\n", read);
  assert.deepEqual(report, { ok: true, note: null });
  assert.equal(consumerDeclarationVerdict(report), null);
  assert.deepEqual(asked, []);
});

test("it PASSES when the key already holds the value, having read the file once", () => {
  const { read, asked } = reader({ [`${CONSUMER}:${FILE}`]: WITH_KEY });
  const text = `${LINE}\n${LABEL} ${CONSUMER}:${FILE} schema=1\n`;
  const report = consumerDeclarationReport(CLOSES_4904, text, read);
  assert.equal(report.ok, true);
  assert.deepEqual(asked, [`${CONSUMER}:${FILE}`], "two lines naming one file are one read");
});

test("it PASSES `Closes: none -- <reason>` with a line, and does not read the consumer (the directing row stays open)", () => {
  const { read, asked } = reader({ [`${CONSUMER}:${FILE}`]: WITHOUT_KEY });
  const report = consumerDeclarationReport(NONE, ACCEPTANCE_782, read);
  assert.equal(report.ok, true);
  assert.match(report.ok ? report.note ?? "" : "", /closes no row/);
  assert.deepEqual(asked, []);
});

test("a malformed line is still named when the PR closes nothing, and REFUSES when it closes a row", () => {
  const text = `${LABEL} a/b:p.json routing.question\n`;
  const none = consumerDeclarationReport(NONE, text, reader({}).read);
  assert.equal(none.ok, true);
  assert.match(none.ok ? none.note ?? "" : "", /line 1/);
  const closing = consumerDeclarationReport(CLOSES_4904, text, reader({}).read);
  assert.equal(closing.ok, false);
  assert.match(failedText(closing), /line 1 `.*routing\.question` is not a Consumer-declaration: line/);
});

test("a file that cannot be READ, or is not JSON, is a refusal naming that, never a pass", () => {
  const unread = consumerDeclarationReport(CLOSES_4904, ACCEPTANCE_782, reader({}).read);
  assert.equal(unread.ok, false);
  assert.match(failedText(unread), /could not READ a11ign\/a11ign:\.agent-org\/project\.json/);
  const notJson = consumerDeclarationReport(CLOSES_4904, ACCEPTANCE_782, reader({ [`${CONSUMER}:${FILE}`]: "<html>" }).read);
  assert.equal(notJson.ok, false);
  assert.match(failedText(notJson), /is not JSON/);
});

test("one satisfied declaration does not excuse another: each unmet key is its own reason", () => {
  const { read } = reader({ [`${CONSUMER}:${FILE}`]: WITH_KEY });
  const text = `${LINE}\n${LABEL} ${CONSUMER}:${FILE} github.identity=a11ign-ai-workers\n`;
  const report = consumerDeclarationReport(CLOSES_4904, text, read);
  assert.equal(report.ok, false);
  assert.equal(report.ok === false ? report.reasons.length : 0, 1);
  assert.match(failedText(report), /line 2.*`github\.identity` \(absent\)/);
});

// --- the step, and the CLI against a fake `gh` ---

test("the step: a source with no text is skipped and says why; it is never read as a PR that declares nothing", () => {
  const skipped = consumerDeclarationStep(CLOSES_4904, () => ({ text: null, named: "ACCEPTANCE-SOURCE: none (no file)" }), reader({}).read);
  assert.equal(skipped?.exit, 0);
  assert.match(skipped?.lines.join("\n") ?? "", /skipped the consumer-declaration comparison -- ACCEPTANCE-SOURCE: none/);
  const refused = consumerDeclarationStep(CLOSES_4904, () => ({ text: ACCEPTANCE_782, named: "ACCEPTANCE-SOURCE: file x" }), reader({ [`${CONSUMER}:${FILE}`]: WITHOUT_KEY }).read);
  assert.equal(refused?.exit, 1);
});

const CHECK_CLI = fileURLToPath(new URL("./closes-mismatch-check.ts", import.meta.url));

/**
 * The CLI as CI runs it, with a fake `gh` first on PATH. The author is Dependabot's, so the body is the acceptance source (no `.acceptance/` file is
 * added in a directory that is no git repository): the declaration line travels in the body, and the consumer's file is answered from `consumerFile`
 * or fails when it is `null`.
 */
function runCli(body: string, consumerFile: string | null, author = "dependabot[bot]") {
  const dir = tmpDir("consumer-declaration-");
  const fake = join(dir, "gh");
  writeFileSync(join(dir, "consumer.json"), consumerFile ?? "");
  writeFileSync(fake, `#!/bin/sh
case "$*" in
  *contents/*) [ "${consumerFile === null}" = true ] && exit 1; cat "${dir}/consumer.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [CHECK_CLI, "4999"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PR_BODY: body, PR_AUTHOR: author },
  });
  return { status: result.status, out: result.stdout };
}

test("CLI: agent-org#782's shape exits 1 with the file, the key and both ways out, and asks for the one file", () => {
  const { status, out } = runCli(`Closes a11ign/a11ign#4904\n\n${LINE}\n`, WITHOUT_KEY);
  assert.equal(status, 1, out);
  assert.match(out, /^CLOSES MISMATCH: REFUSED -- this PR says a consumer's declaration must carry a value/);
  assert.match(out, /a11ign\/a11ign:\.agent-org\/project\.json has no `routing\.question` \(absent\)/);
  assert.match(out, /\(b\) land the consumer's declaration first/);
});

test("CLI: a file that cannot be read exits 1 naming that", () => {
  const { status, out } = runCli(`Closes a11ign/a11ign#4904\n\n${LINE}\n`, null);
  assert.equal(status, 1, out);
  assert.match(out, /could not READ a11ign\/a11ign:\.agent-org\/project\.json/);
});

test("CLI: an author whose body is no source has its comparison skipped and named, never read as declaring nothing", () => {
  const { out } = runCli(`Closes a11ign/a11ign#4904\n\n${LINE}\n`, WITHOUT_KEY, "someone-else");
  assert.match(out, /skipped the consumer-declaration comparison -- ACCEPTANCE-SOURCE: none/);
  assert.doesNotMatch(out, /REFUSED -- this PR says a consumer's declaration/);
});
