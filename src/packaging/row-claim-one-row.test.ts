// no-token: gh -- every `gh` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #2407: ONE INSTANCE, ONE ROW -- `row-claim`'s half (`ceo`, on the chairman's direction of 2026-09-24). The router's
 * half is `wake-one-row.test.ts`; "the offer alone is not the drain, the claim is the other half" (#2324) holds here
 * for the same reason: an instance told to claim the next Ready row by hand goes around any router.
 *
 * The fact arrives as `instance` -- what the instance holds or has held -- so `oneRowReason` and `claimRow` are called
 * with the roster they mean and read no host. The CLI reads it (`instanceNow`), which is what the last two tests drive as
 * a PROCESS: an injected seam is exactly what a deleted call goes around.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync, copyFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { localImports } from "../../../guards/src/local-import-closure.mjs";
import { oneRowReason } from "../row-claim/runner-rule.mjs";
import { claimRow } from "../row-claim.mjs";
import { sparePathsFrom } from "../wake.mjs";

const ROW = 2407;
const REFUSAL = /one instance, one row/;

// --- THE RULE ---

test("#2407 (3): a spare that holds or has held another row is refused, and the reason says what to do instead", () => {
  const reason = oneRowReason("worker-4", ROW, { spare: true, rows: [2378] });
  assert.ok(reason);
  assert.match(reason as string, REFUSAL);
  assert.match(reason as string, /worker-4 holds or has held #2378/);
  assert.match(reason as string, /this instance ends when #2378 closes and a new row gets a new instance/);
  assert.match(reason as string, /review and rework orders on the row you hold still reach you/);
  const several = oneRowReason("worker-4", ROW, { spare: true, rows: [2378, 2293, 2378] });
  assert.match(several as string, /#2378, #2293 /, "each row once, in the order held");
});

test("#2407 (3) POSITIVE CONTROLS: the same fixture is not refused with no other row, as a standing role, or on its own row", () => {
  assert.equal(oneRowReason("worker-4", ROW, { spare: true, rows: [] }), null, "a fresh instance takes the row it was spawned for");
  assert.equal(oneRowReason("worker-tooling", ROW, { spare: false, rows: [2378] }), null,
    "the standing three claim by hand until they retire: the rule keys on the roster's spare mark");
  assert.equal(oneRowReason("worker-4", ROW, { spare: true, rows: [ROW] }), null, "the row being claimed is not counted against itself");
  assert.equal(oneRowReason("worker-4", ROW, { spare: true, rows: [ROW, ROW] }), null);
});

// --- THROUGH `claimRow`: NOTHING IS WRITTEN ON A REFUSAL, AND RESUMING IS NOT A NEW ROW ---

/** A `gh` for one row that is `ready`, and (once written to) carries the claiming session's labels. */
function claimStub(session: string, { alreadyMine = false } = {}) {
  let labelReads = 0;
  return (_cmd: string, args: string[]): string => {
    if (args[1] === "view" && args.includes("number,title,labels,state")) {
      labelReads += 1;
      const mine = [`session:${session}`, "in-progress"];
      const labels = labelReads === 1 ? ["ready", ...(alreadyMine ? mine : [])] : [...mine, "started", "was-ready"];
      return JSON.stringify({ number: ROW, title: "A row", state: "OPEN", labels: labels.map((name) => ({ name })) });
    }
    // Body and `blockedBy` reads fail: those lookups return null and the claim's checks fail OPEN, which is what lets
    // this fixture reach the one check under test without a canned answer for each.
    if (args[1] === "view") throw new Error("simulated: this fixture answers no body and no blockedBy");
    return "[]";
  };
}
const claimAs = (session: string, instance: { spare: boolean; rows: number[] }, alreadyMine = false) =>
  claimRow(ROW, session, { run: claimStub(session, { alreadyMine }), moveStatus: () => ({ moved: true }), instance });

test("#2407 (3) ACCEPTANCE: `claimRow` refuses a spare's second row, naming the rule, and NOTHING is written", () => {
  const writes: string[][] = [];
  const stub = claimStub("worker-4");
  const run = (cmd: string, args: string[]) => { if (args[1] === "edit" || args[1] === "comment") writes.push(args); return stub(cmd, args); };
  const got = claimRow(ROW, "worker-4", { run, moveStatus: () => ({ moved: true }), instance: { spare: true, rows: [2378] } });
  assert.equal(got.claimed, false);
  assert.match((got as { reason: string }).reason, REFUSAL);
  assert.deepEqual(writes, [], "a refused claim leaves the row exactly as it found it");
});

test("#2407 (3) POSITIVE CONTROLS through `claimRow`: a fresh spare claims, a standing role claims, and a spare RESUMING its own row claims", () => {
  assert.equal(claimAs("worker-4", { spare: true, rows: [] }).claimed, true, "the one row the instance is for");
  assert.equal(claimAs("worker-tooling", { spare: false, rows: [2378] }).claimed, true, "a standing role is not this rule's subject");
  assert.equal(claimAs("worker-4", { spare: true, rows: [2378, ROW] }, true).claimed, true,
    "a row the instance already holds is not a NEW one, so it never reaches the rule -- even when it has held others");
  assert.equal(claimRow(ROW, "worker-4", { run: claimStub("worker-4"), moveStatus: () => ({ moved: true }) }).claimed, true,
    "a caller that does not say is asked about nothing: the CLI is what asks");
});

// --- THE CLI, AS A PROCESS: THE INSTANCE'S LIFE, CLAIM -> REVIEW -> CLOSE -> A SECOND CLAIM ---
//
// In a COPY OF ITS OWN CLOSURE, as `wake-drain.test.ts` does and for its reason (#2394): the CLI refuses first of all
// when it cannot ask whether its rule is current, and the acceptance job's clone has no `origin/main`. The copy is of
// the WORKING TREE, so a mutation made there is the one under test.
const ROW_CLAIM_ENTRY = fileURLToPath(new URL("../row-claim.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SESSIONS_JSON = "packages/agent-org/docs/roles/sessions.json";
// `HELD_ROWS` is what `gh issue list --label session:<me>` answers: the rows the instance holds NOW.
const GH_READY_ROW = `#!/bin/sh
case "$*" in
  *number,title,labels,state*) printf '%s' '{"number":${ROW},"title":"A row","state":"OPEN","labels":[{"name":"ready"}]}' ;;
  *"issue list"*) printf '%s' "\${HELD_ROWS:-[]}" ;;
  *) exit 1 ;;
esac
`;

function copyClosureAsRepo(copyRoot: string): string {
  const files = new Set<string>([join(REPO_ROOT, SESSIONS_JSON)]);
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const next of localImports(file)) visit(next);
  };
  visit(ROW_CLAIM_ENTRY);
  for (const name of readdirSync(join(REPO_ROOT, "packages/agent-org/src/row-claim"))) {
    visit(join(REPO_ROOT, "packages/agent-org/src/row-claim", name));
  }
  for (const file of files) {
    const target = join(copyRoot, relative(REPO_ROOT, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: copyRoot, env: sandboxGitEnv(), stdio: "pipe" });
  git("init", "--quiet");
  git("add", "-A");
  git("commit", "--quiet", "-m", "copy");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return join(copyRoot, relative(REPO_ROOT, ROW_CLAIM_ENTRY));
}

/** `row-claim claim 2407` as `session`, with the registry beside a wake ledger under HOME and `held` labelled on GitHub. */
function claimProcess(session: string, { registry = null, held = [] }: { registry?: Record<string, unknown> | null; held?: number[] }) {
  const dir = mkdtempSync(join(tmpdir(), "row-claim-one-row-"));
  try {
    writeFileSync(join(dir, "gh"), GH_READY_ROW);
    chmodSync(join(dir, "gh"), 0o755);
    if (registry !== null) {
      mkdirSync(join(dir, ".cache/a11ign"), { recursive: true });
      writeFileSync(sparePathsFrom(join(dir, ".cache/a11ign/wake-ledger")).registry, `${JSON.stringify(registry)}\n`);
    }
    const entry = copyClosureAsRepo(join(dir, "checkout"));
    return spawnSync(process.execPath, [entry, "claim", String(ROW), `--session=${session}`], {
      encoding: "utf8",
      env: { ...sandboxGitEnv(), HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, A11Y_POLICY_LAUNCH_REASON: "#2407 drives the CLI",
        HELD_ROWS: JSON.stringify(held.map((number) => ({ number }))) },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const refusedFor = (ran: ReturnType<typeof claimProcess>) => REFUSAL.test(ran.stdout);

test("#2407 (1) THE COMMAND: an instance through claim, review and close is refused a second claim -- from the labels AND from the registry", () => {
  // IN REVIEW: the first row is still labelled `session:worker-9`, and no tick has recorded it yet.
  const inReview = claimProcess("worker-9", { held: [2378] });
  assert.match(inReview.stdout, /NOT CLAIMED: one instance, one row: worker-9 holds or has held #2378/, `stdout ${inReview.stdout} stderr ${inReview.stderr}`);
  assert.equal(inReview.status, 1);

  // CLOSED: the label is gone, and the registry a tick kept is the only account of what the instance did.
  const closed = claimProcess("worker-9", { registry: { "worker-9": { spawnedAt: 1, rows: [2378] } } });
  assert.match(closed.stdout, /NOT CLAIMED: one instance, one row/, `the closed row is still a row this instance held; got ${closed.stdout}`);
  assert.equal(closed.status, 1);
});

test("#2407 (1) THE COMMAND, POSITIVE CONTROLS: a fresh instance, a standing role and another instance's registry line are not refused", () => {
  assert.equal(refusedFor(claimProcess("worker-9", {})), false, "a new instance: nothing held, nothing recorded");
  assert.equal(refusedFor(claimProcess("worker-9", { registry: { "worker-9": { spawnedAt: 1, rows: [] } } })), false,
    "registered at spawn with no row yet");
  assert.equal(refusedFor(claimProcess("worker-9", { registry: { "worker-8": { spawnedAt: 1, rows: [2378] } } })), false,
    "the registry line is keyed by the instance: a neighbour's row is not this one's");
  assert.equal(refusedFor(claimProcess("worker-tooling", { held: [2378], registry: { "worker-tooling": { spawnedAt: 1, rows: [2378] } } })),
    false, "a standing role holding a row and named in a registry is not a spare: the roster's mark decides");
  assert.equal(refusedFor(claimProcess("worker-9", { held: [ROW], registry: { "worker-9": { spawnedAt: 1, rows: [ROW] } } })), false,
    "resuming the instance's own row is not a second one");
});
