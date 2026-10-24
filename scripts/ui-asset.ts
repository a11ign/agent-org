// @ts-check
// script: the release's UI asset (A11-191) -- which tag a push released, and the tarball and checksum the board UI's build is shipped as
//
//   node scripts/ui-asset.ts released-tag <sha>           the release tag cut on top of <sha>, or nothing
//   node scripts/ui-asset.ts pack <dist> <tag> <out>      <out>/agent-org-ui-<tag>.tar.gz and <out>/agent-org-ui-<tag>.tar.gz.sha256
//
// `release.yml` and `ci.yml` both call `pack`, so the dry run on a pull request is the release's own step. `released-tag` is how the release job learns its tag: the shared per-merge workflow
// declares no output, so the tag is the `vX.Y.Z` one whose commit's FIRST PARENT is the merge that was pushed ("the release commit, on top of this merge", `release-per-merge.yml`).
//
// THE TARBALL IS THE SAME BYTES FOR THE SAME BUILD: the entries are sorted, owner 0, mtime 0, the modes do not depend on the umask, and the gzip header carries no time. Its root holds the build's own files (`index.html` beside
// `_astro/`), because `install.sh` and `agent-org update` unpack it into `versions/<tag>/ui-build/` as it is.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The tarball's name for `tag`: `install.sh`, `agent-org update` and the release workflow all write it this way. */
export const assetName = (tag: string): string => `agent-org-ui-${tag}.tar.gz`;

const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The release tags (`vX.Y.Z`) cut on top of `sha` in the repository at `cwd`: a tag whose commit has `sha` as its first parent. A tag on another parent, or on `sha` itself, is not one. */
export function releasedTags(sha: string, cwd: string = process.cwd()): string[] {
  const full = git(["rev-parse", "--verify", `${sha}^{commit}`], cwd).trim();
  const tagged = git(["rev-list", "--no-walk", "--parents", "--tags=v*"], cwd).split("\n").filter((line) => line !== "");
  const onTop = tagged.map((line) => line.split(" ")).filter(([, firstParent]) => firstParent === full).map(([commit]) => commit);
  return onTop.flatMap((commit) => git(["tag", "--points-at", commit], cwd).split("\n")).filter((tag) => RELEASE_TAG.test(tag)).toSorted();
}

/**
 * The tag a push of `sha` released, or null when it released nothing. More than one is refused: the Release these files go to would be a guess.
 * @throws when the push released more than one tag
 */
export function releasedTag(sha: string, cwd: string = process.cwd()): string | null {
  const tags = releasedTags(sha, cwd);
  if (tags.length > 1) throw new Error(`${sha} has more than one release tag on top of it (${tags.join(", ")}), so the Release the UI build belongs to is not known`);
  return tags[0] ?? null;
}

/** `sha256sum`'s format: the hex digest, two spaces, the file's name. */
export const checksumLine = (bytes: Uint8Array, name: string): string => `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;

/** The build at `dist` as a deterministic tar.gz: sorted entries, owner 0, mtime 0, modes 644 and 755 whatever the umask. GNU tar, which a CI runner has. */
function tarball(dist: string): Buffer {
  const tar = execFileSync("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", "--mode=u=rwX,go=rX", "-cf", "-", "-C", dist, "."], { maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return gzipSync(tar, { level: 9 });
}

/**
 * Write the tarball of the build at `dist` and its checksum into `out`. REFUSES a `dist` with no `index.html`, which is not a build of the board UI, and a `tag` that is not a release tag or `dry-run`.
 * @returns the two files' paths
 */
export function pack(dist: string, tag: string, out: string): { tarball: string; checksum: string } {
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} holds no index.html, so it is not a build of the board UI`);
  if (!RELEASE_TAG.test(tag) && tag !== "dry-run") throw new Error(`${tag} is not a release tag such as v0.3.0`);
  mkdirSync(out, { recursive: true });
  const name = assetName(tag);
  const file = join(out, name);
  writeFileSync(file, tarball(dist));
  writeFileSync(`${file}.sha256`, checksumLine(readFileSync(file), name));
  return { tarball: file, checksum: `${file}.sha256` };
}

function main(args: readonly string[]): void {
  const [command, ...rest] = args;
  if (command === "released-tag" && rest.length === 1) {
    const tag = releasedTag(rest[0]);
    if (tag !== null) console.log(tag);
  } else if (command === "pack" && rest.length === 3) {
    const files = pack(rest[0], rest[1], rest[2]);
    console.log(`${files.tarball}\n${files.checksum}`);
  } else {
    throw new Error("usage: ui-asset.ts released-tag <sha> | ui-asset.ts pack <dist> <tag> <out>");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`ui-asset: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
