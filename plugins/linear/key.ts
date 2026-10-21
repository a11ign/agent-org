// @ts-check
// module: where Linear's key is kept, its shape, and how it is read -- the Linear plugin's (A11-159)
//
// THE KEY NEVER LEAVES THE PLUGIN. It is read from the macOS Keychain or a file the tracker block names, and the plugin sends it only to Linear (`linear.ts`). The block's
// `key` setting reaches the plugin raw; its shape is judged here, when `create` is called at start and when doctor checks it, and a shape that is neither is refused by name.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Where the tracker's key is read from: the macOS Keychain by service name, or a mode-600 file. */
export type KeySource = Readonly<{ keychain: string } | { path: string }>;

/** The Keychain service the key is read from when the block names none. */
export const DEFAULT_KEYCHAIN_SERVICE = "agent-org-linear";

const KEY_SHAPE = "must be { \"keychain\": \"<service>\" } or { \"path\": \"/abs/file\" }";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value names a Keychain service and no file. */
const isKeychainKey = (value: unknown): value is { keychain: string } => isObject(value) && typeof value.keychain === "string" && value.keychain !== "" && value.path === undefined;

/** A key's source, from the block's `key` setting as the host file holds it. Absent is the Keychain's default service. REFUSES a shape that is neither a service nor an absolute path. */
export function keySource(value: unknown, field = "tickets.providers.tracker.key"): KeySource {
  if (value === undefined) return { keychain: DEFAULT_KEYCHAIN_SERVICE };
  if (isKeychainKey(value)) return { keychain: value.keychain };
  if (isObject(value) && value.keychain === undefined) {
    if (typeof value.path !== "string" || !isAbsolute(value.path)) throw new Error(`${field}.path must be an absolute path, such as "/home/me/.config/linear.key", not ${JSON.stringify(value.path)}`);
    return { path: value.path };
  }
  throw new Error(`${field} ${KEY_SHAPE}`);
}

/** Where a source lives, in words a row of doctor's reads: `Keychain service agent-org-linear`, or the file's path. */
export const describeSource = (source: KeySource): string => ("keychain" in source ? `Keychain service ${source.keychain}` : source.path);

/** Where a source lives, in words a sentence of onboard's reads: `the Keychain service agent-org-linear`, or `the file /k/linear.key`. */
export const placeOf = (source: KeySource): string => ("keychain" in source ? `the Keychain service ${source.keychain}` : `the file ${source.path}`);

/** The key, from where the host file says it lives. `security` prints the secret on stdout, which this returns and never logs. */
export function readLinearKey(source: KeySource, security: (args: string[]) => string = (args) => execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  let stored: string;
  try {
    stored = "keychain" in source ? security(["find-generic-password", "-s", source.keychain, "-w"]) : read(source.path);
  } catch {
    throw new Error("keychain" in source
      ? `ticket mode: no Linear key in the Keychain under ${source.keychain}. Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `ticket mode: the Linear key file ${source.path} cannot be read`);
  }
  const key = stored.trim();
  if (key === "") throw new Error(`ticket mode: the Linear key at ${"keychain" in source ? `Keychain service ${source.keychain}` : source.path} is empty`);
  return key;
}
