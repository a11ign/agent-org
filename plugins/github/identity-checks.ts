// module: the GitHub plugin's identity rows for doctor -- the installed `gh` wrapper, the roles it routes to Apps, and whether each App mints a token (A11-160)
//
// Moved out of `install/doctor.ts` (`ghWrapperChecks`), which read the host's own module (`host-units.ts`, A11-84), with the rows' names and words kept: `gh wrapper` (the installed copy is the one the
// host file declares) and `app token <role>` (a declared role's App mints). `wrapper roles` is new: the roles the installed wrapper routes to an App against the roles the identity setting declares,
// said on a row of its own so a wrapper that lost a role names it. THEY RUN ON A TICKET-ONLY HOST TOO, which they were "not applicable" on: a host file with no project installs no wrapper, so the wrapper
// rows say that, and an App a ticket-only host declares is still minted for by this plugin's own minter.
import type { CodeHostPolicy, PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { GH_TIMEOUT_MS } from "./gh.ts";
import { githubRepoOf } from "./stack-extension.ts";
import { appsOfSettings, appRolesOf, createWrapper, identityOfRole, inputsOfSettings, mintScriptOf, MINTER, probeMint, probePermissions, wrapperRoles } from "./wrapper.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** The fix for a wrapper that could not be checked: the checks read the host file the tool's own checkout resolves. */
const FROM_THE_TOOLS_CHECKOUT = "run `agent-org doctor` from the checkout that host.json's `tool` names";
const REINSTALL = "run `agent-org host:install`, which renders the wrapper from host.json and writes it, or start the instance, which re-renders it";

/** The installed file's text, or null when there is none (or it cannot be read). */
function textOf(path: string, deps: Pick<PluginDeps, "readFile">): string | null {
  try {
    return deps.readFile(path);
  } catch {
    return null;
  }
}

const mintRow = (role: string, failure: string | null): PluginCheck => failure === null ? ok(`app token ${role}`, `the ${role} App mints a token`)
  : failed(`app token ${role}`, `the ${role} App's token mint failed: ${failure}`, `fix the key or the App host.json declares for ${role}, then run \`agent-org host:install\``);

/** One role's row of the list: `workers, reviewer`, or `no role`. */
const listOf = (roles: readonly string[]): string => (roles.length === 0 ? "no role" : roles.join(", "));

/** Whether the installed wrapper routes the roles the identity setting declares, said as a row: the installed copy's role table against the declared one. */
function rolesRow(declared: readonly string[], installed: string | null): PluginCheck {
  const name = "wrapper roles";
  if (installed === null) {
    return declared.length === 0 ? ok(name, "no role is declared as an App, and no wrapper is installed")
      : failed(name, `host.json declares ${listOf(declared)} as Apps, and no wrapper is installed to route them`, REINSTALL);
  }
  const named = wrapperRoles(installed) ?? [];
  return named.join(" ") === declared.join(" ") ? ok(name, `the installed wrapper routes ${listOf(named)} to an App, as host.json declares`)
    : failed(name, `the installed wrapper routes ${listOf(named)} to an App, and host.json declares ${listOf(declared)}`, REINSTALL);
}

type ClaimIdentity = CodeHostPolicy["claimIdentities"][number];

/** The permission GitHub names the commit status access by, and the choice it is granted with. */
const COMMIT_STATUSES = "Commit statuses";
const GRANT_WORDS = { read: "Read-only", write: "Read and write" } as const;

/** Whether a granted level of `statuses` is the access the claim needs: `write` for a write, and `read` or `write` for a read. */
const meets = (access: ClaimIdentity["access"], granted: string | undefined): boolean => granted === "write" || (access === "read" && granted === "read");

/**
 * The row for one identity the review claim uses, when its role is an App (A11-172): the App's installation is READ with its JWT, which writes nothing and mints no token, and `statuses` must be the access the claim
 * needs. A failure names the App and the exact permission to grant, and says the organisation must accept the change on the installation, since an App's permission change takes effect only then.
 */
function appStatusRow(deps: PluginDeps, script: string | undefined, { role, access }: ClaimIdentity, app: Parameters<typeof probePermissions>[3]): PluginCheck {
  const name = `commit statuses ${role}`;
  const said = script === undefined ? { failure: "the wrapper names no minter, so the installation cannot be read" } : probePermissions(deps, script, role, app);
  if ("failure" in said) {
    return failed(name, `the ${role} App's installation permissions could not be read: ${said.failure}`, `fix the key or the App host.json declares for ${role} (see the app token ${role} row), then run \`agent-org doctor\``);
  }
  const named = said.appSlug ?? `${role}`;
  if (meets(access, said.permissions.statuses)) return ok(name, `the ${named} App's installation has the "${COMMIT_STATUSES}" ${said.permissions.statuses} permission the review claim needs (${access})`);
  const accept = said.htmlUrl === null ? "on its installation" : `on its installation (${said.htmlUrl})`;
  return failed(name, `the ${named} App's installation has no "${COMMIT_STATUSES}" ${access} permission (it has: ${said.permissions.statuses ?? "none"})`,
    `grant the ${named} App "${COMMIT_STATUSES}: ${GRANT_WORDS[access]}" (Repository permissions) and accept the change ${accept}, then run \`agent-org doctor\``);
}

/** The first GitHub repository a clone of this host names, or null when none does. */
function firstRepositoryOf(deps: Pick<PluginDeps, "exec" | "clones">): string | null {
  for (const path of Object.values(deps.clones)) {
    const remote = deps.exec("git", ["-C", path, "remote", "get-url", "origin"]);
    const repo = remote.status === 0 ? githubRepoOf(remote.stdout) : null;
    if (repo !== null) return repo;
  }
  return null;
}

/**
 * The row for one identity the review claim uses, when its role is a user account (A11-172): a commit status is posted with push access to the repository and listed with pull access, so the first GitHub
 * repository a clone names is read as that account and its `permissions` must hold the one the claim needs.
 */
function accountStatusRow(deps: PluginDeps, { role, access, env }: ClaimIdentity): PluginCheck {
  const name = `commit statuses ${role}`;
  const repo = firstRepositoryOf(deps);
  if (repo === null) return ok(name, `the ${role} role is a user account, and no clone of this host names a GitHub repository to read its access to`);
  const needs = access === "write" ? "push" : "pull";
  const result = deps.exec("gh", ["api", `repos/${repo}`, "--jq", ".permissions"], { timeoutMs: GH_TIMEOUT_MS, env });
  if (result.status !== 0) {
    const why = result.stderr.split("\n").find((line) => line.trim() !== "") ?? `exit ${result.status}`;
    return failed(name, `the ${role} account's access to ${repo} could not be read: ${why}`, `check that the ${role} account (${env.GH_CONFIG_DIR ?? "this machine's gh account"}) is signed in, then run \`agent-org doctor\``);
  }
  let held: Record<string, unknown> = {};
  try {
    held = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    // an answer that is not JSON holds no permission: the row below says so
  }
  if (held[needs] === true) return ok(name, `the ${role} account has ${needs} access to ${repo}, which a commit status needs (${access})`);
  return failed(name, `the ${role} account has no ${needs} access to ${repo}, which ${access === "write" ? "writing" : "listing"} a commit status needs`,
    `give the ${role} account (${env.GH_CONFIG_DIR ?? "this machine's gh account"}) ${needs} access to ${repo}, then run \`agent-org doctor\``);
}

/** The rows for the identities the review claim uses, one per role core names (A11-172), each App or account asked whether it can write or list a commit status. None on a machine that starts no reviewer. */
function claimStatusChecks(settings: PluginSettings, deps: PluginDeps, script: (role: string) => string | undefined): PluginCheck[] {
  return deps.policy.claimIdentities.map((claim) => {
    const identity = identityOfRole(settings, claim.role);
    return identity.mode === "github-apps" ? appStatusRow(deps, script(claim.role), claim, identity) : accountStatusRow(deps, claim);
  });
}

/**
 * The wrapper's rows: the installed copy is the one the host file declares, the roles it routes to Apps are the declared ones, and each declared role's App mints. A role whose mint fails names the
 * reason the minter printed first, so a key that moved or an App that was removed is the one thing to fix.
 */
export async function wrapperChecks(settings: PluginSettings, deps: PluginDeps): Promise<PluginCheck[]> {
  const reading = await deps.place();
  if (reading.kind === "skipped") return [];
  if (reading.kind === "unreadable") return [failed("gh wrapper", `cannot be checked: ${reading.reason}`, FROM_THE_TOOLS_CHECKOUT)];
  if (reading.kind === "no-project") {
    return [ok("gh wrapper", "not applicable: host.json declares no project, so this machine installs no wrapper"),
      // No commit status row: a host with no project loads no gate, so it starts no reviewer and writes no review claim.
      ...appsOfSettings(settings).map(({ role, app }) => mintRow(role, probeMint(deps, MINTER, role, app)))];
  }
  const wrapper = createWrapper(deps);
  const inputs = inputsOfSettings(settings, reading.place);
  try {
    const { target } = wrapper.file(inputs);
    const installed = textOf(target, deps);
    const divergence = wrapper.divergence(inputs, { target, installed });
    return [
      divergence === null ? ok("gh wrapper", "the installed wrapper is the one host.json declares") : failed("gh wrapper", divergence, REINSTALL),
      rolesRow(appRolesOf(inputs), installed),
      ...appRolesOf(inputs).map((role) => mintRow(role, wrapper.mintFailure(inputs, role))),
      ...claimStatusChecks(settings, deps, () => mintScriptOf(deps, inputs)),
    ];
  } catch (cause) {
    return [failed("gh wrapper", `cannot be checked: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`, FROM_THE_TOOLS_CHECKOUT)];
  }
}
