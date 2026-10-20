// @ts-check
// module: a `lane:ceo` row that carries a PATH, not a decision, run by a ONE-SHOT seat that carries the ceo brief, behind `workers.ceoOneShot` (a11ign/agent-org#914, Phase 1b of a11ign/a11ign#4505, the second lane after #832)
//
// WHAT IT IS. Today a ready row labelled `lane:ceo` is an order addressed to `ceo`, which only the standing seat reads. With the flag ON, `wake.ts` turns that order -- before delivery,
// never in the gate -- into one addressed to `engineers` whose cause is {@link CEO_ONE_SHOT_SPAWN_CAUSES}' and which carries `briefRole: "ceo"`, so the ordinary spawn path starts
// `worker-<tracker>-<row>` for it, briefs it with `ceo.md` (#828's `addressed(..., { briefRole })`) and ends it when its row closes (`endFinishedSpares`). The cause is a SIBLING of
// `SPAWN_CAUSES`, never a widening: that list is the engineer pilot's and its clean-cycle counter runs on it. The same goes for the orchestrator's one-shot cause (#832), whose module
// is built from {@link oneShotFactory} below, the same factory this module builds its lane from.
//
// OFF BY DEFAULT, AND OFF IS BYTE-IDENTICAL (a11ign#5100's rule for machinery that touches waking, `haiku-brief.ts`'s precedent): the flag is `workers.ceoOneShot` in the host declaration,
// exactly `true`; absent, `false` or anything else is off, and {@link withCeoOneShot} then returns the very array it was handed. The file is read only when the tick holds an order this
// would change. The revert is the flag's removal (or `false`): no record is written with it off, so #947's `laneReason` seam stays inert.
//
// WHICH ROWS. The ceo's one-shot is for a `lane:ceo` row that carries a PATH to follow, not a decision the ceo must make: {@link isPathRow} reads the row's `## Region` and admits
// it only when that names files and does not say its deliverable is not a commit. A decision row keeps the gate's order and stays with the standing seat (#914). A row whose body cannot be
// read keeps the gate's order too (fail closed): the standing seat gets it, and the next tick asks again.
//
// THE CLAIM IDENTITY IS `ceo`'s RULING B (agent-org#947): the seat claims under its OWN name, and `laneReason` honours a RECORD OF A SPAWN. {@link CeoOneShot.stand} writes it, from the spawn
// path (the claimer `standInClaimer` wraps, so `spawnWorker`'s own order of checks is untouched), BEFORE the claim, and {@link CeoOneShot.forget} takes it back when the claim is refused or
// the spawn fails after it, so no record outlives a seat that never ran. The record's `owner` is `ceo`, so a standing `ceo` session is still refused by `laneReason` (the record names a seat
// that was spawned, not the standing seat).
//
// ONE RUN AT A TIME WHILE THE FLEET OR LAB IS IN THE ACCEPTANCE (`ceo`'s constraint (a): the hardware is single-operator). {@link CeoOneShot.hold} holds an order whose row's Acceptance names
// a `FLEET_LAB_PATTERNS` command while any one-shot ceo seat is live, and a row under a future `Fleet-hold-until`. A held order is not recorded, so the next tick asks again. It does not
// edit `ROUTED_TO`, `FLEET_LAB_PATTERNS` or `fleetOrLabAcceptance`: it asks the last as it stands. It counts only the ceo's own one-shot records: a live orchestrator one-shot is not held
// against it here, which is reported as an open item.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fleetOrLabAcceptance } from "./acceptance-commands/command-classes-and-declarations.ts";
import { hostConfigPath } from "./host-config.ts";
import { declaredRegionFiles, declaresNoCommit } from "./region-paths.ts";
import { STAND_IN_MAX_AGE_MS, readStandIns, standInPath, writeStandIn, type LaneStandIn } from "./row-claim/lane-stand-in.ts";
import { briefRoleSentence } from "./spawn-role-brief.ts";
import type { SpawnClaimer } from "./wake/pull-request-spawn-orders.ts";
import { fleetHoldUntil } from "./waiting-condition.ts";

/** The cause the gate writes for a ready row of a lane, and the session it addresses it to when the lane is that lane's owner's. */
const GATE_CAUSE = "ready-row-unclaimed";

/** A row and the tracker it is in, as `wake.ts`'s `RowRef`: `key` is `""` for the first tracker. */
export type OneShotRow = { key: string; number: number; };

/** What the spawn path asks of a one-shot run. */
export type OneShot = {
  /** Why this order must not start a seat now, or `null`. Asked before the claim and before any pane exists. */
  hold: (row: OneShotRow, seat: string, live: readonly { label: string; }[]) => string | null;
  /** Record that `seat` was spawned for `row` as the lane's one-shot: what `laneReason` honours (#947). Called before the claim, and only for a one-shot order. */
  stand: (row: OneShotRow, seat: string) => void;
  /** Take that record back, for a spawn that was refused or failed after {@link OneShot.stand}. */
  forget: (row: OneShotRow, seat: string) => void;
};

/** What one one-shot lane is: its flag, the owner whose ready rows it converts, its causes and the brief its seat reads. */
export type OneShotLane = {
  /** The log line's prefix, as `ceo-one-shot`. */
  tag: string;
  /** The flag's key in the host declaration, as `workers.ceoOneShot`. Exactly `true` turns the lane on. */
  flag: string;
  /** The session the gate addresses the lane's ready rows to, and the `owner` of its stand-in records. */
  owner: string;
  /** The lane's one-shot causes: a SIBLING of `wake.ts`'s `SPAWN_CAUSES`, never a member of it. */
  causes: readonly string[];
  /** The role brief the spawned seat is sent to read; one of `SPAWN_BRIEF_ROLES`. */
  briefRole: string;
};

/** The seams {@link createOneShot} takes: the row's reader, and where the records live, the clock and the writer, which a test passes in. */
type CreateOptions = {
  readRow: (row: number, key?: string) => { body: string; };
  path?: string; now?: () => number; write?: typeof writeStandIn;
};

/** The seams {@link oneShotClaimer} takes: the row an order is about, and the labels present now. */
type ClaimerOptions = { rowOf: (order: { causeKey: string; }) => OneShotRow | null; live: readonly { label: string; }[]; };

/**
 * The lane's hold, stand and forget (#914, #947), for one lane: {@link OneShot.hold} asks the row and the live seats, and {@link OneShot.stand} and {@link OneShot.forget} write and take
 * back the record a one-shot seat stands on.
 *
 * @param lane the lane whose records these are: its `owner` writes them and its `briefRole` is checked before the claim
 * @param readRow the row's body, one read; THROWS when it cannot (the order is then held: whether its Acceptance reaches the hardware is not known)
 * @param path where the records live; the host's by default, a parameter so a test hands it a temp file
 * @param write the writer of #947 (`lane-stand-in.ts`); a parameter so a test can count its calls
 */
function createOneShot(lane: OneShotLane, { readRow, path = standInPath(), now = Date.now, write = writeStandIn }: CreateOptions): OneShot {
  const { owner, briefRole } = lane;
  const mention = (row: OneShotRow) => `${row.key === "" ? "" : row.key}#${row.number}`;
  return {
    hold(row, seat, live) {
      // THE BRIEF IS CHECKED BEFORE THE CLAIM: `addressed` throws naming a missing brief, and by then the row is claimed and a pane sits idle on it.
      try {
        briefRoleSentence(briefRole);
      } catch (err) {
        return `the ${briefRole} brief cannot be named (${String((err as Error).message).split("\n")[0]})`;
      }
      let body: string;
      try {
        body = readRow(row.number, row.key).body;
      } catch (err) {
        return `${mention(row)} could not be read (${String((err as Error).message ?? err).split("\n")[0].slice(0, 160)}), so whether its Acceptance reaches the fleet or the lab is not known and it is held, not guessed`;
      }
      const until = fleetHoldUntil(body);
      if (until !== null && Date.parse(until) > now()) return `${mention(row)} carries \`Fleet-hold-until: ${until}\``;
      if (fleetOrLabAcceptance(body) === null) return null;
      const present = new Set(live.map((agent) => agent.label));
      const running = readStandIns(path).filter((r) => r.owner === owner && r.seat !== seat && present.has(r.seat)
        && now() - r.writtenAt >= 0 && now() - r.writtenAt <= STAND_IN_MAX_AGE_MS);
      if (running.length === 0) return null;
      return `${mention(row)}'s Acceptance names a fleet or lab command and one ${owner} run is live (${running.map((r) => `${r.seat} for #${r.row}`).join(", ")}): `
        + "the hardware is single-operator, so this order is held until that run ends";
    },
    stand(row, seat) {
      write({ seat, row: row.number, owner }, { path, now: now() });
    },
    forget(row, seat) {
      const all = readStandIns(path);
      const kept = all.filter((r: LaneStandIn) => !(r.seat === seat && r.row === row.number && r.owner === owner));
      if (kept.length === all.length) return;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}

/**
 * THE CLAIMER A ONE-SHOT RUN'S SPAWN USES: `inner`'s, preceded by {@link OneShot.hold} and {@link OneShot.stand}, and followed by {@link OneShot.forget} when the claim is refused or
 * the spawn is undone after it (`release`). `spawnWorker` asks its host, brief and claimability checks BEFORE `claim`, so a record is only ever written for a seat about to claim.
 *
 * A REFUSAL, NOT A THROW, FOR A MISSING PIECE: with no `oneShot` or no `inner` the order is not spawned, because the one-at-a-time rule and the claim are what this run exists behind.
 *
 * @param owner the lane's owner, named in the refusals and as the records' owner
 * @param opts `inner` and `oneShot` are the spawn path's own claimer and the lane's hold and stand; {@link ClaimerOptions} the rest
 */
function oneShotClaimer(owner: string, { inner, oneShot, rowOf, live }: ClaimerOptions & { inner: SpawnClaimer | undefined; oneShot: OneShot | undefined; }): SpawnClaimer | { refusal: string } {
  if (inner === undefined || oneShot === undefined) {
    return { refusal: `a one-shot ${owner} run needs the claim and the one-at-a-time guard, and was handed ${inner === undefined ? "no claimer" : "no guard"}` };
  }
  return {
    claim(order, role, env) {
      const row = rowOf(order);
      if (row === null) return { refusal: `a one-shot ${owner} run names no row ("${order.causeKey}"), so there is no row to hold or claim` };
      const held = oneShot.hold(row, role, live);
      if (held !== null) return { refusal: `held: ${held}` };
      oneShot.stand(row, role);
      const claimed = inner.claim(order, role, env);
      if ("refusal" in claimed) oneShot.forget(row, role);
      return claimed;
    },
    release(claimed, role, env) {
      oneShot.forget({ key: claimed.key ?? "", number: claimed.row }, role);
      return inner.release(claimed, role, env);
    },
    ...(inner.tier === undefined ? {} : { tier: inner.tier }),
  };
}

/**
 * THE ONE FACTORY BOTH ONE-SHOT LANES BUILD FROM (#914 Change 2): the ceo's here and the orchestrator's in `orchestrator-one-shot.ts`. Each lane is its {@link OneShotLane}; the
 * flag reader, the order filter, the spawn-path guard and the claimer are the same code with that lane's names, so a change to one lane cannot drift from the other.
 *
 * @param lane the lane's names, flag, owner, causes and brief
 */
export function oneShotFactory(lane: OneShotLane) {
  const { tag, owner, briefRole } = lane;
  const field = lane.flag.replace(/^workers\./, "");
  const causes: readonly string[] = Object.freeze([...lane.causes]);
  /** The lines already written, so a host file that stays unreadable is said once per process and not once per tick. */
  const said = new Set<string>();

  /**
   * Whether the host declaration turns the lane on: `workers.<field>` is exactly `true`. An absent file or key is the ordinary case and says nothing; a file that cannot be read or
   * parsed, or a value present and not a boolean, is OFF and is SAID once, because a flag the operator meant to set that silently does nothing is the failure to see. A wake is never refused for this.
   */
  function enabled({ path = hostConfigPath(), read = (file: string) => readFileSync(file, "utf8"), log = (line: string) => process.stderr.write(`${line}\n`) }:
    { path?: string; read?: (path: string) => string; log?: (line: string) => void } = {}): boolean {
    const say = (line: string) => {
      if (said.has(line)) return;
      said.add(line);
      log(line);
    };
    let declared: unknown;
    try {
      declared = JSON.parse(read(path));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") say(`${tag}: ${path} could not be read (${String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160)}); ${lane.flag} is off`);
      return false;
    }
    const workers = (declared as { workers?: unknown } | null)?.workers;
    const flag = typeof workers === "object" && workers !== null ? (workers as Record<string, unknown>)[field] : undefined;
    if (flag !== undefined && typeof flag !== "boolean") say(`${tag}: ${lane.flag} in ${path} is ${JSON.stringify(flag)}, not true or false; it is off`);
    return flag === true;
  }

  /** Is this an order of a one-shot run, as {@link withOneShot} writes it? Addressed to `engineers` and carrying one of the lane's causes. */
  function isOrder(order: { session: string; cause?: string; }): boolean {
    return order.session === "engineers" && causes.includes(String(order.cause));
  }

  /**
   * THE TICK'S ORDERS, with the gate's order for a ready row of the lane's owner turned into a one-shot run's when the flag is ON and `admits` says so.
   *
   * A gate order for `session: owner` with cause `ready-row-unclaimed` is exactly that row. ONLY `session`, `cause` and `briefRole` change: `causeKey` is the ledger's identity and
   * `rowRefOfOrder`'s input, so the delivery count, the "already woken" check and the row the spawn claims are the standing order's own. With the flag OFF, or with no such order, the
   * SAME array comes back and the file is not read. An order `admits` refuses keeps its gate's session.
   *
   * @param enabled the flag's reading; a parameter so a test hands it a stated value
   * @param admits the filter on a ready row of the owner's; the default admits every one
   */
  function withOneShot<T extends { session: string; cause?: string; }>(orders: readonly T[], { enabled: on = enabled, admits = () => true }:
    { enabled?: () => boolean; admits?: (order: T) => boolean } = {}): readonly T[] {
    const changes = (order: T) => order.session === owner && order.cause === GATE_CAUSE;
    if (!orders.some(changes) || !on()) return orders;
    return orders.map((order) => (changes(order) && admits(order)
      ? { ...order, session: "engineers", cause: causes[0], briefRole }
      : order));
  }

  /**
   * THE CLAIMER A ONE-SHOT RUN'S SPAWN USES: {@link oneShotClaimer} for this lane's owner, with `inner`'s claim and release.
   *
   * @param rowOf the row an order is about (`wake.ts`'s `rowRefOfOrder`); a parameter, so this module does not import the file that imports it
   * @param live the labels present now, which {@link OneShot.hold} reads for a run that is live
   */
  function claimer(inner: SpawnClaimer | undefined, oneShot: OneShot | undefined, opts: ClaimerOptions): SpawnClaimer | { refusal: string } {
    return oneShotClaimer(owner, { inner, oneShot, ...opts });
  }

  return { causes, enabled, isOrder, withOneShot, create: (opts: CreateOptions) => createOneShot(lane, opts), claimer };
}

const ceo = oneShotFactory({
  tag: "ceo-one-shot",
  flag: "workers.ceoOneShot",
  owner: "ceo",
  causes: ["ready-ceo-row-unclaimed"],
  briefRole: "ceo",
});

/** The flag's key in the host declaration, as `workers.ceoOneShot`. */
export const CEO_ONE_SHOT_FLAG = "workers.ceoOneShot";

/** The causes of a ceo one-shot run, a SIBLING of `wake.ts`'s `SPAWN_CAUSES` and never a member of it. */
export const CEO_ONE_SHOT_SPAWN_CAUSES: readonly string[] = ceo.causes;

/** The role brief the spawned seat is sent to read; one of `SPAWN_BRIEF_ROLES`. */
export const CEO_ONE_SHOT_BRIEF_ROLE = "ceo";

/**
 * Whether the host declaration turns the ceo one-shot lane on: `workers.ceoOneShot` is exactly `true`. See {@link oneShotFactory}'s `enabled`, which this is.
 */
export const ceoOneShotEnabled = ceo.enabled;

/** Is this an order of a ceo one-shot run, as {@link withCeoOneShot} writes it? Addressed to `engineers` and carrying one of {@link CEO_ONE_SHOT_SPAWN_CAUSES}. */
export const isCeoOneShotOrder = ceo.isOrder;

/**
 * Is this row one that carries a PATH to follow, not a decision for the ceo? Its `## Region` names files, and it does not say its deliverable is not a commit. A row with no Region
 * section, an empty one, or one that says its deliverable is not a commit is a DECISION: it stays with the standing seat (#914).
 *
 * @param rootFiles the root-level files of the tree, as `declaredRegionFiles` takes them; a parameter so a test names its own
 */
export function isPathRow(body: string, { rootFiles }: { rootFiles?: Set<string> } = {}): boolean {
  const files = declaredRegionFiles(body, { rootFiles });
  return files !== null && files.length > 0 && !declaresNoCommit(body);
}

/**
 * THE TICK'S ORDERS, with the gate's order for a ready `lane:ceo` PATH row turned into a ceo one-shot run's when the flag is ON.
 *
 * A DECISION row (see {@link isPathRow}) keeps the gate's order, and so does a row that cannot be read: `rowOf` and `readRow` are needed to ask, and without either the order is
 * not converted. With the flag OFF the SAME array comes back and no row is read.
 *
 * @param enabled the flag's reading; a parameter so a test hands it a stated value
 * @param rowOf the row an order is about (`wake.ts`'s `rowRefOfOrder`); a parameter, so this module does not import the file that imports it
 * @param readRow the row's body, one read (`wake.ts`'s `readRowForTier`); THROWS when it cannot, and that order keeps the gate's session
 * @param rootFiles the tree's root files, as {@link isPathRow} takes them; a parameter so a test names its own, and the default is the project's `origin/main`
 */
export function withCeoOneShot<T extends { session: string; cause?: string; }>(orders: readonly T[], { enabled = ceoOneShotEnabled, rowOf, readRow, rootFiles }: {
  enabled?: () => boolean;
  rowOf?: (order: T) => OneShotRow | null;
  readRow?: (row: number, key?: string) => { body: string; };
  rootFiles?: Set<string>;
} = {}): readonly T[] {
  return ceo.withOneShot(orders, {
    enabled,
    admits: (order) => {
      if (rowOf === undefined || readRow === undefined) return false;
      const row = rowOf(order);
      if (row === null) return false;
      try {
        return isPathRow(readRow(row.number, row.key).body, { rootFiles });
      } catch {
        return false;
      }
    },
  });
}

/** What the spawn path asks of a ceo one-shot run. */
export type CeoOneShot = OneShot;

/**
 * @param readRow the row's body, one read; THROWS when it cannot (the order is then held: whether its Acceptance reaches the hardware is not known)
 * @param path where the records live; the host's by default, a parameter so a test hands it a temp file
 * @param write the writer of #947 (`lane-stand-in.ts`); a parameter so a test can count its calls
 */
export const createCeoOneShot: (opts: {
  readRow: (row: number, key?: string) => { body: string; };
  path?: string; now?: () => number; write?: typeof writeStandIn;
}) => CeoOneShot = ceo.create;
