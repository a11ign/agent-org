// no-token: none -- host files are written into a temporary home; the exposure plugin is loaded and asked for its ports, and no program is run
// A11-279: the exposure a process other than the board resolves (the event tunnel, the kernel notes) is the project's host file's, else the instance's host file's, else local
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { forgetActivation } from "./active.ts";
import { hostExposure } from "./host-exposure.ts";

const TAILSCALE = { providers: { exposure: { provider: "tailscale" } } };
const LOCAL = { providers: { exposure: { provider: "local" } } };
const hostText = (tickets: Record<string, unknown>): string => JSON.stringify({ clones: { a: "/src/a" }, tickets });

/** A home with the instance's host file (`<home>/.agent-org/host.json`) and a project host file elsewhere, each holding `tickets` when it is given. */
function machine(project: Record<string, unknown> | null, instance: Record<string, unknown> | null) {
  const home = tmpDir("host-exposure-");
  const projectFile = join(home, "project", ".agent-org", "host.json");
  mkdirSync(join(home, "project", ".agent-org"), { recursive: true });
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  writeFileSync(projectFile, hostText(project ?? {}));
  if (instance !== null) writeFileSync(join(home, ".agent-org", "host.json"), hostText(instance));
  return { home, env: { AGENT_ORG_HOST: projectFile, HOME: home } };
}

/** The ports the exposure resolved for `env` serves the board on, or null for one that serves nothing. Activation is once per process, so each case starts from none. */
async function portsOf(env: Record<string, string>, home: string) {
  forgetActivation();
  return (await hostExposure(env, home)).ports();
}

test("A11-279: a project host file that names no exposure takes the instance's host file's, so the event tunnel resolves tailscale and not local", async () => {
  const { env, home } = machine({}, TAILSCALE);
  assert.deepEqual(await portsOf(env, home), { ui: 9443, terminal: 9444 });
});

test("A11-279: a project host file that names an exposure keeps it, whatever the instance's says", async () => {
  const { env, home } = machine(LOCAL, TAILSCALE);
  assert.equal(await portsOf(env, home), null, "the project's own `local` is its choice");
  const named = machine(TAILSCALE, LOCAL);
  assert.deepEqual(await portsOf(named.env, named.home), { ui: 9443, terminal: 9444 });
});

test("A11-279: a host that names no exposure in either file, or has no instance host file, resolves local", async () => {
  const neither = machine({}, {});
  assert.equal(await portsOf(neither.env, neither.home), null);
  const alone = machine({}, null);
  assert.equal(await portsOf(alone.env, alone.home), null);
});

test("A11-279: the instance's host file is the one the instance resolves without AGENT_ORG_HOST: the path onboard recorded, before <home>/host.json", async () => {
  const { env, home } = machine({}, LOCAL);
  const recorded = join(home, "recorded.json");
  writeFileSync(recorded, hostText(TAILSCALE));
  writeFileSync(join(home, ".agent-org", "host-file"), recorded);
  assert.deepEqual(await portsOf(env, home), { ui: 9443, terminal: 9444 });
});
