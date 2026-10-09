// @ts-check
// a11ign/a11ign#4071 (#4055 step zero, last item): CLAUDE CODE'S OWN OPENTELEMETRY, RECEIVED ON THIS HOST AND APPENDED TO THE TRACE STORE -- one record per `claude_code.api_request`,
// `source: "otel"`, `kind: "api_request"`, carrying the ROLE the process was launched with.
//
//   node src/trace/otel-receiver.ts [--port <n>] [--store <path>]
//
// WHY: a transcript turn is attributed by the wake that opened it, so spend that no wake explains (27.5% in #4055's step zero) belongs to no task. The exporter is the one source that says,
// per request, which process spent it: `OTEL_RESOURCE_ATTRIBUTES=org.role=<role>,org.pane=<pane>` is stamped on every event (MEASURED on Claude Code 2.1.294: on the resource AND on each
// log record). The store's header records why this was not the first source (#3494): no file exporter, no receiver on the host, and no way into a seat that is already running.
// THIS FILE IS THE SECOND OF THOSE. The third stays true and is not claimed: a pane keeps the environment it started with, so only a process launched with the variables below is seen.
//
//   CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=none OTEL_EXPORTER_OTLP_PROTOCOL=http/json
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_RESOURCE_ATTRIBUTES=org.role=<role>,org.pane=<pane>
//
// OTLP/HTTP WITH JSON ONLY. Protobuf is the exporters' default and decoding it would take a schema this tool does not otherwise carry, so a protobuf body is REFUSED with 415 and the
// variable that fixes it, never accepted and dropped: an OTLP client does not retry a 4xx, and a 200 for a body nobody read is the silent loss this exists to end.
//
// THE ID IS MADE OF THE REQUEST, NOT OF THE ARRIVAL: `otel:<request_id>` (Anthropic's own id for the API call), so an exporter's retry, or the same payload twice, is one record. A request the
// client reports with no id is REJECTED and counted in the response's `partialSuccess` (OTLP's own channel for it) and on stderr; it is never stored under an id invented from its arrival.
//
// A PAYLOAD WITH NO `org.role` IS STORED, with the role `unattributed`: dropping it would hide the spend, and guessing a role would put it on a task it does not belong to.
// "Unattributed" is a finding about the launcher, and a count of these is how the launcher is checked.
//
// WHAT IS NOT DONE HERE: no row or pull request is derived (`row`/`pr` are null: the role is what the exporter knows, and joining it to a wake or a row is a reader's job, as it is for a
// transcript), and no cost is recomputed. `clientCostUsd` is Claude Code's own `cost_usd`, the CLIENT'S ESTIMATE, kept under a name that says so, because `repriceEvents` reprices `turn`s from
// `PRICES` and the two numbers are to be compared (#4071), not merged. `usage.cacheCreation` is unsplit: OTLP carries no 5-minute/1-hour split, and the store's `Tokens` shape cannot be filled
// without guessing one.
//
// NOT AUTHENTICATED, AND BOUND TO LOOPBACK (127.0.0.1) ONLY, with no flag to change it: any local process can post a record. That is the trust the trace store already has (any local process
// can append to the file), and exposing a port beyond loopback would make it a different statement.
//
// THE STORE IS NOT OPENED, IT IS SCANNED: the file is hundreds of megabytes and `openStore` parses every line of it. The receiver streams it once at start for its own `"source":"otel"` lines
// (the only ids it has to refuse) and appends one line per request after. The transcript ingest appends to the same file with `O_APPEND`, so two writers never interleave inside a line.
import { appendFileSync, createReadStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const UNATTRIBUTED = "unattributed";
export const DEFAULT_PORT = 4318; // OTLP/HTTP's registered port (4317 is gRPC's)
export const LOOPBACK = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024; // a batch of a few requests is a few KiB to tens of KiB; this is only the bound for a body that is not one
const NANOS_PER_MS = 1_000_000n;
const API_REQUEST = "claude_code.api_request";
const HTTP = { ok: 200, badRequest: 400, notFound: 404, methodNotAllowed: 405, tooLarge: 413, unsupported: 415, failed: 500 };

/** `trace.mjs`'s own default, restated because importing that file would run the whole ingest's imports in a long-running service. */
export const defaultStore = () => join(homedir(), ".cache", "a11ign", "trace", "events.ndjson");

/**
 * @typedef {{ id: string, kind: "api_request", source: "otel", at: number, session: string, role: string, pane: string | null, row: null, pr: null, repo: null, cause: null, causeKey: null,
 *   wakeId: null, requestId: string, promptId: string | null, sessionId: string | null, model: string | null,
 *   usage: { input: number | null, output: number | null, cacheRead: number | null, cacheCreation: number | null },
 *   clientCostUsd: number | null, durationMs: number | null }} OtelEvent
 */

/** An OTLP `AnyValue` as a JS value; `undefined` for a kind this reader does not use (arrays, maps). @param {any} value */
function anyValue(value: any) {
  if (value === null || typeof value !== "object") return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue); // OTLP/JSON writes an int64 as a string
  return value.doubleValue ?? value.boolValue;
}

/** @param {any} list an OTLP `KeyValue[]` @returns {Record<string, any>} */
const attributesOf = (list: any): Record<string, any> => Object.fromEntries((Array.isArray(list) ? list : []).map((pair) => [pair?.key, anyValue(pair?.value)]));

/** A finite number or `null`, never 0 for an absent field: a request that reports no `cost_usd` is unknown, not free. @param {any} value */
const numberOrNull = (value: any) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** @param {any} value */
const textOrNull = (value: any) => (typeof value === "string" && value !== "" ? value : null);

/** @param {any} record one OTLP log record @param {Record<string, any>} attributes @returns {number | null} epoch ms */
function timeOf(record: any, attributes: Record<string, any>): number | null {
  const stamped = Date.parse(attributes["event.timestamp"] ?? "");
  if (Number.isFinite(stamped)) return stamped;
  return /^\d+$/.test(String(record?.timeUnixNano ?? "")) ? Number(BigInt(record.timeUnixNano) / NANOS_PER_MS) : null;
}

/**
 * One `api_request` log record as a store event, or the reason it cannot be one. The record's own attributes win over the resource's (the exporter writes `org.role` on both).
 * @param {any} record @param {Record<string, any>} resource @returns {{ event: OtelEvent } | { rejected: string }}
 */
function eventOf(record: any, resource: Record<string, any>): { event: OtelEvent; } | { rejected: string; } {
  const attributes = { ...resource, ...attributesOf(record.attributes) };
  const requestId = textOrNull(attributes.request_id);
  if (requestId === null) return { rejected: "api_request with no request_id" };
  const at = timeOf(record, attributes);
  if (at === null) return { rejected: `api_request ${requestId} with no time` };
  const role = textOrNull(attributes["org.role"]) ?? UNATTRIBUTED;
  return { event: {
    id: `otel:${requestId}`, kind: "api_request", source: "otel", at, session: role, role, pane: textOrNull(attributes["org.pane"]),
    row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null,
    requestId, promptId: textOrNull(attributes["prompt.id"]), sessionId: textOrNull(attributes["session.id"]), model: textOrNull(attributes.model),
    usage: { input: numberOrNull(attributes.input_tokens), output: numberOrNull(attributes.output_tokens), cacheRead: numberOrNull(attributes.cache_read_tokens), cacheCreation: numberOrNull(attributes.cache_creation_tokens) },
    clientCostUsd: numberOrNull(attributes.cost_usd), durationMs: numberOrNull(attributes.duration_ms),
  } };
}

/**
 * The `api_request` events of one OTLP/JSON logs export (`ExportLogsServiceRequest`). Every other event Claude Code exports (a hook, a plugin, a prompt) is not this store's and is skipped.
 * @param {any} payload @returns {{ events: OtelEvent[], rejected: string[] }}
 * @throws {TypeError} when the body is not an OTLP logs export at all
 */
export function eventsOfOtlpLogs(payload: any): { events: OtelEvent[]; rejected: string[]; } {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.resourceLogs)) throw new TypeError("not an OTLP logs export: no resourceLogs array");
  /** @type {OtelEvent[]} */
  const events: OtelEvent[] = [];
  /** @type {string[]} */
  const rejected: string[] = [];
  for (const resourceLog of payload.resourceLogs) {
    const resource = attributesOf(resourceLog?.resource?.attributes);
    const records = (resourceLog?.scopeLogs ?? []).flatMap((/** @type {any} */ scope: any) => scope?.logRecords ?? []);
    for (const record of records.filter((/** @type {any} */ one: any) => one?.body?.stringValue === API_REQUEST)) {
      const made = eventOf(record, resource);
      if ("event" in made) events.push(made.event);
      else rejected.push(made.rejected);
    }
  }
  return { events, rejected };
}

/**
 * The ids of the `source: "otel"` lines already in a store file: a stream, not a parse of the file. A missing file holds none.
 * @param {string} path @returns {Promise<Set<string>>}
 */
export async function loadSeenIds(path: string): Promise<Set<string>> {
  const seen = new Set();
  if (!existsSync(path)) return seen;
  for await (const line of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    if (line.includes('"source":"otel"')) seen.add(JSON.parse(line).id);
  }
  return seen;
}

/** Why a request was refused: the HTTP status and what to tell the exporter's operator. */
class Refusal extends Error {
  /** @param {number} status @param {string} message */
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** @param {import("node:http").IncomingMessage} request @param {number} limit @returns {Promise<string>} */
async function bodyOf(request: import("node:http").IncomingMessage, limit: number): Promise<string> {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Refusal(HTTP.tooLarge, `body over ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** @param {import("node:http").IncomingMessage} request */
function checkRequest(request: import("node:http").IncomingMessage) {
  if (request.url !== "/v1/logs") throw new Refusal(HTTP.notFound, "only POST /v1/logs is received (set OTEL_METRICS_EXPORTER=none)");
  if (request.method !== "POST") throw new Refusal(HTTP.methodNotAllowed, "POST only");
  const type = String(request.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) throw new Refusal(HTTP.unsupported, `content-type "${type}" is not application/json: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
  const encoding = String(request.headers["content-encoding"] ?? "identity");
  if (encoding !== "identity") throw new Refusal(HTTP.unsupported, `content-encoding "${encoding}" is not read: send the body uncompressed`);
}

/**
 * The receiver: an HTTP server (not yet listening) and the ids it already holds. Its `record` appends what the store has not got, as ONE write, and is synchronous so two requests never interleave.
 * @param {{ storePath: string, log?: (line: string) => void, maxBodyBytes?: number }} options
 * @returns {Promise<import("node:http").Server>}
 */
export async function createReceiver({ storePath, log = (line) => process.stderr.write(`${line}\n`), maxBodyBytes = DEFAULT_MAX_BODY_BYTES }: { storePath: string; log?: (line: string) => void; maxBodyBytes?: number; }): Promise<import("node:http").Server> {
  const seen = await loadSeenIds(storePath);
  /** @param {OtelEvent[]} events @returns {number} how many were new */
  const append = (events: OtelEvent[]): number => {
    const fresh = [...new Map(events.filter((event) => !seen.has(event.id)).map((event) => [event.id, event])).values()];
    if (fresh.length === 0) return 0;
    mkdirSync(dirname(storePath), { recursive: true });
    appendFileSync(storePath, fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
    for (const event of fresh) seen.add(event.id); // AFTER the write: a write that threw must leave the retry able to store it
    return fresh.length;
  };
  return createServer(async (request, response) => {
    /** @param {number} status @param {object} body */
    const reply = (status: number, body: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      checkRequest(request);
      const { events, rejected } = parseExport(await bodyOf(request, maxBodyBytes));
      const added = append(events);
      for (const reason of rejected) log(`otel-receiver: rejected ${reason}`);
      log(`otel-receiver: ${events.length} api_request, ${added} new, ${rejected.length} rejected`);
      reply(HTTP.ok, rejected.length === 0 ? {} : { partialSuccess: { rejectedLogRecords: rejected.length, errorMessage: rejected.join("; ") } });
    } catch (error) {
      const status = error instanceof Refusal ? error.status : HTTP.failed;
      log(`otel-receiver: ${status} ${error instanceof Error ? error.message : String(error)}`);
      reply(status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** @param {string} text @returns {ReturnType<typeof eventsOfOtlpLogs>} */
function parseExport(text: string): ReturnType<typeof eventsOfOtlpLogs> {
  /** @type {any} */
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new Refusal(HTTP.badRequest, `body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    return eventsOfOtlpLogs(payload);
  } catch (cause) {
    throw new Refusal(HTTP.badRequest, cause instanceof Error ? cause.message : String(cause));
  }
}

/** @param {string[]} argv @returns {{ port: number, store: string }} */
export function parseArgs(argv: string[]): { port: number; store: string; } {
  const flags = new Map(argv.map((arg) => [arg, /^--(port|store)=(.*)$/.exec(arg)]).map(([arg, match]) => {
    // an unknown flag is refused, not ignored: there is deliberately no `--host`, and `--host=0.0.0.0` must not look accepted
    if (match === null) throw new Error(`unknown argument ${arg}: node src/trace/otel-receiver.mjs [--port=<n>] [--store=<path>]`);
    return [match[1], match[2]];
  }));
  const port = flags.has("port") ? Number(flags.get("port")) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port=${flags.get("port")} is not a port`);
  return { port, store: flags.get("store") ?? defaultStore() };
}

async function main() {
  const { port, store } = parseArgs(process.argv.slice(2));
  const server = await createReceiver({ storePath: store });
  server.listen(port, LOOPBACK, () => process.stdout.write(`otel-receiver: listening on http://${LOOPBACK}:${port}/v1/logs, appending to ${store}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
