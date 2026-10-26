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
// THE BUILD IS UNPACKED BESIDE ITS PLACE AND RENAMED INTO IT, so a folder only ever gains a whole `ui-build/`: the download is staged in `<folder>.ui.<id>.partial` (a name `pruneVersions` removes if a kill
// leaves it), and the tarball is unpacked into `<folder>/ui-build.<id>.partial` first. A11-190's `/` looks `ui-build/` up on every request, so a build completed in place is served with no restart.
//
// TWO FETCHES NEVER SHARE A PATH, AND A WHOLE BUILD IS NEVER DELETED FOR ONE THAT IS NOT READY (2026-10-26). Each fetch stages under its own `<id>`, so one fetch's cleanup cannot remove another's half-
// unpacked build; and a build that is already whole when a fetch comes to place its own is kept, so two fetches racing (the timer's update and the board's own) leave a build, not none. Before this, both
// used one fixed path, and the chairman's Mac was seen with a release made `current` (which checks for the build) and its `ui-build/` gone afterwards.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isReleaseTag } from "../lib/release-tag.ts";
import { UI_BUILD_DIR } from "../ticket-mode/ui-build.ts";
import type { Exec } from "./tool-install.ts";

/** The tarball a release carries for `tag`, and the name `scripts/ui-asset.ts` writes it under (a test holds the two together). */
export const uiAssetName = (tag: string): string => `agent-org-ui-${tag}.tar.gz`;

/** Longer than a slow link needs for a build of a few megabytes, and inside what an update run waits for. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Whether the `package.json` text `manifest` says `agentOrg.shipsUiBuild` is true. Text that is not a manifest declares nothing. */
export function declaresUiBuildIn(manifest: string): boolean {
  try {
    return (JSON.parse(manifest) as { agentOrg?: { shipsUiBuild?: unknown } }).agentOrg?.shipsUiBuild === true;
  } catch {
    return false;
  }
}

/** Whether the release unpacked in `folder` ships a UI build: its `package.json` says `agentOrg.shipsUiBuild` is true. */
export function declaresUiBuild(folder: string): boolean {
  try {
    return declaresUiBuildIn(readFileSync(join(folder, "package.json"), "utf8"));
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
  return `${url} could not be downloaded (${answer.status === null ? answer.why : `HTTP ${answer.status}`})`;
}

/** Whether a release has its UI build attached: it has (`attached`), CI has not got to it (`not-yet`, an HTTP 404), or the answer is not known (no releases address, no network, any other status). */
export type UiAttached = "attached" | "not-yet" | "unknown";

/**
 * Whether `tag`'s UI build is attached (A11-284). The probe is a GET of the `.sha256`, which `release.yml` uploads after the tarball, so a checksum that answers 200 has its tarball. It is fetched to
 * `/dev/null` through the same `curl` as the download; a HEAD is not used, because GitHub redirects an asset to a signed CDN address that does not answer one reliably. Only a 404 is `not-yet`:
 * a failure of any other kind is `unknown`, so a broken network is never taken for a release that does not exist yet.
 */
export function uiBuildAttached(source: UiSource, tag: string): UiAttached {
  const releases = source.releases();
  if (releases === null) return "unknown";
  const { status } = download(source, `${releases}/${tag}/${uiAssetName(tag)}.sha256`, "/dev/null");
  if (status === 200) return "attached";
  return status === 404 ? "not-yet" : "unknown";
}

/** The steps of fetching a build, which a failure names (A11-266): a person reads which one broke, and the error that broke it. */
type FetchStep = "stage" | "download" | "checksum" | "unpack" | "rename";

const failedAt = (step: FetchStep, error: string): UiStep => ({ state: "failed", reason: `UI build ${step} failed: ${error}` });

/** Download `tag`'s checksum and tarball into `staging`, and the reason when either is not there. */
function downloadAsset(source: UiSource, { releases, tag, staging }: { releases: string; tag: string; staging: string }): string | null {
  for (const file of [`${uiAssetName(tag)}.sha256`, uiAssetName(tag)]) {
    const url = `${releases}/${tag}/${file}`;
    const answer = download(source, url, join(staging, file));
    if (answer.status !== 200) return unavailable(tag, url, answer);
  }
  return null;
}

/** How many regular files `directory` holds, at any depth. */
const countFiles = (directory: string): number => readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;

/** Unpack `tarball` into `unpacked`, and the reason when it does not leave a build there: `tar` failing (bsdtar's words as it prints them) or no `index.html`. */
function unpack(source: UiSource, { tarball, unpacked }: { tarball: string; unpacked: string }): string | null {
  try {
    mkdirSync(unpacked, { recursive: true });
    // Only the short options bsdtar (macOS) and GNU tar share: a GNU-only long option fails on a Mac.
    source.exec("tar", ["-xzf", tarball, "-C", unpacked], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `tar could not unpack it (${lastLine(String((err as { stderr?: unknown }).stderr || (err as Error).message))})`;
  }
  return existsSync(join(unpacked, "index.html")) ? null : "the tarball holds no index.html, so it is not a build of the board UI";
}

/**
 * Rename `unpacked` into `folder/ui-build`, and the reason when the filesystem refuses. A whole build already there (another fetch placed it meanwhile) is kept and `unpacked` is left for the caller's
 * cleanup; a broken one is moved aside first and removed only once the new one is in place, so `folder` is never left without a build that it had.
 */
function place(folder: string, unpacked: string, id: string): string | null {
  const target = join(folder, UI_BUILD_DIR);
  if (hasUiBuild(folder)) return null;
  const aside = join(folder, `${UI_BUILD_DIR}.${id}.old`);
  try {
    if (existsSync(target)) renameSync(target, aside);
    renameSync(unpacked, target);
  } catch (err) {
    if (!existsSync(target) && existsSync(aside)) renameSync(aside, target);
    return `it could not be moved into ${target} (${lastLine(String((err as Error).message))})`;
  }
  rmSync(aside, { recursive: true, force: true });
  return null;
}

/**
 * Fetch `tag`'s UI build into `folder/ui-build/`: its checksum and tarball downloaded, the tarball verified against the checksum, unpacked beside its place and renamed into it. Anything else is a
 * failure that names its step and leaves `folder` as it was. `folder` is the version folder, or its `.partial` while it is still being built.
 */
function fetchUiBuild(source: UiSource, folder: string, tag: string): UiStep {
  const releases = source.releases();
  if (releases === null) return failedAt("download", `this install's repository is not a GitHub URL, so the build of ${tag} cannot be fetched: set AGENT_ORG_RELEASES_URL to where its releases are downloaded from`);
  // Each fetch has its own two places, so a fetch running beside it (the timer's update and the board's own) never clears or overwrites them.
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const staging = `${folder}.ui.${id}.partial`;
  const unpacked = join(folder, `${UI_BUILD_DIR}.${id}.partial`);
  // Best effort: a cleanup that fails must not hide the step that failed, and `pruneVersions` removes a `.partial` folder a kill leaves.
  const clear = (): void => {
    for (const leftover of [staging, unpacked]) {
      try {
        rmSync(leftover, { recursive: true, force: true });
      } catch {
        // left for the next fetch, and for `pruneVersions`, which removes `.partial` folders
      }
    }
  };
  try {
    clear();
    mkdirSync(staging, { recursive: true });
    const missing = downloadAsset(source, { releases, tag, staging });
    if (missing !== null) return failedAt("download", missing);
    const tarball = join(staging, uiAssetName(tag));
    if (!matches(tarball, `${tarball}.sha256`)) return failedAt("checksum", `${uiAssetName(tag)} did not match its checksum, so it was not installed`);
    const unusable = unpack(source, { tarball, unpacked });
    if (unusable !== null) return failedAt("unpack", unusable);
    const files = countFiles(unpacked);
    const unplaced = place(folder, unpacked, id);
    if (unplaced !== null) return failedAt("rename", unplaced);
    return { state: "ok", said: `✓ UI build for ${tag} installed (${files} files)` };
  } catch (err) {
    return failedAt("stage", lastLine(String((err as Error).message)));
  } finally {
    clear();
  }
}

/**
 * Give the version folder `folder`, named `name`, the UI build its release ships, when it should have one and does not. A folder of a release before the marker, or one that has its build, is left alone
 * with no network call. The main channel's folder has no Release to fetch from, so it says so and succeeds: `doctor` fails on it until a release is installed.
 */
export function ensureUiBuild({ folder, name, source }: { folder: string; name: string; source: UiSource }): UiStep {
  if (!declaresUiBuild(folder)) return { state: "ok" };
  // Said, not silent (2026-10-26): an update log with no UI line could not tell a build in place from a step that never ran.
  if (hasUiBuild(folder)) return { state: "ok", said: `the UI build of ${name} is in place` };
  if (!isReleaseTag(name)) return { state: "ok", said: `${name} is not a release, so it has no UI build to fetch; / shows the missing-build page until a release is installed` };
  return fetchUiBuild(source, folder, name);
}
