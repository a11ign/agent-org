The Settings page edits a value the schema describes in `host.json` (its `tickets` block included) or in the primary project's `.agent-org/project.json`. A change is spliced into the file's text (`json-edit.ts`), and the new text is checked by the same readers that load the file (`settings-verdict.ts`, which `settings-read.ts` now uses too). A value they refuse is not written, and the page shows the reader's message, which names the field. Before a save the page shows each key's old and new value, its in-force sentence, and asks to confirm; a dangerous key needs its own second button, which names the key and what it can break. A save copies the file to `<file>.bak` first and replaces it in one step. Restore swaps the file and its backup. A secret's path can be changed, its contents never read. The three routes sit beside `POST /api/choice`, and a remote instance's edit is refused by the proxy and offers no control on the page.

Acceptance:
```bash
test -n "$AGENT_ORG_HOST" || { echo "set AGENT_ORG_HOST to a host declaration whose primary checkout is a project, as CI's suite job does"; exit 1; }
pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/json-edit.test.ts src/ticket-mode/settings-edit.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/settings-view.test.ts src/ticket-mode/server.test.ts src/ticket-mode/remote-proxy.test.ts src/ticket-mode/ui.test.ts src/ticket-mode/settings.test.ts src/packaging/project-config.test.ts
npm run typecheck
npm run lint
# The copy check: a COPY of the host declaration, never the file itself. A no-op save is byte-equal, a one-value save differs in one line, and the restore is byte-equal again.
copy="$(mktemp -d)"; trap 'rm -rf "$copy"' EXIT
cp "$AGENT_ORG_HOST" "$copy/host.json"; cp "$AGENT_ORG_HOST" "$copy/original.json"
COPY="$copy" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const { previewEdit, saveEdit, restoreBackup } = await import(`${process.cwd()}/src/ticket-mode/settings-edit.ts`);
const { COPY: dir } = process.env;
const hostPath = `${dir}/host.json`;
const same = (a, b) => { try { execFileSync("cmp", ["-s", a, b]); return true; } catch { return false; } };
const current = JSON.parse(readFileSync(hostPath, "utf8")).tickets?.drafts;
if (typeof current !== "boolean") throw new Error("the declaration must hold tickets.drafts as true or false");
const noop = await previewEdit({ hostPath }, "host.json", [{ key: "tickets.drafts", value: current }]);
await saveEdit({ hostPath }, "host.json", [{ key: "tickets.drafts", value: current }], { base: noop.base });
if (!same(hostPath, `${dir}/original.json`)) throw new Error("the no-op save is not byte-equal");
const flipped = !current;
const change = await previewEdit({ hostPath }, "host.json", [{ key: "tickets.drafts", value: flipped }]);
await saveEdit({ hostPath }, "host.json", [{ key: "tickets.drafts", value: flipped }], { base: change.base, confirmed: ["tickets.drafts"] });
const diff = (() => { try { execFileSync("diff", [`${dir}/original.json`, hostPath]); return ""; } catch (error) { return String(error.stdout); } })();
if (diff.split("\n").filter((line) => /^[<>]/.test(line)).length !== 2) throw new Error("the change is not one line");
await restoreBackup({ hostPath }, "host.json");
if (!same(hostPath, `${dir}/original.json`)) throw new Error("the restore is not byte-equal");
console.log("copy check: no-op byte-equal, one line changed, restore byte-equal");
'
```

Consumer-declaration: none -- no reader's validation changes and no key means anything different; the three `/api/settings/` routes are new and sit behind the instance's key, and the read-only `GET /api/settings` is unchanged.
