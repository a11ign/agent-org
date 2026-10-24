// @ts-check
// module: put the herdr this release pins in `~/.local/bin` when this machine has none (A11-223); herdr runs every worker's terminal
//
// THE PIN IS `TOOL_HERDR_VERSION`, and it is the version the agents host runs. Moving herdr is a change to it in an agent-org release, so every machine on that release gets the same herdr.
// `install.sh` holds the same value as `HERDR_VERSION`, and a test holds the two to one.
//
// NOT `curl https://herdr.dev/install.sh | sh`. That script installs the NEWEST herdr and has no version flag, which would make the version depend on the day a machine is set up. So onboard does the steps
// the script does, against the pinned entry: `https://herdr.dev/latest.json` carries a `releases` object keyed by version, with the same `assets` and `sha256` for each as the script reads for
// the newest. The download is checked against that SHA-256, and a binary that does not print the pinned version is never put in place. It never falls back to the newest version.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { herdrVersionOf } from "./herdr-upkeep.ts";
import type { Env } from "./paths.ts";

/**
 * The herdr version every machine on this release runs: what `herdr --version` prints on the agents host (read 2026-10-24).
 * When the agents host moves herdr, this moves in the same agent-org release, with `HERDR_VERSION` in `install.sh`.
 */
export const TOOL_HERDR_VERSION = "0.9.3";

export class HerdrInstallRefusal extends Error {}

export const HERDR_MANIFEST_URL = "https://herdr.dev/latest.json";
export const HERDR_INSTALL_PAGE = "https://herdr.dev/docs/install/";
const RELEASE_BASE = "https://github.com/herdrdev/herdr/releases/download";

/** The asset for this machine, named as herdr names them: `macos-aarch64`, `linux-x86_64`. REFUSES any other platform. */
export function herdrAsset(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (os === null || cpu === null) throw new HerdrInstallRefusal(`herdr publishes no build for ${platform} on ${arch}; see ${HERDR_INSTALL_PAGE}`);
  return `${os}-${cpu}`;
}

/** Where herdr's own installer puts it: `$HERDR_INSTALL_DIR`, else `~/.local/bin`. */
export const herdrInstallDir = (env: Env, home: string): string => (env.HERDR_INSTALL_DIR || join(home, ".local", "bin"));

const SAFE_WORD = /^[A-Za-z0-9_./~-]+$/;
const shellWord = (word: string): string => (SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The command a person runs by hand to put the pinned herdr in place: the pinned GitHub asset, downloaded to a side file and then moved, so it also replaces a herdr that is running
 * without "text file busy". On a platform with no asset it is herdr's install page.
 */
export function handInstallCommand(platform: NodeJS.Platform, arch: string, env: Env): string {
  let asset: string;
  try {
    asset = herdrAsset(platform, arch);
  } catch {
    return `see ${HERDR_INSTALL_PAGE}`;
  }
  const dir = env.HERDR_INSTALL_DIR ? shellWord(env.HERDR_INSTALL_DIR) : "~/.local/bin";
  const side = `${dir}/herdr.download`;
  return `mkdir -p ${dir} && curl -fsSL ${RELEASE_BASE}/v${TOOL_HERDR_VERSION}/herdr-${asset} -o ${side} && chmod +x ${side} && mv ${side} ${dir}/herdr`;
}

export type HerdrInstallDeps = Readonly<{
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  arch: string;
  /** The body at `url`, following redirects; THROWS with the reason when it cannot be read. */
  download: (url: string) => Promise<Buffer>;
  /** Write an executable file, mode 755, making its directory. */
  writeExecutable: (path: string, data: Buffer) => void;
  /** Move `from` over `to`. */
  place: (from: string, to: string) => void;
  remove: (path: string) => void;
  /** What `<path> --version` prints, or null when the program cannot run. */
  versionOf: (path: string) => string | null;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringAt = (from: unknown, key: string): string | null => (isObject(from) && typeof from[key] === "string" ? from[key] : null);

/** The pinned release's asset URL and SHA-256 for `asset`, from herdr's manifest. REFUSES a manifest with no entry for the pin: the top-level entry is the newest version, never used. */
function pinnedEntry(manifestText: string, asset: string): { url: string; sha256: string } {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new HerdrInstallRefusal(`${HERDR_MANIFEST_URL} is not JSON`);
  }
  const release = isObject(manifest) && isObject(manifest.releases) ? manifest.releases[TOOL_HERDR_VERSION] : undefined;
  if (!isObject(release)) throw new HerdrInstallRefusal(`${HERDR_MANIFEST_URL} lists no herdr ${TOOL_HERDR_VERSION}`);
  const url = stringAt(release.assets, asset);
  const sha256 = stringAt(release.sha256, asset);
  if (url === null || sha256 === null) throw new HerdrInstallRefusal(`${HERDR_MANIFEST_URL} lists no ${asset} build of herdr ${TOOL_HERDR_VERSION}`);
  return { url, sha256 };
}

/**
 * Put the pinned herdr in herdr's install dir. @returns where it is, and the version it prints
 * @throws HerdrInstallRefusal with the reason: an unsupported platform, no entry for the pin, an unreachable manifest or download, a checksum that does not match, or a binary that prints another version
 */
export async function installHerdr(deps: HerdrInstallDeps): Promise<{ path: string; version: string }> {
  const asset = herdrAsset(deps.platform, deps.arch);
  const reaching = async (url: string): Promise<Buffer> => {
    try {
      return await deps.download(url);
    } catch (err) {
      throw new HerdrInstallRefusal(`${url} could not be read: ${(err as Error).message.split("\n")[0]}`);
    }
  };
  const { url, sha256 } = pinnedEntry((await reaching(HERDR_MANIFEST_URL)).toString("utf8"), asset);
  const binary = await reaching(url);
  if (createHash("sha256").update(binary).digest("hex") !== sha256.toLowerCase()) throw new HerdrInstallRefusal(`the download from ${url} does not match its published checksum`);
  const path = join(herdrInstallDir(deps.env, deps.home), "herdr");
  const side = `${path}.download`;
  deps.writeExecutable(side, binary);
  const printed = deps.versionOf(side);
  if (printed === null || herdrVersionOf(printed) !== TOOL_HERDR_VERSION) {
    deps.remove(side);
    throw new HerdrInstallRefusal(`the download prints ${printed === null ? "nothing, so it cannot run here" : `"${printed.trim()}"`}, not herdr ${TOOL_HERDR_VERSION}`);
  }
  deps.place(side, path);
  return { path, version: TOOL_HERDR_VERSION };
}
