// a11ign/a11ign#5197: THE LAST MILE OF THE EVENT FEED -- the two host steps no unit can take, and the reading that says whether the feed is live.
//
//   node src/event-tunnel.ts up           serve the receiver's loopback port at `events.publicUrl`'s path, open to the internet, through the exposure plugin (the unit's ExecStart)
//   node src/event-tunnel.ts down         take that one path off the internet (the unit's ExecStop)
//   node src/event-tunnel.ts register     create the webhook secret file if absent, then set the scheduler App's webhook URL and secret
//   node src/event-tunnel.ts deliveries   print the App's recent deliveries (id, event, action, status), never a payload or a secret
//
// THE UNIT is `host/event-tunnel.service.in` (owned by `host-units.ts`, shipped for `events.tunnel: "tailscale-funnel"`) and runs `up` and `down`; the receiver is `event-receiver.ts`.
// `up` and `down` touch ONE path on port 443 and never `reset` or an unscoped `off`: the node's other serve mounts (the trace pages, tailnet-only on 8443) are not this file's.
//
// THE EXPOSURE PLUGIN DOES THE SERVING (A11-162): this file runs no `tailscale`. It asks the exposure the host file enables to serve the path open to the internet (contract 1.1), and a
// host on `local` refuses by name: "the events tunnel needs an exposure that serves to the internet".
//
// BOTH READ FIRST (what the exposure holds at the path, which needs no root) and change nothing when the path is already in the state asked for, and both READ AFTER and fail when it is not.
// Why: tailscaled refuses a non-root change to the serve config whenever the config being sent holds a FILE-PATH handler anywhere in it, new or not (`ipn/localapi/serve.go`,
// `HasPathHandler`), and the node's trace pages are exactly one. A mount applied once by root therefore stays, and a oneshot that re-ran `tailscale funnel` at every login would fail
// against a path that is already correctly served. The read-after is the other half: a `down` that was refused must not leave the unit `inactive` over a path that is still public.
//
// THE SECRET is generated once into the file the receiver reads (`events.receiver.secretPath`, mode 600 in a 700 directory) and is NEVER REPLACED by this file: a second `register` that
// rotated it would break every delivery until the App's copy caught up, and the file is the one place both halves read it from. It appears in no output, argument or error here.
//
// REGISTRATION IS `PATCH /app/hook/config` BY THE APP'S OWN JWT (not an installation token): GitHub accepts `url`, `content_type`, `secret` and `insecure_ssl` there and has NO field for
// `active` or for the subscribed events. Those two are the chairman's clicks in the App's settings (the row's step 4c), and this file says so rather than pretending to set them.
//
// A DELIVERY READ answers "is the feed live" from GitHub's side (`GET /app/hook/deliveries`): a `ping` is answered 200 by the receiver and, by design, never queued, so its proof is its
// status here and the receiver's heartbeat, while a `pull_request` is proven by its `deliveryId` in the queue.
import { createSign, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Exposure } from "./plugins/contracts/exposure.ts";
import { hostExposure } from "./plugins/host-exposure.ts";

/** GitHub's API. */
const GITHUB_API = "https://api.github.com";
/** GitHub refuses a JWT living past ten minutes; `iat` is set a minute back for the clock skew it also refuses. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;
const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/**
 * The App's RS256 JWT, which authenticates it (not an installation) for the calls below. THE GITHUB PLUGIN'S MINTER SIGNS THE SAME JWT (`plugins/github/app-token.ts`), which is a program that imports nothing
 * of core, and core imports no plugin's code, so the signer is written twice until this file's GitHub calls move into the plugin with the event feed (A11-160, step 8): `app-token.test.ts` holds the two to one token.
 */
export function appJwt({ appId, privateKey, now }: { appId: string, privateKey: string, now: number }): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

const SECRET_BYTES = 32;
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;
const REQUEST_TIMEOUT_MS = 15_000;
const DELIVERIES_PER_PAGE = 30;
const HTTP_OK = 200;
/** What the App must subscribe to (the row's step 4c): the receiver stores the first eight; `status` and `push` are accepted and ignored (202), so the gate does not read them yet. */
export const SUBSCRIBED_EVENTS = Object.freeze(["Pull request", "Pull request review", "Check run", "Check suite", "Workflow run", "Status", "Issues", "Issue comment", "Merge group", "Push"]);

export type Reply = { status: number, text: () => Promise<string> };
export type Fetch = (url: string, init: { method: string, headers: Record<string, string>, body?: string }) => Promise<Reply>;
export type App = { appId: string, keyPath: string };
export type Delivery = { id: number, guid: string, event: string, action: string | null, status: string, statusCode: number, deliveredAt: string, redelivery: boolean };

/** A failure that names the call and its status, never a body that could echo a secret. */
export class EventTunnelFailure extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`event-tunnel: ${why}`, options);
    this.name = "EventTunnelFailure";
  }
}

/** The secret file's state after the call: `created` this time, or `kept` because one was already there (and is never read, rewritten or measured). */
export function ensureSecretFile(path: string, { random = () => randomBytes(SECRET_BYTES).toString("hex") }: { random?: () => string } = {}): "created" | "kept" {
  if (existsSync(path)) return "kept";
  mkdirSync(dirname(path), { recursive: true, mode: SECRET_DIR_MODE });
  const scratch = `${path}.${process.pid}.${randomUUID()}`;
  writeFileSync(scratch, `${random()}\n`, { mode: SECRET_FILE_MODE });
  renameSync(scratch, path);
  return "created";
}

type Call = { fetch: Fetch, app: App, privateKey: string, now: number, apiBase?: string };

async function callApp({ fetch, app, privateKey, now, apiBase = GITHUB_API }: Call, request: { method: string, path: string, body?: unknown }): Promise<unknown> {
  const jwt = appJwt({ appId: app.appId, privateKey, now });
  const headers: Record<string, string> = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let reply: Reply;
  try {
    reply = await fetch(`${apiBase}${request.path}`, { method: request.method, headers, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
  } catch (cause) {
    throw new EventTunnelFailure(`${request.method} ${request.path} did not answer`, { cause });
  }
  const text = await reply.text();
  if (reply.status !== HTTP_OK) throw new EventTunnelFailure(`${request.method} ${request.path} answered ${reply.status}`);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new EventTunnelFailure(`${request.method} ${request.path} answered something that is not JSON`, { cause });
  }
}

/** Sets where GitHub posts and what it signs with. Returns the URL GitHub now holds, which is the one thing worth quoting back (the secret is write-only there too). */
export async function registerWebhook(call: Call, { publicUrl, secret }: { publicUrl: string, secret: string }): Promise<{ url: string }> {
  if (secret === "") throw new EventTunnelFailure("the secret is empty: refusing to set a webhook that signs with nothing");
  const config = await callApp(call, { method: "PATCH", path: "/app/hook/config", body: { url: publicUrl, content_type: "json", secret, insecure_ssl: "0" } }) as { url?: unknown };
  if (config.url !== publicUrl) throw new EventTunnelFailure(`GitHub answered with a webhook URL other than the one set`);
  return { url: publicUrl };
}

const textOrNull = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The newest deliveries GitHub recorded for the App's webhook: what the log says happened to each, with no payload. */
export async function recentDeliveries(call: Call, { count = DELIVERIES_PER_PAGE }: { count?: number } = {}): Promise<Delivery[]> {
  const list = await callApp(call, { method: "GET", path: `/app/hook/deliveries?per_page=${Math.min(Math.max(1, Math.trunc(count)), 100)}` });
  if (!Array.isArray(list)) throw new EventTunnelFailure("the delivery list is not a list");
  return list.map((entry: Record<string, unknown>) => ({
    id: Number(entry.id), guid: String(entry.guid), event: String(entry.event), action: textOrNull(entry.action), status: String(entry.status),
    statusCode: Number(entry.status_code), deliveredAt: String(entry.delivered_at), redelivery: entry.redelivery === true,
  }));
}

/** One delivery as a line a person can quote: the GUID is `X-GitHub-Delivery`, which is the `deliveryId` the receiver queues. */
export const deliveryLine = (delivery: Delivery) =>
  `${delivery.deliveredAt} ${delivery.guid} ${delivery.event}${delivery.action === null ? "" : `.${delivery.action}`} ${delivery.statusCode} ${delivery.status}${delivery.redelivery ? " (redelivery)" : ""}`;

/** The one HTTPS port Funnel serves, which the event feed's public address is on. */
const FUNNEL_PORT = 443;

type Mount = { publicUrl: string, port: number };

/** The path the receiver is served at: `events.publicUrl`'s. */
const pathOf = ({ publicUrl }: Mount): string => new URL(publicUrl).pathname;

/** Whether the exposure holds the receiver's loopback port at the funnel path AND has the port open to the internet (the exposure's internet is per port, not per path). */
export function pathIsServed(exposure: Pick<Exposure, "portState">, mount: Mount): boolean {
  const state = exposure.portState(FUNNEL_PORT, mount.port, { path: pathOf(mount) });
  return state.kind === "ours" && state.funnel;
}

/** What a refusal to serve the path means: an exposure that serves nothing cannot reach the internet, and any other has its own reason. */
function failureOf(exposure: Pick<Exposure, "ports">, command: "up" | "down", path: string, why: string): EventTunnelFailure {
  if (exposure.ports() === null) return new EventTunnelFailure(`the events tunnel needs an exposure that serves to the internet: ${why}`);
  return new EventTunnelFailure(`the exposure could not ${command === "up" ? "serve" : "remove"} ${path}: ${why}`);
}

/** Moves the path to the state `command` names, or says it is already there. Throws when the state afterwards is not the one asked for, so a refused change is never reported as done. */
export function changeFunnel(command: "up" | "down", mount: Mount, deps: { out: (line: string) => unknown, exposure: Pick<Exposure, "portState" | "serve" | "unserve" | "ports"> }): void {
  const { out, exposure } = deps;
  const wanted = command === "up";
  const path = pathOf(mount);
  if (pathIsServed(exposure, mount) === wanted) return void out(`${path} is already ${wanted ? "served" : "off"}${exposure.ports() === null && !wanted ? " as far as this exposure can tell (it serves on loopback only: a path an earlier exposure opened is that exposure's to remove)" : ""}: nothing to change`);
  out(`${wanted ? "serve" : "unserve"} ${path} on port ${FUNNEL_PORT}, open to the internet`);
  const result = wanted ? exposure.serve(FUNNEL_PORT, mount.port, { path, funnel: true }) : exposure.unserve(FUNNEL_PORT, { path, funnel: true, local: mount.port });
  if (result.status !== 0) throw failureOf(exposure, command, path, result.refusal ?? (result.stderr || `exit ${result.status}`));
  if (pathIsServed(exposure, mount) !== wanted) {
    throw new EventTunnelFailure(`the exposure returned and ${path} is still ${wanted ? "NOT served" : "served"}: what it holds at the path says so`);
  }
}

type Declared = { app: App, publicUrl: string, secretPath: string };

/** The scheduler App, the public URL and the secret path, from the host's declaration -- or a refusal naming the field that is missing. */
export function declaredTunnel(host: { github?: { identity?: Record<string, unknown> }, events?: { tunnel?: string, publicUrl?: string, receiver?: { secretPath: string, port: number } } }): Declared {
  const scheduler = host.github?.identity?.scheduler as { mode?: string, appId?: string, keyPath?: string } | undefined;
  if (scheduler?.mode !== "github-apps" || !scheduler.appId || !scheduler.keyPath) {
    throw new EventTunnelFailure("`github.identity.scheduler` is not a `github-apps` identity with an appId and keyPath: there is no App to register");
  }
  const { events } = host;
  if (events?.tunnel !== "tailscale-funnel" || events.publicUrl === undefined || events.receiver === undefined) {
    throw new EventTunnelFailure("`events.tunnel` is not `tailscale-funnel` with a `publicUrl` and a `receiver`: nothing is exposed to register");
  }
  return { app: { appId: scheduler.appId, keyPath: scheduler.keyPath }, publicUrl: events.publicUrl, secretPath: events.receiver.secretPath };
}

const realFetch: Fetch = (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** The two facts the funnel needs, or a refusal naming what is missing. Shares `declaredTunnel`'s reading of `events`. */
export function funnelFacts(host: Parameters<typeof declaredTunnel>[0]): { publicUrl: string, port: number } {
  const { events } = host;
  if (events?.tunnel !== "tailscale-funnel" || events.publicUrl === undefined || events.receiver === undefined) {
    throw new EventTunnelFailure("`events.tunnel` is not `tailscale-funnel` with a `publicUrl` and a `receiver`: nothing is exposed to serve");
  }
  return { publicUrl: events.publicUrl, port: events.receiver.port };
}

export async function main(argv: string[], deps: { out?: (line: string) => unknown, fetch?: Fetch, now?: () => number, exposure?: () => Promise<Exposure> } = {}): Promise<number> {
  const { out = (line: string) => process.stdout.write(`${line}\n`), fetch = realFetch, now = () => Math.floor(Date.now() / 1000), exposure = hostExposure } = deps;
  const [command] = argv;
  const isUnknownCommand = command !== "register" && command !== "deliveries" && command !== "up" && command !== "down";
  if (isUnknownCommand) {
    out("usage: node src/event-tunnel.ts <up|down|register|deliveries>");
    return 2;
  }
  try {
    const { homeHostConfig } = await import("./host-config.ts");
    const host = homeHostConfig() as Parameters<typeof declaredTunnel>[0];
    if (command === "up" || command === "down") {
      const mount = funnelFacts(host);
      changeFunnel(command, mount, { out, exposure: await exposure() });
      return 0;
    }
    const { app, publicUrl, secretPath } = declaredTunnel(host);
    const call: Call = { fetch, app, privateKey: readFileSync(app.keyPath, "utf8"), now: now() };
    if (command === "deliveries") {
      for (const delivery of await recentDeliveries(call)) out(deliveryLine(delivery));
      return 0;
    }
    out(`secret file ${secretPath}: ${ensureSecretFile(secretPath)}`);
    out(`webhook url set: ${(await registerWebhook(call, { publicUrl, secret: readFileSync(secretPath, "utf8").trim() })).url}`);
    out(`still the chairman's clicks (the API has no field for them): Webhook Active, and subscribe to ${SUBSCRIBED_EVENTS.join(", ")}`);
    return 0;
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
