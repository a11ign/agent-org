// no-token: gh
//
// Every `gh` call in this file is a fixture: `runArmPr` and `main` take an injected `run`/`login`, and the sweep is
// driven as a real process with a fake `gh` first on PATH that records its calls and answers from a script. True of
// the IMPORT (`arm-pr.mjs` and `pr-open.mjs` spawn `gh`) and false of every CALL.
/**
 * #3254, #1756 RULING ITEM 7: `ceo`, `product-manager` and `orchestrator` do not author pull requests touching
 * `.github/workflows/`, and nothing made that true. Four PRs from `a11ign-ai-leads` touched the pipeline in about a day
 * (#3238, #3196, #3109, #3066), three of them for rows (#3211, #3180, #3054) that `laneLabelsFor` had filed `lane:ceo`,
 * which `laneReason` refuses every OTHER session at claim time -- so the practice could not be followed.
 *
 * TWO DEFECTS, ONE CAUSE, SO ONE FILE:
 *   1. the filing derivation reserved a path-only pipeline row for its REVIEWER (`laneLabelsFor`);
 *   2. with that fixed, nothing stopped the leads login opening or arming a pipeline PR anyway.
 *
 * WHICH DOOR. `arm-pr` runs in CI on the PR's OWN event, so a bare `gh pr create` cannot walk around it; `pr-open` is only
 * the door the org's sessions use, and so is the early, cheap half. `auto-arm-sweep` arms every open PR on the same event,
 * so a refusal in `arm-pr` alone would be undone one job later: it asks the same predicate.
 *
 * THERE IS NO OVERRIDE, and the controls below assert the ABSENCE rather than assume it: a body line, a label or an
 * extra argument of any spelling leaves the refusal where it was.
 *
 * The lane data is built here, never read from the project's own `docs/lane-ownership.json`: a test that read it would
 * pass or fail on whether the project had merged its `reviewOnly` field, and the tool's suite must not depend on that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWEEP_WAIT_ENV } from "../auto-arm-sweep.ts";
import { laneLabelsFor } from "../row-file.ts";
import { laneAuthorshipRefusal, ownsReviewOnlyLane, reviewOnlyPathsIn, authorshipVerdict, ROLE_LOGIN } from "../lane-ownership.ts";
import { runArmPr, EXIT } from "../arm-pr.ts";
import { main, EXIT_NOTHING_SENT } from "../pr-open.ts";

const LEADS = "a11ign-ai-leads";
const WORKERS = "a11ign-ai-workers";
const WORKFLOW = ".github/workflows/ci.yml";
const CARVED_OUT = ".github/workflows/consumer-gate.yml";

const PIPELINE = { lane: "the pipeline", owner: "ceo", branchPrefixes: ["ceo/"], paths: [".github/workflows/"],
  why: "trunk health", except: [CARVED_OUT], reviewOnly: true };
const DOCS = { lane: "docs", owner: "pm", branchPrefixes: ["pm/"], paths: ["docs/"], why: "docs" };
const LANES = { lanes: [PIPELINE] };

// --- 1. the derivation: a review-only lane protects REVIEW, so a path-only row is anybody's ---

test("#3254 (1): a Region whose only lane-matching paths are in .github/workflows/ derives lane:any", () => {
  assert.deepEqual(laneLabelsFor([WORKFLOW], LANES), ["lane:any"]);
  assert.deepEqual(laneLabelsFor([WORKFLOW, ".github/workflows/release.yml"], LANES), ["lane:any"]);
  assert.deepEqual(laneLabelsFor([".github/workflows/"], LANES), ["lane:any"], "a directory entry too (#941's shape)");
});

test("#3254 (1): a Region touching the pipeline AND another lane keeps the OTHER lane's label, and only that", () => {
  assert.deepEqual(laneLabelsFor([WORKFLOW, "docs/README.md"], { lanes: [PIPELINE, DOCS] }), ["lane:pm"]);
});

test("#3254 (1): consumer-gate.yml still derives nothing for the pipeline", () => {
  assert.deepEqual(laneLabelsFor([CARVED_OUT], LANES), ["lane:any"]);
  assert.deepEqual(laneLabelsFor([CARVED_OUT, "docs/README.md"], { lanes: [PIPELINE, DOCS] }), ["lane:pm"]);
});

test("#3254 (1) POSITIVE CONTROL: the SAME lane WITHOUT reviewOnly still derives lane:<owner> -- the flag is what moved it, "
  + "so a lane that really is the owner's alone is not silently opened", () => {
  const { reviewOnly: _dropped, ...ownerOnly } = PIPELINE;
  assert.deepEqual(laneLabelsFor([WORKFLOW], { lanes: [ownerOnly] }), ["lane:ceo"]);
  assert.equal(_dropped, true, "the control really did remove the flag");
});

// --- 2. the predicate: who may author into a review-only lane ---

test("#3254 (2): the owner's login authoring a PR that touches a non-carved-out lane path is refused, naming the row and the ruling", () => {
  const refusal = laneAuthorshipRefusal({ author: LEADS, files: ["README.md", WORKFLOW], lanes: LANES });
  assert.ok(refusal, "the leads login is refused");
  assert.match(refusal, /#3254/);
  assert.match(refusal, /#1756 Ruling item 7/);
  assert.match(refusal, /\.github\/workflows\/ci\.yml/, "it names the path that did it");
  assert.equal(ROLE_LOGIN.ceo, LEADS, "ceo's login is the one the org's leads session acts as");
});

test("#3254 (3) POSITIVE CONTROLS, each its own case: the same PR from the workers login is NOT refused", () => {
  assert.equal(laneAuthorshipRefusal({ author: WORKERS, files: [WORKFLOW], lanes: LANES }), null);
});

test("#3254 (3): a leads PR touching ONLY consumer-gate.yml is NOT refused", () => {
  assert.equal(laneAuthorshipRefusal({ author: LEADS, files: [CARVED_OUT], lanes: LANES }), null);
});

test("#3254 (3): a leads PR touching ONLY non-lane paths is NOT refused", () => {
  assert.equal(laneAuthorshipRefusal({ author: LEADS, files: ["README.md", "docs/x.md"], lanes: LANES }), null);
});

test("#3254 (3): a lane WITHOUT reviewOnly refuses nobody -- the refusal is the ruling's, not every lane's", () => {
  const { reviewOnly: _flag, ...ownerOnly } = PIPELINE;
  assert.equal(laneAuthorshipRefusal({ author: LEADS, files: [WORKFLOW], lanes: { lanes: [ownerOnly] } }), null);
  assert.equal(_flag, true);
});

test("#3254: no lanes file (an outside contributor's checkout) and no author each answer null, not a refusal and not a throw", () => {
  assert.equal(laneAuthorshipRefusal({ author: LEADS, files: [WORKFLOW], lanes: null }), null);
  assert.equal(laneAuthorshipRefusal({ author: null, files: [WORKFLOW], lanes: LANES }), null);
  assert.equal(ownsReviewOnlyLane(LEADS, null), false);
  assert.deepEqual(reviewOnlyPathsIn([WORKFLOW], null), []);
});

test("#3254 (3), THE ABSENCE OF AN OVERRIDE IS ASSERTED: no spelling of one changes the answer for the leads login", () => {
  const spellings = [
    { body: "Lane-exception: pipeline -- assigned by ceo, because the queue is stalled" },
    { laneException: "ceo", override: true, force: true, skip: true },
    { labels: ["lane:any", "lane-exception", "override"], body: "Outside-Region: .github/workflows/ci.yml — deliberate" },
  ];
  for (const extra of spellings) {
    const refusal = laneAuthorshipRefusal({ author: LEADS, files: [WORKFLOW], lanes: LANES, ...extra } as never);
    assert.ok(refusal, `still refused with ${JSON.stringify(extra)}`);
  }
});

// --- the door every pipeline PR passes through: arm-pr, driven with real shapes ---

/** Drives `runArmPr` for a PR by `author` touching `files`, with `body` and `labels` on it, recording every `gh` call. */
function driveArm({ author, files, body = "Closes #1", labels = [] as string[], lanes = LANES }: {
  author: string; files: string[]; body?: string; labels?: string[]; lanes?: typeof LANES | null }) {
  const calls: string[][] = [];
  const said: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ labels: labels.map((name) => ({ name })), body, state: "OPEN", author: { login: author } });
    }
    if (args[0] === "api" && args[2]?.endsWith("/files")) return files.join("\n");
    // #3487: the queue history `arm-pr` now asks last -- never queued, so never ejected.
    if (args.some((x) => x.includes("timelineItems"))) return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } });
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ labels: [], blockedBy: { nodes: [], totalCount: 0 } });
    return "";
  };
  const code = runArmPr({ argv: ["--pr=7", "--repo=a11ign/a11ign"], env: {}, run: run as never, sleep: () => "ok" as const,
    log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes });
  const merged = calls.some((a) => a[0] === "pr" && a[1] === "merge");
  return { code, said: said.join("\n"), merged, calls };
}

test("#3254 (2): arm-pr REFUSES a leads-login PR touching the pipeline -- exit REFUSED, no merge call, names the row and the ruling", () => {
  const out = driveArm({ author: LEADS, files: ["README.md", WORKFLOW] });
  assert.equal(out.code, EXIT.REFUSED);
  assert.equal(out.merged, false, "nothing was armed");
  assert.match(out.said, /#3254/);
  assert.match(out.said, /#1756 Ruling item 7/);
});

test("#3254 (3): arm-pr takes NO override -- a Lane-exception line, an Outside-Region line and every label leave it refused", () => {
  const bodies = ["Closes #1\n\nLane-exception: pipeline -- ceo assigned this", "Closes #1\nOutside-Region: .github/workflows/ci.yml — deliberate",
    "Closes #1\n\nOverride: yes"];
  for (const body of bodies) {
    const out = driveArm({ author: LEADS, files: [WORKFLOW], body, labels: ["lane:any", "lane-exception", "override"] });
    assert.equal(out.code, EXIT.REFUSED, body);
    assert.equal(out.merged, false, body);
  }
});

test("#3254 (3) POSITIVE CONTROLS at arm-pr: the workers login, a consumer-gate-only PR and a non-lane PR from the leads login ARE armed", () => {
  for (const control of [{ author: WORKERS, files: [WORKFLOW] }, { author: LEADS, files: [CARVED_OUT] },
    { author: LEADS, files: ["README.md"] }]) {
    const out = driveArm(control);
    assert.equal(out.merged, true, `armed: ${JSON.stringify(control)}`);
    assert.notEqual(out.code, EXIT.REFUSED, JSON.stringify(control));
  }
});

test("#3254: a file list that cannot be read is CANNOT_ASK for the leads login -- never 'clear' -- and costs every OTHER author no call", () => {
  const calls: string[][] = [];
  const failing = authorshipVerdict({ number: "7", repo: "a11ign/a11ign", author: LEADS, lanes: LANES,
    run: (args) => { calls.push(args); throw new Error("HTTP 502"); } });
  assert.equal(failing.kind, "cannot-ask");
  const before = calls.length;
  const workers = authorshipVerdict({ number: "7", repo: "a11ign/a11ign", author: WORKERS, lanes: LANES,
    run: (args) => { calls.push(args); throw new Error("must not be asked"); } });
  assert.deepEqual(workers, { kind: "clear" });
  assert.equal(calls.length, before, "the workers login's PR read no file list");
});

test("#3254: a HELD PR is not armed and is not refused -- the refusal speaks only when the run was about to arm", () => {
  const out = driveArm({ author: LEADS, files: [WORKFLOW], labels: ["hold:worker-1"] });
  assert.equal(out.merged, false);
  assert.equal(out.code, EXIT.DONE);
  assert.doesNotMatch(out.said, /Ruling item 7/);
});

// --- pr-open: the cheap early half, before anything runs or is sent ---

const ARGS = ["--head", "agent/x", "--body", "Acceptance:\n```bash\ntrue\n```\nCloses: none — a test"];

/** `main` for `create` over a diff of `files`, as `login`, reporting the exit code and whether anything was SENT. */
function drivePrOpen(files: string[], login: () => string) {
  const sent: string[][] = [];
  const err: string[] = [];
  const git = (args: string[]) => {
    if (args[0] === "diff") return files.join("\0");
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "agent/x";
    return "abc123";
  };
  const code = main(["create", ...ARGS], { git, login, lanes: LANES, run: (a) => { sent.push(a); },
    runAcceptance: () => 0, runMutation: () => 0, owner: () => null, out: () => {}, err: (l) => err.push(l) });
  return { code, sent, said: err.join("") };
}

test("#3254 (2): pr-open REFUSES a leads-login create touching the pipeline, before anything is sent", () => {
  const out = drivePrOpen([WORKFLOW], () => LEADS);
  assert.equal(out.code, EXIT_NOTHING_SENT);
  assert.deepEqual(out.sent, []);
  assert.match(out.said, /#3254/);
  assert.match(out.said, /#1756 Ruling item 7/);
});

test("#3254 (3) POSITIVE CONTROLS at pr-open: workers login, consumer-gate-only and non-lane diffs are not refused for authorship", () => {
  for (const [files, login] of [[[WORKFLOW], WORKERS], [[CARVED_OUT], LEADS], [["README.md"], LEADS]] as const) {
    const out = drivePrOpen([...files], () => login);
    assert.doesNotMatch(out.said, /Ruling item 7/, `${files} as ${login}`);
  }
});

test("#3254: pr-open asks `gh api user` ONLY when the diff touches a review-only lane -- an ordinary PR costs no call", () => {
  let asked = 0;
  drivePrOpen(["README.md"], () => { asked += 1; return LEADS; });
  assert.equal(asked, 0);
  drivePrOpen([WORKFLOW], () => { asked += 1; return WORKERS; });
  assert.equal(asked, 1);
});

test("#3254: a login pr-open cannot read REFUSES a pipeline diff -- unreadable is not 'not the leads login'", () => {
  const out = drivePrOpen([WORKFLOW], () => { throw new Error("HTTP 401"); });
  assert.equal(out.code, EXIT_NOTHING_SENT);
  assert.deepEqual(out.sent, []);
  assert.match(out.said, /could not say who is opening it/);
});

// --- the sweep: the same predicate, or arm-pr's refusal is undone one job later ---

const SWEEP = fileURLToPath(new URL("../auto-arm-sweep.ts", import.meta.url));
const FIXTURE_PROJECT = fileURLToPath(new URL("./fixtures/host-project-paths/project", import.meta.url));

/**
 * Runs the real sweep as a process over ONE open PR (#7), with a fake `gh` that answers from its arguments and records
 * them. The project is the fixture one, copied, with `PIPELINE` as its only lane -- the sweep reads its lanes the way
 * production does, through `HOME_CHECKOUT`, and nothing here imports a project's own file.
 */
function driveSweep(author: string, files: string[]) {
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

test("#3254 (3) POSITIVE CONTROLS at the sweep: the workers login, and a leads PR off the pipeline, ARE armed", () => {
  for (const [author, files] of [[WORKERS, [WORKFLOW]], [LEADS, ["README.md"]], [LEADS, [CARVED_OUT]]] as const) {
    const out = driveSweep(author, [...files]);
    assert.equal(out.merged, true, `${author} ${files}: ${out.said}`);
  }
});
