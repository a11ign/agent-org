# Atomaut parity: nothing today's board does is lost

The chairman's rule (2026-10-24): **"The current functionality doesn't degrade."** Atomaut does everything today's board (`src/ticket-mode/ui.html`) does. Where the boards draw a feature, Atomaut builds it as drawn. Where they do not, Atomaut keeps the feature in the boards' neighbouring patterns (banners, lists, callouts, disclosures) and lists it here. No feature is dropped because a board is silent.

This file is the inventory, read from `ui.html`'s markup and script. A11-202 walks it again before `/` serves Atomaut.

## Every `pattern:` row is a feature the chairman can draw later

A row whose last cell starts `pattern:` is a feature with no board. It uses the pattern named after the colon, so it reads as a neighbour of what the boards draw. It is the list of what to draw on the canvas when the chairman wants it. A row whose last cell names a board (`AtomautRuns`) is drawn as the board draws it.

## How the rows are written

| Column | Says |
| --- | --- |
| Feature | What a person sees or does, in words. |
| In `ui.html` | The element id (`#claim-note`) or the function (`renderBoard()`, or a name `ui.html` imports, in backticks) that draws it. A test holds every element id of `ui.html`'s markup, and every name it imports from `/board-view.js`, `/label-filters.js`, `/assignee-filter.js`, `/settings-search.js` and `/plugins-section.js`, to appear in this column of some row. |
| Atomaut page | The route and the place on it. |
| Ticket | The ticket that built the feature, or that builds it. |
| Board or pattern | The board that draws it, or `pattern: <name>`. |

`ui/test/parity/parity.test.ts` reads this file. It fails when a row has an empty cell, a Ticket that is not a ticket key, or a last cell that is neither a board nor `pattern: <words>`; and while `ui.html` exists, when an id or an imported name of `ui.html` is in no row.

The tickets: A11-194 the shell, A11-195 an unreachable instance, A11-196 Tickets, A11-197 Runs, A11-198 Run detail, A11-199 New ticket, A11-200 Settings, A11-201 Plugins, A11-211 refetch on focus and the reconnecting line, A11-217 the update drain banner, A11-218 Publish, A11-202 the cutover, A11-220 this inventory and what it restored.

## 1. Shell and live state

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The title and the tabs that switch pages | `#pick`, `#board`, `renderBoard()`, `renderPick()` | Every page: the sidebar's Tickets and Runs items | A11-194 | AtomautTickets |
| Instance switcher, shown when there is more than one instance | `#connection-label`, `#connection`, `renderConnections()`, `connectionLabel`, `chosenConnection` | Every page: the sidebar's instance switcher | A11-194 | AtomautTickets |
| The remembered instance and the `apiBase` of its API | `apiBase`, `recall`, `remember` | Every page: the shell's `ShellProvider` and client | A11-194 | AtomautTickets |
| The service's refusal of the connections file | `#connections-note` | Every page: the shell frame's refusal banner | A11-194 | pattern: status banner |
| The Settings button | `#open-settings` | Every page: the sidebar's Settings item | A11-194 | AtomautTickets |
| The error line, red, with the sentence of a refused press or read | `#error`, `report()` | Each page's failure banner, with Retry and Dismiss | A11-194 | AtomautRuns |
| The quiet Reconnecting line while the instance restarts | `#reconnecting`, `looksLikeRestart`, `Restarting` | Every page: the lifecycle's reconnecting frame | A11-211 | pattern: reconnecting frame |
| The check that holds every run, above both tabs | `#held` | `/next/tickets` above the list, and `/next/runs` above the pool bar | A11-220 | pattern: status banner |
| The breaking update that drains: its banner, and the line on a run | `#update-note`, `updateBanner`, `updateLines` | `/next/tickets` and `/next/runs` above the page: the shell's drain banner. A run's line is on the Runs row and on Run detail's "Everything this run noted" | A11-217 | AtomautRunsDraining |
| The poll: one read after another, 5 s after a good one, backing off from 2 s to 60 s | `POLL_MS`, `nextDelay` | Every page: the shell's poller | A11-211 | pattern: reconnecting frame |
| Read at once when the window is focused or shown again | `readNow()`, `readOnce()` | Every page: the poller | A11-211 | pattern: reconnecting frame |
| An answer for another instance is dropped | `STALE`, `call()` | Every page: `ShellProvider`, which keys every read to its connection | A11-194 | pattern: status banner |
| A link from an ended run names its instance (`?connection=`) | `chosenConnection` | `/next` redirect page | A11-202 | pattern: redirect |
| Scroll to the card a link names (`#run-KEY`) | `scrollToNamedCard()` | `/next/runs/<key>` is the run's own page, so the link opens the run | A11-202 | pattern: redirect |
| A stale terminal link is read again before it is followed | `resolveStaleTerminal()`, `isBlank()`, `openTerminalWhenReady()`, `terminalTab`, `terminalLink`, `terminalOpenHref` | The header's Talk to it link on `/next/runs/<key>`, and Open terminal on a New ticket request | A11-220 | pattern: terminal link |
| The terminal link of a run, built from a pane | `ticketTerminal()`, `runTerminalHref()`, `writerTerminal()` | `/next/runs/<key>` header, and the New ticket request card | A11-198 | AtomautRunDetail |

## 2. Pick: the Tickets page

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| Search by key, title or project | `#filter` | `/next/tickets`, the filter row | A11-196 | AtomautTickets |
| Select all shown | `#all`, `pickableShown()` | `/next/tickets`, each section's header (per section, the board's) | A11-196 | AtomautTickets |
| Expand all or Collapse all | `#fold-all`, `allOpen()`, `parentKeys` | `/next/tickets`, the header | A11-196 | AtomautTickets |
| The counter: N of M shown, K selected | `#loaded`, `scopeWord`, `ticketCount` | `/next/tickets`, the header's count | A11-196 | AtomautTickets |
| New ticket | `#new-ticket` | `/next/tickets`, the header | A11-199 | AtomautNewTicket |
| Projects, with their counts | `#projects`, `renderProjects()`, `projectCounts`, `chosenProject`, `inProject`, `projectOf` | The sidebar's projects | A11-194 | AtomautTickets |
| The Assignee chips with counts, and Loading… | `#assignees`, `renderAssignees()`, `scopeChips`, `scopeToRead`, `inScope`, `ANYONE`, `NO_VIEWER`, `defaultScope` | `/next/tickets`, the Assignee group | A11-196 | AtomautTickets |
| The owner on a row once the list is not the signed-in person's | `ownerName`, `showsOwner` | `/next/tickets`, a row's owner pill | A11-196 | AtomautTickets |
| Priority filter | `#priorities`, `renderPriorities()`, `prioritiesOf`, `priorityCounts`, `PRIORITY_NAMES` | `/next/tickets`, the Priority button's menu | A11-196 | AtomautTickets |
| Plan filter, only where the machine names a plan pattern | `#plans`, `renderPlans()`, `planChoiceOf`, `planCounts` | `/next/tickets`, the Plan button's menu | A11-196 | AtomautTickets |
| Label filters, one row for each label group | `#label-rows`, `renderLabels()`, `labelRows`, `withLabels`, `clearedRow` | `/next/tickets`, one dashed button for each label group but Goal, whose choice the sidebar's goals make | A11-196 | AtomautTickets |
| Visible tickets after every filter | `visibleTickets` | `/next/tickets`, the list | A11-196 | AtomautTickets |
| A row's label tags, each titled with its group | `groupTags` | `/next/tickets`, after a row's title; the Goal label is the goal pill | A11-220 | pattern: goal pill |
| The no-plan mark, muted when the parent's plan covers it | `missingPlan` | `/next/tickets`, before a row's title | A11-220 | pattern: priority mark |
| Sections by status, each collapsible and remembered | `#groups`, `groupByStatus`, `flatten`, `toggled` | `/next/tickets`, the sections | A11-196 | AtomautTickets |
| The parent tree: fold, tick picks its children, Not in this view, N tickets under it | `parentTick`, `isParentTicket` | `/next/tickets`, the tree rows | A11-196 | AtomautTickets |
| A ticket's status when nested under a parent | `titleCell()` | `/next/tickets`, a nested row's status note | A11-196 | AtomautTickets |
| Queue its children, with the instance's note | `#children-note`, `QUEUE_CHILDREN`, `QUEUE_CHILDREN_TITLE`, `childrenNote`, `queueChildren()` | `/next/tickets`, the parent row's button and the notice above the list | A11-196 | AtomautTickets |
| Needs a decision, with its reason, and Grill | `NEEDS_DECISION`, `GRILL`, `GRILL_TITLE`, `grillButton()`, `grillTicket()` | `/next/tickets`, a row's pill and button | A11-196 | AtomautTickets |
| Taken by another instance, and On the queue, on a row | `selectable`, `entryFor()` | `/next/tickets`, a row's note | A11-196 | AtomautTickets |
| The instance's empty sentence, and the scope-empty sentence | `scopeEmptyText`, `state.empty` | `/next/tickets`, the empty panel | A11-196 | AtomautTicketsEmpty |
| The paused note | `#paused-note` | `/next/tickets`, the paused banner | A11-196 | AtomautTicketsPaused |
| Remembered sections, parents, filters and project | `ticket-mode.open`, `ticket-mode.open-parents` | `/next/tickets`, the same storage keys | A11-196 | AtomautTickets |
| Loading | `state.loaded` | `/next/tickets`, the skeleton | A11-196 | AtomautTicketsLoading |

## 3. The queue bar: Tickets' queue options

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The bar, shown while tickets are selected | `#queue-bar` | `/next/tickets`, the queue bar | A11-196 | AtomautTickets |
| Model and effort for the batch | `#batch-model`, `#batch-effort`, `batchChoice`, `batchOverride` | `/next/tickets`, the Options popover | A11-196 | AtomautTickets |
| The batch's note and the Custom pill | `#batch-note`, `batchNote`, `isDefaultBatch` | `/next/tickets`, the bar's Custom pill | A11-196 | AtomautTickets |
| Use the default | `#batch-reset` | `/next/tickets`, the popover's Reset | A11-196 | AtomautTickets |
| Change the default | `#change-choice` | `/next/tickets`, the popover's Change defaults | A11-196 | AtomautTickets |
| Plan first, offered when a selected ticket has no plan | `#plan-first-label`, `#plan-first`, `unplannedCount` | `/next/tickets`, the popover's Plan first | A11-196 | AtomautTickets |
| Queue N tickets | `#queue`, `queueLabel` | `/next/tickets`, the bar's Queue button | A11-196 | AtomautTickets |

## 4. New ticket and the writers' cards

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The dialog | `#new-ticket-dialog`, `#new-ticket-title`, `openNewTicket()` | `/next/tickets`, the New ticket dialog | A11-199 | AtomautNewTicket |
| The request | `#writer-request` | The dialog's request field | A11-199 | AtomautNewTicket |
| Quick or Grill, and the note when Grill has no terminal | `#writer-mode`, `#writer-grill`, `#writer-grill-note` | The dialog's mode cards | A11-199 | AtomautNewTicketNoTerminal |
| Project, repository, goal, priority and parent | `#writer-project`, `#writer-repo`, `#writer-goal`, `#writer-priority`, `#writer-parent`, `goalNames`, `projectNames`, `WRITER_PRIORITY_LABEL` | The dialog's Manual placement | A11-199 | AtomautNewTicketManual |
| Start, and the dialog's own note | `#writer-start`, `#writer-note`, `writerStart`, `writerBody` | The dialog's Start and footer line | A11-199 | AtomautNewTicketError |
| The new tickets strip | `#writers`, `#writers-list`, `writerCard()`, `renderWriters()`, `refreshWriters()` | `/next/tickets`, the request strip | A11-199 | AtomautNewTicketWriting |
| A request's status, and the model and effort it runs on | `WRITER_STATUS_LABEL`, `writerChoiceLabel` | The request card's head | A11-199 | AtomautNewTicketQueued |
| Open terminal, Stop and Dismiss on a request | `writerRunActions`, `writerAction()`, `actionButton()` | The request card's buttons | A11-199 | AtomautNewTicketWriting |
| The question the agent asked | `writerCard()` | The waiting request card | A11-199 | AtomautNewTicketWaiting |
| Created KEY, linked, and the note when Pick does not list it | `writerTicket()` | The done request card | A11-199 | AtomautNewTicketDone |
| The failure | `writerCard()` | The failed request card | A11-199 | AtomautNewTicketFailed |
| Pick is read again when a request made a ticket or a Grill ended | `refreshWriters()` | The request strip refreshes the tickets | A11-199 | pattern: request card |

## 5. Board: the Runs page

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| Whether workers are started or paused | `#pool-state` | `/next/runs`, the pool bar | A11-197 | AtomautRuns |
| Pause or Start workers | `#toggle-pause` | `/next/runs`, the pool bar's button | A11-197 | AtomautRuns |
| How many workers at once, and Change | `#max-note`, `#change-max`, `workersLabel` | `/next/runs`, the pool bar's "N of M busy" and Change limit | A11-197 | AtomautRuns |
| The status filter with counts, remembered | `#filters`, `statusCounts`, `RUN_STATUSES`, `ticket-mode.run-filter` | The sidebar's run status rail | A11-197 | AtomautRuns |
| The runs, newest first | `#runs`, `runsShown`, `row()` | `/next/runs`, the list under its headings | A11-197 | AtomautRuns |
| The empty sentence | `.empty` | `/next/runs`, the empty panel | A11-197 | AtomautRunsEmpty |
| A row's status icon, key and title, status, repositories, model, tokens and timing | `statusIcon()`, `shownStatus`, `repoLabel`, `runChoiceLabel`, `length()`, `since()`, `runStatus` | `/next/runs`, a row | A11-197 | AtomautRuns |
| A row's pull requests as links; an address that is not http or https is text | `pullsOf`, `safeHref` | `/next/runs`, a row's pills | A11-197 | AtomautRuns |
| A row's actions and their titles | `runActions`, `APPROVE_TITLE`, `APPLY_EDIT_TITLE`, `DISCARD_EDIT_TITLE`, `DISMISS_EDIT_TITLE`, `DISMISS_TITLE`, `RESPOND_TITLE`, `START_ANYWAY_TITLE`, `hasEdit` | `/next/runs`, a row's icon buttons | A11-197 | AtomautRuns |
| Talk to it | `talkTo()` | `/next/runs`, a row's button | A11-197 | AtomautRuns |
| Reviewers off while reviews are required | `#reviewer-off-note`, `reviewerBanner` | `/next/runs`, above the pool bar | A11-220 | pattern: status banner |
| The review claims GitHub refuses | `#claim-note` | `/next/runs`, above the pool bar | A11-220 | pattern: status banner |
| Pull requests no run lists | `#pull-requests`, `unlistedPulls` | `/next/runs`, below the runs | A11-220 | pattern: run group |
| After-merge checks | `#after-merge`, `afterMergeChecks` | `/next/runs`, below the runs | A11-220 | pattern: run group |
| Publish: the tick on a Ready to merge run, the button and its note | `#publish`, `#publish-note`, `publishable`, `publishLabel`, `publishNote` | `/next/runs` | A11-218 | pattern: run group |
| A published run's Slack message link | `.published.link` | `/next/runs` and `/next/runs/<key>` | A11-218 | pattern: run group |
| A published run's terminal link | `publishTerminalLink` | `/next/runs/<key>` header | A11-218 | pattern: terminal link |
| Loading, paused and error | `renderBoard()` | `/next/runs` | A11-197 | AtomautRunsLoading |

## 6. A run's card: the Runs row's note, and Run detail

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The agent's pending prompt | `promptNote` | The Runs row's note, and the Needs you callout | A11-197 | AtomautRunDetailNeeds |
| The batch planner's shared session | `sharedRunNote` | The Runs row's note, and "Everything this run noted" | A11-220 | pattern: disclosure |
| Waits on, and the stack a run sits on | `waitsOn`, `stackedOn`, `stackNote` | The Runs row's note, and "Everything this run noted" | A11-220 | pattern: disclosure |
| The rebase, and what a queued run waits for | `rebaseNote`, `waitNote` | The Runs row's note; the Queued and Blocked callouts | A11-198 | AtomautRunDetailBlocked |
| Publishing off | `publishingOffLine` | The Runs row's note, and "Everything this run noted" | A11-220 | pattern: disclosure |
| The session note, the started-anyway note, the cut list | `sessionNote`, `overrideNote`, `cutListNote` | The Runs row's note, and "Everything this run noted" | A11-220 | pattern: disclosure |
| A restart's note: a run re-adopted after a restart, or lost in one and queued again | `readoptNote` | The Runs row's note, and "Everything this run noted" | A11-240 | pattern: disclosure |
| The reason, and the question | `reasonOf` | The callout of every state | A11-198 | AtomautRunDetailHandedBack |
| What changed in the ticket's description | `#ticket-diff-dialog`, `#ticket-diff-title`, `#ticket-diff`, `ticketChangeOf`, `diffLines`, `showTicketChange()` | `/next/runs/<key>`, a "What changed in KEY" disclosure | A11-220 | pattern: disclosure |
| The pull requests a queued plan learns from | `learnsFrom` | `/next/runs/<key>`, a "learns from" line | A11-220 | pattern: disclosure |
| What a breaking update does to the run | `updateLines` | The Runs row's note, and "Everything this run noted" | A11-217 | AtomautRunsDraining |
| The review state of each open pull request | `reviewLinesOf` | The Ready to merge callout, and Run detail's pull requests | A11-198 | AtomautRunDetailReady |
| A done run's evidence | `evidence` | "Everything this run noted" | A11-220 | pattern: disclosure |
| The proposed edit's text, now and proposed | `proposal()` | `/next/runs/<key>`, a "Proposed edit to the ticket" disclosure; Apply edit and Discard edit are the header's | A11-220 | pattern: disclosure |
| The verdict, retarget, check and merge queue notes | `verdictNote`, `retargetNote`, `checkNote`, `queueNote` | The Runs row's note, and "Everything this run noted" | A11-220 | pattern: disclosure |
| A stalled run, and what the worker is doing | `workingNote` | The Working callout | A11-198 | AtomautRunDetail |
| A parked run | `isParked` | The Runs row's note, and the Handed back callout | A11-198 | AtomautRunDetailHandedBack |
| Every line of the note, whole | `noteLines()` | `/next/runs/<key>`, "Everything this run noted" | A11-220 | pattern: disclosure |
| The run's pull requests, steps and properties | `.meta` | `/next/runs/<key>` | A11-198 | AtomautRunDetail |
| Open terminal | `.terminal` | `/next/runs/<key>`, the header's Talk to it link | A11-198 | AtomautRunDetail |
| Run gone, and loading | `entryFor()` | `/next/runs/<key>` | A11-198 | AtomautRunDetailMissing |

## 7. Settings

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The page, its title, and Back to the board | `#settings-page`, `#settings-title`, `#back-to-board`, `showRoute()`, `moveFocus()` | `/next/settings/models`, `/workers`, `/machine` and the sidebar | A11-200 | AtomautSettings |
| What the page says of itself | `.hint` | Each page's lede | A11-200 | AtomautSettings |
| The files the readers refused | `#settings-refusals` | The page's refusal alert | A11-200 | AtomautSettingsRefused |
| The notes | `#settings-notes` | The page's status banners | A11-200 | pattern: status banner |
| An instance older than the page | `drawSettingsView()` | The read-failure banner | A11-200 | pattern: status banner |
| Search by key or description, and its status | `#settings-search`, `#settings-search-status`, `searchGroups`, `drawSearch()` | The Machine, Workers and Models pages' search | A11-200 | AtomautSettingsMachine |
| Show settings at their defaults | `#settings-all` | The pages' "Show settings at their defaults" | A11-200 | AtomautSettingsMachine |
| The sections, with a count each | `#settings-groups`, `settingsGroup()`, `settingsCount()` | Each page's sections | A11-200 | AtomautSettingsMachine |
| A section's remembered open state | `ticket-mode.settings-open`, `setOpened()` | The boards draw every section open | A11-200 | AtomautSettingsMachine |
| A row: value, state, source, editable, and its Details | `settingRow()`, `detailsOf()` | A row: value, explanation and meta; "Details" holds its state, source and what breaks | A11-220 | pattern: disclosure |
| A provider row says where it is changed | `settingRow()` | A provider row's meta line | A11-220 | pattern: row meta |
| Edit, Stage change, Return to default and the problem line | `editControl()`, `valueOf()`, `stageChange()` | A row's input stages as it is typed; Return to default empties it | A11-220 | pattern: row meta |
| The Changes panel: staged list, Take back, Review changes | `#edit-panel`, `#edit-title`, `#pending`, `#pending-list`, `#review-changes`, `renderPending()` | The unsaved-changes bar, with Discard and Review changes | A11-200 | AtomautSettingsEdited |
| The review: what each file would say, and the dangerous key | `#review`, `#review-files`, `reviewOf()`, `reviewChanges()`, `changeWords()` | The review dialog | A11-200 | AtomautSettingsReview |
| Save one file | `saveFile()` | The review dialog's Save | A11-200 | AtomautSettingsSaved |
| Saved, and the refused and conflict outcomes | `#edit-refusal`, `#edit-outcome`, `showEditRefusal()` | The page's saved, refused and conflict banners | A11-200 | AtomautSettingsRefused |
| A remote instance's files are changed on that machine | `#edit-note`, `editable()` | The page's remote note, with every input read-only | A11-200 | AtomautSettingsUnreachable |
| Restore the backup of a host file, at any time | `#restores`, `restoreButtons()`, `restoreFile()`, `projectDeclared()` | `/next/settings/machine`, at the foot; Restore previous is the saved banner's | A11-220 | pattern: ghost button |
| What the Conventions plugin says: the plugins each worker loads, contract mismatches, the connectors and deny rules | `renderContractMismatchRows()` | `/next/settings/machine`, a "Conventions plugin" disclosure | A11-220 | pattern: disclosure |
| New runs: model and effort, saved as they change | `#model`, `#effort`, `saveChoice()`, `readChoice()`, `setDefault()` | `/next/settings/models` | A11-200 | AtomautSettings |
| Planning: model and effort, only on a machine that plans | `#planning-settings`, `#planModel`, `#planEffort` | `/next/settings/models` | A11-200 | AtomautSettings |
| Ticket writer: model and effort, with the host default | `#writer-settings`, `#writerModel`, `#writerEffort` | `/next/settings/models` | A11-200 | AtomautSettings |
| Workers at once | `#max`, `saveMax()`, `readMax()` | `/next/settings/workers` | A11-200 | AtomautSettingsWorkers |
| Saved, or the sentence that refused | `#settings-status`, `showSaved()`, `showRefused()` | The page's save state | A11-200 | AtomautSettings |
| The Settings address and its focus | `onSettingsPage()`, `drawSettings()`, `clearEdits()`, `sameInstance()` | The Settings routes | A11-200 | AtomautSettings |

## 8. Plugins (the Settings page's Plugins section in `ui.html`)

| Feature | In `ui.html` | Atomaut page | Ticket | Board or pattern |
| --- | --- | --- | --- | --- |
| The section, and its lede | `buildPluginsSection()`, `layoutSettings()` | `/next/settings/plugins`, the header and lede | A11-201 | AtomautPlugins |
| Reading the plugins | `readPlugins()` | The page's skeleton | A11-201 | AtomautPluginsLoading |
| The plugins could not be read | `plugins.phase` | The shared error banner, with Retry | A11-201 | AtomautPluginsUnknown |
| A concern, its plugins and its settings | `CONCERNS`, `concernOfGroup`, `PLUGIN_GROUPS`, `providerSections()`, `concernNode()` | A concern's card | A11-201 | AtomautPlugins |
| A concern with no plugin: the sentence, and the commands | `emptyWords` | The card's check row, with a Copy for each command | A11-201 | AtomautPlugins |
| A plugin's words: name, version, contract and state | `rowWords`, `pluginNode()` | The card's head | A11-201 | AtomautPlugins |
| A plugin's description and where it is | `pluginNode()` | A plugin's description is the choice of a concern with more than one plugin; where it is, is not drawn | A11-202 | pattern: card note |
| Why a plugin failed, and the fix | `failedNode()` | The card's check row | A11-201 | AtomautPlugins |
| A plugin's failing checks | `pluginNode()` | The card's check rows | A11-201 | AtomautPlugins |
| A secret is a command, never a field: Install and the set commands, with Copy | `SECRET_WORDS`, `commandNode()` | The card's secrets panel | A11-201 | AtomautPlugins |
| The controls a plan allows, off with the reason | `CONTROL_LABEL`, `controlsOf`, `controlNodes()` | The card's buttons and lock reasons | A11-201 | AtomautPlugins |
| Configure: the plugin's settings, or the project hint | `isProviderLine`, `ofAnotherPlugin` | The card's settings, edited in place | A11-201 | AtomautPlugins |
| The uninstall and replace confirmations | `runPluginAction()` | The confirm dialogs | A11-201 | AtomautPluginsConfirm |
| What an action came to | `outcomeWords`, `drawSettings()` | The applied, refused and conflict banners | A11-201 | AtomautPluginsApplied |
| Refused by the registry | `failedNode()` | The refused package's card | A11-201 | AtomautPlugins |
| A remote instance offers no control | `buildPluginsSection()` | The page's remote note | A11-201 | AtomautPluginsUnknown |
| The words about a note the plugins answer carries | `buildPluginsSection()` | The page's host note | A11-201 | pattern: status banner |
