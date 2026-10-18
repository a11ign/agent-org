## What it is

The board's page and the worker terminal can be served on the tailnet, so the chairman reaches the board from any of his devices over Tailscale and only over Tailscale. With `tickets.serve: "tailscale"` set in the host file, `start` and `onboard` serve the page (`tickets.servePorts.ui`, 9443) and the terminal (`tickets.servePorts.terminal`, 9444) with `tailscale serve --bg`, never with Funnel. `stop` removes only those two entries. The page accepts the machine's MagicDNS name as its `Host`, and the board hands the page the tailnet address of the terminal. Browser pairing is unchanged.

## Change

- `tickets.serve` and `tickets.servePorts` are read by `settings.ts`, refused by name when they are not valid.
- `tailnet.ts` (new, pure) builds the serve, status and removal commands, reads the tailnet name and the serve config, and words the refusals. It builds no `funnel` argument and no `reset`.
- `service.ts` checks tailscale and the port before it starts a served page or terminal, then serves it, and on stop removes only its own entry.
- `ui-server.ts` and `local-http.ts` accept the tailnet `Host` and `Origin` on the public port, and nothing else new.
- `server.ts` and `terminal.ts` hand the page the tailnet terminal address when served.
- `doctor.ts` checks tailscale, and each served port's entry, Funnel and answer.

## Verified

- `tailnet.test.ts`: the status parser; the serve, status and removal commands, with none naming funnel or reset; the agents host's serve config (Funnel on :443, :8443 plain); free, ours, foreign and Funnel decisions; the allowed Host and Origin with a public port of 443; the terminal template; the operator refusal text; the name cache's ten-second retry.
- `settings.test.ts`: serve absent gives `null`; `"tailscale"` gives 9443 and 9444; custom ports; each refusal by name.
- `ui-server.test.ts`: the tailnet name at 9443 is answered; `:4748`, another name and a bare name at 9443 are refused; a write from the tailnet origin is allowed and another is refused; a code pairs a browser over the tailnet; the name is asked only for a non-loopback Host.
- `server.test.ts`: `/api/config`'s terminal is the tailnet address for a loopback or absent stored one, the stored one for another machine's, and the stored one when the name cannot be read; the instance refuses the tailnet Host.
- `service.test.ts`: start serves the right loopback port after the unit starts; Funnel, a foreign entry, a missing tailscale, a node that is not Running and the operator refusal each refuse with their text; stop removes only its own entry and never names the other entries; the instance and auto-update never call tailscale; without `tickets.serve` no tailscale is called.
- `doctor.test.ts`, `onboard.test.ts`, `terminal.test.ts`: the tailnet checks and their fixes; the tailnet address line; a ui the tailnet refuses fails onboard; the effective terminal rule.

No real `tailscale` runs in these tests.

Refs A11-87

Flag: none. The served page and terminal start only when `tickets.serve` is set in the host file.
Revert: revert this PR; without `tickets.serve` the board behaves as before, and an existing serve entry is removed with `agent-org stop ui` and `agent-org stop terminal`.

Acceptance: `bash -c 'cd /home/agent/repos/.tickets/A11-87/agent-org && npx rstest run --config scripts/rstest/rstest.config.ts src/ticket-mode/tailnet.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/ui-server.test.ts src/ticket-mode/server.test.ts src/install/service.test.ts src/install/doctor.test.ts src/install/onboard.test.ts src/install/terminal.test.ts'`
