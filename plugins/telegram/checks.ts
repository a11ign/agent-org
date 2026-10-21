// @ts-check
// module: the Telegram plugin's doctor checks (A11-162) -- the token file is readable by no one else, and the chairman has paired
//
// They are what `messaging:check` checks (`src/messaging/check.ts`): the files' permissions are judged from the open descriptor before a byte is read (`secretFileProblem`), nothing is
// fetched, and no content is ever printed, so the worst a row says is a path, a mode and an owner. A chairman file that does not exist is not a failure: the pairing command writes it,
// and a check that failed before the chairman had paired would be red on the day the feature is first configured. The row says so and names the command.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

const isPath = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The rows of the Telegram messaging plugin, for the paths its settings name. */
export function telegramChecks(settings: PluginSettings, deps: Pick<PluginDeps, "messaging" | "mode">): PluginCheck[] {
  const { tokenFile, chairmanFile } = settings;
  const { secretFileProblem } = deps.messaging;
  if (!isPath(tokenFile) || !isPath(chairmanFile)) {
    return [failed("telegram settings", "the messaging key names no tokenFile or no chairmanFile", "set messaging.tokenFile and messaging.chairmanFile in project.json: `agent-org plugin config telegram tokenFile=<path> chairmanFile=<path>`")];
  }
  const token = secretFileProblem(tokenFile);
  const rows = [token === null ? ok("telegram token file", `${tokenFile} is readable by no one else (mode 0600, owned by the running user)`)
    : failed("telegram token file", token, `put the bot's token alone in ${tokenFile} with mode 600 (chmod 600 ${tokenFile})`)];
  if (deps.mode(chairmanFile) === null) {
    rows.push(ok("telegram chat", `NOT YET PAIRED: ${chairmanFile} is absent, and the pairing command writes it: run \`agent-org messaging:pair\``));
    return rows;
  }
  const chairman = secretFileProblem(chairmanFile);
  rows.push(chairman === null ? ok("telegram chat", `paired: ${chairmanFile} is readable by no one else`)
    : failed("telegram chat", chairman, `chmod 600 ${chairmanFile}, or pair again with \`agent-org messaging:pair\``));
  return rows;
}
