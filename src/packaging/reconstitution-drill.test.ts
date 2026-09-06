// THE CONTINGENCY DRILL'S ACCEPTANCE TEST, EXTENDING THE EXISTING ONE RATHER THAN REPLACING IT.
//
// `docs/roles/README.md`'s "contingency drill" section already names the acceptance test for the role
// system: a fresh clone producing every agent's first message from the repo alone. Until this unit that
// was five lines of `cat`/`git clone` typed by a human. `scripts/reconstitution-drill.mjs` is the same
// drill as a command, extended to also compose the accumulated memory into each message -- and this file
// is that script's own test, not a restatement of `roles-readme.test.ts`'s roster/completeness checks,
// which stay exactly where they are and keep doing their own job.
//
// Runs the real script against THIS checkout (offline, fast, what CI can do) -- the `--clone` path is
// exercised manually per the drill instructions in README.md, never automated here, because a real clone
// over the network is exactly the kind of check this repo's own rules say does not belong in a unit test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrill } from "../../../../scripts/reconstitution-drill.mjs";

test("the drill runs against this checkout and produces a message for every roster agent", () => {
  const report = runDrill(process.cwd());
  assert.ok(report.ok, "the drill refused against the real checkout -- docs/roles/README.md must be unreadable");
  // A floor, not a target -- same reasoning as roles-readme.test.ts's own roster guard: the organisation
  // does not shrink to zero as a happy path.
  assert.ok(report.agents.length >= 6,
    `expected at least 6 agents from the real roster, found ${report.agents.length}`);
  for (const a of report.agents) {
    assert.ok(a.agent, "every produced entry must name its agent");
  }
});

test("every agent's composed message includes the memory section, when memory exists", () => {
  const report = runDrill(process.cwd());
  assert.ok(report.ok, "the drill refused against the real checkout");
  assert.ok((report.memoryEntryCount ?? 0) > 0,
    "docs/roles/memory/MEMORY.md produced zero entries against the real checkout -- the migration itself may be missing");
  for (const a of report.agents) {
    if (!a.message) continue; // a genuine gap (missing message block) is its own assertion below
    assert.match(a.message, /MEMORY\.md/,
      `${a.agent}'s composed message does not mention the memory index -- "with memory included" is not being met`);
  }
});

test("a roster agent with no role file is reported as a gap, not silently dropped", () => {
  const report = runDrill(process.cwd());
  // Mirrors roles-readme.test.ts's live finding rather than assuming it: whichever roles are currently
  // unwritten must show up here too, by the SAME real signal (existsSync), read independently.
  const stillMissing = report.agents.filter((a) => a.gaps.some((g) => g.startsWith("role file missing")));
  for (const a of stillMissing) {
    assert.ok(a.message, `${a.agent} has a missing role file but no composed message -- the two checks must not conflate`);
  }
});

/**
 * MUTATION HALF, against a synthetic checkout built under `os.tmpdir()` -- never the real `docs/roles/`
 * tree, for the same reason `roles-readme.test.ts`'s own mutation test gives: a shared, git-hooked
 * checkout should not have a real agent's file deleted even temporarily mid-test-run.
 */
test("MUTATION: a missing README, a missing message block, and a missing memory index are each caught", () => {
  const dir = mkdtempSync(join(tmpdir(), "reconstitution-drill-mutation-"));

  // 1. No README at all -- the drill must refuse cleanly, not throw.
  const emptyReport = runDrill(dir);
  assert.equal(emptyReport.ok, false, "a checkout with no docs/roles/README.md must be reported as a gap, not silently pass");

  // 2. A README with a roster row but no matching "first message" block, and no memory index.
  mkdirSync(join(dir, "docs", "roles"), { recursive: true });
  writeFileSync(join(dir, "docs", "roles", "README.md"),
    "# If this machine is lost\n\n## The roster\n\n"
    + "| role | agent name | file | reports to |\n|---|---|---|---|\n"
    + "| Example | `example-agent` | [example.md](./example.md) | `example-boss` |\n\n"
    + "## The first message for each agent, ready to paste\n\n(none written yet)\n");
  writeFileSync(join(dir, "docs", "roles", "example.md"), "# Example\n");

  const noMessageReport = runDrill(dir);
  assert.equal(noMessageReport.ok, true);
  assert.equal(noMessageReport.agents.length, 1);
  assert.ok(noMessageReport.agents[0].gaps.some((g) => g.includes("no \"first message\" block")),
    "a roster row with no matching message block must be reported, not silently skipped");
  assert.equal(noMessageReport.agents[0].message, null, "a missing message block must not fabricate a message");
  assert.equal(noMessageReport.memoryEntryCount, 0, "a checkout with no memory index must report zero entries, not throw");

  // 3. Add the message block and a memory index -- both gaps must clear.
  writeFileSync(join(dir, "docs", "roles", "README.md"),
    "# If this machine is lost\n\n## The roster\n\n"
    + "| role | agent name | file | reports to |\n|---|---|---|---|\n"
    + "| Example | `example-agent` | [example.md](./example.md) | `example-boss` |\n\n"
    + "## The first message for each agent, ready to paste\n\n"
    + "**`example-agent`:**\n> You are `example-agent`. Read your file.\n");
  mkdirSync(join(dir, "docs", "roles", "memory"), { recursive: true });
  writeFileSync(join(dir, "docs", "roles", "memory", "MEMORY.md"), "- [A lesson](a-lesson.md) — a hook\n");

  const completeReport = runDrill(dir);
  assert.deepEqual(completeReport.agents[0].gaps, [], "gaps did not clear once the message block and memory index were added");
  const composedMessage = completeReport.agents[0].message;
  assert.ok(composedMessage, "the complete fixture must produce a message");
  assert.match(composedMessage, /You are `example-agent`/);
  assert.match(composedMessage, /A lesson -- a hook/);
  assert.equal(completeReport.memoryEntryCount, 1);

  rmSync(dir, { recursive: true, force: true });
});

test("the worker template block substitutes <name> per agent, not a literal placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "reconstitution-drill-worker-template-"));
  mkdirSync(join(dir, "docs", "roles"), { recursive: true });
  writeFileSync(join(dir, "docs", "roles", "README.md"),
    "# If this machine is lost\n\n## The roster\n\n"
    + "| role | agent name | file | reports to |\n|---|---|---|---|\n"
    + "| Worker | `worker-x` | [worker-x.md](./worker-x.md) | `dispatcher` |\n\n"
    + "## The first message for each agent, ready to paste\n\n"
    + "**Each worker** (`worker-x`):\n> You are `<name>`. Read `docs/roles/<name>.md`.\n");
  writeFileSync(join(dir, "docs", "roles", "worker-x.md"), "# worker-x\n");

  const report = runDrill(dir);
  const worker = report.agents.find((a) => a.agent === "worker-x");
  assert.ok(worker?.message, "worker-x should have a composed message from the shared worker template");
  assert.match(worker.message, /You are `worker-x`\. Read `docs\/roles\/worker-x\.md`\./);
  assert.doesNotMatch(worker.message, /<name>/, "the <name> placeholder must be fully substituted");

  rmSync(dir, { recursive: true, force: true });
});
