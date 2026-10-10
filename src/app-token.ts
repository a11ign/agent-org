// #4900: A GITHUB APP'S INSTALLATION TOKEN, MINTED, CACHED AND REFRESHED BEFORE IT EXPIRES.
//
// Every session of a role shared one personal account's 5,000 points an hour and its secondary limit, so the gate and six workers could
// starve each other (the tick ended 17 times in 30 minutes on `API rate limit already exceeded for user ID 328832207`). An installation token
// of a GitHub App is a separate principal with its own pool. `host/gh` asks this file for a role's token and puts it in `GH_TOKEN`; this file
// does the three things that need code: sign the app's JWT, trade it for an installation token, and keep the token where the next call finds it.
//
// WHICH ROLE USES WHICH APP is `host.json`'s `github.identity` (`host-config.ts`); `user-accounts` is the default and this file is not
// reached for it. THIS FILE NEVER FALLS BACK: it prints a token or it fails naming the stage, and the wrapper that called it is the one
// that goes back to today's account and records the incident, because only the wrapper knows which account that is.
//
// A token is a SECRET: it is written to stdout for the wrapper and to a mode-600 file in a mode-700 directory, and appears in no message
// this file builds. The same holds for the key: its PATH may be named in a failure, never its bytes.
//
// A LEAF, and `host-config.ts` imports it, never the reverse: `node:` modules only. The app's id and key path come from the wrapper's
// environment, rendered into it from `host.json` at install time, because importing `host-config.ts` resolves the project's checkout from
// the working directory at import, and a minter that refused from `/tmp` would fall back to the shared account for a reason that has
// nothing to do with the app.
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const GITHUB_API = "https://api.github.com";
/** A token with less than this left is replaced: an hour-long token that dies under a `git push` already running is the failure this margin is for. */
export const REFRESH_MARGIN_SECONDS = 300;
/** GitHub refuses a JWT living past ten minutes; `iat` is set a minute back for the clock skew it also refuses. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;
const HTTP_OK = 200;
const HTTP_CREATED = 201;

/** The three callers of `gh` that may each hold their own GitHub App: the gate and scripts, the engineer sessions, the decision-holders. */
export const GITHUB_ROLES = Object.freeze(["scheduler", "workers", "managers"] as const);
export type GithubRole = typeof GITHUB_ROLES[number];
/** What mints a token: the app, the file its private key is in (a path, never the key) and, when it has several, the installation to use. */
export type AppIdentity = { appId: string, keyPath: string, installationId?: string };
/** An installation token and when it dies, in epoch seconds. */
export type InstallationToken = { token: string, expiresAt: number };
export type Reply = { status: number, text: () => Promise<string> };
/** `fetch`, narrowed to what is used, so a test hands in a recorder and nothing reaches the network. */
export type Fetch = (url: string, init: { method: string, headers: Record<string, string> }) => Promise<Reply>;
export type MintStage = "key" | "installation" | "token";

/** A failure that names WHERE it stopped, so the incident a wrapper records says whether the key, the app or the installation is wrong. */
export class AppTokenFailure extends Error {
  stage: MintStage;
  constructor(stage: MintStage, why: string, options?: { cause?: unknown }) {
    super(`app token: ${stage}: ${why}`, options);
    this.name = "AppTokenFailure";
    this.stage = stage;
  }
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** The app's RS256 JWT, which authenticates it (not an installation) for the two calls that trade it for a token. */
export function appJwt({ appId, privateKey, now }: { appId: string, privateKey: string, now: number }): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The file's format, which `host/gh` reads in shell: `<expiry epoch seconds> <token>`. */
export const formatTokenFile = ({ token, expiresAt }: InstallationToken) => `${expiresAt} ${token}\n`;

/** A cached token, or `null` for a file that is not the format: a torn or foreign file is a miss, never a token. */
export function parseTokenFile(text: string): InstallationToken | null {
  const match = /^(\d{1,12}) (\S+)\n?$/.exec(text);
  return match === null ? null : { expiresAt: Number(match[1]), token: match[2] };
}

async function callGithub(fetch: Fetch, { url, method, jwt, expect, stage }: { url: string, method: string, jwt: string, expect: number, stage: MintStage }) {
  let reply: Reply;
  try {
    reply = await fetch(url, { method, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  } catch (cause) {
    throw new AppTokenFailure(stage, `${method} ${new URL(url).pathname} did not answer`, { cause });
  }
  const body = await reply.text();
  if (reply.status !== expect) {
    throw new AppTokenFailure(stage, `${method} ${new URL(url).pathname} answered ${reply.status}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new AppTokenFailure(stage, `${method} ${new URL(url).pathname} answered something that is not JSON`, { cause });
  }
}

/** The installation to mint for: the declared one, else the app's ONLY one. Two or none is refused, since a guess mints for the wrong organisation. */
async function installationFor(app: AppIdentity, { fetch, jwt, apiBase }: { fetch: Fetch, jwt: string, apiBase: string }): Promise<string> {
  if (app.installationId !== undefined) return app.installationId;
  const list = await callGithub(fetch, { url: `${apiBase}/app/installations?per_page=100`, method: "GET", jwt, expect: HTTP_OK, stage: "installation" });
  const ids = Array.isArray(list) ? list.map((entry) => (entry as { id?: unknown })?.id).filter((id) => typeof id === "number") : [];
  if (ids.length !== 1) {
    throw new AppTokenFailure("installation", `the app has ${ids.length} installations; declare \`installationId\` for the one to use`);
  }
  return String(ids[0]);
}

/** Trade the app's key for an installation token. NOT cached here: `appToken` is the one that keeps it. */
export async function mintInstallationToken({ app, privateKey, fetch, now, apiBase = GITHUB_API }: {
  app: AppIdentity, privateKey: string, fetch: Fetch, now: number, apiBase?: string,
}): Promise<InstallationToken> {
  let jwt: string;
  try {
    jwt = appJwt({ appId: app.appId, privateKey, now });
  } catch (cause) {
    throw new AppTokenFailure("key", `${app.keyPath} is not a private key that can sign`, { cause });
  }
  const installation = await installationFor(app, { fetch, jwt, apiBase });
  const url = `${apiBase}/app/installations/${installation}/access_tokens`;
  const granted = await callGithub(fetch, { url, method: "POST", jwt, expect: HTTP_CREATED, stage: "token" }) as { token?: unknown, expires_at?: unknown };
  const expiresAt = typeof granted.expires_at === "string" ? Math.floor(Date.parse(granted.expires_at) / 1000) : Number.NaN;
  if (typeof granted.token !== "string" || granted.token === "" || !Number.isFinite(expiresAt)) {
    throw new AppTokenFailure("token", "the reply carried no token and expiry");
  }
  return { token: granted.token, expiresAt };
}

/** Atomic (rename), so a call reading while another writes sees the old file or the new one and never half of either. */
function writeSecret(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: SECRET_DIR_MODE });
  const scratch = `${path}.${process.pid}`;
  writeFileSync(scratch, text, { mode: SECRET_FILE_MODE });
  renameSync(scratch, path);
}

/** `now` is in epoch SECONDS, the unit GitHub's `expires_at` and a JWT's `exp` use. */
export type AppTokenDeps = {
  now?: () => number, fetch?: Fetch, readKey?: (path: string) => string, apiBase?: string,
};

/** The cache path for a role: beside the other roles', one file each, so a role's refresh never races another's. */
export const tokenPath = (cacheDir: string, role: GithubRole) => join(cacheDir, `${role}.token`);

/**
 * The role's token: the cached one while it has more than `REFRESH_MARGIN_SECONDS` left, else a freshly minted one, which is cached. The
 * key is read only on a mint, so a cache hit touches nothing but the one file. `source` says which, for a caller that records it.
 */
export async function appToken({ role, app, cacheDir, deps = {} }: {
  role: GithubRole, app: AppIdentity, cacheDir: string, deps?: AppTokenDeps,
}): Promise<InstallationToken & { source: "cache" | "minted" }> {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  const path = tokenPath(cacheDir, role);
  const cached = readCached(path);
  if (cached !== null && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return { ...cached, source: "cache" };
  const readKey = deps.readKey ?? ((keyPath: string) => readFileSync(keyPath, "utf8"));
  let privateKey: string;
  try {
    privateKey = readKey(app.keyPath);
  } catch (cause) {
    throw new AppTokenFailure("key", `${app.keyPath} cannot be read`, { cause });
  }
  const fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  const minted = await mintInstallationToken({ app, privateKey, fetch, now, apiBase: deps.apiBase });
  writeSecret(path, formatTokenFile(minted));
  return { ...minted, source: "minted" };
}

function readCached(path: string): InstallationToken | null {
  try {
    return parseTokenFile(readFileSync(path, "utf8"));
  } catch {
    // an absent or unreadable file is a miss; the mint that follows is the thing that reports a real fault
    return null;
  }
}

/**
 * `node app-token.ts <role>`: print the role's token and exit 0, or say why not on stderr and exit 1. The wrapper runs it only for a role
 * `host.json` declares `github-apps`, handing the app in `A11Y_APP_ID`, `A11Y_APP_KEY_PATH` and `A11Y_APP_INSTALLATION_ID` (optional) and the
 * cache directory in `A11Y_APP_TOKEN_DIR`; any of the first two or the directory missing is exit 2, never a mint for something nobody configured.
 */
export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const role = argv[0] as GithubRole;
  if (!(GITHUB_ROLES as readonly string[]).includes(role)) {
    console.error(`app token: usage: app-token.ts <${GITHUB_ROLES.join("|")}>`);
    return 2;
  }
  const { A11Y_APP_ID: appId, A11Y_APP_KEY_PATH: keyPath, A11Y_APP_TOKEN_DIR: cacheDir, A11Y_APP_INSTALLATION_ID: installationId } = env;
  if (!appId || !keyPath || !cacheDir) {
    console.error("app token: A11Y_APP_ID, A11Y_APP_KEY_PATH and A11Y_APP_TOKEN_DIR must all be set; `host/gh` sets them from the host's declaration");
    return 2;
  }
  try {
    const app = { appId, keyPath, ...(installationId ? { installationId } : {}) };
    process.stdout.write((await appToken({ role, app, cacheDir })).token);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
