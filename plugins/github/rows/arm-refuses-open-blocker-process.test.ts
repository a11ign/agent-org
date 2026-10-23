// no-token: gh -- the `gh` here is a stub first on PATH of a spawned sweep; nothing reaches GitHub
/**
 * #3544, AS A REAL PROCESS: THE SWEEP OVER ONE OPEN PULL REQUEST WHOSE CLOSING ROW HAS AN OPEN `blocked-by` EDGE, with a stub `gh` answering from its arguments.
 *
 * Moved from `src/packaging/arm-refuses-open-blocker.test.ts` (A11-160, step 5). The sweep's DECISIONS are core's and its tests run on the fake code host; what a process shows
 * is that the real program reaches `gh` THROUGH THE GITHUB PLUGIN (it loads the host file's code host by `require`), asks the edges where the row lives and posts or does not post
 * the once-only comment, which only the plugin's own operations and a stub at the process boundary can show. It is the plugin's end-to-end test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWEEP_WAIT_ENV } from "../../../src/auto-arm-sweep.ts";

const REPO = "a11ign/a11ign";
const node = (number: number, state: string) => ({ number, state, title: `row ${number}`, url: `https://github.com/${REPO}/issues/${number}` });
const edges = (...nodes: ReturnType<typeof node>[]) => ({ blockedBy: { nodes, totalCount: nodes.length } });

/** #3422's real edge list: two nodes, #3509 OPEN and #3414 CLOSED. */
const EDGES_3422 = edges(node(3509, "OPEN"), node(3414, "CLOSED"));
const CLEARED_3422 = edges(node(3509, "CLOSED"), node(3414, "CLOSED"));
const UNBLOCKED = edges();
const BODY = "Closes #3422\n\nAcceptance:\n```bash\npnpm test\n```";

const SWEEP = fileURLToPath(new URL("../../../src/auto-arm-sweep.ts", import.meta.url));

/** The real sweep over ONE open PR (#3507), a fake `gh` answering from its arguments. `rows` is the edge list per row, or "fail". */
function driveSweep({ rows, body = BODY, existingComment = "" }: { rows: Record<number, unknown | "fail">; body?: string; existingComment?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "arm-refuses-blocker-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "body.txt"), body);
    writeFileSync(join(dir, "comments.json"), JSON.stringify({ comments: [{ body: existingComment }] }));
    const issueCases = Object.entries(rows).map(([row, answer]) => {
      writeFileSync(join(dir, `row-${row}.json`), JSON.stringify(answer));
      return `  *"issue view ${row} "*) ${answer === "fail" ? "echo 'HTTP 502' >&2; exit 1" : `cat "${dir}/row-${row}.json"`} ;;`;
    }).join("\n");
    writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$*" in
${issueCases}
  *"issue view"*) echo 'HTTP 404' >&2; exit 1 ;;
  *timelineItems*) echo '{"mergeQueueEntry":null,"timelineItems":{"nodes":[]}}' ;;
  *"api graphql"*) echo '[{"number":3507,"isDraft":false,"merged":false,"autoMergeRequest":null,"mergeQueueEntry":null}]' ;;
  *"--json comments"*) cat "${dir}/comments.json" ;;
  *"--json body"*) cat "${dir}/body.txt" ;;
  *"--json labels"*) echo '[]' ;;
  *"--json author"*) echo 'worker-1' ;;
  *"--json headRefOid"*) echo 11aa53a ;;
  *"check-runs"*) echo 9 ;;
esac
`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const run = spawnSync(process.execPath, [SWEEP], { encoding: "utf8", env: { ...process.env,
      GITHUB_REPOSITORY: REPO, [SWEEP_WAIT_ENV]: "0", PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    return { said: run.stdout + run.stderr, status: run.status, merged: calls.some((c) => c.startsWith("pr merge")),
      commented: calls.filter((c) => c.startsWith("pr comment")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3544 (1) sweep, as a process: #3507 over #3422's real edges is SKIPPED naming the blocker, nothing is merged, one comment is posted", () => {
  const out = driveSweep({ rows: { 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SWEEP: #3507 SKIPPED -- closing row #3422 is blocked by open #3509/);
  assert.equal(out.status, 0, "a PR waiting on a row is not an arming failure, as a hold is not");
  assert.equal(out.commented.length, 1, out.said);
});

test("#3544 (6) sweep, as a process: a tick that finds its marker already on the PR posts nothing more", () => {
  const out = driveSweep({ rows: { 3422: EDGES_3422 }, existingComment: "<!-- arm-refused: open-blocker 3509 -->\nNot armed" });
  assert.equal(out.merged, false, out.said);
  assert.equal(out.commented.length, 0, out.said);
});

test("#3544 (2) sweep CONTROLS, as a process: the blocker CLOSED, no edges, and `Closes: none` are all ARMED (the merge call is made)", () => {
  const controls: Record<string, Parameters<typeof driveSweep>[0]> = {
    "the blocker closed": { rows: { 3422: CLEARED_3422 } },
    "no edges": { rows: { 3422: UNBLOCKED } },
    "Closes: none": { rows: {}, body: "Closes: none — docs only" },
    "an empty body": { rows: {}, body: "" },
  };
  for (const [name, fixture] of Object.entries(controls)) {
    const out = driveSweep(fixture);
    assert.equal(out.merged, true, `${name}: ${out.said}`);
    assert.doesNotMatch(out.said, /SKIPPED/, name);
  }
});

test("#3544 (3) sweep, as a process: an unreadable edge list arms nothing and is reported as a lookup that failed", () => {
  for (const rows of [{ 3422: "fail" as const }, { 3422: { labels: [] } }]) {
    const out = driveSweep({ rows });
    assert.equal(out.merged, false, out.said);
    assert.match(out.said, /SWEEP: #3507 SKIPPED -- could not read closing row #3422's blocked-by edges/);
    assert.equal(out.status, 1, "the sweep's existing `could not arm` code: inconclusive, never fine");
  }
});

test("#3544 (4) sweep, as a process: the second of two closing rows is the one named", () => {
  const out = driveSweep({ body: "Closes #3400\nCloses #3422", rows: { 3400: UNBLOCKED, 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /closing row #3422 is blocked by open #3509/);
});
