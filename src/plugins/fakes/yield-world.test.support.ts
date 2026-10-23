// A test-support module (A11-160, step 7): the fake code host holding the world the chairman's-yield tests ask the claim about -- the asker, the rows already claimed (`in-progress`, with their Regions), the rows
// carrying `priority:chairman` and who added it last, and the other repository's open pull requests. The host is watched and put where core finds it; the returned calls are the operations asked of it, in order.
import { substituteCodeHost } from "../active.ts";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";
import { watchedRows, type WatchedCall } from "./watched-rows.test.support.ts";

export type YieldWorld = {
  /** rows carrying the label, with who added it last (`null`: the history cannot be read) */
  labelled?: Record<number, string | null>;
  claimed?: { number: number; files: string[]; }[];
  prs?: { number: number; path: string; closes?: number; }[];
  blockedBy?: number[];
  claimedUnreadable?: boolean;
};

export type YieldSeed = { asker: number; tracker: string; otherRepo: string; bodyOf: (...files: string[]) => string; askerFiles: string };

export function holdYieldWorld(world: YieldWorld, { asker, tracker, otherRepo, bodyOf, askerFiles }: YieldSeed): WatchedCall[] {
  const host = createFakeCodeHost();
  const w = host.rowsWorld;
  w.repo = tracker;
  const labelled = world.labelled ?? {};
  const claimed = new Map((world.claimed ?? []).map((row) => [row.number, row]));
  for (const number of new Set([asker, ...Object.keys(labelled).map(Number), ...claimed.keys()])) {
    const row = claimed.get(number);
    const labels = [...(number === asker ? ["ready"] : []), ...(number in labelled ? ["priority:chairman"] : []), ...(row === undefined ? [] : ["in-progress"])];
    const body = number === asker ? bodyOf(askerFiles) : row === undefined ? "" : bodyOf(...row.files);
    w.rows.set(number, fakeRow(w, number, { title: "A row", labels, body, blockedBy: number === asker ? world.blockedBy ?? [] : [] }));
  }
  for (const [number, actor] of Object.entries(labelled)) {
    w.gate.events.set(Number(number), actor === null ? new Error("HTTP 502") : [{ event: "labeled", label: "priority:chairman", actor, at: "2026-10-10T08:00:00Z" }]);
  }
  w.rules.otherRepos.set(otherRepo, new Map((world.prs ?? []).map((pr) => [pr.number, { number: pr.number, body: pr.closes === undefined ? "" : `Closes ${tracker}#${pr.closes}\n`, headRefName: `agent/x-${pr.number}`,
    labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-10T08:00:00Z", comments: [], files: [pr.path] }])));
  if (world.claimedUnreadable) w.failures.set("readClaimedRows", new Error("HTTP 502"));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  return watched.calls;
}
