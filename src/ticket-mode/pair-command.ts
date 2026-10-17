#!/usr/bin/env node
// @ts-check
// command: ticket:pair -- print a one-time code that pairs a browser with the running board page (`ticket:ui`)
//
// The board key stays in its file. This reads the key, asks the page's service on this machine for a code, and prints the code, which a
// person types into its pairing page. A code works once, within ten minutes.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKeyPath, readBoardKey } from "./board-key.ts";
import { readTicketSettings, type TicketSettings } from "./settings.ts";

/** A new pairing code from the page's service `settings` names. REFUSES when it is not running, or does not take this machine's key. */
export async function pairingCode(settings: TicketSettings, request: typeof fetch = fetch): Promise<{ code: string; minutes: number }> {
  const key = readBoardKey(boardKeyPath(settings.stateDir));
  const url = `http://127.0.0.1:${settings.uiPort}/api/pair-code`;
  let response: Response;
  try {
    response = await request(url, { method: "POST", headers: { "x-ticket-token": key } });
  } catch {
    throw new Error(`no board page answers on 127.0.0.1:${settings.uiPort}: start it with agent-org ticket:ui`);
  }
  if (!response.ok) throw new Error(`the server on 127.0.0.1:${settings.uiPort} refused (${response.status}): it may be another machine's, or an older agent-org's`);
  return await response.json() as { code: string; minutes: number };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags([], { entry: import.meta.url, command: "agent-org ticket:pair" });
  const settings = readTicketSettings();
  pairingCode(settings).then(({ code, minutes }) => {
    process.stdout.write(`${code}\n  type it into http://127.0.0.1:${settings.uiPort}/ within ${minutes} minutes. It works once.\n`);
  }, (err) => {
    process.stderr.write(`ticket:pair: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
