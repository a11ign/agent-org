---
"agent-org": minor
---

`src/trace/otel-receiver.mjs` receives Claude Code's OpenTelemetry on 127.0.0.1:4318 (OTLP/HTTP with JSON only; protobuf is refused with 415 naming the variable that fixes it) and appends one `source: "otel"`, `kind: "api_request"` record per `claude_code.api_request` to the trace store, with `org.role`, `org.pane`, `prompt.id`, the token counts and Claude Code's own `cost_usd` (kept as `clientCostUsd`: the client's estimate, not the store's repriced figure). The id is `otel:<request_id>`, so a retried export is one record; a payload with no `org.role` is stored as `unattributed`. `host/otel-receiver.service.in` is shipped as a long-running service no timer starts (`LONG_RUNNING_TEMPLATES`), so `host:install` enables it with `--now`; a pane already running keeps the environment it started with and is not seen (a11ign/a11ign#4071, step zero of #4055).
