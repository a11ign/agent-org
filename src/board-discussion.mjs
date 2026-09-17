#!/usr/bin/env node
// @ts-check
// command: say whether today's board edition exists as a Discussion (exit 0 yes, 1 no, 2 could not ask)
// THE BOARD EDITION'S CARRIER: a GitHub Discussion, one per date, in the `board-editions` category (#1290).
//
// It was a PDF on a DRAFT release until 2026-09-13, and the chairman moved it for reasons measured that
// day: a draft release creates no tag, is visible only to write-access accounts, and is the least portable
// object on a repository move -- with the transfer two days out. Six releases existed against eight edition
// dates. The WORDS do not change; `board-document.mjs` still produces them. Only the carrier does.
//
// THE CATEGORY IS RESOLVED BY SLUG ON EVERY RUN, NEVER TYPED AS AN ID. An id is per-repository; the transfer
// creates a new repository, where "Board editions" has to be created again by hand -- no API mutation
// creates a category -- and it gets a new id there. An id written into this file would point at nothing.
//
// AND AN ABSENT CATEGORY REFUSES. It does not fall back to General and does not post uncategorised: a board
// document published into the wrong category looks exactly like success, which is the failure this row was
// filed to remove, one level down.
//
//   node packages/agent-org/src/board-discussion.mjs --exists     the workflow's republish precondition
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { gh, REPO } from "./board-data.mjs";

export const EDITION_CATEGORY_SLUG = "board-editions";

/**
 * THE DATE AN EDITION IS FILED UNDER, IN LONDON -- decided here ONCE (#1302), and imported by every script
 * that names an edition's day: the Discussion's title, the republish gate, the summary file the render reads,
 * and the summary check that warns when it is missing.
 *
 * LONDON, NOT UTC, because the edition's day is the board's day, and between 00:00 and 01:00 London in
 * summer the two differ. This was a UTC slice until #1302, while `board-summary-check.mjs` already asked for
 * London's day for exactly that reason, so two copies of "today" disagreed for one hour a night. Measured on
 * #1295's review: a republish dispatched at 00:30 London found YESTERDAY's Discussion and was permitted. Its
 * freshness refusal then told the operator to rewrite the summary, and doing so updated yesterday's edition.
 * At the scheduled 08:13 London run the two zones agree, so nothing that runs on schedule changes.
 *
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD in Europe/London
 */
export const editionDay = (now = new Date()) => new Intl.DateTimeFormat("en-CA",
  { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** ONE POST PER DATE, TITLED BY THE DATE -- the title is the key both republish and the late path look up.
 * @param {string} day */
export const editionTitle = (day) => `Board report — ${day}`;

/** @typedef {(args: string[]) => string} Run */

const [OWNER, NAME] = REPO.split("/");

// `first:50` bounds CATEGORIES, of which the repository has seven. `first:100` bounds EDITIONS, newest first,
// and one arrives per date -- so today's is among them unless a hundred were created after it.
const CATEGORIES = "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id "
  + "discussionCategories(first:50){ nodes{ id slug } } } }";
const EDITIONS = "query($owner:String!,$name:String!,$categoryId:ID!){ repository(owner:$owner,name:$name){ "
  + "discussions(first:100,categoryId:$categoryId,orderBy:{field:CREATED_AT,direction:DESC}){ "
  + "nodes{ id title url } } } }";
const CREATE = "mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){ createDiscussion("
  + "input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){ discussion{ url } } }";
const UPDATE = "mutation($discussionId:ID!,$body:String!){ "
  + "updateDiscussion(input:{discussionId:$discussionId,body:$body}){ discussion{ url } } }";

/**
 * `gh api graphql` exits non-zero on a GraphQL error as well as on a refused request, and `execFileSync`
 * keeps that status by throwing -- so a failed read reaches the caller as an exception, never as an empty
 * `nodes` list that would read as "no edition yet" and create a second one.
 * @param {Run} run @param {string} query @param {Record<string, string>} vars
 * @returns {any} the response's `data`
 */
function graphql(run, query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push("-f", `${key}=${value}`);
  return JSON.parse(run(args)).data;
}

/**
 * PURE. The category's id, or a refusal saying what to do -- never another category's id.
 * @param {{ id: string, slug: string }[]} nodes @param {string} [slug]
 * @returns {string}
 */
export function categoryIdFor(nodes, slug = EDITION_CATEGORY_SLUG) {
  const found = nodes.find((n) => n.slug === slug);
  if (found) return found.id;
  throw new Error(`REFUSING to publish the board edition: this repository has no Discussion category with `
    + `slug "${slug}" (it has: ${nodes.map((n) => n.slug).join(", ") || "none"}).\n`
    + "Create \"Board editions\" in the repository's Discussions settings. It is a web-UI step for an admin: "
    + "no API mutation creates a category. Nothing was posted, and nothing is posted to another category.");
}

/**
 * PURE. The edition titled for this date, or null. TWO is a refusal: an update has to land on the edition
 * the board already has, and with two of them either choice could be the wrong one.
 * @param {{ id: string, title: string, url: string }[]} nodes @param {string} title
 */
export function editionFor(nodes, title) {
  const matches = nodes.filter((n) => n.title === title);
  if (matches.length > 1) {
    throw new Error(`REFUSING: ${matches.length} Discussions are titled "${title}" `
      + `(${matches.map((n) => n.url).join(", ")}). One post per date is the contract; delete the duplicate by `
      + "hand, then re-run.");
  }
  return matches[0] ?? null;
}

/**
 * The repository, the category and the date's edition if it exists. Every failure THROWS.
 * @param {{ day: string, run?: Run }} opts
 */
export function lookUpEdition({ day, run = gh }) {
  const repository = graphql(run, CATEGORIES, { owner: OWNER, name: NAME }).repository;
  const categoryId = categoryIdFor(repository.discussionCategories.nodes);
  const nodes = graphql(run, EDITIONS, { owner: OWNER, name: NAME, categoryId }).repository.discussions.nodes;
  return { repositoryId: repository.id, categoryId, edition: editionFor(nodes, editionTitle(day)) };
}

/**
 * Create the date's edition, or UPDATE it in place when it exists -- a republish replaces the document the
 * board has rather than adding a second post beside it, as `gh release upload --clobber` did for the PDF.
 * @param {{ day: string, body: string, run?: Run }} opts
 * @returns {{ url: string, action: "created" | "updated" }}
 */
export function publishEdition({ day, body, run = gh }) {
  const { repositoryId, categoryId, edition } = lookUpEdition({ day, run });
  if (edition) {
    graphql(run, UPDATE, { discussionId: edition.id, body });
    return { url: edition.url, action: "updated" };
  }
  const created = graphql(run, CREATE, { repositoryId, categoryId, title: editionTitle(day), body });
  return { url: created.createDiscussion.discussion.url, action: "created" };
}

/**
 * Does the date's edition exist? A FAILED LOOKUP READS AS "YES", deliberately: the late path asks this to
 * stop a late edition CREATING a document beside one the board already has, so the safe answer when GitHub
 * cannot be asked is the one that refuses. The reason is printed, so the refusal is not a mystery.
 * @param {{ day: string, run?: Run, warn?: (line: string) => void }} opts
 */
export function todaysEditionExists({ day, run = gh, warn = (line) => console.error(line) }) {
  try {
    return lookUpEdition({ day, run }).edition !== null;
  } catch (error) {
    warn("Could not ask whether today's edition exists, so answering YES (the answer that refuses): "
      + String(/** @type {Error} */ (error)?.message ?? error));
    return true;
  }
}

const EXIT_ABSENT = 1;
const EXIT_CANNOT_ASK = 2;

function main() {
  refuseUnknownFlags(["--exists"], { entry: import.meta.url, command: "node packages/agent-org/src/board-discussion.mjs" });
  if (!process.argv.includes("--exists")) {
    console.error("usage: node packages/agent-org/src/board-discussion.mjs --exists");
    process.exit(EXIT_CANNOT_ASK);
  }
  const day = editionDay();
  let found;
  try {
    found = lookUpEdition({ day });
  } catch (error) {
    // THE STATUS DISCRIMINATES. The republish step refuses on 1 and 2 alike, but "absent" and "could not
    // ask" send the reader to different places, so they are different codes as well as different words.
    console.error(`CANNOT ASK whether the ${day} board edition exists: `
      + String(/** @type {Error} */ (error)?.message ?? error));
    process.exit(EXIT_CANNOT_ASK);
  }
  if (!found.edition) {
    console.error(`No board edition titled "${editionTitle(day)}" in "${EDITION_CATEGORY_SLUG}".`);
    process.exit(EXIT_ABSENT);
  }
  process.stdout.write(`${found.edition.url}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
