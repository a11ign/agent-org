// @ts-check
// module: the board UI's build, fetched from the release it belongs to (A11-191) -- the asset's address, its checksum, and the unpack into `versions/<tag>/ui-build/`
//
// CI BUILDS THE UI INTO EACH RELEASE (A11-187), so a machine never runs the UI's toolchain. `release.yml` attaches `agent-org-ui-<tag>.tar.gz` and its `.sha256` to the GitHub Release
// (`scripts/ui-asset.ts pack`), and `install.sh` (in bash, the same rules) and `agent-org update` (here) fetch them: `<releases>/<tag>/agent-org-ui-<tag>.tar.gz`. `<releases>` is
// `AGENT_ORG_RELEASES_URL` when set (the tests set it), else `https://github.com/<owner>/<repo>/releases/download` from the repository's GitHub URL.
//
// WHICH RELEASES HAVE ONE: exactly those whose `package.json` says `"agentOrg": { "shipsUiBuild": true }`. Every release before the marker installs as it always did, with no network call, and
// `doctor` reads the same marker to know whether a build is missing. The `main` channel has no Release, so it has no asset.
//
// THE BUILD IS UNPACKED BESIDE ITS PLACE AND RENAMED INTO IT, so a folder only ever gains a whole `ui-build/`: the download is staged in `<folder>.ui.partial` (a name `pruneVersions` removes if a kill leaves it), and
// the tarball is unpacked into `<folder>/ui-build.partial` first. A11-190's `/next` looks `ui-build/` up on every request, so a build completed in place is served with no restart.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isReleaseTag } from "../lib/release-tag.ts";
import { UI_BUILD_DIR } from "../ticket-mode/ui-build.ts";
import type { Exec } from "./tool-install.ts";

/** The tarball a release carries for `tag`, and the name `scripts/ui-asset.ts` writes it under (a test holds the two together). */
export const uiAssetName = (tag: string): string => `agent-org-ui-${tag}.tar.gz`;

/** Longer than a slow link needs for a build of a few megabytes, and inside what an update run waits for. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Whether the release unpacked in `folder` ships a UI build: its `package.json` says `agentOrg.shipsUiBuild` is true. */
export function declaresUiBuild(folder: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { agentOrg?: { shipsUiBuild?: unknown } };
    return manifest.agentOrg?.shipsUiBuild === true;
  } catch {
    return false;
  }
}

/** Whether `folder` holds its UI build: `ui-build/index.html`, the file A11-190 counts a build by. */
export const hasUiBuild = (folder: string): boolean => existsSync(join(folder, UI_BUILD_DIR, "index.html"));

/**
 * The address releases' downloads start at: `AGENT_ORG_RELEASES_URL` when it is set, else the one GitHub gives a repository (`https://github.com/<owner>/<repo>[.git]`, `git@github.com:<owner>/<repo>.git` or
 * `ssh://git@github.com/<owner>/<repo>.git`). Null for any other repository. `install.sh`'s `releases_url` is the same rule.
 */
export function releasesUrl(repoUrl: string | null, env: Readonly<Record<string, string | undefined>>): string | null {
  const override = env.AGENT_ORG_RELEASES_URL?.replace(/\/+$/, "") ?? "";
  if (override !== "") return override;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec((repoUrl ?? "").trim());
  return match === null ? null : `https://github.com/${match[1]}/releases/download`;
}

/** Where releases are fetched from, and how a program is run: `exec` runs `curl` and `tar`, and a test passes its own. */
export type UiSource = Readonly<{ releases: () => string | null; exec: Exec }>;

/** What fetching a build did: nothing to say, a line to say, or the reason the version must not become current. */
export type UiStep = Readonly<{ state: "ok"; said?: string }> | Readonly<{ state: "failed"; reason: string }>;

/** A download's answer: the HTTP status, or why there is none. */
type Answer = Readonly<{ status: number }> | Readonly<{ status: null; why: string }>;

const lastLine = (text: string): string => text.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "no output";

/** GET `url` into `file`, following redirects (GitHub serves an asset from a CDN), retrying what curl calls transient. */
function download(source: UiSource, url: string, file: string): Answer {
  try {
    const printed = source.exec("curl", ["-sSL", "--retry", "3", "-o", file, "-w", "%{http_code}", url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: DOWNLOAD_TIMEOUT_MS });
    return { status: Number(String(printed).trim()) };
  } catch (err) {
    const failure = err as { stderr?: unknown; message?: string };
    return { status: null, why: lastLine(String(failure.stderr || failure.message || err)) };
  }
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Whether the checksum file's first word is the tarball's SHA-256. A file that holds no digest is a mismatch. */
function matches(tarball: string, checksum: string): boolean {
  const want = readFileSync(checksum, "utf8").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(want) && want === sha256(tarball);
}

/** The reason a file is not there to download: nothing attached yet for a 404, else the status or curl's own words. */
function unavailable(tag: string, url: string, answer: Answer): string {
  if (answer.status === 404) return `${tag} has not attached its UI build yet (CI attaches it a few minutes after the release), so it is not installed; the next update tries again`;
  return `the UI build of ${tag} could not be downloaded from ${url} (${answer.status === null ? answer.why : `HTTP ${answer.status}`})`;
}

/** Download `tag`'s checksum and tarball into `staging`, and the reason when either is not there. */
function downloadAsset(source: UiSource, { releases, tag, staging }: { releases: string; tag: string; staging: string }): string | null {
  for (const file of [`${uiAssetName(tag)}.sha256`, uiAssetName(tag)]) {
    const url = `${releases}/${tag}/${file}`;
    const answer = download(source, url, join(staging, file));
    if (answer.status !== 200) return unavailable(tag, url, answer);
  }
  return null;
}

/**
 * Fetch `tag`'s UI build into `folder/ui-build/`: its checksum and tarball downloaded, the tarball verified against the checksum, unpacked beside its place and renamed into it. Anything else is a
 * failure that leaves `folder` as it was. `folder` is the version folder, or its `.partial` while it is still being built.
 */
function fetchUiBuild(source: UiSource, folder: string, tag: string): UiStep {
  const releases = source.releases();
  if (releases === null) return { state: "failed", reason: `the UI build of ${tag} cannot be fetched: this install's repository is not a GitHub URL, so set AGENT_ORG_RELEASES_URL to where its releases are downloaded from` };
  const staging = `${folder}.ui.partial`;
  const unpacked = join(folder, `${UI_BUILD_DIR}.partial`);
  const clear = (): void => { rmSync(staging, { recursive: true, force: true }); rmSync(unpacked, { recursive: true, force: true }); };
  try {
    clear();
    mkdirSync(staging, { recursive: true });
    const missing = downloadAsset(source, { releases, tag, staging });
    if (missing !== null) return { state: "failed", reason: missing };
    const tarball = join(staging, uiAssetName(tag));
    if (!matches(tarball, `${tarball}.sha256`)) return { state: "failed", reason: `the UI build of ${tag} did not match its checksum, so it was not installed` };
    mkdirSync(unpacked, { recursive: true });
    source.exec("tar", ["-xzf", tarball, "-C", unpacked], { stdio: ["ignore", "pipe", "pipe"] });
    if (!existsSync(join(unpacked, "index.html"))) return { state: "failed", reason: `the UI build of ${tag} holds no index.html, so it is not a build of the board UI` };
    rmSync(join(folder, UI_BUILD_DIR), { recursive: true, force: true });
    renameSync(unpacked, join(folder, UI_BUILD_DIR));
    return { state: "ok", said: `fetched the UI build of ${tag}` };
  } catch (err) {
    return { state: "failed", reason: `the UI build of ${tag} could not be unpacked (${lastLine(String((err as { stderr?: unknown }).stderr || (err as Error).message))})` };
  } finally {
    clear();
  }
}

/**
 * Give the version folder `folder`, named `name`, the UI build its release ships, when it should have one and does not. A folder of a release before the marker, or one that has its build, is left alone
 * with no network call. The main channel's folder has no Release to fetch from, so it says so and succeeds: `doctor` warns that it has no build.
 */
export function ensureUiBuild({ folder, name, source }: { folder: string; name: string; source: UiSource }): UiStep {
  if (!declaresUiBuild(folder) || hasUiBuild(folder)) return { state: "ok" };
  if (!isReleaseTag(name)) return { state: "ok", said: `${name} is not a release, so it has no UI build to fetch; /next shows the missing-build page until a release is installed` };
  return fetchUiBuild(source, folder, name);
}
