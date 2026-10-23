// @ts-check
// module: the tracker contract's suite (A11-158) -- `runTrackerConformance(source, probe)` is the only definition of "a tracker"
//
// EVERY IMPLEMENTATION'S OWN TEST CALLS THIS, so "does Linear honour `read`" and "does the next tracker" are one question with one answer. A tracker cannot be asked
// offline what it holds, so the caller seeds the state the probe names: a ticket the tracker has (`known`), a key it has none of (`missing`) and, for the checks that
// write, a second ticket (`other`). The suite writes only to what the probe names, and only through operations the implementation has.
//
// CONTRACT 1.4 (A11-173) adds the optional `comment`: one call posts one comment on a ticket in any state, and the suite checks that it is no error on the known ticket and refused for a ticket the tracker has none of.
// CONTRACT 1.3 (A11-167) adds the optional `texts` and `detachPlan`, and `updatedAt` of a ticket: `texts` answers the description a `read` gives with a time, and `detachPlan` of a title the ticket has no attachment under is no error.
// CONTRACT 1.2 (A11-168) adds the optional `claim` and `claims`, checked together: a claim is read back as the latest, and a repeated one changes nothing.
// CONTRACT 1.1 (A11-159): a tracker also declares what a new-ticket run files with (`TrackerWriting`, the plugin's manifest data). The caller passes it, and the suite checks that it
// hangs together the way the hook and the brief use it: the tools it grants are covered by its filing pattern, a creation with an `id` is refused, a created key is read back by
// the declared shape, and every priority has a number, `none` being 0.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIORITIES, type Ticket, type TicketSource, type TrackerWriting } from "../contracts/tracker.ts";
import { createdKeyOf } from "../../ticket-mode/writer.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isObject, isString, runChecks } from "./suite.ts";

/** What the caller has seeded: the key of a ticket the tracker holds, a key it holds none of, and a second ticket the write checks may relate to the first. */
export type TrackerProbe = Readonly<{ known: string; missing: string; other?: string }>;
type Subject = Readonly<{ source: TicketSource; probe: TrackerProbe; writing?: TrackerWriting }>;

const REQUIRED_OPERATIONS = ["assigned", "read", "download"] as const;
const TICKET_STRINGS = ["key", "title", "description", "url", "branch", "status", "team"] as const;

/** A ticket as the board reads it: its text fields, its order and priority as numbers, and its parent as a key or null. */
function expectTicket(value: unknown, where: string): asserts value is Ticket {
  expect(isObject(value), `${where} is not a ticket object`);
  for (const field of TICKET_STRINGS) expect(isString(value[field]), `${where}.${field} must be text`);
  expect(typeof value.statusOrder === "number", `${where}.statusOrder must be a number`);
  expect(typeof value.priority === "number", `${where}.priority must be a number`);
  expect(value.parent === null || isString(value.parent), `${where}.parent must be a ticket key or null`);
}

const has = (name: keyof TicketSource) => (subject: Subject): boolean => typeof subject.source[name] === "function";
const optional = (name: keyof TicketSource, run: Conditional<Subject>["run"]): Conditional<Subject> => ({ applies: has(name), reason: `the tracker has no ${name}, which is optional`, run });

async function expectMap(promise: Promise<unknown>, what: string): Promise<Map<unknown, unknown>> {
  const value = await promise;
  expect(value instanceof Map, `${what} must resolve a Map`);
  return value;
}

/** Runs `use` with a scratch directory, and removes it: `download` writes into one. */
async function withScratch(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tracker-conformance-"));
  try {
    await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ALWAYS: Readonly<Record<string, (subject: Subject) => unknown>> = {
  "assigned lists tickets": async ({ source }) => {
    const tickets = await source.assigned();
    expect(Array.isArray(tickets), "assigned() must resolve a list");
    tickets.forEach((ticket, index) => expectTicket(ticket, `assigned()[${index}]`));
  },
  "read answers a ticket by its key": async ({ source, probe }) => {
    const ticket = await source.read(probe.known);
    expectTicket(ticket, `read(${probe.known})`);
    expect(ticket.key === probe.known, `read(${probe.known}) answered the ticket ${ticket.key}`);
  },
  "read answers null for a key the tracker has none of": async ({ source, probe }) => {
    expect((await source.read(probe.missing)) === null, `read(${probe.missing}) must resolve null for a key with no ticket, not a guess`);
  },
  "download returns the paths it fetched": async ({ source, probe }) => {
    const ticket = await source.read(probe.known);
    expectTicket(ticket, `read(${probe.known})`);
    await withScratch(async (dir) => {
      const paths = await source.download(ticket, dir);
      expect(Array.isArray(paths) && paths.every(isString), "download() must resolve a list of paths");
    });
  },
};

const declared = (subject: Subject): TrackerWriting => {
  expect(subject.writing !== undefined, "the check applies only when the tracker declares its writing");
  return subject.writing;
};
const withWriting = (run: (writing: TrackerWriting) => void): Conditional<Subject> => ({
  applies: (subject) => subject.writing !== undefined, reason: "the caller passed no writer tooling (tracker contract 1.1)", run: (subject) => run(declared(subject)),
});

/** What a creation's answer looks like in the shape the tracker declares: the first field, under the wrapper when there is one. */
const answerIn = ({ createdKey }: Pick<TrackerWriting, "createdKey">, key: string): unknown => (createdKey.wrapper === null ? { [createdKey.fields[0]]: key } : { [createdKey.wrapper]: { [createdKey.fields[0]]: key } });

const WRITING: Readonly<Record<string, Conditional<Subject>>> = {
  "writing grants the create and attach tools, and its filing pattern covers every one": withWriting((writing) => {
    const filing = new RegExp(writing.filingTools);
    for (const tool of [writing.createTool, ...writing.attachTools]) expect(filing.test(tool), `filingTools must cover the granted tool ${tool}, or a build worker could call it`);
    expect(!writing.attachTools.includes(writing.createTool), "the create tool is not also an attach tool");
  }),
  "writing refuses a creation that names an id, which would update a ticket": withWriting((writing) => {
    expect(writing.refusedInputs.some(({ input }) => input === "id"), "refusedInputs must name `id`: a new-ticket run creates tickets and never updates one (A11-135)");
  }),
  "writing reads a created ticket's key back by the shape it declares": withWriting((writing) => {
    for (const field of writing.createdKey.fields) {
      const shape = { createdKey: { ...writing.createdKey, fields: [field] } };
      expect(createdKeyOf(answerIn(shape, "ABC-1"), writing.createdKey) === "ABC-1", `createdKey must read the key from an answer that names it as ${field}`);
    }
    expect(createdKeyOf({ content: "created" }, writing.createdKey) === null, "an answer with no key reads as none, so the hook refuses to record it");
  }),
  "writing numbers every priority, and none is 0": withWriting((writing) => {
    for (const name of PRIORITIES) expect(Number.isInteger(writing.priorities[name]), `priorities.${name} must be a whole number`);
    expect(writing.priorities.none === 0, "priorities.none must be 0: a ticket the form gave no priority has none");
  }),
};

const CONDITIONAL: Readonly<Record<string, Conditional<Subject>>> = {
  "viewer names the person whose key this is": optional("viewer", async ({ source }) => {
    const name = await source.viewer?.();
    expect(isString(name) && name !== "", "viewer() must resolve a name");
  }),
  "me names the person by id and name": optional("me", async ({ source }) => {
    const me = await source.me?.();
    expect(isObject(me) && isString(me.id) && isString(me.name), "me() must resolve { id, name }");
  }),
  "people counts who holds the open tickets": optional("people", async ({ source }) => {
    const held = await source.people?.();
    expect(isObject(held) && Array.isArray(held.people) && typeof held.unassigned === "number" && typeof held.total === "number", "people() must resolve { people, unassigned, total }");
  }),
  "scoped pages a scope's tickets": optional("scoped", async ({ source }) => {
    const page = await source.scoped?.("anyone", null);
    expect(isObject(page) && Array.isArray(page.tickets) && (page.next === null || isString(page.next)), "scoped() must resolve { tickets, next }, with next null at the end");
  }),
  "stateTypes answers a Map of the keys it knows": optional("stateTypes", async ({ source, probe }) => {
    const types = await expectMap(source.stateTypes!([probe.known, probe.missing]), "stateTypes()");
    expect(isString(types.get(probe.known)), `stateTypes() must name the state type of ${probe.known}`);
    expect(!types.has(probe.missing), `stateTypes() must leave out ${probe.missing}, which the tracker has none of`);
  }),
  "texts answers each key's description and updatedAt, as read gives the description, and leaves out a key with no ticket": optional("texts", async ({ source, probe }) => {
    const texts = await expectMap(source.texts!([probe.known, probe.missing]), "texts()");
    const text = texts.get(probe.known) as { description?: unknown; updatedAt?: unknown } | undefined;
    expect(isObject(text) && isString(text.description) && isString(text.updatedAt) && !Number.isNaN(Date.parse(text.updatedAt)), `texts() must give ${probe.known} as { description, updatedAt }, the time an ISO time`);
    expect(text.description === (await source.read(probe.known))?.description, `texts() must give the description read(${probe.known}) gives`);
    expect(!texts.has(probe.missing), `texts() must leave out ${probe.missing}, which the tracker has none of`);
  }),
  "detachPlan of a title the ticket has no attachment under changes nothing and is no error": optional("detachPlan", async ({ source, probe }) => {
    const before = await source.read(probe.known);
    await source.detachPlan!(probe.known, ["conformance-no-such-plan.md"]);
    await source.detachPlan!(probe.known, ["conformance-no-such-plan.md"]);
    const after = await source.read(probe.known);
    expect(JSON.stringify(before?.uploads ?? []) === JSON.stringify(after?.uploads ?? []), "detachPlan must leave the attachments it was not asked to remove as they were");
  }),
  "pullStates answers a Map by key": optional("pullStates", async ({ source, probe }) => {
    await expectMap(source.pullStates!([probe.known]), "pullStates()");
  }),
  "blockers answers a Map, leaving out a key with no ticket": optional("blockers", async ({ source, probe }) => {
    const blockers = await expectMap(source.blockers!([probe.known, probe.missing]), "blockers()");
    expect(!blockers.has(probe.missing), `blockers() must leave out ${probe.missing}, which the tracker has none of`);
  }),
  "projectSummaries answers a Map, leaving out a key with no project": optional("projectSummaries", async ({ source, probe }) => {
    const summaries = await expectMap(source.projectSummaries!([probe.known, probe.missing]), "projectSummaries()");
    expect(!summaries.has(probe.missing), `projectSummaries() must leave out ${probe.missing}`);
  }),
  "keywords name the words a pull request body is read by": {
    applies: ({ source }) => source.keywords !== undefined,
    reason: "the tracker declares no keywords, so it is read by the defaults",
    run: ({ source }) => expect(isString(source.keywords?.closing) && source.keywords.closing !== "" && isString(source.keywords.nonClosing) && source.keywords.nonClosing !== "", "keywords must be { closing, nonClosing }, each a word"),
  },
  "updateTicketText writes the fields it is given and no others": optional("updateTicketText", async ({ source, probe }) => {
    const before = await source.read(probe.known);
    expectTicket(before, `read(${probe.known})`);
    await source.updateTicketText!(probe.known, { title: `${before.title} (edited)` });
    const after = await source.read(probe.known);
    expectTicket(after, `read(${probe.known})`);
    expect(after.title === `${before.title} (edited)`, "updateTicketText({ title }) must change the title");
    expect(after.description === before.description, "updateTicketText({ title }) must leave the description as it was");
  }),
  "addBlockers records a relation once, and again without error": {
    applies: ({ source, probe }) => typeof source.addBlockers === "function" && typeof source.blockers === "function" && probe.other !== undefined,
    reason: "the tracker has no addBlockers or blockers, or the probe names no second ticket",
    run: async ({ source, probe }) => {
      await source.addBlockers!(probe.known, [probe.other!]);
      await source.addBlockers!(probe.known, [probe.other!]);
      const blockers = await expectMap(source.blockers!([probe.known]), "blockers()");
      const held = blockers.get(probe.known);
      expect(Array.isArray(held) && held.filter((blocker) => blocker.key === probe.other).length === 1, `${probe.other} must block ${probe.known} exactly once after two calls`);
    },
  },
  "claim records the claimant, claims reads the latest one back, and a repeated claim changes nothing": {
    applies: ({ source }) => typeof source.claim === "function" && typeof source.claims === "function",
    reason: "the tracker has no claim or claims, which are optional (contract 1.2)",
    run: async ({ source, probe }) => {
      const claimantOf = async () => (await expectMap(source.claims!([probe.known, probe.missing]), "claims()")).get(probe.known);
      await source.claim!(probe.known, "conformance.a");
      expect(await claimantOf() === "conformance.a", `claims() must name conformance.a for ${probe.known} after claim(${probe.known}, "conformance.a")`);
      await source.claim!(probe.known, "conformance.a");
      expect(await claimantOf() === "conformance.a", "a second claim by the same claimant must leave the latest claim as it was");
      await source.claim!(probe.known, "conformance.b");
      expect(await claimantOf() === "conformance.b", "claims() must name the LATEST claimant: another claimant's claim replaces it");
      expect(!(await expectMap(source.claims!([probe.missing]), "claims()")).has(probe.missing), `claims() must leave out ${probe.missing}, which the tracker has none of`);
    },
  },
  "comment posts on a ticket in any state, and is refused for a key the tracker has none of": optional("comment", async ({ source, probe }) => {
    await source.comment!(probe.known, "commented by the conformance suite");
    let refused = false;
    try {
      await source.comment!(probe.missing, "commented by the conformance suite");
    } catch {
      refused = true;
    }
    expect(refused, `comment() must throw for ${probe.missing}, which the tracker has none of`);
  }),
  "complete finishes a ticket once and leaves a finished one alone": optional("complete", async ({ source, probe }) => {
    await source.complete!(probe.known, "completed by the conformance suite");
    if (typeof source.stateTypes === "function") {
      expect((await source.stateTypes([probe.known])).get(probe.known) === "completed", "complete() must move the ticket to a completed state");
    }
    await source.complete!(probe.known, "completed again");
  }),
};

/**
 * Runs every check against `source`, so one run reports EVERY way a tracker is wrong. `writing` is the plugin's manifest data (contract 1.1); the checks of it are skipped without.
 * @throws ContractError listing each failed check
 */
export function runTrackerConformance(source: TicketSource, probe: TrackerProbe, writing?: TrackerWriting): Promise<ConformanceResult> {
  return runChecks("tracker", { source, probe, writing }, {
    shape: ({ source: candidate }) => expect(hasFunctions(candidate, REQUIRED_OPERATIONS), `a tracker is an object with ${REQUIRED_OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
    conditional: { ...CONDITIONAL, ...WRITING },
  });
}
