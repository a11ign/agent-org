// module: the GitHub plugin's identity rows for doctor -- the installed `gh` wrapper, the roles it routes to Apps, and whether each App mints a token (A11-160)
//
// Moved out of `install/doctor.ts` (`ghWrapperChecks`), which read the host's own module (`host-units.ts`, A11-84), with the rows' names and words kept: `gh wrapper` (the installed copy is the one the
// host file declares) and `app token <role>` (a declared role's App mints). `wrapper roles` is new: the roles the installed wrapper routes to an App against the roles the identity setting declares,
// said on a row of its own so a wrapper that lost a role names it. THEY RUN ON A TICKET-ONLY HOST TOO, which they were "not applicable" on: a host file with no project installs no wrapper, so the wrapper
// rows say that, and an App a ticket-only host declares is still minted for by this plugin's own minter.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { appsOfSettings, appRolesOf, createWrapper, inputsOfSettings, MINTER, probeMint, wrapperRoles } from "./wrapper.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

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

/**
 * The wrapper's rows: the installed copy is the one the host file declares, the roles it routes to Apps are the declared ones, and each declared role's App mints. A role whose mint fails names the
 * reason the minter printed first, so a key that moved or an App that was removed is the one thing to fix.
 */
export async function wrapperChecks(settings: PluginSettings, deps: PluginDeps): Promise<PluginCheck[]> {
  const reading = await deps.place();
  if (reading.kind === "unreadable") return [failed("gh wrapper", `cannot be checked: ${reading.reason}`, "run `agent-org doctor` from the checkout that host.json's `tool` names")];
  if (reading.kind === "no-project") {
    return [ok("gh wrapper", "not applicable: host.json declares no project, so this machine installs no wrapper"),
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
    ];
  } catch (cause) {
    return [failed("gh wrapper", `cannot be checked: ${String((cause as Error)?.message ?? cause).split("\n")[0]}`, "run `agent-org doctor` from the checkout that host.json's `tool` names")];
  }
}
