// no-token: gh -- the `gh` here is a stub first on PATH of a spawned sweep; nothing reaches GitHub
/**
 * #3254, #816, #1501, AS A REAL PROCESS: THE SWEEP OVER ONE OPEN PULL REQUEST, with a stub `gh` first on PATH that records its calls and answers from a script.
 *
 * Moved from `src/packaging/pipeline-lane-authorship.test.ts` (A11-160, step 5). `arm-pr`'s refusal is undone one job later unless the sweep, which arms every open PR on the same event, asks the same
 * predicate; the DECISION is core's and the same fixture drives `arm-pr` on the fake code host there. What a process shows is that the real sweep reads its lanes as production does, reaches `gh`
 * THROUGH THE GITHUB PLUGIN, and makes or does not make the arm. It is the plugin's end-to-end test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWEEP_WAIT_ENV } from "../../../src/auto-arm-sweep.ts";

const LEADS = "a11ign-ai-leads";
const WORKERS = "a11ign-ai-workers";
const WORKFLOW = ".github/workflows/ci.yml";
const CARVED_OUT = ".github/workflows/consumer-gate.yml";
const BOT = "a11ign-workers[bot]";
const MANAGERS_BOT = "a11ign-managers[bot]";
const MANAGERS_BARE = "a11ign-managers"; // a GraphQL `Bot` author without the suffix

const PIPELINE = { lane: "the pipeline", owner: "ceo", branchPrefixes: ["ceo/"], paths: [".github/workflows/"],
  why: "trunk health", except: [CARVED_OUT], reviewOnly: true };
const LANES = { lanes: [PIPELINE] };

// --- the sweep: the same predicate, or arm-pr's refusal is undone one job later ---

const SWEEP = fileURLToPath(new URL("../../../src/auto-arm-sweep.ts", import.meta.url));
const FIXTURE_PROJECT = fileURLToPath(new URL("../../../src/packaging/fixtures/host-project-paths/project", import.meta.url));

/**
 * Runs the real sweep as a process over ONE open PR (#7), with a fake `gh` that answers from its arguments and records
 * them. The project is the fixture one, copied, with `PIPELINE` as its only lane -- the sweep reads its lanes the way
 * production does, through `HOME_CHECKOUT`, and nothing here imports a project's own file.
 */
function driveSweep(author: string, files: string[], tip = "abc123") {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-lane-sweep-"));
  try {
    const project = join(dir, "project");
    cpSync(FIXTURE_PROJECT, project, { recursive: true });
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "lane-ownership.json"), JSON.stringify(LANES));
    const hostFile = join(dir, "host.json");
    writeFileSync(hostFile, JSON.stringify({ schema: 1, home: dir, binDir: join(dir, "bin"), primary: "fixture",
      projects: [{ id: "fixture", checkout: project }],
      gh: { workers: join(dir, "workers"), leads: join(dir, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$*" in
  *timelineItems*) echo '{"mergeQueueEntry":null,"timelineItems":{"nodes":[]}}' ;;
  "api repos/a11ign/a11ign/pulls/7") echo '{"state":"open","user":{"login":"${author}"},"labels":[],"body":"Closes #1","head":{"sha":"abc123","ref":"agent/lane-7","repo":{"full_name":"a11ign/a11ign"}},"base":{"repo":{"full_name":"a11ign/a11ign"}}}' ;;
  "api repos/a11ign/a11ign/git/ref/heads/agent/lane-7") echo '{"object":{"sha":"${tip}"}}' ;;
  *closingIssuesReferences*) echo '{"data":{"repository":{"pullRequest":{"closingIssuesReferences":{"nodes":[{"number":1,"title":"a row","repository":{"nameWithOwner":"a11ign/a11ign"},"labels":{"nodes":[]}}]}}}}}' ;;
  *"api graphql"*) echo '[{"number":7,"isDraft":false,"merged":false,"autoMergeRequest":null,"mergeQueueEntry":null}]' ;;
  *"--json labels"*) echo '[]' ;;
  *"--json author"*) echo '${author}' ;;
  *"--json headRefOid"*) echo abc123 ;;
  *"check-runs"*) echo 3 ;;
  *"/files"*) printf '%s\\n' ${files.map((f) => `'${f}'`).join(" ")} ;;
esac
`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const run = spawnSync(process.execPath, [SWEEP], { encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: hostFile,
      GITHUB_REPOSITORY: "a11ign/a11ign", [SWEEP_WAIT_ENV]: "0", PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    return { said: run.stdout + run.stderr, merged: calls.some((c) => c.startsWith("pr merge")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3254 (2): the SWEEP, a second unattended door that arms, refuses the leads-login pipeline PR arm-pr refused", () => {
  const out = driveSweep(LEADS, [WORKFLOW]);
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SKIPPED/);
  assert.match(out.said, /#1756 Ruling item 7/);
});


test("#816: the SWEEP refuses the managers App's login in both spellings", () => {
  for (const author of [MANAGERS_BOT, MANAGERS_BARE]) {
    const out = driveSweep(author, [WORKFLOW]);
    assert.equal(out.merged, false, out.said);
    assert.match(out.said, /#1756 Ruling item 7/);
  }
  assert.equal(driveSweep(BOT, [WORKFLOW]).merged, true);
});

test("#3254 (3) POSITIVE CONTROLS at the sweep: the workers login, and a leads PR off the pipeline, ARE armed", () => {
  for (const [author, files] of [[WORKERS, [WORKFLOW]], [LEADS, ["README.md"]], [LEADS, [CARVED_OUT]]] as const) {
    const out = driveSweep(author, [...files]);
    assert.equal(out.merged, true, `${author} ${files}: ${out.said}`);
  }
});


test("#1501: the SWEEP refuses the same head that is not the tip, and arms the same PR when it is", () => {
  const stale = driveSweep(WORKERS, ["README.md"], "def456");
  assert.equal(stale.merged, false, stale.said);
  assert.match(stale.said, /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.equal(driveSweep(WORKERS, ["README.md"]).merged, true);
});

