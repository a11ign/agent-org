// no-token: none -- a static file server on 127.0.0.1 that stands in for github.com/<owner>/<repo>/releases/download; nothing reaches the network
// module: the stand-in for GitHub's release downloads (A11-191) -- `install.sh` and `agent-org update` fetch a release's UI build, and the tests point `AGENT_ORG_RELEASES_URL` here
//
// IT IS A CHILD PROCESS because `install-sh.test.ts` runs `install.sh` with `spawnSync`, which blocks the test's event loop: a server in that process would never answer. Run as a program it serves the
// directory it is given (`<root>/<tag>/<file>`), answers 404 for anything absent, and appends each request's path to a log file; the test reads that log to say what was and was not asked for.
//   node release-server.ts <root> <log>      prints `listening <port>` on its first line
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [root = "", log = ""] = process.argv.slice(2);
  const server = createServer((request, response) => {
    appendFileSync(log, `${request.url}\n`);
    const file = join(root, normalize(String(request.url)));
    if (!file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end("not found\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  server.listen(0, "127.0.0.1", () => console.log(`listening ${(server.address() as { port: number }).port}`));
}

/** A running stand-in: where it answers, what it was asked, and how to stop it. */
export type ReleaseServer = Readonly<{ url: string; root: string; requests: () => string[]; stop: () => void }>;

/** Every server a test started, stopped after the test: `afterEach` comes from `node:test` as an ESM import, as `tmp-fixture.ts` explains, so rstest hooks it. */
const started = new Set<ReleaseServer>();
afterEach(() => { for (const server of started) server.stop(); started.clear(); });

/** Serve `<root>/<tag>/<file>` on a free port. The log file is `<root>.requests`. It is stopped after the test that started it. */
export async function startReleaseServer(root: string): Promise<ReleaseServer> {
  mkdirSync(root, { recursive: true });
  const log = `${root}.requests`;
  writeFileSync(log, "");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, log], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (chunk: Buffer) => resolve(Number(/listening (\d+)/.exec(String(chunk))?.[1])));
  });
  const requests = (): string[] => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  const server: ReleaseServer = { url: `http://127.0.0.1:${port}`, root, requests, stop: () => { child.kill(); child.stdout.destroy(); } };
  started.add(server);
  return server;
}

/** Put a release's UI asset where the server serves it: `<root>/<tag>/agent-org-ui-<tag>.tar.gz` and its `.sha256`, packed from `dist` by the release's own `scripts/ui-asset.ts pack`. */
export function publishUiAsset(root: string, tag: string, dist: string): { tarball: string; checksum: string } {
  const out = join(root, tag);
  const script = fileURLToPath(new URL("../../../scripts/ui-asset.ts", import.meta.url));
  execFileSync(process.execPath, [script, "pack", dist, tag, out], { stdio: "pipe" });
  return { tarball: join(out, `agent-org-ui-${tag}.tar.gz`), checksum: join(out, `agent-org-ui-${tag}.tar.gz.sha256`) };
}
