// @ts-check
// module: a role declared `github-apps` that makes calls and never as its app is a LEDGER INCIDENT, class `app-role-silent` (agent-org#790, parent a11ign/a11ign#4900)
//
// MEASURED 2026-10-10 (a11ign#4906): the switch merged at 22:18:30Z, the installed wrapper had been rendered at 22:05Z, so `app_declared()` was empty and every call went to the shared
// account until a session re-ran `host:install` at 22:20Z. `host:check` said `gh: DIVERGED` throughout and nothing read it. The tick now re-renders that one file
// (`rerenderGhWrapper`, host-units.ts); this is the detector for the case where it STILL does not take effect: a mint that fails (the fallback is the shared account, by design), a key
// that cannot be read, an app nobody installed. The wrapper writes the account a call acted as, and `app:<role>` when it acted as the app, so "declared and silent" is a reading of its ledger.
//
// PURE, AND A LEAF (`gh-ledger.ts`'s line parser and the failure ledger's event type): ledger text, the declared roles and the clock in, roles out. THE CALLER READS THE FILES AND WRITES THE EVENT.
//
// THE QUESTION IS "CALLS IN THE WINDOW, AND NONE OF THEM AS THE APP". A role that made no call in the window is NOT an incident (nothing to be silent about), and neither is a ledger nobody could read:
// both are an empty list here, which is `silent: []` and not "every role is fine" -- the caller says an unreadable ledger on its own channel.
import { parseLine, type LedgerEntry } from "./gh-ledger.ts";
import type { GithubRole } from "./app-token.ts";
import type { FailureEvent } from "./failure-ledger.ts";

/** The failure-ledger class key, an event kind like `main-red` (the ledger's keys are event kinds, not `failure-classes.json`'s row-defect ids). */
export const APP_ROLE_SILENT = "app-role-silent";

/** THE ROW'S FIGURE: a declared role that made calls for this long and never as its app. Named so the test's boundary cases and the caller read one number. */
export const APP_ROLE_SILENT_MINUTES = 10;
export const APP_ROLE_SILENT_MS = APP_ROLE_SILENT_MINUTES * 60_000;

/**
 * One ledger file as the caller read it, and the role a call of a workspace in it belongs to when it did not act as an app. THE FILE IS WHAT SEPARATES THEM: `host/gh` keeps one ledger per
 * account directory, a workspace on the leads list writes to the leads account's (`managers`) and every other workspace to the workers' (`workers`), and the line itself carries the
 * account's LOGIN, which is a host's own string and names no role. A call with no workspace id is a unit's or a script's and is the `scheduler`'s in either file (`app_role` in `host/gh`).
 * `AGENT_ORG_GH_ROLE`, which a caller may set to name another role, is not in the line: such a call reads as the role its workspace says unless it ran as the app.
 */
export type LedgerSource = { role: Extract<GithubRole, "workers" | "managers">, lines: readonly string[] };

/** A failed mint as the wrapper wrote it: the line's time, the reason the minter gave and its exit status (`null` when the line is not in the wrapper's own shape). */
export type MintFailure = { at: string, reason: string, exit: number | null };

/** `calls` the role's own calls in the window; `lastApp` the time of its newest `app:<role>` line in ANY of the text read, `null` when there is none (a trim may have dropped it); `mint` the role's newest failed mint at or after `lastApp` (any one when `lastApp` is `null`), `null` when there is none. */
export type SilentRole = { role: GithubRole, calls: number, lastApp: string | null, mint: MintFailure | null };

const NO_WORKSPACE = "-";
const INCIDENT_RESOURCE = "incident";
const APP_ACCOUNT = "app:";
const MINT_COMMAND = "app-token ";
// The wrapper's caller field for a failed mint: `app-token <role> failed, <outcome>: <reason> (exit <n>)`, where the outcome names no colon (`host/gh`, `app_token`).
const MINT_CALLER = /^app-token \S+ failed, [^:]*: (.*) \(exit (-?\d+)\)$/;

const mintOf = (entry: LedgerEntry): MintFailure => {
  const shaped = MINT_CALLER.exec(entry.caller);
  return shaped === null ? { at: entry.time, reason: entry.caller, exit: null } : { at: entry.time, reason: shaped[1], exit: Number(shaped[2]) };
};

/**
 * The declared roles that made at least one call in the last `APP_ROLE_SILENT_MINUTES` and none of them as `app:<role>`, in the order they were declared.
 *
 * WHAT IS NOT A CALL: the wrapper's own `incident` line (a failed mint, command `app-token <role>`) names the app that did not answer, and the call it fell back for is its own line, so
 * counting both would make one call two. A line that does not parse (a half line left by a trim) is skipped, never read as a time.
 *
 * THE MINT'S REASON is read from the same incident lines, which the ledger trim may drop before anyone reads: only the NEWEST one per role is kept, because a newer line is
 * at or after `lastApp` whenever an older one is, so the newest is the only candidate that can qualify.
 * @param ledgers the ledger files read, each with the role its un-app'd workspace calls belong to
 * @param declaredRoles the roles `host.json` declares `github-apps`: a role not in it is never returned, whatever its calls
 * @param now epoch ms
 */
export function appRoleSilent(ledgers: readonly LedgerSource[], declaredRoles: readonly GithubRole[], now: number): SilentRole[] {
  const since = now - APP_ROLE_SILENT_MS;
  const calls = new Map<GithubRole, number>();
  const appInWindow = new Set<GithubRole>();
  const lastApp = new Map<GithubRole, string>();
  const newestMint = new Map<GithubRole, MintFailure>();
  for (const { role: home, lines } of ledgers) {
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry === null) continue;
      const at = Date.parse(entry.time);
      if (Number.isNaN(at)) continue;
      if (entry.resource === INCIDENT_RESOURCE) {
        const role = entry.command.startsWith(MINT_COMMAND) ? entry.command.slice(MINT_COMMAND.length) as GithubRole : null;
        if (role !== null && (newestMint.get(role)?.at ?? "") < entry.time) newestMint.set(role, mintOf(entry));
        continue;
      }
      const app = entry.account.startsWith(APP_ACCOUNT) ? entry.account.slice(APP_ACCOUNT.length) as GithubRole : null;
      if (app !== null && (lastApp.get(app) ?? "") < entry.time) lastApp.set(app, entry.time);
      if (at <= since) continue;
      const role = app ?? (entry.workspace === NO_WORKSPACE ? "scheduler" : home);
      calls.set(role, (calls.get(role) ?? 0) + 1);
      if (app !== null) appInWindow.add(app);
    }
  }
  return declaredRoles.filter((role) => (calls.get(role) ?? 0) > 0 && !appInWindow.has(role))
    .map((role) => {
      const last = lastApp.get(role) ?? null;
      const mint = newestMint.get(role) ?? null;
      return { role, calls: calls.get(role) ?? 0, lastApp: last, mint: mint !== null && (last === null || mint.at >= last) ? mint : null };
    });
}

/**
 * THE REF NAMES THE EPISODE: the role and the time of its last app line (`never` when the text holds none). `recordFailures` skips a (key, ref) already logged for ever, so the ref must be
 * stable while the role stays silent -- the tick sees one episode on every run -- and differ for the next one, which begins after an app line has shown the role working. A window
 * start would be new every tick, and a calendar day would hide a second episode the same day.
 */
export const appRoleSilentEvents = (silent: readonly SilentRole[]): FailureEvent[] =>
  silent.map(({ role, lastApp }) => ({ classKey: APP_ROLE_SILENT, ref: `${role}@${lastApp ?? "never"}` }));
