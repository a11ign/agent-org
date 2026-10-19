import { createHash } from "node:crypto";
import { stateEntryPath } from "../../host-config.ts";

/**
 * WHO IS WOKEN, NAMED ON THE ROW RATHER THAN ASSUMED, because #2174 asked for exactly that.
 *
 * `orchestrator`, on #2002's own reasoning: host writes are its work, and `agent-practices.md` already
 * makes it the first reader for fleet and host questions. THE COUNTER-EVIDENCE, stated because it is
 * real: no entry in `docs/lane-ownership.json` covers host paths at all, and BOTH host writes this org
 * has actually made were `worker-capture`'s -- #2002 on 2026-09-23T07:15Z and #2173 at 15:54Z. So this
 * is a routing choice with a live exception, not a settled fact; it is one line to change if the
 * exception becomes the rule, and the wake ledger will show which session actually answers.
 */
export const HOST_DRIFT_SESSION = "orchestrator";

/**
 * A PRIMARY THAT IS NOT AT `origin/main` IS A SIGNAL, NOT A JOURNAL LINE (#2781).
 *
 * `a11ign-work-tick.service` runs `primary:update` as `ExecStartPre=-`, so when it fails the tick goes on -- and from
 * 2026-09-28T12:01Z a dirty primary made it fail on every tick for 22 hours (2,652 journal lines) while the gate gave orders from
 * `a5f407d4f`. Nothing told any session. `ceo` owns the primary (`.github/CLAUDE.md`), so `ceo` is told, with the dirty paths
 * and how far behind, on the tick they appear.
 *
 * TWO CONDITIONS, NEITHER DERIVED FROM THE UPDATE'S FAILURE: tracked paths with uncommitted changes (a dirty primary is reported
 * before a newer `origin/main` makes it conflict), or HEAD is not `origin/main` (behind, or carrying commits origin lacks).
 *
 * AN ACTION CAUSE, so `wake.ts`'s twenty-minute expiry RE-DELIVERS it until it clears -- a wake that does not stick leaves the
 * gate running stale with nobody told, which is the defect. KEYED ON THE TWO SHAS AND THE DIRTY SET, so a further merge or a
 * further edit is a new question and an unchanged stale primary is not a new one every tick.
 *
 * `null`/omitted emit NOTHING and are not a clean reading: a linked worktree, CI or a repository with no `origin/main` cannot be asked.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * the 2026-09-28 stale primary was an interactive session's uncommitted edits, which no hook refuses.
 */
export function primaryStaleOrders(drift: import("../../update-primary.ts").PrimaryDrift | null | undefined): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const hasNothingToReport = !drift || (drift.behind === 0 && drift.ahead === 0 && drift.dirty.length === 0);
  if (hasNothingToReport) return [];
  const dirty = [...drift.dirty].sort();
  const key = `${drift.sha.slice(0, 9)}.${drift.originSha.slice(0, 9)}.${createHash("sha256").update(dirty.join("\n")).digest("hex").slice(0, 8)}`;
  return [{
    session: "ceo",
    cause: "primary-stale",
    subject: "primary-checkout",
    discriminator: key,
    prompt: `The PRIMARY checkout is not at \`origin/main\`: it is at ${drift.sha.slice(0, 9)}, ${drift.behind} commit(s) behind `
      + `${drift.originSha.slice(0, 9)}${drift.ahead > 0 ? ` and carrying ${drift.ahead} commit(s) origin lacks` : ""}. Every order this gate gives `
      + "is given from THAT code, and every agent reads its role briefs and scripts out of it.\n"
      + (dirty.length > 0 ? `${dirty.length} tracked path(s) carry uncommitted changes, which is what makes \`pnpm run primary:update\` refuse `
        + `("would be overwritten by checkout"):\n${dirty.map((path) => `  ${path}`).join("\n")}\n` : "No tracked path is dirty, so the update itself "
        + "is failing for another reason: run `pnpm run primary:update` and read its output.\n")
      + "THE EDITS ARE NOT YOURS TO DISCARD UNREAD: an interactive session left them there, and no hook "
      + "refuses an uncommitted edit. Save `git diff` to `" + stateEntryPath("salvage") + "/primary-<date>.patch` first and say on #2781 "
      + "where it went, then clear the tracked paths and run `pnpm run primary:update`. This order repeats until the primary is at `origin/main`.",
    causeKey: `ceo/primary-stale/${key}`,
  }];
}

/**
 * EVERY ORDER SAYS THE GATE IS RUNNING STALE WHEN IT IS (#2781, done-when 2), with the sha and the count, at the head of its prompt.
 * The builder's choice between this and withholding: withholding would stall the whole org on a condition `ceo` can clear in one
 * command, but an order presented as current from stale code is what cost 22 hours, so the orders go out and SAY WHAT THEY ARE.
 * Applied to the tick's orders after `decide`, so no cause's own text or key changes; `primary-stale` already says it.
 */
export function withStalePrimaryNotice<T extends { cause?: string; prompt: string }>(orders: T[], drift: import("../../update-primary.ts").PrimaryDrift | null | undefined): T[] {
  if (!drift || drift.behind === 0) return orders;
  const notice = `[THIS GATE IS RUNNING FROM A STALE PRIMARY: ${drift.sha.slice(0, 9)}, ${drift.behind} commit(s) behind origin/main ${drift.originSha.slice(0, 9)}. `
    + "What this order asks may already be superseded on main; check before acting.]\n";
  return orders.map((order) => (order.cause === "primary-stale" ? order : { ...order, prompt: notice + order.prompt }));
}
