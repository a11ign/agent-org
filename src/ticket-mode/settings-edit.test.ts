// no-token: gh -- the edits run against files in a temporary folder, through a seam that counts the reads and fails a step; no route, no `gh`, no herdr
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { NODE_FS, PROJECT_NOTE, type EditOptions, type FileSystem, previewEdit, restoreBackup, saveEdit, SettingsEditRefusal } from "./settings-edit.ts";
import { readSettingsView } from "./settings-read.ts";
import { parseTicketSettings } from "./settings.ts";

/** A host file with no `primary`, so it is a ticket-only one and no project is read against it; its prose keys sit between its keys. */
const hostWith = (dir: string, tickets: string = "") => `{
  "_about": "Prose the page never changes.",
  "clones": { "nbl-ui-netbox": "/r/netbox" },
  "stateDir": "${join(dir, "state")}",
  "tickets": {
    "_note": "Kept as written.",
    "port": 4747,
    "uiPort": 4748,
    "drafts": true${tickets}
  }
}`;

const PROJECT = `${JSON.stringify({ schema: 1, tracker: [{ key: "", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 1 } }], code: [{ key: "", repo: "a11ign/agent-org" }] }, null, 2)}\n`;

/** A folder with a host file (mode 600, as the real one is), a project declaration, a queue file and the options that name them. */
function setup(host = (dir: string) => hostWith(dir)) {
  const dir = tmpDir("settings-edit-");
  const hostPath = join(dir, "host.json");
  const projectPath = join(dir, "project.json");
  writeFileSync(hostPath, host(dir), { mode: 0o600 });
  chmodSync(hostPath, 0o600);
  writeFileSync(projectPath, PROJECT);
  const queuePath = join(dir, "queue.json");
  const options: EditOptions = { hostPath, projectPath, queuePath };
  return { dir, hostPath, projectPath, queuePath, options };
}

/** A file system that is the real one, except that it records each read and fails the call `fail` names. */
function seam(reads: string[] = [], fail: Partial<FileSystem> = {}): FileSystem {
  return { ...NODE_FS, readFile: (path) => { reads.push(path); return NODE_FS.readFile(path); }, ...fail };
}

const drafts = (value: boolean) => [{ key: "tickets.drafts", value }];

test("a valid save writes the one value, keeps every other byte, and first copies the old file to its backup at the same mode", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", drafts(false));
  assert.deepEqual(preview.changes.map(({ key, old, new: now, applies }) => ({ key, old, new: now, applies })), [{ key: "tickets.drafts", old: "true", new: "false", applies: "board" }]);
  await saveEdit(options, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] });
  assert.equal(readFileSync(hostPath, "utf8"), before.replace("\"drafts\": true", "\"drafts\": false"));
  assert.equal(readFileSync(`${hostPath}.bak`, "utf8"), before, "the backup holds the old bytes");
  assert.equal(statSync(hostPath).mode & 0o777, 0o600, "the file keeps its mode");
  assert.equal(existsSync(`${hostPath}.next`), false, "no temporary file is left");
});

test("a change made on a file that is already the same is a byte-equal copy", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", drafts(true));
  await saveEdit(options, "host.json", drafts(true), { base: preview.base });
  assert.equal(readFileSync(hostPath, "utf8"), before, "the file is byte-equal after a no-op save");
});

test("a save names the base the page read, and refuses when the file has changed since", async () => {
  const { hostPath, options } = setup();
  const preview = await previewEdit(options, "host.json", drafts(false));
  writeFileSync(hostPath, readFileSync(hostPath, "utf8").replace("\"_note\"", "\"_hand\": \"edited by hand\", \"_note\""));
  const edited = readFileSync(hostPath, "utf8");
  await assert.rejects(saveEdit(options, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] }), /the file changed since you looked: read it again/);
  assert.equal(readFileSync(hostPath, "utf8"), edited, "the hand edit is not overwritten");
});

test("a dangerous key is refused until its second confirmation names it, and the refusal says what it can break", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", drafts(false));
  assert.match(preview.changes[0].dangerous ?? "", /skips the Approve step/);
  await assert.rejects(saveEdit(options, "host.json", drafts(false), { base: preview.base }), /tickets\.drafts is dangerous and needs a second confirmation that names it\. It can break this: False opens each pull request ready/);
  assert.equal(readFileSync(hostPath, "utf8"), before, "nothing is written without the confirmation");
});

test("a value the readers refuse is not written, and the message names the field", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  writeFileSync(`${hostPath}.bak`, "an older backup");
  await assert.rejects(previewEdit(options, "host.json", [{ key: "tickets.port", value: "x" }]), (error: unknown) => error instanceof SettingsEditRefusal && /tickets\.port/.test(error.message));
  await assert.rejects(saveEdit(options, "host.json", [{ key: "tickets.port", value: "x" }], { base: "" }), /tickets\.port/);
  assert.equal(readFileSync(hostPath, "utf8"), before);
  assert.equal(readFileSync(`${hostPath}.bak`, "utf8"), "an older backup", "an existing backup is not touched by a refused save");
});

test("a port the reader refuses because it equals the other port is refused, naming tickets.uiPort", async () => {
  const { options } = setup();
  await assert.rejects(previewEdit(options, "host.json", [{ key: "tickets.uiPort", value: 4747 }]), /tickets\.uiPort/);
});

test("a pattern in tickets.deny that does not compile is refused, and a list changed as a whole is checked as a whole", async () => {
  const { options } = setup();
  await assert.rejects(previewEdit(options, "host.json", [{ key: "tickets.deny", value: [{ pattern: "(", reason: "no" }] }]), /tickets\.deny/);
});

test("a project key the reader refuses is refused, and the declaration is kept", async () => {
  const { projectPath, options } = setup();
  const before = readFileSync(projectPath, "utf8");
  await assert.rejects(previewEdit(options, "project.json", [{ key: "tracker", value: [] }]), /tracker/);
  assert.equal(readFileSync(projectPath, "utf8"), before);
});

test("a save of the project says the change is not committed, and the note is the one the page shows", async () => {
  const { projectPath, options } = setup();
  const preview = await previewEdit(options, "project.json", [{ key: "offerMilestones", value: ["v1"] }]);
  assert.equal(preview.note, PROJECT_NOTE);
  await saveEdit(options, "project.json", [{ key: "offerMilestones", value: ["v1"] }], { base: preview.base });
  assert.match(readFileSync(projectPath, "utf8"), /"offerMilestones": \[\s*"v1"\s*\]/);
  assert.equal(existsSync(`${projectPath}.bak`), true);
});

test("a failed backup writes nothing: the file keeps its bytes and no temporary file is left", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit({ ...options, fs: seam() }, "host.json", drafts(false));
  const failing = seam([], { copyFile: () => { throw new Error("the disk is full"); } });
  await assert.rejects(saveEdit({ ...options, fs: failing }, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] }), /the disk is full/);
  assert.equal(readFileSync(hostPath, "utf8"), before);
  assert.equal(existsSync(`${hostPath}.next`), false);
});

test("a failed replacement leaves the old bytes, the old mode and no temporary file", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", drafts(false));
  const failing = seam([], { rename: (from, to) => { if (to === hostPath) throw new Error("rename refused"); NODE_FS.rename(from, to); } });
  await assert.rejects(saveEdit({ ...options, fs: failing }, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] }), /rename refused/);
  assert.equal(readFileSync(hostPath, "utf8"), before, "the old file is intact");
  assert.equal(statSync(hostPath).mode & 0o777, 0o600);
  assert.equal(existsSync(`${hostPath}.next`), false, "the temporary file is removed");
});

test("a restore swaps the file and its backup, so a second restore undoes the first, and the restore shows what it changed", async () => {
  const { hostPath, options } = setup();
  const original = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", drafts(false));
  await saveEdit(options, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] });
  const saved = readFileSync(hostPath, "utf8");
  const restored = await restoreBackup(options, "host.json");
  assert.equal(readFileSync(hostPath, "utf8"), original, "the backup is back in place");
  assert.equal(readFileSync(`${hostPath}.bak`, "utf8"), saved, "the file it replaced is now the backup");
  assert.deepEqual(restored.changes.map(({ key, old, new: now }) => ({ key, old, new: now })), [{ key: "tickets.drafts", old: "false", new: "true" }]);
  await restoreBackup(options, "host.json");
  assert.equal(readFileSync(hostPath, "utf8"), saved, "a second restore undoes the first");
});

test("a restore with no backup says there is none, and a backup the readers refuse is not restored", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  await assert.rejects(restoreBackup(options, "host.json"), /there is no backup of host\.json to restore/);
  writeFileSync(`${hostPath}.bak`, hostWith("/nowhere").replace("\"port\": 4747", "\"port\": \"x\""));
  await assert.rejects(restoreBackup(options, "host.json"), /the backup is refused by the readers, so it is not restored: .*tickets\.port/);
  assert.equal(readFileSync(hostPath, "utf8"), before);
});

test("the exposure's UI port is in force after the units are reinstalled, tickets.max is in force after the board restarts, and not at all once the queue holds its own", async () => {
  const { options, queuePath } = setup((folder) => hostWith(folder, `, "providers": { "exposure": { "provider": "tailscale" } }`));
  const serve = await previewEdit(options, "host.json", [{ key: "tickets.providers.exposure.tailnetPorts", value: { ui: 9443, terminal: 9444 } }]);
  assert.equal(serve.changes[0].applies, "unit");
  assert.match(serve.changes[0].inForce, /reinstall and restart agent-org-ui\.service and agent-org-terminal\.service/, "the tailnet ports are read by the page and the terminal (A11-162 corrected the services the entry names)");
  const cli = await previewEdit({ ...options, plugins: true }, "host.json", [{ key: "tickets.providers.exposure.tailnetPorts", value: { ui: 9443, terminal: 9444 } }, { key: "tickets.providers.exposure.provider", value: "tailscale" }]);
  assert.deepEqual(cli.changes.map(({ inForce }) => inForce), Array(2).fill("in force after the instance, the page and the terminal restart: run `agent-org start instance`, `agent-org start ui` and `agent-org start terminal`."), "agent-org plugin names all three services of an exposure change");
  const max = await previewEdit(options, "host.json", [{ key: "tickets.max", value: 2 }]);
  assert.equal(max.changes[0].applies, "board");
  writeFileSync(queuePath, JSON.stringify({ entries: [], max: 4, paused: true }));
  const owned = await previewEdit(options, "host.json", [{ key: "tickets.max", value: 2 }]);
  assert.equal(owned.changes[0].applies, "none");
  assert.match(owned.changes[0].inForce, /not in force/);
});

test("a key file is named by its path and never read: the answers show the path and whether the file exists, and no read reaches a key file", async () => {
  const marker = "SECRET-MARKER-7f3a";
  const { dir, hostPath, options } = setup((folder) => hostWith(folder, `, "providers": { "tracker": { "provider": "linear", "key": { "path": "${join(folder, "old.key")}" } } }`));
  writeFileSync(join(dir, "old.key"), marker);
  writeFileSync(join(dir, "new.key"), marker);
  const reads: string[] = [];
  const counted = { ...options, fs: seam(reads) };
  const key = "tickets.providers.tracker.key.path";
  const preview = await previewEdit(counted, "host.json", [{ key, value: join(dir, "new.key") }]);
  const saved = await saveEdit(counted, "host.json", [{ key, value: join(dir, "new.key") }], { base: preview.base, confirmed: [key] });
  assert.match(preview.changes[0].new, /new\.key \(the file exists\)/);
  assert.equal(JSON.stringify([preview, saved]).includes(marker), false, "the marker is in no answer");
  assert.equal(reads.some((path) => path.endsWith(".key")), false, "no key file was read");
  assert.equal(JSON.parse(readFileSync(hostPath, "utf8")).tickets.providers.tracker.key.path, join(dir, "new.key"));
});

test("the keychain service name and a key file's contents cannot be changed from the page", async () => {
  const { options } = setup();
  await assert.rejects(previewEdit(options, "host.json", [{ key: "tickets.linearKey.keychain", value: "other" }]), /tickets\.linearKey\.keychain cannot be changed from this page/);
  await assert.rejects(previewEdit(options, "host.json", [{ key: "schema", value: 2 }]), /schema cannot be changed from this page/);
  await assert.rejects(previewEdit(options, "host.json", [{ key: "workers.haikuBrief", value: true }]), /workers\.haikuBrief cannot be changed from this page/);
  await assert.rejects(previewEdit(options, "host.json", [{ key: "not.a.key", value: 1 }]), /not\.a\.key is not a key this page describes in host\.json/);
});

test("a removal shows the built-in default in words, and the key is gone from the file", async () => {
  const { hostPath, options } = setup();
  const preview = await previewEdit(options, "host.json", [{ key: "tickets.drafts", remove: true }]);
  assert.equal(preview.changes[0].new, "the built-in default: true");
  await saveEdit(options, "host.json", [{ key: "tickets.drafts", remove: true }], { base: preview.base, confirmed: ["tickets.drafts"] });
  assert.equal("drafts" in JSON.parse(readFileSync(hostPath, "utf8")).tickets, false);
});

test("a save keeps prose keys, their order and the CRLF line ends of a file that has them", async () => {
  const { hostPath, options } = setup((dir) => hostWith(dir).replace(/\n/g, "\r\n"));
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit(options, "host.json", [{ key: "tickets.stallMinutes", value: 12 }]);
  await saveEdit(options, "host.json", [{ key: "tickets.stallMinutes", value: 12 }], { base: preview.base });
  const after = readFileSync(hostPath, "utf8");
  assert.equal(after, before.replace("\"drafts\": true\r\n", "\"drafts\": true,\r\n    \"stallMinutes\": 12\r\n"));
  assert.deepEqual(Object.keys(JSON.parse(after).tickets), ["_note", "port", "uiPort", "drafts", "stallMinutes"]);
});

test("a restore names a key that holds a dot, such as a repository called .github, with the value it had and the value it returns to", async () => {
  const { hostPath, options } = setup((folder) => hostWith(folder).replace("\"nbl-ui-netbox\": \"/r/netbox\"", "\"nbl-ui-netbox\": \"/r/netbox\", \".github\": \"/r/github\""));
  const change = [{ key: "clones..github", value: "/r/other" }];
  const preview = await previewEdit(options, "host.json", change);
  await saveEdit(options, "host.json", change, { base: preview.base, confirmed: ["clones..github"] });
  const restored = await restoreBackup(options, "host.json");
  assert.deepEqual(restored.changes.map(({ key, old, new: now }) => ({ key, old, new: now })), [{ key: "clones..github", old: "/r/other", new: "/r/github" }]);
});

test("a symbolic link to the host file is kept as a link, and the file it names is the one replaced, with its backup beside it", async () => {
  const { dir, hostPath, options } = setup();
  const link = join(dir, "link.json");
  symlinkSync(hostPath, link);
  const before = readFileSync(hostPath, "utf8");
  const preview = await previewEdit({ ...options, hostPath: link }, "host.json", drafts(false));
  await saveEdit({ ...options, hostPath: link }, "host.json", drafts(false), { base: preview.base, confirmed: ["tickets.drafts"] });
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is still a link");
  assert.equal(readFileSync(hostPath, "utf8"), before.replace("\"drafts\": true", "\"drafts\": false"));
  assert.equal(readFileSync(`${hostPath}.bak`, "utf8"), before);
});

test("the page's refusal and a save's refusal of the same file are the same words", async () => {
  const { dir, hostPath, projectPath, queuePath } = setup((folder) => hostWith(folder).replace("\"port\": 4747", "\"port\": \"x\""));
  const settings = parseTicketSettings(JSON.parse(hostWith(dir)));
  const view = await readSettingsView({ hostPath, projectPath, settings, queuePath, queueMax: 3, choicePath: join(dir, "choice.json"), pluginRecord: join(dir, "none.json") });
  const shown = view.refusals.find((refusal) => refusal.file === "host.json (tickets)")?.message;
  assert.ok(shown, "the page refuses the tickets block");
  const preview = await previewEdit({ hostPath, projectPath, queuePath }, "host.json", drafts(false)).catch((error: Error) => error);
  assert.ok(preview instanceof SettingsEditRefusal);
  assert.equal(preview.message, shown);
});

// A11-158: a plugin's block, its `provider` and its `enabled` are read-only on the Settings page, and `agent-org plugin` alone may write them.
const ENABLED = [{ key: "tickets.providers.reviewer.enabled", value: false }, { key: "tickets.providers.reviewer.provider", value: "atomic" }];

test("A11-158: the page cannot change a plugin's provider or `enabled`, and a save with the plugin option can, through the same checks", async () => {
  const { hostPath, options } = setup();
  await assert.rejects(previewEdit(options, "host.json", ENABLED), /tickets\.providers\.reviewer\.enabled cannot be changed from this page: changed with agent-org plugin enable or disable/);
  await assert.rejects(previewEdit(options, "host.json", [{ key: "tickets.providers.reviewer.provider", value: "atomic" }]), /tickets\.providers\.reviewer\.provider cannot be changed from this page/);
  const forPlugins: EditOptions = { ...options, plugins: true };
  const preview = await previewEdit(forPlugins, "host.json", ENABLED);
  const saved = await saveEdit(forPlugins, "host.json", ENABLED, { base: preview.base });
  assert.deepEqual(JSON.parse(readFileSync(hostPath, "utf8")).tickets.providers.reviewer, { enabled: false, provider: "atomic" });
  assert.match(readFileSync(hostPath, "utf8"), /"_note": "Kept as written\."/, "the person's notes are kept");
  assert.equal(readFileSync(saved.backup, "utf8").includes("providers"), false, "the backup is the file as it was");
});

test("A11-158: the plugin option writes only plugin keys: any other key the page keeps read-only is still refused", async () => {
  const { options } = setup();
  const forPlugins: EditOptions = { ...options, plugins: true };
  await assert.rejects(previewEdit(forPlugins, "host.json", [{ key: "schema", value: 2 }]), /schema cannot be changed from this page/);
  await assert.rejects(previewEdit(forPlugins, "host.json", [{ key: "tickets.linearKey.keychain", value: "other" }]), /tickets\.linearKey\.keychain cannot be changed from this page/);
});

test("A11-158: the plugin option still refuses a value the readers refuse, and writes nothing", async () => {
  const { hostPath, options } = setup();
  const before = readFileSync(hostPath, "utf8");
  await assert.rejects(previewEdit({ ...options, plugins: true }, "host.json", [{ key: "tickets.providers.tracker.provider", value: "linear" }, { key: "tickets.providers.tracker.enabled", value: false }]), /linear is the only tracker/);
  assert.equal(readFileSync(hostPath, "utf8"), before);
});

test("A11-162: the project's messaging key is judged for agent-org plugin's writes only: the page's other saves of project.json are as they were", async () => {
  const { options, projectPath } = setup(() => hostWith("/nowhere"));
  const broken = JSON.parse(readFileSync(projectPath, "utf8"));
  writeFileSync(projectPath, `${JSON.stringify({ ...broken, messaging: { provider: "telegram", tokenFile: "/etc/shadow", chairmanFile: "/etc/shadow" } })}\n`);
  const page = await previewEdit(options, "project.json", [{ key: "offerMilestones", value: ["v1"] }]);
  assert.equal(page.changes[0].key, "offerMilestones", "a key the page changes is saved whatever the messaging key says");
  await assert.rejects(previewEdit({ ...options, plugins: true }, "project.json", [{ key: "messaging.enabled", value: false }]), /messaging\.tokenFile: .*is not a file under ~\/\.config\/agent-org\//, "and the plugin command's write is judged by the messaging reader");
});
