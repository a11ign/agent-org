// module: the dev server's `/api/*`, passed on to this machine's instance, so a page can be built against live data
//
// THE KEY STAYS IN THIS PROCESS. The instance's port and key come from the checkout's own `ticket:remote-info`, which reads the host file (`$AGENT_ORG_HOST`,
// else the default) and the key file, and is how a remote board reaches an instance over ssh. The key is held in memory and sent as `x-ticket-token`: it is
// never written to a file, a URL, a log line or a response, and an error says what failed without printing what `remote-info` answered.
//
// THE REQUEST IS REBUILT, as `src/ticket-mode/remote-proxy.ts` does: the instance's own `Host` (its DNS-rebinding guard accepts that), the key, and the
// body with its type. The browser's cookies and every other header are not sent on.
import { spawn } from "node:child_process";
import { request, type IncomingMessage, type ServerResponse } from "node:http";

/** The instance a call is passed on to: the port it listens on, and the key it answers to. */
export type Instance = Readonly<{ port: number; key: string }>;

/** Runs `ticket:remote-info` and returns its stdout. REJECTS with its own message, which names the remedy, when there is no instance or no key. */
export type ReadRemoteInfo = () => Promise<string>;

const FORWARD_MS = 30_000;
const MS_PER_SECOND = 1000;
const BAD_GATEWAY = 502;
const UNAUTHORIZED = 401;
const LOCALHOST = "127.0.0.1";

/** The instance in `remote-info`'s stdout, `{ port, key, terminal }`. THROWS, without echoing the text (it holds the key), when it is not that. */
export function parseRemoteInfo(stdout: string): Instance {
  let info: unknown;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("ticket:remote-info answered with something that is not JSON");
  }
  const { port, key } = (typeof info === "object" && info !== null ? info : {}) as { port?: unknown; key?: unknown };
  if (!isPort(port) || !isKey(key)) throw new Error("ticket:remote-info did not answer with a port and a key");
  return { port, key };
}

const isPort = (port: unknown): port is number => typeof port === "number" && Number.isInteger(port) && port >= 1;
const isKey = (key: unknown): key is string => typeof key === "string" && key !== "";

/** The headers an instance is sent: its own host, its key, and the body's type and length. Nothing of the browser's. */
export function instanceHeaders(instance: Instance, incoming: IncomingMessage["headers"], body: Buffer): Record<string, string> {
  const contentType = incoming["content-type"];
  return {
    host: `${LOCALHOST}:${instance.port}`,
    "x-ticket-token": instance.key,
    accept: "application/json",
    ...(body.length === 0 || contentType === undefined ? {} : { "content-type": contentType, "content-length": String(body.length) }),
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

type Answer = Readonly<{ status: number; contentType: string; body: Buffer }>;

function send(instance: Instance, req: IncomingMessage, body: Buffer): Promise<Answer> {
  const options = { host: LOCALHOST, port: instance.port, method: req.method, path: req.url, headers: instanceHeaders(instance, req.headers, body), timeout: FORWARD_MS };
  return new Promise((done, fail) => {
    const outgoing = request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done({ status: response.statusCode ?? BAD_GATEWAY, contentType: response.headers["content-type"] ?? "application/json", body: Buffer.concat(chunks) }));
      response.on("error", fail);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer within ${FORWARD_MS / MS_PER_SECOND} seconds`)));
    outgoing.on("error", fail);
    outgoing.end(body);
  });
}

function answerJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Whether a request is one of the instance's: a path of `/api/`. */
export const isApiCall = (url: string | undefined): boolean => url?.startsWith("/api/") === true;

/** The dev server's way in: `handle` is the middleware, and `warm` reads the instance when the dev server starts. */
export type InstanceProxy = Readonly<{ handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void; warm: () => void }>;

/**
 * The middleware that passes `/api/*` on. The instance is read from `ticket:remote-info` when the dev server starts (`warm`), and again on a call when that
 * failed or when the instance refused the key, so starting the instance or its key later needs no restart. The dev server starts without an instance: a call
 * then answers 502 with `remote-info`'s own error.
 */
export function instanceProxy(readRemoteInfo: ReadRemoteInfo): InstanceProxy {
  let known: Promise<Instance> | null = null;
  const instance = (): Promise<Instance> => (known ??= readRemoteInfo().then(parseRemoteInfo));
  // Only the read a call used is forgotten: a call that fails late must not drop a newer read another call made since.
  const forget = (used: Promise<Instance>) => { if (known === used) known = null; };
  async function pass(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const used = instance();
    let target: Instance;
    try {
      target = await used;
    } catch (err) {
      forget(used);
      return answerJson(res, BAD_GATEWAY, { error: `cannot reach the instance: ${(err as Error).message}` });
    }
    try {
      const answer = await send(target, req, await readBody(req));
      if (answer.status === UNAUTHORIZED) {
        forget(used);
        return answerJson(res, BAD_GATEWAY, { error: "the instance refused the key, which is read again on the next call" });
      }
      res.writeHead(answer.status, { "content-type": answer.contentType });
      res.end(answer.body);
    } catch (err) {
      answerJson(res, BAD_GATEWAY, { error: `cannot reach the instance at ${LOCALHOST}:${target.port}: ${(err as Error).message}. Is agent-org ticket:serve running?` });
    }
  }
  return {
    handle: (req, res, next) => (isApiCall(req.url) ? void pass(req, res) : next()),
    warm: () => { const used = instance(); used.catch(() => forget(used)); },
  };
}

/** Runs `node <checkout>/src/ticket-mode/remote-info-command.ts`, with the environment as it is, so `$AGENT_ORG_HOST` reaches it. Its stderr is the rejection. */
export function runRemoteInfo(checkout: string, env: NodeJS.ProcessEnv = process.env): ReadRemoteInfo {
  return () => new Promise((done, fail) => {
    const child = spawn(process.execPath, [`${checkout}/src/ticket-mode/remote-info-command.ts`], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(stdout) : fail(new Error(stderr.trim() || `ticket:remote-info exited with ${code}`))));
  });
}
