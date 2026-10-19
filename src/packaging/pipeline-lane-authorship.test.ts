// no-token: gh
//
// Every `gh` call in this file is a fixture: `runArmPr` and `main` take an injected `run`/`login`, and the sweep is
// driven as a real process with a fake `gh` first on PATH that records its calls and answers from a script. True of
// the IMPORT (`arm-pr.ts` and `pr-open.ts` spawn `gh`) and false of every CALL.
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
import { laneLabelsFor } from "../row-file/duplicate-title-refusal.ts";
import { laneAuthorshipRefusal, ownsReviewOnlyLane, reviewOnlyPathsIn, authorshipVerdict, ROLE_LOGIN, APP_ROLE_LANE_OWNER } from "../lane-ownership.ts";
import { GITHUB_ROLES } from "../app-token.ts";
import { runArmPr, EXIT, deliberateMarker } from "../arm-pr.ts";
import { main, EXIT_NOTHING_SENT, loginThrough } from "../pr-open.ts";
import { testEach } from "../lib/test-each.ts";

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
  assert.ok(ROLE_LOGIN.ceo.includes(LEADS), "ceo's login is the one the org's leads session acts as");
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
function driveArm({ author, files, body = "Closes #1", labels = [] as string[], lanes = LANES, tip = "abc123" }: {
  author: string; files: string[]; body?: string; labels?: string[]; lanes?: typeof LANES | null; tip?: string }) {
  const calls: string[][] = [];
  const said: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && args.includes("comments")) return JSON.stringify({ comments: [] });
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ labels: labels.map((name) => ({ name })), body, state: "OPEN", author: { login: author } });
    }
    if (args[0] === "api" && args[2]?.endsWith("/files")) return files.join("\n");
    // agent-org#1501: what a11ign's `deliberateRefusals` job asked, asked here for an org author's PR: a recorded head that IS the branch's tip, and the
    // one row the body closes resolved as GitHub would, so the PR is clear and this fixture still reaches its arming.
    if (args[0] === "api" && args[1] === "repos/a11ign/a11ign/pulls/7") {
      return JSON.stringify({ state: "open", user: { login: author }, labels: labels.map((name) => ({ name })), body,
        head: { sha: "abc123", ref: "agent/lane-7", repo: { full_name: "a11ign/a11ign" } }, base: { repo: { full_name: "a11ign/a11ign" } } });
    }
    if (args[0] === "api" && args[1] === "repos/a11ign/a11ign/git/ref/heads/agent/lane-7") return JSON.stringify({ object: { sha: tip } });
    // the row the body closes names no test, so the tests-first read has nothing to hold the PR to.
    if (args[0] === "api" && args[1] === "repos/a11ign/a11ign/issues/1") return JSON.stringify({ body: "a row naming no test" });
    if (args.some((x) => x.includes("closingIssuesReferences"))) {
      return JSON.stringify({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [
        { number: 1, title: "a row", repository: { nameWithOwner: "a11ign/a11ign" }, labels: { nodes: [] } }] } } } } });
    }
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
    assert.equal(out.merged, true, `armed: ${JSON.stringify(control)}\n${out.said}`);
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

// --- #811: an installation token cannot answer `gh api user`; the identity comes from the GraphQL viewer ---

const BOT = "a11ign-workers[bot]";
const ACCESS_403 = Object.assign(new Error("Command failed: gh api user --jq .login"),
  { stderr: "gh: Resource not accessible by integration (HTTP 403)\n" });

/** A `gh` that answers as `token` would: `api user` and the GraphQL viewer each from its own entry, a function throwing. */
function fakeGh(answers: { user: string | (() => string); viewer: string | (() => string) }) {
  const asked: string[] = [];
  const gh = (args: string[]) => {
    const which = args[0] === "api" && args[1] === "user" ? "user"
      : args[0] === "api" && args[1] === "graphql" && args.join(" ").includes("viewer") ? "viewer" : null;
    assert.ok(which, `an unexpected gh call: ${args.join(" ")}`);
    asked.push(which);
    const answer = answers[which];
    return typeof answer === "function" ? answer() : answer;
  };
  return { gh, asked };
}
const refuses403 = () => { throw ACCESS_403; };

test("#811 (1): an installation token's identity opening a diff into .github/workflows/ is NOT refused", () => {
  const { gh, asked } = fakeGh({ user: refuses403, viewer: BOT });
  const out = drivePrOpen([WORKFLOW], () => loginThrough(gh));
  assert.deepEqual(asked, ["user", "viewer"], "the viewer is asked after `api user` is refused, and only then");
  // authorship is checked BEFORE the body (`main`), and this fixture's bare body fails the later acceptance check, so "not
  // refused" is the absence of the authorship refusals, as at #3254 (3) -- and `asked` above proves the identity was read.
  assert.doesNotMatch(out.said, /Ruling item 7|could not say who|review-only lane/);
});

testEach("#811 (3): an identity NEITHER read answers is refused -- the 403 is named, and the refusal is #3254's", [
  {
    name: "POSITIVE CONTROL: the leads login, read through the SAME fallback, is still refused",
    viewer: LEADS,
    says: [{ pattern: /#1756 Ruling item 7/ }],
  },
  {
    name: "the viewer throws",
    viewer: () => { throw new Error("HTTP 502"); },
    says: [
      { pattern: /could not say who is opening it/ },
      { pattern: /Resource not accessible by integration \(HTTP 403\)/, message: "the first failure's own words, not just `Command failed`" },
    ],
  },
  {
    name: "the viewer answers nothing",
    viewer: () => "\n",
    says: [
      { pattern: /could not say who is opening it/ },
      { pattern: /Resource not accessible by integration \(HTTP 403\)/, message: "the first failure's own words, not just `Command failed`" },
    ],
  },
], (c: { viewer: string | (() => string); says: { pattern: RegExp; message?: string }[] }) => {
  const { gh } = fakeGh({ user: refuses403, viewer: c.viewer });
  const out = drivePrOpen([WORKFLOW], () => loginThrough(gh));
  assert.equal(out.code, EXIT_NOTHING_SENT);
  assert.deepEqual(out.sent, []);
  for (const s of c.says) assert.match(out.said, s.pattern, s.message);
});

test("#811 (4): a user token pays ONE call -- `api user` answering means the viewer is never asked, and an empty answer is no login", () => {
  const user = fakeGh({ user: ` ${WORKERS}\n`, viewer: () => { throw new Error("must not be asked"); } });
  assert.equal(loginThrough(user.gh), WORKERS);
  assert.deepEqual(user.asked, ["user"]);
  const empty = fakeGh({ user: "", viewer: BOT });
  assert.equal(loginThrough(empty.gh), BOT, "an empty `api user` answer is a failure, so the viewer is asked");
});

// --- #816: the managers App's bot login owns `ceo`'s lane; the workers' does not ---

const MANAGERS_BOT = "a11ign-managers[bot]";
const MANAGERS_BARE = "a11ign-managers"; // a GraphQL `Bot` author without the suffix

test("#816 (1): the managers App's login, in each spelling, authoring into .github/workflows/ is refused at pr:open", () => {
  for (const login of [MANAGERS_BOT, MANAGERS_BARE]) {
    const { gh } = fakeGh({ user: refuses403, viewer: login });
    const out = drivePrOpen([WORKFLOW], () => loginThrough(gh));
    assert.equal(out.code, EXIT_NOTHING_SENT, login);
    assert.deepEqual(out.sent, []);
    assert.match(out.said, /#1756 Ruling item 7/, login);
  }
});

test("#816 (2): the same spellings are refused by the predicate and the workers' bot is not", () => {
  for (const login of [MANAGERS_BOT, MANAGERS_BARE]) {
    assert.ok(laneAuthorshipRefusal({ author: login, files: [WORKFLOW], lanes: LANES }), login);
    assert.equal(laneAuthorshipRefusal({ author: login, files: [CARVED_OUT], lanes: LANES }), null, login);
  }
  for (const login of [BOT, "a11ign-workers", "a11ign-scheduler[bot]"]) {
    assert.equal(laneAuthorshipRefusal({ author: login, files: [WORKFLOW], lanes: LANES }), null, login);
  }
});

test("#816 (3): every App role is accounted for -- its bot login owns a role in ROLE_LOGIN, or is declared not to", () => {
  assert.deepEqual([...Object.keys(APP_ROLE_LANE_OWNER)].sort(), [...GITHUB_ROLES].sort(), "a new App role must be listed");
  for (const [role, owner] of Object.entries(APP_ROLE_LANE_OWNER)) {
    const bot = `a11ign-${role}[bot]`;
    const owned = Object.values(ROLE_LOGIN).some((logins) => logins.includes(bot));
    assert.equal(owned, owner !== null, `${role}: ${bot}`);
    if (owner !== null) assert.ok(ROLE_LOGIN[owner].includes(bot), `${role} -> ${owner}`);
  }
});

// --- #796: the managers App in `gh pr list`'s spelling, and a role the wrapper knows when no read can say the login ---

const MANAGERS_APP = "app/a11ign-managers"; // `gh pr list --json author`'s spelling, as `dependabot` is in `dependency-bot-login.ts`

test("#796 (1): `app/a11ign-managers` is the owner's login too -- refused by the predicate, and `ownsReviewOnlyLane` is true for all four spellings", () => {
  assert.ok(laneAuthorshipRefusal({ author: MANAGERS_APP, files: [WORKFLOW], lanes: LANES }));
  assert.equal(laneAuthorshipRefusal({ author: MANAGERS_APP, files: [CARVED_OUT], lanes: LANES }), null);
  assert.deepEqual([LEADS, MANAGERS_BOT, MANAGERS_BARE, MANAGERS_APP].map((a) => ownsReviewOnlyLane(a, LANES)), [true, true, true, true]);
  assert.ok(ROLE_LOGIN.ceo.includes(MANAGERS_APP));
});

test("#796 (2): a login NEITHER read answers, with a role the wrapper declares, is decided by the role -- a manager is refused, a worker is not", () => {
  const unreadable = () => fakeGh({ user: refuses403, viewer: refuses403 }).gh;
  const managers = drivePrOpen([WORKFLOW], () => loginThrough(unreadable(), "managers"));
  assert.equal(managers.code, EXIT_NOTHING_SENT);
  assert.deepEqual(managers.sent, []);
  assert.match(managers.said, /#1756 Ruling item 7/, "the lane check decided, not the could-not-say refusal");
  assert.doesNotMatch(managers.said, /could not say who is opening it/);

  // POSITIVE CONTROL: the same diff and the same unreadable reads, a role that owns no lane, is not refused for authorship
  for (const role of ["workers", "scheduler", "reviewer"]) {
    const out = drivePrOpen([WORKFLOW], () => loginThrough(unreadable(), role));
    assert.doesNotMatch(out.said, /Ruling item 7|could not say who is opening it/, role);
  }
});

test("#796 (3): no role, or a role the wrapper does not declare, is no identity -- unreadable still REFUSES, naming both failures", () => {
  for (const role of [undefined, "", "root", "constructor", "app:managers"]) {
    const { gh } = fakeGh({ user: refuses403, viewer: refuses403 });
    assert.throws(() => loginThrough(gh, role), /`gh api user`: .*403.*the GraphQL `viewer` read: .*403/, String(role));
    const out = drivePrOpen([WORKFLOW], () => loginThrough(fakeGh({ user: refuses403, viewer: refuses403 }).gh, role));
    assert.match(out.said, /could not say who is opening it/, String(role));
  }
});

test("#796 (4): a read that DOES answer outranks the role -- the role is asked only when both reads failed", () => {
  const { gh, asked } = fakeGh({ user: refuses403, viewer: BOT });
  assert.equal(loginThrough(gh, "managers"), BOT, "the viewer's login, not the role's");
  assert.deepEqual(asked, ["user", "viewer"]);
});

test("#796 (5): `app:<role>` owns only the lane its role's App is declared to; an `app:` that names no role owns nothing", () => {
  assert.deepEqual(["app:managers", "app:workers", "app:reviewer", "app:scheduler", "app:", "app:root", "app:constructor"]
    .map((a) => ownsReviewOnlyLane(a, LANES)), [true, false, false, false, false, false, false]);
});

// --- the sweep: the same predicate, or arm-pr's refusal is undone one job later ---

const SWEEP = fileURLToPath(new URL("../auto-arm-sweep.ts", import.meta.url));
const FIXTURE_PROJECT = fileURLToPath(new URL("./fixtures/host-project-paths/project", import.meta.url));

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

test("#816: arm-pr refuses the managers App's login in both spellings, and arms the workers' bot", () => {
  for (const author of [MANAGERS_BOT, MANAGERS_BARE]) {
    const out = driveArm({ author, files: [WORKFLOW] });
    assert.equal(out.code, EXIT.REFUSED, author);
    assert.equal(out.merged, false, author);
  }
  assert.equal(driveArm({ author: BOT, files: [WORKFLOW] }).merged, true);
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

// agent-org#1501: the receiving side of a11ign#5460. Both unattended doors ask what a11ign's `deliberateRefusals` job asked, so a head that is not the
// branch's recorded tip is refused ARMING (nothing merges), with the reason the job gave, and the same PR with its tip recorded is armed (the control).
test("#1501: arm-pr REFUSES to arm an org PR whose head is not the branch tip -- no merge call, and the job's reason", () => {
  const stale = driveArm({ author: WORKERS, files: ["README.md"], tip: "def456" });
  assert.equal(stale.merged, false, stale.said);
  assert.equal(stale.code, EXIT.DONE);
  assert.match(stale.said, /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  const posted = stale.calls.find((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(posted, "the refusal is said where the author looks");
  const body = String(posted[posted.indexOf("--body") + 1]);
  assert.ok(body.startsWith(deliberateMarker("GITHUB'S HEAD IS NOT THE BRANCH TIP: GitHub recorded abc123, the branch's real tip is def456.\n  Every check below belongs to the recorded head, which is not the commit that would actually merge.\n  Re-push the branch so GitHub picks up the real tip, then ask again.")), body);
  assert.notEqual(deliberateMarker("a"), deliberateMarker("b"), "a changed reason is said afresh");
  assert.equal(driveArm({ author: WORKERS, files: ["README.md"] }).merged, true, "the same PR with its tip recorded arms");
});

test("#1501: the SWEEP refuses the same head that is not the tip, and arms the same PR when it is", () => {
  const stale = driveSweep(WORKERS, ["README.md"], "def456");
  assert.equal(stale.merged, false, stale.said);
  assert.match(stale.said, /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.equal(driveSweep(WORKERS, ["README.md"]).merged, true);
});

test("#1501: an arm-pr for a PR by no org identity is not asked about its head -- the refusal never reaches an outside contributor", () => {
  const out = driveArm({ author: "an-outside-contributor", files: ["README.md"], tip: "def456" });
  assert.doesNotMatch(out.said, /BRANCH TIP/);
  assert.equal(out.calls.some((a) => a[0] === "api" && String(a[1]).includes("/git/ref/heads/")), false, "no tip was read for it");
});
