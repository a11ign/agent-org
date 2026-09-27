#!/usr/bin/env node
// @ts-check
// #1984: WHICH `gh` ACCOUNT IS THIS PROCESS ABOUT TO ACT AS -- answered from the same three facts
// `packages/agent-org/host/gh` (the routing wrapper every `gh` invocation on this host goes through) reads,
// in the SAME order, so this module can never answer a different question than the one that actually
// decides the account. A restated conclusion drifts from the thing it restates; this reads the wrapper's
// own inputs instead.
//
// THE WRAPPER'S THREE STEPS, exactly:
//   1. an explicit `GH_CONFIG_DIR` always wins (a systemd unit, a spawned session, a developer's own shell).
//   2. else, `HERDR_WORKSPACE_ID` set: the LEADS list (`host.json`'s `gh.leadsWorkspaces`) routes to the
//      leads config, every other workspace id to the workers config -- and a config that is not INSTALLED
//      there is a REFUSAL, never a fallback to the human account (chairman, #1950, #2332, #2333).
//   3. neither variable set: this is a person's own shell, left to `gh`'s own default config.
//
// EACH BRANCH READS THE ACCOUNT OFF THE CONFIG DIRECTORY'S OWN `hosts.yml` (the `user:` line `gh auth
// login` writes there) rather than assuming a name -- "a11ign-ai-workers" and "a11ign-ai-leads" are never
// hard-coded here, because the day either account is renamed this module must not go on repeating the old
// one. NEVER the `oauth_token` beside it: this answers WHO, not WHAT CREDENTIAL, and a secret has no
// business surfacing in a diagnostic line meant to be read and journalled.
//
// NEVER GUESSES. A branch that cannot read an account says UNKNOWN and names why -- a host with no
// `.agent-org/host.json`, a `GH_CONFIG_DIR` naming a directory with no `hosts.yml`, a workspace the
// wrapper would itself refuse, or a shell with neither variable and no `~/.config/gh` either (a fresh
// checkout, or a GitHub Actions runner, where `GH_TOKEN` decides instead and this question does not apply).
// "Confirmed false" and "could not determine" are different states and must never share a value
// (`packages/agent-org/docs/roles/engineer.md`).
//
// A LEAF, like `api-pool.mjs` and `host-config.mjs`: `work-gate.mjs` reaches this on its refusal path,
// which runs before any `npm ci` or build (`api-pool.mjs`'s header states the identical constraint for the
// same reason), so this imports nothing but `node:fs`, `node:path`, and `host-config.mjs` -- itself a leaf.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeHostConfig } from "./host-config.mjs";

/** @typedef {{ login: string | null, source: string }} DeclaredAccount */

/**
 * The `user:` `gh auth login` writes into a config directory's `hosts.yml` for `github.com`, or `null`
 * when the file is absent, unreadable, or names no such line.
 *
 * READ BY REGEX, NOT A YAML LIBRARY, for the reason `lab-job.mjs` and `gh-token-jobs.test.ts`'s own CI
 * parser give theirs: a shared line this cheap does not owe itself a dependency. `hosts.yml`'s shape is
 * `gh`'s own and stable (`github.com:` at column 0, its scalar properties -- `git_protocol`, `oauth_token`,
 * `user` -- at one indent, and a `users:` map of every logged-in login at two indents beneath THAT). The
 * pattern anchors on `user:` with the colon immediately after, which a `users:` map key can never satisfy
 * (its own colon sits after the extra `s`), so the two can never be confused. The FIRST match is taken
 * because a single-host file -- the only shape this org's `gh auth login` ever produces -- carries at
 * most one.
 *
 * THE OAUTH TOKEN IS NEVER READ. `oauth_token:` is one line above `user:` in every `hosts.yml` this repo
 * has seen, and reading it would mean a credential could reach a diagnostic line by accident; this
 * function has no path that can return one.
 * @param {string} configDir @param {typeof readFileSync} read
 * @returns {string | null}
 */
function loginInConfigDir(configDir, read) {
  /** @type {string} */
  let text;
  try {
    text = String(read(join(configDir, "hosts.yml"), "utf8"));
  } catch {
    // NOT AN EMPTY CATCH: the caller reports this as UNKNOWN with the directory it tried, which is the
    // diagnostic -- there is nothing further to log here that the caller does not already say.
    return null;
  }
  const match = /^[ \t]*user:[ \t]*(\S+)[ \t]*$/m.exec(text);
  return match ? match[1] : null;
}

/**
 * WHICH ACCOUNT THIS PROCESS WILL ACT AS, derived the way `packages/agent-org/host/gh` decides it rather
 * than restated from memory. See this file's header for the three branches and why each is read off disk
 * instead of assumed.
 *
 * `host` DEFAULTS TO THE REAL DECLARATION rather than being required, unlike `poolDiagnosis`'s `run`
 * (#1405): reading `.agent-org/host.json` and a `hosts.yml` is a local file read, never a network call or
 * a `gh` spawn, so a defaulted call here costs nothing a test needs to guard against -- callers that DO
 * want a fixed answer (every test in `gh-identity-declared.test.ts`, and any caller that wants a specific
 * host) pass `host` and `env` explicitly.
 *
 * `homeHostConfig()`'s own contract is REFUSE, NEVER DEFAULT (`host-config.mjs`'s header) -- a host with
 * no declaration at all THROWS there. That refusal is swallowed here into UNKNOWN rather than left to
 * crash whichever refusal path called this: `work-gate.mjs` reaches this exactly when its OWN reads have
 * already failed, and a second, unrelated throw on that path would turn "the org could not be asked" into
 * an uncaught exception instead of a report.
 *
 * @param {{ env?: Record<string, string | undefined>, host?: import("./host-config.mjs").HostConfig,
 *           read?: typeof readFileSync }} [deps]
 * @returns {DeclaredAccount}
 */
export function declaredGhAccount({ env = process.env, host, read = readFileSync } = {}) {
  /** @type {import("./host-config.mjs").HostConfig} */
  let resolvedHost;
  try {
    resolvedHost = host ?? homeHostConfig();
  } catch (cause) {
    return { login: null,
      source: `UNKNOWN: the host declaration could not be read (${/** @type {Error} */ (cause).message})` };
  }

  // STEP 1: an explicit `GH_CONFIG_DIR` wins outright, exactly as `[ -z "$GH_CONFIG_DIR" ]` reads it --
  // an EMPTY value is the same as unset to the wrapper, and JavaScript's own falsy check agrees for free.
  const explicit = env.GH_CONFIG_DIR;
  if (explicit) {
    const login = loginInConfigDir(explicit, read);
    return login === null
      ? { login: null,
          source: `UNKNOWN: GH_CONFIG_DIR=${explicit} names no readable hosts.yml for github.com` }
      : { login, source: `declared via GH_CONFIG_DIR=${explicit}` };
  }

  // STEP 2: `HERDR_WORKSPACE_ID` routes through `host.json`'s leads list -- present in every org session,
  // absent from every systemd unit (#1974's own finding, which is why a unit needs its OWN declaration
  // instead: `identityDrift` in `host-units.mjs` covers that population, not this one).
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (workspaceId) {
    const onLeads = resolvedHost.gh.leadsWorkspaces.some((workspace) => workspace.id === workspaceId);
    const dir = join(onLeads ? resolvedHost.gh.leads : resolvedHost.gh.workers, "gh");
    const login = loginInConfigDir(dir, read);
    return login === null
      ? { login: null,
          source: `UNKNOWN: workspace ${workspaceId} routes to ${dir}, which names no readable hosts.yml -- `
            + "the wrapper REFUSES here rather than falling back to the human account (chairman, #1950)" }
      : { login, source: `declared via HERDR_WORKSPACE_ID=${workspaceId} -> ${dir}` };
  }

  // STEP 3: neither variable set -- a person's own shell, or a process the wrapper does not recognise as
  // an agent at all (a GitHub Actions runner, a fresh checkout with no session). `gh`'s own default is the
  // human's config directory, named by `host.json`'s `home` rather than a literal (`host-units.mjs`'s
  // `humanConfigDir` reads the identical path for the identical reason).
  const humanDir = join(resolvedHost.home, ".config/gh");
  const login = loginInConfigDir(humanDir, read);
  return login === null
    ? { login: null,
        source: `UNKNOWN: no GH_CONFIG_DIR, no HERDR_WORKSPACE_ID, and ${humanDir} names no readable `
          + "hosts.yml -- this process is not routed by the wrapper at all (a fresh checkout, or a runner "
          + "where GH_TOKEN decides instead and this question does not apply)" }
    : { login, source: "declared as the human account -- no HERDR_WORKSPACE_ID, so this is a person's own shell" };
}
