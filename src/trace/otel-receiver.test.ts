// a11ign/a11ign#4071: the OTel receiver. FIXTURES FROM ONE REAL RUN: `REQUEST` is the body Claude Code 2.1.294 POSTed to /v1/logs for one fresh `claude -p "Reply with the single word: ok" --model haiku`
// (2026-10-08, `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_RESOURCE_ATTRIBUTES=org.role=worker-probe,org.pane=probe-pane`), and `OTHER` is
// the run's first body cut to its `user_prompt` and `hook_registered` events. Both are byte-for-byte what was received EXCEPT that `user.id`, `user.email`, `user.account_uuid`, `user.account_id`
// and `organization.id` are replaced by "REDACTED" (they identify a person, and nothing here reads them). Nothing in them is invented: change a value and you are no longer testing the exporter.
// no-token: gh -- no `gh` call is made; the receiver listens on loopback with port 0 and a temp store.
// THE UNIT'S HOST-UNIT ASSERTIONS ARE NOT HERE: `host-units.ts` reads git history, which CI's acceptance job does not have, and a command that imports it is REFUSED there (a11ign/a11ign#4071); they are in `src/packaging/host-units.test.ts`.
import { TSX_IMPORT } from "../tsx-import.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createReceiver, eventsOfOtlpLogs, LOOPBACK, parseArgs, UNATTRIBUTED } from "./otel-receiver.mjs";
import { Server,IncomingMessage,ServerResponse } from "http";
import { URL } from "url";

const REQUEST = {"resourceLogs":[{"resource":{"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"host.arch","value":{"stringValue":"amd64"}},{"key":"os.type","value":{"stringValue":"linux"}},{"key":"os.version","value":{"stringValue":"7.0.0-38-generic"}},{"key":"service.name","value":{"stringValue":"claude-code"}},{"key":"service.version","value":{"stringValue":"2.1.294"}}],"droppedAttributesCount":0},"scopeLogs":[{"scope":{"name":"com.anthropic.claude_code.events","version":"2.1.294"},"logRecords":[{"timeUnixNano":"1791447318137000000","observedTimeUnixNano":"1791447318137000000","body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"api_request"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:18.137Z"}},{"key":"event.sequence","value":{"intValue":15}},{"key":"prompt.id","value":{"stringValue":"a50257c3-696f-46fc-9f50-5483556d2fac"}},{"key":"model","value":{"stringValue":"claude-haiku-5-5"}},{"key":"input_tokens","value":{"intValue":2}},{"key":"output_tokens","value":{"intValue":4}},{"key":"cache_read_tokens","value":{"intValue":9179}},{"key":"cache_creation_tokens","value":{"intValue":13356}},{"key":"cost_usd","value":{"doubleValue":0.0027651900000000003}},{"key":"cost_usd_micros","value":{"intValue":2765}},{"key":"duration_ms","value":{"intValue":742}},{"key":"ttft_ms","value":{"intValue":729}},{"key":"request_id","value":{"stringValue":"req_011CfpSK96NthX9vPNsW9X2b"}},{"key":"client_request_id","value":{"stringValue":"6c711657-a9c5-4866-a954-d89949d811b5"}},{"key":"speed","value":{"stringValue":"normal"}},{"key":"query_source","value":{"stringValue":"sdk"}},{"key":"effort","value":{"stringValue":"medium"}}],"droppedAttributesCount":0},{"timeUnixNano":"1791447318137000000","observedTimeUnixNano":"1791447318137000000","body":{"stringValue":"claude_code.assistant_response"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"assistant_response"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:18.137Z"}},{"key":"event.sequence","value":{"intValue":16}},{"key":"prompt.id","value":{"stringValue":"a50257c3-696f-46fc-9f50-5483556d2fac"}},{"key":"response_length","value":{"intValue":2}},{"key":"response","value":{"stringValue":"<REDACTED>"}},{"key":"request_id","value":{"stringValue":"req_011CfpSK96NthX9vPNsW9X2b"}},{"key":"message.uuid","value":{"stringValue":"45d22e98-df5d-4769-9f54-d50c668477be"}},{"key":"model","value":{"stringValue":"claude-haiku-5-5"}},{"key":"query_source","value":{"stringValue":"sdk"}}],"droppedAttributesCount":0},{"timeUnixNano":"1791447318146000000","observedTimeUnixNano":"1791447318146000000","body":{"stringValue":"claude_code.mcp_server_connection"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"mcp_server_connection"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:18.146Z"}},{"key":"event.sequence","value":{"intValue":17}},{"key":"prompt.id","value":{"stringValue":"a50257c3-696f-46fc-9f50-5483556d2fac"}},{"key":"status","value":{"stringValue":"disconnected"}},{"key":"transport_type","value":{"stringValue":"http"}},{"key":"server_scope","value":{"stringValue":"user"}},{"key":"duration_ms","value":{"stringValue":"1493"}},{"key":"is_plugin","value":{"boolValue":false}}],"droppedAttributesCount":0},{"timeUnixNano":"1791447318146000000","observedTimeUnixNano":"1791447318146000000","body":{"stringValue":"claude_code.mcp_server_connection"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"mcp_server_connection"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:18.146Z"}},{"key":"event.sequence","value":{"intValue":18}},{"key":"prompt.id","value":{"stringValue":"a50257c3-696f-46fc-9f50-5483556d2fac"}},{"key":"status","value":{"stringValue":"disconnected"}},{"key":"transport_type","value":{"stringValue":"claudeai-proxy"}},{"key":"server_scope","value":{"stringValue":"claudeai"}},{"key":"duration_ms","value":{"stringValue":"1113"}},{"key":"is_plugin","value":{"boolValue":false}}],"droppedAttributesCount":0}]}]}]};
const OTHER = {"resourceLogs":[{"resource":{"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"host.arch","value":{"stringValue":"amd64"}},{"key":"os.type","value":{"stringValue":"linux"}},{"key":"os.version","value":{"stringValue":"7.0.0-38-generic"}},{"key":"service.name","value":{"stringValue":"claude-code"}},{"key":"service.version","value":{"stringValue":"2.1.294"}}],"droppedAttributesCount":0},"scopeLogs":[{"scope":{"name":"com.anthropic.claude_code.events","version":"2.1.294"},"logRecords":[{"timeUnixNano":"1791447316602000000","observedTimeUnixNano":"1791447316602000000","body":{"stringValue":"claude_code.hook_registered"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"hook_registered"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:16.602Z"}},{"key":"event.sequence","value":{"intValue":2}},{"key":"hook_event","value":{"stringValue":"SessionStart"}},{"key":"hook_type","value":{"stringValue":"command"}},{"key":"hook_source","value":{"stringValue":"userSettings"}},{"key":"safe_mode","value":{"stringValue":"false"}}],"droppedAttributesCount":0},{"timeUnixNano":"1791447317355000000","observedTimeUnixNano":"1791447317355000000","body":{"stringValue":"claude_code.user_prompt"},"attributes":[{"key":"org.role","value":{"stringValue":"worker-probe"}},{"key":"org.pane","value":{"stringValue":"probe-pane"}},{"key":"user.id","value":{"stringValue":"REDACTED"}},{"key":"session.id","value":{"stringValue":"eec3945a-5a85-4c3c-9aa2-39e4b8445cef"}},{"key":"organization.id","value":{"stringValue":"REDACTED"}},{"key":"user.email","value":{"stringValue":"REDACTED"}},{"key":"user.account_uuid","value":{"stringValue":"REDACTED"}},{"key":"user.account_id","value":{"stringValue":"REDACTED"}},{"key":"terminal.type","value":{"stringValue":"xterm-256color"}},{"key":"event.name","value":{"stringValue":"user_prompt"}},{"key":"event.timestamp","value":{"stringValue":"2026-10-08T08:15:17.355Z"}},{"key":"event.sequence","value":{"intValue":14}},{"key":"prompt.id","value":{"stringValue":"a50257c3-696f-46fc-9f50-5483556d2fac"}},{"key":"prompt_length","value":{"stringValue":"30"}},{"key":"prompt","value":{"stringValue":"<REDACTED>"}},{"key":"prompt_text","value":{"stringValue":"<REDACTED>"}},{"key":"message.uuid","value":{"stringValue":"a37624e1-d3d8-4ea7-b607-7b7ad0aa49ae"}}],"droppedAttributesCount":0}]}]}]};
const REQUEST_ID = "req_011CfpSK96NthX9vPNsW9X2b";
// Plain `node --test` is the acceptance command and cannot import `lib/tmp-fixture.ts`, so the temp directories are made and removed here.
const made: string[] = [];
const tmpDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "otel-receiver.mjs");

/** A copy of an export with every attribute named in `drop` removed, on the resource and on each log record. */
function withoutAttributes(payload: { resourceLogs: { resource: { attributes: { key: string; value: { stringValue: string; }; }[]; droppedAttributesCount: number; }; scopeLogs: { scope: { name: string; version: string; }; logRecords: ({ timeUnixNano: string; observedTimeUnixNano: string; body: { stringValue: string; }; attributes: ({ key: string; value: { stringValue: string; intValue?: undefined; doubleValue?: undefined; }; }|{ key: string; value: { intValue: number; stringValue?: undefined; doubleValue?: undefined; }; }|{ key: string; value: { doubleValue: number; stringValue?: undefined; intValue?: undefined; }; })[]; droppedAttributesCount: number; }|{ timeUnixNano: string; observedTimeUnixNano: string; body: { stringValue: string; }; attributes: ({ key: string; value: { stringValue: string; intValue?: undefined; boolValue?: undefined; }; }|{ key: string; value: { intValue: number; stringValue?: undefined; boolValue?: undefined; }; }|{ key: string; value: { boolValue: boolean; stringValue?: undefined; intValue?: undefined; }; })[]; droppedAttributesCount: number; })[]; }[]; }[]; }, drop: string|any[]) {
  const strip = (list: any[]) => list.filter((pair: { key: any; }) => !drop.includes(pair.key));
  const copy = structuredClone(payload);
  for (const resourceLog of copy.resourceLogs) {
    resourceLog.resource.attributes = strip(resourceLog.resource.attributes);
    for (const scope of resourceLog.scopeLogs) for (const record of scope.logRecords) record.attributes = strip(record.attributes);
  }
  return copy;
}

/** A copy with `key` set to `value` on the resource and on each log record that already has it. */
function withAttribute(payload: { resourceLogs: { resource: { attributes: { key: string; value: { stringValue: string; }; }[]; droppedAttributesCount: number; }; scopeLogs: { scope: { name: string; version: string; }; logRecords: ({ timeUnixNano: string; observedTimeUnixNano: string; body: { stringValue: string; }; attributes: ({ key: string; value: { stringValue: string; intValue?: undefined; doubleValue?: undefined; }; }|{ key: string; value: { intValue: number; stringValue?: undefined; doubleValue?: undefined; }; }|{ key: string; value: { doubleValue: number; stringValue?: undefined; intValue?: undefined; }; })[]; droppedAttributesCount: number; }|{ timeUnixNano: string; observedTimeUnixNano: string; body: { stringValue: string; }; attributes: ({ key: string; value: { stringValue: string; intValue?: undefined; boolValue?: undefined; }; }|{ key: string; value: { intValue: number; stringValue?: undefined; boolValue?: undefined; }; }|{ key: string; value: { boolValue: boolean; stringValue?: undefined; intValue?: undefined; }; })[]; droppedAttributesCount: number; })[]; }[]; }[]; }, key: string, value: string) {
  const set = (list: any[]) => list.map((pair: { key: any; }) => (pair.key === key ? { key, value: { stringValue: value } } : pair));
  const copy = structuredClone(payload);
  for (const resourceLog of copy.resourceLogs) {
    resourceLog.resource.attributes = set(resourceLog.resource.attributes);
    for (const scope of resourceLog.scopeLogs) for (const record of scope.logRecords) record.attributes = set(record.attributes);
  }
  return copy;
}

const lines = (path: string|number|URL|Buffer<ArrayBufferLike>) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/** A receiver on a temp store, listening on loopback with an ephemeral port, closed at the end. `options` reach `createReceiver`. */
async function withReceiver(body: { ({ post,storePath }: { post: any; storePath: any; }): Promise<void>; ({ post }: { post: any; }): Promise<void>; ({ post }: { post: any; }): Promise<void>; ({ post,storePath }: { post: any; storePath: any; }): Promise<void>; ({ post,storePath,logged }: { post: any; storePath: any; logged: any; }): Promise<void>; ({ post,storePath }: { post: any; storePath: any; }): Promise<void>; ({ post,storePath }: { post: any; storePath: any; }): Promise<void>; ({ post }: { post: any; }): Promise<void>; (arg0: { post: (payload: any,{ path,headers,method }?: { path?: string|undefined; headers?: { "content-type": string; }|undefined; method?: string|undefined; }) => Promise<Response>; storePath: string; logged: any[]; server: Server<IncomingMessage,ServerResponse>; }): any; }, { storePath = join(tmpDir("otel-"), "events.ndjson"), ...options } = {}) {
  const logged: string[] = [];
  const server = await createReceiver({ storePath, log: (line) => logged.push(line), ...options });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const url = `http://${LOOPBACK}:${server.address().port}`;
  const post = (payload: BodyInit|null|undefined, { path = "/v1/logs", headers = { "content-type": "application/json" }, method = "POST" } = {}) =>
    fetch(`${url}${path}`, { method, headers, ...(method === "POST" ? { body: typeof payload === "string" ? payload : JSON.stringify(payload) } : {}) });
  try {
    await body({ post, storePath, logged, server });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("A REAL api_request becomes ONE source:otel record with org.role, prompt.id and cost_usd; the run's other events become none", async () => {
  await withReceiver(async ({ post, storePath }) => {
    // NEGATIVE CONTROL FIRST: the same run's user_prompt and hook events are received (200) and stored as nothing.
    const other = await post(OTHER);
    assert.equal(other.status, 200);
    assert.deepEqual(lines(storePath), [], "events that are not an API request are not this store's");
    assert.equal(eventsOfOtlpLogs(OTHER).events.length, 0);

    const response = await post(REQUEST);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {}, "nothing rejected, so no partialSuccess");
    const [event, ...rest] = lines(storePath);
    assert.deepEqual(rest, [], "one request, one record");
    assert.deepEqual(event, {
      id: `otel:${REQUEST_ID}`, kind: "api_request", source: "otel", at: Date.parse("2026-10-08T08:15:18.137Z"), session: "worker-probe", role: "worker-probe", pane: "probe-pane",
      row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, requestId: REQUEST_ID,
      promptId: "a50257c3-696f-46fc-9f50-5483556d2fac", sessionId: "eec3945a-5a85-4c3c-9aa2-39e4b8445cef", model: "claude-haiku-5-5",
      usage: { input: 2, output: 4, cacheRead: 9179, cacheCreation: 13356 }, clientCostUsd: 0.0027651900000000003, durationMs: 742,
    });
  });
});

test("THE SAME PAYLOAD TWICE IS ONE RECORD: the id is the request's, across posts, within one export and across a restart; another request is another record", async () => {
  const storePath = join(tmpDir("otel-"), "events.ndjson");
  await withReceiver(async ({ post }) => {
    await post(REQUEST);
    await post(REQUEST);
    assert.equal(lines(storePath).length, 1, "a retry of the exporter adds nothing");
    // POSITIVE CONTROL: dedup is by request id, not "one record ever": the same export under another request_id is a second record.
    await post(withAttribute(REQUEST, "request_id", "req_another"));
    assert.deepEqual(lines(storePath).map((event) => event.id), [`otel:${REQUEST_ID}`, "otel:req_another"]);
    // Two copies of one request inside ONE export are one record too.
    const twice = structuredClone(REQUEST);
    twice.resourceLogs[0].scopeLogs[0].logRecords.push(...structuredClone(twice.resourceLogs[0].scopeLogs[0].logRecords));
    await post(withAttribute(twice, "request_id", "req_in_one_export"));
    assert.equal(lines(storePath).length, 3);
  }, { storePath });
  // A RESTART forgets nothing: the ids are scanned back out of the file, and a line that is not the receiver's (the ingest's) is never mistaken for one.
  await withReceiver(async ({ post }) => {
    await post(REQUEST);
    assert.equal(lines(storePath).length, 3, "the restarted receiver refuses what the file already holds");
    await post(withAttribute(REQUEST, "request_id", "req_after_restart"));
    assert.equal(lines(storePath).length, 4);
  }, { storePath });
});

test("A PAYLOAD WITH NO org.role IS STORED AS `unattributed`: not dropped, and never given a role", async () => {
  await withReceiver(async ({ post, storePath }) => {
    // POSITIVE CONTROL: with the role present the record carries it, so `unattributed` below is the missing attribute's doing.
    await post(REQUEST);
    assert.equal(lines(storePath)[0].role, "worker-probe");
    assert.notEqual(lines(storePath)[0].role, UNATTRIBUTED);

    await post(withAttribute(withoutAttributes(REQUEST, ["org.role"]), "request_id", "req_no_role"));
    const stored = lines(storePath).find((event) => event.requestId === "req_no_role");
    assert.ok(stored, "stored, not dropped");
    assert.equal(stored.role, UNATTRIBUTED);
    assert.equal(stored.session, UNATTRIBUTED);
    assert.equal(stored.pane, "probe-pane", "the pane is still recorded: it is NOT used to guess a role");
    assert.equal(stored.promptId, "a50257c3-696f-46fc-9f50-5483556d2fac", "and nothing else about the request is lost");
    assert.equal(stored.clientCostUsd, 0.0027651900000000003);

    // An EMPTY role is no role. (`OTEL_RESOURCE_ATTRIBUTES=org.role=` is what a launcher with an unset variable produces.)
    await post(withAttribute(withAttribute(REQUEST, "org.role", ""), "request_id", "req_empty_role"));
    assert.equal(lines(storePath).find((event) => event.requestId === "req_empty_role").role, UNATTRIBUTED);
  });
  // The role on the RESOURCE alone is enough (a record with no copy of it), and the record's own wins when they differ.
  const resourceOnly = structuredClone(REQUEST);
  for (const record of resourceOnly.resourceLogs[0].scopeLogs[0].logRecords) record.attributes = record.attributes.filter((pair) => pair.key !== "org.role");
  assert.equal(eventsOfOtlpLogs(resourceOnly).events[0].role, "worker-probe");
  const differing = structuredClone(REQUEST);
  differing.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((pair) => pair.key === "org.role").value = { stringValue: "reviewer-9" };
  assert.equal(eventsOfOtlpLogs(differing).events[0].role, "reviewer-9");
});

test("WHAT IT CANNOT READ IS REFUSED OUT LOUD, and nothing is stored for it", async () => {
  await withReceiver(async ({ post, storePath, logged }) => {
    const protobuf = await post("\n\u0003abc", { headers: { "content-type": "application/x-protobuf" } });
    assert.equal(protobuf.status, 415);
    assert.match((await protobuf.json()).error, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/, "and it names the variable that fixes it");
    assert.equal((await post(REQUEST, { headers: { "content-type": "application/json", "content-encoding": "gzip" } })).status, 415);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ hello: "world" })).status, 400, "JSON that is not an OTLP logs export");
    assert.equal((await post(REQUEST, { path: "/v1/metrics" })).status, 404);
    assert.equal((await post(REQUEST, { method: "GET" })).status, 405);
    assert.deepEqual(lines(storePath), []);
    assert.ok(logged.some((line: string|string[]) => line.includes("415")), "and the refusal is on the log, where the journal has it");

    // POSITIVE CONTROL: the same body under the right content-type IS stored, so the refusals above are the headers' and not a receiver that stores nothing.
    assert.equal((await post(REQUEST)).status, 200);
    assert.equal(lines(storePath).length, 1);
  });
});

test("A REQUEST WITH NO request_id IS REJECTED AND COUNTED (partialSuccess), never stored under an invented id; its neighbours are stored", async () => {
  await withReceiver(async ({ post, storePath }) => {
    const mixed = structuredClone(REQUEST);
    const records = mixed.resourceLogs[0].scopeLogs[0].logRecords;
    records.push(structuredClone(records[0]));
    records.at(-1).attributes = records.at(-1).attributes.filter((pair) => pair.key !== "request_id");
    const response = await post(mixed);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.partialSuccess.rejectedLogRecords, 1);
    assert.match(body.partialSuccess.errorMessage, /no request_id/);
    assert.deepEqual(lines(storePath).map((event) => event.id), [`otel:${REQUEST_ID}`]);
  });
});

test("A BODY OVER THE LIMIT IS 413 and stores nothing; the limit is a parameter so this needs no 8 MiB", async () => {
  await withReceiver(async ({ post, storePath }) => {
    assert.equal((await post(REQUEST)).status, 413);
    assert.deepEqual(lines(storePath), []);
  }, { maxBodyBytes: 1024 });
  await withReceiver(async ({ post }) => assert.equal((await post(REQUEST)).status, 200), { maxBodyBytes: 1024 * 1024 });
});

test("IT LISTENS ON LOOPBACK AND HAS NO FLAG TO CHANGE THAT: an unknown argument is refused, not ignored", () => {
  assert.deepEqual(parseArgs([]).port, 4318);
  assert.deepEqual(parseArgs(["--port=4999", "--store=/s"]), { port: 4999, store: "/s" });
  assert.throws(() => parseArgs(["--host=0.0.0.0"]), /unknown argument --host=0\.0\.0\.0/);
  assert.throws(() => parseArgs(["--port=70000"]), /not a port/);
  assert.equal(LOOPBACK, "127.0.0.1");
});

test("THE PROGRAM, STARTED AS THE UNIT STARTS IT, receives a post and appends it (the entry point, not only the library)", async () => {
  const storePath = join(tmpDir("otel-"), "events.ndjson");
  const port = await new Promise((resolve) => {
    const probe = createNetServer().listen(0, LOOPBACK, () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const child = spawn(process.execPath, [...TSX_IMPORT, SCRIPT, `--port=${port}`, `--store=${storePath}`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`exited ${code} before listening`)));
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(undefined); });
    });
    const response = await fetch(`http://${LOOPBACK}:${port}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REQUEST) });
    assert.equal(response.status, 200);
    assert.deepEqual(lines(storePath).map((event) => event.role), ["worker-probe"]);
  } finally {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  }
});
