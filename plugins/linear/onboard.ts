// @ts-check
// module: the Linear plugin's onboard steps -- where the key lives, storing it, registering Linear's MCP for Claude Code, and the read connectors (A11-159)
//
// Moved out of `install/onboard.ts` with their words unchanged. Onboard runs a plugin's steps in order at the point where it set Linear up before, giving each the block's settings as
// the earlier steps left them. A step returns the settings it wants written (`key`, then `connectors`), and onboard writes them into the tracker block. A step that has nothing to
// say returns an empty detail, which onboard does not print.
//
// IT NEVER ECHOES A KEY. A key is stored only when none is readable and a person is at the terminal: into the Keychain by `security`'s own prompt, which does not echo, or into a
// mode-600 file from a prompt that does not echo. It then reads the key back to check it is there, and says WHERE it is, never what it is. The key goes to `claude` as an argument
// and is never printed: a message that would carry it carries `<key>` instead.
import { isAbsolute, join } from "node:path";
import type { OnboardStepDeps, OnboardStep, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { keyOf } from "./checks.ts";
import { CONNECTORS, MCP_NAME, MCP_URL } from "./connectors.ts";
import { DEFAULT_KEYCHAIN_SERVICE, keySource, placeOf, type KeySource } from "./key.ts";

const expandHome = (path: string, home: string): string => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);
const firstLine = (text: string, status: number | null): string => text.trim().split("\n")[0] || `exit ${status}`;
/** `text` with every occurrence of `secret` replaced by `<key>`, for a message a program that was handed the key may echo. */
const scrub = (text: string, secret: string): string => (secret === "" ? text : text.split(secret).join("<key>"));

/** A Keychain service name is printed in a command to paste, so it is held to characters a shell reads as they are. */
function keychainService(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`\`${name}\` is not a Keychain service name: use letters, digits, \`.\`, \`_\` and \`-\``);
  return name;
}

/** The key source a flag names, or undefined when none does. REFUSES both flags, and a key file that is not an absolute path. */
function flagged(deps: OnboardStepDeps): KeySource | undefined {
  const { keychain, keyFile } = deps.flags;
  if (keychain !== undefined && keyFile !== undefined) throw new Error("give --linear-keychain or --linear-key-file, not both");
  if (typeof keychain === "string") return { keychain: keychainService(keychain) };
  if (typeof keyFile === "string") {
    const path = expandHome(keyFile, deps.home);
    if (!isAbsolute(path)) throw new Error("--linear-key-file must be an absolute path");
    return { path };
  }
  return undefined;
}

/** Where the OS keeps the Linear key when no one names it: the Keychain on a Mac, a mode-600 file elsewhere. */
const fallbackSource = (deps: OnboardStepDeps): KeySource => (deps.platform === "darwin" ? { keychain: DEFAULT_KEYCHAIN_SERVICE } : { path: join(deps.agentOrgHome, "linear.key") });

/** The place a person names at a terminal for the Linear key, or the fallback when they name none. */
async function askSource(deps: OnboardStepDeps): Promise<KeySource> {
  const fallback = fallbackSource(deps);
  const answer = (await deps.ask(`Where is the Linear key read from? A Keychain service name, or an absolute file path [${"keychain" in fallback ? fallback.keychain : fallback.path}]: `)).trim();
  if (answer === "") return fallback;
  const path = expandHome(answer, deps.home);
  return isAbsolute(path) ? { path } : { keychain: keychainService(answer) };
}

/** The key source the block now names: a flag outright, else the block's own value, else the person's answer at a terminal (none when a profile answered), else the OS's place. */
async function sourceOf(settings: PluginSettings, deps: OnboardStepDeps): Promise<KeySource> {
  const named = flagged(deps);
  if (named !== undefined) return named;
  if (settings.key !== undefined) return keySource(settings.key);
  return !deps.answered && deps.interactive ? await askSource(deps) : fallbackSource(deps);
}

function readable(source: KeySource, deps: OnboardStepDeps): boolean {
  try {
    keyOf(source, deps);
    return true;
  } catch {
    return false;
  }
}

/** The step that decides where the key is read from. It writes the `key` setting. */
const keyLocation: OnboardStep = {
  name: "key location",
  explain: "Where Linear's personal API key is read from: the macOS Keychain on a Mac, a mode-600 file elsewhere, or the place a flag or the tracker block names.",
  async run(settings, deps): Promise<StepResult> {
    const source = await sourceOf(settings, deps);
    return { ok: true, detail: "", settings: { key: source } };
  },
};

/** Store a key where `source` says, by a prompt that does not echo. Only called with a person at the terminal. */
async function storeKey(source: KeySource, deps: OnboardStepDeps): Promise<void> {
  if ("keychain" in source) {
    deps.log(`Paste your Linear personal API key at the Keychain prompt (it is not shown). It is stored under ${source.keychain}.`);
    // `security` prompts for the password itself when `-w` is last and has no value, and does not echo it.
    const stored = deps.exec("security", ["add-generic-password", "-U", "-a", deps.env.USER ?? "", "-s", source.keychain, "-w"], { inherit: true });
    if (stored.status !== 0) throw new Error(`security add-generic-password exited ${stored.status}`);
    return;
  }
  const key = (await deps.askSecret(`Paste your Linear personal API key (it is not shown). It is written to ${source.path}, mode 600: `)).trim();
  if (key === "") return;
  deps.writeFile(source.path, `${key}\n`);
}

/** The command that stores a Linear key the machine cannot read yet, said with where it goes. */
function missingLine(source: KeySource): string {
  const store = "keychain" in source ? `Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w` : `Write it to ${source.path} with mode 600`;
  return `NO LINEAR KEY is readable from ${placeOf(source)}. ${store}, then run \`agent-org doctor\`.`;
}

/** The step that stores the key when none is readable and a person is at the terminal, then reads it back to say whether it is there. */
const keyStorage: OnboardStep = {
  name: "key storage",
  explain: "Stores the Linear key when none is readable and a person is at the terminal, then reads it back. It says where the key is, never what it is.",
  async run(settings, deps): Promise<StepResult> {
    const source = keySource(settings.key);
    if (!readable(source, deps) && deps.interactive) await storeKey(source, deps);
    return readable(source, deps) ? { ok: true, detail: `the Linear key is readable from ${placeOf(source)}` }
      : { ok: false, detail: missingLine(source) };
  },
};

/** The step that registers Linear's MCP for Claude Code at user scope, authenticated by the key, unless a `linear` MCP is there already. */
const mcpRegistration: OnboardStep = {
  name: "mcp registration",
  explain: "Registers Linear's MCP for Claude Code at user scope, authenticated by the key, so workers can read their tickets. A `linear` MCP that is there already is left as it is.",
  async run(settings, deps): Promise<StepResult> {
    const source = keySource(settings.key);
    if (!readable(source, deps)) return { ok: false, detail: "" };
    if (deps.exec("claude", ["mcp", "get", MCP_NAME]).status === 0) return { ok: true, detail: "Claude Code has a `linear` MCP already, so onboard left it as it is" };
    const key = keyOf(source, deps).trim();
    const added = deps.exec("claude", ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, MCP_URL, "--header", `Authorization: Bearer ${key}`]);
    if (added.status === 0) return { ok: true, detail: `registered Linear's MCP for Claude Code (user scope), authenticated by the key in ${placeOf(source)}` };
    return { ok: false, detail: `could not register Linear's MCP for Claude Code: ${scrub(firstLine(added.stderr || added.stdout, added.status), key)}. Workers cannot read Linear until it is; run \`agent-org onboard\` again, or \`claude mcp add --scope user --transport http ${MCP_NAME} ${MCP_URL} --header "Authorization: Bearer <key>"\`` };
  },
};

/** `connectors` with Linear's read and comment tools added where absent. A value that is not a list is left for the host reader to refuse (undefined: no change). */
export function withConnectors(connectors: unknown): unknown {
  if (connectors === undefined) return [...CONNECTORS];
  if (!Array.isArray(connectors)) return connectors;
  return [...connectors, ...CONNECTORS.filter((pattern) => !connectors.includes(pattern))];
}

/** The step that lets the workers call Linear's reads: the tracker block's `connectors`, with the read and comment tools added where absent. */
const readConnectors: OnboardStep = {
  name: "read connectors",
  explain: "Adds Linear's read and comment tools to the tracker block's connectors, which is what lets a worker read a ticket. Never a save of an issue, a state or a relation.",
  async run(settings, deps): Promise<StepResult> {
    if (!readable(keySource(settings.key), deps)) return { ok: false, detail: "" };
    return { ok: true, detail: "", settings: { connectors: withConnectors(settings.connectors) } };
  },
};

export const ONBOARD_STEPS: readonly OnboardStep[] = Object.freeze([keyLocation, keyStorage, mcpRegistration, readConnectors]);
