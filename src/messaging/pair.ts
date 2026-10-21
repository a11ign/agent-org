// `messaging:pair` (a11ign/a11ign#2902; docs/messaging.md decision 1, "Secret by reference only"): THE ONLY WAY THE CHAIRMAN'S IDS GET INTO THE CHAIRMAN FILE. The command is the core's; the step
// that talks to the provider (a one-time code the chairman sends the bot, the first sender that proves it) is the plugin's `pair` (A11-162, messaging contract 1.1), which this loads from
// the registry by the name `messaging.provider` gives. A provider that offers no `pair` is refused by name, not guessed at.
//
// THE FLAGS ARE READ BEFORE ANYTHING ELSE (a11ign/agent-org#513): `--help` once started the poll, and Telegram answered the listener's next `getUpdates` with a 409. Strict, so a flag this
// command does not have is refused by name and never ignored.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { loadMessagingModule, messagingPluginDeps } from "./plugin.ts";

export const EXIT = Object.freeze({ paired: 0, notPaired: 1, refused: 2 });

export const USAGE = [
  "usage: messaging:pair [--root=<dir>]",
  "  Prints a one-time code; send `/pair <code>` to the bot from your private chat with it within 10 minutes, and the chairman file is written.",
  "  --root=<dir>  the project root (default: the current directory)",
  "  -h, --help    print this and exit: nothing is read and no request is made",
].join("\n");

function readFlags(argv: string[]): { help: boolean; root: string; } | { refusal: string; } {
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: "string" }, help: { type: "boolean", short: "h" } } });
    return { help: values.help === true, root: values.root ?? process.cwd() };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { refusal: error.message };
  }
}

/** The exit code: 0 paired, 1 not, 2 refused to start (a flag it does not have). */
export async function main(argv: string[], { fetch: fetchImpl, home, out = (line) => { process.stdout.write(`${line}\n`); }, err = (line) => { process.stderr.write(`${line}\n`); }, importModule }: {
  fetch?: typeof fetch; home?: string; out?: (line: string) => void; err?: (line: string) => void; importModule?: (url: string) => Promise<unknown>;
} = {}): Promise<number> {
  const flags = readFlags(argv);
  if ("refusal" in flags) {
    err(`messaging:pair: ${flags.refusal}\n${USAGE}`);
    return EXIT.refused;
  }
  if (flags.help) {
    out(USAGE);
    return EXIT.paired;
  }
  try {
    const config = readMessagingConfig(flags.root, { home });
    if (!config.enabled) {
      out("messaging: OFF (no `messaging` key in .agent-org/project.json); there is nothing to pair");
      return EXIT.notPaired;
    }
    const { module } = await loadMessagingModule(config.provider, { importModule });
    if (module.pair === undefined) {
      err(`messaging:pair: the messaging plugin ${config.provider} offers no pairing: its chairman file is written another way`);
      return EXIT.notPaired;
    }
    return await module.pair({ tokenFile: config.tokenFile, chairmanFile: config.chairmanFile, print: out }, messagingPluginDeps({ fetch: fetchImpl, home, log: err })) === 0 ? EXIT.paired : EXIT.notPaired;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`messaging:pair: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${error.message}`);
    return EXIT.notPaired;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
