// no-token: none -- the planner is given each host file as text, and the one write is injected; the last test spawns `doctor` as its own process on a
// temporary host file, and reads nothing else
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeMoves, migrateHost, planHostFix, writeHostFix } from "./migrate-host.ts";
import { parseHostConfig } from "../host-config.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { TicketSettingsRefusal } from "../ticket-mode/settings-refusal.ts";

const LINEAR = "^mcp__linear__(get|list|search|extract)_";
const SAVE = "^mcp__linear__save_comment$";
const DESIGN = "^mcp__claude_ai_Figma__(get|read)_";

/** The machine facts every host file names: the project, its checkout and the workers' and leads' gh accounts. */
const BASE = {
  schema: 1, home: "/home/agent", binDir: "/home/agent/.local/bin", primary: "app", projects: [{ id: "app", checkout: "/home/agent/projects/app" }],
  clones: { "nbl-ui-netbox": "/home/agent/repos/nbl-ui-netbox" }, stateDir: "/home/agent/.local/state/agent-org", _what: "prose, which no reader reads",
  gh: { workers: "/home/agent/workers", leads: "/home/agent/leads", leadsHeader: ["header"], leadsWorkspaces: [{ id: "w6", role: "ceo" }] },
};

/** The agents host, as `host.json` held it on 2026-10-20: a key file, tailscale, the atomic reviewer, a planner, GitHub Apps and the Linear reads. */
const AGENTS_HOST = {
  ...BASE,
  github: { identity: { scheduler: { mode: "github-apps", appId: 1234, keyPath: "/home/agent/.config/app.pem", installationId: 5678, slug: "agent-org-bot" } } },
  tickets: {
    max: 3, port: 4747, uiPort: 4748, herdrSession: "tickets", linearKey: { path: "/home/agent/.config/linear.key" },
    connectors: [LINEAR, SAVE], workingState: "In Progress", plan: "-plan-[^/]*\\.md$",
    planner: { run: "Run the nbl-ui:create-ticket skill: unattended: plan {keys} into {dir}", state: "Planned" }, reviewer: "atomic",
    terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal", serve: "tailscale", servePorts: { ui: 9443, terminal: 9444 },
    _note: "prose inside tickets",
  },
  _note: "prose at the top",
};

/** The work host: the Keychain key, a Slack publisher with its connectors, the Linear reads beside a design tool, and no reviewer. */
const WORK_HOST = {
  ...BASE,
  tickets: {
    max: 2, linearKey: { keychain: "agent-org-linear" }, connectors: [LINEAR, DESIGN], workingState: "In Progress", designTools: true,
    publish: { run: "Run the post-pr-to-slack skill on these pull requests: {prs}; then write {dir}/published.json", model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] },
  },
};

const text = (host: unknown) => JSON.stringify(host, null, 2);

/** The flat settings a host file reads, without the providers: what the migration must keep. */
function flatSettingsOf(host: unknown) {
  const { providers: _providers, ...settings } = parseTicketSettings(host);
  return { ...settings, connectors: [...settings.connectors].sort() };
}

/** The move a host file makes, which the test asserts it makes: the file's text, and the moves. */
async function moveOf(host: unknown) {
  const fix = await planHostFix(text(host));
  assert.ok(fix.kind === "move", `${fix.kind} is not a move: ${JSON.stringify(fix)}`);
  return fix;
}

for (const [name, host] of [["the agents host", AGENTS_HOST], ["the work host", WORK_HOST]] as const) {
  test(`${name}: doctor --fix moves every old key to its block, and the new file reads the same settings and the same host`, async () => {
    const { text: migratedText } = await moveOf(host);
    const migrated = JSON.parse(migratedText);
    assert.deepEqual(flatSettingsOf(migrated), flatSettingsOf(host), "the ticket settings are the same");
    assert.deepEqual(parseHostConfig(migratedText), parseHostConfig(text(host)), "the host file reads the same gh wrapper, units and identities");
    for (const old of ["linearKey", "workingState", "publish", "reviewer", "port", "uiPort", "terminal", "serve", "servePorts"]) {
      assert.equal(Object.hasOwn(migrated.tickets, old), false, `tickets.${old} is gone from the file`);
    }
    assert.equal(Object.hasOwn(migrated, "gh"), false, "gh moved into the code host block");
    assert.equal(Object.hasOwn(migrated, "github"), false, "github moved into the code host block");
    assert.equal(migrated._what, host._what, "prose keys stay, where they were");
  });

  test(`${name}: a second run finds nothing to move, so running it again changes nothing`, async () => {
    assert.equal((await planHostFix((await moveOf(host)).text)).kind, "nothing");
  });
}

test("the work host's Linear reads move to the tracker, and the design tool stays in tickets.connectors", async () => {
  const migrated = JSON.parse((await moveOf(WORK_HOST)).text);
  assert.deepEqual(migrated.tickets.providers.tracker.connectors, [LINEAR]);
  assert.deepEqual(migrated.tickets.connectors, [DESIGN], "the design tool is not the tracker's");
  assert.equal(migrated.tickets.providers.publish.provider, "slack", "a publish block names slack");
  assert.equal(migrated.tickets.providers.reviewer, undefined, "no reviewer alias, so no reviewer block");
});

test("a block that already holds an alias's value leaves the alias to be removed, with nothing copied", async () => {
  const host = { ...AGENTS_HOST, tickets: { ...AGENTS_HOST.tickets, linearKey: { path: "/k" }, providers: { tracker: { provider: "linear", key: { path: "/k" } } } } };
  const fix = await moveOf(host);
  const migrated = JSON.parse(fix.text);
  assert.deepEqual(migrated.tickets.providers.tracker.key, { path: "/k" });
  assert.match(describeMoves(fix.moves).join("\n"), /tickets\.linearKey: the same value is already at tickets\.providers\.tracker\.key, so tickets\.linearKey is only removed/);
});

test("a host file the ticket settings refuse is not migrated: two refusals would agree by their text and prove nothing", async () => {
  const fix = await planHostFix(text({ ...AGENTS_HOST, tickets: { ...AGENTS_HOST.tickets, max: "three" } }));
  assert.equal(fix.kind, "refused");
  if (fix.kind !== "refused") return;
  assert.match(fix.reason, /the ticket settings refuse, so there are no settings to keep/);
});

test("a host file whose blocks and aliases disagree is refused by name, and nothing is migrated", async () => {
  const host = { ...AGENTS_HOST, tickets: { ...AGENTS_HOST.tickets, providers: { tracker: { provider: "linear", key: { path: "/other" } } } } };
  await assert.rejects(planHostFix(text(host)), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.linearKey");
});

/** The machine facts without the top-level `gh`, which is an alias once it is read through the code host's block. */
const { gh: _gh, ...TICKETS_ONLY } = BASE;

test("a host file with no alias to move says so, and has nothing to write", async () => {
  const fix = await planHostFix(text({ ...TICKETS_ONLY, tickets: { providers: { tracker: { provider: "linear" } } } }));
  assert.equal(fix.kind, "nothing");
});

test("a connector list with no Linear pattern stays in tickets.connectors, and no block is added for it", async () => {
  const { host } = migrateHost({ ...TICKETS_ONLY, tickets: { connectors: [DESIGN] } });
  assert.deepEqual((host.tickets as Record<string, unknown>).connectors, [DESIGN]);
  assert.equal(Object.hasOwn(host.tickets as object, "providers"), false, "no block is added for no alias");
});

test("the backup is kept beside the host file, mode 0600, under the UTC time the move was made, before the new file replaces it", async () => {
  const calls: Array<[string, unknown, number]> = [];
  const backup = writeHostFix("/home/agent/.agent-org/host.json", "old", "new", 0o644, new Date("2026-10-20T21:30:05.123Z"),
    (path, body, mode) => { calls.push([path, body, mode]); });
  assert.equal(backup, "/home/agent/.agent-org/host.json.before-providers-2026-10-20T21-30-05-123Z");
  assert.deepEqual(calls, [
    [backup, "old", 0o600],
    ["/home/agent/.agent-org/host.json", "new", 0o644],
  ], "the backup is written first, and the host file keeps its mode");
});

test("a line the move removes and adds is named, so the dry run shows the change", async () => {
  const fix = await moveOf(WORK_HOST);
  assert.ok(fix.lines.some((line) => line.startsWith("+ ") && line.includes("providers")), "the new block's lines are added");
  assert.ok(fix.lines.some((line) => line.startsWith("- ") && line.includes("linearKey")), "the old key's line is removed");
});

/** A ticket-only machine's host file, as the chairman's work Mac holds it: the clones and the tickets, and no `primary` (A11-144). */
const TICKET_ONLY_FILE = { clones: { "nbl-ui-netbox": "/home/agent/repos/nbl-ui-netbox" }, tickets: { linearKey: { keychain: "agent-org-linear" }, port: 4800 } };

test("A11-144: a ticket-only host with no primary is migrated by the planner, which loads no project declaration", async () => {
  const fix = await moveOf(TICKET_ONLY_FILE);
  assert.deepEqual(fix.moves.map(({ old }) => old), ["tickets.linearKey", "tickets.port"]);
});

test("A11-144: doctor and doctor --fix run on a ticket-only host with no primary, in processes that do not load the project declaration", () => {
  // The project declaration is loaded at import when a host file names no ticket run (`AGENT_ORG_TICKET` unset): a `doctor` that loads it refuses here.
  const host = join(tmpDir("doctor-ticket-only-"), "host.json");
  writeFileSync(host, JSON.stringify(TICKET_ONLY_FILE, null, 2));
  const env: Record<string, string | undefined> = { ...process.env, AGENT_ORG_HOST: host };
  delete env.AGENT_ORG_TICKET;
  const doctor = fileURLToPath(new URL("./doctor.ts", import.meta.url));
  const fix = spawnSync(process.execPath, [doctor, "--fix", "--dry-run"], { env, encoding: "utf8" });
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.stdout, /would move, and nothing is written/);
  assert.doesNotMatch(fix.stderr, /REFUSED|ProjectDeclarationRefusal/);
  const plain = spawnSync(process.execPath, [doctor], { env, encoding: "utf8", timeout: 120_000 });
  assert.doesNotMatch(plain.stderr, /REFUSED|ProjectDeclarationRefusal/);
  assert.match(plain.stdout, /host file: .*: 1 repositories/);
});

test("A11-144: doctor --fix, then doctor, on a copy of each host shape leaves no alias row, on this branch's own code", () => {
  // The chairman's live check runs this same pair on the real host files; this runs it on a copy of each shape, so the branch carries the evidence.
  const doctor = fileURLToPath(new URL("./doctor.ts", import.meta.url));
  for (const [name, file] of [["ticket-only", TICKET_ONLY_FILE], ["agents", AGENTS_HOST]] as const) {
    const host = join(tmpDir("doctor-copy-"), "host.json");
    writeFileSync(host, JSON.stringify(file, null, 2));
    const env: Record<string, string | undefined> = { ...process.env, AGENT_ORG_HOST: host };
    delete env.AGENT_ORG_TICKET;
    const fix = spawnSync(process.execPath, [doctor, "--fix"], { env, encoding: "utf8", timeout: 120_000 });
    assert.match(fix.stdout, /moved, and the old file is kept at/, `${name}: ${fix.stdout}${fix.stderr}`);
    const plain = spawnSync(process.execPath, [doctor], { env, encoding: "utf8", timeout: 120_000 });
    assert.doesNotMatch(plain.stderr, /REFUSED|ProjectDeclarationRefusal/, name);
    assert.doesNotMatch(plain.stdout, /^FAIL {2}alias /m, `${name}: an alias row remains`);
    assert.match(plain.stdout, /tracker \(linear\)/, `${name}: the tracker's provider row is there`);
  }
});
