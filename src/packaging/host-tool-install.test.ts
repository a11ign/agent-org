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
 * paths from one ledger path (`wake.ts`'s queue, spare, reviewer and kept-claim paths) are shown to follow it. FOUR CONSTANTS STILL
 * SPELL `~/.cache/a11ign` -- `DRAIN_MARKER` and `REVIEWER_STATE_DIR` in `work-gate.ts`, `LIVE_STATE_DIR` in `shadow-gate.ts`, and the
 * default of `ledgerPathFrom` in `wake.ts` -- and those files are other rows' Regions, so wiring them to `stateFilePath` is not done
 * here. The last test below reads `ledgerPathFrom([])` so that the residue is a named value rather than a claim of absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, SHIPPED_DIR, TOOL_UPDATE_EXEC, identityDrift, shippedUnitText, unitsSpendingGh, workTickToolForm } from "../host-units.ts";
import { HostConfigRefusal, homeHostConfig, parseBeforeTick, parseHostConfig, renderTemplate, stateFilePath, templateValues }
  from "../host-config.ts";
import { handoffQueuePath, keptClaimsPath, ledgerPathFrom, reviewerPathsFrom, sparePathsFrom } from "../wake.ts";
import { updateTool } from "../update-tool.ts";
import { sandboxGitEnv, withGitSandbox } from "../lib/git-sandbox.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The digest of the `work-tick` unit the host runs today: the one `host-project-paths.test.ts` pins as `TODAYS_TEXT`, restated so this file's claim is checkable alone. */
const TODAYS_WORK_TICK_SHA = "348a00639a198e4d800beb3c8eee663eb589d8c7566e7cda8299c61486abbec3";

/**
 * a11ign's host with its `tool` taken out. #2974 (cut-over 3 of 6) SET `tool` in a11ign's `host.json`, so the real host now renders the tool
 * form, and "the template's plain text for a11ign's values" has to be asked of the same host without the key. The digest above moved with the
 * template's `primary:update` line (npm -> the pnpm shim), the one text change the cut made to the plain form.
 */
const plainA11ignHost = (() => {
  const plain: Record<string, unknown> = { ...homeHostConfig() };
  delete plain.tool;
  return Object.freeze(plain);
})() as never;

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
    assert.equal((refusal(() => parse(acmeHost(extra))) as any).field, field, `${what} must be refused, naming \`${field}\``);
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
    assert.equal((refusal(() => parseBeforeTick(text, "project.json")) as any).field, "beforeTick", `${what} must be refused, naming \`beforeTick\``);
  }
  assert.equal((refusal(() => parseBeforeTick("{not json")) as any).field, "(file)");
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
  assert.equal(Object.hasOwn(plainA11ignHost as object, "tool"), false, "POSITIVE CONTROL: the host asked here names no tool, so this is the plain render");
  assert.equal(homeHostConfig().stateDir, undefined, "and no stateDir: a11ign's host.json declares none");
  assert.equal(sha256(shippedUnitText("a11ign-work-tick.service", { host: plainA11ignHost }) ?? ""), TODAYS_WORK_TICK_SHA, "the unit's plain render, unchanged");
  withProjects((dirs) => {
    const host = hostAt(dirs, {});
    const template = readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8");
    assert.equal(workTickOf(host), renderTemplate(template, templateValues(host, ACME_UNITS), "work-tick"),
      "a host without `tool` gets the plain render of the template, which is what it got before this row");
  });
});

test("#2793 + #2974: with `tool` set, THREE lines are decision 3's, ONE is the host variable the tool needs, and the rest is today's", () => {
  withProjects((dirs) => {
    const plain = workTickOf(hostAt(dirs, {}));
    const installed = workTickOf(hostAt(dirs, { tool: dirs.tool }));
    assert.notEqual(installed, plain, "POSITIVE CONTROL: the two renderings differ, so `equal` above is not one text compared to itself");
    assert.deepEqual(linesOnlyIn(plain, installed), [
      "WorkingDirectory=" + dirs.widgets,
      "ExecStartPre=-%h/.local/bin/pnpm run primary:update",
      "ExecStart=/usr/bin/node --import=./packages/agent-org/src/lib/crash-exit.mjs --import tsx packages/agent-org/src/work-tick.ts",
    ], "the three lines that leave");
    assert.deepEqual(linesOnlyIn(installed, plain), [
      "WorkingDirectory=" + dirs.tool,
      `Environment=AGENT_ORG_HOST=${dirs.widgets}/.agent-org/host.json`,
      "ExecStartPre=-" + TOOL_UPDATE_EXEC,
      `ExecStartPre=-/usr/bin/env -C ${dirs.widgets} npm run widgets:update`,
      "ExecStart=/usr/bin/node --import=./src/lib/crash-exit.mjs --import tsx src/work-tick.ts",
    ], "the tool's path, then the tool update and THEN the declared beforeTick, then the shorter ExecStart");
    const order = installed.split("\n").filter((line) => line.startsWith("ExecStartPre="));
    assert.deepEqual(order, ["ExecStartPre=-" + TOOL_UPDATE_EXEC, `ExecStartPre=-/usr/bin/env -C ${dirs.widgets} npm run widgets:update`],
      "the gadgets project declares none, so it adds no line: only a declared beforeTick runs");
  });
});

test("#2793: the tool update the rendered ExecStartPre names EXISTS, at the path it names relative to the tool's `src/`", () => {
  const script = /node --import=\.\/src\/lib\/crash-exit\.mjs --import tsx (src\/update-tool\.ts)$/.exec(TOOL_UPDATE_EXEC)?.[1];
  assert.equal(script, "src/update-tool.ts", "POSITIVE CONTROL: the command names a script, so the existence check below is of something");
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
    assert.equal((refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))) as any).field, "beforeTick");
    rmSync(join(dirs.gadgets, ".agent-org/project.json"));
    assert.equal((refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))) as any).field, "(file)",
      "an unreadable declaration is a refusal, not a skipped project whose checkout would go stale unseen");
  });
});

test("#3464: a tool command in a beforeTick is for the host's PRIMARY project only, since the tool resolves its project from the host, not from where it runs", () => {
  withProjects((dirs) => {
    writeFileSync(join(dirs.widgets, ".agent-org/project.json"), JSON.stringify({ schema: 1, beforeTick: "agent-org primary:update" }));
    assert.match(workTickOf(hostAt(dirs, { tool: dirs.tool })), new RegExp(`^ExecStartPre=-/usr/bin/env -C ${dirs.widgets} /usr/bin/node --import ${dirs.tool}/node_modules/tsx/dist/loader\\.mjs ${dirs.tool}/src/update-primary\\.ts$`, "m"),
      "POSITIVE CONTROL: the primary (widgets) may declare one, and it renders");
    writeFileSync(join(dirs.gadgets, ".agent-org/project.json"), JSON.stringify({ schema: 1, beforeTick: "agent-org primary:update" }));
    assert.equal((refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))) as any).field, "beforeTick", "a second project would have the PRIMARY moved instead of itself");
    writeFileSync(join(dirs.gadgets, ".agent-org/project.json"), JSON.stringify({ schema: 1, beforeTick: "agent-org\tprimary:update" }));
    assert.equal((refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))) as any).field, "beforeTick",
      "a TAB between the words is the same command, so the foreign project is refused for it too and not let through as 'the project's own'");
  });
});

// --- 2b. #2974: EVERY SERVICE THE TOOL SHIPS RUNS FROM THE TOOL, and the tool is told where its project is -----------------------------

/** The services the tool ships and a11ign installs (the work-tick, the worktree prune, the board report, the dormant shadow window). */
const TOOL_SERVICES = ["work-tick", "worktree-prune", "board-report", "shadow-window"] as const;
const serviceOf = (host: ReturnType<typeof parse>, name: string) => shippedUnitText(`acme-${name}.service`, { host, units: ACME_UNITS }) ?? "";
const nonComment = (text: string) => text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

test("#2974: with `tool` set, every shipped service runs from the tool's checkout and names no `packages/agent-org` path", () => {
  withProjects((dirs) => {
    const plainHost = hostAt(dirs, {});
    const toolHost = hostAt(dirs, { tool: dirs.tool });
    for (const name of TOOL_SERVICES) {
      const plain = nonComment(serviceOf(plainHost, name));
      const installed = nonComment(serviceOf(toolHost, name));
      assert.notDeepEqual(installed, plain, `POSITIVE CONTROL: ${name} renders differently under a tool, so the checks below are of the tool form`);
      assert.ok(installed.includes(`WorkingDirectory=${dirs.tool}`), `${name} runs from the tool: ${installed.join(" | ")}`);
      assert.deepEqual(installed.filter((line) => line.includes("packages/agent-org")), [], `${name} names a path inside the monorepo copy`);
      assert.doesNotMatch(serviceOf(toolHost, name), /packages\/agent-org/, `${name}: not even in a comment, because \`systemctl cat\` shows comments and #2974's done-when 1 reads it`);
      assert.ok(installed.includes(`Environment=AGENT_ORG_HOST=${dirs.widgets}/.agent-org/host.json`),
        `${name} must say where the host's declaration is: a tool run from its own checkout refuses without it`);
    }
    assert.ok(nonComment(serviceOf(plainHost, "work-tick")).some((line) => line.includes("packages/agent-org")),
      "POSITIVE CONTROL: the plain work-tick DOES name the path, so an empty filter above means the tool form removed it");
  });
});

test("#2974: the prune and the board report take their project from the checkout the host names, not from a working directory", () => {
  withProjects((dirs) => {
    const toolHost = hostAt(dirs, { tool: dirs.tool });
    const prune = nonComment(serviceOf(toolHost, "worktree-prune"));
    assert.ok(prune.includes(`ExecStart=/usr/bin/node --import tsx src/prune-worktrees.ts --apply ${dirs.widgets}`),
      `the prune is handed the repository it prunes (its cwd is the tool's now): ${prune.join(" | ")}`);
    const report = nonComment(serviceOf(toolHost, "board-report"));
    assert.ok(report.includes("ExecStart=/usr/bin/bash host/board-report-dispatch.sh"));
    assert.ok(report.includes(`Environment=AGENT_ORG_PROJECT=${dirs.widgets}/.agent-org/project.json`),
      "the dispatcher reads the project's declaration from $AGENT_ORG_PROJECT, which its default would otherwise look for in the tool's directory");
    const timer = shippedUnitText("acme-work-tick.timer", { host: toolHost, units: ACME_UNITS });
    assert.equal(timer, shippedUnitText("acme-work-tick.timer", { host: hostAt(dirs, {}), units: ACME_UNITS }), "a timer names no path of its own, so the tool form leaves it alone");
  });
});

// --- 2c. #2974: THE TOOL AIMS EVERY AMBIENT `gh` AT ITS PROJECT, because its working directory is no longer the project's ---------------
// Measured 2026-10-02 15:01Z, the first tick after the cut: `gh label list` run from the tool's checkout asked `a11ign/agent-org` and found no
// `answer:` label, so the gate printed 1 order where the same gate from the project's directory printed 12. `GH_REPO` is the line that fixes it.

const declareRepo = (dir: string, repo: unknown) =>
  writeFileSync(join(dir, ".agent-org/project.json"), JSON.stringify({ schema: 1, code: [{ key: "", repo }] }));

test("#2974: every shipped service in tool form says which repository `gh` asks about, and a plain one does not", () => {
  withProjects((dirs) => {
    const plainHost = hostAt(dirs, {});
    const toolHost = hostAt(dirs, { tool: dirs.tool });
    for (const name of TOOL_SERVICES) {
      assert.equal(nonComment(serviceOf(toolHost, name)).some((line) => line.startsWith("Environment=GH_REPO=")), false,
        `CONTROL: ${name} for a project whose declaration names no repository gets no line, since there is nothing to aim at`);
    }
    declareRepo(dirs.widgets, "acme/widgets");
    for (const name of TOOL_SERVICES) {
      assert.ok(nonComment(serviceOf(toolHost, name)).includes("Environment=GH_REPO=acme/widgets"),
        `${name}: a tool run from its own checkout would otherwise ask the checkout's repository: ${nonComment(serviceOf(toolHost, name)).join(" | ")}`);
      assert.equal(nonComment(serviceOf(plainHost, name)).some((line) => line.startsWith("Environment=GH_REPO=")), false,
        `${name}: a host with no tool runs from the project, where gh already finds it, and its bytes do not change`);
    }
  });
});

test("#2974: a repository that is not owner/name is refused naming the field, because it is written into a unit line", () => {
  withProjects((dirs) => {
    for (const bad of ["acme", "acme/widgets extra", "acme/widgets\nExecStartPre=/bin/false", "", 7]) {
      declareRepo(dirs.widgets, bad);
      assert.equal((refusal(() => workTickOf(hostAt(dirs, { tool: dirs.tool }))) as any).field, "code[0].repo", `${JSON.stringify(bad)} must be refused`);
    }
  });
});

test("#2974: a11ign's own declaration puts `GH_REPO=a11ign/a11ign` on all four services it installs from the tool", () => {
  const toolHost = { ...homeHostConfig(), projects: [{ id: homeHostConfig().primary, checkout: REPO_ROOT.replace(/\/$/, "") }], tool: "/home/agent/repos/agent-org" } as never;
  for (const name of TOOL_SERVICES) {
    const lines = nonComment(shippedUnitText(`a11ign-${name}.service`, { host: toolHost }) ?? "");
    assert.ok(lines.includes("Environment=GH_REPO=a11ign/a11ign"), `a11ign-${name}.service: ${lines.join(" | ")}`);
  }
});

test("#2974: the gh-identity check still SEES a unit in tool form -- the population does not lose its work-tick", () => {
  // `unitEntryPoints` resolved `node src/work-tick.ts` against the project and found nothing, so the unit that spends the most rate limit
  // dropped out of `unitsSpendingGh` without a failure. a11ign's real host with a `tool` injected, so this holds before and after its host.json says one.
  // Its project is THIS run's checkout, not the host's absolute path, which a CI runner does not have: the tool form reads each project's `beforeTick`.
  const toolHost = { ...homeHostConfig(), projects: [{ id: homeHostConfig().primary, checkout: REPO_ROOT.replace(/\/$/, "") }], tool: "/home/agent/repos/agent-org" } as never;
  const spending = unitsSpendingGh({ host: toolHost }).map((u) => u.unit);
  assert.ok(spending.includes("a11ign-work-tick.service"), `the tick is in the population: ${spending.join(", ")}`);
  assert.ok(spending.includes("a11ign-worktree-prune.service"), `and so is the prune: ${spending.join(", ")}`);
  assert.deepEqual(identityDrift({ host: toolHost }), [], "and every one of them still declares whose account it spends");
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
  assert.equal((refusal(() => stateFilePath(parse(acmeHost()), "wake-ledger")) as any).field, "stateDir");
  assert.equal((refusal(() => stateFilePath(homeHostConfig(), "wake-ledger")) as any).field, "stateDir", "and a11ign's own host.json, unedited, declares none");
});

// --- 4. `update-tool`: refuses a dirty tree and a linked worktree (what it moves TO is `update-tool.test.ts`'s, #3443) ---------------------------------

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

test("#2793: `update-tool` REFUSES a linked worktree, which detaching would take off its branch", () => {
  withUpstreamAndClones(({ tool, at }) => {
    const linked = `${tool}-linked`;
    at(tool)(["worktree", "add", "-q", "-b", "elsewhere", linked]);
    assert.throws(() => updateTool(linked, at(linked)), /not a primary checkout/);
    assert.equal(at(linked)(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "elsewhere", "the worktree is still on its branch");
    rmSync(linked, { recursive: true, force: true });
  });
});
