// @ts-check
// module: the instance's request for a worker terminal's pairing code, for a paired browser that follows a worker link (A11-93)
//
// THE SAME CALL THE PLUGIN'S OWN `pair` MAKES, from the same place: this process, on the terminal's machine, over loopback with no proxy headers,
// which herdr web ui takes as "this PC" (its `decideAccess`). Its token, when one is set, is read from the plugin's config directory, as the plugin
// reads it, and sent as a bearer. Neither the code nor the token is logged, returned, or put in a thrown message: a failure is a note, and the
// link then goes out plain, which is today's behaviour. The mint is an optimisation, never a requirement.
import { join } from "node:path";
import { pluginConfigDir } from "../install/terminal.ts";
import type { TicketSettings } from "./settings.ts";

/** A terminal pairing code, or the reason there is none. */
export type TerminalMint = Readonly<{ code: string; note?: undefined }> | Readonly<{ code: null; note: string }>;

export type MintDeps = Readonly<{
  home: string;
  /** The text of a file in the plugin's config directory, or null when it is absent. */
  read: (path: string) => string | null;
  request: typeof fetch;
  /** How long herdr web ui may take to answer before the link goes out plain. */
  timeoutMs: number;
}>;

/** A pairing code is six digits, as herdr web ui's `pair` prints it. Anything else is refused, so the link goes out plain. */
const CODE = /^\d{6}$/;

/**
 * The bearer token herdr web ui's `pair` reads: `HERDR_WEB_TOKEN` from `env`, then from `.env`, where a later file wins, as the plugin merges them.
 * An empty value means no token. PURE over `read`.
 */
export function pluginToken(configDir: string, read: (path: string) => string | null): string | null {
  let token: string | undefined;
  for (const name of ["env", ".env"]) {
    const text = read(join(configDir, name));
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed.length === 0 || trimmed.startsWith("#") || eq <= 0) continue;
      if (trimmed.slice(0, eq).trim() === "HERDR_WEB_TOKEN") token = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return token === undefined || token === "" ? null : token;
}

/**
 * A code for the worker terminal on `port`, this machine's own (`localTerminalPort`). `{ code: null, note }` when there is no such port, which
 * `settings` says is `tickets.terminal` absent or another machine's, or the terminal does not answer, refuses, answers something else, or is too
 * slow. NEVER throws.
 */
export async function mintTerminalCode(settings: TicketSettings, port: number | null, deps: MintDeps): Promise<TerminalMint> {
  if (port === null) return { code: null, note: settings.terminal === null ? "tickets.terminal is not set" : "tickets.terminal is served by another machine" };
  const token = pluginToken(pluginConfigDir(deps.home, settings.herdrSession), deps.read);
  const headers: Record<string, string> = { "content-type": "application/json", "x-herdr-machine": "1" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  let answer: Response;
  try {
    answer = await deps.request(`http://127.0.0.1:${port}/api/devices/pair/start`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch {
    return { code: null, note: `the worker terminal did not answer on 127.0.0.1:${port}` };
  }
  if (!answer.ok) return { code: null, note: `the worker terminal refused a pairing code (${answer.status})` };
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    return { code: null, note: "the worker terminal answered with something that is not JSON" };
  }
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" && CODE.test(code) ? { code } : { code: null, note: "the worker terminal's answer names no pairing code" };
}
