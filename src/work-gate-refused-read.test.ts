// no-token: gh -- every read is handed a fake `run`, and the three that reach the real `defaultRun` run in a child with a stub `gh` first on PATH (#3724)
/**
 * #3724: A REFUSED READ OF ONE SHA IS NAMED, AND A STALE EVIDENCE HEAD SAYS NOTHING.
 *
 * THE DEFECT, measured 2026-10-05: `gh: Not Found (HTTP 404)` repeated for 30+ ticks and named no repository, pull request or sha. It was
 * `readPatchId` reading `compare/main...<head>` for a head a review named and a force-push had removed. The read caught the refusal and
 * returned `null`, which was right, but `defaultRun` inherits stderr, so `gh`'s own line went to the journal beside it.
 *
 * (1) is the RED control: the REAL `defaultRun` with a `gh` that answers 404, run in a child so its inherited stderr can be read. A stub `run`
 *     cannot show it, since a stub never writes to the child's stderr. (2) and (3) are the two directions of the classification: a stale sha
 *     is silent, any other refusal is ONE line per tick that names the repository, the path and the status. (4) pins that a 404 of a read
 *     that is not of a sha still reaches stderr, so the capture is not a way of silencing every `gh`.
 */
import { TSX_IMPORT } from "./tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inRepo, readCommitShas, readFailingChecks, withPatchIds } from "./work-gate.ts";

const GATE = fileURLToPath(new URL("./work-gate.ts", import.meta.url));
const HEAD = "a".repeat(40);
const STALE = "c8fe8f58";
const ALSO_STALE = "b".repeat(8);
const DIFF = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";

const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-06T00:00:00Z" }];
/** A settled-green pull request whose reviews name two heads that are no longer its own: the shape that makes `withPatchIds` read each. */
const reviewedAtStaleHeads = () => ({ number: 4, headRefOid: HEAD, baseRefName: "main", statusCheckRollup: GREEN, labels: [], body: "",
  reviews: [STALE, ALSO_STALE].map((oid) => ({ state: "COMMENTED", commit: { oid }, body: "" })) });

/** The error `execFileSync` throws for a `gh` that printed `message` on stderr and exited 1. */
const ghRefusal = (message: string) => Object.assign(new Error(`Command failed: gh api\n${message}`), { status: 1, stderr: message });

/** A `gh` that answers the head's compare with a diff and every other compare with `refusal`, and records each call. */
function ghWhere(refusal: Error) {
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args[args.length - 1]);
    if (args[args.length - 1].endsWith(`...${HEAD}`)) return DIFF;
    throw refusal;
  };
  return { run, calls };
}

/** What `read` wrote to this process's stderr, line by line. */
function toldDuring(read: () => void): string[] {
  const told: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { told.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    read();
  } finally {
    process.stderr.write = write;
  }
  return told;
}

const enriched = (pr: object) => (pr as { patchIds?: Record<string, string> }).patchIds;

test("(1) the REAL `defaultRun`: a refused compare of a stale head prints nothing, and a refused list of commits is told", () => {
  const dir = mkdtempSync(join(tmpdir(), "refused-read-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$*" in\n  *"...${HEAD}") cat <<'EOF'\n${DIFF}EOF\n;;\n`
      + "  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;\nesac\n");
    chmodSync(join(dir, "gh"), 0o755);
    const script = `import { withPatchIds, readCommitShas, defaultRun, inRepo } from ${JSON.stringify(GATE)};
      const pr = ${JSON.stringify(reviewedAtStaleHeads())};
      inRepo("o/r", () => {
        const [read] = withPatchIds([pr], defaultRun, null);
        process.stdout.write(JSON.stringify(Object.keys(read.patchIds ?? {})) + "\\n");
        readCommitShas(4, defaultRun);
        try { defaultRun(["api", "repos/o/r/labels/nope"]); } catch { /* the caller of a read that is not of a sha handles it */ }
      });`;
    const child = spawnSync(process.execPath, [...TSX_IMPORT, "--input-type=module", "-e", script],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "o/r" } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), JSON.stringify([HEAD]), "the pull request is enriched at its head alone");
    const lines = child.stderr.split("\n").filter(Boolean);
    assert.equal(lines.filter((line) => line.startsWith("gh: Not Found (HTTP 404)")).length, 1,
      `only the label read (4) reaches the journal as gh's own line: ${lines.join(" | ")}`);
    assert.equal(lines.filter((line) => line.startsWith("REFUSED READ in o/r:") && line.includes("repos/o/r/pulls/4/commits")).length, 1,
      "the commits of a pull request are not a sha: its 404 is a fault and is told, naming the repository and the path");
    assert.equal(lines.length, 2, `nothing else: ${lines.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(2) a stale evidence head (404 or 422 on a compare or a commit path) says nothing and the pull request keeps the head's own reading", () => {
  for (const status of ["Not Found (HTTP 404)", "Unprocessable Entity (HTTP 422)"]) {
    const { run, calls } = ghWhere(ghRefusal(`gh: ${status}`));
    let result: object[] = [];
    const told = toldDuring(() => { result = withPatchIds([reviewedAtStaleHeads()], run, null); });
    assert.deepEqual(told, [], `${status}: nothing is written`);
    assert.deepEqual(Object.keys(enriched(result[0]) ?? {}), [HEAD], `${status}: unenriched by the stale heads, enriched by the head`);
    assert.equal(calls.length, 3, "the control: both stale heads WERE read, so the silence is not an unread population");
  }
  const refusedCheckRuns = () => { throw ghRefusal("gh: Not Found (HTTP 404)"); };
  assert.deepEqual(toldDuring(() => assert.equal(readFailingChecks(STALE, refusedCheckRuns), null)), [], "a commit's check-runs: the same");
});

test("(3) a refusal that is not a stale sha (403, 502, a timeout) is ONE line naming the repository, the path and the status, per tick and not per head", () => {
  const cases = [
    { refusal: ghRefusal("gh: Resource not accessible by integration (HTTP 403)"), says: "HTTP 403" },
    { refusal: ghRefusal("gh: Bad Gateway (HTTP 502)"), says: "HTTP 502" },
    { refusal: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }), says: "ETIMEDOUT" },
  ];
  for (const { refusal, says } of cases) {
    const { run, calls } = ghWhere(refusal);
    let result: object[] = [];
    const told = toldDuring(() => { result = inRepo("a11ign/lab", () => withPatchIds([reviewedAtStaleHeads()], run, null)); });
    assert.equal(told.length, 1, `${says}: two heads were refused and ONE line was told: ${told.join("|")}`);
    assert.match(told[0], /^REFUSED READ in a11ign\/lab: `gh api repos\/a11ign\/lab\/compare\/main\.\.\.<sha>` answered /);
    assert.ok(told[0].includes(says), told[0]);
    assert.deepEqual(Object.keys(enriched(result[0]) ?? {}), [HEAD], `${says}: still read at the head`);
    assert.equal(calls.length, 3);
    assert.deepEqual(toldDuring(() => inRepo("a11ign/lab", () => withPatchIds([reviewedAtStaleHeads()], run, null))), [],
      `${says}: told once, so the same fault in the same tick is not told again`);
  }
});

test("(4) a 404 of a read that is not of a sha is a fault: told, and the answer is `null` rather than empty", () => {
  const notFound = () => { throw ghRefusal("gh: Not Found (HTTP 404)"); };
  const told = toldDuring(() => assert.equal(inRepo("o/gone", () => readCommitShas(9, notFound)), null));
  assert.equal(told.length, 1);
  assert.match(told[0], /^REFUSED READ in o\/gone: `gh api repos\/o\/gone\/pulls\/9\/commits` answered HTTP 404/);
});
