# Atomaut UI redesign: the brief (from the chairman, 2026-10-24)

Design source: [https://claude.ai/artifact/S7AMyTJ3wSDk7s342DzcVD](<https://claude.ai/artifact/S7AMyTJ3wSDk7s342DzcVD>), a design canvas of 49 boards. Read it with the Artifact tool: `path: project/<Board>.dc.html` for a board, `path: project/canvas.json` for the order and sections. The canvas groups them as: main pages, loading and empty, run states, writing a ticket, changing settings, changing plugins.

## Rules

* The boards are the spec for layout, copy, states and behaviour. Don't redesign. Where something is ambiguous, check the agent-org code and keep its existing behaviour.
* Match the boards' visual system: dark theme, a 248px sidebar, and their colours and spacing. At 820px and below the sidebar collapses to full width.
* Don't add UI the boards don't show.
* "Atomaut" is the UI's name only. The CLI, package and repository stay agent-org.

## What changes

* **Navigation:** a left sidebar replaces the old top row. It holds the instance switcher, a connection status pill, Tickets, Runs, then projects and goals, with Settings at the bottom.
* **Tickets:** the queue options sit in a popover behind a cog button. A New ticket dialog replaces the writer strip.
* **Runs and Run detail:** the header actions come from the real `runActions()` rules. "Talk to it" opens the run's session in herdr, which is a separate app, so only the button belongs in Atomaut.
* **New ticket:** choose Quick or Grill, then Auto or Manual placement. A footer pill shows the writer model and effort. The dialog shows every writer state: submitting, error, no terminal, queued, writing, waiting, done and failed.
* **Settings:** split into Models, Workers, Machine and Plugins.
  * Model and effort choices save as soon as they change.
  * Host-file keys use the existing preview, save and restore flow. That includes the review dialog, the confirmation for dangerous keys, and the refused and conflict states.
* **Plugins:** install, enable, disable and uninstall, with a confirmation for uninstalling and for replacing an install. Show the "takes effect when the board restarts" note.
* **Every page needs its full lifecycle:** loading skeletons, empty, error, and the unreachable-instance state. Unreachable applies only to SSH remote connections. The page polls every 5s, and retries back off from 2s to 60s.

## Proposed, not yet in the code (to be built)

* The unreachable "Last known" view and its "Check now" action.
* The Auto/Manual placement toggle in the new-ticket dialog.
* The Models/Workers/Machine split of Settings.
* The "1 needs attention" badge on the Plugins sub-nav item.

## Example text

The reason and prompt text on the failed, needs-you, handed-back, blocked and awaiting run boards is illustrative and labelled that way. Use the real strings from the backend.

## Not designed

* A failure state for herdr not opening.
* Separate state boards for the "Claude plugins" tab.

Use the same patterns as the neighbouring states for both.

## Before a page is done

* Check it against its boards, including the loading, empty and error states.
* Check it at 390px wide, with no horizontal overflow.
