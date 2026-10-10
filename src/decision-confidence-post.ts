// #4755 (use 1 and 2 of a11ign/a11ign#4627, row 5 of 5): THE DAILY CONFIDENCE READING, POSTED. `provider-confidence.ts` (#4748) counts what the provider was unsure of and prints it for whoever runs it;
// the chairman asked for the reading to be WATCHED ("if it keeps having low confidence, we need to figure out how we give it better confidence"), so this is the module that puts it where he is told things.
//
// IT IS TOLD, NEVER ASKED. The post is an ANNOUNCEMENT (a11ign/a11ign#4742): it asks the chairman nothing and needs no reply. The kind it rides on declares that audience in {@link CONFIDENCE_CONFIG}, in this
// file where a reader meets it, and the test's control is that same declaration set to `ask`. The text never carries a question mark: a reading that ends in "?" is an ask wearing an announcement's clothes.
//
// THREE DESTINATIONS, ONE DECISION EACH, AND THE FIRST TWO ARE THE PROVIDER'S (#4742): with `messaging.announcementsFile` the provider sends an announcement to the channel; with only the chairman chat it
// sends it there, "exactly as every message did before the channel existed"; and with no messaging configured at all it is a comment on the epic, a11ign/a11ign#4627. The route is read off the provider and
// the ledger line, never decided here a second time.
//
// ONE POST PER DAY, AND THE STATE IS WHERE THE POST IS. Through the messenger the key is `summary:provider-confidence:<UTC day>` and the ledger dedupes it (an announcement is never reminded). On the epic the
// day's marker comment is asked for FIRST and a day already there posts nothing, as `board-truth-audit.ts`'s `postDaysTable` does: nothing is kept locally to disagree with the row. So a restart, a second
// host or a tick a minute later is harmless, and the CLI may be run as often as a tick.
//
// NOTHING AT ALL WITHOUT A PROVIDER (chairman, #4627: "the provider stays optional"). No provider declared is not a post saying so: no message, no comment, no ledger line, no output. A host declaration that
// cannot be READ is a different fact and is not reported as that one (`CANNOT POST`, exit 2).
//
// #4750's LINE IS COPIED HERE, AND SAYS SO. `provider-low-confidence.ts` is that row's module and is not merged; its two numbers (more than 30% under the floor on at least 20 decisions) are
// {@link LOW_CONFIDENCE_LINE} below, and when that module lands this file should import its constants rather than carry a second copy.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "@a11ign/toolchain/lib/cli-flags";
import { createMessenger } from "./messaging/core.ts";
import type { MessagingOn } from "./messaging/config.ts";
import { createLedger } from "./messaging/ledger.ts";
import { AUDIENCE } from "./messaging/provider-contract.ts";
import { confidenceReading, DEFAULT_WINDOW_MS, type ConfidenceReading } from "./provider-confidence.ts";

/** The epic the reading is posted on while no messaging is configured. */
export const TRACKER_EPIC = 4627;
/** #4750's line: a question is over it when MORE than `share` of at least `minDecisions` decisions were held back by the floor. */
export const LOW_CONFIDENCE_LINE = Object.freeze({ minDecisions: 20, share: 0.3 });
/**
 * The existing kind this rides on, keyed `summary:provider-confidence:<day>`. `summary` is the one silent kind (a reading is not news that should buzz), is never reminded and has no hold-down. A kind of its
 * own is a change to `event.ts`, `core.ts` and `audience.test.ts`, which this row's Region does not hold.
 */
export const POST_KIND = "summary";
/** THE DECLARATION: this kind is for the chairman to be told. Overridden to `ask` in the test, which is what shows the destination assertions bite. */
export const CONFIDENCE_CONFIG = Object.freeze({ kinds: Object.freeze({ [POST_KIND]: Object.freeze({ audience: AUDIENCE.announcement }) }) });

const PERCENT = 100;
const DAY_LENGTH = 10;
const MINUTE_LENGTH = 16;
const EMPTY_READING = "no provider decisions in the window";
const NOTHING_ASKED = "Told, not asked: nothing here needs an answer.";
const COMMENT_ID = /issuecomment-(\d+)/;
const GH_TIMEOUT_MS = 60_000;

export type Destination = "channel" | "chairman-chat" | "tracker-comment";
export type MessengerConfig = NonNullable<Parameters<typeof createMessenger>[0]["config"]>;
export type Delivery =
  | { via: "messenger"; provider: Parameters<typeof createMessenger>[0]["provider"]; ledger: ReturnType<typeof createLedger>; config?: MessengerConfig }
  | { via: "tracker"; repo: string; run: (args: string[]) => string };
export type PostInput = { reading: ConfidenceReading; providerDeclared: boolean; delivery: Delivery; now: number };
export type PostResult =
  | { posted: true; destination: Destination; ref: string; key: string; text: string }
  | { posted: false; why: "no-provider" | "already-posted" | "not-sent"; detail?: string };

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, DAY_LENGTH);
const minute = (at: number): string => `${new Date(at).toISOString().slice(0, MINUTE_LENGTH)}Z`;
const percent = (share: number): string => `${Math.round(share * PERCENT)}%`;
const figure = (value: number | undefined): string => (value === undefined ? "-" : value.toFixed(2));

/** The rows over #4750's line, as `use/question`: the names the chairman is shown. */
export function questionsOverTheLine(reading: ConfidenceReading, line = LOW_CONFIDENCE_LINE): string[] {
  return reading.rows
    .filter((row) => row.asked >= line.minDecisions && row.underFloorShare > line.share)
    .map((row) => `${row.use}/${row.question}`);
}

function rowText(row: ConfidenceReading["rows"][number]): string {
  const floor = row.floor === undefined ? "the floor not known" : `floor ${row.floor.value}`;
  const other = row.otherFallback > 0 ? `, ${row.otherFallback} other fallback` : "";
  return `${row.use}/${row.question}: ${row.asked} asked, ${percent(row.underFloorShare)} under ${floor}, mean ${figure(row.meanConfidence)}, median ${figure(row.medianConfidence)}${other}`;
}

function lineText(over: readonly string[], line: typeof LOW_CONFIDENCE_LINE): string {
  const rule = `more than ${percent(line.share)} under the floor on at least ${line.minDecisions} asked`;
  return over.length === 0 ? `No question is over the line (${rule}).` : `Over the line (${rule}): ${over.join(", ")}.`;
}

/**
 * THE MESSAGE: one short text per day, the same shape on a quiet day, so a day that changed nothing still says so. Every `?` in it is removed at the end, because a question name or a log-derived string is
 * data and the one property this text must have is that it asks nothing.
 */
export function renderConfidencePost(reading: ConfidenceReading, line = LOW_CONFIDENCE_LINE): string {
  const lines = [`Provider confidence, ${minute(reading.since)} to ${minute(reading.until)}`];
  if (reading.rows.length === 0) lines.push(EMPTY_READING);
  else lines.push(...reading.rows.map(rowText), `${reading.decisions} decision${reading.decisions === 1 ? "" : "s"} asked in the window.`, lineText(questionsOverTheLine(reading, line), line));
  const { count } = reading.unreadable;
  if (count > 0) lines.push(`${count} log line${count === 1 ? "" : "s"} could not be read and ${count === 1 ? "is" : "are"} not in this reading.`);
  lines.push(NOTHING_ASKED);
  return lines.join("\n").replaceAll("?", "");
}

/** The message id the provider returned for this key, from the line the ledger wrote when it was SENT. */
function sentLine(ledger: ReturnType<typeof createLedger>, key: string): Record<string, any> | undefined {
  return ledger.read().filter((line) => line.key === key && line.status === "sent").at(-1);
}

async function postThroughMessenger({ delivery, key, text, now }: { delivery: Extract<Delivery, { via: "messenger" }>; key: string; text: string; now: number }): Promise<PostResult> {
  const { provider, ledger, config = CONFIDENCE_CONFIG } = delivery;
  const messenger = createMessenger({ provider, ledger, now: () => now, config });
  const decisions = await messenger.tick([{ key, kind: POST_KIND, severity: "info", firstSeenAt: now, text }]);
  // `tick` may also flush a held digest first; the answer this post needs is the decision for ITS key.
  const action = decisions.find((decision) => decision.key === key)?.action ?? "none";
  if (action === "duplicate") return { posted: false, why: "already-posted" };
  const line = sentLine(ledger, key);
  if (action !== "sent" || line === undefined) return { posted: false, why: "not-sent", detail: action };
  const toChannel = line.audience === AUDIENCE.announcement && (provider.capabilities.destinations ?? 1) >= 2;
  return { posted: true, destination: toChannel ? "channel" : "chairman-chat", ref: String(line.providerMessageId), key, text };
}

const markerFor = (day: string): string => `<!-- decision-confidence-post: ${day} -->`;

/** A failed ask or a failed post THROWS and the caller says so: a post that could not tell whether the day's comment is there must not guess. */
function postToTracker({ delivery, text, day }: { delivery: Extract<Delivery, { via: "tracker" }>; text: string; day: string }): PostResult {
  const { repo, run } = delivery;
  const marker = markerFor(day);
  const path = `repos/${repo}/issues/${TRACKER_EPIC}/comments?per_page=100&since=${day}T00:00:00Z`;
  const present = run(["api", "--paginate", path, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim();
  if (present !== "") return { posted: false, why: "already-posted" };
  const printed = run(["issue", "comment", String(TRACKER_EPIC), "--repo", repo, "--body", `${marker}\n${text}`]).trim();
  return { posted: true, destination: "tracker-comment", ref: COMMENT_ID.exec(printed)?.[1] ?? printed, key: marker, text };
}

/** THE POST: nothing without a provider; otherwise one announcement for the UTC day of `now`, wherever the delivery sends it. */
export async function postConfidenceReading({ reading, providerDeclared, delivery, now }: PostInput): Promise<PostResult> {
  if (!providerDeclared) return { posted: false, why: "no-provider" };
  const day = utcDay(now);
  const text = renderConfidencePost(reading);
  if (delivery.via === "tracker") return postToTracker({ delivery, text, day });
  return postThroughMessenger({ delivery, key: `${POST_KIND}:provider-confidence:${day}`, text, now });
}

// THE CLI. Everything the host knows is imported when it is needed, as `provider-confidence.ts` does: the reading and its test refuse on no machine for want of `AGENT_ORG_HOST`.
const EXIT = { POSTED_OR_NOTHING_TO_DO: 0, NOT_SENT: 1, CANNOT_POST: 2 };

function cannotPost(message: string): never {
  process.stderr.write(`CANNOT POST: ${message}\n`);
  process.exit(EXIT.CANNOT_POST);
}

/** An absent log is the provider never having been asked; any other failure to read it is not that. */
function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return [];
    return cannotPost(`the decision log could not be read (${(error as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a provider asked nothing.`);
  }
}

async function providerIsDeclared(): Promise<boolean> {
  try {
    return (await import("./host-config.ts")).homeHostConfig().triage?.provider === "jev";
  } catch (error) {
    return cannotPost(`the host declaration could not be read (${(error as Error)?.name ?? "unknown error"}), so whether a provider is declared is not known and nothing was posted.`);
  }
}

async function logPath(): Promise<string> {
  const given = flagValue(process.argv, "log");
  if (given !== undefined) return given;
  const { stateEntryPath } = await import("./host-config.ts");
  const { decisionLogPathFrom } = await import("./decision-provider.ts");
  return decisionLogPathFrom(stateEntryPath("wake-ledger"));
}

/** Messaging configured: the same provider `messaging:watch` builds, plus the channel when `announcementsFile` is declared. */
async function messengerDelivery({ config, now }: { config: MessagingOn; now: number }): Promise<Delivery> {
  const { readSecretFile, SecretFileRefusal } = await import("./messaging/secret.ts");
  const { readAnnouncementsChatId, readChairman, defaultLedgerPath } = await import("./messaging/state.ts");
  const { createTelegramProvider } = await import("./messaging/providers/telegram/send.ts");
  let provider;
  try {
    provider = createTelegramProvider({
      token: readSecretFile(config.tokenFile), chatId: readChairman(config.chairmanFile).chatId,
      announcementsChatId: readAnnouncementsChatId(config.announcementsFile), log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    // A secret file that is refused is a post that cannot be made (exit 2), as a non-integer channel file was before the read moved to `messaging/state.ts`.
    if (error instanceof SecretFileRefusal) return cannotPost(error.message);
    throw error;
  }
  return { via: "messenger", provider, ledger: createLedger({ path: defaultLedgerPath(homedir()), now: () => now }) };
}

async function deliveryFromHost(now: number): Promise<Delivery> {
  const { HOME_CHECKOUT } = await import("./project-config.ts");
  const { MessagingConfigRefusal, readMessagingConfig } = await import("./messaging/config.ts");
  const { trackerRepo } = await import("./messaging/state.ts");
  let config;
  try {
    config = readMessagingConfig(HOME_CHECKOUT);
  } catch (error) {
    // A declaration that cannot be read is not "no messaging configured": the epic is for the second, and posting there would hide the first.
    if (error instanceof MessagingConfigRefusal) return cannotPost(error.message);
    throw error;
  }
  if (!config.enabled) {
    return { via: "tracker", repo: trackerRepo(HOME_CHECKOUT), run: (args) => execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS }) };
  }
  return messengerDelivery({ config, now });
}

async function main(): Promise<void> {
  refuseUnknownFlags(["--log="], { entry: import.meta.url, command: "node src/decision-confidence-post.ts" });
  const now = Date.now();
  // No provider: nothing is read, built or printed. The delivery is not even resolved, so a host with no messaging and no `gh` account is not asked for either.
  if (!await providerIsDeclared()) process.exit(EXIT.POSTED_OR_NOTHING_TO_DO);
  const reading = confidenceReading(readLog(await logPath()), { now, windowMs: DEFAULT_WINDOW_MS });
  const result = await postConfidenceReading({ reading, providerDeclared: true, delivery: await deliveryFromHost(now), now });
  if (result.posted) process.stdout.write(`posted: ${result.destination} ${result.ref}\n`);
  else process.stdout.write(`not posted: ${result.why}${result.detail === undefined ? "" : ` (${result.detail})`}\n`);
  process.exit(result.posted || result.why === "already-posted" ? EXIT.POSTED_OR_NOTHING_TO_DO : EXIT.NOT_SENT);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
