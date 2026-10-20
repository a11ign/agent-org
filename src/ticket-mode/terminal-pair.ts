// @ts-check
// module: the instance's request for a worker terminal's pairing code, for a paired browser that follows a worker link (A11-93)
//
// THE SAME CALL THE PLUGIN'S OWN `pair` MAKES, from the same place: this process, on the terminal's machine, over loopback with no proxy headers,
// which herdr web ui takes as "this PC" (its `decideAccess`). Its token, when one is set, is read from the plugin's config directory, as the plugin
// reads it, and sent as a bearer. Neither the code nor the token is logged, returned, or put in a thrown message: a failure is a note, and the
// link then goes out plain, which is today's behaviour. The mint is an optimisation, never a requirement.
import { join } from "node:path";
import { pluginConfigDir } from "../install/terminal.ts";
import { escapeRegExp } from "../lib/escape-regexp.ts";
import { type Queue, writerStatus } from "./queue/queue-entries-and-outcomes.ts";
import type { TicketSettings } from "./settings.ts";

/*
 * A RUN'S TERMINAL LINK (A11-129). A worker link whose run has ended says so, rather than redirecting to a terminal that is gone (herdr web ui's page
 * spins there). The board answers that from its own record: which run held the workspace and pane the link names, and whether it still does.
 */

/** The values a worker terminal's link carries: the workspace, pane and key of the run it opens, as `terminalLink` wrote them into the template. */
export type TerminalValues = Readonly<{ workspace?: string; pane?: string; key?: string }>;

/** What the board holds for a worker terminal's link: `live` while a run's agent is in it, `ended` with the run it was, or `unknown` for none. */
export type TerminalRun = Readonly<{ state: "live" | "unknown" }>
  | Readonly<{ state: "ended"; outcome: "failed" | "finished"; run: string; kind: "ticket" | "writer" | "publish"; reason?: string }>;

/** The workspace and pane a link names, when it names both, else null. PURE. */
const placeOf = (values: TerminalValues | null): Readonly<{ workspace: string; pane: string }> | null =>
  values?.workspace === undefined || values.pane === undefined ? null : { workspace: values.workspace, pane: values.pane };

/** A run that has ended, with its reason when it has one. */
const ended = (outcome: "failed" | "finished", run: string, kind: "ticket" | "writer" | "publish", reason: string | undefined): TerminalRun =>
  ({ state: "ended", outcome, run, kind, ...(reason === undefined ? {} : { reason }) });

/**
 * The values a link carries when it is `template` with each `{workspace}`, `{pane}` and `{key}` filled in, or null when it is not that address. Each value
 * is read as `terminalLink` encoded it, so one that cannot be decoded is not the address either. PURE.
 */
export function runOfTerminalLink(template: string, link: string): TerminalValues | null {
  const parts = template.split(/\{(workspace|pane|key)\}/);
  const literals = parts.filter((_, i) => i % 2 === 0);
  const names = parts.filter((_, i) => i % 2 === 1);
  const matched = new RegExp(`^${literals.map(escapeRegExp).join("([^&#/?]*)")}$`).exec(link);
  if (matched === null) return null;
  try {
    return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(matched[i + 1])]));
  } catch {
    return null;
  }
}

/**
 * The run that holds the terminal a link names: `live` when a run's agent is in it now (a ticket run, parked or running; a new-ticket run or a publish run
 * while it runs), `ended` with the run it was when that run has ended, and `unknown` for a link no run holds, or one that is not the template's address.
 * A run that holds it now is live, whatever a run that held it before says. PURE.
 */
export function terminalRunOf(queue: Queue, template: string, link: string): TerminalRun {
  const place = placeOf(runOfTerminalLink(template, link));
  if (place === null) return { state: "unknown" };
  const held = (other: Readonly<{ workspace?: string; pane?: string }> | undefined): boolean => other?.workspace === place.workspace && other?.pane === place.pane;
  const writers = queue.writers ?? [];
  const runningHere = (run: Readonly<{ phase: string; workspace?: string; pane?: string }> | undefined): boolean => run?.phase === "running" && held(run);
  if (queue.entries.some(held) || [...writers, queue.publish].some(runningHere)) return { state: "live" };
  const writer = writers.find((run) => run.phase !== "running" && held(run));
  if (writer !== undefined) return ended(writerStatus(writer) === "failed" ? "failed" : "finished", writer.id, "writer", writer.failure);
  const entry = queue.entries.find((e) => held(e.lastTerminal));
  if (entry !== undefined) return ended(entry.outcome?.kind === "crashed" ? "failed" : "finished", entry.ticket.key, "ticket", entry.outcome && "reason" in entry.outcome ? entry.outcome.reason : undefined);
  if (queue.publish !== undefined && held(queue.publish.lastTerminal)) return ended(queue.publish.failure === undefined ? "finished" : "failed", queue.publish.id, "publish", queue.publish.failure);
  return { state: "unknown" };
}

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
