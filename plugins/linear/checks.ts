// @ts-check
// module: the Linear plugin's doctor checks -- the key is readable, Linear's MCP is connected for Claude Code (A11-159), and the board's calls to Linear mostly succeed (A11-359)
//
// Moved out of `install/doctor.ts` with the rows' names and words unchanged: `tracker key` and `linear mcp`. The key is read to prove it is there, and never printed.
// Linear's MCP is read from `claude mcp list`, which connects to each server, so "connected" is a real answer.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { join } from "node:path";
import { CALLS_FILE, describeCounts, isFlagged, readCounts } from "./call-log.ts";
import { describeSource, keySource, readLinearKey, type KeySource } from "./key.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** The key as the Keychain or the file gives it, through the deps' seams: `security` prints it on stdout, and a program that fails is a missing key. */
export function keyOf(source: KeySource, deps: Pick<PluginDeps, "exec" | "readFile">): string {
  const security = (args: string[]): string => {
    const result = deps.exec("security", args);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  return readLinearKey(source, security, deps.readFile);
}

/** The key is readable from where the block says, and a key file is readable by no one else. */
export function keyCheck(settings: PluginSettings, deps: PluginDeps): PluginCheck {
  let source: KeySource;
  try {
    source = keySource(settings.key);
  } catch (error) {
    return failed("tracker key", (error as Error).message, "fix tickets.providers.tracker.key");
  }
  const where = describeSource(source);
  try {
    keyOf(source, deps);
  } catch {
    return failed("tracker key", `nothing readable at ${where}`, "keychain" in source
      ? `security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `write your Linear personal API key to ${source.path} with mode 600, or run \`agent-org onboard\``);
  }
  const mode = "path" in source ? deps.mode(source.path) : null;
  if ("path" in source && mode !== null && (mode & 0o077) !== 0) {
    return failed("tracker key", `${source.path} can be read by other users (mode ${(mode & 0o777).toString(8)})`, `chmod 600 ${source.path}`);
  }
  return ok("tracker key", `readable from ${where}`);
}

/** `claude mcp list` connects to each server, so it is given a minute, as doctor always gave it. */
const MCP_LIST_MS = 60_000;

/** What `claude mcp list` printed, or null when it could not run. */
function mcpList(deps: Pick<PluginDeps, "exec">): string | null {
  const result = deps.exec("claude", ["mcp", "list"], { timeoutMs: MCP_LIST_MS });
  return result.status === 0 ? result.stdout : null;
}

/** Linear's MCP, which workers and planners read their tickets through, connected for Claude Code. */
export function mcpCheck(deps: PluginDeps): PluginCheck {
  const listed = mcpList(deps);
  const add = "run `agent-org onboard`, which registers it with the Linear key, or `claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header \"Authorization: Bearer <key>\"`";
  if (listed === null) return failed("linear mcp", "`claude mcp list` could not run", "install Claude Code and put `claude` on PATH, then run `agent-org onboard`");
  const line = listed.split("\n").find((entry) => entry.startsWith("linear:"));
  if (line === undefined) return failed("linear mcp", "Claude Code has no `linear` MCP, so workers cannot read their tickets", add);
  return /Connected/.test(line) ? ok("linear mcp", line.trim())
    : failed("linear mcp", line.trim(), "`claude mcp get linear` says why; a key that changed is fixed by `claude mcp remove linear --scope user`, then `agent-org onboard`");
}

/** Whether `err` is a file that is not there, as `readFileSync` and the deps' fakes say it. */
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ENOENT" || /ENOENT/.test(String((err as Error | null)?.message ?? ""));

/**
 * The board's calls to Linear over the last hour (A11-359): the count the board writes beside its state (`call-log.ts`), flagged when more than one call in a hundred failed. A board that has made no call in the hour, or has
 * never written the count, has nothing to flag. A count that is there and cannot be read, or is not a count, is not a healthy board: the row fails, so an unknown rate is never read as a good one.
 */
export function callsCheck(deps: Pick<PluginDeps, "readFile" | "stateDir">, now: number = Date.now()): PluginCheck {
  const name = "linear calls";
  let text: string;
  try {
    text = deps.readFile(join(deps.stateDir, CALLS_FILE));
  } catch (err) {
    if (isMissing(err)) return ok(name, "the board has recorded no call to Linear yet");
    return failed(name, `${CALLS_FILE} cannot be read (${(err as Error).message})`, `check the permissions of ${join(deps.stateDir, CALLS_FILE)}; the board writes it with its next call to Linear`);
  }
  const counts = readCounts(text);
  if (counts === null) return failed(name, `${CALLS_FILE} is not a count of calls, so the rate of failed calls is not known`, `remove ${join(deps.stateDir, CALLS_FILE)}; the board writes it again with its next call to Linear`);
  if (now - counts.at >= counts.windowMs) return ok(name, "the board has made no call to Linear in the last hour");
  const said = describeCounts(counts);
  return isFlagged(counts)
    ? failed(name, said, "the board's connections to Linear are failing: read its journal for the `Linear: a call failed` lines and their reasons (`ECONNRESET`, `UND_ERR_SOCKET`, a timeout)")
    : ok(name, said);
}
