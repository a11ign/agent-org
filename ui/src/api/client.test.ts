import type { Answer } from "./answer.ts";
import { createClient } from "./client.ts";
import type { ViewConnection } from "./types.ts";

const SSH: ViewConnection = { name: "personal", kind: "ssh" };
const LOCAL: ViewConnection = { name: "this machine", kind: "local" };

type Seen = { url: string; init: RequestInit };

/** A `fetch` that records each request and answers every one with `status` and `body`. */
function answering(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const headersOf = (init: RequestInit): Record<string, string> => Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));

describe("the client's requests", () => {
  it("sends each read as a GET under the connection's /c/<name>, with the query it is given", async () => {
    const { fetch, seen } = answering(200, []);
    const client = createClient(LOCAL, { fetch });
    const reads = [client.config, client.tickets, client.people, client.parents, client.pick, client.queue, client.writer, client.settings, client.plugins];
    for (const read of reads) await read();
    await client.ticketsPage("Unassigned", "cursor 2");
    await client.ticketsPage("Anyone");
    expect(seen.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      ...["config", "tickets", "people", "parents", "pick", "queue", "writer", "settings", "plugins"].map((route) => `GET /c/this%20machine/api/${route}`),
      "GET /c/this%20machine/api/tickets?assignee=Unassigned&after=cursor+2",
      "GET /c/this%20machine/api/tickets?assignee=Anyone",
    ]);
  });

  it("sends each change as a POST with its JSON body and the body's type", async () => {
    const { fetch, seen } = answering(200, {});
    const client = createClient(SSH, { fetch });
    await client.enqueue(["A11-1"], { model: "opus", effort: "high", plan: true });
    await client.enqueueChildren("A11-2", { model: "sonnet", effort: "low" });
    await client.publish(["A11-1"]);
    await client.pause();
    await client.setMax(3);
    await client.saveChoice({ model: "haiku" });
    await client.amend("A11-1", { effort: "max" });
    await client.writeTickets({ request: "a ticket", mode: "quick" });
    await client.grillTicket("A11-3");
    await client.previewSettings("host.json", [{ key: "tickets.max", value: 2 }]);
    await client.saveSettings({ file: "host.json", changes: [{ key: "tickets.max", remove: true }], base: "abc", confirmed: ["tickets.max"] });
    await client.restoreSettings("project.json");
    await client.pluginAction({ action: "enable", name: "telegram", base: "abc" });
    expect(seen.map(({ url, init }) => [init.method, url, init.body])).toEqual([
      ["POST", "/c/personal/api/queue", '{"keys":["A11-1"],"model":"opus","effort":"high","plan":true}'],
      ["POST", "/c/personal/api/queue-children", '{"key":"A11-2","model":"sonnet","effort":"low"}'],
      ["POST", "/c/personal/api/publish", '{"keys":["A11-1"]}'],
      ["POST", "/c/personal/api/paused", '{"paused":true}'],
      ["POST", "/c/personal/api/max", '{"max":3}'],
      ["POST", "/c/personal/api/choice", '{"model":"haiku"}'],
      ["POST", "/c/personal/api/queue/A11-1/amend", '{"effort":"max"}'],
      ["POST", "/c/personal/api/writer", '{"request":"a ticket","mode":"quick"}'],
      ["POST", "/c/personal/api/grill-ticket", '{"key":"A11-3"}'],
      ["POST", "/c/personal/api/settings/preview", '{"file":"host.json","changes":[{"key":"tickets.max","value":2}]}'],
      ["POST", "/c/personal/api/settings/save", '{"file":"host.json","changes":[{"key":"tickets.max","remove":true}],"base":"abc","confirmed":["tickets.max"]}'],
      ["POST", "/c/personal/api/settings/restore", '{"file":"project.json"}'],
      ["POST", "/c/personal/api/plugins/action", '{"action":"enable","name":"telegram","base":"abc"}'],
    ]);
    for (const { init } of seen) expect(headersOf(init)["Content-Type"]).toBe("application/json");
  });

});

describe("the client's run actions and addressing", () => {
  it("sends each run action as a POST to /api/queue/<key>/<verb> and a new-ticket run's stop and dismiss under /api/writer", async () => {
    const { fetch, seen } = answering(200, {});
    const client = createClient(LOCAL, { fetch });
    const verbs = ["respond", "retry", "dismiss", "remove", "talk", "start-anyway", "approve", "stop", "close", "apply-edit", "discard-edit"] as const;
    for (const verb of verbs) await client.runAction("A11-9", verb);
    await client.stopWriterRun("w1");
    await client.dismissWriterRun("w1");
    expect(seen.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      ...verbs.map((verb) => `POST /c/this%20machine/api/queue/A11-9/${verb}`),
      "POST /c/this%20machine/api/writer/w1/stop",
      "POST /c/this%20machine/api/writer/w1/dismiss",
    ]);
    expect(seen.every(({ init }) => init.body === undefined)).toBe(true);
  });

  it("addresses /api/... at the root for a null connection, and /api/connections at the root for any", async () => {
    const { fetch, seen } = answering(200, { connections: [], refusal: null });
    await createClient(null, { fetch }).queue();
    await createClient(null, { fetch }).runAction("A11-1", "retry");
    await createClient(SSH, { fetch }).connections();
    expect(seen.map(({ url }) => url)).toEqual(["/api/queue", "/api/queue/A11-1/retry", "/api/connections"]);
  });

  it("sends the paired browser's cookie as the page does and no token of its own", async () => {
    const { fetch, seen } = answering(200, {});
    const client = createClient(LOCAL, { fetch });
    await client.queue();
    await client.resume();
    for (const { init } of seen) {
      expect(Object.keys(headersOf(init)).map((name) => name.toLowerCase())).not.toContain("x-ticket-token");
      expect(init.credentials).toBeUndefined();
    }
  });

  it("passes the signal of a read on to fetch", async () => {
    const { fetch, seen } = answering(200, {});
    const controller = new AbortController();
    await createClient(LOCAL, { fetch }).queue(controller.signal);
    expect(seen[0].init.signal).toBe(controller.signal);
  });
});

describe("the client's answers", () => {
  it("resolves a success to the server's JSON", async () => {
    const { fetch } = answering(200, { entries: [], max: 2 });
    expect(await createClient(LOCAL, { fetch }).queue()).toEqual({ ok: true, data: { entries: [], max: 2 } });
  });

  it("returns a refused mutation's text as data, whatever the status, and does not throw", async () => {
    const refusal = "NBF-3 waits on a ticket or its plan, which Start anyway does not pass";
    for (const status of [400, 403, 404, 503]) {
      const { fetch } = answering(status, { error: refusal });
      const answer: Answer<unknown> = await createClient(LOCAL, { fetch }).runAction("NBF-3", "retry");
      expect(answer).toEqual({ ok: false, status, refusal, unreachable: false });
    }
  });

  it("returns a refusal from every kind of mutation the same way", async () => {
    const { fetch } = answering(400, { error: "name a model or an effort to change" });
    const client = createClient(LOCAL, { fetch });
    const answers = await Promise.all([client.saveChoice({}), client.setMax(0), client.writeTickets({}), client.restoreSettings("host.json"), client.amend("A11-1", {})]);
    for (const answer of answers) expect(answer).toMatchObject({ ok: false, refusal: "name a model or an effort to change" });
  });

  it("names a fixed sentence for an answer that is not JSON", async () => {
    const { fetch } = answering(200, "<html>proxy error</html>");
    expect(await createClient(LOCAL, { fetch }).queue()).toEqual({ ok: false, status: 200, refusal: "the instance answered with something that is not JSON", unreachable: false });
  });

  it("falls back to the status when a failure names no error", async () => {
    const { fetch } = answering(500, {});
    expect(await createClient(LOCAL, { fetch }).queue()).toMatchObject({ ok: false, status: 500, refusal: "HTTP 500" });
  });

  it("answers status 0 with the browser's message when fetch rejects, and that is an error even for an SSH connection", async () => {
    const fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof globalThis.fetch;
    expect(await createClient(SSH, { fetch }).queue()).toEqual({ ok: false, status: 0, refusal: "Failed to fetch", unreachable: false });
    expect(await createClient(SSH, { fetch }).pause()).toEqual({ ok: false, status: 0, refusal: "Failed to fetch", unreachable: false });
  });
});
