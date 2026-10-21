// no-token: none -- nothing here reaches `gh`, `tailscale`, `systemctl` or GitHub: the fetch is a recorder, the host is a fixture, and the key is generated for the run
// requires: history
// (the unit tests import `host-units.ts`, which reads git history to say where an orphaned unit came from)
//
// a11ign/a11ign#5197: THE LAST MILE OF THE EVENT FEED. Five things are pinned, each by running the code and not by reading it:
//   1. THE DECLARATION: `events.tunnel` and `events.publicUrl` read back, are refused BY FIELD NAME, and a host that names neither reads as it always did;
//   2. THE UNIT: it ships for `tailscale-funnel` only (with the receiver it exposes, even on a `poll` host), and renders the one funnel path and the loopback port; the funnel itself is the
//      EXPOSURE PLUGIN'S (A11-162): this file asks it for the one path, and a host on `local` is refused by name;
//   3. THE SECRET: created once at mode 600, never replaced, never in an output or a failure;
//   4. THE REGISTRATION and THE DELIVERY READ: exactly the call GitHub documents, by an App JWT, and a refusal that does not echo a secret;
//   5. THE LIVE HOST: when `AGENT_ORG_HOST` names the real declaration (the row's Acceptance does), that declaration is flagged and its unit renders.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Fetch } from "./event-tunnel.ts";

// THE LIVE DECLARATION'S PATH IS READ FIRST, because `host-units-project.ts` replaces `$AGENT_ORG_HOST` with its fixture's when it is imported; the tool is imported after it, and so are
// the modules that resolve their project from that variable, which is why they are dynamic imports and not static ones.
const LIVE = process.env.AGENT_ORG_HOST;
const { PROJECT_ROOT } = await import("./packaging/host-units-project.ts");
const { HOST_OPTIONAL_UNITS, SHIPPED_DIR, TOOL_ENTRIES, shippedUnitText, shippedUnits } = await import("./host-units/shipped-unit-texts-and-declarations.ts");
const { LONG_RUNNING_TEMPLATES } = await import("./host-config.ts");
const { hostUnitsInstall, unclassifiedEntries } = await import("./host-units.ts");
const { HostConfigRefusal, parseHostConfig, renderTemplate, templateValues } = await import("./host-config.ts");
const { tmpDir } = await import("./lib/tmp-fixture.ts");
const { EventTunnelFailure, SUBSCRIBED_EVENTS, changeFunnel, declaredTunnel, deliveryLine, ensureSecretFile, main, pathIsServed, recentDeliveries, registerWebhook } = await import("./event-tunnel.ts");
const { createFakeExposure } = await import("./plugins/fakes/exposure.ts");

const TEMPLATE = "event-tunnel.service.in";
const UNIT = "a11ign-event-tunnel.service";
const RECEIVER_UNIT = "a11ign-event-receiver.service";
const UNITS = { prefix: "a11ign-", boardReportWorkflow: "board-report.yml", own: [] as string[] };
const PUBLIC_URL = "https://agents.example.ts.net/webhook";
const SECRET_PATH = "/home/h/.config/agent-org/webhook-secret";
const RECEIVER = { port: 8787, secretPath: SECRET_PATH, tunnel: "tailscale" };
const FUNNEL = { source: "poll", tunnel: "tailscale-funnel", publicUrl: PUBLIC_URL, receiver: RECEIVER };

const fixtureHostJson = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
/** The fixture project's declaration with `events` replaced, so each host says only what the test says. */
const hostWith = (events?: unknown) => {
  const { events: _events, ...rest } = fixtureHostJson();
  return parseHostConfig(JSON.stringify(events === undefined ? rest : { ...rest, events }), "event-tunnel test host.json");
};
const refusalField = (events: unknown) => {
  try { hostWith(events); } catch (error) { return error instanceof HostConfigRefusal ? error.field : `not a refusal: ${error}`; }
  return "not refused";
};
const listed = (events?: unknown) => shippedUnits(SHIPPED_DIR, { projectUnitsDir: null, prefix: UNITS.prefix, declaredKeys: new Set(), host: hostWith(events) });
const unitText = (name: string, events?: unknown) => shippedUnitText(name, { host: hostWith(events), units: UNITS, projectUnitsDir: null }) ?? "";

test("#5197: `events.tunnel` and `events.publicUrl` read back whole, and a host that names neither reads exactly as it did", () => {
  assert.deepEqual(hostWith(FUNNEL).events, { source: "poll", receiver: RECEIVER, tunnel: "tailscale-funnel", publicUrl: PUBLIC_URL }, "POSITIVE CONTROL: the funnel declaration reads back as written");
  assert.deepEqual(hostWith({ source: "poll" }).events, { source: "poll" }, "no tunnel key, none set");
  assert.deepEqual(hostWith({ source: "poll", tunnel: "none" }).events, { source: "poll", tunnel: "none" });
  assert.deepEqual(hostWith({ source: "webhook", receiver: RECEIVER, tunnel: "tailscale-funnel", publicUrl: PUBLIC_URL }).events,
    { source: "webhook", receiver: RECEIVER, reconcileMinutes: 20, tunnel: "tailscale-funnel", publicUrl: PUBLIC_URL }, "the funnel rides on a webhook host too");
  assert.deepEqual(hostWith({ source: "poll", tunnel: "none", publicUrl: PUBLIC_URL }).events, { source: "poll", tunnel: "none", publicUrl: PUBLIC_URL },
    "the revert is the one word `none`: the URL left behind is read and unused, not refused");
});

test("#5197: each wrong tunnel field is refused BY NAME, and the same block with that field put right is read", () => {
  for (const tunnel of ["tailscale", "cloudflare", "Tailscale-Funnel", "", null, true]) {
    assert.equal(refusalField({ ...FUNNEL, tunnel }), "events.tunnel", `${JSON.stringify(tunnel)} is refused by name`);
  }
  const { publicUrl: _dropped, ...noUrl } = FUNNEL;
  assert.equal(refusalField(noUrl), "events.publicUrl", "a funnel with no URL names no path");
  assert.equal(refusalField({ ...FUNNEL, receiver: undefined }), "events.receiver", "a funnel with no receiver exposes nothing");
  assert.equal(refusalField({ ...FUNNEL, receiver: { ...RECEIVER, tunnel: "cloudflare" } }), "events.receiver.tunnel", "two declarations of one tunnel may not disagree");
  assert.equal(refusalField({ source: "poll", receiver: RECEIVER }), "events.receiver", "a receiver under `poll` with no funnel is still ignored, so still refused");
  assert.equal(refusalField(FUNNEL), "not refused", "NEGATIVE CONTROL: the whole declaration is read");
});

test("#5197: a `publicUrl` that is not exactly `https://<host>/<path>` is refused by `events.publicUrl`", () => {
  for (const publicUrl of ["http://agents.example.ts.net/webhook", "https://agents.example.ts.net:8443/webhook", "https://agents.example.ts.net/", "https://agents.example.ts.net",
    "https://agents.example.ts.net/webhook/", "https://agents.example.ts.net/webhook?x=1", "https://u:p@agents.example.ts.net/webhook", "https://agents.example.ts.net/a b", "agents.example.ts.net/webhook", 7]) {
    assert.equal(refusalField({ ...FUNNEL, publicUrl }), "events.publicUrl", `${JSON.stringify(publicUrl)} is refused by name`);
  }
  assert.equal(refusalField({ ...FUNNEL, publicUrl: "https://agents.example.ts.net/github/events" }), "not refused", "a nested path is read");
});

test("#5197: the funnel unit ships for `tailscale-funnel` and for nothing else, and brings the receiver it exposes even on a `poll` host", () => {
  const funnel = listed(FUNNEL);
  assert.ok(funnel.includes(UNIT), "POSITIVE CONTROL: a funnel host IS shipped the tunnel, so the absences below are the declaration's doing");
  assert.ok(funnel.includes(RECEIVER_UNIT), "the receiver is shipped with it, so the feed is live while the gate still polls");
  for (const [name, events] of [["no events block", undefined], ["poll", { source: "poll" }], ["tunnel none", { source: "poll", tunnel: "none", publicUrl: PUBLIC_URL }]] as const) {
    const without = listed(events);
    assert.equal(without.includes(UNIT), false, `NEGATIVE CONTROL: ${name} is not shipped the tunnel`);
    assert.equal(without.includes(RECEIVER_UNIT), false, `${name} runs no receiver`);
    assert.deepEqual(funnel.filter((unit) => unit !== UNIT && unit !== RECEIVER_UNIT), without, `${name}: the declaration adds the two services and changes nothing else`);
  }
  assert.ok(listed({ source: "webhook", receiver: RECEIVER }).includes(RECEIVER_UNIT), "a webhook host with no funnel still gets the receiver it always did");
  assert.equal(listed({ source: "webhook", receiver: RECEIVER }).includes(UNIT), false);
});

test("#5197: the template is classified, long-running, and keyed on the HOST declaration", () => {
  assert.ok(TOOL_ENTRIES.includes(TEMPLATE));
  assert.ok(LONG_RUNNING_TEMPLATES.includes(TEMPLATE), "no clock starts it: `enable --now` on the SERVICE is what serves the path");
  assert.ok(Object.hasOwn(HOST_OPTIONAL_UNITS, TEMPLATE));
  assert.ok(existsSync(join(SHIPPED_DIR, TEMPLATE)));
  assert.deepEqual(unclassifiedEntries({ shippedDir: SHIPPED_DIR, projectUnitsDir: null, units: UNITS, host: hostWith(FUNNEL) }), []);
});

test("#5197: the unit runs `up` and `down` of the tool's own file", () => {
  const text = unitText(UNIT, FUNNEL);
  assert.doesNotMatch(text, /@@/, "no placeholder is left");
  assert.match(text, /^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/event-tunnel\.ts up$/m);
  assert.match(text, /^ExecStop=-%h\/\.local\/bin\/node packages\/agent-org\/src\/event-tunnel\.ts down$/m, "stopping takes the path off, and an already-removed path is not a failure of the stop");
  assert.match(text, /^Type=oneshot$/m);
  assert.match(text, /^RemainAfterExit=yes$/m, "`is-active` answers 'is the path served'");
  assert.match(text, /^Wants=a11ign-event-receiver\.service$/m);
  assert.match(text, /^Environment=NODE_COMPILE_CACHE=%h\/\.cache\/node-compile-cache$/m);
  assert.match(text, /^Environment=GH_CONFIG_DIR=.+\/gh$/m);
  assert.match(unitText(RECEIVER_UNIT, FUNNEL), /^ExecStart=.*event-receiver\.ts --port 8787 --secret-file \/home\/h\/\.config\/agent-org\/webhook-secret --queue /m, "and the receiver renders for a poll host that opens the funnel");
});

test("#5197: a host that opens no funnel has the unit left out, and the unit renders from a plain template of the funnel host's values", () => {
  assert.equal(Object.hasOwn(templateValues(hostWith({ source: "poll" }), UNITS), "eventsPort"), false, "NEGATIVE CONTROL: no receiver values for a poll host with no receiver");
  assert.equal(templateValues(hostWith(FUNNEL), UNITS).eventsPort, "8787", "POSITIVE CONTROL: a funnel host's values carry the receiver's port, which `up` reads from the declaration too");
  const template = readFileSync(join(SHIPPED_DIR, TEMPLATE), "utf8");
  assert.doesNotThrow(() => renderTemplate(template, templateValues(hostWith(FUNNEL), UNITS), TEMPLATE));
});

test("#5197: the secret file is created once at mode 600 in a 700 directory, and a second call neither reads nor changes it", () => {
  const dir = join(tmpDir("event-tunnel-secret-"), "agent-org");
  const path = join(dir, "webhook-secret");
  assert.equal(ensureSecretFile(path, { random: () => "first-secret-value" }), "created");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(readFileSync(path, "utf8"), "first-secret-value\n");
  assert.equal(ensureSecretFile(path, { random: () => "second-secret-value" }), "kept", "never rotated: the App holds the old one");
  assert.equal(readFileSync(path, "utf8"), "first-secret-value\n");
  const real = join(dir, "generated");
  ensureSecretFile(real);
  assert.match(readFileSync(real, "utf8"), /^[0-9a-f]{64}\n$/, "the default is 32 random bytes in hex");
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const APP = { appId: "5267089", keyPath: "/keys/scheduler.pem" };
const NOW = 1_800_000_000;
type Seen = { url: string, method: string, headers: Record<string, string>, body?: string };
const recorder = (replies: Array<{ status: number, body: unknown }>) => {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, ...init });
    const reply = replies[Math.min(seen.length, replies.length) - 1];
    return { status: reply.status, text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)) };
  };
  return { seen, call: { fetch, app: APP, privateKey, now: NOW } };
};

test("#5197: registration is one PATCH of /app/hook/config by the App's own JWT, with the secret in the body and nowhere else", async () => {
  const SECRET = "s3cr3t-value-that-must-not-leak";
  const { seen, call } = recorder([{ status: 200, body: { url: PUBLIC_URL, content_type: "json", insecure_ssl: "0" } }]);
  const result = await registerWebhook(call, { publicUrl: PUBLIC_URL, secret: SECRET });
  assert.deepEqual(result, { url: PUBLIC_URL });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "PATCH");
  assert.equal(seen[0].url, "https://api.github.com/app/hook/config");
  assert.deepEqual(JSON.parse(seen[0].body ?? ""), { url: PUBLIC_URL, content_type: "json", secret: SECRET, insecure_ssl: "0" });
  const [header, claims] = (seen[0].headers.authorization ?? "").replace("Bearer ", "").split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(claims.iss, APP.appId, "authenticated AS the App, not as an installation");
  assert.ok(!JSON.stringify(seen[0].headers).includes(SECRET) && !seen[0].url.includes(SECRET), "the secret is in the body only");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("#5197: a refused or mismatched registration is a failure that names the status and never the secret", async () => {
  const SECRET = "s3cr3t-value-that-must-not-leak";
  const refused = recorder([{ status: 422, body: { message: `Validation failed for ${SECRET}` } }]);
  await assert.rejects(registerWebhook(refused.call, { publicUrl: PUBLIC_URL, secret: SECRET }), (error: unknown) =>
    error instanceof EventTunnelFailure && error.message.includes("422") && !error.message.includes(SECRET));
  const wrong = recorder([{ status: 200, body: { url: "https://elsewhere.example/hook" } }]);
  await assert.rejects(registerWebhook(wrong.call, { publicUrl: PUBLIC_URL, secret: SECRET }), (error: unknown) => error instanceof EventTunnelFailure && !error.message.includes(SECRET));
  const down: Fetch = async () => { throw new Error(`connect refused with ${SECRET}`); };
  await assert.rejects(registerWebhook({ ...refused.call, fetch: down }, { publicUrl: PUBLIC_URL, secret: SECRET }), (error: unknown) => error instanceof EventTunnelFailure && !error.message.includes(SECRET));
  await assert.rejects(registerWebhook(recorder([{ status: 200, body: "not json" }]).call, { publicUrl: PUBLIC_URL, secret: "" }), EventTunnelFailure, "an empty secret is refused before any call");
  assert.equal((await registerWebhook(recorder([{ status: 200, body: { url: PUBLIC_URL } }]).call, { publicUrl: PUBLIC_URL, secret: SECRET })).url, PUBLIC_URL, "NEGATIVE CONTROL: the same call, answered properly, succeeds");
});

test("#5197: the delivery read lists id, event, action and status from GitHub's log, a line quotes the delivery id, and the page size is bounded", async () => {
  const log = [
    { id: 11, guid: "aaaa-1111", event: "ping", action: null, status: "OK", status_code: 200, delivered_at: "2026-10-12T10:00:00Z", redelivery: false },
    { id: 12, guid: "bbbb-2222", event: "pull_request", action: "opened", status: "OK", status_code: 200, delivered_at: "2026-10-12T10:05:00Z", redelivery: true },
  ];
  const { seen, call } = recorder([{ status: 200, body: log }]);
  const deliveries = await recentDeliveries(call, { count: 500 });
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://api.github.com/app/hook/deliveries?per_page=100", "an oversized count is clamped to GitHub's page");
  assert.deepEqual(deliveries.map(deliveryLine), [
    "2026-10-12T10:00:00Z aaaa-1111 ping 200 OK",
    "2026-10-12T10:05:00Z bbbb-2222 pull_request.opened 200 OK (redelivery)",
  ]);
  await assert.rejects(recentDeliveries(recorder([{ status: 200, body: { not: "a list" } }]).call), EventTunnelFailure);
});

test("#5197: `declaredTunnel` reads the scheduler App, the URL and the secret path, and names what is missing", () => {
  const host = { github: { identity: { scheduler: { mode: "github-apps", appId: "5267089", keyPath: "/k.pem" } } }, events: { tunnel: "tailscale-funnel", publicUrl: PUBLIC_URL, receiver: { secretPath: SECRET_PATH, port: 8787 } } };
  assert.deepEqual(declaredTunnel(host), { app: { appId: "5267089", keyPath: "/k.pem" }, publicUrl: PUBLIC_URL, secretPath: SECRET_PATH });
  assert.throws(() => declaredTunnel({ ...host, github: { identity: { scheduler: { mode: "user-accounts" } } } }), /github\.identity\.scheduler/);
  assert.throws(() => declaredTunnel({ ...host, events: { ...host.events, tunnel: "none" } }), /events\.tunnel/);
  assert.throws(() => declaredTunnel({ github: host.github }), /events\.tunnel/);
});

/** A shipped directory holding the two templates, an installed directory, and a `systemctl` that remembers what it was told. */
function withHome(body: (home: { install: (events?: unknown) => string[], installedDir: string, calls: string[][], out: string[] }) => void) {
  const root = tmpDir("event-tunnel-5197-");
  const shippedDir = join(root, "host");
  const installedDir = join(root, ".config/systemd/user");
  mkdirSync(shippedDir, { recursive: true });
  for (const template of [TEMPLATE, "event-receiver.service.in"]) copyFileSync(join(SHIPPED_DIR, template), join(shippedDir, template));
  const calls: string[][] = [];
  const out: string[] = [];
  const systemctl = (args: string[]) => { calls.push(args); return ""; };
  const install = (events?: unknown) => hostUnitsInstall({ shippedDir, installedDir, host: hostWith(events), units: UNITS, projectUnitsDir: null, declaredKeys: new Set(), systemctl: systemctl as never,
    git: (() => "") as never, out: (line: string) => { out.push(line); } } as never) as unknown as string[];
  body({ install, installedDir, calls, out });
}

test("#5197: `host:install` writes and enables both services for the funnel, and `tunnel: none` removes both, stopping the tunnel first", () => {
  withHome(({ install, installedDir, calls, out }) => {
    assert.deepEqual(install({ source: "poll" }), [], "NEGATIVE CONTROL: a poll host with no tunnel installs neither");
    assert.deepEqual(install(FUNNEL), [RECEIVER_UNIT, UNIT], "POSITIVE CONTROL: the funnel host installs the receiver and the tunnel");
    assert.equal(readFileSync(join(installedDir, UNIT), "utf8"), unitText(UNIT, FUNNEL), "written as the template renders it");
    assert.deepEqual(calls.filter((call) => call[0] === "enable").map((call) => call.join(" ")).sort(), [`enable --now ${RECEIVER_UNIT}`, `enable --now ${UNIT}`], "the SERVICES are enabled: no timer starts either");
    // THE REVERT: the one word, and the same install removes both, the tunnel stopped (so its ExecStop runs) before its file goes.
    calls.length = 0;
    out.length = 0;
    install({ ...FUNNEL, tunnel: "none" });
    assert.deepEqual(readdirSync(installedDir), [], "both units are gone");
    assert.ok(out.some((line) => line.startsWith(`REMOVED ${UNIT}`)));
    assert.deepEqual(calls.filter((call) => call.includes(UNIT)).slice(0, 1), [["disable", "--now", UNIT]], "stopped before the file was deleted");
  });
});

test("#5197: the command refuses an unknown subcommand with usage, and a host that exposes nothing with the field that says so", async () => {
  const out: string[] = [];
  assert.equal(await main(["bogus"], { out: (line) => { out.push(line); } }), 2);
  assert.match(out.join("\n"), /usage: node src\/event-tunnel\.ts <up\|down\|register\|deliveries>/);
  const refused: string[] = [];
  const asked: string[] = [];
  const fetch: Fetch = async (url) => { asked.push(url); return { status: 200, text: async () => "[]" }; };
  assert.equal(await main(["register"], { out: (line) => { refused.push(line); }, fetch }), 1, "the fixture host declares no funnel");
  assert.match(refused.join("\n"), /event-tunnel: /);
  assert.deepEqual(asked, [], "and nothing was sent to GitHub");
  const exposure = createFakeExposure("agents.example.ts.net");
  assert.equal(await main(["up"], { out: () => undefined, exposure: async () => exposure }), 1, "`up` on a host that declares no funnel refuses, and asks the exposure nothing");
  assert.deepEqual(exposure.calls, []);
});

const MOUNT = { publicUrl: PUBLIC_URL, port: 8787 };
const NAME = "agents.example.ts.net";

/** An exposure that serves the receiver at its funnel path, open to the internet, and the trace pages on 8443 (which are not the receiver's). */
function serving() {
  const exposure = createFakeExposure(NAME);
  exposure.serve(443, 8787, { path: "/webhook", funnel: true });
  exposure.serve(8443, 8788);
  exposure.calls.length = 0;
  return exposure;
}

test("#5197: the path counts as served only when the exposure holds the loopback port at it AND has the port open to the internet", () => {
  assert.equal(pathIsServed(serving(), MOUNT), true, "POSITIVE CONTROL: the whole shape reads as served, so each refusal below is its own field's doing");
  const pagesOnly = createFakeExposure(NAME);
  pagesOnly.serve(8443, 8788);
  assert.equal(pathIsServed(pagesOnly, MOUNT), false, "the trace pages alone are not the receiver");
  assert.equal(pathIsServed(createFakeExposure(NAME), MOUNT), false, "nothing served");
  const tailnetOnly = createFakeExposure(NAME);
  tailnetOnly.serve(443, 8787, { path: "/webhook" });
  assert.equal(pathIsServed(tailnetOnly, MOUNT), false, "proxied but tailnet-only is NOT exposed to GitHub");
  assert.equal(pathIsServed(serving(), { ...MOUNT, port: 9100 }), false, "a different loopback port is a different mount");
  assert.equal(pathIsServed(serving(), { ...MOUNT, publicUrl: "https://agents.example.ts.net/other" }), false, "a different path is a different mount");
  assert.equal(pathIsServed(createFakeExposure(), MOUNT), false, "an exposure that serves nothing holds nothing");
});

test("#5197: `up` and `down` read first and change nothing when the path is already as asked, and read after and refuse when it is not", () => {
  const harness = (exposure: ReturnType<typeof createFakeExposure>) => {
    const out: string[] = [];
    return { out, deps: { out: (line: string) => { out.push(line); }, exposure } };
  };
  const unchanged = harness(serving());
  changeFunnel("up", MOUNT, unchanged.deps);
  assert.deepEqual(unchanged.deps.exposure.calls, [], "already served: the exposure is NOT asked to serve, so a path mounted once by root keeps the unit active as the agent");
  assert.match(unchanged.out.join("\n"), /already served/);

  const empty = createFakeExposure(NAME);
  const mounted = harness(empty);
  changeFunnel("up", MOUNT, mounted.deps);
  assert.deepEqual(empty.calls, ["serve 443/webhook funnel"], "POSITIVE CONTROL: not served, so `up` asks for exactly the one scoped path, open to the internet");
  assert.equal(pathIsServed(empty, MOUNT), true);

  const ignoring = createFakeExposure(NAME);
  const refusedAfter = harness(Object.assign(ignoring, { serve: (): { status: number; stdout: string; stderr: string } => ({ status: 0, stdout: "", stderr: "" }) }));
  assert.throws(() => changeFunnel("up", MOUNT, refusedAfter.deps), /is still NOT served/, "a command that returned and left the path unmounted is a failure, not a success");

  const cannot = createFakeExposure(NAME);
  const refusing = harness(Object.assign(cannot, { serve: () => ({ status: 1, stdout: "", stderr: "401 Unauthorized", refusal: "401 Unauthorized" }) }));
  assert.throws(() => changeFunnel("up", MOUNT, refusing.deps), /the exposure could not serve \/webhook: 401 Unauthorized/, "the exposure's refusal reaches the unit's journal and is not swallowed");

  const gone = harness(createFakeExposure(NAME));
  changeFunnel("down", MOUNT, gone.deps);
  assert.deepEqual(gone.deps.exposure.calls, [], "already off: `down` asks for nothing");

  const removed = harness(serving());
  changeFunnel("down", MOUNT, removed.deps);
  assert.deepEqual(removed.deps.exposure.calls, ["unserve 443/webhook"]);
  assert.equal(pathIsServed(removed.deps.exposure, MOUNT), false);
  assert.deepEqual(removed.deps.exposure.served(), [`${NAME}:8443`], "and the trace pages are left alone");

  const stillPublic = serving();
  assert.throws(() => changeFunnel("down", MOUNT, harness(Object.assign(stillPublic, { unserve: () => ({ status: 0, stdout: "", stderr: "" }) })).deps), /is still served/, "a stop that left the path public says so rather than reporting the unit down over it");
});

test("#5197: under an exposure that serves nothing (`local`), `up` is refused by name and `down` finds nothing to remove", async () => {
  const local = createFakeExposure();
  const out: string[] = [];
  assert.throws(() => changeFunnel("up", MOUNT, { out: (line) => { out.push(line); }, exposure: local }),
    (error: unknown) => error instanceof EventTunnelFailure && error.message === "event-tunnel: the events tunnel needs an exposure that serves to the internet: fake exposure: serve 443: this exposure serves on loopback only");
  changeFunnel("down", MOUNT, { out: (line) => { out.push(line); }, exposure: local });
  assert.match(out.join("\n"), /\/webhook is already off as far as this exposure can tell \(it serves on loopback only: a path an earlier exposure opened is that exposure's to remove\): nothing to change/,
    "and says it cannot tell, rather than that the path is off, since a Funnel path a tailscale exposure opened stays public until it is removed");
});

test("#5197: the chairman's subscription list is the ten the row names", () => {
  assert.deepEqual([...SUBSCRIBED_EVENTS], ["Pull request", "Pull request review", "Check run", "Check suite", "Workflow run", "Status", "Issues", "Issue comment", "Merge group", "Push"]);
});

// THE LIVE HOST. `AGENT_ORG_HOST` is the declaration the row's Acceptance names; in the tool's own CI it is unset (the other tests use a fixture project), and that is the one reason
// this test is skipped. The tests above always run, so the skip hides the live reading only, and the Acceptance command is where it is made.
/** #1650: the fixture's host.json is a recorded copy with no `events` block, so the live reading has nothing to open there. A declaration that cannot be read is NOT skipped: the test runs and reports the parse error. */
const DECLARES_FUNNEL = (() => {
  try {
    return LIVE !== undefined && existsSync(LIVE) && parseHostConfig(readFileSync(LIVE, "utf8"), LIVE).events?.tunnel !== undefined;
  } catch {
    return true;
  }
})();

test("#5197: the REAL host declaration opens the funnel and its unit renders", { skip: LIVE === undefined || !existsSync(LIVE) ? "AGENT_ORG_HOST does not name a host declaration: the live reading is the row's Acceptance" : DECLARES_FUNNEL ? false : "#1650: the host AGENT_ORG_HOST names declares no `events.tunnel` (the fixture's host.json has no events block): the live reading is a11ign's own declaration, and the row's Acceptance on a host that declares one" }, () => {
  const real = parseHostConfig(readFileSync(LIVE as string, "utf8"), LIVE as string);
  assert.equal(real.events?.tunnel, "tailscale-funnel", "the host declares `events.tunnel: tailscale-funnel`");
  assert.ok(real.events?.publicUrl?.startsWith("https://") && real.events.publicUrl.endsWith(".ts.net" + new URL(real.events.publicUrl).pathname));
  const prefix = "a11ign-";
  const text = shippedUnitText(`${prefix}event-tunnel.service`, { host: real, units: { prefix, boardReportWorkflow: "board-report.yml", own: [] }, projectUnitsDir: null }) ?? "";
  assert.match(text, /^ExecStart=%h\/\.local\/bin\/node (?:packages\/agent-org\/)?src\/event-tunnel\.ts up$/m, "the unit renders from the live declaration (in the tool's form on a host that names a `tool`)");
  const { publicUrl, receiver } = real.events as { publicUrl: string, receiver: { port: number } };
  const exposure = createFakeExposure("agents.example.ts.net");
  changeFunnel("up", { publicUrl, port: receiver.port }, { out: () => undefined, exposure });
  assert.equal(exposure.entries.get(`443${new URL(publicUrl).pathname}`)?.local, receiver.port, "and `up` serves the declared loopback port");
  assert.doesNotMatch(text, /@@/);
});
