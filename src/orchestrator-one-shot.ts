// @ts-check
// module: a `lane:orchestrator` row run by a ONE-SHOT seat that carries the orchestrator brief, behind `workers.orchestratorOneShot` (a11ign/agent-org#832, Phase 1b of a11ign/a11ign#4505)
//
// WHAT IT IS. The lane's behaviour is {@link oneShotFactory} in `ceo-one-shot.ts`, the factory the ceo's lane is built from too (#914 Change 2): a ready `lane:orchestrator` row becomes an
// order addressed to `engineers` whose cause is {@link ONE_SHOT_SPAWN_CAUSES}' and which carries `briefRole: "orchestrator"`, behind `workers.orchestratorOneShot`, OFF by default and
// byte-identical when off. This module names the lane and re-exports the factory's pieces under the names `wake.ts` and the tests use. The cause is a SIBLING of `SPAWN_CAUSES`, never a widening.
//
// WHICH ROWS (a11ign/agent-org#1527). A row labelled `fleet-gated`, or whose Acceptance or body names a `FLEET_LAB_PATTERNS` command, is NOT converted: its order keeps the gate's
// session, the standing `orchestrator`, as it does with the flag OFF. A spawned seat has no inventory and no control host, so it cannot reach the plane and only ends on the stop hook's bound.
// A row whose body cannot be read keeps the gate's order too (fail closed). The claim of a converted row is recorded under `orchestrator` (#947's `laneReason`), and a row under a future
// `Fleet-hold-until` is held. It does not edit `ROUTED_TO`, `FLEET_LAB_PATTERNS` or `fleetOrLabAcceptance`.
//
// WHICH ROWS, PATH-LESS (a11ign/agent-org#1714). A row whose body is not a PATH row keeps the gate's order too: its Region names no file, or says its deliverable is not a commit
// (`isPathRow`, the ceo lane's predicate, imported and not copied). A seat spawned for such a row has no file to commit, so it can only end on the stop hook's bound (#1646).
import { fleetOrLabAcceptance } from "./acceptance-commands/classification.ts";
import { isPathRow, oneShotFactory, type OneShot, type OneShotRow } from "./ceo-one-shot.ts";

const orchestrator = oneShotFactory({
  tag: "orchestrator-one-shot",
  flag: "workers.orchestratorOneShot",
  owner: "orchestrator",
  causes: ["ready-orchestrator-row-unclaimed"],
  briefRole: "orchestrator",
});

/** The flag's key in the host declaration, as `workers.orchestratorOneShot`. */
export const ORCHESTRATOR_ONE_SHOT_FLAG = "workers.orchestratorOneShot";

/** The causes of a one-shot run, a SIBLING of `wake.ts`'s `SPAWN_CAUSES` and never a member of it. */
export const ONE_SHOT_SPAWN_CAUSES: readonly string[] = orchestrator.causes;

/** The role brief the spawned seat is sent to read; one of `SPAWN_BRIEF_ROLES`. */
export const ONE_SHOT_BRIEF_ROLE = "orchestrator";

/** Whether the host declaration turns the one-shot lane on: `workers.orchestratorOneShot` is exactly `true`. */
export const orchestratorOneShotEnabled = orchestrator.enabled;

/** Is this an order of a one-shot run, as {@link withOrchestratorOneShot} writes it? Addressed to `engineers` and carrying one of {@link ONE_SHOT_SPAWN_CAUSES}. */
export const isOneShotOrder = orchestrator.isOrder;

/**
 * THE TICK'S ORDERS, with the gate's order for a ready `lane:orchestrator` row turned into a one-shot run's when the flag is ON and the row is one the lane may run (see the
 * header: not `fleet-gated`, and no fleet or lab command in its Acceptance). The same array comes back when it is OFF. With NO reader handed, no row is converted: the call site
 * has not said how to read a row, and an order that cannot be asked about keeps the gate's session.
 *
 * @param enabled the flag's reading; a parameter so a test hands it a stated value
 * @param rowOf the row an order is about (`wake.ts`'s `rowRefOfOrder`); a parameter, so this module does not import the file that imports it
 * @param readRow the row's labels and body, one read; THROWS when it cannot (that order then keeps the gate's session)
 * @param rootFiles the tree's root files, as {@link isPathRow} takes them; a parameter so a test names its own, and the default is the project's `origin/main`
 */
export function withOrchestratorOneShot<T extends { session: string; cause?: string; }>(orders: readonly T[], { enabled, rowOf, readRow, rootFiles }: {
  enabled?: () => boolean;
  rowOf?: (order: T) => OneShotRow | null;
  readRow?: (row: number, key?: string) => { body: string; labels?: readonly string[]; };
  rootFiles?: Set<string>;
} = {}): readonly T[] {
  return orchestrator.withOneShot(orders, {
    enabled: enabled ?? orchestratorOneShotEnabled,
    admits: (order) => {
      if (rowOf === undefined || readRow === undefined) return false;
      const row = rowOf(order);
      if (row === null) return false;
      try {
        const { body, labels = [] } = readRow(row.number, row.key);
        return !labels.includes("fleet-gated") && fleetOrLabAcceptance(body) === null && isPathRow(body, { rootFiles });
      } catch {
        return false;
      }
    },
  });
}

/** A row and the tracker it is in, as `wake.ts`'s `RowRef`: `key` is `""` for the first tracker. */
export type { OneShotRow };

/** What the spawn path asks of a one-shot run. */
export type OrchestratorOneShot = OneShot;

/**
 * @param readRow the row's body, one read; THROWS when it cannot (the order is then held: whether its Acceptance reaches the hardware is not known)
 * @param path where the records live; the host's by default, a parameter so a test hands it a temp file
 * @param write the writer of #947 (`lane-stand-in.ts`); a parameter so a test can count its calls
 */
export const createOrchestratorOneShot: (opts: {
  readRow: (row: number, key?: string) => { body: string; };
  path?: string; now?: () => number; write?: Parameters<typeof orchestrator.create>[0]["write"];
}) => OrchestratorOneShot = orchestrator.create;

/**
 * THE CLAIMER A ONE-SHOT RUN'S SPAWN USES: `inner`'s, preceded by {@link OneShot.hold} and {@link OneShot.stand}, and followed by {@link OneShot.forget} when the claim is refused or
 * the spawn is undone after it. See {@link oneShotFactory}'s `claimer`, which this is.
 *
 * @param rowOf the row an order is about (`wake.ts`'s `rowRefOfOrder`); a parameter, so this module does not import the file that imports it
 * @param live the labels present now, which {@link OneShot.hold} reads for a run that is live
 */
export const standInClaimer: (inner: Parameters<typeof orchestrator.claimer>[0], oneShot: OrchestratorOneShot | undefined, opts: {
  rowOf: (order: { causeKey: string; }) => OneShotRow | null; live: readonly { label: string; }[];
}) => ReturnType<typeof orchestrator.claimer> = orchestrator.claimer;
