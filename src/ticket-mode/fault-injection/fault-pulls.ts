// @ts-check
// no-token: none -- the pull requests are the code host contract's in-memory fake's; nothing reaches GitHub
// module: the pull requests a fault-injection scenario's runs open, and how GitHub moves them between the board's passes (A11-439)
//
// THE CODE HOST IS THE CONTRACT'S IN-MEMORY FAKE, UNWRAPPED. Every fault here is something GitHub says through the contract's own fields, seeded on the fake as a test of the pool seeds it: a cancelled run of a required check that holds
// an approved, armed pull request BLOCKED (`blocked`, `cancelledRequired`, contract 1.28), and a removal from the merge queue (`queue.removals`, contract 1.21, with the failing `merge_group` run behind it). So the host the board reads is
// the fake that passes the code host conformance suite (`fault-pulls.test.ts` runs the suite on a fake seeded this way), and no member of it is replaced.
//
// THE TRACKER LINKS EACH PULL REQUEST, AS LINEAR'S GITHUB INTEGRATION DOES. A pull request opened for a run is linked on its ticket open, and linked merged when it merges: the board reads a merge from the tracker
// (`refreshTracker`, `pullStates`), not from the code host.
//
// GITHUB ANSWERS WHAT THE BOARD ASKED. After each pass, {@link PullWorld.step} moves every pull request one step, as GitHub would have in the meantime: a rerun the board asked for of a cancelled run goes green (unless the fault cancels every
// run of that check), a pull request the board asked the arm bot to arm again is back in the merge queue, and an approved, armed pull request that nothing blocks merges. Nothing else moves it, so a pull request the board does nothing for
// stays where the fault left it, and the report says whether the board said why.
import type { FailingCheck, QueueRemoval } from "../../plugins/contracts/code-host.ts";
import { createFakeCodeHost, fakePullUrl, queueFailureKey } from "../../plugins/fakes/code-host.ts";
import type { createFakeTracker } from "../../plugins/fakes/tracker.ts";

/** The repository the fixture's pull requests are opened in. */
export const FIXTURE_REPOSITORY = "fixture/app";

/** The fake code host a fixture instance's board reads. */
type FixtureCodeHost = ReturnType<typeof createFakeCodeHost>;

/** What a fault does to a pull request's check: cancelled once, so the board's rerun goes green, or cancelled on every run, so no rerun helps. */
type Cancelling = "once" | "always";

/** The fake tracker a fixture instance's board reads, which links each pull request to its ticket. */
type FixtureTracker = Pick<ReturnType<typeof createFakeTracker>, "linkPull">;

/** A pull request of a run, as the fixture opened it: its ticket, its address, and the fault on its check, if any. */
type Pull = { key: string; url: string; cancelling?: Cancelling };

/** The account GitHub's merge queue removes pull requests as. */
export const QUEUE_ACTOR = "github-merge-queue[bot]";

/** The log of a job that failed before the code ran: the registry did not list a version published minutes before (A11-295, a11ign/agent-org#1939), as pnpm reports it. */
const REGISTRY_LOG = ["##[group]Run pnpm install --frozen-lockfile", " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @typescript-eslint/types@8.72.1", "##[error]Process completed with exit code 1."].join("\n");

/** The address of the job page of a run of a check on a pull request's head. PURE. */
const jobUrl = (number: number, run: number): string => `https://github.com/${FIXTURE_REPOSITORY}/actions/runs/${number}00${run}/job/${number}00${run}1`;

/** The pull request number of `key`'s run: the digits of its key. PURE. */
const numberOf = (key: string): number => Number(key.replace(/\D/g, ""));

/** The head commit of pull request `number`: a full commit id, so the card's short form names the pull request. PURE. */
const headOf = (number: number): string => `f1c5${String(number).padStart(4, "0")}`.padEnd(40, "0");

/** The merge group commit the merge queue tested pull request `number` in when it removed it. PURE. */
export const groupCommitOf = (number: number): string => `9e0c${String(number).padStart(4, "0")}`.padEnd(40, "0");

/** The pull requests a fixture's runs open, over `host`, linked on `tracker`, and how GitHub moves them. */
export function pullWorld(host: FixtureCodeHost, tracker: FixtureTracker) {
  const pulls = new Map<string, Pull>();
  const at = (url: string) => host.pullAt(url)!;
  /** Opens `key`'s pull request at `now`: approved at its head, armed, its checks green. Returns its address. */
  const open = (key: string, now: number): string => {
    const number = numberOf(key);
    const head = headOf(number);
    const { url } = host.seedPull(FIXTURE_REPOSITORY, number, {
      head, files: [`src/${key.toLowerCase()}.ts`], reviews: [{ author: "fixture-reviewer", state: "APPROVED", commit: head, at: now }], merge: { armed: true, mergeable: true },
      feedback: { verdictAtHead: "approved", reviewDecision: "approved", approvedAtHead: true, armed: true, blocked: false },
    });
    pulls.set(url, { key, url });
    tracker.linkPull(key, url, "open");
    return url;
  };
  /** `url`'s required check `gate` has a run cancelled by its concurrency group, which holds the pull request BLOCKED; `cancelling` says whether a rerun is cancelled too. */
  const cancelCheck = (url: string, cancelling: Cancelling): void => {
    const pull = pulls.get(url)!;
    pull.cancelling = cancelling;
    const cancelled: FailingCheck = { name: "gate", detailsUrl: jobUrl(at(url).number, 1) };
    Object.assign(at(url).feedback, { blocked: true, cancelledRequired: [cancelled] });
  };
  /** The merge queue removes `url` now, for `removal`'s reason. A removal for failed checks is the registry's: the install failed before the code ran. */
  const eject = (url: string, removal: Pick<QueueRemoval, "reason" | "actor">, now: number): void => {
    const number = at(url).number;
    const groupCommit = groupCommitOf(number);
    const job = jobUrl(number, 9);
    host.queues.failures.set(queueFailureKey(url, groupCommit), { runId: number, runUrl: job.slice(0, job.indexOf("/job/")), jobs: [{ name: "install", step: "Install", detailsUrl: job }] });
    host.checksAndClaims.logs.set(job, REGISTRY_LOG);
    const removals = at(url).queue?.removals ?? [];
    at(url).queue = { queued: false, removals: [...removals, { at: now, groupCommit, ...removal }] };
  };
  /** Whether the board asked for a rerun of `url`'s cancelled run since the last step. */
  const rerunAsked = (url: string, seen: number): boolean => host.checksAndClaims.runReruns.slice(seen).flat().some((run) => run === jobUrl(at(url).number, 1));
  /** Whether the board asked the arm bot to arm `url` again since the last step. */
  const rearmAsked = (url: string, seen: number): boolean => host.stackMerges.requests.slice(seen).some((request) => fakePullUrl(request.repo, request.number) === url);
  const seen = { reruns: 0, rearms: 0 };
  /** One step of GitHub's, after a pass of the board's. */
  const step = (): void => {
    for (const pull of pulls.values()) {
      const held = at(pull.url);
      if (held.state !== "open") continue;
      if (pull.cancelling === "once" && rerunAsked(pull.url, seen.reruns)) Object.assign(held.feedback, { blocked: false, cancelledRequired: [] });
      if (rearmAsked(pull.url, seen.rearms)) held.queue = { queued: true, removals: held.queue?.removals ?? [] };
      const blocked = held.feedback.blocked === true || held.queue?.queued === false;
      if (blocked) continue;
      held.state = "merged";
      tracker.linkPull(pull.key, pull.url, "merged");
    }
    seen.reruns = host.checksAndClaims.runReruns.length;
    seen.rearms = host.stackMerges.requests.length;
  };
  /** Whether every pull request opened has merged. */
  const allMerged = (): boolean => [...pulls.values()].every(({ url }) => at(url).state === "merged");
  return { open, cancelCheck, eject, step, allMerged };
}

/** The `ready-pr` outcome a run's worker ends with once it opened `url`. PURE. */
export const readyPr = (url: string) => ({ kind: "ready-pr", prs: [{ repo: FIXTURE_REPOSITORY, url }], reason: "fault-injection fixture: the scripted worker opened its pull request" }) as const;
