/**
 * #735: the FILING-side twin of #707's claim-side gate -- `scripts/row-file.mjs` refuses to run
 * `gh issue create` when the body it would file is missing Region, Acceptance or Open-check, using the
 * SAME rule `row-claim` already enforces at claim time (`missingTemplateFields`, imported unchanged from
 * `row-claim/template-fields-rule.mjs`), asked one step earlier so the cost lands on whoever holds the
 * context rather than whoever claims the row later.
 *
 * #771: it also REQUIRES `--session=<name>` (the same flag `row-claim.mjs` uses) and writes
 * `Filed-by: <session>` into the body that actually reaches `gh` -- see `row-claim.mjs`'s `filedByLine`
 * for the read side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyFromArgv, fileRefusalReason, createIssue, sessionFromArgv, appendFiledBy, withFiledBy,
} from "../../../../scripts/row-file.mjs";
import { filedByLine } from "../../../../scripts/row-claim.mjs";

const CLI = fileURLToPath(new URL("../../../../scripts/row-file.mjs", import.meta.url));

const COMPLETE_BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";

// --- bodyFromArgv: reading exactly the shape `gh issue create` itself would ---

test("bodyFromArgv: --body VALUE (two separate argv entries)", () => {
  assert.equal(bodyFromArgv(["--title", "x", "--body", "hello"]), "hello");
});

test("bodyFromArgv: --body=VALUE (one argv entry)", () => {
  assert.equal(bodyFromArgv(["--title=x", "--body=hello"]), "hello");
});

test("bodyFromArgv: --body-file PATH reads the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-file-test-"));
  try {
    const path = join(dir, "body.md");
    writeFileSync(path, "file contents\n");
    assert.equal(bodyFromArgv(["--body-file", path]), "file contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bodyFromArgv: --body-file=PATH reads the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "row-file-test-"));
  try {
    const path = join(dir, "body.md");
    writeFileSync(path, "file contents\n");
    assert.equal(bodyFromArgv([`--body-file=${path}`]), "file contents\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bodyFromArgv: --body-file - (gh's own stdin convention) reads as null, not a literal filename", () => {
  assert.equal(bodyFromArgv(["--body-file", "-"]), null);
  assert.equal(bodyFromArgv(["--body-file=-"]), null);
});

test("bodyFromArgv: neither flag present is null", () => {
  assert.equal(bodyFromArgv(["--title", "x", "--label", "backlog"]), null);
});

// --- fileRefusalReason: THE VERDICT, PURE ---

test("MUTATION TARGET: a body missing all three is refused, naming all three", () => {
  const reason = fileRefusalReason("just some prose, no headings at all");
  assert.ok(reason);
  assert.match(reason as string, /Region/);
  assert.match(reason as string, /Acceptance/);
  assert.match(reason as string, /Open-check/);
});

test("a body with only Open-check missing is refused, naming exactly that field", () => {
  const body = "## Region\n\nfoo\n\n## Acceptance\n\nbar\n";
  const reason = fileRefusalReason(body);
  assert.ok(reason);
  assert.match(reason as string, /Open-check/);
  assert.doesNotMatch(reason as string, /missing Region/);
});

test("a complete body is not refused", () => {
  assert.equal(fileRefusalReason(COMPLETE_BODY), null);
});

test("a null body (no --body/--body-file found) is refused with its own distinct message, never silently "
  + "treated as complete or as 'missing everything'", () => {
  const reason = fileRefusalReason(null);
  assert.ok(reason);
  assert.match(reason as string, /no --body or --body-file/);
});

// --- #771: sessionFromArgv / appendFiledBy / withFiledBy ---

test("sessionFromArgv reads --session=<name>", () => {
  assert.equal(sessionFromArgv(["--title", "x", "--session=worker-contracts"]), "worker-contracts");
});

test("sessionFromArgv is null when absent -- there is no space-separated --session <name> form, matching "
  + "row-claim.mjs's own convention exactly", () => {
  assert.equal(sessionFromArgv(["--title", "x"]), null);
  assert.equal(sessionFromArgv(["--session", "worker-contracts"]), null);
});

test("appendFiledBy lands the line on its own line regardless of the body's own trailing whitespace", () => {
  assert.equal(appendFiledBy("## Region\nfoo", "worker-contracts"),
    "## Region\nfoo\n\nFiled-by: worker-contracts\n");
  assert.equal(appendFiledBy("## Region\nfoo\n\n\n", "worker-contracts"),
    "## Region\nfoo\n\nFiled-by: worker-contracts\n");
});

test("withFiledBy replaces --body with the augmented text, strips --session, and leaves every other "
  + "argument in place", () => {
  const argv = ["--title", "x", "--body", "## Region\nfoo", "--session=worker-contracts", "--label", "backlog"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--label", "backlog", "--body",
    "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

test("withFiledBy also strips a --body-file form, replacing it with the augmented --body", () => {
  const argv = ["--title", "x", "--body-file=/tmp/x.md", "--session=worker-contracts"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--body", "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

// --- #771 ACCEPTANCE: filedByLine (row-claim.mjs) reads exactly what row-file.mjs writes, and only that ---

test("#771 ACCEPTANCE: filedByLine reads the exact line appendFiledBy writes", () => {
  const augmented = appendFiledBy("## Region\nfoo", "worker-contracts");
  assert.equal(filedByLine(augmented), "worker-contracts");
});

test("#771 ACCEPTANCE, MUTATION TARGET: older prose ('Filed by `orchestrator`', no hyphen) is NEVER "
  + "inferred as the new line -- #737 and #758's real shape, both must read as absent", () => {
  const oldProseBody = "Found in #685's control arm. Filed by `orchestrator`; **not claimed**.\n\n"
    + "## The measurement\n";
  assert.equal(filedByLine(oldProseBody), null);
});

test("filedByLine is null on a body with no Filed-by line at all", () => {
  assert.equal(filedByLine("## Region\nfoo\n"), null);
});

// --- createIssue: the CLI's own decision, with gh's spawn injected so nothing reaches the network ---

test("ACCEPTANCE: a complete body with --session= files -- spawnGh receives the body WITH Filed-by "
  + "appended, --session stripped, everything else unchanged", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", "--label", "backlog"];
  let called: string[] | null = null;
  const code = createIssue(argv, { spawnGh: (a) => { called = a; } });
  assert.equal(code, 0);
  assert.deepEqual(called, ["--title", "a real row", "--label", "backlog", "--body",
    appendFiledBy(COMPLETE_BODY, "worker-contracts")]);
});

test("ACCEPTANCE: no --session= at all refuses -- spawnGh is NEVER called, even with a complete body", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; } });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test("ACCEPTANCE: an incomplete body still refuses even with --session= present -- spawnGh is NEVER called", () => {
  const argv = ["--title", "a real row", "--body", "no sections at all", "--session=worker-contracts"];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; } });
  assert.equal(code, 1);
  assert.equal(called, false, "gh issue create must never run when the body is incomplete");
});

test("a gh failure (non-zero exit) is surfaced as this tool's own exit code, not swallowed as success", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  const code = createIssue(argv, {
    spawnGh: () => { throw Object.assign(new Error("gh failed"), { status: 7 }); },
  });
  assert.equal(code, 7);
});

// --- the REAL CLI, spawned -- proves it is guarded (cli-flags.test.ts's discovery test requires it) ---

test("REAL CLI: an unrecognised flag is refused by name, before gh ever runs", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "y", "--session=worker-contracts", "--bogus-flag"], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 2, `expected exit 2 from refuseUnknownFlags, got: ${e.stderr}`);
      assert.match(e.stderr ?? "", /--bogus-flag/);
      return true;
    },
  );
});

test("REAL CLI: --session= itself is a KNOWN flag to the guard, never refused as unrecognised", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "no sections", "--session=worker-contracts"], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1, `expected the section-check refusal, got: ${e.stderr}`);
      assert.doesNotMatch(e.stderr ?? "", /unknown flag/i);
      return true;
    },
  );
});

test("REAL CLI: a genuinely known gh flag (e.g. -l/--label) is NOT refused by the flag guard -- it is "
  + "refused by the SECTION check instead, proving the guard did not swallow it as unknown", () => {
  assert.throws(
    () => execFileSync("node",
      [CLI, "--title", "x", "--body", "no sections", "--session=worker-contracts", "-l", "backlog"],
      { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1, `expected the section-check refusal (exit 1), got: ${e.stderr}`);
      assert.match(e.stderr ?? "", /missing/);
      assert.doesNotMatch(e.stderr ?? "", /unknown flag/i);
      return true;
    },
  );
});

test("REAL CLI: no --session= at all refuses with its own message, distinct from the section refusal", () => {
  assert.throws(
    () => execFileSync("node", [CLI, "--title", "x", "--body", COMPLETE_BODY], { encoding: "utf8" }),
    (error: unknown) => {
      const e = error as { status?: number; stderr?: string };
      assert.equal(e.status, 1);
      assert.match(e.stderr ?? "", /--session=<name> is required/);
      return true;
    },
  );
});
