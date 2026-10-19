// no-token: none -- every write is into a temp directory this file builds, the wrapper is rendered and never run, the minter is a stub, and nothing reaches `gh`, `herdr` or the network
// requires: history
// (the tests import `host-units.ts`, which reads git history to say where an orphaned unit came from)
//
// A11-84: THE ROUTING WRAPPER HAS ONE WRITER, AND THAT WRITER REFUSES A WRAPPER THAT NAMES NO APP. The incident: from 19:39Z to 20:59Z on 2026-10-17 `~/.local/bin/gh`
// held a rendering with an EMPTY App role table, so no App token was minted for any role. Each refusal of `writeGhWrapper` is tested with a stub write that must
// not be called; the replay of the incident (four roles installed, a host declaring none) is refused and leaves the installed bytes as they were; the legitimate
// cases still write; and the detector and the start-up say what they find.
import "./host-units-project.ts"; // FIRST: it names the fixture project the tool resolves at import
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "./host-units-project.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseHostConfig } from "../host-config.ts";
import { type MintRun, ghWrapperDivergence, hostIdentityInstall, mintFailure, rerenderGhWrapper, startupGhWrapper, tickRerenderGhWrapper, wrapperRoles, writeGhWrapper } from "../host-units/tool-version-notes.ts";
import { shippedScriptText } from "../host-units/shipped-dir.ts";

const baseHost = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
const APPS = (roles: string[]) => ({ identity: Object.fromEntries(roles.map((role) => [role, {
  mode: "github-apps", appId: `id-${role}`, keyPath: `/scratch/${role}.pem`, ...(role === "workers" ? { installationId: "777" } : {}),
}])) });

/** A scratch host declaration (never the live one): its bin directory under `root`, and the apps it declares. */
function hostOf(root: string, roles: string[]) {
  return parseHostConfig(JSON.stringify({
    ...baseHost(), binDir: join(root, "bin"),
    gh: { ...(baseHost().gh as object), workers: join(root, "workers"), leads: join(root, "leads") },
    ...(roles.length === 0 ? {} : { github: APPS(roles) }),
  }), "scratch host.json");
}

/** A bin directory holding the wrapper as `host:install` renders it for `roles`, and the host declaration for any other set of roles. */
function installed(roles: string[]) {
  const root = tmpDir("gh-wrapper-guard-");
  mkdirSync(join(root, "bin"), { recursive: true });
  const target = join(root, "bin", "gh");
  writeFileSync(target, shippedScriptText("gh", { host: hostOf(root, roles) }) as string, { mode: 0o755 });
  return { root, target, host: (declared: string[]) => hostOf(root, declared), text: () => readFileSync(target, "utf8") };
}

/** The rendered wrapper for `roles`, as text. */
const rendered = (root: string, roles: string[]) => shippedScriptText("gh", { host: hostOf(root, roles) }) as string;
/** The same wrapper with its minter at a shipped checkout's path, outside any temporary directory: what production writes. */
const shippedCheckout = (text: string) => text
  .replace(/(A11Y_APP_TOKEN_SCRIPT:-)[^}\n]*\}/, "$1/opt/agent-org/src/app-token.ts}")
  .replace(/(A11Y_GH_FLAG_SCRIPT:-)[^}\n]*\}/, "$1/opt/agent-org/src/gh-author-fallback.ts}");

/** A write that must not happen: the refusal is what is under test, so a call here is the failure. */
const noWrite = (() => { throw new Error("a refused wrapper must not be written"); }) as never;
const noWrites = { write: noWrite, rename: noWrite, chmod: noWrite, mkdir: noWrite };
/** The dirs a `hostIdentityInstall` call needs, beside the host's own bin directory, all under `root`. */
const dirsOf = (root: string) => ({ scriptDir: join(root, "bin"), workersDir: join(root, "workers"), leadsDir: join(root, "leads"), out: () => {} });

test("A11-84 POSITIVE: a host that declares roles renders them, and the one writer writes exactly the rendered text", () => {
  const root = tmpDir("gh-wrapper-guard-write-");
  const host = hostOf(root, ["workers"]);
  const target = join(root, "bin", "gh");
  const text = rendered(root, ["workers"]);
  writeGhWrapper({ target, mode: 0o755, text, host, realBin: join(root, "elsewhere"), under: true });
  assert.equal(readFileSync(target, "utf8"), text, "byte-identical to the render");
  assert.deepEqual(wrapperRoles(readFileSync(target, "utf8")), ["workers"]);
});

test("A11-84 REFUSAL 1: an empty table while host.json declares github-apps roles is refused, and nothing is written", () => {
  const root = tmpDir("gh-wrapper-guard-empty-");
  const host = hostOf(root, ["workers"]);
  const target = join(root, "bin", "gh");
  assert.throws(() => writeGhWrapper({ target, mode: 0o755, text: rendered(root, []), host, realBin: join(root, "elsewhere"), under: true, ...noWrites }),
    /host\.json declares github-apps roles \(workers\), but the rendered wrapper names none, so .* is not written/);
  assert.equal(existsSync(target), false, "nothing was written");
});

test("A11-84 REFUSAL 2, THE INCIDENT REPLAY: a wrapper naming four roles, on a host that declares none, is refused and its bytes are left as they were", () => {
  const h = installed(["scheduler", "workers", "managers", "reviewer"]);
  const before = h.text();
  assert.deepEqual(wrapperRoles(before), ["scheduler", "workers", "managers", "reviewer"], "the control: the installed wrapper names four roles");
  assert.throws(() => rerenderGhWrapper({ host: h.host([]), ...noWrites }),
    /names no App role and the installed one names scheduler, workers, managers, reviewer.*`host:install --allow-no-apps`/);
  assert.equal(h.text(), before, "the installed bytes are as they were");
});

test("A11-84 REFUSAL 2 IS THE TICK'S TOO, AS A NOTE: the tick never passes `allowNoApps`, so a downgrade is said and not written", () => {
  const h = installed(["workers"]);
  const before = h.text();
  const said: string[] = [];
  assert.deepEqual(tickRerenderGhWrapper({ host: h.host([]), err: (line) => said.push(line) }), [], "no finding for a refused write");
  assert.match(said.join(""), /^could not re-render the gh wrapper: .*names no App role and the installed one names workers/);
  assert.equal(h.text(), before);
});

test("A11-84 DOWNGRADE, ASKED FOR: `host:install --allow-no-apps` writes the no-app wrapper for a host that really dropped its Apps, and without it the same call throws", () => {
  const h = installed(["workers"]);
  assert.throws(() => hostIdentityInstall({ host: h.host([]), ...dirsOf(h.root) }), /--allow-no-apps/);
  assert.deepEqual(wrapperRoles(h.text()), ["workers"], "the refused install wrote nothing");
  hostIdentityInstall({ host: h.host([]), allowNoApps: true, ...dirsOf(h.root) });
  assert.deepEqual(wrapperRoles(h.text()), [], "with the flag, the table is empty, as the host declares");
});

test("A11-84 REFUSAL 3: in production, a wrapper whose minter runs from /tmp is refused, as a scratch checkout's; a path elsewhere is the control", () => {
  const root = tmpDir("gh-wrapper-guard-tmp-");
  const host = hostOf(root, ["workers"]);
  const target = join(root, "bin", "gh");
  const scratch = rendered(root, ["workers"]).replace(/(app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-)[^}\n]*\}/, "$1/tmp/claude-1000/scratch/project/src/app-token.ts}");
  assert.match(scratch, /app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-\/tmp\/claude-1000\/scratch\/project\/src\/app-token\.ts\}/, "the control: the path is rewritten");
  assert.throws(() => writeGhWrapper({ target, mode: 0o755, text: scratch, host, realBin: join(root, "elsewhere"), under: false, ...noWrites }),
    /the wrapper runs \/tmp\/claude-1000\/scratch\/project\/src\/app-token\.ts, which is in a temporary directory/);
  assert.equal(existsSync(target), false);
  const elsewhere = shippedCheckout(rendered(root, ["workers"]));
  writeGhWrapper({ target, mode: 0o755, text: elsewhere, host, realBin: join(root, "elsewhere"), under: false });
  assert.equal(readFileSync(target, "utf8"), elsewhere, "POSITIVE CONTROL: the shipped checkout's path is written");
});

test("A11-84 REFUSAL 3 IS NOT A TEST RUN'S: under a test run a fixture's checkout in a temporary directory renders and is written, and the real bin is still refused", () => {
  const root = tmpDir("gh-wrapper-guard-fixture-tmp-");
  const host = hostOf(root, ["workers"]);
  const scratch = rendered(root, ["workers"]).replace(/(app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-)[^}\n]*\}/, "$1/tmp/claude-1000/scratch/project/src/app-token.ts}");
  const target = join(root, "bin", "gh");
  writeGhWrapper({ target, mode: 0o755, text: scratch, host, realBin: join(root, "elsewhere"), under: true });
  assert.equal(readFileSync(target, "utf8"), scratch, "a fixture's own bin directory takes the fixture's checkout");
  assert.throws(() => writeGhWrapper({ target: join(userInfo().homedir, ".local", "bin", "gh"), mode: 0o755, text: scratch, host, under: true, ...noWrites }),
    /a test run may not write the real home's bin directory/, "the machine's own wrapper is still refused under a test run");
});

test("A11-84 TRIPWIRE: under a test run, the real home's bin directory is refused, found by the account and not by $HOME; a fixture's bin directory is allowed", () => {
  const root = tmpDir("gh-wrapper-guard-tripwire-");
  const host = hostOf(root, ["workers"]);
  const text = shippedCheckout(rendered(root, ["workers"]));
  const realTarget = join(userInfo().homedir, ".local", "bin", "gh");
  const realBefore = existsSync(realTarget) ? readFileSync(realTarget, "utf8") : null;
  const saved = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.throws(() => writeGhWrapper({ target: realTarget, mode: 0o755, text, host, under: true, ...noWrites }),
      /a test run may not write the real home's bin directory/, "the real bin directory is refused even with $HOME moved");
  } finally {
    process.env.HOME = saved;
  }
  assert.equal(existsSync(realTarget) ? readFileSync(realTarget, "utf8") : null, realBefore, "the real wrapper, if there is one, is as it was");
  const fixtureBin = join(root, "realbin");
  writeGhWrapper({ target: join(fixtureBin, "gh"), mode: 0o755, text, host, realBin: fixtureBin, under: false });
  assert.equal(readFileSync(join(fixtureBin, "gh"), "utf8"), text, "CONTROL: outside a test run the same directory is written");
  writeGhWrapper({ target: join(root, "bin", "gh"), mode: 0o755, text, host, realBin: join(root, "elsewhere"), under: true });
  assert.equal(readFileSync(join(root, "bin", "gh"), "utf8"), text, "CONTROL: under a test run, a fixture's bin directory is written");
});

test("A11-84: the detector says what is wrong with the installed wrapper, and nothing when it is the one host.json declares", () => {
  const h = installed(["workers"]);
  assert.equal(ghWrapperDivergence({ host: h.host(["workers"]) }), null, "POSITIVE: the matching wrapper");
  writeFileSync(h.target, rendered(h.root, []));
  assert.match(ghWrapperDivergence({ host: h.host(["workers"]) }) ?? "", /names no App role, but host\.json declares workers, so no App token is minted for any of them/);
  writeFileSync(h.target, `${rendered(h.root, ["workers"])}# hand-edited\n`);
  assert.match(ghWrapperDivergence({ host: h.host(["workers"]) }) ?? "", /is not the wrapper this repository renders from host\.json, though its App roles agree/);
  rmSync(h.target);
  assert.match(ghWrapperDivergence({ host: h.host(["workers"]) }) ?? "", /there is no gh wrapper at/);
});

test("A11-84: `wrapperRoles` reads the role table of a rendered wrapper, empty as [], and text with no table as null", () => {
  const root = tmpDir("gh-wrapper-guard-roles-");
  assert.deepEqual(wrapperRoles(rendered(root, ["scheduler", "workers"])), ["scheduler", "workers"]);
  assert.deepEqual(wrapperRoles(rendered(root, [])), []);
  assert.equal(wrapperRoles("#!/bin/sh\nexec /usr/bin/gh \"$@\"\n"), null, "a copy from before #4900 names no table");
});

// --- the minter probe: one role's mint, with the minter the installed wrapper would run -------------------------------------------------

const ok: MintRun = () => ({ status: 0, stdout: "ghs_token\n", stderr: "" });

test("A11-84: `mintFailure` runs the wrapper's own minter with the declared app and a token directory of its own, and names the first line the minter printed", () => {
  const root = tmpDir("gh-wrapper-guard-mint-");
  const host = hostOf(root, ["workers"]);
  const calls: { script: string, role: string, env: Record<string, string> }[] = [];
  assert.equal(mintFailure("workers", { host, run: (script, role, env) => { calls.push({ script, role, env }); return ok(script, role, env); } }), null, "POSITIVE: it mints");
  assert.match(calls[0].script, /app-token\.ts$/, "the minter the wrapper names");
  assert.equal(calls[0].env.A11Y_APP_ID, "id-workers");
  assert.equal(calls[0].env.A11Y_APP_KEY_PATH, "/scratch/workers.pem");
  assert.notEqual(calls[0].env.A11Y_APP_TOKEN_DIR, undefined);
  assert.equal(existsSync(calls[0].env.A11Y_APP_TOKEN_DIR), false, "the scratch token directory is removed afterwards");

  const failing: MintRun = () => ({ status: 2, stdout: "", stderr: "could not read the key /scratch/workers.pem\nand a second line" });
  assert.equal(mintFailure("workers", { host, run: failing }), "could not read the key /scratch/workers.pem", "the first line the minter printed");
  const spaced: MintRun = () => ({ status: 0, stdout: "two words\n", stderr: "" });
  assert.equal(mintFailure("workers", { host, run: spaced }), "the minter exited 0", "a token is one word; a stdout of two is no token");
  assert.equal(mintFailure("scheduler", { host, run: () => { throw new Error("a role the host does not declare is not minted"); } }), null);
});

// --- the instance's start-up -------------------------------------------------------------------------------------------------------------

test("A11-84 START-UP: a diverged wrapper is said LOUDLY and re-rendered through the one writer, and a role that mints is said nothing", () => {
  const h = installed([]);
  const said: string[] = [];
  const reading = startupGhWrapper({ host: h.host(["workers"]), err: (line) => said.push(line), run: ok });
  assert.match(said[0], /^ERROR gh wrapper: .*names no App role, but host\.json declares workers/);
  assert.match(said[1], new RegExp(`^re-rendered ${h.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from host\\.json`));
  assert.equal(reading.rerendered, h.target);
  assert.deepEqual(wrapperRoles(h.text()), ["workers"], "the wrapper now names what host.json declares");
  assert.equal(said.length, 2, "a role that mints is not said");
});

test("A11-84 START-UP: a re-render the guard REFUSES is logged and returned, and the instance is not stopped: the check returns", () => {
  const h = installed(["scheduler", "workers"]);
  const before = h.text();
  const said: string[] = [];
  const reading = startupGhWrapper({ host: h.host([]), err: (line) => said.push(line), run: ok });
  assert.equal(reading.rerendered, null);
  assert.match(reading.refused ?? "", /names no App role and the installed one names scheduler, workers/);
  assert.match(said.join(""), /ERROR gh wrapper NOT re-rendered: .*The instance starts anyway/);
  assert.equal(h.text(), before, "the installed bytes are as they were");
});

test("A11-84 START-UP: a role whose mint fails is logged with its reason on every start, and a wrapper that is right is not re-rendered", () => {
  const h = installed(["workers"]);
  const said: string[] = [];
  const failing: MintRun = () => ({ status: 2, stdout: "", stderr: "could not read the key /scratch/workers.pem" });
  const first = startupGhWrapper({ host: h.host(["workers"]), err: (line) => said.push(line), run: failing });
  assert.equal(first.divergence, null, "the matching wrapper is not re-rendered");
  assert.equal(first.rerendered, null);
  assert.match(said.join(""), /^ERROR app role workers: its token mint failed: could not read the key \/scratch\/workers\.pem\n$/);
  said.length = 0;
  startupGhWrapper({ host: h.host(["workers"]), err: (line) => said.push(line), run: failing });
  assert.match(said.join(""), /ERROR app role workers/, "said again on the next start");
  said.length = 0;
  startupGhWrapper({ host: h.host(["workers"]), err: (line) => said.push(line), run: ok });
  assert.equal(said.join(""), "", "and silent once it mints");
});

test("A11-84 START-UP: the mint probe takes the run it is given, and makes one mint per declared role", () => {
  const h = installed(["workers"]);
  const calls: string[] = [];
  startupGhWrapper({ host: h.host(["workers"]), err: () => {}, run: (script) => { calls.push(script); return ok(script, "workers", {}); } });
  assert.equal(calls.length, 1, "one mint for the one declared role");
});

test("A11-84 START-UP: a start never CREATES a missing wrapper, as the tick never has, and says how to install it", () => {
  const root = tmpDir("gh-wrapper-guard-missing-");
  const host = hostOf(root, ["workers"]);
  const target = join(root, "bin", "gh");
  const said: string[] = [];
  const reading = startupGhWrapper({ host, err: (line) => said.push(line), run: ok });
  assert.equal(existsSync(target), false, "nothing was created");
  assert.equal(reading.rerendered, null);
  assert.match(reading.refused ?? "", /there is no wrapper at .*\/bin\/gh, and a start does not create/);
  assert.match(said.join(""), /ERROR gh wrapper NOT re-rendered: there is no wrapper at .*\/bin\/gh/);
});
