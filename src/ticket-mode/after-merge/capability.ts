// @ts-check
// module: a check this host cannot run (A11-361) -- a routing problem, not a failure. The verifier ends `cannot-run-here` naming what it needs, the board routes the check to a runner that has it, and files ONE ticket for each missing capability. PURE
//
// A MISSING CAPABILITY IS FILED ONCE. Checks that needed the chairman's Mac, a publishing machine or the board key each ended failed on 2026-10-27 and each filed a ticket: six tickets for three missing things. A check that cannot run
// here stays open, parked on what it needs. The capability is the unit: the first parked check for it files the ticket, and every other check for the same capability, now or later, carries that request instead of filing its own.
import type { CheckRecord, ChecksFile } from "./checks.ts";

/** A runner a check may be routed to, and the capabilities it has. */
export type CheckRunner = Readonly<{ name: string; has: readonly string[] }>;

/**
 * The runners other than this host's verifier runs. None exists yet: a capability no runner has is a missing capability, and is filed as a ticket. A runner that is added here (the machine with the chairman's Mac, say) takes the checks
 * parked on what it has from the next sweep: they are marked routed and given to a verifier run (`queueVerifiers`), once for each try the check has left. A test registers one and removes it.
 */
export const CHECK_RUNNERS: CheckRunner[] = [];

/** The longest a capability's name may be. */
export const CAPABILITY_CHARS = 40;

/** A capability as the verifier names it: lower case words joined by hyphens, such as `chairman-mac` or `board-key`. */
const CAPABILITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A capability as a verifier run wrote it ("Chairman Mac", "board key"), kept as a name, or why it is not one. PURE. */
export function capabilityOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const name = text.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return name.length <= CAPABILITY_CHARS && CAPABILITY.test(name) ? name : null;
}

/** The name of a runner that has `capability`, or null when none does. PURE. */
export const runnerWith = (capability: string, runners: readonly CheckRunner[] = CHECK_RUNNERS): string | null => runners.find(({ has }) => has.includes(capability))?.name ?? null;

/** The request a capability's ticket was filed with, as another check parked on it records, or undefined when none is filed. */
const requestFor = (file: ChecksFile, capability: string): string | null | undefined => Object.values(file.checks).find((check) => check.needs?.capability === capability && check.needs.request !== undefined)?.needs?.request;

/**
 * The file with open check `id` parked on `capability`: it stays open and is given to no verifier run, it carries what the run said it lacked, and it takes the request an earlier check parked on the same capability filed. A check that is
 * not open is left as it was. PURE.
 */
export function parkCheck(file: ChecksFile, id: string, capability: string, why: string, runners: readonly CheckRunner[] = CHECK_RUNNERS): ChecksFile {
  const check = file.checks[id];
  if (check === undefined || check.state !== "open") return file;
  const request = requestFor(file, capability);
  const routedTo = runnerWith(capability, runners);
  const parked: CheckRecord = { ...check, verifier: { run: null, tries: check.verifier?.tries ?? 0 }, needs: { capability, why, ...(request === undefined ? {} : { request }), ...(routedTo === null ? {} : { routedTo }) } };
  return { checks: { ...file.checks, [id]: parked } };
}

/** Whether an open check is parked on a capability that no runner has and no ticket is filed for. */
function needsATicket(check: CheckRecord, runners: readonly CheckRunner[]): boolean {
  const needs = check.needs;
  return check.state === "open" && needs !== undefined && needs.request === undefined && runnerWith(needs.capability, runners) === null;
}

/** The open checks parked on a capability no runner has, and no ticket is filed for, by capability, oldest first: the board files one ticket for each. PURE. */
export function missingCapabilities(file: ChecksFile, runners: readonly CheckRunner[] = CHECK_RUNNERS): Map<string, CheckRecord[]> {
  const missing = new Map<string, CheckRecord[]>();
  for (const check of Object.values(file.checks).sort((a, b) => a.listedAt - b.listedAt)) {
    const capability = check.needs?.capability;
    if (capability !== undefined && needsATicket(check, runners)) missing.set(capability, [...(missing.get(capability) ?? []), check]);
  }
  return missing;
}

/** The file with `request` (the writer run that was queued, or null for none) recorded on every open check parked on `capability`. PURE. */
export function recordCapabilityRequest(file: ChecksFile, capability: string, request: string | null): ChecksFile {
  const parked = Object.values(file.checks).filter((check) => check.state === "open" && check.needs?.capability === capability && check.needs.request === undefined);
  if (parked.length === 0) return file;
  return { checks: { ...file.checks, ...Object.fromEntries(parked.map((check) => [check.id, { ...check, needs: { ...check.needs!, request } }])) } };
}

/** The file with each parked check whose capability a runner now has marked as routed to it, and each whose capability no runner has any more unmarked. Returns `file` itself when nothing changes. PURE. */
export function routeParked(file: ChecksFile, runners: readonly CheckRunner[] = CHECK_RUNNERS): ChecksFile {
  const changed = Object.values(file.checks).flatMap((check) => {
    const needs = check.needs;
    if (check.state !== "open" || needs === undefined) return [];
    const routedTo = runnerWith(needs.capability, runners);
    if (routedTo === (needs.routedTo ?? null)) return [];
    const { routedTo: _before, ...rest } = needs;
    return [{ ...check, needs: routedTo === null ? rest : { ...rest, routedTo } }];
  });
  return changed.length === 0 ? file : { checks: { ...file.checks, ...Object.fromEntries(changed.map((check) => [check.id, check])) } };
}

/** The request that files a capability's one ticket: what is missing, and the checks that could not run for want of it. It does not start with "Follow-up to", which is a failed check's. PURE. */
export function capabilityRequest(capability: string, checks: readonly Pick<CheckRecord, "id" | "line" | "needs">[]): string {
  const listed = checks.map((check) => `- ${check.id}: ${check.line}\n  What the verifier said it lacked: ${check.needs?.why ?? ""}`);
  return [`Runner needed: ${capability}.`, "", `These After-merge checks cannot run on this host because it lacks \`${capability}\`. They are parked, not failed. A runner that has it takes them; or the check is closed another way.`, "", ...listed].join("\n");
}
