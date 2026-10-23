/**
 * A11-127: CI's `closes` REPORT READS A TICKET-MODE PULL REQUEST'S DECLARATION.
 *
 * a11ign/a11ign#5713 (`Refs A11-126`) failed `acceptance` on `CLOSES: MISSING`, and a body that wrote `Closes A11-127` read `CLOSES: MALFORMED`:
 * CI's report knew only `Closes #N`, `Closes owner/repo#N` and `Closes: none -- <reason>`, the old org's GitHub rows, while ticket-mode `pr:open` holds a body to
 * `Closes <KEY>` (or `Refs <KEY>` and a `Partial:` line) and refuses `Closes: none`. No ticket-mode body could pass both. The report now reads a ticket's declaration
 * with `pr:open`'s own grammar (`ticket-references.ts`), and `extractClosesDeclaration`, which the readers that close or compare GitHub rows branch on, is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CI_BODY_REPORTS, ciClosesReport, closesDeclarationReport, extractClosesDeclaration } from "../acceptance-commands/acceptance-report-and-closure.ts";
import { DEFAULT_KEYWORDS } from "../plugins/contracts/tracker.ts";
import { ticketClosesReport } from "../ticket-mode/ticket-references.ts";

test("A11-127: `Closes A11-127` passes, and the line says the closing keyword completes the ticket", () => {
  assert.deepEqual(ciClosesReport("Closes A11-127\n"), { ok: true, line: "CLOSES: A11-127 -- `Closes` completes it when the pull request merges" });
});

test("A11-127: `Refs A11-127` with a `Partial:` line passes, and the line says the pull request is partial", () => {
  const report = ciClosesReport("Refs A11-127\nPartial: step 2 of 3, lab\n");
  assert.equal(report.ok, true, report.line);
  assert.match(report.line, /^CLOSES: A11-127 -- `Refs` links it and does not complete it: the pull request is partial, and step 2 of 3, lab remains$/);
});

test("A11-127: `Refs A11-127` alone is refused, naming the missing `Partial:` line (a link that completes nothing and says so nowhere)", () => {
  const report = ciClosesReport("Refs A11-127\n");
  assert.equal(report.ok, false);
  assert.match(report.line, /^CLOSES: REFUSED -- `Refs A11-127` links the ticket and does not complete it, and the body has no `Partial:` line/);
});

test("A11-127: `Closes A11-127` with a `Partial:` line is refused, as `pr:open` refuses it", () => {
  const report = ciClosesReport("Closes A11-127\nPartial: step 1 of 3\n");
  assert.equal(report.ok, false);
  assert.match(report.line, /^CLOSES: REFUSED -- `Closes A11-127` completes the ticket when the pull request merges, but the body also has a `Partial:` line/);
});

test("A11-127: the bodies that named a GitHub row, or none, read exactly as before", () => {
  const bodies = ["Closes #471", "Closes #510\nCloses #497", "Closes a11ign/a11ign#5080", "Closes: none — this is a docs-only change", "Closes: none",
    "Closes: none\nRefs A11-1\nPartial: step 1 of 2", "Closes", "Closes soon", "nothing declared", "Refs #5\nPartial: the rest", ""];
  for (const body of bodies) assert.deepEqual(ciClosesReport(body), closesDeclarationReport(body), JSON.stringify(body));
  assert.equal(ciClosesReport("Closes #471").line, "CLOSES: #471");
  assert.match(ciClosesReport("Closes: none — docs").line, /^CLOSES: NONE -> docs$/);
  assert.match(ciClosesReport("nothing declared").line, /^CLOSES: MISSING -- no `Closes #N` or `Closes: none/);
  assert.match(ciClosesReport("Closes").line, /^CLOSES: MALFORMED/);
});

test("A11-127: a row beside a ticket still passes as the row it is, and a null body is MISSING", () => {
  assert.deepEqual(ciClosesReport("Closes #471\nRefs A11-1\n"), closesDeclarationReport("Closes #471\nRefs A11-1\n"));
  assert.equal(ciClosesReport(null).line, closesDeclarationReport(null).line);
  assert.equal(ciClosesReport(undefined).ok, false);
});

test("A11-127: CI's report and `pr:open`'s are one grammar -- they agree on every body, for the ticket the body names", () => {
  const bodies = ["Closes A11-127", "Closes A11-127 -- done", "**Closes** A11-127", "- Closes A11-127", "Refs A11-127\nPartial: step 1 of 3", "Refs A11-127\nPartial: <what remains>",
    "Refs A11-127\nPartial:", "Refs A11-127", "Closes A11-127\nPartial: x", "Closes A11-127\nRefs A11-9", "Closes A11-127, A11-9", "Closes (A11-127)."];
  for (const body of bodies) {
    const ci = ciClosesReport(body);
    const ticket = ticketClosesReport(body, "A11-127", DEFAULT_KEYWORDS);
    assert.deepEqual({ ok: ci.ok, line: ci.line }, { ok: ticket.ok, line: ticket.lines.join(" ") }, JSON.stringify(body));
  }
});

test("A11-127: the ticket is the one the closing keyword names, else the first the non-closing keyword does; another ticket's `Closes` is still refused", () => {
  assert.equal(ciClosesReport("Refs A11-9\nCloses A11-127\n").ok, true, "A11-127 is closed, and A11-9 is only linked");
  assert.match(ciClosesReport("Refs A11-9\nCloses A11-127\n").line, /^CLOSES: A11-127 /);
  assert.match(ciClosesReport("Refs A11-9\nRefs A11-127\nPartial: step 1 of 2\n").line, /^CLOSES: A11-9 /);
  const two = ciClosesReport("Closes A11-127, A11-128\n");
  assert.equal(two.ok, false, "one pull request completes one ticket");
  assert.match(two.line, /names a ticket other than A11-127/);
});

test("A11-127: a name that is not a ticket's key is no ticket (a word, a bare number, a row's #N, a hyphenated word in prose)", () => {
  for (const body of ["Closes soon", "Closes 127", "Refs #127\nPartial: the rest", "Closes #127x", "Closes owner/repo#127", "Closes the SHA-256 bug", "Closes the gap in UTF-8 handling"]) {
    assert.deepEqual(ciClosesReport(body), closesDeclarationReport(body), JSON.stringify(body));
  }
});

test("A11-127: a row that was tried and got wrong is not read past by a `Refs <ticket>` and `Partial:` beside it", () => {
  for (const body of ["Closes a11ign/a11ign#5, owner#8\nRefs A11-1\nPartial: later", "Closes owner#5\nCloses A11-7", "Closes A11-7\nCloses owner#5", "Refs A11-1\nCloses a11ign/a11ign#5, owner#8\nPartial: later", "Closes: none\nRefs A11-1\nPartial: later"]) {
    const report = ciClosesReport(body);
    assert.equal(report.ok, false, JSON.stringify(body));
    assert.deepEqual(report, closesDeclarationReport(body), JSON.stringify(body));
  }
});

test("A11-127: `extractClosesDeclaration` is NOT changed -- the readers of GitHub rows still see a ticket's name as no row", () => {
  assert.deepEqual(extractClosesDeclaration("Closes A11-127"), { kind: "malformed", detail: "mentions \"Closes\" but names no `#<number>` and no `none — <reason>` opt-out" });
  assert.deepEqual(extractClosesDeclaration("Refs A11-127\nPartial: step 1 of 3"), { kind: "missing" });
  assert.equal(closesDeclarationReport("Closes A11-127").ok, false, "and so does the row report");
});

test("A11-127: the `closes` entry CI's acceptance job runs is this report", () => {
  const closes = CI_BODY_REPORTS.find((report) => report.name === "closes");
  assert.ok(closes, "CI_BODY_REPORTS has a closes report");
  const input = (body: string) => ({ body, run: () => 0, diff: { ok: false as const, why: "not read" }, author: "worker" });
  assert.equal(closes.report(input("Closes A11-127")).ok, true);
  assert.equal(closes.report(input("Refs A11-127")).ok, false);
  assert.equal(closes.report(input("Closes #471")).ok, true);
});

test("A11-178: CI refuses a partial body that quotes a closing word next to its own ticket's key, as a11ign/agent-org#1827 did, and one that names another ticket after one", () => {
  const quoting = ciClosesReport("Refs A11-127\n\nPartial: step 1 of 3\n\nThe tests read the grammar: `Closes A11-127` completes the ticket.\n");
  assert.equal(quoting.ok, false);
  assert.match(quoting.line, /^CLOSES: REFUSED -- the body has a `Partial:` line, but line `The tests read the grammar: `Closes A11-127` completes the ticket\.` reads as a closing word followed by A11-127/);
  const other = ciClosesReport("Closes A11-127\n\nIt also resolves A11-9.\n");
  assert.equal(other.ok, false);
  assert.match(other.line, /reads as a closing word followed by A11-9, which is not A11-127/);
  assert.deepEqual(ciClosesReport("Refs A11-127\n\nPartial: step 1 of 3\n\nThe closing keyword followed by the key is read.\n"), ciClosesReport("Refs A11-127\nPartial: step 1 of 3\n"), "described in words, it is as a plain partial body");
});

test("A11-178: CI and `pr:open` agree on bodies that carry a closing word anywhere", () => {
  const bodies = ["Refs A11-127\nPartial: x\n`Closes A11-127`", "Closes A11-127\nand fixes A11-9", "Refs A11-127\nPartial: x\nimplements A11-127", "Closes A11-127\nIt fixes the UTF-8 bug."];
  for (const body of bodies) {
    const ci = ciClosesReport(body);
    const ticket = ticketClosesReport(body, "A11-127", DEFAULT_KEYWORDS);
    assert.deepEqual({ ok: ci.ok, line: ci.line }, { ok: ticket.ok, line: ticket.lines.join(" ") }, JSON.stringify(body));
  }
});
