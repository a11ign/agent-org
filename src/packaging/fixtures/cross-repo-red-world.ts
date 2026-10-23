// no-token: none -- the world of the fake code host: no `gh`, no network
/**
 * THE FAKE CODE HOST'S WORLD FOR agent-org#992 / #1278: ONE LAB PULL REQUEST WHOSE CROSS-REPO LEG MAY BE RED. Shared by `cross-repo-red-refusal.test.ts` and `cross-repo-red-disarms.test.ts`, which drive `runArmPr`
 * and the sweep's `refusalBeforeArming` over it (A11-160, step 5: those two doors' reads and writes are the code host's, so their tests seed its world instead of answering `gh`'s arguments).
 *
 * lab#81 (a11ign#5078, ADR 0045 cut 1): on its head `e929f712` the check run `checks (cross-repo)` reads `failure` and `gate` reads `success`; the newest `push` run on lab's `main`, 38151939490 at `77283f6e`, has the leg `success`.
 * A read that cannot be made is an `Error` in the map that holds it (`world.ci`), or an operation named in `world.failures`.
 */
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { fakeRow } from "../../plugins/fakes/code-host-rows.ts";
import { fakePull } from "../../plugins/fakes/code-host-pulls.ts";
import { substituteCodeHost } from "../../plugins/active.ts";

export const LAB = "a11ign/lab";
export const PRIMARY = "a11ign/a11ign";
export const LEG = "checks (cross-repo)";
export const STEP = "The tests of this leg";
export const PR_HEAD = "e929f712";
export const PR_RUN = "38150000001";
export const TRUNK_RUN = 38151939490;
export const FILES = ["packages/lab/src/packaging/every-test-file-is-run.test.ts", "packages/lab/src/packaging/layer-edges.test.ts"];
export const BODY = "Closes a11ign/a11ign#5078\n\nADR 0045 cut 1.";
export const DECLARED_BODY = `${BODY}\nCross-repo-red: A11-123\n`;

/** One `FAIL` line in rstest's form (directory, file name and `>` painted apart), for the leg of a synthetic run. */
export const failLine = (file: string, job = LEG) => {
  const slash = file.lastIndexOf("/");
  return `${job}\t${STEP}\t2026-10-11T15:35:54.0000000Z ^[[41m^[[37m^[[1m FAIL ^[[22m^[[39m^[[49m ^[[90m${file.slice(0, slash + 1)}^[[39m^[[36m${file.slice(slash + 1)}^[[39m ^[[2m>^[[22m a test of it`;
};
export const logOf = (...files: string[]) => files.map((file) => failLine(file)).join("\n");

/** Lines 189, 324, 1664-1668, 1697-1702, 1730, 1733 and 1737 of the merge run's failed log for the leg (every line is `job\tstep\ttimestamp text`). */
export const LAB81_LEG_LOG_LINES = [
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:49:32.7573122Z   ^[[33m✓^[[39m A DECLARATION NARROWER THAN THE WALK FAILS THE GUARD'S OWN RUN^[[90m (1.16s)^[[39m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:49:38.5125205Z ^[[90mlog^[[39m^[[90m^[[2m | packages/lab/src/packaging/arm-pr.test.ts > #2391: a FAILED read-back leaves the position unknown, and unknown is not the front^[[22m^[[39m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2542004Z ^[[1mSummary of all failing tests:^[[22m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2542716Z ",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2545830Z ^[[41m^[[37m^[[1m FAIL ^[[22m^[[39m^[[49m ^[[90mpackages/lab/src/packaging/^[[39m^[[36mevery-test-file-is-run.test.ts^[[39m ^[[2m>^[[22m every tracked test file under packages/ is reached by at least one runner glob — the positive control for this emptiness lives in the next test, which asserts the same predicate REPORTS a real file that no glob reaches",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2548985Z ^[[31m^[[1mAssertionError^[[22m^[[39m^[[31m: 1 test file(s) are executed by no runner: packages/lab/scripts/generate-coverage-doc.test.ts",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2550353Z A test outside every runner glob passes by hand and is run by no gate (#1940). Either move it under a path a glob reaches, or grow a glob to include it — the 5 globs in force are:",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2636408Z ^[[90m        at ^[[90mpackages/lab/src/packaging/^[[90m^[[36mevery-test-file-is-run.test.ts^[[90m:127:3^[[39m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2636829Z ",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2637808Z ^[[41m^[[37m^[[1m FAIL ^[[22m^[[39m^[[49m ^[[90mpackages/lab/src/packaging/^[[39m^[[36mlayer-edges.test.ts^[[39m ^[[2m>^[[22m the lab's edges agree with its own baseline: no new edge, no stale entry, every entry well-formed",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2638899Z ^[[31m^[[1mAssertionError^[[22m^[[39m^[[31m: Expected values to be strictly deep-equal:",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2639328Z + actual - expected",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2639468Z ",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2732140Z ^[[90m Test Files^[[39m ^[[1m^[[31m2 failed^[[39m^[[22m^[[2m | ^[[22m^[[1m^[[32m220 passed^[[39m^[[22m^[[90m (222)^[[39m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:41.2777459Z ^[[90m      Tests^[[39m ^[[1m^[[31m2 failed^[[39m^[[22m^[[2m | ^[[22m^[[1m^[[32m2939 passed^[[39m^[[22m^[[2m | ^[[22m^[[33m13 skipped^[[39m^[[90m (2954)^[[39m",
  "checks (cross-repo)\tThe tests of this leg\t2026-10-11T15:52:42.1993362Z ##[error]Process completed with exit code 1.",];
export const LAB81_LEG_LOG = LAB81_LEG_LOG_LINES.join("\n");

export type LabOptions = {
  prLeg?: string | null;             // the PR head's leg conclusion; `null` = the head has no cross-repo check run
  prLog?: string | Error;
  trunkLeg?: string | null;          // the newest trunk run's leg conclusion; `null` = that run has no cross-repo job
  trunkLog?: string | Error;
  comments?: string[];               // comments already on the pull request
  body?: string;
  totalCount?: number;               // how many check runs exist, when a page was not read
  seat?: { armed: boolean; queued: boolean; merged: boolean };
  /** Operations that throw `HTTP 502` when asked: by name. */
  refuse?: string[];
};

/** The fake code host (substituted as the process's) holding lab#81 and what the cross-repo-red verdict reads about it. */
export function labWorld(w: LabOptions = {}) {
  const { prLeg = "failure", prLog = logOf(...FILES), trunkLeg = "success", trunkLog = "", comments = [], body = BODY, seat = { armed: false, queued: false, merged: false } } = w;
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.repo = LAB;
  // The row the pull request closes lives in the primary's tracker, unblocked and with no session label; a bare `#7` of the declaration lives in the lab's.
  world.foreignRows.set(`${PRIMARY}#5078`, fakeRow(world, 5078));
  const pull = fakePull(world, 81, { body, author: "worker-1", headRefOid: PR_HEAD, comments: [...comments], armed: seat.armed, merged: seat.merged });
  if (seat.queued) world.queue.entries = [{ state: "QUEUED", enqueuedAt: "2026-10-13T10:00:00Z", position: 1, headSha: PR_HEAD, pull: 81, pullId: "PR_fake_81" }];
  const checks = [{ name: "gate", conclusion: "success", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/1` },
    ...(prLeg === null ? [] : [{ name: LEG, conclusion: prLeg, details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/114504845032` }])];
  world.ci.checks.set(PR_HEAD, { checks, total: w.totalCount ?? checks.length });
  const common = { head_sha: "77283f6e", status: "completed", html_url: `https://github.com/${LAB}/actions/runs/${TRUNK_RUN}` };
  world.ci.runs.set("ci.yml|event=push", [{ ...common, id: TRUNK_RUN, conclusion: "success", created_at: "2026-10-11T15:35:54Z", event: "push" }]);
  world.ci.runs.set("ci.yml|event=schedule", [{ ...common, id: 38133429541, conclusion: "success", created_at: "2026-10-11T10:51:00Z", event: "schedule" }]);
  world.ci.jobs.set(String(TRUNK_RUN), [{ name: "gate", conclusion: "success" }, ...(trunkLeg === null ? [] : [{ name: LEG, conclusion: trunkLeg }])]);
  world.ci.logs.set(PR_RUN, prLog);
  world.ci.logs.set(String(TRUNK_RUN), trunkLog);
  for (const operation of w.refuse ?? []) world.failures.set(operation, new Error("HTTP 502"));
  substituteCodeHost(host);
  return { host, world, pull };
}
