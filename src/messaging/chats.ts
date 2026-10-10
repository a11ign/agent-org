// `messaging:chats` (a11ign/a11ign#4743, #928 row 5 of 5): WHICH CHATS THE LISTENER HAS SEEN THE BOT PUT IN, so the id of the chairman's announcements
// channel is read ON THE HOST with no token in sight. The listener is the only `getUpdates` caller there can be (a second one is a 409), so it writes a
// `chat-seen` line for each chat (`inbound.ts`), and this reads them back.
//
//   pnpm run messaging:chats          <chat id><TAB><type>, one chat per line, in the order first seen
//
// **IT NEVER TOUCHES THE CONFIGURATION.** It reads the ledger and nothing else: not the `messaging` key, not the token file, not its path. There is
// no route from the secret to this output for a later edit to find, which is a stronger claim than "it is scrubbed", and `chats.test.ts` pins it by
// what this file imports. It prints the id and the type and not the title: a title is the chat's own text, and the chairman knows the channel's name.
//
// EXIT CODES, as `messaging:measure`'s: 0 listed (or nothing seen yet, said plainly), 1 the ledger could not be read, 2 refused (an argument).

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { chatsSeen } from "./inbound.ts";
import { describeError, readLedgerLines } from "./ledger.ts";
import { defaultLedgerPath } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });

/** What an empty list says: it is "not yet", not "never", and the listener has to be running for either to change. */
export const NONE_SEEN = "no chat has been seen yet: add the bot to the channel as an administrator and post one message, with `messaging:listen` running";

/** `home` is injected so a test owns the ledger. Returns the exit code. */
export function main(argv: string[], { home = homedir(), out = (line: string) => console.log(line), err = (line: string) => console.error(line) }: {
        home?: string; out?: (line: string) => void; err?: (line: string) => void;
    } = {}): number {
  try {
    parseArgs({ args: argv, allowPositionals: false, options: {} });
  } catch (error) {
    err(`messaging:chats: ${describeError(error)} (it takes no arguments)`);
    return EXIT.refused;
  }
  try {
    const chats = chatsSeen(readLedgerLines(defaultLedgerPath(home)));
    for (const line of chats.length === 0 ? [NONE_SEEN] : chats.map((chat) => `${chat.chatId}\t${chat.type}`)) out(line);
    return EXIT.ok;
  } catch (error) {
    err(`messaging:chats: ${describeError(error)}`);
    return EXIT.failed;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
