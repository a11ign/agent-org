// no-token: gh -- reads the schema and runs the readers on a fixture; the readers' own reads are recorded, so no file outside the test is read
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, type SchemaEntry } from "./config-schema.ts";
import { defaultSchema } from "../plugins/schema.ts";
import { keySource } from "../../plugins/linear/key.ts";

/** The schema the page and the readers use: core's entries and the bundled plugins' settings (A11-159). */
const SCHEMA = defaultSchema();
import { parseTicketSettings } from "./settings.ts";
import { parseHostConfig, parseBeforeTick, parseUnitsDeclaration } from "../host-config.ts";
import { parseProjectDeclaration } from "../project-config.ts";
import { haikuBriefEnabled } from "../haiku-brief.ts";
import { ceoOneShotEnabled } from "../ceo-one-shot.ts";
import { orchestratorOneShotEnabled } from "../orchestrator-one-shot.ts";
import { parseEmergencyPriorityOption } from "../work-gate/causes/rows-offer.ts";

/** A host file with every key the readers accept, each with a value the readers accept. `_note` is prose, which no reader reads. */
const HOST = {
  schema: 1, _note: "prose",
  home: "/home/a", binDir: "/home/a/.local/bin", primary: "app", projects: [{ id: "app", checkout: "/home/a/projects/app" }],
  tool: "/home/a/tools/agent-org", toolVersion: "v0.7.8", stateDir: "/home/a/.local/state/agent-org",
  clones: { "nbl-ui-netbox": "/home/a/repos/nbl-ui-netbox" },
  triage: { provider: "jev", keyPath: "/home/a/.config/jev.key", minConfidence: 0.8 },
  events: { source: "webhook", reconcileMinutes: 20, receiver: { port: 8787, secretPath: "/home/a/.config/hook.secret", tunnel: "tailscale" },
    tunnel: "tailscale-funnel", publicUrl: "https://host.example.ts.net/hook" },
  gh: { workers: "/home/a/gh/workers", leads: "/home/a/gh/leads", leadsHeader: ["header"], leadsWorkspaces: [{ id: "lead1", role: "lead" }] },
  github: { identity: { scheduler: { mode: "github-apps", appId: 123, keyPath: "/home/a/.config/app.pem", installationId: 456, slug: "agent-org-bot" }, workers: { mode: "user-accounts" } } },
  workers: { haikuBrief: true, ceoOneShot: true, orchestratorOneShot: true },
  emergencyPriority: { enabled: true, setters: ["manager"], incidentKeys: ["incident:x"] },
  tickets: {
    max: 3, port: 4747, uiPort: 4748, herdrSession: "tickets", worktreeRoot: "/home/a/state/worktrees", linearKey: { path: "/home/a/.config/linear.key" },
    brief: "/home/a/brief.md", review: "/home/a/review.md", deny: [{ pattern: "rm -rf", reason: "it deletes" }], plugins: ["nbl-ui@applied-ai"],
    terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}", plan: "-plan-[^/]*\\.md$", planner: { run: "plan {keys} into {dir}", state: "Planned" },
    writer: { run: "write {request} into {dir}", model: "opus", effort: "high" }, preflight: [{ name: "lint", run: "true", timeoutSeconds: 30 }],
    workingState: "In Progress", connectors: ["^mcp__linear__(get|list)_"], publish: { run: "publish {prs} into {dir}", model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] },
    drafts: true, designTools: true, prReview: "a11ign:clean-code-review", reviewer: "atomic", pick: { team: "A11" }, stallMinutes: 30, updateMaxDeferHours: 2,
    serve: "tailscale", servePorts: { ui: 9443, terminal: 9444 },
    // The named provider blocks (A11-144), each setting in the place its old key holds, with the same value: the drift test reads both, so each new key
    // has an entry and each alias one, and the aliases still parse beside their blocks.
    providers: {
      tracker: { provider: "linear", key: { path: "/home/a/.config/linear.key" }, connectors: ["^mcp__linear__(get|list)_"], workingState: "In Progress", plannedState: "Planned", takenStates: ["In Progress", "Planned"] },
      codeHost: {
        provider: "github", stack: true,
        identity: { scheduler: { mode: "github-apps", appId: 123, keyPath: "/home/a/.config/app.pem", installationId: 456, slug: "agent-org-bot" }, workers: { mode: "user-accounts" } },
        gh: { workers: "/home/a/gh/workers", leads: "/home/a/gh/leads", leadsHeader: ["header"], leadsWorkspaces: [{ id: "lead1", role: "lead" }] },
      },
      publish: { provider: "slack", run: "publish {prs} into {dir}", model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] },
      reviewer: { provider: "atomic" },
      exposure: {
        provider: "tailscale", port: 4747, uiPort: 4748, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}",
        tailnetPorts: { ui: 9443, terminal: 9444 },
      },
    },
  },
};

/** A project declaration with every key the readers accept, and the `units` and `beforeTick` the host reader reads. */
const PROJECT = {
  schema: 1,
  tracker: [{ key: "", repo: "owner/app", board: { owner: "owner", number: 4 } }],
  code: [{ key: "", repo: "owner/app" }, { key: "lib", repo: "owner/lib" }],
  leakPatterns: [{ name: "internal host", pattern: "corp\\.example" }],
  dora: [{ repo: "owner/lib", release: { kind: "npm", package: "lib" }, releasablePaths: ["src/"], adopterFacing: true, adopterDocs: ["README.md"] },
    { repo: "owner/tool", release: { kind: "tag" }, releasablePaths: ["src/"], adopterFacing: false }],
  offerMilestones: ["Now"],
  routing: { question: "traits", routes: ["haiku/high", "sonnet/medium", "sonnet/high"], guidance: { "haiku/high": { what: "w", signals: ["s"], notFor: "n", examples: ["e"] } },
    cheaperMinP: 0.5, dearerMinP: 0.7, sonnetVetoMinP: 0.7 },
  units: { prefix: "app-", boardReportWorkflow: "report.yml", own: ["app-thing.service"] },
  beforeTick: "pnpm run primary:update",
};

/** The workers a board runs with when nothing names a number: the built-in default the schema describes. */
const DEFAULT_MAX = 3;

const isIndex = (name: string) => /^\d+$/.test(name);
/** Names every object has, or every array has, which a reader touches for its own reasons and no key of the file is. */
const NOT_A_KEY = new Set([...Object.getOwnPropertyNames(Object.prototype), ...Object.getOwnPropertyNames(Array.prototype), "length"]);

/**
 * `value`, wrapped so that each key a reader asks of it is recorded under its path: `tickets.deny[].pattern`, `clones.nbl-ui-netbox`. A key the
 * object does not hold is recorded all the same, because the reader asked for it. The reader sees the same value, so nothing is validated differently.
 */
function recording(value: unknown, path: string, into: Set<string>): unknown {
  if (typeof value !== "object" || value === null) return value;
  const at = (name: string) => (path === "" ? name : `${path}.${name}`);
  const isKey = (name: string | symbol): name is string => typeof name !== "symbol" && !isIndex(name) && !NOT_A_KEY.has(name);
  return new Proxy(value, {
    // eslint-disable-next-line clean-code/names-describe-side-effects -- the Proxy trap's own name, which the reader's access calls
    get(target, name, receiver) {
      const child = Reflect.get(target, name, receiver);
      if (typeof name === "symbol" || NOT_A_KEY.has(name)) return child;
      if (isIndex(name)) return recording(child, `${path}[]`, into);
      into.add(at(name));
      return recording(child, at(name), into);
    },
    // eslint-disable-next-line clean-code/names-describe-side-effects -- the Proxy trap's own name, which the reader's access calls
    has(target, name) {
      if (isKey(name)) into.add(at(name));
      return Reflect.has(target, name);
    },
    // eslint-disable-next-line clean-code/names-describe-side-effects -- the Proxy trap's own name, which the reader's access calls
    getOwnPropertyDescriptor(target, name) {
      if (isKey(name)) into.add(at(name));
      return Reflect.getOwnPropertyDescriptor(target, name);
    },
  });
}

/** Runs `run` with every `JSON.parse` in it handing back a recording value, and returns what was read. */
function readsOf(into: Set<string>, run: () => void, path = ""): void {
  const parse = JSON.parse;
  JSON.parse = ((text: string) => recording(parse(text), path, into)) as typeof JSON.parse;
  try {
    run();
  } finally {
    JSON.parse = parse;
  }
}

/** The keys one file's readers read, in the notation the schema uses. */
function hostReads(): Set<string> {
  const reads = new Set<string>();
  const text = JSON.stringify(HOST);
  const quiet = { path: "/host.json", log: () => {} };
  readsOf(reads, () => parseHostConfig(text, "host.json"));
  // The ticket block's reader takes the parsed object, so it is recorded here rather than through `JSON.parse`.
  parseTicketSettings(recording(HOST, "", reads) as typeof HOST, "/home/a");
  // The tracker's key is the Linear plugin's to read (A11-159): core hands the block's value over, and the plugin's own reader is what asks it for `keychain` and `path`.
  keySource(recording(HOST.tickets.providers.tracker.key, "tickets.providers.tracker.key", reads));
  readsOf(reads, () => haikuBriefEnabled({ ...quiet, read: () => text }));
  readsOf(reads, () => ceoOneShotEnabled({ ...quiet, read: () => text }));
  readsOf(reads, () => orchestratorOneShotEnabled({ ...quiet, read: () => text }));
  readsOf(reads, () => parseEmergencyPriorityOption(text));
  return reads;
}

function projectReads(): Set<string> {
  const reads = new Set<string>();
  const text = JSON.stringify(PROJECT);
  readsOf(reads, () => parseProjectDeclaration(text, "project.json"));
  readsOf(reads, () => parseUnitsDeclaration(text, "project.json"));
  readsOf(reads, () => parseBeforeTick(text, "project.json"));
  return reads;
}

/** A schema key as a pattern that matches a read path: `<name>` and `<role>` stand for one key, `[]` for one list element. */
const pattern = (key: string) => new RegExp(`^${key.replace(/[.[\]/]/g, "\\$&").replace(/<[a-z]+>/g, "[^.\\[\\]]+")}$`);

const entriesOf = (file: SchemaEntry["file"]) => SCHEMA.filter((entry) => entry.file === file);
/** Every alternative shape a key takes, which a fixture need not read all at once. */
const ALTERNATIVES = new Set(SCHEMA.flatMap((entry) => entry.also ?? []));

/** Asserts a file's readers and its schema describe the same keys, both ways. */
function assertDescribes(file: SchemaEntry["file"], reads: Set<string>) {
  const described = entriesOf(file).map((entry) => pattern(entry.key));
  const unread = [...reads].filter((read) => !read.startsWith("_") && !described.some((re) => re.test(read))).sort();
  assert.deepEqual(unread, [], `${file}: a reader accepts a key with no entry in config-schema.ts`);
  const undescribed = entriesOf(file).map((entry) => entry.key).filter((key) => !ALTERNATIVES.has(key)
    && ![...reads].some((read) => pattern(key).test(read))).sort();
  assert.deepEqual(undescribed, [], `${file}: config-schema.ts describes a key no reader accepts`);
}

test("the host file's readers accept exactly the keys the schema describes, and the project's do too", () => {
  assertDescribes("host.json", hostReads());
  assertDescribes("project.json", projectReads());
});

test("every entry says what the key is, what it defaults to, what breaks, and which group shows it", () => {
  for (const entry of SCHEMA) {
    const where = `${entry.file} ${entry.key}`;
    for (const field of ["key", "type", "explanation", "breaks"] as const) assert.ok(entry[field].trim() !== "", `${where}: ${field} is empty`);
    assert.ok((GROUPS as readonly string[]).includes(entry.group), `${where}: group ${entry.group} is not one the page shows`);
    assert.equal(entry.absent === "default", entry.default !== null, `${where}: a default is named exactly when the absent state is default`);
    assert.ok(!entry.key.split(".").some((segment) => segment.startsWith("_")), `${where}: a key that starts with _ is prose, not described`);
  }
});

test("each secret path and key is flagged, so the page never shows its contents", () => {
  const flagged = new Set(SCHEMA.filter((entry) => entry.secret !== undefined).map((entry) => entry.key));
  for (const key of ["tickets.linearKey.path", "tickets.linearKey.keychain", "events.receiver.secretPath", "triage.keyPath", "github.identity.<role>.keyPath"]) {
    assert.ok(flagged.has(key), `${key} is a secret path and is flagged`);
  }
  const unflagged = SCHEMA.filter((entry) => /(keyPath|secretPath|linearKey\.path|linearKey\.keychain)$/.test(entry.key) && entry.secret === undefined).map((entry) => entry.key);
  assert.deepEqual(unflagged, []);
});

test("the schema's entry for a choice the page's controls change has the built-in value the board uses", () => {
  const choices = Object.fromEntries(SCHEMA.filter((entry) => entry.file === "choice.json").map((entry) => [entry.key, entry.default]));
  assert.deepEqual(Object.keys(choices).sort(), ["effort", "model", "planEffort", "planModel", "writerEffort", "writerModel"]);
  assert.equal(parseTicketSettings({ clones: { r: "/r" }, stateDir: "/s" }).max, DEFAULT_MAX, "the workers' default is the one the schema names");
});

/** The shortest sentence that says what a dangerous key can break. */
const MIN_SENTENCE = 20;

test("A11-132: every editable entry says when a change is in force, every entry that cannot be edited says why, and the dangerous keys are the set the plan names, each with what it can break", () => {
  const editable = SCHEMA.filter((entry) => entry.edit.editable);
  for (const entry of editable) {
    assert.ok(entry.edit.editable && ["now", "board", "unit", "none"].includes(entry.edit.applies), `${entry.file} ${entry.key} says when it is in force`);
  }
  for (const entry of SCHEMA.filter((candidate) => !candidate.edit.editable)) {
    assert.ok(!entry.edit.editable && entry.edit.why.length > 0, `${entry.file} ${entry.key} says why it is not editable`);
  }
  const dangerous = editable.flatMap((entry) => (entry.edit.editable && entry.edit.dangerous !== undefined ? [`${entry.file} ${entry.key}`] : []));
  assert.deepEqual(dangerous.sort(), [
    "host.json binDir", "host.json clones.<name>", "host.json events.receiver.port", "host.json events.receiver.secretPath", "host.json home",
    "host.json primary", "host.json projects", "host.json stateDir", "host.json tickets.connectors", "host.json tickets.deny", "host.json tickets.drafts",
    "host.json tickets.plugins", "host.json tickets.preflight", "host.json tickets.providers.codeHost.identity.<role>.keyPath",
    "host.json tickets.providers.codeHost.identity.<role>.mode", "host.json tickets.providers.exposure.port", "host.json tickets.providers.exposure.tailnetPorts",
    "host.json tickets.providers.exposure.uiPort", "host.json tickets.providers.publish.connectors", "host.json tickets.providers.publish.run",
    "host.json tickets.providers.tracker.connectors", "host.json tickets.providers.tracker.key.path", "host.json tickets.worktreeRoot", "host.json triage.keyPath",
    "project.json beforeTick",
  ].sort(), "the set is pinned: change this test with the flags in config-schema.ts");
  for (const entry of editable) {
    if (entry.edit.editable && entry.edit.dangerous !== undefined) assert.ok(entry.edit.dangerous.length > MIN_SENTENCE, `${entry.key} says what it can break`);
  }
});

test("A11-132: a key that is only shown is never editable as a secret's contents: the secret keys are the path keys, and the keychain is not editable", () => {
  const secrets = SCHEMA.filter((entry) => entry.secret !== undefined);
  for (const entry of secrets) {
    // An alias is shown, not changed: its new key is the editable path (A11-144).
    if (entry.secret === "path") assert.equal(entry.edit.editable, entry.aliasOf === undefined, `${entry.key} is editable as a path, unless it is an alias`);
    if (entry.secret === "keychain") assert.equal(entry.edit.editable, false, `${entry.key} is not editable`);
  }
});
