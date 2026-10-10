// @ts-check
// THE GITHUB ADAPTER OF THE TICKET PORT (ADR 0046; agent-org#484). The only file under `src/ticket-port/` that speaks `gh`, and the one place a
// label string is written or compared on the port's behalf: ADR 0046 decision 5's table is `STATE_LABEL`, `FLAG_LABEL` and `STATUS_OF` below.
//
// IT NEVER SPAWNS ANYTHING ITSELF. `run` is handed in -- the gate's `defaultRun`, with its timeout, its identity and its call census -- so a read
// made here is counted and bounded exactly as the read it replaced was, and a test hands a stub. Only modules `work-gate.ts` already imports
// are imported here, so the gate keeps its documented property of running before any `pnpm install` or build.
import type { ApiBudget, ChangeRef, Decision, EventFilter, ItemEvent, ItemRef, ItemRelations, OpenItemSummary, OpenItemsReader, PortEvent,
  StateChange, TicketFlag, TicketItem, TicketPort, TicketState } from "./port.ts";
import { poolFromRateLimitField } from "../api-pool.ts";
import { CLAIM_LABEL, READY_LABEL } from "../claim-labels.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL, LANE_PREFIX, OUT_OF_RELEASE_LABEL } from "../project-vocabulary.ts";
import { parseWaits } from "../wait-condition.ts";
import { notBeforeDate } from "../waiting-condition.ts";

export const TRACKER = "github";

// --- ADR 0046 decision 5: the labels-as-state conventions, as ONE table ------------------------------------------------------------------

const PARKED = "parked";
/** The state labels. `in-review` and `done` have none: a pull request and a merge are what they are, and the board Status says it. */
const STATE_LABEL: Readonly<Partial<Record<TicketState, string>>> = Object.freeze({
  backlog: BACKLOG_LABEL, ready: READY_LABEL, "in-progress": CLAIM_LABEL, parked: PARKED,
});
const STATE_OF_LABEL = new Map<string, TicketState>(Object.entries(STATE_LABEL).map(([state, label]) => [label as string, state as TicketState]));
/** The board Status each state is written as. `null` is a state the board has no option the code writes today (`board-status-health.ts`'s `WRITTEN_STATUSES`). */
const STATUS_OF: Readonly<Record<TicketState, string | null>> = Object.freeze({
  backlog: "Backlog", ready: "Ready", "in-progress": "In progress", "in-review": null, done: "Done", parked: null,
});
const STATE_OF_STATUS = new Map<string, TicketState>([["Backlog", "backlog"], ["Ready", "ready"], ["In progress", "in-progress"],
  ["In review", "in-review"], ["Done", "done"], ["Parked", "parked"]]);

const CHAIRMAN_PRIORITY_LABEL = "priority:chairman";
/** The port's own spelling of `lane:<owner>` (ADR 0046 decision 1). The label's prefix is the project's (`LANE_PREFIX`), so the two may differ. */
const LANE_FLAG_PREFIX = "lane:";
const SAME_NAME_FLAGS = ["priority", "hold", OUT_OF_RELEASE_LABEL] as const;

/** A flag as the label that carries it. */
export function labelOfFlag(flag: TicketFlag): string {
  if (flag === "chairman-priority") return CHAIRMAN_PRIORITY_LABEL;
  if (flag.startsWith("answer-owed:")) return `${ANSWER_PREFIX}${flag.slice("answer-owed:".length)}`;
  if (flag.startsWith(LANE_FLAG_PREFIX)) return `${LANE_PREFIX}${flag.slice(LANE_FLAG_PREFIX.length)}`;
  return flag; // `priority`, `hold` and `out-of-release` are spelled the same in both vocabularies
}

/** A label as the flag it carries, or `null` for a label that is not one. `chairman-priority` is decided by the caller from WHO added it. */
function flagOfLabel(label: string): TicketFlag | null {
  if (label.startsWith(ANSWER_PREFIX) && label.length > ANSWER_PREFIX.length) return `answer-owed:${label.slice(ANSWER_PREFIX.length)}`;
  if (label.startsWith(LANE_PREFIX) && label.length > LANE_PREFIX.length) return `${LANE_FLAG_PREFIX}${label.slice(LANE_PREFIX.length)}`;
  return (SAME_NAME_FLAGS as readonly string[]).includes(label) ? (label as TicketFlag) : null;
}

// --- the reads ---------------------------------------------------------------------------------------------------------------------------

/**
 * Every open row's board membership, in an answer this tick already pays for (#2075, #3448): one connection query carries each row's OWN
 * `projectItems`, never the board listing, which lags minutes behind an add.
 */
export const OPEN_ITEMS_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    # #3448: THE ACCOUNT AND ITS GRAPHQL BUDGET, IN AN ANSWER THIS TICK ALREADY PAYS FOR. \`rateLimit\` is never charged, so the pool-low signal costs no point.
    viewer { login }
    rateLimit { limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title createdAt
          projectItems(first: 10) { totalCount nodes { project { number } } }
        }
      }
    }
  }
`;

/** The pages `readOpenItems` will walk. Beyond this it returns `null`: a partial list is not a reading. */
const OPEN_ITEMS_MAX_PAGES = 10;

/** One item, with what `TicketItem` carries: the labels, the board Status, its relations and the tail of its timeline. */
export const ITEM_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number title body state createdAt author { login }
        labels(first: 100) { nodes { name } }
        projectItems(first: 10) { nodes { project { number } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
        parent { number repository { nameWithOwner } }
        subIssues(first: 50) { nodes { number repository { nameWithOwner } } }
        blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
        closedByPullRequestsReferences(first: 10) { nodes { number repository { nameWithOwner } } }
        timelineItems(last: 30, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt actor { login } label { name } }
            ... on UnlabeledEvent { createdAt actor { login } label { name } }
            ... on IssueComment { createdAt author { login } body }
          }
        }
      }
    }
  }
`;

/** The `<!-- decided-by: ... -->` line `host/gh` appends to a comment (agent-org#486), in the same grammar, so a posted decision is never stamped twice. */
const DECIDED_BY = /<!--\s*decided-by:/;
const HEADER_WORD = /^[A-Za-z0-9._-]{1,64}$/;

export type GithubAdapterOptions = {
  /** `gh`, as the gate runs it: one argument list in, stdout out, throwing on a refusal. */
  run: (args: string[]) => string;
  /** The repository the items are in, `owner/name`. */
  scope: string;
  /** The logins whose `priority:chairman` counts (decision 2): that rule lives here, not in a consumer. */
  chairmanLogins?: readonly string[];
  /** The board Status write. Defaults to the one call `row-claim.ts`'s `moveProjectStatus` makes; #490's cutover passes `moveProjectStatus` itself to keep its snapshot guard (#1275). */
  moveStatus?: (id: number, statusName: string) => void;
};

export type GithubTicketAdapter = TicketPort & OpenItemsReader & { publish(event: PortEvent): void };

/**
 * The adapter. `TicketPort` is the four operations ADR 0046 rules; `OpenItemsReader` is the bulk read `port.ts` explains and keeps apart.
 */
export function githubTicketAdapter(options: GithubAdapterOptions): GithubTicketAdapter {
  const { run, scope, chairmanLogins = [] } = options;
  const [owner, name] = scope.split("/");
  const ref = (id: number): ItemRef => ({ tracker: TRACKER, scope, id });
  const moveStatus = options.moveStatus ?? ((id: number, statusName: string) => {
    run(["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
      "--url", `https://github.com/${scope}/issues/${id}`, "--field", "Status", "--value", statusName]);
  });
  const subscribers = new Set<{ filter: EventFilter; handler: (event: PortEvent) => void }>();

  /** The raw issue node, or `null` when the read was refused, carried errors or named no such issue. */
  function readNode(id: number): any | null {
    try {
      const parsed = JSON.parse(run(["api", "graphql", "-f", `query=${ITEM_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${id}`]));
      const issue = parsed?.errors ? null : parsed?.data?.repository?.issue;
      return issue !== null && typeof issue === "object" && issue.number === id ? issue : null;
    } catch {
      return null;
    }
  }

  const refOf = (node: any): ItemRef => ({ tracker: TRACKER, scope: String(node?.repository?.nameWithOwner ?? scope), id: Number(node?.number) });
  const labelsOf = (node: any): string[] => (node?.labels?.nodes ?? []).map((l: any) => String(l?.name));
  const statusOf = (node: any): string | null => {
    const item = (node?.projectItems?.nodes ?? []).find((n: any) => n?.project?.number === PROJECT_NUMBER);
    return typeof item?.fieldValueByName?.name === "string" ? item.fieldValueByName.name : null;
  };

  /** LABELS DECIDE, the board Status fills in: the labels are what the gate has always claimed on, so a disagreement reads as they say. */
  function stateOf(node: any): TicketState | null {
    if (node.state === "CLOSED") return "done";
    for (const label of labelsOf(node)) {
      const state = STATE_OF_LABEL.get(label);
      if (state !== undefined) return state;
    }
    return STATE_OF_STATUS.get(statusOf(node) ?? "") ?? null;
  }

  /** The newest event adding `label`, whose actor decides `chairman-priority`; `null` when no timeline event shows who added it. */
  const newestAdder = (events: any[], label: string): string | null =>
    events.filter((e) => e.__typename === "LabeledEvent" && e.label?.name === label).at(-1)?.actor?.login ?? null;

  function flagsOf(node: any, events: any[]): TicketFlag[] {
    const flags = new Set<TicketFlag>();
    for (const label of labelsOf(node)) {
      if (label === CHAIRMAN_PRIORITY_LABEL) {
        const adder = newestAdder(events, label);
        if (adder !== null && chairmanLogins.includes(adder)) flags.add("chairman-priority");
        continue;
      }
      const flag = flagOfLabel(label);
      if (flag !== null) flags.add(flag);
    }
    return [...flags];
  }

  function eventsOf(node: any, items: any[]): ItemEvent[] {
    const out: ItemEvent[] = [{ at: String(node.createdAt), actor: node.author?.login ?? null, kind: "item-opened" }];
    for (const e of items) {
      const at = String(e.createdAt);
      if (e.__typename === "IssueComment") {
        if (DECIDED_BY.test(String(e.body ?? ""))) out.push({ at, actor: e.author?.login ?? null, kind: "decision-posted" });
        continue;
      }
      const label = String(e.label?.name ?? "");
      const added = e.__typename === "LabeledEvent";
      if (STATE_OF_LABEL.has(label)) out.push({ at, actor: e.actor?.login ?? null, kind: "state-changed", detail: `${STATE_OF_LABEL.get(label)}${added ? "" : " removed"}` });
      else if (label === CHAIRMAN_PRIORITY_LABEL || flagOfLabel(label) !== null) {
        const flag = label === CHAIRMAN_PRIORITY_LABEL ? "chairman-priority" : flagOfLabel(label);
        out.push({ at, actor: e.actor?.login ?? null, kind: added ? "flag-added" : "flag-removed", detail: String(flag) });
      }
    }
    return out;
  }

  function relationsOf(node: any): ItemRelations {
    const body = String(node.body ?? "");
    const linked: ChangeRef[] = (node.closedByPullRequestsReferences?.nodes ?? [])
      .map((pr: any) => ({ host: TRACKER, id: `${String(pr?.repository?.nameWithOwner ?? scope)}#${pr?.number}` }));
    return {
      blockedBy: (node.blockedBy?.nodes ?? []).filter((b: any) => b?.state !== "CLOSED").map(refOf),
      parent: node.parent ? refOf(node.parent) : null,
      children: (node.subIssues?.nodes ?? []).map(refOf),
      linkedChanges: linked,
      notBefore: notBeforeDate(body),
      waitingFor: parseWaits(body).map((wait) => wait.text),
    };
  }

  function emit(event: PortEvent) {
    for (const { filter, handler } of subscribers) {
      if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) continue;
      if (filter.ref !== undefined && (filter.ref.tracker !== event.ref.tracker || filter.ref.scope !== event.ref.scope || filter.ref.id !== event.ref.id)) continue;
      handler(event);
    }
  }

  /** One open issue's board facts, from its `repository.issues` node. `onBoard` is `null` for a row with more items than the page returned and none of them on the board. */
  function openItemOf(node: any): OpenItemSummary {
    const items = node?.projectItems;
    const found = Array.isArray(items?.nodes) && items.nodes.some((n: any) => n?.project?.number === PROJECT_NUMBER);
    const complete = Array.isArray(items?.nodes) && items.nodes.length >= items.totalCount;
    return { ref: ref(node.number), title: String(node.title ?? ""), openedAtMs: Date.parse(node.createdAt), onBoard: found ? true : complete ? false : null };
  }

  return {
    readItem(target) {
      if (target.tracker !== TRACKER || target.scope !== scope) return null;
      const node = readNode(target.id);
      if (node === null) return null;
      const timeline: any[] = node.timelineItems?.nodes ?? [];
      return {
        ref: target, title: String(node.title ?? ""), body: String(node.body ?? ""), state: stateOf(node), flags: flagsOf(node, timeline),
        relations: relationsOf(node), events: eventsOf(node, timeline),
      } satisfies TicketItem;
    },

    postDecision(target, decision: Decision) {
      for (const [field, value] of [["role", decision.role], ["runId", decision.runId], ["kind", decision.kind]] as const) {
        // NEVER A GUESS: a header is a statement of who decided, and one that cannot be written truthfully is not written (`host/gh`'s own rule).
        if (!HEADER_WORD.test(value)) throw new Error(`postDecision: \`${field}\` must be 1-64 characters of [A-Za-z0-9._-], got ${JSON.stringify(value)}`);
      }
      const body = `${decision.text.trimEnd()}\n\n<!-- decision-kind: ${decision.kind} -->\n<!-- decided-by: ${decision.role} run: ${decision.runId} -->`;
      const out = run(["issue", "comment", String(target.id), "--repo", target.scope, "--body", body]).trim();
      return /#issuecomment-(\d+)/.exec(out)?.[1] ?? out;
    },

    changeState(target, change: StateChange) {
      const node = readNode(target.id);
      if (node === null) throw new Error(`changeState: could not read ${target.scope}#${target.id}, so nothing was written`);
      const have = new Set(labelsOf(node));
      const add = new Set<string>();
      const remove = new Set<string>();
      let status: string | null = null;
      if (change.state !== undefined) {
        const want = STATE_LABEL[change.state];
        for (const label of STATE_OF_LABEL.keys()) if (label !== want && have.has(label)) remove.add(label);
        if (want !== undefined && !have.has(want)) add.add(want);
        const named = STATUS_OF[change.state];
        if (named !== null && statusOf(node) !== named) status = named;
      }
      for (const flag of change.addFlags ?? []) if (!have.has(labelOfFlag(flag))) add.add(labelOfFlag(flag));
      for (const flag of change.removeFlags ?? []) if (have.has(labelOfFlag(flag)) && !add.has(labelOfFlag(flag))) remove.add(labelOfFlag(flag));
      if (add.size === 0 && remove.size === 0 && status === null) return false;
      // ONE EDIT FOR THE LABELS, THEN THE BOARD STATUS (decision 1): the labels are what the gate claims on, so they land first.
      if (add.size > 0 || remove.size > 0) {
        const args = ["issue", "edit", String(target.id), "--repo", target.scope];
        if (add.size > 0) args.push("--add-label", [...add].join(","));
        if (remove.size > 0) args.push("--remove-label", [...remove].join(","));
        run(args);
      }
      if (status !== null) moveStatus(target.id, status);
      return true;
    },

    subscribe(filter, handler) {
      // THE TICK IS THE ONE THAT READS GITHUB (#4148), so events are not pulled here: whoever read the tracker publishes what it saw through
      // `publish`, and a subscriber is told as a hint to read again. Nothing polls on a subscriber's behalf.
      const subscription = { filter, handler };
      subscribers.add(subscription);
      return () => { subscribers.delete(subscription); };
    },

    readOpenItems({ onBudget } = {}) {
      const items: OpenItemSummary[] = [];
      try {
        let after: string | null = null;
        for (let page = 0; page < OPEN_ITEMS_MAX_PAGES; page++) {
          const args = ["api", "graphql", "-f", `query=${OPEN_ITEMS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
          if (after !== null) args.push("-f", `after=${after}`);
          const parsed = JSON.parse(run(args));
          const issues = parsed?.errors ? null : parsed?.data?.repository?.issues;
          if (!Array.isArray(issues?.nodes)) return null;
          const budget: ApiBudget | null = page === 0 ? poolFromRateLimitField(parsed.data) : null;
          if (budget !== null) onBudget?.(budget);
          items.push(...issues.nodes.map(openItemOf));
          if (issues.pageInfo?.hasNextPage !== true) return items;
          after = issues.pageInfo.endCursor;
        }
        return null;
      } catch {
        return null;
      }
    },
    // `publish` is the adapter's, not the port's: it is how what a tick read becomes a hint to subscribers.
    publish: emit,
  };
}
