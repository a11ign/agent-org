#!/usr/bin/env node
// @ts-check
// command: ticket:remote-info -- print this instance's port, key and terminal address as JSON, for another machine's `ticket:ui` that runs it over ssh
//
// THE KEY GOES ONLY TO A PIPE. Another machine's `ticket:ui` runs `ssh <this machine> agent-org ticket:remote-info` and reads the JSON from stdout,
// so the key travels inside the SSH connection and lands in that service's memory. A person who runs this in a terminal would put the key on their
// screen, so it refuses when stdout is a terminal.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKeyPath, readBoardKey } from "./board-key.ts";
import type { RemoteInfo } from "./remote.ts";
import type { TicketSettings } from "./settings.ts";
import { readTicketSettings } from "./settings.ts";

/** What this machine's board answers as, for another board to reach it. REFUSES when stdout is a terminal, and when the board has no key yet. */
export function remoteInfo(settings: TicketSettings, toTerminal: boolean, readKey: (path: string) => string = readBoardKey): RemoteInfo {
  if (toTerminal) throw new Error("this prints the board's key for another machine's board to read over ssh, so it refuses to print it to a terminal");
  return { port: settings.port, key: readKey(boardKeyPath(settings.stateDir)), terminal: settings.terminal };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags([], { entry: import.meta.url, command: "agent-org ticket:remote-info" });
  try {
    process.stdout.write(`${JSON.stringify(remoteInfo(readTicketSettings(), process.stdout.isTTY === true))}\n`);
  } catch (err) {
    process.stderr.write(`ticket:remote-info: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  }
}
