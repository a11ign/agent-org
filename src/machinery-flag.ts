#!/usr/bin/env node
// command: machinery:flag -- turn a machinery flag on or off, or list them: `on|off <name> [--signals=a,b] --session=<you>`, or `list`
//
// NOTHING IN THE TREE TURNED A MACHINERY FLAG ON (agent-org#1061). Every change that ships behind a flag (#5100's rule) reads `machineryFlagOn` and keeps its
// old behaviour while the flag is off, and the only caller of `withMachineryFlag` was a test, so a flag stayed off until somebody hand-edited
// `machinery-canary.json`. This is that switch. It writes the record through `withMachineryFlag`, the same record the canary and the readers consult, so
// `on` starts the canary's hour at the gate's next tick, and `off` clears a `reverted` verdict, which lets a flag the canary turned off be tried again.
//
// THE REGISTRY IS THE FLAGS A MODULE READS. A name no module reads is REFUSED, because an `on` for it would write a record nothing consults and report success.
// THE FILE IS WRITTEN ONLY WHEN IT PARSES: a malformed `machinery-canary.json` is refused and left as it is, since a state read wrong would forget a flag that
// is on (`parseCanaryState`'s rule).
//
// A LEAF OF THE GATE: it names the flags and reads the file the readers read, and runs no tick.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonObject } from "./claim-stall.ts";
import { BOARD_TRUTH_PAIR_FLAG } from "./org-health/board-truth-and-access-readings.ts";
import { CANARY_STATE_FILE } from "./org-health/claim-and-tick-readings.ts";
import { STANDARD_MACHINERY_SIGNALS, emptyCanaryState, machineryFlagOn, parseCanaryState, type CanaryState, type FlagRecord } from "./org-health/fleet-build-readings.ts";
import { withMachineryFlag } from "./org-health.ts";
import { CHAIN_WAIT_FLAG } from "./work-gate/causes/org-health-chain-wait.ts";
import { REENQUEUE_EJECTED_FLAG, REENQUEUE_INFRA_FLAG } from "./work-gate/causes/pr-ejected.ts";
import { QUEUE_ENTRY_NO_RUN_FLAG } from "./work-gate/causes/queue-entry-no-run.ts";
import { CLOSED_UNDER_HALF_FLAG } from "./work-gate/causes/rows-closed-under-half.ts";
import { CHAIRMAN_REFUSAL_FLAG } from "./work-gate/causes/rows-offer.ts";
import { RECHECK_FLAG } from "./work-gate/shared-file-orders.ts";
import { REVIEWER_STATE_DIR } from "./work-gate/vocabulary.ts";
import { AUTO_UNPARK_FLAG } from "./unpark-satisfied.ts";
import { OPEN_PR_HOLD_FLAG } from "./prune-worktrees.ts";
import { REFUSE_ASKING_ANNOUNCEMENTS_FLAG } from "./messaging/core.ts";
import { PACING_FLAG } from "./work-gate/pacing.ts";
import { OWNERLESS_ASK_FLAG } from "./work-gate/pr-orders.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { PR_OWNER_ROUTING_FLAG, ROW_REVIEW_SKILL_FLAG, SAME_HEAD_REFAIL_FLAG } from "./work-gate/pr-orders/pr-gate-readings.ts";
import { SESSION_PR_OUTSIDE_FLAG } from "./work-gate/outside-session-pr.ts"; // agent-org#1667
import { ACCOUNT_LIMIT_FLAG } from "./account-limit.ts";
import { REFUSE_AUTHOR_FALLBACK_FLAG } from "./gh-author-fallback.ts";
import { VERDICT_DELIVERY_FLAG } from "./review-trust.ts";

const REFUSED = 2;

/** The flags a module reads. A name that is not here is refused by `switchFlag`. */
export const FLAG_REGISTRY: readonly string[] = Object.freeze([REENQUEUE_EJECTED_FLAG, REENQUEUE_INFRA_FLAG, CHAIN_WAIT_FLAG, CLOSED_UNDER_HALF_FLAG, AUTO_UNPARK_FLAG, QUEUE_ENTRY_NO_RUN_FLAG, RECHECK_FLAG, OPEN_PR_HOLD_FLAG, REFUSE_ASKING_ANNOUNCEMENTS_FLAG, PACING_FLAG, ROW_REVIEW_SKILL_FLAG, ACCOUNT_LIMIT_FLAG, SAME_HEAD_REFAIL_FLAG, PR_OWNER_ROUTING_FLAG, CHAIRMAN_REFUSAL_FLAG, OWNERLESS_ASK_FLAG, REFUSE_AUTHOR_FALLBACK_FLAG, VERDICT_DELIVERY_FLAG, SESSION_PR_OUTSIDE_FLAG, BOARD_TRUTH_PAIR_FLAG]);

export const USAGE = [
  "usage: agent-org machinery:flag on|off <name> [--signals=a,b] --session=<you>",
  "       agent-org machinery:flag list",
  `  flags: ${FLAG_REGISTRY.join(", ")}`,
  `  signals: ${STANDARD_MACHINERY_SIGNALS.join(", ")}`,
].join("\n");

export type FlagOutcome = { ok: true; state: CanaryState; line: string } | { ok: false; refusal: string };

/**
 * The state a switch makes, or the refusal that leaves the file as it was. PURE.
 * @param state the file's state as it stands
 * @param signals the signals the flag watches; absent is the standard set
 * @param now the moment of the switch, recorded with who made it
 */
export function switchFlag(state: CanaryState, { on, name, signals, session, now }: { on: boolean; name: string; signals?: readonly string[]; session: string; now: number; }): FlagOutcome {
  if (!FLAG_REGISTRY.includes(name)) return { ok: false, refusal: `${name} is not a flag any module reads (${FLAG_REGISTRY.join(", ")}); nothing was written` };
  const unknown = (signals ?? []).filter((signal) => !STANDARD_MACHINERY_SIGNALS.includes(signal));
  if (unknown.length > 0) return { ok: false, refusal: `${unknown.join(", ")} is not a signal the tick records (${STANDARD_MACHINERY_SIGNALS.join(", ")}); nothing was written` };
  const next = withMachineryFlag(state, { name, on, signals: signals ?? STANDARD_MACHINERY_SIGNALS });
  const record: FlagRecord & { setBy: string; setAt: number } = { ...next.flags[name], setBy: session, setAt: now };
  const when = new Date(now).toISOString();
  return { ok: true, state: { ...next, flags: { ...next.flags, [name]: record } }, line: `${name} ${on ? "ON" : "OFF"}, set by ${session} at ${when}` };
}

/** One line per flag a module reads, and any other flag the file holds (which no module reads), with who set it. */
export function listFlags(state: CanaryState): string[] {
  const names = [...new Set([...FLAG_REGISTRY, ...Object.keys(state.flags)])];
  return names.map((name) => {
    const record = state.flags[name] as (FlagRecord & { setBy?: string; setAt?: number }) | undefined;
    const detail = record === undefined ? "" : [record.verdict === null ? null : `verdict ${record.verdict}`, record.setBy === undefined ? null : `set by ${record.setBy} at ${new Date(record.setAt as number).toISOString()}`].filter(Boolean).join(", ");
    const reader = FLAG_REGISTRY.includes(name) ? "" : " (no module reads it)";
    return `${name}  ${machineryFlagOn(state, name) ? "ON " : "OFF"}${detail === "" ? "" : `  ${detail}`}${reader}`;
  });
}

/**
 * The command. Returns the exit code: 0 for a switch or a list, 2 for a refusal, with the reason on `err`.
 * @param argv what follows `machinery:flag`
 * @param dir the state directory, which the readers read `machinery-canary.json` from
 */
export function main(argv: readonly string[] = process.argv.slice(2), { dir = REVIEWER_STATE_DIR, now = Date.now(), out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) }: { dir?: string; now?: number; out?: (text: string) => void; err?: (text: string) => void; } = {}): number {
  const [verb, ...rest] = argv;
  const flagValue = (name: string) => rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const unknown = rest.filter((arg) => arg.startsWith("--") && !/^--(signals|session)=/.test(arg));
  if (unknown.length > 0) return refuse(`REFUSED unknown-flag: ${unknown.join(" ")}\n${USAGE}\n`, err);
  const path = join(dir, CANARY_STATE_FILE);
  let state: CanaryState;
  try {
    state = existsSync(path) ? parseCanaryState(readFileSync(path, "utf8")) : emptyCanaryState();
  } catch (error) {
    return refuse(`REFUSED: ${path} is unreadable (${String((error as Error).message).split("\n")[0]}); nothing was written\n`, err);
  }
  if (verb === "list") {
    out(`${listFlags(state).join("\n")}\n`);
    return 0;
  }
  const on = verb === "on";
  const [name] = rest.filter((arg) => !arg.startsWith("--"));
  const session = flagValue("session");
  const isUsageError = (!on && verb !== "off") || name === undefined || session === undefined || session === "";
  if (isUsageError) return refuse(`${USAGE}\n`, err);
  const signalText = flagValue("signals");
  const signals = signalText === undefined ? undefined : signalText.split(",").filter(Boolean);
  if (signals !== undefined && signals.length === 0) return refuse(`REFUSED: --signals names no signal; a flag that watches nothing passes its hour by default\n`, err);
  const outcome = switchFlag(state, { on, name, signals, session, now });
  if (!outcome.ok) return refuse(`REFUSED: ${outcome.refusal}\n`, err);
  writeJsonObject(path, outcome.state);
  out(`${outcome.line}\n${on ? "the canary's hour starts at the gate's next tick" : "a reverted verdict is cleared, so the canary may watch it again"}\n`);
  return 0;
}

function refuse(text: string, err: (text: string) => void): number {
  err(text);
  return REFUSED;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) process.exitCode = main();
