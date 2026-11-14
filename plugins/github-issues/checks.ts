// @ts-check
// module: the GitHub Issues plugin's doctor checks -- the settings are well formed and the token is readable, and a token file is readable by no one else (A11-447)
//
// The token is read to prove it is there, and never printed.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { describeSource, issuesSettings, readToken } from "./settings.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** The block names a repository and a prefix, the token is readable from where it says, and a token file is mode 600. */
export function tokenCheck(settings: PluginSettings, deps: PluginDeps): PluginCheck {
  const name = "tracker key";
  let read: ReturnType<typeof issuesSettings>;
  try {
    read = issuesSettings(settings);
  } catch (error) {
    return failed(name, (error as Error).message, "fix tickets.providers.tracker in host.json");
  }
  const where = describeSource(read.token);
  try {
    readToken(read.token, deps);
  } catch {
    return failed(name, `nothing readable at ${where}`, "keychain" in read.token
      ? `security add-generic-password -a "$USER" -s ${read.token.keychain} -w`
      : `write a GitHub token that can read and write the issues of ${read.owner}/${read.repo} to ${read.token.path} with mode 600`);
  }
  const mode = "path" in read.token ? deps.mode(read.token.path) : null;
  if (mode !== null && (mode & 0o077) !== 0) return failed(name, `${where} can be read by other users (mode ${(mode & 0o777).toString(8)})`, `chmod 600 ${where}`);
  return ok(name, `readable from ${where}, for the issues of ${read.owner}/${read.repo}`);
}
