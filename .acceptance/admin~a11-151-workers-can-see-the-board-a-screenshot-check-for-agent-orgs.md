## What it is

A worker that changes the board could not check what it looks like, so it ended `needs-human` asking a person to load the page at 1280x800. This adds `agent-org ticket:capture`: one command that starts this checkout's instance and board on free ports from a throwaway host file and state folder, pairs a headless browser through the board's own pairing, opens a route at a size, writes the PNG, and removes everything it started. `agent-org onboard` installs the Chromium builds Playwright needs, and `agent-org doctor` checks both builds and fails with the install command. A worker whose change alters a page is told to capture it and show the image in its pull request, when `tickets.capture` is true.

## Change

- `src/ticket-mode/capture-command.ts`: `ticket:capture`. Refuses before anything starts when a Chromium build is missing. Starts `ticket:serve` and `ticket:ui` from this checkout, pairs through `pairingCode` and `POST /pair`, shoots the route, and stops both and removes the throwaway directory on every exit path, including a signal.
- `src/ticket-mode/capture.ts`: the pure parts: the size and route, the file name, the throwaway host file (`captureHost`, loaded by `readTicketSettings` in its test), the stub herdr, and a PNG's size.
- `src/install/chromium.ts`: both builds (`chromium`, `chromium-headless-shell`) found by Playwright's revisions, each checked for the binary and, on Linux, for the libraries `ldd` says are missing. The install commands.
- `src/install/onboard.ts`: `setUpChromium` installs the browsers as the person, and the libraries through `sudo -n` only when root or `sudo -n` works; writes `tickets.capture: true` only where it is absent and both builds start.
- `src/install/doctor.ts`: one check per build; a failed build's fix is the install command.
- `src/ticket-mode/settings.ts`, `config-schema.ts`: `tickets.capture`, a true-or-false host key, shown read-only on the Settings page.
- `src/ticket-mode/worker-files.ts`, `pool-prepare.ts`: step 8 of the brief when `tickets.capture` is true.
- `src/commands.ts`: `ticket:capture`. `package.json`, `pnpm-lock.yaml`: `playwright-core` 1.63.0, pinned, a runtime dependency.
- `README.md`: a paragraph on `ticket:capture`.

## Acceptance

Each line of the ticket's acceptance and done-when has a named test or the runnable check below. The check captures the Settings page through the real command on this machine and reads the PNG's own header, so a capture of another size or a file that is not a PNG fails it.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/install/chromium.test.ts src/ticket-mode/capture.test.ts src/ticket-mode/capture-command.test.ts src/ticket-mode/settings.test.ts src/ticket-mode/config-schema.test.ts src/ticket-mode/worker-files.test.ts src/install/onboard.test.ts src/install/doctor.test.ts src/packaging/bin-commands.test.ts
out="$(mktemp -d)"
shot="$(node src/bin.ts ticket:capture /settings --size 1280x800 --out "$out")"
node -e 'const b = require("fs").readFileSync(process.argv[1]); const w = b.readUInt32BE(16); const h = b.readUInt32BE(20); if (b.toString("latin1", 1, 4) !== "PNG" || w !== 1280 || h !== 800) { console.error(`not a 1280x800 PNG: ${w}x${h}`); process.exit(1); } console.log(`1280x800 PNG: ${process.argv[1]}`);' "$shot"
```
