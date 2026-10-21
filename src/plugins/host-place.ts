// @ts-check
// module: where the host file says the machine keeps what a code host's routing wrapper is rendered from (A11-160)
//
// THE WRAPPER'S INPUTS ARE THE HOST FILE'S FACTS, which a plugin cannot import the reader of (ADR 0001), so core reads them and hands them over: `hostPlaceOf` is the place (where programs are put on
// PATH, the installed tool, the primary project's checkout and the state directory's entries), and `wrapperInputsOf` adds the accounts' folders and each role's identity, which the code host plugin holds as
// settings and which the reader has already checked. A host that cannot be read is `readHostPlace`'s `unreadable`, never an empty place.
import { GITHUB_ROLES, HostConfigRefusal, type HostConfig, homeHostConfig, roleIdentity, stateEntryPath } from "../host-config.ts";
import type { HostPlace, RoleIdentity, WrapperInputs } from "./contracts/code-host.ts";
import type { HostPlaceReading } from "./manifest.ts";

/** The place of a host. The state directory's entries are where `stateEntryPath` puts them for that host, not for the process's environment. */
export function hostPlaceOf(host: Readonly<HostConfig>): HostPlace {
  const primary = host.projects.find((project) => project.id === host.primary);
  if (primary === undefined) throw new HostConfigRefusal("primary", `\`${host.primary}\` is not one of \`projects\``, "host.json");
  return { binDir: host.binDir, tool: host.tool, checkout: primary.checkout, stateEntry: (name) => stateEntryPath(name, { host, home: host.home, env: {} }) };
}

/** What the wrapper is rendered from for a host: its place, its accounts' folders and every role's identity. */
export function wrapperInputsOf(host: Readonly<HostConfig>): WrapperInputs {
  const identity = Object.fromEntries(GITHUB_ROLES.map((role): [string, RoleIdentity] => [role, roleIdentity(host, role)]));
  return { place: hostPlaceOf(host), accounts: { workers: host.gh.workers, leads: host.gh.leads }, identity };
}

/** The place of the host this process runs on, or why there is none. `read` is the host reader, which a test replaces. */
export async function readHostPlace(read: () => Readonly<HostConfig> = homeHostConfig): Promise<HostPlaceReading> {
  try {
    return { kind: "place", place: hostPlaceOf(read()) };
  } catch (cause) {
    return { kind: "unreadable", reason: String((cause as Error)?.message ?? cause).split("\n")[0] };
  }
}

