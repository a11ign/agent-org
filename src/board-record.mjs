// @ts-check
// command: write an achievement record, refusing when it would displace one — #577
//
// THE INCIDENT THIS EXISTS FOR. On 2026-09-08 the board document's body sat at exactly 925 words, its
// cap. Two achievement records were added, their bullets 19 and 24 words — precisely the 43-word overage.
// `board-style.test.ts` refused, `trunk-guard` went red on `4e87c875`, and main stayed red until #576
// reverted them. **The next achievement anyone recorded was going to do this**, to whoever recorded it,
// whenever; nothing about those two entries caused it beyond being next.
//
// `bodyCapRefusal` was already good and already thorough — it lists every achievement oldest first with
// the word cost of its bullet, and says which to consider retiring. IT JUST RAN IN THE WRONG PLACE: inside
// `board:document`, at 08:00. The check that turns the trunk red runs on every push. So the person who
// wrote the record learned nothing, and the person who learned was `trunk-guard`, hours later, with the
// chairman reading red merges — the exact hurry the refusal's own comment says this decision must not be
// made in. **A refusal that arrives after the merge cannot stop the merge.**
//
// So this is the WRITE PATH, and it runs the same refusal before the file exists. It does not reimplement
// it: `bodyCapRefusal` is imported, per the row's own instruction.
//
// IT REFUSES; IT NEVER RETIRES. Displacing an old claim for a new one is a judgement about which has
// stopped earning its place, and this tool has no way to make it. It names the candidates, oldest first,
// with their word costs — and stops. A tool that retired the oldest automatically would make that decision
// in the same hurry the refusal exists to prevent, and would do it invisibly.
//
// AND IT WRITES NOTHING WHEN IT REFUSES. "It refused" and "it wrote the record and then complained" are
// indistinguishable from an exit code, and the second leaves the trunk exactly as red as before. The file
// is written after the check passes, never before — see `writeRecord`'s own ordering.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { bodyCapRefusal, document } from "./board-document.mjs";
import { collect, reported } from "./board-data.mjs";

const ROOT = path.resolve(path.dirname(realpathSync(new URL(import.meta.url).pathname)), "..");
const ACHIEVEMENTS_DIR = "docs/board/reported/achievements";

/** The fields a record cannot be written without. `order` and `boardClaim` are optional by design:
 * `board-data.mjs` already defaults an absent `order` to the end and falls back to `claim`. */
const REQUIRED_FIELDS = ["claim", "evidence", "issue", "reportedBy", "at"];

/**
 * Pure: which required fields is this draft missing? NAMED, never counted — a refusal that says "3 fields
 * missing" sends the reader back to the template to work out which, which is the shape #603's owned-path
 * sign-off and #655's refusal rule both already forbid.
 * @param {any} draft
 * @returns {string[]}
 */
export function missingFields(draft) {
  return REQUIRED_FIELDS.filter((f) => {
    const v = draft?.[f];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}

/** How far apart assigned `order` values sit. `board-data.mjs`'s own comment: spacing by tens means
 * inserting between two entries picks a value between them and re-labels nothing. */
const ORDER_STEP = 10;

/**
 * Pure: the records already on disk, as `{ issue, order }` — the only two fields anything enforces
 * uniqueness on, and the two `board-style.test.ts` asserts in one breath.
 * @param {string} dir
 * @returns {{ issue: unknown, order: unknown, file: string }[]}
 */
export function existingRecords(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const body = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    return { issue: body.issue, order: body.order, file: f };
  });
}

/**
 * Pure: the next free `order` — the highest in use plus a step.
 *
 * ASSIGNED RATHER THAN CHECKED, and that is the whole shape of this fix. A writer has no reason to know
 * which values are taken, and requiring them to is how #324's record landed on 40 beside #311's: the cap
 * refusal fired, the cap was cleared, the file was written, and the tree failed
 * `board-style.test.ts`'s "no two recorded entries share an identity or an order". A tool whose stated
 * property is that a record cannot be written into a state the guards reject wrote one.
 * @param {{ order: unknown }[]} records
 */
export function nextFreeOrder(records) {
  const used = records.map((r) => r.order).filter((o) => typeof o === "number");
  return used.length === 0 ? ORDER_STEP : Math.max(...used) + ORDER_STEP;
}

/**
 * Pure: is this draft's identity or explicit `order` already taken? `null` to proceed; a refusal STRING
 * otherwise, naming the record that holds it AND the free value — a refusal that says only "taken" makes
 * the reader go and find what this function already knows.
 *
 * An explicit `order` is HONOURED when free. Deliberate placement is what the field is for, and a tool
 * that overrode it would trade one silent wrong for another.
 * @param {any} draft @param {{ issue: unknown, order: unknown, file: string }[]} records
 * @returns {string | null}
 */
export function collisionRefusal(draft, records) {
  const sameIssue = records.find((r) => r.issue === draft.issue);
  if (sameIssue) {
    return `board:record REFUSES — issue ${draft.issue} already has a record (${sameIssue.file}).\n`
      + "Nothing was written. `board-summary-check.mjs` keys achievements on `issue`, so a second record "
      + "for one issue is two claims wearing one identity. Edit the existing file, or record this under "
      + "the issue it is actually about.";
  }
  if (draft.order === undefined) return null;
  const sameOrder = records.find((r) => r.order === draft.order);
  if (!sameOrder) return null;
  return `board:record REFUSES — order ${draft.order} is already held by ${sameOrder.file}.\n`
    + `Nothing was written. The next free order is ${nextFreeOrder(records)}; omit \`order\` entirely and `
    + "this tool assigns it. `order` decides the document's reading sequence, and two records sharing one "
    + "leave that sequence decided by filename, which is the defect the field exists to remove.";
}

/**
 * Pure: the file this record lands in. Deterministic from the issue number and the claim, so writing the
 * same record twice is visibly the same file rather than a second copy with a different name — the
 * duplicate-record shape `board-summary-check.mjs` keys `achievements` on `issue` to detect.
 * @param {any} draft
 * @returns {string}
 */
export function recordFilename(draft) {
  const digest = createHash("sha256").update(String(draft.claim)).digest("hex").slice(0, 8);
  return `issue-${draft.issue}-${digest}.json`;
}

/**
 * Pure: the decision. `null` to proceed; a refusal STRING to print and stop.
 *
 * THE ORDER MATTERS AND IS ASSERTED BY A TEST. Shape first, cap second: a draft missing its `evidence`
 * would otherwise be reported as "the body is too long", which names a real problem that is not this
 * draft's, and sends the writer to retire somebody else's achievement over their own typo.
 *
 * @param {any} draft
 * @param {(d: any, md: string) => string | null} capRefusal
 * @param {{ data: any, render: (d: any) => string }} board  the board as it would be WITH this draft
 * @param {{ issue: unknown, order: unknown, file: string }[]} [records] the records already on disk
 * @returns {string | null}
 */
export function refusalForDraft(draft, capRefusal, board, records = []) {
  const missing = missingFields(draft);
  if (missing.length > 0) {
    return `board:record REFUSES — this draft is missing ${missing.join(", ")}.\n`
      + "Nothing was written. Every achievement carries the evidence that makes it a capability claim "
      + "rather than an assertion, and a record without it renders as a heading with no body.";
  }
  // COLLISIONS BEFORE THE CAP, DELIBERATELY, and the ordering is asserted. The collision check reads only
  // the files on disk; the cap check reads GitHub through `board-data.mjs`. So a duplicate identity or a
  // taken `order` is refused with no network at all — which matters because on 2026-09-09 the tracker was
  // unreachable for fifteen minutes and a collision should not need a working tracker to detect.
  const collision = collisionRefusal(draft, records);
  if (collision) return collision;
  const cap = capRefusal(board.data, board.render(board.data));
  if (!cap) return null;
  return `${cap}\n\nNOTHING WAS WRITTEN. This is a person's decision, not this tool's: retiring a claim `
    + "is a judgement about which has stopped earning its place, and the list above is oldest first so "
    + "it can be made on age rather than on whoever is in the most hurry. Mark one `\"inBody\": false` "
    + "to retire it from the body (it stays in the record and the appendix), or shorten this draft's "
    + "`boardClaim`, then run this again.";
}

/**
 * The board data as it WOULD be with this draft included — the whole point, since the question is not
 * "does the body fit today" but "does it fit once this is in it".
 * @param {any} draft
 * @param {{ collectData?: typeof collect, reportedData?: typeof reported }} [deps]
 */
export function boardWithDraft(draft, { collectData = collect, reportedData = reported } = {}) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const data = collectData(since);
  const existing = reportedData().achievements ?? [];
  return { ...data, ...reportedData(), achievements: [...existing, draft] };
}

/**
 * Writes the record — ONLY after the refusal has come back `null`. The ordering is the acceptance's own
 * mutation: assert no file was created.
 * @param {any} draft @param {string} dir
 * @param {{ order: unknown }[]} [records] the records already on disk, for assigning a free `order`
 * @returns {{ file: string, order: unknown }} the path written and the order it landed on
 */
export function writeRecord(draft, dir, records = []) {
  // ASSIGNED HERE, not required of the author: a draft with no `order` gets the next free value, and one
  // that names a free value keeps it. `refusalForDraft` has already refused a taken one.
  const body = draft.order === undefined ? { ...draft, order: nextFreeOrder(records) } : draft;
  const file = path.join(dir, recordFilename(body));
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { file, order: body.order };
}

function usage() {
  return "Usage:\n"
    + "  npm run board:record -- --from=<draft.json>   validate, check the body cap, then write it\n"
    + "\nThe draft is the record you intend to add, in the shape `docs/board/reported/achievements/`\n"
    + "already holds: claim, boardClaim, evidence, issue, reportedBy, at, order. It is written into that\n"
    + "directory only if the body still fits with it; otherwise nothing is written and the refusal names\n"
    + "which achievements to consider retiring, oldest first.\n";
}

function main() {
  refuseUnknownFlags(["--from="], { entry: import.meta.url, command: "board-record" });
  const argv = process.argv.slice(2);
  const from = argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);
  if (!from) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  if (!existsSync(from)) {
    process.stderr.write(`board:record: no such draft: ${from}\n`);
    process.exitCode = 2;
    return;
  }
  /** @type {any} */
  let draft;
  try {
    draft = JSON.parse(readFileSync(from, "utf8"));
  } catch (error) {
    process.stderr.write(`board:record: ${from} is not JSON -- ${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const dir = path.join(ROOT, ACHIEVEMENTS_DIR);
  const records = existingRecords(dir);
  const refusal = refusalForDraft(draft, bodyCapRefusal,
    { data: boardWithDraft(draft), render: (d) => document(d, { text: "placeholder for measurement" }) },
    records);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 5;
    return;
  }
  const { file, order } = writeRecord(draft, dir, records);
  process.stdout.write(`board:record wrote ${path.relative(ROOT, file)} at order ${order}\n`
    + "The body still fits with it. Commit it with the change it describes.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
