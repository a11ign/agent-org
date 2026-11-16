// @ts-check
// module: the GitHub Issues plugin's settings -- the repository its issues are in, the prefix of its keys, and where its token is read from (A11-447)
//
// THE TOKEN NEVER LEAVES THE PLUGIN. It is read from the macOS Keychain or a file the tracker block names, through the deps' seams, and sent only to api.github.com (`client.ts`).
// A setting of the wrong shape is refused by name when `create` is called at start and when doctor checks it.
import { isAbsolute } from "node:path";
import type { PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";

/** Where the token is read from: the macOS Keychain by service name, or a mode-600 file. */
export type TokenSource = Readonly<{ keychain: string } | { path: string }>;

/** The tracker block, read: the repository as `owner/name`, the key prefix, and where the token is. */
export type IssuesSettings = Readonly<{ owner: string; repo: string; prefix: string; token: TokenSource }>;

/** The Keychain service the token is read from when the block names none. */
export const DEFAULT_KEYCHAIN_SERVICE = "agent-org-github-issues";
/** The prefix of every key when the block names none: issue 12 is `GH-12`. */
export const DEFAULT_PREFIX = "GH";

const FIELD = "tickets.providers.tracker";
const REPOSITORY = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const PREFIX = /^[A-Za-z][A-Za-z0-9]*$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value names a Keychain service and no file. */
const isKeychainSource = (value: unknown): value is { keychain: string } => isObject(value) && typeof value.keychain === "string" && value.keychain !== "" && value.path === undefined;
/** Whether a value names an absolute file and no Keychain service. */
const isFileSource = (value: unknown): value is { path: string } => isObject(value) && value.keychain === undefined && typeof value.path === "string" && isAbsolute(value.path);

/** A token's source, from the block's `key` setting. Absent is the Keychain's default service. REFUSES a shape that is neither a service nor an absolute path. */
export function tokenSource(value: unknown): TokenSource {
  if (value === undefined) return { keychain: DEFAULT_KEYCHAIN_SERVICE };
  if (isKeychainSource(value)) return { keychain: value.keychain };
  if (isFileSource(value)) return { path: value.path };
  throw new Error(`${FIELD}.token must be { "keychain": "<service>" } or { "path": "/abs/file" }, not ${JSON.stringify(value)}`);
}

/** The block's settings, read. REFUSES, by name, a repository that is not `owner/name` and a prefix that is not letters and digits starting with a letter. */
export function issuesSettings(settings: PluginSettings): IssuesSettings {
  const repository = REPOSITORY.exec(typeof settings.repo === "string" ? settings.repo : "");
  if (repository === null) throw new Error(`${FIELD}.repo must name the repository the issues are in, as "owner/name", not ${JSON.stringify(settings.repo)}`);
  const prefix = settings.prefix ?? DEFAULT_PREFIX;
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) throw new Error(`${FIELD}.prefix must be letters and digits starting with a letter, such as "GH", not ${JSON.stringify(settings.prefix)}`);
  return { owner: repository[1], repo: repository[2], prefix: prefix.toUpperCase(), token: tokenSource(settings.token) };
}

/** Where a source lives, in words: `Keychain service agent-org-github-issues`, or the file's path. */
export const describeSource = (source: TokenSource): string => ("keychain" in source ? `Keychain service ${source.keychain}` : source.path);

/** The token, from where the block says it lives, through the deps' seams: `security` prints it on stdout, which this returns and never logs. REFUSES a token that cannot be read or is empty. */
export function readToken(source: TokenSource, deps: Pick<PluginDeps, "exec" | "readFile">): string {
  let stored: string;
  try {
    if ("path" in source) stored = deps.readFile(source.path);
    else {
      const result = deps.exec("security", ["find-generic-password", "-s", source.keychain, "-w"]);
      if (result.status !== 0) throw new Error(result.stderr);
      stored = result.stdout;
    }
  } catch {
    throw new Error("keychain" in source
      ? `ticket mode: no GitHub token in the Keychain under ${source.keychain}. Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `ticket mode: the GitHub token file ${source.path} cannot be read`);
  }
  const token = stored.trim();
  if (token === "") throw new Error(`ticket mode: the GitHub token at ${describeSource(source)} is empty`);
  return token;
}
