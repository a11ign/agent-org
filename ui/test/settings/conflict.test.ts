import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewEdit, saveEdit, SettingsEditRefusal } from "../../../src/ticket-mode/settings-edit.ts";
import { CONFLICT_SENTENCE, isConflict } from "../../src/settings/settings-model.ts";

// THE PAGE TELLS A FILE THAT CHANGED FROM A REFUSAL BY ITS SENTENCE, because the backend refuses both the same way (`SettingsEditRefusal`) and the client's answer carries only the sentence.
// The backend is not changed for this page, so this holds the sentence the page keeps to the one `saveEdit` throws: if the backend's words change, this fails and the page is changed with them.
const HOST = `{ "clones": { "nbl-ui-netbox": "/r/netbox" }, "stateDir": "STATE", "tickets": { "port": 4747, "uiPort": 4748, "drafts": true } }\n`;

describe("the conflict sentence", () => {
  it("is the sentence saveEdit refuses a save with when the file changed since the page read it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-conflict-"));
    try {
      const hostPath = join(dir, "host.json");
      writeFileSync(hostPath, HOST.replace("STATE", join(dir, "state")), { mode: 0o600 });
      const options = { hostPath, projectPath: join(dir, "project.json"), queuePath: join(dir, "queue.json") };
      const changes = [{ key: "tickets.drafts", value: false }];
      const preview = await previewEdit(options, "host.json", changes);
      writeFileSync(hostPath, HOST.replace("STATE", join(dir, "state")).replace("4747", "4749"), { mode: 0o600 });
      const refusal = await saveEdit(options, "host.json", changes, { base: preview.base, confirmed: ["tickets.drafts"] }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(SettingsEditRefusal);
      expect((refusal as Error).message).toBe(CONFLICT_SENTENCE);
      expect(isConflict((refusal as Error).message)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is told from any other refusal of a save", async () => {
    expect(isConflict("tickets.drafts is dangerous and needs a second confirmation that names it. It can break this: x")).toBe(false);
    expect(isConflict("")).toBe(false);
  });
});
