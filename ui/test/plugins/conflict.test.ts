import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionRequestOf, runAction } from "../../../src/plugins/page-actions.ts";
import { defaultCatalog } from "../../../src/plugins/registry.ts";
import { baseOf } from "../../../src/ticket-mode/settings-edit.ts";
import { CONFLICT_SENTENCE, isConflict } from "../../src/settings/settings-model.ts";

// THE PAGE TELLS A FILE THAT CHANGED FROM A REFUSAL BY ITS SENTENCE, because `runAction` refuses both as a command refusal and the client's answer carries only the sentence. The backend is not changed
// for this page, so this holds the sentence the page keeps to the one `writePlan` throws for a stale `base`: if the backend's words change, this fails and the page is changed with them.
const HOST = { clones: { "nbl-ui-netbox": "/r/netbox" }, tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } } } };

describe("the conflict sentence of a plugin action", () => {
  it("is the sentence runAction refuses an action with when the host file changed since the page read it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugins-conflict-"));
    try {
      const hostPath = join(dir, "host.json");
      const text = JSON.stringify({ ...HOST, stateDir: join(dir, "state") }, null, 2);
      writeFileSync(hostPath, `${text}\n`, { mode: 0o600 });
      const base = await baseOf({ hostPath }, "host.json");
      writeFileSync(hostPath, `${text.replace("5000", "5001")}\n`, { mode: 0o600 });
      const deps = { hostPath, catalog: defaultCatalog(), log: () => undefined, error: () => undefined };
      const refusal = await runAction(actionRequestOf({ action: "disable", name: "tailscale", base, confirmed: false }), deps).catch((error: unknown) => error);
      expect((refusal as Error).message).toBe(CONFLICT_SENTENCE);
      expect(isConflict((refusal as Error).message)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is told from the other refusals of an action", () => {
    expect(isConflict("uninstall tailscale needs the person's confirmation first: ask again with it")).toBe(false);
    expect(isConflict("linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled")).toBe(false);
  });
});
