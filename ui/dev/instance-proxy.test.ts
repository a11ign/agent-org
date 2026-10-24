import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceProxy, parseRemoteInfo, runRemoteInfo, type ReadRemoteInfo } from "./instance-proxy.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

/** A fake instance on a free port: it records what it was sent and answers `status` with `answer` as JSON. */
async function fakeInstance(status: number, answer: unknown): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

/** The dev server's middleware on a free port, as Vite mounts it: `/api/*` is passed on, anything else reaches `next`. */
async function devServer(readRemoteInfo: ReadRemoteInfo): Promise<{ server: Server; port: number; proxy: ReturnType<typeof instanceProxy> }> {
  const proxy = instanceProxy(readRemoteInfo);
  const server = createServer((req, res) => proxy.handle(req, res, () => { res.writeHead(200).end("next"); }));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port, proxy };
}

function call(port: number, method: string, path: string, { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      response.on("end", () => done({ status: response.statusCode ?? 0, text }));
    });
    outgoing.on("error", fail);
    outgoing.end(body);
  });
}

const open: Server[] = [];
const track = <T extends { server: Server }>(started: T): T => { open.push(started.server); return started; };
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); })));
});

const remoteInfoFor = (port: number): ReadRemoteInfo => async () => JSON.stringify({ port, key: KEY, terminal: "t" });

describe("the dev proxy's call to the instance", () => {
  it("sends the key and the instance's own host, and nothing of the browser's", async () => {
    const instance = track(await fakeInstance(200, { ok: true }));
    const dev = track(await devServer(remoteInfoFor(instance.port)));
    const answer = await call(dev.port, "GET", "/api/config?x=1", { headers: { cookie: "session=secret", authorization: "Bearer browser" } });
    expect(answer).toEqual({ status: 200, text: JSON.stringify({ ok: true }) });
    expect(instance.seen).toHaveLength(1);
    expect(instance.seen[0].url).toBe("/api/config?x=1");
    expect(instance.seen[0].headers["x-ticket-token"]).toBe(KEY);
    expect(instance.seen[0].headers.host).toBe(`127.0.0.1:${instance.port}`);
    expect(instance.seen[0].headers.cookie).toBeUndefined();
    expect(instance.seen[0].headers.authorization).toBeUndefined();
  });

  it("passes a POST body on with its type, and the instance's status back", async () => {
    const instance = track(await fakeInstance(409, { error: "no" }));
    const dev = track(await devServer(remoteInfoFor(instance.port)));
    const answer = await call(dev.port, "POST", "/api/queue", { headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(answer).toEqual({ status: 409, text: JSON.stringify({ error: "no" }) });
    expect(instance.seen[0].method).toBe("POST");
    expect(instance.seen[0].body).toBe('{"a":1}');
    expect(instance.seen[0].headers["content-type"]).toBe("application/json");
  });

  it("leaves a path outside /api to the dev server", async () => {
    const dev = track(await devServer(async () => { throw new Error("must not be read"); }));
    expect(await call(dev.port, "GET", "/next/")).toEqual({ status: 200, text: "next" });
    expect(await call(dev.port, "GET", "/apiary")).toEqual({ status: 200, text: "next" });
  });
});

describe("the dev proxy with no instance", () => {
  it("answers 502 with remote-info's own error, and reads again on the next call", async () => {
    const instance = track(await fakeInstance(200, { ok: true }));
    let reads = 0;
    const dev = track(await devServer(async () => {
      reads += 1;
      if (reads === 1) throw new Error("ticket:remote-info: /state/tickets/board.key does not exist: start the instance once with agent-org ticket:serve, which makes it");
      return JSON.stringify({ port: instance.port, key: KEY });
    }));
    const refused = await call(dev.port, "GET", "/api/config");
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.text).error).toBe("cannot reach the instance: ticket:remote-info: /state/tickets/board.key does not exist: start the instance once with agent-org ticket:serve, which makes it");
    expect((await call(dev.port, "GET", "/api/config")).status).toBe(200);
    expect(reads).toBe(2);
  });

  it("starts without an instance: warming a failing read throws nothing", async () => {
    const proxy = instanceProxy(async () => { throw new Error("no host file"); });
    expect(() => proxy.warm()).not.toThrow();
    await new Promise((done) => setTimeout(done, 10));
  });

  it("answers 502, naming the port, when the instance does not answer", async () => {
    const gone = await fakeInstance(200, {});
    const { port } = gone;
    gone.server.close();
    const dev = track(await devServer(remoteInfoFor(port)));
    const answer = await call(dev.port, "GET", "/api/config");
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.text).error).toContain(`cannot reach the instance at 127.0.0.1:${port}`);
    expect(answer.text).not.toContain(KEY);
  });

  it("answers 502 when the instance refuses the key, and reads the key again next time", async () => {
    const refusing = track(await fakeInstance(401, { error: "unauthorized" }));
    let reads = 0;
    const dev = track(await devServer(async () => { reads += 1; return JSON.stringify({ port: refusing.port, key: KEY }); }));
    const answer = await call(dev.port, "GET", "/api/config");
    expect(answer.status).toBe(502);
    expect(answer.text).not.toContain(KEY);
    await call(dev.port, "GET", "/api/config");
    expect(reads).toBe(2);
  });
});

describe("the instance read from remote-info", () => {
  it("is the port and the key", () => {
    expect(parseRemoteInfo(JSON.stringify({ port: 8123, key: KEY, terminal: "t" }))).toEqual({ port: 8123, key: KEY });
  });

  it.each([
    ["not JSON", `nope ${KEY}`],
    ["no port", JSON.stringify({ key: KEY })],
    ["a port that is not a number", JSON.stringify({ port: "8123", key: KEY })],
    ["no key", JSON.stringify({ port: 8123 })],
    ["an empty key", JSON.stringify({ port: 8123, key: "" })],
    ["null", "null"],
  ])("refuses %s without printing the text, which holds the key", (_name, stdout) => {
    let message = "";
    try { parseRemoteInfo(stdout); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/^ticket:remote-info /);
    expect(message).not.toContain(KEY);
  });
});

describe("running the checkout's ticket:remote-info", () => {
  let checkout = "";
  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), "ui-remote-info-"));
    mkdirSync(join(checkout, "src", "ticket-mode"), { recursive: true });
  });
  afterEach(() => rmSync(checkout, { recursive: true, force: true }));
  const script = (body: string) => writeFileSync(join(checkout, "src", "ticket-mode", "remote-info-command.ts"), body);

  it("returns its stdout, with the environment it was given", async () => {
    script('process.stdout.write(JSON.stringify({ port: 7, key: process.env.FAKE_KEY }));');
    const stdout = await runRemoteInfo(checkout, { ...process.env, FAKE_KEY: KEY })();
    expect(parseRemoteInfo(stdout)).toEqual({ port: 7, key: KEY });
  });

  it("rejects with its stderr when it exits non-zero", async () => {
    script('process.stderr.write("ticket:remote-info: no key\\n"); process.exit(1);');
    await expect(runRemoteInfo(checkout)()).rejects.toThrow("ticket:remote-info: no key");
  });
});
