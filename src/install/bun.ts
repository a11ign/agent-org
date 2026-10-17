// @ts-check
// module: put `bun` in `~/.bun/bin` when this machine has none, for the web terminal service (herdr web ui runs on bun)
//
// NO `unzip`, NO `sudo`, NO INSTALL SCRIPT. bun's own installer (`curl https://bun.sh/install | bash`) needs `unzip`, which a minimal Linux image
// lacks, and the agents host had none on 2026-10-17: bun was put there by hand, from the release zip, extracted with python. So onboard does the
// same in code: it downloads `bun-<os>-<arch>.zip` from bun's newest GitHub release and reads the one `bun` binary out of it with node's own
// `zlib`, which every machine that runs agent-org has. The zip is read by its central directory, and an entry whose CRC does not match is refused,
// so a truncated download never becomes a `bun` that crashes at its first start.
//
// It writes only `~/.bun/bin/bun`, the place bun's installer uses, so a later `bun upgrade` finds it where it expects.
import { crc32, inflateRawSync } from "node:zlib";
import { delimiter, join } from "node:path";
import type { Env } from "./paths.ts";

export class BunRefusal extends Error {}

/** The release asset for this machine, named as bun names them: `bun-darwin-aarch64`, `bun-linux-x64`. REFUSES any other platform. */
export function bunAsset(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x64" : null;
  if (os === null || cpu === null) throw new BunRefusal(`bun publishes no build for ${platform} on ${arch}: install bun yourself, then run onboard again`);
  return `bun-${os}-${cpu}`;
}

export const bunReleaseUrl = (asset: string) => `https://github.com/oven-sh/bun/releases/latest/download/${asset}.zip`;

/** Where onboard puts bun, and where the terminal service looks first. */
export const bunHomePath = (home: string) => join(home, ".bun", "bin", "bun");

/** The `bun` the terminal service runs: `~/.bun/bin/bun`, else the first on `path`, else null. */
export function findBun(home: string, path: string | undefined, exists: (path: string) => boolean): string | null {
  const candidates = [bunHomePath(home), ...(path ?? "").split(delimiter).filter((dir) => dir.startsWith("/")).map((dir) => join(dir, "bun"))];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** The end record is 22 bytes and may be followed by a comment of up to 65535. */
const EOCD_SEARCH = 22 + 0xffff;

/**
 * The bytes of the entry whose name is `name` or ends `/<name>`, from a zip held in memory. PURE. REFUSES a buffer that is not a zip, an absent
 * entry, a compression other than stored or deflate, and an entry whose CRC-32 does not match.
 */
export function zipEntry(zip: Buffer, name: string): Buffer {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - EOCD_SEARCH); at--) {
    if (zip.readUInt32LE(at) === EOCD) { end = at; break; }
  }
  if (end < 0) throw new BunRefusal("the download is not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new BunRefusal("the zip's directory is damaged");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (entry !== name && !entry.endsWith(`/${name}`)) continue;
    if (zip.readUInt32LE(local) !== LOCAL) throw new BunRefusal(`the zip's entry ${entry} is damaged`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method !== STORED && method !== DEFLATED) throw new BunRefusal(`the zip's entry ${entry} uses compression method ${method}`);
    const data = method === STORED ? Buffer.from(raw) : inflateRawSync(raw);
    if (crc32(data) !== crc) throw new BunRefusal(`the zip's entry ${entry} does not match its checksum: the download was cut short`);
    return data;
  }
  throw new BunRefusal(`the zip holds no ${name}`);
}

export type BunDeps = Readonly<{
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  arch: string;
  exists: (path: string) => boolean;
  /** The body at `url`, following redirects. */
  download: (url: string) => Promise<Buffer>;
  /** Write an executable file, mode 755. */
  writeExecutable: (path: string, data: Buffer) => void;
}>;

/** The `bun` this machine has, installing it into `~/.bun/bin` when it has none. @returns its path, and whether this call installed it */
export async function ensureBun(deps: BunDeps): Promise<{ path: string; installed: boolean }> {
  const found = findBun(deps.home, deps.env.PATH, deps.exists);
  if (found !== null) return { path: found, installed: false };
  const asset = bunAsset(deps.platform, deps.arch);
  const zip = await deps.download(bunReleaseUrl(asset));
  const path = bunHomePath(deps.home);
  deps.writeExecutable(path, zipEntry(zip, "bun"));
  return { path, installed: true };
}
