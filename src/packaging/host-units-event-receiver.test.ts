// no-token: gh
//
// agent-org#980 (a11ign/a11ign#5043): THE EVENT RECEIVER'S UNIT SHIPS ONLY ON A HOST THAT DECLARES `events.source: webhook`.
//
// Nothing here spawns `gh` or `systemctl`: `shippedUnits`, `shippedUnitText` and `hostUnitsInstall` take their host, their shipped directory, their installed directory and their
// `systemctl` injected, and the real reads are of `host/` (the template) and of the fixture project (`host-units-project.ts`) whose `host.json` every host below is built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./host-units-project.ts";
import { HOST_OPTIONAL_UNITS, SHIPPED_DIR, TOOL_ENTRIES, shippedUnitText, shippedUnits, toolForm } from "../host-units/shipped-dir.ts";
import { LONG_RUNNING_TEMPLATES } from "../host-config.ts";
import { hostUnitsInstall, unclassifiedEntries } from "../host-units.ts";
import { orphanedUnits } from "../host-units/gh-spawn-reached-from.ts";
import { HostConfigRefusal, parseHostConfig, renderTemplate, stateEntryPath, templateValues } from "../host-config.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const TEMPLATE = "event-receiver.service.in";
const UNIT = "a11ign-event-receiver.service";
const UNITS = { prefix: "a11ign-", boardReportWorkflow: "board-report.yml", own: [] as string[] };
const SECRET_PATH = "/etc/a11ign/webhook-secret";
const WEBHOOK = { source: "webhook", receiver: { port: 8787, secretPath: SECRET_PATH, tunnel: "cloudflare" } };

const fixtureHostJson = () => JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")) as Record<string, unknown>;
/** A host built from the fixture project's declaration with `extra` changed; `events` is dropped first so each host says only what the test says. */
const hostWith = (extra: Record<string, unknown>) => {
  const { events: _events, ...rest } = fixtureHostJson();
  return parseHostConfig(JSON.stringify({ ...rest, ...extra }), "event-receiver test host.json");
};
const webhookHost = () => hostWith({ events: WEBHOOK });
const pollHost = () => hostWith({ events: { source: "poll" } });
const noEventsHost = () => hostWith({});

const listed = (host: ReturnType<typeof hostWith>) => shippedUnits(SHIPPED_DIR, { projectUnitsDir: null, prefix: UNITS.prefix, declaredKeys: new Set(), host });
const shippedText = (host: ReturnType<typeof hostWith>) => shippedUnitText(UNIT, { host, units: UNITS, projectUnitsDir: null }) ?? "";

test("agent-org#980: with `events.source: webhook` the receiver's unit is in `shippedUnits`; with `poll` and with no `events` block it is not, and nothing else moves", () => {
  const withReceiver = listed(webhookHost());
  assert.ok(withReceiver.includes(UNIT), "POSITIVE CONTROL: a webhook host IS shipped the unit, so the absences below are the declaration's doing and not a template that never ships");
  assert.ok(withReceiver.length > 1, "and the list is more than the one unit, so 'nothing else moves' compares two populations");
  for (const [name, host] of [["poll", pollHost()], ["no events block", noEventsHost()]] as const) {
    const without = listed(host);
    assert.equal(without.includes(UNIT), false, `NEGATIVE CONTROL: a ${name} host is not shipped the unit`);
    assert.deepEqual(withReceiver.filter((unit) => unit !== UNIT), without, `${name}: the declaration adds the one service and changes nothing else`);
  }
});

test("agent-org#980: the template is classified as the tool's, long-running with no timer, and keyed on the HOST declaration, so it is never UNCLASSIFIED", () => {
  assert.ok(TOOL_ENTRIES.includes(TEMPLATE));
  assert.ok(LONG_RUNNING_TEMPLATES.includes(TEMPLATE), "`enable --now` on the SERVICE is what starts it: no clock does");
  assert.ok(!TOOL_ENTRIES.includes("event-receiver.timer.in"));
  assert.deepEqual(Object.keys(HOST_OPTIONAL_UNITS), [TEMPLATE, "event-tunnel.service.in"], "the receiver's template and, since a11ign/a11ign#5197, the funnel's");
  assert.ok(Object.keys(HOST_OPTIONAL_UNITS).every((name) => existsSync(join(SHIPPED_DIR, name))), "every host-optional template is a file that is there");
  assert.deepEqual(unclassifiedEntries({ shippedDir: SHIPPED_DIR, projectUnitsDir: null, units: UNITS, host: pollHost() }), []);
});

test("agent-org#980: the unit is rendered with the port, the secret path and the queue from the declaration, and names the loopback address the tunnel must point at", () => {
  const host = webhookHost();
  const text = shippedText(host);
  const queue = stateEntryPath("events/queue.jsonl", { host, home: host.home, env: {} });
  assert.match(text, new RegExp(`^ExecStart=%h/\\.local/bin/node packages/agent-org/src/event-receiver\\.ts --port 8787 --secret-file ${SECRET_PATH} --queue ${queue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(text, /@@/, "no placeholder is left");
  assert.match(text, /^Environment=NODE_COMPILE_CACHE=%h\/\.cache\/node-compile-cache$/m);
  assert.match(text, new RegExp(`^Environment=GH_CONFIG_DIR=${host.gh.workers}/gh$`, "m"));
  assert.match(text, /^Type=simple$/m);
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^# IT LISTENS ON 127\.0\.0\.1:8787 and nowhere else/m, "the header names the loopback address");
  assert.match(text, /^# THE TUNNEL .* IS NOT STARTED HERE: .* must point at http:\/\/127\.0\.0\.1:8787 /m, "and says the tunnel is not this unit's");
  assert.doesNotMatch(text, /^ExecStart=.*--host/m, "no flag moves it off loopback");

  const other = hostWith({ events: { ...WEBHOOK, receiver: { ...WEBHOOK.receiver, port: 9100, secretPath: "/srv/secrets/gh-hook" } } });
  assert.match(shippedText(other), /--port 9100 --secret-file \/srv\/secrets\/gh-hook /, "a different declaration renders a different unit: the values are read, not typed");
});

test("agent-org#980: in tool form it runs from the tool's checkout and carries the host's declaration", () => {
  const tool = "/opt/agent-org";
  const host = hostWith({ events: WEBHOOK, tool });
  const installed = shippedText(host);
  assert.match(installed, new RegExp(`^WorkingDirectory=${tool}$`, "m"));
  assert.match(installed, /^ExecStart=%h\/\.local\/bin\/node src\/event-receiver\.ts --port 8787 --secret-file /m);
  assert.doesNotMatch(installed, /packages\/agent-org/);
  assert.match(installed, /^Environment=AGENT_ORG_HOST=.*\/\.agent-org\/host\.json$/m);
  const plain = shippedUnitText(UNIT, { host: webhookHost(), units: UNITS, projectUnitsDir: null }) ?? "";
  assert.equal(toolForm(TEMPLATE, plain, { tool, checkout: PROJECT_ROOT, beforeTicks: [] }).includes("src/event-receiver.ts"), true, "`toolForm` is what rewrote it");
});

test("agent-org#980: a path that would change what the unit line runs is refused by field name, and a poll host's values carry no receiver at all", () => {
  const spaced = parseHostConfig(JSON.stringify({ ...fixtureHostJson(), events: { ...WEBHOOK, receiver: { ...WEBHOOK.receiver, secretPath: "/etc/a b/secret" } } }), "test");
  assert.throws(() => templateValues(spaced, UNITS), (err: unknown) => err instanceof HostConfigRefusal && err.field === "events.receiver.secretPath");
  const poll = templateValues(pollHost(), UNITS);
  assert.deepEqual(Object.keys(poll).filter((key) => key.startsWith("events")), [], "NEGATIVE CONTROL: no port, secret or queue is defaulted for a poll host");
  assert.ok(Object.keys(templateValues(webhookHost(), UNITS)).includes("eventsPort"), "POSITIVE CONTROL: and a webhook host's values do carry them");
  const template = readFileSync(join(SHIPPED_DIR, TEMPLATE), "utf8");
  assert.throws(() => renderTemplate(template, poll, TEMPLATE), (err: unknown) => err instanceof HostConfigRefusal && err.field === "@@eventsPort@@",
    "a template rendered for a host that declares no receiver is REFUSED, never installed with a hole in it");
});

/** A shipped directory holding the receiver's template, an installed directory, and a `systemctl` that remembers what it was told. */
function withHome(body: (home: { install: (host: ReturnType<typeof hostWith>) => { units: string[], out: string[] }, installedDir: string, calls: string[][] }) => void) {
  const root = tmpDir("event-receiver-980-");
  const shippedDir = join(root, "host");
  const installedDir = join(root, ".config/systemd/user");
  mkdirSync(shippedDir, { recursive: true });
  copyFileSync(join(SHIPPED_DIR, TEMPLATE), join(shippedDir, TEMPLATE));
  const calls: string[][] = [];
  const systemctl = (args: string[]) => { calls.push(args); return ""; };
  const install = (host: ReturnType<typeof hostWith>) => {
    const out: string[] = [];
    const units = hostUnitsInstall({ shippedDir, installedDir, host, units: UNITS, projectUnitsDir: null, declaredKeys: new Set(), systemctl: systemctl as never, git: (() => "") as never,
      out: (line: string) => { out.push(line); } } as never);
    return { units, out };
  };
  body({ install, installedDir, calls });
}

test("agent-org#980: `host:install` on a webhook host writes the unit and runs `enable --now` on the SERVICE; on a poll host it writes nothing and removes an installed copy", () => {
  withHome(({ install, installedDir, calls }) => {
    const poll = install(pollHost());
    assert.deepEqual(poll.units, [], "NEGATIVE CONTROL: a poll host installs no unit");
    assert.equal(existsSync(join(installedDir, UNIT)), false);
    assert.deepEqual(calls.filter((call) => call.includes(UNIT)), []);

    const webhook = install(webhookHost());
    assert.deepEqual(webhook.units, [UNIT], "POSITIVE CONTROL: a webhook host installs it");
    assert.equal(readFileSync(join(installedDir, UNIT), "utf8"), shippedText(webhookHost()), "written as the template renders it");
    assert.deepEqual(calls.filter((call) => call[0] === "enable"), [["enable", "--now", UNIT]], "the SERVICE is what is enabled: no timer starts it");

    // THE REVERT: the declaration says `poll` again and the same install removes the copy, stopping it first.
    calls.length = 0;
    const reverted = install(pollHost());
    assert.deepEqual(reverted.units, []);
    assert.ok(reverted.out.some((line) => line.startsWith(`REMOVED ${UNIT}`)), "the install says it removed the orphan");
    assert.equal(existsSync(join(installedDir, UNIT)), false);
    assert.deepEqual(calls.filter((call) => call.includes(UNIT)).slice(0, 1), [["disable", "--now", UNIT]], "and stopped it before deleting the file");
  });
});

test("agent-org#980: an installed copy on a poll host is reported an orphan, and on a webhook host it is not", () => {
  withHome(({ install, installedDir }) => {
    install(webhookHost());
    const deps = { shippedDir: join(installedDir, "..", "..", "..", "host"), installedDir, units: UNITS, projectUnitsDir: null, declaredKeys: new Set<string>(), git: (() => "") as never };
    assert.deepEqual(orphanedUnits({ ...deps, host: webhookHost() }).map((finding) => finding.unit), [], "POSITIVE CONTROL: on the host that asks for it the installed copy is current");
    assert.deepEqual(orphanedUnits({ ...deps, host: pollHost() }).map((finding) => finding.unit), [UNIT], "NEGATIVE CONTROL: once the host reverts to poll it is an orphan");
    assert.deepEqual(readdirSync(installedDir), [UNIT]);
  });
});
