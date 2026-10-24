## What it is

Step 2 of 2 of the Atomaut New ticket dialog, in `ui/src/new-ticket/`: the dialog the Tickets page's New ticket buttons (the header's and the empty panel's) now open, and the request strip under the page's header. The dialog is the request, Quick or Grill, Auto or Manual placement (Manual's project, repository, goal, priority and parent, each "Not set" until chosen), and the footer pill with the writer's model and effort linking to Settings. A refusal shows the server's sentence in the dialog with the request kept. The strip draws one card per request from `GET /api/writer` (polled every 5s): queued, writing, waiting for you (the writer's own question, with Open terminal), done (the tickets it filed, linked) and failed (the run's own reason). The request belongs to the page, so closing the dialog stops nothing, and opening it again shows Sending…, the refusal, or a fresh form. The step-1 API (`placement`) is already merged.

## Acceptance

The component checks (happy-dom) cover each of the five states from fixtures with the real strings, the dialog's words, focus and keyboard, Quick or Grill (and no terminal), Auto or Manual with the options read from the page, the writer pill, the body posted for Quick, Grill, Auto and Manual (the writer stubbed), the refusal, Sending…, a request that goes on with the dialog closed, Stop and Dismiss, a failed read, and the tickets list read again when a request files a ticket. The page checks drive Chromium over the real build: the dialog opening and closing with the focus, Manual placement end to end with the exact body posted, the refusal, and each of the ten boards at 1440px and 390px with no horizontal overflow, written to `ui/captures/new-ticket/`.

Acceptance:
```bash
bash -c 'set -euo pipefail
pnpm --dir ui install --frozen-lockfile --ignore-scripts >/dev/null
pnpm ui:typecheck
pnpm ui:build >/dev/null
pnpm ui:test
npx eslint ui --quiet
ls ui/captures/new-ticket/new-ticket-form-1440x900.png ui/captures/new-ticket/new-ticket-manual-390x844.png ui/captures/new-ticket/new-ticket-done-1440x900.png ui/captures/new-ticket/new-ticket-failed-390x844.png'
```

## After merge (who runs it)

The chairman session, on the agents host's `/next/tickets`: write one Quick ticket with Manual placement (a project, and priority Low), then one Grill ticket with Auto. A pass: the strip reaches Done with the key and its link, and the Quick one has that project and priority Low in the tracker; the Grill one opens its terminal, shows "Waiting for you" with the writer's question, and after the answer shows Done with the key. Cleanup: dismiss both cards and close the tickets they filed.

Consumer-declaration: none -- `ui/` is a private package nothing else reads; no option is added to a project declaration.
