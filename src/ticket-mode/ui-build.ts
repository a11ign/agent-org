// @ts-check
// module: where the built board UI (`ui/`, A11-188) is looked for, how a request under `/next` maps to a file in it, and the headers each file is sent with (A11-190)
//
// THE BUILD IS LOOKED FOR IN TWO PLACES, IN ORDER: `<TOOL_ROOT>/ui-build/`, beside the running version, where a release's build is unpacked (A11-191), then `<TOOL_ROOT>/ui/dist/`,
// the checkout's own output of `pnpm ui:build`, for dev. A folder counts only when it holds `index.html`. The lookup is cheap and the caller makes it on each request, so a build made
// while `ticket:ui` runs is served without a restart.
//
// A PATH THAT LEAVES THE BUILD IS NEVER SERVED. It is decoded and normalised, and a result outside the build's root, or whose real path (after symlinks) is, is "not found".
//
// A CLIENT-SIDE ROUTE IS ANSWERED WITH THE NEAREST PAGE ABOVE IT: Astro's static output writes each route as `<route>/index.html`, so `/settings/plugins/x` takes `settings/index.html` when
// that exists and the root page when not. A MISSING ASSET IS NEVER ANSWERED WITH A PAGE: a path with a file extension, or under `_astro/`, that is not there is "not found".
import { realpathSync, statSync } from "node:fs";
import { extname, join, posix, resolve, sep } from "node:path";
import { TOOL_ROOT } from "../install/paths.ts";

/** The folder beside the running version that a release's build is unpacked into. A11-191's install, auto-update and doctor import the name from here. */
export const UI_BUILD_DIR = "ui-build";

/** Where the build's own output lands in a checkout, relative to its root. */
const DEV_BUILD_DIR = join("ui", "dist");

/** The folder Astro writes content-hashed files into: the only files that never change under their name. */
const HASHED_DIR = "_astro";

/** The directories the build is looked for in, first to last. */
export function buildCandidates(root: string = TOOL_ROOT): readonly string[] {
  return [join(root, UI_BUILD_DIR), join(root, DEV_BUILD_DIR)];
}

/** The path of `file`'s real file, or null when it is not a file (or cannot be read: a missing file and a refused one are the same to a visitor). */
function realFile(file: string): string | null {
  try {
    return statSync(file).isFile() ? realpathSync(file) : null;
  } catch {
    return null;
  }
}

const within = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The first of `candidates` that holds `index.html`, or null: the build to serve. */
export function findBuild(candidates: readonly string[]): string | null {
  return candidates.find((dir) => realFile(join(dir, "index.html")) !== null) ?? null;
}

/** What a path under `/next` is answered with: the file to send, or nothing. `relative` is the file's path in the build, with `/`, which its headers are chosen by. */
export type Located = Readonly<{ file: string; relative: string }> | null;

/** `text` percent-decoded, or null when it is not valid or holds a NUL byte, which no file name does. */
function decoded(text: string): string | null {
  try {
    const value = decodeURIComponent(text);
    return value.includes("\0") ? null : value;
  } catch {
    return null;
  }
}

/** The page that answers a client-side route: the `index.html` of the nearest directory above `relative` that has one, up to the build's own. */
function nearestPage(root: string, relative: string): Located {
  for (let dir = posix.dirname(relative); ; dir = posix.dirname(dir)) {
    const file = realFile(join(root, dir, "index.html"));
    if (file !== null && within(root, file)) return { file, relative: posix.join(dir, "index.html") };
    if (dir === ".") return null;
  }
}

/** Whether a path in the build names an asset and not a route: it has a file extension, or is under `_astro/`. A missing asset is a 404, and an unpaired call for one is a 401. PURE. */
export function isAssetPath(path: string): boolean {
  return extname(path) !== "" || path.replace(/^\/+/, "").split("/")[0] === HASHED_DIR;
}

/**
 * The file in the build at `root` that answers `path`, the part of the request's path after `/next` (empty, or starting with `/`). In order: the exact file, the directory's
 * `index.html`, `<path>.html`, then, for a path that is not an asset, the nearest page above it. Null is a 404. PURE over the files it reads.
 */
export function locate(root: string, path: string): Located {
  const text = decoded(path);
  if (text === null) return null;
  const realRoot = realpathSync(root);
  const asked = text.replace(/^\/+/, "");
  const target = resolve(realRoot, asked);
  if (!within(realRoot, target)) return null;
  // The path as the build names it: normalised, with no trailing slash, `.` for the root.
  const inBuild = posix.normalize(asked === "" ? "." : asked).replace(/\/$/, "");
  const served = (file: string | null, relative: string): Located => (file !== null && within(realRoot, file) ? { file, relative } : null);
  const found = served(realFile(target), inBuild)
    ?? served(realFile(join(target, "index.html")), posix.join(inBuild, "index.html"))
    ?? (asked === "" ? null : served(realFile(`${target}.html`), `${inBuild}.html`));
  if (found !== null) return found;
  return isAssetPath(asked) ? null : nearestPage(realRoot, inBuild);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};

/** Whether a file of the build is a page. */
export const isPage = (relative: string): boolean => extname(relative) === ".html";

/**
 * The headers a file of the build is sent with. A page is `no-cache`: it names the hashed files a build holds, so a browser asks again each time. A hashed file under `_astro/` is
 * cached for a year and never revalidated, because its name changes when its content does. Any other file keeps its name across builds, so it is `no-cache` too. PURE.
 */
export function fileHeaders(relative: string): Record<string, string> {
  const hashed = relative.startsWith(`${HASHED_DIR}/`) && !isPage(relative);
  return {
    "Content-Type": CONTENT_TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Whether `path`, a request's pathname, is `/next` or under it. */
export const isNextPath = (path: string): boolean => path === "/next" || path.startsWith("/next/");

/** `path`'s part after `/next`: empty for `/next` itself. */
export const afterNext = (path: string): string => path.slice("/next".length);
