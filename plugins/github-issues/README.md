# GitHub Issues, the second tracker

`plugins/github-issues` is a tracker plugin: the open issues of one GitHub repository are the board's tickets. It implements the tracker contract (`src/plugins/contracts/tracker.ts`, version 1.9) and passes its suite (`conformance.test.ts`), as `plugins/linear` does. It reads and writes through GitHub's REST API with a token, and never through `gh`: the code host plugin, `plugins/github`, stays the only place `gh` runs.

## Setting it up

In `host.json`, name the plugin as the tracker and the repository whose issues are the tickets:

```json
{
  "tickets": {
    "providers": {
      "tracker": {
        "provider": "github-issues",
        "repo": "acme/tracker",
        "prefix": "GH",
        "token": { "path": "/home/me/.config/agent-org/github-issues.token" }
      }
    }
  }
}
```

- `repo` is required, as `owner/name`.
- `prefix` is optional, and `GH` by default. Issue 12 is the ticket `GH-12`, and its branch is `gh-12`.
- `token` says where the token is: `{ "path": "/abs/file" }`, a file of mode 600, or `{ "keychain": "<service>" }`, the macOS Keychain. With no `token`, the plugin reads the Keychain service `agent-org-github-issues`. The token needs to read and write the repository's issues: a fine-grained token with Issues read and write on that repository, or a classic token with `repo`.
- `connectors`, `workingState`, `plannedState` and `takenStates` work as they do for Linear, with the state names below. `connectors` takes the patterns of GitHub's MCP issue tools.

The token's setting is `token`, not Linear's `key`, so the Settings page keeps Linear's wording for a host that keeps Linear.

`agent-org doctor` shows one row for the plugin, `tracker key`: the settings are well formed, the token can be read, and a token file is readable by no one else. Onboard asks nothing for it yet.

## How Linear's model maps onto GitHub Issues

GitHub Issues has no workflow states, no priorities and no label groups. The plugin keeps each in labels and in the issue's open or closed state. The mapping is in `mapping.ts`.

### States

| State | Type | How GitHub holds it |
| --- | --- | --- |
| Backlog | backlog | an open issue with no `state:` label |
| Todo | unstarted | an open issue labelled `state: Todo` |
| Planned | unstarted | an open issue labelled `state: Planned` |
| In Progress | started | an open issue labelled `state: In Progress` |
| In Review | started | an open issue labelled `state: In Review` |
| Done | completed | a closed issue, closed as completed |
| Canceled | canceled | a closed issue, closed as not planned |
| Duplicate | duplicate | a closed issue, closed as a duplicate |

- A move to an open state takes the issue's other `state:` labels off, puts the new one on, and reopens the issue if it was closed. A move to a closed state closes the issue with the matching reason, and leaves its labels alone.
- An open issue with two `state:` labels is in the later of the two states. A `state:` label that names no state above is ignored.
- A host's `workingState` or `plannedState` must be one of these names. A name outside the table keeps the ticket's state, and the note says so, as a Linear team with no such state does.
- A plan moves only a Backlog ticket. A worker starting moves a Backlog, Todo or Planned ticket.

### Priorities

A `priority: urgent`, `priority: high`, `priority: medium` or `priority: low` label gives the ticket priority 1, 2, 3 or 4, as Linear numbers them. With none, the priority is 0. With two, the more urgent one counts.

### Labels and label groups

Linear nests labels under a parent label, a group. GitHub labels are flat, so the part of a label's name before `: ` is its group: `Bucket: Bug` is the label `Bug` of the group `Bucket`. A label without `: ` stands alone. The `state:` and `priority:` labels are read as the state and the priority, and are not shown as labels.

### Projects

A Linear project is a GitHub milestone. Its title is the project's name, and its description is the project's summary, where a repository's address is written (`github.com/<owner>/<repo>`). Only open milestones are listed in the Pick view's project picker. `tickets.pick` set to `{ "project": "<title>" }` lists that milestone's open issues, and `{ "team": "<anything>" }` lists every open issue of the repository.

### Sub-issues and parents

GitHub's own sub-issues are the ticket's children, and its parent issue is the ticket's parent. An issue with an open sub-issue is a parent, which the board never queues itself, as a Linear epic. The plugin reads an issue's sub-issues only when GitHub's summary says one is still open, so an ordinary issue costs no extra request. A sub-issue must be in the same repository to be named by its key.

### Blocked by

GitHub's issue dependencies are Linear's "blocked by". `addBlockers` adds a dependency once, and adding it again changes nothing. A blocker in another repository is named by its address, not by a key.

### Plans, attachments and claims

- GitHub's API cannot attach a file to an issue, so a plan file is a comment whose first line names the file: `<!-- agent-org attachment: <name> -->`, then the file's text. A file already kept under its name is not posted again. A re-plan deletes those comments. A worker's download writes each one to a file. A file longer than 65,000 characters cannot be kept, and the attach is refused by name.
- A claim is a comment, `agent-org: claimed by <instance>`, as with Linear.
- The comments a planner and a worker are briefed with leave out the plan and claim comments.

### Pull requests and closing words

- A pull request is linked to a ticket when it names the issue: GitHub then lists a cross-reference on the issue's timeline, and the plugin reads each one's state and title from it.
- GitHub closes an issue on merge only for a closing word followed by `#<number>` or the issue's address. Its words are close, fix and resolve, each with its -s and -d forms. A pull request body that names the key (`Closes GH-12`) does not close it, so the board closes the ticket itself once the pull request merges, as it completes a Linear ticket whose pull request did not.
- When GitHub closed the issue from a commit or a pull request, or an app closed it, `undoAutomaticCompletion` reopens it, in the state its labels name, and posts the board's comment. A closing by a person, the board's own included, is left alone.

## What is not there yet

- `people` and `scoped`: the Pick view lists the token holder's open issues, the milestone picker and search reach the rest.
- The writer tooling (`agentOrg.tooling.writer`): a new-ticket run cannot file a GitHub issue yet, because the key a filing tool answers with is an issue number, not `<prefix>-<number>`. That is core's to read, in step 2 of A11-447.
- Onboard steps.
