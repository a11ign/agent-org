// module: the GitHub plugin's routing wrapper -- the `gh` every agent on an org host runs, rendered from the host's declaration, and the rules about writing it (A11-160)
//
// THE WRAPPER (`wrapper/gh`, a shell script, moved here from `host/gh` byte for byte) decides which account or GitHub App each call acts as. It is a TEMPLATE: this file fills its nine
// placeholders from what the host declares, so a shell script never parses JSON on every `gh` call, and answers the contract's `wrapper` group (`CodeHostWrapper`): where it is installed, the text it
// must hold, why a write of it must be refused, what is wrong with the installed copy, and whether a role's App can mint. CORE WRITES THE FILE (`host-units`), after asking `refusal`.
//
// INCIDENT 2026-10-17 (A11-84): from 19:39Z to 20:59Z `~/.local/bin/gh` held a rendering whose App role table was empty, so no App token was minted for any role and every call went out as the account
// or unauthenticated (agent-org#1738's two verdicts did not post). The rendering came from a host declaration that named no App, and the tick wrote it over a wrapper that named four. So
// every path that puts this file on the host asks `refusal`, which refuses when the text it would write holds no App while the host declares one, when it would drop the Apps the installed copy names
// (unless `allowNoApps` says the host really dropped them), or when it runs its minter from a temporary directory, which is a scratch checkout's. A test run may not write the real home's bin
// directory at all (`AGENT_ORG_UNDER_TEST`, set by the rstest config).
//
// IT IMPORTS NODE'S MODULES AND CORE'S TYPES ONLY (ADR 0001). The minter and the authoring switch are run by the wrapper as programs (`app-token.ts`, `author-flag.ts`), found in this folder: under the
// installed tool's checkout when the host names one, else under the primary project's own `packages/agent-org`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeHostWrapper, HostPlace, RoleIdentity, WrapperFile, WrapperInputs, WrapperWrite } from "../../src/plugins/contracts/code-host.ts";
import type { PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { GITHUB_ROLES } from "./app-token.ts";

/** The wrapper's template, shipped beside this file. */
export const WRAPPER_TEMPLATE = fileURLToPath(new URL("./wrapper/gh", import.meta.url));

/** Where the minter and the authoring switch are, inside the tool's checkout: this folder, relative to its root. */
const PLUGIN_FOLDER = "plugins/github";
/** The canary state's file name in the host's state directory, which the authoring switch reads. Core's `host-config.ts` holds the same name (`CANARY_STATE_NAME`); `wrapper.test.ts` holds the two to one. */
export const CANARY_STATE_NAME = "machinery-canary.json";

/** The nine placeholders the template carries, filled by {@link valuesOf}. */
const PLACEHOLDER = /@@([A-Za-z0-9]+)@@/g;

/** A word a `sh` single-quoted string carries exactly, whatever the declaration holds. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** The roles the inputs declare as Apps, in the order the wrapper lists them. */
export function appRolesOf(inputs: WrapperInputs): string[] {
  return GITHUB_ROLES.filter((role) => inputs.identity[role]?.mode === "github-apps");
}

/** Where a program of this folder is run from: the installed tool's checkout when the host names one, else the primary project's own copy of the tool. */
const programOf = (place: HostPlace, file: string): string => place.tool === undefined ? join(place.checkout, "packages/agent-org", PLUGIN_FOLDER, file) : join(place.tool, PLUGIN_FOLDER, file);

/** What the template's placeholders are filled from. */
function valuesOf({ place, accounts, identity }: WrapperInputs): Record<string, string> {
  const arms = GITHUB_ROLES.flatMap((role) => {
    const app = identity[role];
    if (app?.mode !== "github-apps") return [];
    return [`    ${role}) app_id=${shellQuote(app.appId)}; app_key=${shellQuote(app.keyPath)}; app_inst=${shellQuote(app.installationId ?? "")}; app_slug=${shellQuote(app.slug ?? "")} ;;`];
  });
  return {
    binDir: place.binDir,
    workersDir: accounts.workers,
    leadsDir: accounts.leads,
    appRoles: appRolesOf({ place, accounts, identity }).join(" "),
    appDeclared: ["case \"$1\" in", ...arms, "    *) return 1 ;;", "  esac"].join("\n"),
    appTokenDir: place.stateEntry("app-tokens"),
    appTokenScript: programOf(place, "app-token.ts"),
    // the authoring switch (agent-org#1666): the leaf that reads it, and the canary state it reads, in the state directory `org-health` writes
    authorFlagScript: programOf(place, "author-flag.ts"),
    canaryStateFile: place.stateEntry(CANARY_STATE_NAME),
  };
}

/** Fills the template. A placeholder the values do not carry is REFUSED, by name, so a template that grew a new one before this did never installs a wrapper that still says `@@name@@`. */
function render(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`gh: \`@@${name}@@\` is a placeholder no value fills`);
    return values[name];
  });
}

/** The default of `APP_ROLES` in a rendered wrapper, the one place a role table is written as a list. */
const WRAPPER_ROLE_DEFAULT = /^APP_ROLES=\$\{A11Y_APP_ROLES-([^}\n]*)\}$/m;
/** An arm of `app_declared()`: one role, one app. A table with no arm mints nothing, whatever `APP_ROLES` says. */
const WRAPPER_APP_ARM = /^ {4}[a-z]+\) app_id=/gm;
/** The minter's path, as the rendered wrapper names it: the one default the mint reads. */
const WRAPPER_MINT_SCRIPT = /^  app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-([^}\n]+)\}$/m;
/** The defaults of the two scripts a rendered wrapper RUNS: the App minter and the authoring switch's flag script (`${TMPDIR:-/tmp}` is a scratch file, not a script). */
const WRAPPER_SCRIPT_DEFAULTS = /\$\{(?:A11Y_APP_TOKEN_SCRIPT|A11Y_GH_FLAG_SCRIPT):-([^}\n]+)\}/g;
/** The two places the wrapper carries the identity: the roles line and the `app_declared()` body. */
const WRAPPER_APP_ROLES = /^APP_ROLES=.*$/m;
const WRAPPER_APP_DECLARED = /^app_declared\(\) \{\n[\s\S]*?\n\}$/m;

/**
 * The roles a rendered or installed wrapper routes to an App: `[]` for an empty table, and `null` for text with no role table at all (a copy from before #4900).
 */
export function wrapperRoles(text: string): string[] | null {
  const roles = WRAPPER_ROLE_DEFAULT.exec(text)?.[1];
  if (roles === undefined) return null;
  return [...text.matchAll(WRAPPER_APP_ARM)].length === 0 ? [] : roles.split(" ").filter((role) => role !== "");
}

/**
 * The identity a rendered wrapper carries, as the text of those two places, or `null` for a wrapper that has neither (a copy from before #4900). Compared as TEXT so the comparison and the
 * render cannot disagree: both are the one template filled by {@link valuesOf}.
 */
export function wrapperIdentity(text: string): string | null {
  const roles = WRAPPER_APP_ROLES.exec(text)?.[0];
  const declared = WRAPPER_APP_DECLARED.exec(text)?.[0];
  return roles === undefined || declared === undefined ? null : `${roles}\n${declared}`;
}

/**
 * The first path a rendered wrapper defaults into `/tmp`, or `null`: the scratch-checkout wrapper the incident's copy was (`/tmp/claude-1000/...`). It is the system
 * `/tmp` and not `os.tmpdir()`, because a test run's own temporary directory is a fixture's, and every such fixture renders from one.
 */
function temporaryDefault(text: string): string | null {
  const temp = resolve("/tmp");
  for (const [, value] of text.matchAll(WRAPPER_SCRIPT_DEFAULTS)) {
    if (value === temp || value.startsWith(`${temp}/`)) return value;
  }
  return null;
}

/** The real home's `.local/bin`, found by the account's home and NOT by `$HOME`, which a test overrides (the incident's `binDir` came in through a copied host file). */
const realBinDirectory = (): string => join(userInfo().homedir, ".local", "bin");

/** How long a mint probe may run. */
const MINT_PROBE_MS = 30_000;

/** The minter this plugin ships, for a host that installs no wrapper to name one (a ticket-only host). */
export const MINTER = fileURLToPath(new URL("./app-token.ts", import.meta.url));

/**
 * Why `role`'s token cannot be minted for `app` by `script`, or null when it can. It runs the minter the INSTALLED wrapper would run, with the declared app, into a token directory of its own,
 * so the probe never reads or writes the cache the wrapper reads. The reason is the first line the minter printed, so a key that moved or an App that was removed is the one thing to fix.
 */
export function probeMint(deps: Pick<PluginDeps, "exec" | "env">, script: string, role: string, app: Extract<RoleIdentity, { mode: "github-apps" }>): string | null {
  const dir = mkdtempSync(join(tmpdir(), "gh-mint-probe-"));
  try {
    const result = deps.exec(deps.env.A11Y_APP_NODE ?? "node", [script, role], { timeoutMs: MINT_PROBE_MS,
      env: { A11Y_APP_ID: app.appId, A11Y_APP_KEY_PATH: app.keyPath, A11Y_APP_INSTALLATION_ID: app.installationId ?? "", A11Y_APP_TOKEN_DIR: dir } });
    const token = result.stdout.trim();
    if (result.status === 0 && token !== "" && !/\s/.test(token)) return null;
    return result.stderr.split("\n").find((line) => line.trim() !== "") ?? `the minter exited ${result.status}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The wrapper's operations, over the seams a test injects: `readFile` reads the template, and `exec` runs the minter for a probe. */
export function createWrapper(deps: Pick<PluginDeps, "exec" | "readFile" | "env">): CodeHostWrapper {
  const file = (inputs: WrapperInputs): WrapperFile => {
    let template: string | null;
    try {
      template = deps.readFile(WRAPPER_TEMPLATE);
    } catch {
      template = null;
    }
    return { target: join(inputs.place.binDir, "gh"), mode: 0o755, expected: template === null ? null : render(template, valuesOf(inputs)) };
  };
  const appRoles = (inputs: WrapperInputs): readonly string[] => appRolesOf(inputs);
  const divergence: CodeHostWrapper["divergence"] = (inputs, { target, installed }) => {
    const { expected } = file(inputs);
    if (expected === null) return "the repository's gh wrapper could not be read, so this host cannot be compared to it";
    if (installed === null) return `there is no gh wrapper at ${target}`;
    if (installed === expected) return null;
    const declared = appRoles(inputs);
    const named = wrapperRoles(installed) ?? [];
    if (named.length === 0 && declared.length > 0) {
      return `${target} names no App role, but host.json declares ${declared.join(", ")}, so no App token is minted for any of them`;
    }
    return wrapperIdentity(installed) === wrapperIdentity(expected)
      ? `${target} is not the wrapper this repository renders from host.json, though its App roles agree`
      : `${target} names ${named.join(", ") || "no App"}, and host.json declares ${declared.join(", ") || "no App"}`;
  };
  return {
    file,
    appRoles,
    refusal: (write) => refusalOf(write, appRoles(write.inputs)),
    divergence,
    identityStale(inputs, installed) {
      const { expected } = file(inputs);
      const wanted = expected === null ? null : wrapperIdentity(expected);
      if (wanted === null) return false;
      const has = wrapperIdentity(installed);
      return !(has === wanted || (has === null && appRoles(inputs).length === 0));
    },
    mintFailure(inputs, role) {
      const app = inputs.identity[role];
      if (app?.mode !== "github-apps") return null;
      const script = WRAPPER_MINT_SCRIPT.exec(file(inputs).expected ?? "")?.[1];
      return script === undefined ? "the wrapper names no minter, so no App token can be minted" : probeMint(deps, script, role, app);
    },
  };
}

/**
 * Why `write.text` may not be written, each with its reason, in this order:
 *   1. (a test run) the target is inside the real home's bin directory;
 *   2. (production, not a test run) the text runs its minter from a temporary directory;
 *   3. the text has no App role table at all;
 *   4. the text names no App while the host declares `github-apps` roles (the render is broken, or the declaration is not the host's);
 *   5. the text names no App and the installed copy names some, unless `allowNoApps` (the downgrade: the incident's case, which `host:install --allow-no-apps` takes).
 */
function refusalOf({ target, text, installed, allowNoApps, under = process.env.AGENT_ORG_UNDER_TEST === "1", realBin = realBinDirectory() }: WrapperWrite, declared: readonly string[]): string | null {
  const inside = relative(resolve(realBin), resolve(target));
  if (under && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    return "a test run may not write the real home's bin directory: a test takes its bin directory from a fixture";
  }
  // Production only: a test run's fixtures are checkouts in the runner's own temporary directory, so under a test run the real-bin tripwire above is the guard,
  // and it refuses the one write that matters (the machine's own wrapper).
  const scratch = temporaryDefault(text);
  if (!under && scratch !== null) return `the wrapper runs ${scratch}, which is in a temporary directory, so it was rendered from a scratch checkout`;
  const rendered = wrapperRoles(text);
  if (rendered === null) return "the rendered text has no App role table to check";
  if (rendered.length === 0 && declared.length > 0) return `host.json declares github-apps roles (${declared.join(", ")}), but the rendered wrapper names none`;
  if (rendered.length === 0 && !allowNoApps) {
    const named = installed === null ? [] : wrapperRoles(installed) ?? [];
    if (named.length > 0) {
      return `the rendered wrapper names no App role and the installed one names ${named.join(", ")}: that drops their identity. `
        + "`host:install --allow-no-apps` writes it, for a host that really dropped its Apps";
    }
  }
  return null;
}

/** One role's identity as a plugin's settings hold it, read leniently: the host file's reader has already refused what is malformed, so an entry that is not an App is the person's account. */
function roleIdentityOf(raw: unknown): RoleIdentity {
  const entry = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const text = (name: string): string | undefined => {
    const value = entry[name];
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const appId = text("appId");
  const keyPath = text("keyPath");
  if (entry.mode !== "github-apps" || appId === undefined || keyPath === undefined) return { mode: "user-accounts" };
  const installationId = text("installationId");
  const slug = text("slug");
  return { mode: "github-apps", appId, keyPath, ...(installationId === undefined ? {} : { installationId }), ...(slug === undefined ? {} : { slug }) };
}

/** The wrapper's inputs, from the plugin's settings (`identity`, `gh`) and the host's place. The accounts' folders are empty text when the settings name none, which only a doctor row reads. */
export function inputsOfSettings(settings: PluginSettings, place: HostPlace): WrapperInputs {
  const identity = typeof settings.identity === "object" && settings.identity !== null ? settings.identity as Record<string, unknown> : {};
  const gh = typeof settings.gh === "object" && settings.gh !== null ? settings.gh as Record<string, unknown> : {};
  const folder = (name: string): string => (typeof gh[name] === "string" ? gh[name] as string : "");
  return { place, accounts: { workers: folder("workers"), leads: folder("leads") }, identity: Object.fromEntries(GITHUB_ROLES.map((role) => [role, roleIdentityOf(identity[role])])) };
}

/** The Apps the settings declare, by role, in the wrapper's order: what a doctor row mints for even where no wrapper is installed (a ticket-only host). */
export function appsOfSettings(settings: PluginSettings): readonly Readonly<{ role: string; app: Extract<RoleIdentity, { mode: "github-apps" }> }>[] {
  const identity = typeof settings.identity === "object" && settings.identity !== null ? settings.identity as Record<string, unknown> : {};
  return GITHUB_ROLES.flatMap((role) => {
    const app = roleIdentityOf(identity[role]);
    return app.mode === "github-apps" ? [{ role, app }] : [];
  });
}
