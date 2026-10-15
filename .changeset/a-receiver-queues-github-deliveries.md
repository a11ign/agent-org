---
"@a11ign/agent-org": patch
---

`src/event-receiver.ts` receives GitHub webhook deliveries on `127.0.0.1` only (a11ign/agent-org#978): it verifies `X-Hub-Signature-256` over the raw body, drops a repeated `X-GitHub-Delivery`, appends each accepted event to a local queue and writes a heartbeat file beside it. Nothing starts it and nothing reads the queue yet, so no behaviour changes and `poll` stays the default.
