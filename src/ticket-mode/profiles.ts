// @ts-check
// module: the boards this board can show, from `~/.config/agent-org/profiles.json` -- this machine's own, and other machines' reached over SSH
//
// EACH MACHINE KEEPS ITS OWN BOARD, BOUND TO 127.0.0.1. A profile names one: `{ "local": true }` is this board, and `{ "ssh": "<target>" }` is the
// board on the machine `ssh <target>` reaches, exactly as `herdr --remote <target>` takes it. `remote.ts` opens the tunnel to it.
//
// NO FILE IS NO SWITCHER. A board with no profiles file behaves as it did before profiles existed. A file that breaks a rule below is refused by
// name, and the board then serves its own profile only, rather than guess which of the file's profiles were meant.
//
// THE TARGET REACHES `ssh`'S ARGUMENTS, so it is held to a shape: a name, `user@host`, `host:port` or `ssh://...`, never one that starts with `-`
// (which `ssh` would read as an option) or holds a space or a shell character. `agentOrg`, the remote's command, is run by the remote's shell, so it
// is held to a plain path.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Profile = Readonly<{ name: string; local: true } | { name: string; local: false; ssh: string; agentOrg: string }>;
export type RemoteProfile = Extract<Profile, { local: false }>;

/** The profiles read, and why the file was refused, or null. A refused file leaves no profiles, so the board shows only its own. */
export type ProfilesRead = Readonly<{ profiles: readonly Profile[]; refusal: string | null }>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SSH_TARGET = /^[A-Za-z0-9_.@:/[\]%][A-Za-z0-9_.@:/[\]%-]*$/;
const COMMAND = /^[A-Za-z0-9_./~][A-Za-z0-9_./~-]*$/;
const DEFAULT_AGENT_ORG = "agent-org";

/** Where the profiles file is: under `$XDG_CONFIG_HOME` when it is an absolute path, as the XDG rule says, and `~/.config` otherwise. */
export function profilesPath(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME;
  return join(base !== undefined && isAbsolute(base) ? base : join(home, ".config"), "agent-org", "profiles.json");
}

/** The profiles `value` names, in its order. THROWS naming the rule the first bad entry breaks. */
export function parseProfiles(value: unknown): Profile[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("it must be a JSON object of profile name to profile");
  const profiles = Object.entries(value).map(([name, entry]) => parseProfile(name, entry));
  const locals = profiles.filter((profile) => profile.local);
  if (locals.length !== 1) throw new Error(`exactly one profile must be { "local": true }, this board's own, and ${locals.length} are`);
  return profiles;
}

function parseProfile(name: string, entry: unknown): Profile {
  if (!NAME.test(name)) throw new Error(`profile name "${name}" must be 1 to 32 letters, digits, - or _, starting with a letter or digit`);
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`profile ${name} must be an object`);
  const fields = entry as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((field) => !["local", "ssh", "agentOrg"].includes(field));
  if (unknown.length > 0) throw new Error(`profile ${name} has a field no profile takes: ${unknown.join(", ")}`);
  if (fields.local !== undefined) {
    if (fields.local !== true) throw new Error(`profile ${name}: local must be true, or left out`);
    if (fields.ssh !== undefined || fields.agentOrg !== undefined) throw new Error(`profile ${name} is local, so it takes no ssh or agentOrg`);
    return { name, local: true };
  }
  if (typeof fields.ssh !== "string" || !SSH_TARGET.test(fields.ssh)) {
    throw new Error(`profile ${name}: ssh must be an ssh target such as "agents" or "me@host", not starting with - and with no spaces or shell characters`);
  }
  const agentOrg = fields.agentOrg ?? DEFAULT_AGENT_ORG;
  if (typeof agentOrg !== "string" || !COMMAND.test(agentOrg)) throw new Error(`profile ${name}: agentOrg must be a plain path to agent-org on that machine`);
  return { name, local: false, ssh: fields.ssh, agentOrg };
}

/** The profiles in the file at `path`. No file reads as no profiles. A file that cannot be parsed or breaks a rule is refused, naming why. */
export function readProfiles(path: string, read: (path: string) => string = (file) => readFileSync(file, "utf8")): ProfilesRead {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [], refusal: null };
    return { profiles: [], refusal: `${path} cannot be read: ${String((err as Error)?.message ?? err)}` };
  }
  try {
    return { profiles: parseProfiles(JSON.parse(text)), refusal: null };
  } catch (err) {
    const reason = err instanceof SyntaxError ? "it is not valid JSON" : String((err as Error).message);
    return { profiles: [], refusal: `${path} is refused, so only this board is shown: ${reason}` };
  }
}
