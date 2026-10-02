// no-token: gh
//
// Nothing here reaches the network or a real `gh`. Every git command runs in a disposable repository built by `withGitSandbox`, and every
// host and project this file renders is a temp directory it builds and deletes.

/**
 * #2793 (child 5b of #2623): THE HOST READS `tool`, `stateDir` AND `beforeTick`, THE `work-tick` UNIT RENDERS DECISION 3'S FORM, AND THE
 * TOOL HAS AN `update` COMMAND -- with the running unit untouched.
 *
 * ADR 0040's decision 3 describes an installed form (the tool run from its own checkout, pointed at projects by `host.json`) and the
 * reader that #2620 shipped read none of its three new fields, so nobody owned the seam between "the reader" and "the install". This
 * file is that seam's test. **It changes nothing that runs**: a11ign's `host.json` names no `tool`, so its `work-tick` unit is still
 * today's bytes (asserted below against the digest `host-project-paths.test.ts` pins, and by that file, unchanged, from the other
 * side). Editing a11ign's `host.json` and reinstalling the unit is #2623's cut-over, after the shadow window.
 *
 * WHAT IT DOES NOT COVER. `stateDir` is READ and VALIDATED here, and the readers of the org's state entries that already derive their
 * paths from one ledger path (`wake.mjs`'s queue, spare, reviewer and kept-claim paths) are shown to follow it. FOUR CONSTANTS STILL
 * SPELL `~/.cache/a11ign` -- `DRAIN_MARKER` and `REVIEWER_STATE_DIR` in `work-gate.mjs`, `LIVE_STATE_DIR` in `shadow-gate.mjs`, and the
 * default of `ledgerPathFrom` in `wake.mjs` -- and those files are other rows' Regions, so wiring them to `stateFilePath` is not done
 * here. The last test below reads `ledgerPathFrom([])` so that the residue is a named value rather than a claim of absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_DIR, TOOL_UPDATE_EXEC, shippedUnitText, workTickToolForm } from "../host-units.mjs";
import { HostConfigRefusal, homeHostConfig, parseBeforeTick, parseHostConfig, renderTemplate, stateFilePath, templateValues }
  from "../host-config.mjs";
import { handoffQueuePath, keptClaimsPath, ledgerPathFrom, reviewerPathsFrom, sparePathsFrom } from "../wake.mjs";
import { updateTool } from "../update-tool.mjs";
import { sandboxGitEnv, withGitSandbox } from "../lib/git-sandbox.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The digest of the `work-tick` unit the host runs today: the one `host-project-paths.test.ts` pins as `TODAYS_TEXT`, restated so this file's claim is checkable alone. */
const TODAYS_WORK_TICK_SHA = "b566128df67e75cf012540a9aa8d75a7d9a2fb91d32e12ad901f7b8bce8a171e";

/** A host that is nothing like a11ign's: a different account, prefix, home, state directory and project set. */
const acmeHost = (extra: Record<string, unknown> = {}) => ({
  schema: 1, home: "/srv/acme", binDir: "/srv/acme/bin", primary: "widgets",
  projects: [{ id: "widgets", checkout: "/srv/acme/repos/widgets" }, { id: "gadgets", checkout: "/srv/acme/repos/gadgets" }],
  gh: { workers: "/srv/acme/workers", leads: "/srv/acme/leads", leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
  ...extra,
});
const parse = (host: Record<string, unknown>) => parseHostConfig(JSON.stringify(host), "acme host.json");
const ACME_UNITS = { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] as string[] };

function refusal(fn: () => unknown): HostConfigRefusal {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HostConfigRefusal, `expected a HostConfigRefusal, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal, and nothing was refused" });
}

// --- 1. the reader: `tool`, `stateDir`, and a project's `beforeTick` ---------------------------------------------------------------

test("#2793: `tool` and `stateDir` are read when present, and the KEY IS ABSENT when they are not", () => {
  const without = parse(acmeHost());
  assert.equal(Object.hasOwn(without, "tool"), false, "a host with no tool has no `tool` key, so a deepEqual of today's host is unchanged");
  assert.equal(Object.hasOwn(without, "stateDir"), false);
  const withBoth = parse(acmeHost({ tool: "/srv/acme/tools/agent-org", stateDir: "/srv/acme/state" }));
  assert.equal(withBoth.tool, "/srv/acme/tools/agent-org");
  assert.equal(withBoth.stateDir, "/srv/acme/state");
  assert.notDeepEqual(without, withBoth, "POSITIVE CONTROL: the two hosts differ, so the reads above are of two different things");
});

test("#2793: a malformed `tool` or `stateDir` is REFUSED NAMING THE FIELD", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["a relative tool", { tool: "tools/agent-org" }, "tool"],
    ["a null tool", { tool: null }, "tool"],
    ["a numeric tool", { tool: 7 }, "tool"],
    ["a tool with a trailing slash", { tool: "/srv/acme/tools/agent-org/" }, "tool"],
    ["a tool a unit line would split", { tool: "/srv/acme/my tools/agent-org" }, "tool"],
    ["a tool carrying a systemd specifier", { tool: "/srv/acme/%h/agent-org" }, "tool"],
    ["a tool that IS a project's checkout", { tool: "/srv/acme/repos/widgets" }, "tool"],
    ["a tool INSIDE a project's checkout", { tool: "/srv/acme/repos/gadgets/tools/agent-org" }, "tool"],
    ["a relative stateDir", { stateDir: "state" }, "stateDir"],
    ["an empty stateDir", { stateDir: "" }, "stateDir"],
    ["a list stateDir", { stateDir: ["/srv/acme/state"] }, "stateDir"],
  ];
  assert.ok(cases.length >= 10, "POSITIVE CONTROL: the table is not empty");
  for (const [what, extra, field] of cases) {
    assert.equal(refusal(() => parse(acmeHost(extra))).field, field, `${what} must be refused, naming \`${field}\``);
  }
});

test("#2793: a tool BESIDE a project's checkout is not inside it (`widgets-tool` is not under `widgets`)", () => {
  assert.equal(parse(acmeHost({ tool: "/srv/acme/repos/widgets-tool" })).tool, "/srv/acme/repos/widgets-tool",
    "the prefix test is on `checkout + /`, so a sibling whose name starts with the same letters is allowed");
});

test("#2793: a project's `beforeTick` is read, ABSENT is null, and a malformed one is refused naming the field", () => {
  assert.equal(parseBeforeTick('{"schema":1,"beforeTick":"npm run primary:update"}'), "npm run primary:update");
  assert.equal(parseBeforeTick('{"schema":1}'), null, "a project may need no command");
  const bad: [string, string][] = [
    ["a number", '{"beforeTick":3}'], ["null", '{"beforeTick":null}'], ["empty", '{"beforeTick":""}'],
    ["leading space", '{"beforeTick":" npm run x"}'], ["a command separator", '{"beforeTick":"npm run x; rm -rf y"}'],
    ["a pipeline", '{"beforeTick":"a | b"}'], ["a variable", '{"beforeTick":"echo $HOME"}'],
    ["a systemd specifier", '{"beforeTick":"npm run %h"}'], ["a quote", '{"beforeTick":"npm run \\"x\\""}'],
    ["a newline", '{"beforeTick":"npm run x\\nrm y"}'],
  ];
  for (const [what, text] of bad) {
    assert.equal(refusal(() => parseBeforeTick(text, "project.json")).field, "beforeTick", `${what} must be refused, naming \`beforeTick\``);
  }
  assert.equal(refusal(() => parseBeforeTick("{not json")).field, "(file)");
});

// --- 2. the unit: today's text without `tool`, decision 3's three lines with it ------------------------------------------------------

/** Two project checkouts on disk, each with a declaration, the second asking for a command before each tick. */
function withProjects<T>(fn: (dirs: { widgets: string; gadgets: string; tool: string }) => T): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-host-tool-")));
  try {
    const dirs = { widgets: join(root, "repos/widgets"), gadgets: join(root, "repos/gadgets"), tool: join(root, "tools/agent-org") };
    for (const [name, beforeTick] of [["widgets", 'npm run widgets:update'], ["gadgets", undefined]] as const) {
      mkdirSync(join(dirs[name], ".agent-org"), { recursive: true });
      writeFileSync(join(dirs[name], ".agent-org/project.json"), JSON.stringify({ schema: 1, ...(beforeTick ? { beforeTick } : {}) }));
    }
    return fn(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hostAt = (dirs: { widgets: string; gadgets: string; tool: string }, extra: Record<string, unknown>) => parse(acmeHost({
  projects: [{ id: "widgets", checkout: dirs.widgets }, { id: "gadgets", checkout: dirs.gadgets }], ...extra,
}));
const workTickOf = (host: ReturnType<typeof parse>) => shippedUnitText("acme-work-tick.service", { host, units: ACME_UNITS }) ?? "";

/** The lines of `a` that are not lines of `b`, comments left out: what a form ADDED, in order. */
const linesOnlyIn = (a: string, b: string) => a.split("\n").filter((line) => line !== "" && !line.startsWith("#") && !b.split("\n").includes(line));

test("#2793: with NO `tool` the work-tick unit is today's text BYTE FOR BYTE -- a11ign's, and any host's", () => {
  assert.equal(homeHostConfig().tool, undefined, "POSITIVE CONTROL: a11ign's host.json names no tool, so this is the running unit");
  assert.equal(homeHostConfig().stateDir, undefined, "and no stateDir: a11ign's host.json is not edited by this row (#2623 does)");
  assert.equal(sha256(shippedUnitText("a11ign-work-tick.service") ?? ""), TODAYS_WORK_TICK_SHA, "the unit the host runs, unchanged");
  withProjects((dirs) => {
    const host = hostAt(dirs, {});
    const template = readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8");
    assert.equal(workTickOf(host), renderTemplate(template, templateValues(host, ACME_UNITS), "work-tick"),
      "a host without `tool` gets the plain render of the template, which is what it got before this row");
  });
});

test("#2793: with `tool` set, EXACTLY THREE lines are decision 3's and the rest of the text is today's", () => {
  withProjects((dirs) => {
    const plain = workTickOf(hostAt(dirs, {}));
    const installed = workTickOf(hostAt(dirs, { tool: dirs.tool }));
    assert.notEqual(installed, plain, "POSITIVE CONTROL: the two renderings differ, so `equal` above is not one text compared to itself");
    assert.deepEqual(linesOnlyIn(plain, installed), [
      "WorkingDirectory=" + dirs.widgets,
      "ExecStartPre=-/usr/bin/npm run primary:update",
      "ExecStart=/usr/bin/node packages/agent-org/src/work-tick.mjs",
    ], "the three lines that leave");
    assert.deepEqual(linesOnlyIn(installed, plain), [
      "WorkingDirectory=" + dirs.tool,
      "ExecStartPre=-" + TOOL_UPDATE_EXEC,
      `ExecStartPre=-/usr/bin/env -C ${dirs.widgets} npm run widgets:update`,
      "ExecStart=/usr/bin/node src/work-tick.mjs",
    ], "the tool's path, then the tool update and THEN the declared beforeTick, then the shorter ExecStart");
    const order = installed.split("\n").filter((line) => line.startsWith("ExecStartPre="));
    assert.deepEqual(order, ["ExecStartPre=-" + TOOL_UPDATE_EXEC, `ExecStartPre=-/usr/bin/env -C ${dirs.widgets} npm run widgets:update`],
      "the gadgets project declares none, so it adds no line: only a declared beforeTick runs");
  });
});

test("#2793: the tool update the rendered ExecStartPre names EXISTS, at the path it names relative to the tool's `src/`", () => {
  const script = /node (src\/update-tool\.mjs)$/.exec(TOOL_UPDATE_EXEC)?.[1];
  assert.equal(script, "src/update-tool.mjs", "POSITIVE CONTROL: the command names a script, so the existence check below is of something");
  assert.ok(existsSync(join(SHIPPED_DIR, "..", script ?? "")), "the monorepo keeps the tool's `src/` at packages/agent-org/src");
});

test("#2793: a template edited out from under the tool form REFUSES, and never installs a unit still in the old form", () => {
  const template = readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8");
  const rendered = renderTemplate(template, templateValues(parse(acmeHost()), ACME_UNITS), "work-tick");
  assert.match(workTickToolForm(rendered, "/srv/acme/tools/agent-org", []), /^WorkingDirectory=\/srv\/acme\/tools\/agent-org$/m,
    "POSITIVE CONTROL: the intact text is transformed");
  const noStart = rendered.replace(/^ExecStart=.*$/m, "");
  assert.equal(refusal(() => workTickToolForm(noStart, "/srv/acme/tools/agent-org", [])).name, "HostConfigRefusal", "an anchor that matches nothing");
  const twoPre = rendered.replace(/^ExecStartPre=.*$/m, (line) => `${line}\n${line}`);
  assert.equal(refusal(() => workTickToolForm(twoPre, "/srv/acme/tools/agent-org", [])).name, "HostConfigRefusal", "an anchor that matches twice");
});

test("#2793: a project whose declaration cannot be read, or holds a bad beforeTick, refuses the render", () => {
  withProjects((dirs) => {
    writeFileSync(join(dirs.gadgets, ".agent-org/project.json"), JSON.stringify({ schema: 1, beforeTick: "npm run x | tee y" }));
    assert.equal(refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))).field, "beforeTick");
    rmSync(join(dirs.gadgets, ".agent-org/project.json"));
    assert.equal(refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))).field, "(file)",
      "an unreadable declaration is a refusal, not a skipped project whose checkout would go stale unseen");
  });
});

// --- 3. stateDir: a different one changes every path the readers use --------------------------------------------------------------

test("#2793: a fixture host's `stateDir` moves every state path the readers derive, and a11ign's is not among them", () => {
  const host = parse(acmeHost({ stateDir: "/srv/acme/state" }));
  const ledger = stateFilePath(host, "wake-ledger");
  assert.equal(ledger, "/srv/acme/state/wake-ledger");
  const spare = sparePathsFrom(ledger);
  const reviewer = reviewerPathsFrom(ledger);
  const paths = [ledgerPathFrom([`--ledger=${ledger}`]), handoffQueuePath(ledger), keptClaimsPath(ledger), ...Object.values(spare), ...Object.values(reviewer)];
  assert.equal(paths.length, 3 + Object.keys(spare).length + Object.keys(reviewer).length,
    "POSITIVE CONTROL: every path the readers derive is checked -- the count is the three singles plus each spare and reviewer path, derived from the two objects rather than floored");
  assert.ok(Object.keys(spare).length > 0 && Object.keys(reviewer).length > 0, "POSITIVE CONTROL: both derivations name paths, so the count above is not 3 + 0 + 0");
  const a11ignState = ledgerPathFrom([]).replace(/\/wake-ledger$/, "");
  assert.match(a11ignState, /\/\.cache\/a11ign$/, "POSITIVE CONTROL: the default IS a11ign's directory, so the exclusion below is against something");
  const outside = paths.filter((path) => !path.startsWith("/srv/acme/state/") || path.startsWith(`${a11ignState}/`));
  assert.deepEqual(outside, [], "every reader's path is under the fixture's stateDir, and none is under a11ign's");
});

test("#2793: a host with no `stateDir` gets a REFUSAL from `stateFilePath`, never a11ign's directory", () => {
  assert.equal(refusal(() => stateFilePath(parse(acmeHost()), "wake-ledger")).field, "stateDir");
  assert.equal(refusal(() => stateFilePath(homeHostConfig(), "wake-ledger")).field, "stateDir", "and a11ign's own host.json, unedited, declares none");
});

// --- 4. `update-tool`: moves to origin/main, refuses a dirty tree, touches no other checkout ---------------------------------

/** git in a directory, with every `GIT_*` variable stripped so a leaked one cannot reach a real repository. */
const gitAt = (dir: string) => (args: string[]) => execFileSync("git", args, { cwd: dir, env: sandboxGitEnv(), encoding: "utf8" });

/** An upstream on `main` with one commit and two clones of it (the tool and a project's checkout), each at that commit. */
function withUpstreamAndClones<T>(fn: (ctx: { upstream: ReturnType<typeof gitAt>; commit: (name: string) => string;
  tool: string; project: string; at: typeof gitAt }) => T): T {
  return withGitSandbox((sandbox) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "a11y-update-tool-")));
    try {
      sandbox.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      const commit = (name: string) => {
        writeFileSync(join(sandbox.dir, "file.txt"), `${name}\n`);
        sandbox.run(["add", "file.txt"]);
        sandbox.commit(name);
        return sandbox.run(["rev-parse", "HEAD"]).trim();
      };
      commit("first");
      const tool = join(scratch, "tool");
      const project = join(scratch, "project");
      for (const clone of [tool, project]) execFileSync("git", ["clone", "-q", sandbox.dir, clone], { env: sandboxGitEnv(), encoding: "utf8" });
      return fn({ upstream: sandbox.run, commit, tool, project, at: gitAt });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test("#2793: `update-tool` moves the tool checkout to origin/main and leaves the project checkout beside it exactly where it was", () => {
  withUpstreamAndClones(({ commit, tool, project, at }) => {
    const first = at(project)(["rev-parse", "HEAD"]).trim();
    assert.equal(at(tool)(["rev-parse", "HEAD"]).trim(), first, "POSITIVE CONTROL: both clones start at the first commit");
    const second = commit("second");
    assert.notEqual(second, first);
    assert.equal(updateTool(tool, at(tool)), second, "it reports the commit it moved to");
    assert.equal(at(tool)(["rev-parse", "HEAD"]).trim(), second, "the tool checkout is at the new origin/main");
    assert.equal(at(project)(["rev-parse", "HEAD"]).trim(), first, "the project checkout was not moved");
    assert.equal(at(project)(["status", "--porcelain"]).trim(), "", "and not touched");
    assert.equal(at(project)(["rev-parse", "origin/main"]).trim(), first, "not even fetched: its origin/main is what it was");
  });
});

test("#2793: `update-tool` REFUSES a tree with a modified tracked file, naming it, and moves nothing", () => {
  withUpstreamAndClones(({ commit, tool, at }) => {
    const first = at(tool)(["rev-parse", "HEAD"]).trim();
    commit("second");
    writeFileSync(join(tool, "file.txt"), "edited by hand\n");
    assert.match(at(tool)(["status", "--porcelain"]), /file\.txt/, "POSITIVE CONTROL: the fixture is dirty BEFORE it is refused");
    assert.throws(() => updateTool(tool, at(tool)), /uncommitted changes[\s\S]*file\.txt/);
    assert.equal(at(tool)(["rev-parse", "HEAD"]).trim(), first, "HEAD did not move");
    assert.equal(readFileSync(join(tool, "file.txt"), "utf8"), "edited by hand\n", "and the edit was neither stashed nor reset");
  });
});

test("#2793: an UNTRACKED file is not dirt -- the tool still updates", () => {
  withUpstreamAndClones(({ commit, tool, at }) => {
    writeFileSync(join(tool, "build-product.txt"), "x\n");
    assert.match(at(tool)(["status", "--porcelain"]), /\?\? build-product\.txt/, "POSITIVE CONTROL: git sees the untracked file");
    const second = commit("second");
    assert.equal(updateTool(tool, at(tool)), second);
  });
});

test("#2793: `update-tool` REFUSES a linked worktree, which detaching would take off its branch", () => {
  withUpstreamAndClones(({ tool, at }) => {
    const linked = `${tool}-linked`;
    at(tool)(["worktree", "add", "-q", "-b", "elsewhere", linked]);
    assert.throws(() => updateTool(linked, at(linked)), /not a primary checkout/);
    assert.equal(at(linked)(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "elsewhere", "the worktree is still on its branch");
    rmSync(linked, { recursive: true, force: true });
  });
});
