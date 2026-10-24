// @ts-check
// module: the Linear plugin's onboard steps -- where the key lives, connecting to Linear with it, registering Linear's MCP for Claude Code, and the read connectors (A11-159, A11-222)
//
// Moved out of `install/onboard.ts` with their words unchanged, then reworded (A11-222) so a person can tell what is being asked. Onboard runs a plugin's steps in order at the point where it set Linear up before, giving each the block's
// settings as the earlier steps left them. A step returns the settings it wants written (`key`, then `connectors`), and onboard writes them into the tracker block. A step that has nothing to say returns an empty detail, which onboard does not print.
//
// "CONNECT TO LINEAR" IS THE KEY STEP. Where the key lives is NOT ASKED: it is the macOS Keychain on a Mac and a mode-600 file elsewhere, unless `--linear-keychain`, `--linear-key-file` or the tracker block's `key` names another. The person is told
// where it will be kept and where to create one, asked for it at a prompt that does not echo, and THE KEY IS CHECKED AGAINST LINEAR AT ONCE (the `viewer` query) so the step can say whose account it is. A key Linear rejects is asked for again;
// Linear that cannot be reached still gets the key stored, said as not checked.
//
// IT NEVER ECHOES A KEY. A key is stored only when none is readable and a person is at the terminal: into the Keychain through `security -i`, with the command on its standard input so the key is never an argument in a process list, or into a
// mode-600 file. It then reads the key back to check it is there, and says WHERE it is, never what it is. The key goes to `claude` as an argument and is never printed: a message that would carry it carries `<key>` instead.
import { isAbsolute, join } from "node:path";
import type { OnboardStepDeps, OnboardStep, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { keyOf } from "./checks.ts";
import { CONNECTORS, MCP_NAME, MCP_URL } from "./connectors.ts";
import { DEFAULT_KEYCHAIN_SERVICE, keySource, placeOf, type KeySource } from "./key.ts";
import { linearSource } from "./linear.ts";

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

/** The key source the block now names: a flag outright, else the block's own value, else the OS's place. Nobody is asked where: a different place is an advanced option, named by a flag or the block. */
function sourceOf(settings: PluginSettings, deps: OnboardStepDeps): KeySource {
  return flagged(deps) ?? (settings.key !== undefined ? keySource(settings.key) : fallbackSource(deps));
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
    return { ok: true, detail: "", settings: { key: sourceOf(settings, deps) } };
  },
};

/** A Linear key is letters, digits, `_`, `-` and `.`; anything else is not one, and is never put in a command. */
const LOOKS_LIKE_A_KEY = /^[A-Za-z0-9_.-]+$/;
/** How many times a key Linear rejects is asked for before the step gives up with its fix. */
const ATTEMPTS = 3;

/** The command that stores a Linear key, for a person to run by hand. */
function storeCommand(source: KeySource): string {
  return "keychain" in source ? `security add-generic-password -U -a "$USER" -s ${source.keychain} -w` : `write it to ${source.path} with mode 600`;
}

/** The command that stores a Linear key the machine cannot read yet, said with where it goes. */
function missingLine(source: KeySource): string {
  const store = "keychain" in source ? `Store one with: ${storeCommand(source).replace(" -U", "")}` : `Write it to ${source.path} with mode 600`;
  return `NO LINEAR KEY is readable from ${placeOf(source)}. ${store}, then run \`agent-org doctor\`.`;
}

/** `path` with the home folder as `~`, as a person writes it. */
const shown = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** What the person is told before the key is asked for: where it will be kept, and where to create one. */
function introduction(source: KeySource, deps: OnboardStepDeps): string[] {
  const where = "keychain" in source ? "the macOS Keychain" : `a private file, ${shown(source.path, deps.home)}, readable only by you`;
  return ["Connect to Linear", `agent-org keeps your Linear key in ${where}.`,
    "Create a personal API key at Linear → Settings → Security & access → Personal API keys, with Read and Write access."];
}

/** What Linear said of a key: whose it is, that it was refused, or that Linear could not be asked. */
type Verdict = Readonly<{ kind: "accepted"; name: string } | { kind: "rejected"; reason: string } | { kind: "unreachable"; reason: string }>;

/** How long Linear has to answer the check: a connection that hangs is Linear being out of reach, which the step says, and not a step that never ends. */
const CHECK_TIMEOUT_MS = 15_000;

/** Linear's answers that mean the key is not good: a refusal to authenticate, as opposed to Linear being down or out of reach. */
const REFUSED = new Set([400, 401, 403]);

/** Asks Linear whose key `key` is. Never throws, and never carries the key in what it says. */
async function verdictOn(key: string, deps: OnboardStepDeps): Promise<Verdict> {
  try {
    const withinTime: typeof fetch = (input, init) => deps.fetch(input, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return { kind: "accepted", name: (await linearSource({ key, fetch: withinTime }).me?.())?.name ?? "this key's owner" };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const reason = scrub(firstLine(error instanceof Error ? error.message : String(error), null), key);
    return typeof status === "number" && REFUSED.has(status) ? { kind: "rejected", reason } : { kind: "unreachable", reason };
  }
}

/** The step's answer for a key Linear did not refuse: whose it is as a ✓ line, or, when Linear could not be asked, that it was `held` but not checked, as a ✗ line with the command that checks it later. */
function connected(verdict: Exclude<Verdict, { kind: "rejected" }>, source: KeySource, held: "stored" | "found"): StepResult {
  const place = `the Linear key is readable from ${placeOf(source)}`;
  if (verdict.kind === "accepted") return { ok: true, detail: place, summary: `Linear key works: signed in as ${verdict.name}` };
  return { ok: false, detail: "Run `agent-org doctor` once you are online.", summary: `Linear key ${held} but not checked: ${verdict.reason}` };
}

/** The step's answer for the key already stored: {@link connected}, or the fix when Linear refuses it. */
function storedKey(verdict: Verdict, source: KeySource): StepResult {
  if (verdict.kind !== "rejected") return connected(verdict, source, "found");
  return { ok: false, detail: `Linear did not accept the key in ${placeOf(source)}: ${verdict.reason}. Replace it: ${storeCommand(source)}, then run \`agent-org doctor\`.` };
}

/** Puts `key` where `source` says. THROWS with the reason when it cannot. The Keychain gets it on `security -i`'s standard input, so the key is no argument of a process. */
function storeKey(source: KeySource, key: string, deps: OnboardStepDeps): void {
  if ("path" in source) return deps.writeFile(source.path, `${key}\n`);
  const account = /^[A-Za-z0-9._-]+$/.test(deps.env.USER ?? "") ? deps.env.USER : "agent-org";
  const stored = deps.exec("security", ["-i"], { input: `add-generic-password -U -a "${account}" -s "${source.keychain}" -w "${key}"\n` });
  if (stored.status !== 0) throw new Error(`the macOS Keychain did not take it: ${scrub(firstLine(stored.stderr || stored.stdout, stored.status), key)}`);
}

/** Asks for the key until Linear accepts one, the person gives none, or {@link ATTEMPTS} are used. @returns the key Linear did not refuse, with what it said, or null when none was given or all were refused */
async function askForKey(deps: OnboardStepDeps): Promise<Readonly<{ key: string; verdict: Exclude<Verdict, { kind: "rejected" }> }> | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const key = (await deps.askSecret("Paste your Linear API key (it is not shown): ")).trim();
    if (key === "") return null;
    if (!LOOKS_LIKE_A_KEY.test(key)) {
      deps.log("  ✗ That is not a Linear API key: it has only letters, digits and `_`. Copy it again from Linear.");
      continue;
    }
    const verdict = await verdictOn(key, deps);
    if (verdict.kind !== "rejected") return { key, verdict };
    deps.log(`  ✗ Linear did not accept that key: ${verdict.reason}`);
  }
  return null;
}

/** The step's answer when no key could be got: where it would go, and the command that puts one there. */
const notConnected = (source: KeySource): StepResult => ({ ok: false, detail: missingLine(source) });

/** Connect to Linear: tell the person where the key is kept and where to get one, ask for it, check it, store it, and read it back. */
async function connect(source: KeySource, deps: OnboardStepDeps): Promise<StepResult> {
  for (const line of introduction(source, deps)) deps.log(line);
  const given = await askForKey(deps);
  if (given === null) return notConnected(source);
  try {
    storeKey(source, given.key, deps);
  } catch (error) {
    return { ok: false, detail: `${(error as Error).message}. ${missingLine(source)}` };
  }
  return readable(source, deps) ? connected(given.verdict, source, "stored") : notConnected(source);
}

/** The step that connects to Linear: a key already readable is checked against Linear and not asked for again; otherwise a person at the terminal is asked for one. */
const keyStorage: OnboardStep = {
  name: "key storage",
  explain: "Connects to Linear: checks a readable key against Linear and says whose it is, or, with none readable and a person at the terminal, asks for one at a prompt that does not echo, checks it, stores it and reads it back. It says where the key is, never what it is.",
  async run(settings, deps): Promise<StepResult> {
    const source = keySource(settings.key);
    if (readable(source, deps)) return storedKey(await verdictOn(keyOf(source, deps).trim(), deps), source);
    return deps.interactive ? connect(source, deps) : notConnected(source);
  },
};

const WORKERS_CAN_READ = "Workers can read Linear";

/** The step that registers Linear's MCP for Claude Code at user scope, authenticated by the key, unless a `linear` MCP is there already. */
const mcpRegistration: OnboardStep = {
  name: "mcp registration",
  explain: "Registers Linear's MCP for Claude Code at user scope, authenticated by the key, so workers can read their tickets. A `linear` MCP that is there already is left as it is.",
  async run(settings, deps): Promise<StepResult> {
    const source = keySource(settings.key);
    if (!readable(source, deps)) return { ok: false, detail: "" };
    if (deps.exec("claude", ["mcp", "get", MCP_NAME]).status === 0) return { ok: true, detail: "Claude Code has a `linear` MCP already, so onboard left it as it is", summary: WORKERS_CAN_READ };
    const key = keyOf(source, deps).trim();
    const added = deps.exec("claude", ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, MCP_URL, "--header", `Authorization: Bearer ${key}`]);
    if (added.status === 0) return { ok: true, detail: `registered Linear's MCP for Claude Code (user scope), authenticated by the key in ${placeOf(source)}`, summary: WORKERS_CAN_READ };
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
