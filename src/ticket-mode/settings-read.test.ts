// no-token: gh -- reads temporary host and project files written by the test, and runs the real project reader on them; nothing outside the temporary folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { readSettingsView, type SettingsReadOptions } from "./settings-read.ts";
import type { View } from "./settings-view.ts";

/** The options a page read needs, with the files the test writes in one temporary folder. */
function options(dir: string, hostPath: string, extra: Partial<SettingsReadOptions> = {}): SettingsReadOptions {
  return { hostPath, settings: parseTicketSettings({ clones: { r: "/r" }, stateDir: dir }), queuePath: join(dir, "queue.json"), queueMax: 3, choicePath: join(dir, "choice.json"), ...extra };
}
const rowsIn = (view: View) => view.groups.flatMap((group) => group.rows);
const NO_PROJECT = /declares no project/;

/** A host file that names a primary project, so the machine is not a ticket-only one. */
function primaryHost(dir: string): string {
  const path = join(dir, "host.json");
  writeFileSync(path, JSON.stringify({ schema: 1, home: dir, binDir: join(dir, "bin"), primary: "app", projects: [{ id: "app", checkout: join(dir, "app") }],
    clones: { r: "/r" }, stateDir: dir, gh: { workers: join(dir, "w"), leads: join(dir, "l"), leadsHeader: [], leadsWorkspaces: [] }, tickets: {} }));
  return path;
}

test("a project the readers cannot resolve is a refusal of the project, not the note that no project is declared", async () => {
  const dir = tmpDir("settings-read-unresolved-");
  const view = await readSettingsView(options(dir, primaryHost(dir), {
    loadProject: async () => { throw new Error("ticket mode: `AGENT_ORG_HOST` REFUSED: the project cannot be resolved"); },
  }));
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json").map((r) => r.message), ["ticket mode: `AGENT_ORG_HOST` REFUSED: the project cannot be resolved"]);
  assert.equal(view.notes.some((note) => NO_PROJECT.test(note)), false, "the failure is not reported as a machine with no project");
});

test("a project declaration that is read and refused names its field, and the rest of the page still draws", async () => {
  const dir = tmpDir("settings-read-refused-");
  const project = join(dir, "project.json");
  writeFileSync(project, JSON.stringify({ schema: 1, tracker: [], code: [{ key: "", repo: "owner/app" }] }));
  const view = await readSettingsView(options(dir, primaryHost(dir), { projectPath: project }));
  assert.equal(view.refusals.find((r) => r.file === "project.json")?.message.includes("`tracker`"), true, "the refusal names the field");
  assert.ok(rowsIn(view).some((row) => row.key === "tickets.max"), "the ticket keys still draw");
});

test("a valid project declaration draws its keys from the file as it is", async () => {
  const dir = tmpDir("settings-read-valid-");
  const project = join(dir, "project.json");
  writeFileSync(project, JSON.stringify({ schema: 1, tracker: [{ key: "", repo: "owner/app", board: { owner: "owner", number: 1 } }], code: [{ key: "", repo: "owner/app" }] }));
  const view = await readSettingsView(options(dir, primaryHost(dir), { projectPath: project }));
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json"), []);
  const tracker = rowsIn(view).find((row) => row.key === "tracker");
  assert.deepEqual([tracker?.file, tracker?.source, tracker?.state], ["project.json", "project.json", "enabled"]);
});

test("a ticket-only host, which names no primary, is a note that it declares no project, and no refusal", async () => {
  const dir = tmpDir("settings-read-ticket-only-");
  const path = join(dir, "host.json");
  writeFileSync(path, JSON.stringify({ clones: { r: "/r" }, stateDir: dir, tickets: { max: 2 } }));
  const view = await readSettingsView(options(dir, path));
  assert.equal(view.notes.some((note) => NO_PROJECT.test(note)), true);
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json"), []);
});
