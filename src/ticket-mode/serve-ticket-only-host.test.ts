// no-token: gh -- every child runs `ticket:serve` against a fake herdr on PATH and a key file; nothing reaches GitHub, Linear or the real herdr
/**
 * (agent-org#1723) A HOST FILE WITH ONLY `clones` AND `tickets` MUST START `ticket:serve`.
 *
 * The first tests run the real entry (`server.ts`) in a child process, so the module graph loads exactly as `agent-org ticket:serve` loads it.
 * Before the fix, `reviewer-port.ts` resolved the org's `primary` project at import, and a host without one crashed with a stack.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { HOST_FILE_ENV } from "./settings.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = realpathSync(join(HERE, "server.ts"));
const REVIEWER_PORT = realpathSync(join(HERE, "reviewer-port.ts"));
const PROJECT = join(HERE, "..", "packaging", "fixtures", "row-claim-file-overlap-rule", "project");
const STARTED = "ticket mode instance: 127.0.0.1:";
const WAIT_MS = 30_000;

/** A port nothing listens on now: listen on 0, read it, close. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A herdr that answers every call with an empty session, so nothing real is touched: the real one is at ~/.local/bin/herdr. */
function fakeHerdr(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "herdr"), "#!/bin/sh\necho '{\"result\":{\"workspaces\":[],\"agents\":[]}}'\n");
  chmodSync(join(bin, "herdr"), 0o755);
  return bin;
}

/** A host file in `root` holding `host` plus what `ticket:serve` must have: a key file, a state dir and free ports. */
async function hostFile(root: string, host: Record<string, unknown>, tickets: Record<string, unknown> = {}): Promise<string> {
  const keyPath = join(root, "linear.key");
  writeFileSync(keyPath, "lin_api_test\n");
  const path = join(root, "host.json");
  writeFileSync(path, JSON.stringify({
    ...host,
    clones: { demo: join(root, "demo") },
    stateDir: join(root, "state"),
    tickets: { port: await freePort(), uiPort: await freePort(), linearKey: { path: keyPath }, ...tickets },
  }));
  return path;
}

/** A host file with `primary` and a project, the positive control: the same entry must start on it too. */
function primaryHost(root: string): Record<string, unknown> {
  const checkout = join(root, "project");
  cpSync(PROJECT, checkout, { recursive: true });
  return { schema: 1, home: root, binDir: join(root, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout }], gh: { workers: join(root, "workers"), leads: join(root, "leads"), leadsHeader: [], leadsWorkspaces: [] } };
}

type Outcome = { code: number | null; stdout: string; stderr: string; started: boolean };

/** Runs `ticket:serve` as the CLI does and waits for it to start (then stops it) or to exit. `host` null leaves `AGENT_ORG_HOST` unset. Refuses after a timeout, so a hang fails the test. */
function runServe(host: string | null, root: string, home: string = process.env.HOME ?? root): Promise<Outcome> {
  const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: `${fakeHerdr(root)}:${process.env.PATH}` };
  if (host === null) delete childEnv[HOST_FILE_ENV];
  else childEnv[HOST_FILE_ENV] = host;
  const child: ChildProcess = spawn(process.execPath, [SERVER], { env: childEnv, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`ticket:serve neither started nor exited in ${WAIT_MS} ms: ${stderr}`)); }, WAIT_MS);
    const finish = (outcome: Outcome) => { clearTimeout(timer); done(outcome); };
    child.on("exit", (code) => finish({ code, stdout, stderr, started: stdout.includes(STARTED) }));
    const poll = setInterval(() => {
      if (!stdout.includes(STARTED)) return;
      clearInterval(poll);
      child.kill("SIGTERM");
    }, 50);
    child.on("exit", () => clearInterval(poll));
  });
}

/** A stack trace: a frame line `    at ...` in the output. */
const STACK = /\n\s+at /;

test("ticket:serve starts on a host file with only clones and tickets, and no tickets.reviewer", async () => {
  const root = tmpDir("serve-ticket-only-");
  const host = await hostFile(root, {});
  const outcome = await runServe(host, root);
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
  assert.doesNotMatch(outcome.stderr, /ProjectDeclarationRefusal/);
});

test("ticket:serve on the same entry with a host file that has primary also starts (the positive control)", async () => {
  const root = tmpDir("serve-with-primary-");
  const host = await hostFile(root, primaryHost(root));
  const outcome = await runServe(host, root);
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
});

test("ticket:serve with tickets.reviewer set on a host file with only clones and tickets either starts or exits 2 naming the missing field, never a stack from import", async () => {
  const root = tmpDir("serve-reviewer-no-primary-");
  const host = await hostFile(root, {}, { reviewer: "atomic", drafts: false });
  const outcome = await runServe(host, root);
  assert.doesNotMatch(outcome.stderr, STACK);
  if (outcome.code === 2) {
    assert.match(outcome.stderr, /primary/);
  } else {
    assert.equal(outcome.started, true, outcome.stderr);
    assert.match(outcome.stderr, /tickets\.reviewer is set, but no reviewer starts: .*primary/);
  }
});

test("importing reviewer-port.ts with no primary in the host file does not throw", async () => {
  const root = tmpDir("serve-import-no-primary-");
  const host = await hostFile(root, {}, { reviewer: "atomic", drafts: false });
  const code = `await import(${JSON.stringify(pathToFileURL(REVIEWER_PORT).href)}); process.stdout.write("imported\\n");`;
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, AGENT_ORG_HOST: host }, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (exitCode) => done({ code: exitCode, stdout, stderr }));
  });
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "imported\n");
  assert.doesNotMatch(outcome.stderr, /ProjectDeclarationRefusal/);
});

test("ticket:serve with AGENT_ORG_HOST unset reads ~/.agent-org/host.json and starts on it", async () => {
  const home = tmpDir("serve-home-");
  const root = tmpDir("serve-home-state-");
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  const host = await hostFile(root, {});
  writeFileSync(join(home, ".agent-org", "host.json"), readFileSync(host, "utf8"));
  const outcome = await runServe(null, root, home);
  assert.equal(outcome.started, true, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, STACK);
});
