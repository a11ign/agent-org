# Answering a run that asked a person

A run that is stuck on a question only a person can settle ends `needs-human`, and its card is in **Needs you**. Which questions may reach a person at all is the planner's rule (A11-257): most are settled before a run starts. For the ones that do, there is one way to answer that the board records, and it is an API call. There is no Answer box on the card, and nothing reads what a person types in a terminal.

## The call

```bash
curl -sS -X POST \
  -H "x-ticket-token: $(cat ~/.local/state/agent-org/tickets/board.key)" \
  -H 'content-type: application/json' \
  -d '{"answer":"Keep the current wording.","who":"the chairman"}' \
  http://127.0.0.1:<port>/api/queue/<KEY>/answer
```

The key is the instance's own (`board-key.ts`), sent as `x-ticket-token`, as for every other write. The chairman session and the Telegram asks bot answer through this route, and through nothing else.

| Body field | |
| --- | --- |
| `answer` | The person's answer, as text. Required, at most 4,000 characters. |
| `who` | The name the entry is headed with. Optional, one line of at most 60 characters. When absent, it is the tracker's name for the key's person, else "a person". |

## What the board does, in this order

1. **It refuses, naming why, unless a run is waiting on a person.** The ticket's run must be on the board and finished with a `needs-human` outcome the board could read, the ticket must not be completed or closed in the tracker, and the tracker must be able to edit a ticket's text. A refusal is a `400` with `{ "error": "<why>" }`, and nothing is written or sent.
2. **It writes the ticket first.** It reads the ticket's description fresh and adds an entry to it, through the tracker plugin's `updateTicketText`:

   ```md
   ## Decisions (<who>, <YYYY-MM-DD>)

   * **Question:** <the run's needs-human reason, as the board shows it>
   * **Answer:** <the answer, as given>
   ```

   The entry goes in as the description's last section, or under the last section when that has the same heading. The same question and answer already in the description is not written again. A write the tracker refuses is a `400`, and the run is sent nothing.
3. **It sends the answer to the waiting run.** A run that is parked (its workspace still open) is sent one message: who answered what, where the ticket records it, and an instruction to carry on with the answer and to link that entry whenever it tells a pull request that a person decided something. The board then sees the agent working again and resumes the run, as it does for any parked run.

A worker, a planner or a reviewer never writes a Decisions entry: only this route does, and only from the text of the request. `ticket:hook` refuses every ticket run a command that names the key's file or a queue action route, and any file tool on the key.

## The answer

A `200` carries the queue, as the other verbs do, and:

| Field | |
| --- | --- |
| `written` | `true`: the entry is in the ticket. |
| `delivered` | `true` when the run was sent the answer. `false` when its workspace is gone, so nothing was waiting for it. |
| `why` | When `delivered` is `false`, why. The answer is in the ticket, and the run that works the ticket next reads its Decisions first. Retry plans or works the ticket again. |

A `502` means the answer **is in the ticket** and herdr would not take the message to the run (`agent_blocked`, for one): `{ "error": "...", "written": true, "delivered": false }`. Send the same answer again. It finds its entry already in the ticket, writes nothing a second time, and sends the message.

## What reads the entry

Every brief tells a worker to read the ticket's `## Decisions` sections before the plan: a decision overrides the plan, its files and the worker's own preference. The planner's brief asks for a `## Ticket decisions` section in the plan, one `Follows:` or `Conflicts:` bullet for each decision, and the board does not attach a plan that has a `Conflicts:` bullet or no such section. The reviewer reads the ticket's decisions through `decisionsOf` (`ticket-decisions.ts`).
