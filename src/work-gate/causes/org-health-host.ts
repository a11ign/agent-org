import { poolDiagnosis, refusalPoolLine } from "../../api-pool.ts";
import { graphqlPoolProbe } from "../../ticket-port/graphql-pool-probe.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../../project-vocabulary.ts";
import { diskHeadroom, MIN_FREE_FRACTION } from "../../disk-headroom.ts";
import { openRowState, stalledOrder, workingClaims } from "../orders.ts";

const BYTES_PER_GIB = 1_073_741_824;

/**
 * `/` and `/tmp` -> `root+tmp`: a mount as a word a causeKey can carry. `/` is `root`, any other loses its leading
 * slash and turns the rest into `-`.
 */
function mountsLabel(mounts: string[]) {
  return mounts.map((m) => (m === "/" ? "root" : m.replace(/^\//, "").replaceAll("/", "-"))).join("+");
}

function describeLow(f: import("../../disk-headroom.ts").LowFinding) {
  const amount = f.resource === "bytes"
    ? `${(f.free / BYTES_PER_GIB).toFixed(1)} GiB of ${(f.total / BYTES_PER_GIB).toFixed(1)} GiB`
    : `${f.free.toLocaleString("en-US")} of ${f.total.toLocaleString("en-US")}`;
  return `${f.mounts.join(" + ")}  FREE ${f.resource.toUpperCase()}: ${amount} (${(f.fraction * 100).toFixed(1)}%)`;
}

/**
 * The incident order to `ceo`, or none (#2163). `ceo` because a full disk is the one fault every session shares and
 * no session owns, and the remedy (what to delete, whether to schedule the prune) is theirs to rule on.
 *
 * JUDGMENT-KEYED ON WHICH RESOURCE OF WHICH FILESYSTEM IS LOW, and on nothing else -- so a condition that persists
 * is asked again on the judgment window and not on every tick, and a SECOND resource going low is a new question
 * that reaches `ceo` at once. The cost, stated: 9% and 0% free are the same key, so a disk getting worse does not
 * re-page inside the window; the stderr line below is written every tick and does.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * on 2026-09-25 `/tmp` ran out of INODES at 73% of its bytes and every session failed with ENOSPC for about six hours.
 */
export function diskHeadroomOrders(low: import("../../disk-headroom.ts").LowFinding[]): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  if (low.length === 0) return [];
  const key = low.map((f) => `${mountsLabel(f.mounts)}:${f.resource}`).sort().join(".");
  return [{
    session: "ceo",
    cause: "disk-headroom-low",
    subject: "disk-headroom",
    discriminator: key,
    prompt: `DISK HEADROOM IS LOW on this host (a resource is low below ${MIN_FREE_FRACTION * 100}% free):\n`
      + low.map((f) => `  ${describeLow(f)}`).join("\n") + "\n"
      + "BYTES AND INODES ARE JUDGED SEPARATELY, and `df -h` shows only bytes. A filesystem can run out of "
      + "INODES with bytes to spare, and every session then fails with ENOSPC. Read both: "
      + "`df -h / /tmp` and `df -i / /tmp`.\n"
      + "What has filled it before: `/tmp/rv-*` review clones, `/tmp/claude-1000` session scratchpads, "
      + "`~/repos/wt-*` worktrees (each with a `node_modules`), and npm caches. `node "
      + "packages/agent-org/src/prune-tmp.ts` classifies `/tmp` and removes NOTHING without `--apply`, and "
      + "`--apply` waits for a named list one cycle first (#2243). `pnpm run worktrees:prune` is the worktree half.\n"
      + "IF YOUR OWN SHELL IS FAILING WITH ENOSPC you cannot fix this from here: label a row `" + CHAIRMAN_LABEL + "` and "
      + "@-mention `@DanBeckDev` in its brief (a GitHub write, and the label is what the gate reads). "
      + "The same reading is written on the tick's stderr before `wake` runs (`journalctl --user -u "
      + "a11ign-work-tick.service | grep 'DISK LOW'`), though that journal sits on this same filesystem.",
    causeKey: `ceo/disk-headroom-low/${key}`,
  }];
}

/**
 * The detector's whole tick: read `/` and `/tmp`, say on stderr what is low, return the incident order.
 *
 * NEVER THROWS, for `reviewerAuthTick`'s reason -- a detector that can crash the gate stops every order behind it.
 * A mount that cannot be READ is said on stderr and is neither reported low nor counted healthy: `statfs` failing
 * is not the disk being full, and silence about it would read as a clean bill.
 *
 * THE STDERR LINE IS THE CHANNEL THAT DOES NOT NEED THE DISK (#2163 done-when 4). `work-tick` relays the gate's
 * stderr BEFORE it runs `wake`, and `wake`'s writes (`wake-emitted`, the ledger) are what a full disk breaks: a
 * throwing write to `wake-emitted` ends `wake` with an uncaught exception, exit 1, BEFORE any delivery, and one to
 * the ledger ends it AFTER the first delivery and before the rest (both measured -- `disk-headroom.test.ts`). The
 * line is written whether or not the order is ever delivered. THE JOURNAL IT LANDS IN IS ON THE SAME FILESYSTEM
 * (`/var/log/journal`, persistent), so this is a channel that does not depend on a write BY THE ORG, not one proven
 * to survive an exhausted disk: journald's own free-space rules decide that, and nothing here has run it to zero.
 */
export function diskHeadroomTick({ read = diskHeadroom, log = (line) => process.stderr.write(line) }: { read?: typeof diskHeadroom; log?: (line: string) => void; } = {}) {
  try {
    const { low, unreadable } = read();
    for (const u of unreadable) {
      log(`disk-headroom: could not read ${u.mount} (${u.reason}) -- neither reported low nor counted healthy.\n`);
    }
    for (const f of low) log(`DISK LOW: ${describeLow(f)}\n`);
    return diskHeadroomOrders(low);
  } catch (err) {
    log(`disk-headroom: could not run (${String((err as any)?.message ?? err).split("\n")[0]}) -- no order this tick.\n`);
    return [];
  }
}

/**
 * The dead man's switch, wired: asked ONLY when everything else said nothing.
 *
 * Split out of `main`, which reached `complexity` 17 with it inline -- and the seam is real rather than
 * cosmetic: every other line in `main` is about delivering what the gate found, and this one is about
 * what it did NOT find.
 *
 * A DRAIN WITHHOLDS IT like any other START cause. During a transfer window the org is SUPPOSED to be
 * idle, and a switch that fires then is one people learn to ignore -- which is the failure mode the
 * pattern's own literature warns about more loudly than the missing-switch one.
 *
 * IT TAKES THE ROWS RATHER THAN READING THEM (#1938). `main` has the whole open-row list in hand by the
 * time this is reached, so asking again was a second `gh` call for a subset of a list already fetched.
 * What it must be handed is the UN-COALESCED result -- `readOpenRows`, not `readOpenRows ?? []` --
 * because those two spell "the API refused" and "the tracker is empty" identically, and only one of them
 * is a state where silence is honest.
 *
 * A REFUSAL SAYS SO OUT LOUD, and that line is how the difference is OBSERVABLE rather than ceremonial.
 * `stalledOrder` returns no order for either `null` or `0`, so without this the two states would be
 * indistinguishable from outside -- a silent tick that could not ask would look exactly like a silent
 * tick that asked and found a finished org. `main` already refuses to report a refused read as quiet for
 * the pull-request and Ready lanes (`CANNOT ASK` / `PARTIAL`); this is the same rule for this lane.
 *
 * A CLAIMED ROW WITH A WORKING SESSION IS NOT COUNTED (#4205): `agents` is herdr's listing, the one the tick already read, and `null` or absent leaves every row counted.
 */
export function deadMansSwitch({ orders, drain, performed = 0, openRows, agents = null,
  log = (line) => process.stderr.write(line) }: {
        orders: unknown[]; drain: boolean; performed?: number; openRows: any[] | null;
        agents?: { label: string; status: string; }[] | null; log?: (line: string) => void;
    }) {
  // A PERFORMED ACTION IS ACTIVITY. Without this the gate could mark a draft ready, emit no order, and
  // then announce the org as stalled in the same tick -- reporting the one thing it just did as nothing.
  if (drain || orders.length > 0 || performed > 0) return [];
  // BOTH HALVES OF THE ANSWER FROM THE ROWS ALREADY READ: how many rows could move, and what is stopping
  // the ones that cannot. A refused read stays `null` all the way into `stalledOrder`, which is the
  // #1286 rule -- it must not collapse to a zero count, which would silence the switch on an API hiccup.
  const state = openRowState(openRows);
  if (state === null) {
    log("CANNOT ASK whether the org is stalled: the open-rows read was refused this tick. "
      + "This silence is NOT a quiet queue, and the dead man's switch did NOT examine anything.\n");
  }
  const leftOut = state === null ? 0 : workingClaims(openRows, agents).length;
  const stalled = stalledOrder({ orders, openRows: state === null ? null : state.reachable - leftOut, waiting: state?.waiting, leftOut });
  return stalled ? [stalled] : [];
}

/**
 * THE REFUSAL, WITH THE THREE FACTS THAT TELL A DEAD POOL FROM A QUIET QUEUE (#2003).
 *
 * The first sentence is unchanged and still does its job: it is correct, it is loud, and on 2026-09-22 it
 * ran on every tick from 20:28:15Z. What it could not say is the only thing a reader needs -- which
 * account was refused, which pool, and when it comes back. `328832207` is a user ID, not a login, and the
 * answer to "for how long" (52 minutes) was sitting in the headers of the call that had just failed.
 *
 * THE COST IS PAID ONLY HERE, AND IT IS ONE POINT. A healthy tick still makes exactly the reads `GH_READS`
 * names: this function is reached only when BOTH lanes have already refused, on a pool that by definition
 * has nothing left to protect, and `poolDiagnosis` spends a single probe whatever it finds there.
 *
 * A DEAD POOL BOUGHT ONLY THE RESET, NOT THE LOGIN, because no one call buys both and "how long is the org
 * deaf" was the question the 2026-09-22 outage left unanswered -- so the account used to read `UNREADABLE
 * (user ID ...)` on exactly that path. #1984 closes that gap AT NO EXTRA CALL: `identity.login` is the
 * DECLARED account `gh-identity.ts` reads off disk (which config `gh` is routed to), and it fills in
 * whenever the probe's own response names none, which is precisely the dead-pool case. When the probe DOES
 * name one (a live pool), that response wins -- it is a confirmed account fact and `identity.login` is
 * left unused, per `accountPhrase`'s own header in `api-pool.ts`. `identity` is REQUIRED rather than
 * defaulted, for the same reason `run` is (#1405): a defaulted read of `.agent-org/host.json` and a
 * `hosts.yml` is still a real filesystem read, and a test reaching this function would make it against
 * whatever this host happens to have installed.
 */
export function cannotAskReport({ run, identity }: { run: (args: string[]) => string; identity: import("../../gh-identity.ts").DeclaredAccount; }): string {
  const diagnosis = poolDiagnosis({ run, probe: graphqlPoolProbe() });
  return "CANNOT ASK: neither the pull-request list nor the Ready rows could be read. "
    + "Nothing was examined -- this is NOT a quiet queue, and no session has been woken.\n"
    + `${refusalPoolLine({ ...diagnosis, login: diagnosis.login ?? identity.login })}\n`;
}
