// A ROW HELD ON A CONDITION THAT IS ALREADY TRUE, OR ON AN UMBRELLA ROW THAT NAMES NO CONDITION (#4005, the chairman's order, 2026-10-07: "very keen on the root cause
// being fixed"). Seven `ready` rows sat behind #3778 after `0.3.0` reached `next`: four needed only that a version EXISTS, three needed a tag, and every edge said
// `blocked-by #3778`, a row of five done-whens, so nothing could say which link was needed or that it was already there.
//
// THREE THINGS LIVE HERE, EACH THE ANSWER TO ONE PART OF THE ROW:
//   - `readReleaseFacts`: the registry and remote reads a `Waiting-for: published|latest = next|tagged` needs, ONE read per distinct fact and a failed read `null` (part a).
//   - `heldOnSatisfiedOrders`: a `ready` row whose release-state wait is TRUE while the wait still holds it, ordered to `product-manager` (part c, i).
//   - `umbrellaEdges` / `umbrellaEdgeOrders`: a `ready` row held by a native edge onto an OPEN row of more than one done-when that names no condition (part c, ii).
//
// THEY READ MACHINE-READABLE TRUTH ONLY (registry, remote, labels, state, the edge), never prose, and cost API calls, not a model turn.
// A LEAF OF THE GATE: it imports no binding from `work-gate.ts` (`org-health.ts` does, and is a cycle), so the order cap and the `gh` runner arrive as arguments.
import { spawnSync } from "node:child_process";
import { READY_LABEL } from "../claim-labels.ts";
import { subjectMention, subjectRef } from "../review-attribution.ts";
import { releaseReferencesOf, umbrellaEdge } from "../wait-condition.ts";

/** How many distinct release facts one tick reads. A BOUND ON THE SPEND, NOT A TARGET: a few waits cite the same one or two packages and tags. */
export const MAX_RELEASE_READS = 8;
const REGISTRY_TIMEOUT_SECONDS = 20;
/** Who hears about a row held on a satisfied condition: `product-manager`, the first reader for rows and process, and not `ceo` (#4005). */
const REPORTED_TO = "product-manager";

/**
 * What the facts are read WITH. `null` from either is a read that failed, which `conditionHolds` calls unknown.
 */
export type ReleaseReaders = { distTags: (pkg: string) => Record<string, string> | null, tagExists: (tag: string) => boolean | null };

/**
 * A PACKAGE'S DIST-TAGS FROM THE REGISTRY, or `null` when the read failed. The registry is the authority and the publish workflow's log is not: the registry lags a publish
 * by minutes (measured 2026-10-07: `changeset publish` at 17:13:01Z, `next` visible at 17:15Z), so a wait that read the log would clear before the thing it waits for exists.
 * `-f` makes a 404 (never published) a failed read too, which is an unknown: it cannot be mistaken for "not published" and release a hold early.
 */
export function registryDistTags(pkg: string): Record<string, string> | null {
  const url = `https://registry.npmjs.org/-/package/${pkg.replace("/", "%2f")}/dist-tags`;
  const result = spawnSync("curl", ["-sSf", "--max-time", String(REGISTRY_TIMEOUT_SECONDS), "-H", "Accept: application/json", url], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    const tags = JSON.parse(result.stdout);
    return tags !== null && typeof tags === "object" && !Array.isArray(tags) ? tags : null;
  } catch {
    return null; // a body that is not JSON is a read that failed, said as an unknown
  }
}

/**
 * WHETHER A TAG EXISTS ON THE REMOTE, or `null` when the read failed. `matching-refs` answers an empty list for a tag that is absent, so no HTTP status has to be told
 * apart from "absent" (a 404 from `git/ref` would be absent OR forbidden); it matches by PREFIX, so the exact ref is compared.
 */
export function remoteTagExists(tag: string, { run, repo }: { run: (args: string[]) => string; repo: () => string; }): boolean | null {
  try {
    const refs = JSON.parse(run(["api", `repos/${repo()}/git/matching-refs/tags/${tag}`]));
    return Array.isArray(refs) ? refs.some((r) => r?.ref === `refs/tags/${tag}`) : null;
  } catch {
    return null;
  }
}

/** THE RELEASE FACTS THE ITEMS' WAITS NAME, each read once. A reference past `limit` is left OUT, which is an unknown and never "not published". */
export function readReleaseFacts({ items, readers, limit = MAX_RELEASE_READS }: { items: import("../wait-condition.ts").WaitItem[]; readers: ReleaseReaders; limit?: number; }): Record<string, Record<string, string> | boolean> {
  const releases: Record<string, Record<string, string> | boolean> = {};
  for (const ref of releaseReferencesOf(items).slice(0, limit)) {
    const fact = ref.kind === "npm" ? readers.distTags(ref.pkg) : readers.tagExists(ref.tag);
    if (fact !== null) releases[ref.key] = fact;
  }
  return releases;
}

/** @returns a release-state wait holding a `ready` row: the shape this row reports */
const isHeldReadyRow = ({ item, wait }: import("../wait-condition.ts").StaleWait): boolean => item.kind === "row" && item.labels.includes(READY_LABEL)
  && (wait.state === "published" || wait.state === "latest-next" || wait.state === "tagged");

/** THE STALE WAITS THIS MODULE OWNS, and the rest, which keep `staleWaitOrders`'s text: a release wait on a `ready` row is reported as what it is. */
export function splitHeldOnSatisfied(stale: import("../wait-condition.ts").StaleWait[]): { held: import("../wait-condition.ts").StaleWait[]; rest: import("../wait-condition.ts").StaleWait[]; } {
  return { held: stale.filter(isHeldReadyRow), rest: stale.filter((s) => !isHeldReadyRow(s)) };
}

/** ONE ORDER PER ROW HELD ON A SATISFIED CONDITION, to `product-manager`: the row, the condition now true, and the fields to remove. */
export function heldOnSatisfiedOrders(held: import("../wait-condition.ts").StaleWait[], { limit }: { limit: number; }): any[] {
  return held.slice(0, limit).map(({ item, wait, remove }) => {
    const discriminator = `${subjectRef(item.repoKey, item.number)}:${wait.key}`;
    return { session: REPORTED_TO, cause: "org-health", subject: `held-on-satisfied-${subjectRef(item.repoKey, item.number)}`, discriminator,
      prompt: `A ROW IS HELD ON A SATISFIED CONDITION. ${subjectMention(item)} is \`ready\` and declares \`Waiting-for: ${wait.text}\`; that is TRUE now (read from the `
        + `${wait.state === "tagged" ? "remote" : "registry"}), so nothing is being waited for and the row is still held. REMOVE: ${remove.join("; ")}. `
        + "If the row needs a LATER condition, write it as the new `Waiting-for:` line instead.",
      causeKey: `${REPORTED_TO}/org-health/held-on-satisfied-order@${discriminator}` };
  });
}

/**
 * A `ready` row held by a native edge onto an open row of `doneWhens` (more than one) done-whens, naming no condition.
 */
export type UmbrellaEdge = { item: import("../wait-condition.ts").WaitItem, blocker: number, doneWhens: number };

/**
 * EVERY UMBRELLA EDGE AMONG THE ITEMS. A blocker that is not among the open rows the tick read is not judged (its done-whens are not known, and an unknown is not an
 * umbrella); a row of one done-when has nothing to choose between. Only the first repository's rows: a `repoKey` row's edge names a row of another tracker.
 */
export function umbrellaEdges({ items }: { items: import("../wait-condition.ts").WaitItem[]; }): UmbrellaEdge[] {
  const rows = items.filter((item) => item.kind === "row" && item.repoKey === undefined);
  const bodyOf = new Map(rows.map((row) => [row.number, row.body]));
  return rows.filter((row) => row.labels.includes(READY_LABEL)).flatMap((item) => (item.blockers ?? []).flatMap((blocker) => {
    const body = bodyOf.get(blocker);
    const edge = body === undefined ? null : umbrellaEdge({ holderBody: item.body, blocker: { number: blocker, body } });
    return edge ? [{ item, blocker, doneWhens: edge.doneWhens }] : [];
  }));
}

/** ONE ORDER PER UMBRELLA EDGE, to `product-manager`. It says what the edge is waiting for (ALL of the blocker's done-whens) and the two ways out. */
export function umbrellaEdgeOrders(edges: UmbrellaEdge[], { limit }: { limit: number; }): any[] {
  return edges.slice(0, limit).map(({ item, blocker, doneWhens }) => {
    const discriminator = `${item.number}:${blocker}`;
    return { session: REPORTED_TO, cause: "org-health", subject: `umbrella-edge-${item.number}`, discriminator,
      prompt: `AN EDGE ONTO AN UMBRELLA ROW. #${item.number} is \`ready\` and held by a native \`blocked-by\` edge onto #${blocker}, a row of ${doneWhens} done-whens; the edge `
        + `clears only when #${blocker} CLOSES, which is when ALL ${doneWhens} are done, and it does not say which one this row needs. WRITE THE CONDITION INSTEAD: `
        + "a `Waiting-for:` line (`published <pkg>@<dist-tag>`, `<pkg> latest = next`, `tagged <tag>`, `closed #n`, `merged #n`) and remove the edge; or, if the row "
        + `really waits on #${blocker} whole, name the done-when with \`Waits-on-done-when: ${blocker}.<k>\`.`,
      causeKey: `${REPORTED_TO}/org-health/umbrella-edge-order@${discriminator}` };
  });
}
