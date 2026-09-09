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
  boardingFor, issueNumberFromUrl, unverifiedFilingFields, fetchIssueBoardStatus,
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

test("withFiledBy strips --ready too -- #844's own flag, not gh's", () => {
  const argv = ["--title", "x", "--body", "## Region\nfoo", "--session=worker-contracts", "--ready"];
  const result = withFiledBy(argv, "worker-contracts", "## Region\nfoo");
  assert.deepEqual(result, ["--title", "x", "--body", "## Region\nfoo\n\nFiled-by: worker-contracts\n"]);
});

// --- #844: boardingFor -- backlog unless --ready is explicitly given ---

test("boardingFor: no --ready -- backlog label, Backlog Status", () => {
  assert.deepEqual(boardingFor(["--title", "x"]), { label: "backlog", status: "Backlog" });
});

test("boardingFor: --ready given -- ready label, Ready Status, never both", () => {
  assert.deepEqual(boardingFor(["--title", "x", "--ready"]), { label: "ready", status: "Ready" });
});

// --- #844: issueNumberFromUrl ---

test("issueNumberFromUrl reads the number off gh issue create's own bare-URL stdout", () => {
  assert.equal(issueNumberFromUrl("https://github.com/DanBeckDev/a11y-witness/issues/900\n"), 900);
});

test("issueNumberFromUrl is null on anything that does not end in /issues/<digits>", () => {
  assert.equal(issueNumberFromUrl("not a url"), null);
  assert.equal(issueNumberFromUrl("https://github.com/DanBeckDev/a11y-witness/pull/900"), null);
});

// --- #844: unverifiedFilingFields -- named, not a bare boolean ---

test("unverifiedFilingFields: all three confirmed -- empty", () => {
  const after = { labels: ["backlog"], body: "## Region\nfoo\n\nFiled-by: worker-contracts\n", boardStatus: "Backlog" };
  assert.deepEqual(unverifiedFilingFields(after, { session: "worker-contracts", label: "backlog", status: "Backlog" }), []);
});

test("unverifiedFilingFields: missing label named", () => {
  const after = { labels: [], body: "Filed-by: worker-contracts\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after, { session: "worker-contracts", label: "backlog", status: "Backlog" });
  assert.deepEqual(missing, ["the `backlog` label"]);
});

test("unverifiedFilingFields: missing Filed-by named -- wrong session or absent line, both count", () => {
  const after = { labels: ["backlog"], body: "## Region\nfoo\n", boardStatus: "Backlog" };
  const missing = unverifiedFilingFields(after, { session: "worker-contracts", label: "backlog", status: "Backlog" });
  assert.deepEqual(missing, ["the Filed-by line"]);
});

test("unverifiedFilingFields: never on the board at all vs. on it with the WRONG Status are named "
  + "differently", () => {
  const notBoarded = { labels: ["backlog"], body: "Filed-by: worker-contracts\n", boardStatus: null };
  assert.deepEqual(unverifiedFilingFields(notBoarded, { session: "worker-contracts", label: "backlog", status: "Backlog" }),
    ["Project 2 membership"]);
  const wrongStatus = { labels: ["backlog"], body: "Filed-by: worker-contracts\n", boardStatus: "Ready" };
  assert.deepEqual(unverifiedFilingFields(wrongStatus, { session: "worker-contracts", label: "backlog", status: "Backlog" }),
    ['Project 2 Status (reads "Ready", not "Backlog")']);
});

test("unverifiedFilingFields: all three missing at once are all named, not just the first", () => {
  const after = { labels: [], body: null, boardStatus: null };
  const missing = unverifiedFilingFields(after, { session: "worker-contracts", label: "backlog", status: "Backlog" });
  assert.equal(missing.length, 3);
});

// --- #844: fetchIssueBoardStatus -- a single targeted read, not the whole board ---

test("fetchIssueBoardStatus reads the Status option name off the one matching project", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [
    { project: { number: 2 }, fieldValueByName: { name: "Backlog" } },
  ] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), "Backlog");
});

test("fetchIssueBoardStatus: no project item at all reads as null, not a crash", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), null);
});

test("fetchIssueBoardStatus: an item on a DIFFERENT project is not read as this one's Status", () => {
  const run = () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [
    { project: { number: 7 }, fieldValueByName: { name: "Done" } },
  ] } } } } });
  assert.equal(fetchIssueBoardStatus(900, { run }), null);
});

test("MUTATION: fetchIssueBoardStatus throws, never returns null as if unboarded, when gh fails", () => {
  const run = () => { throw new Error("gh: not authenticated"); };
  assert.throws(() => fetchIssueBoardStatus(900, { run }), /could not read #900's Project membership/);
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

// --- createIssue: the CLI's own decision, with every gh-facing dependency injected so nothing reaches
// the network. #844: files, labels, boards, sets Status, then reads all three back before reporting. ---

const FILED_URL = "https://github.com/DanBeckDev/a11y-witness/issues/900";

/** A `run` fake for the calls createIssue makes AFTER spawnGh: `gh project item-add` and the body
 * read-back (`gh issue view ... --json body --jq .body`). Everything else answers "" harmlessly. */
function afterRun(body: string) {
  return (_cmd: string, args: string[]) => (args.includes("body") ? body : "");
}

/** The full set of happy-path dependencies, so each test overrides only what it means to test. */
function happyDeps(session: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    spawnGh: () => FILED_URL,
    run: afterRun(appendFiledBy(COMPLETE_BODY, session)),
    fetchBoardStatus: () => (label === "ready" ? "Ready" : "Backlog"),
    fetchLabels: () => ({ number: 900, title: "a real row", labels: [label] }),
    moveStatus: () => ({ moved: true as const }),
    ...overrides,
  };
}

test("ACCEPTANCE: a complete body with --session= files -- spawnGh receives the body WITH Filed-by "
  + "appended and --session stripped, but NO --label at all: the board label is added later, never at "
  + "creation time (see #844's own header for why)", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  let called: string[] | null = null;
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    spawnGh: (a) => { called = a; return FILED_URL; },
  });
  assert.equal(code, 0);
  assert.deepEqual(called, ["--title", "a real row", "--body",
    appendFiledBy(COMPLETE_BODY, "worker-contracts")]);
});

test("#844 ACCEPTANCE, MUTATION TARGET: the board label is added via a SEPARATE gh issue edit call, "
  + "AFTER the Status move succeeds, never before -- the exact ordering #867's own live dogfooding run "
  + "proved necessary: a `ready` label present before the item has a Status makes the row itself the "
  + "shape #747's board-safety floor refuses, on its own snapshot, every time", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts", "--ready"];
  const order: string[] = [];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "ready"),
    run: (cmd: string, args: string[]) => {
      if (args[1] === "item-add") order.push("board");
      if (args.includes("--add-label")) order.push(`label:${args[args.indexOf("--add-label") + 1]}`);
      return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(cmd, args);
    },
    moveStatus: (n: number, s: string) => { order.push(`status:${s}`); return { moved: true as const }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(order, ["board", "status:Ready", "label:ready"],
    `board, then Status, then the label -- got: ${JSON.stringify(order)}`);
});

test("ACCEPTANCE: the issue is added to Project 2 and its Status is moved to match the label, both "
  + "AFTER a successful gh issue create", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  const projectCalls: string[][] = [];
  const moveCalls: [number, string][] = [];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    run: (cmd: string, args: string[]) => {
      if (args[1] === "item-add") projectCalls.push(args);
      return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(cmd, args);
    },
    moveStatus: (n: number, s: string) => { moveCalls.push([n, s]); return { moved: true }; },
  });
  assert.equal(code, 0);
  assert.equal(projectCalls.length, 1);
  assert.ok(projectCalls[0].includes("--url") && projectCalls[0].includes(FILED_URL));
  assert.deepEqual(moveCalls, [[900, "Backlog"]]);
});

test("ACCEPTANCE, MUTATION TARGET: the issue number and https URL are read back and printed only after "
  + "every check confirms -- prints exactly the issue's own URL", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  let printed = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { printed += chunk; return true; }) as typeof process.stdout.write;
  try {
    const code = createIssue(argv, happyDeps("worker-contracts", "backlog"));
    assert.equal(code, 0);
    assert.equal(printed, `${FILED_URL}\n`);
  } finally {
    process.stdout.write = original;
  }
});

test("ACCEPTANCE: no --session= at all refuses -- spawnGh is NEVER called, even with a complete body", () => {
  const argv = ["--title", "a real row", "--body", COMPLETE_BODY];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; return FILED_URL; } });
  assert.equal(code, 1);
  assert.equal(called, false);
});

test("ACCEPTANCE: an incomplete body still refuses even with --session= present -- spawnGh is NEVER called", () => {
  const argv = ["--title", "a real row", "--body", "no sections at all", "--session=worker-contracts"];
  let called = false;
  const code = createIssue(argv, { spawnGh: () => { called = true; return FILED_URL; } });
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

test("#844 ACCEPTANCE: gh issue create succeeding but printing something that is not a real issue URL "
  + "is refused distinctly -- filed, but unboardable and unverifiable", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  const code = createIssue(argv, { spawnGh: () => "not a url at all" });
  assert.equal(code, 2);
});

test("#844 ACCEPTANCE: a failure adding the issue to Project 2 is refused distinctly (exit 2), naming "
  + "the issue number and the hand-recovery command -- it is NOT reported as a plain success", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      run: (_cmd: string, args: string[]) => {
        if (args[1] === "item-add") throw new Error("gh: could not add item");
        return "";
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900/);
    assert.match(stderr, /could NOT add it to Project/);
    assert.match(stderr, /gh project item-add 2 --owner DanBeckDev --url/);
  } finally {
    process.stderr.write = original;
  }
});

test("#844 ACCEPTANCE, MUTATION TARGET: a Status move that does not succeed is refused distinctly "
  + "(exit 2), never reported as filed cleanly", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  const code = createIssue(argv, {
    ...happyDeps("worker-contracts", "backlog"),
    moveStatus: () => ({ moved: false, reason: "gh: rate limited", notOnBoard: false }),
  });
  assert.equal(code, 2);
});

test("#844 ACCEPTANCE: a label-add failure AFTER a successful Status move is refused distinctly (exit "
  + "2), naming the issue number and the Status already set, never reported as filed cleanly", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      run: (_cmd: string, args: string[]) => {
        if (args.includes("--add-label")) throw new Error("gh: label add failed");
        return afterRun(appendFiledBy(COMPLETE_BODY, "worker-contracts"))(_cmd, args);
      },
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900, boarded with Status "Backlog"/);
    assert.match(stderr, /`backlog` label could not be added/);
  } finally {
    process.stderr.write = original;
  }
});

test("#844 ACCEPTANCE, MUTATION TARGET: everything succeeds but the READ-BACK disagrees (e.g. the label "
  + "did not actually stick) -- refused distinctly (exit 2), naming what is missing, never reported as "
  + "filed cleanly on the strength of the write calls alone", () => {
  const argv = ["--title", "x", "--body", COMPLETE_BODY, "--session=worker-contracts"];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, {
      ...happyDeps("worker-contracts", "backlog"),
      fetchLabels: () => ({ number: 900, title: "x", labels: [] }), // the write claimed success; the read-back disagrees
    });
    assert.equal(code, 2);
    assert.match(stderr, /FILED as #900/);
    assert.match(stderr, /the `backlog` label/);
  } finally {
    process.stderr.write = original;
  }
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
