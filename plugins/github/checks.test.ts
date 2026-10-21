// no-token: none -- `gh` and `git` are a fake `exec`: no GitHub CLI runs, and no extension or remote is asked of the machine
//
// THE PLUGIN'S DOCTOR ROWS (A11-160), moved from `install/doctor.test.ts` with their expectations unchanged: the stacking extension for the workers' account (`gh stack`), and whether
// GitHub makes stacked pull requests available to each repository a clone names (`stacked pull requests`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecOptions, ExecResult } from "../../src/plugins/manifest.ts";
import { stackChecks } from "./checks.ts";

const LISTING = "gh stack  github/gh-stack  v0.2.1\n";
const GITHUB_ORIGIN = "git@github.com:a11ign/nbl-ui-netbox.git";
const WORKERS = { workers: "/home/agent/workers" };
const NOT_ENABLED = (): ExecResult => ({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });

type Stacks = (repo: string) => ExecResult;
const ENABLED: Stacks = () => ({ status: 0, stdout: "[]", stderr: "" });

/** A machine whose `gh` lists `listing` as its extensions and answers each repository's stacks with `stacks`, and whose clones' origin is `origin`. */
function machine({ listing = LISTING, stacks = ENABLED as Stacks, origin = null as string | null, env = {} as Record<string, string> } = {}) {
  const asked: { file: string; args: readonly string[]; options: ExecOptions | undefined }[] = [];
  const exec = (file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
    asked.push({ file, args, options });
    if (file === "git") return origin === null ? { status: 1, stdout: "", stderr: "no origin" } : { status: 0, stdout: `${origin}\n`, stderr: "" };
    if (args[0] === "extension") return { status: 0, stdout: listing, stderr: "" };
    const repo = args[1].split("/").slice(1, 3).join("/");
    return stacks(repo);
  };
  return { asked, deps: fakePluginDeps({ exec, env, clones: { netbox: "/src/netbox" } }) };
}

test("A11-106: doctor fails a missing gh stack with the install command for the workers' account, and passes when it is listed", () => {
  const missing = stackChecks({ gh: WORKERS }, machine({ listing: "gh dash  dlvhdr/gh-dash  v4.0.0\n" }).deps)[0];
  assert.equal(missing.name, "gh stack");
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, "`gh stack` is not installed, so a worker cannot link a stacked pull request");
  assert.equal(missing.fix, "GH_CONFIG_DIR=/home/agent/workers/gh gh extension install github/gh-stack, or run `agent-org onboard`");
  const listed = stackChecks({ gh: WORKERS }, machine().deps)[0];
  assert.deepEqual([listed.ok, listed.detail], [true, "github/gh-stack v0.2.1 (for GH_CONFIG_DIR=/home/agent/workers/gh)"]);
});

test("A11-106: the checks ask gh as the workers' account, and name the install command without one when no host file names it", () => {
  const { asked, deps } = machine();
  stackChecks({ gh: WORKERS }, deps);
  assert.deepEqual(asked.filter(({ file }) => file === "gh").map(({ options }) => options?.env), [{ GH_CONFIG_DIR: "/home/agent/workers/gh" }]);
  const bare = stackChecks({}, machine({ listing: "" }).deps)[0];
  assert.equal(bare.fix, "gh extension install github/gh-stack, or run `agent-org onboard`");
  const fromEnvironment = machine({ listing: "", env: { GH_CONFIG_DIR: "/home/me/gh" } });
  assert.equal(stackChecks({}, fromEnvironment.deps)[0].fix, "GH_CONFIG_DIR=/home/me/gh gh extension install github/gh-stack, or run `agent-org onboard`", "the environment names the account when the host file does not");
});

test("A11-106: the checks say gh could not list its extensions, rather than that the extension is missing", () => {
  const exec = (): ExecResult => ({ status: null, stdout: "", stderr: "spawn gh ENOENT" });
  const [check] = stackChecks({}, fakePluginDeps({ exec }));
  assert.equal(check.ok, false);
  assert.match(check.detail, /could not list its extensions.*spawn gh ENOENT/);
  assert.equal(check.fix, "install the GitHub CLI and put `gh` on PATH, then run `agent-org onboard`");
});

test("A11-106: the checks name the repository GitHub refuses stacked pull requests for, with the preview requirement", () => {
  const stacks = stackChecks({ gh: WORKERS }, machine({ origin: GITHUB_ORIGIN, stacks: NOT_ENABLED }).deps).find(({ name }) => name === "stacked pull requests");
  assert.equal(stacks?.ok, false);
  assert.equal(stacks?.detail, "GitHub refuses stacked pull requests for a11ign/nbl-ui-netbox");
  assert.match(stacks?.fix ?? "", /GitHub preview that must be available to each repository/);
  assert.match(stacks?.fix ?? "", /the organization/);
  assert.match(stacks?.fix ?? "", /github\.github\.com\/gh-stack\//);
});

test("A11-106: the checks ask GitHub about each repository once, pass when GitHub enables it, and say what they could not read", () => {
  const asked: string[] = [];
  const enabled = stackChecks({ gh: WORKERS }, machine({ origin: GITHUB_ORIGIN, stacks: (repo: string) => { asked.push(repo); return { status: 0, stdout: "[]", stderr: "" }; } }).deps)
    .find(({ name }) => name === "stacked pull requests");
  assert.deepEqual([enabled?.ok, enabled?.detail, asked], [true, "available for a11ign/nbl-ui-netbox", ["a11ign/nbl-ui-netbox"]]);
  const unread = stackChecks({ gh: WORKERS }, machine({ origin: GITHUB_ORIGIN, stacks: () => ({ status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }) }).deps)
    .find(({ name }) => name === "stacked pull requests");
  assert.equal(unread?.ok, false);
  assert.match(unread?.detail ?? "", /could not be read for a11ign\/nbl-ui-netbox: gh: Bad credentials/);
  assert.equal(unread?.fix, "run `gh api repos/<owner>/<repo>/stacks` with the workers' GH_CONFIG_DIR to see why");
});

test("A11-106: a host with no GitHub clone adds no stacked pull requests check, and a missing extension asks GitHub nothing", () => {
  const none = stackChecks({ gh: WORKERS }, machine({ origin: "/srv/git/local.git" }).deps);
  assert.deepEqual(none.map(({ name }) => name), ["gh stack"]);
  let asked = false;
  stackChecks({ gh: WORKERS }, machine({ listing: "", origin: GITHUB_ORIGIN, stacks: () => { asked = true; return { status: 0, stdout: "[]", stderr: "" }; } }).deps);
  assert.equal(asked, false, "nothing is asked of GitHub without the extension");
});

test("A11-145: a host that sets stack to false is asked nothing: no row, and gh is not run", () => {
  const { asked, deps } = machine({ origin: GITHUB_ORIGIN });
  assert.deepEqual(stackChecks({ stack: false, gh: WORKERS }, deps), []);
  assert.deepEqual(asked, []);
  assert.equal(stackChecks({ stack: true }, deps).length > 0, true, "CONTROL: true, and an absent setting, require it");
});
