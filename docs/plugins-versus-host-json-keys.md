# Plugins versus host.json keys

Status: **Proposed**, 2026-10-20. Decides, and builds nothing.

The record decides how far agent-org goes into plugins, and for each of the ten ticket-mode keys whether it stays in `host.json` or a plugin provides it. It is the decision input for the Plugins section of the Settings page (A11-131) and the follow-ups in section 7. It changes no code: no contract reader, no check, no page change, and no change to the a11ign plugin. The line numbers below are from agent-org's ticket-mode code as of v0.258.4.

## 1. Status and scope

The ten keys are `brief`, `review`, `deny`, `connectors`, `plugins`, `preflight`, `planner`, `writer`, `publish` and `prReview`. "Ticket mode" is the board's worker runs. The reader of each key is in `src/ticket-mode/settings.ts`, and the file is `host.json`'s `tickets` block.

This record does not wait for A11-131. Where its Plugins section has not landed, the failures below are measured from the code the worker reads now, and the page rows in section 6 use A11-131's ticket text as the specification.

## 2. Today's failures, from the code

**2.1 Enabled but not loaded.** `src/ticket-mode/plugins.ts:4-7` records the case: measured 2026-10-14, with a plugin installed for another folder, `claude plugin list` in a ticket's folder reported it enabled while the worker's session loaded none of its skills. The enabling is unconditional. `src/ticket-mode/worker-files.ts:741` writes `enabledPlugins` for every entry of `tickets.plugins`, and `pluginList` (`settings.ts:183-189`) accepts any `name@marketplace`. Nothing reads the install record until a run starts. Then `unreachablePlugins` (`plugins.ts:54-67`) reads Claude Code's install record (`plugins.ts:13`) and accepts a user install, or one whose `projectPath` is the ticket's folder, with its files in the cache (`plugins.ts:33-47`). The open gaps, all in the same code:

- It runs only at run start. `clearRunDir` throws (`pool-prepare.ts:105-109`), and it is called from `prepare` (`pool-prepare.ts:76`), from `prepareBatch` (`:153`), and before the board's own runs (`pool-start.ts:420` and `:451`). A person sees a refused run, not a row on the page.
- An unreadable record proves nothing and returns no problem (`plugins.ts:59-65`). An entry of a shape it does not know returns no problem either (`plugins.ts:36`).
- It never asks whether the skills the host file names are in the plugin.

The record's path and its shape (`installs.plugins`, with `scope`, `projectPath` and `installPath`) come from this code. The Claude Code plugin manifest reference does not document that record file, so its shape is not checked against Claude Code's own documentation.

**2.2 Skill names held as strings, never checked.** Three keys name a skill, and each check accepts any name of the right shape:

- `tickets.prReview` is checked only against `^[\w.-]+(:[\w.-]+)?$` (`settings.ts:345-349`).
- `tickets.planner.run` must contain `{key}` or `{keys}` and `{dir}` (`settings.ts:222-228`). It is refused without `tickets.plan` (`settings.ts:230`).
- `tickets.writer.run` must contain `{request}` and `{dir}` (`settings.ts:286-294`).

The pre-PR gate matches a `Skill` call by its exact name (`hook.ts:385-388`) and refuses a push until that call has run (`hook.ts:424`). If the plugin does not provide the named skill, the gate refuses every push, and nothing at load time says so. This follows from reading the gate. It has not been run against a missing skill.

**2.3 Two halves of one contract, in two places.** `tickets.plan` is a regular expression for the name of a plan file (`settings.ts:208-214`). The planning naming lives in the plugin: `plugins/a11ign/skills/create-ticket/references/plan-attachment.md:11` names the plan `0001-plan-<slug>.md`, and `:111` gives it the issue-id prefix, `<issue-id>-0001-plan-<slug>.md`. No check ties the regular expression to that name.

**2.4 Prose read by code.** `src/install/doctor.ts` matches the writer's instruction text. `writerCheck` (`doctor.ts:180-193`) looks for a mode word in `tickets.writer.run` (`:173`, `quick` or `grill`) and for the word "draft" (`:192`). It also checks that `tickets.connectors` lets a worker read a Linear ticket (`:170`, `:183`). The writer skill's behaviour is matched by its text.

**2.5 No plugin check in `agent-org doctor`.** `grep -n plugin src/install/doctor.ts` finds nothing.

**2.6 Names drift inside the plugin.** `plugins/a11ign/skills/create-ticket/SKILL.md:102` tells the reader to invoke `nbl-ui:domain-modeling` and `nbl-ui:grilling`. The plugin ships `a11ign:domain-modeling` and `a11ign:grilling`, and Claude Code namespaces every component under the plugin's name. The same `nbl-ui:` names appear in `workflow-visual-review/SKILL.md:3,69,92,102`, `tool-playwright-cli/SKILL.md:3,10` and `tool-screenshot/SKILL.md:25`. The plugin's description says it was copied from nbl-ui 0.21.0. A machine that also installs nbl-ui would satisfy these names, and nothing checks whether it does.

## 3. The classification rule, and the table

Three rules decide each row:

1. A machine fact, a permission or a secret stays in `host.json`. So does a tuning value, or anything a person on this machine should be able to grant or refuse.
2. How the work is done is the same on every machine that installs the plugin. That is what a plugin provides. `host.json` then only chooses it by name.
3. A plugin may narrow what a worker may do, but never widen it. Widening needs the person's own key.

Each row below states the reason from the code. The starting positions in the epic's record were confirmed for all ten keys, and none changed.

| Key | Decision | Reason from the code |
| --- | --- | --- |
| `plugins` | stays | The machine's choice of what to enable (`settings.ts:183-189`, `worker-files.ts:741`). It is the root every other plugin row depends on, and it gains a health row per entry (section 6). |
| `connectors` | stays | It widens what a worker may call (`connectorPatterns`, `settings.ts:247-256`), so rule 3 forbids a plugin from setting it. A plugin declares what it needs (`needs.connectors`, section 6), and the page shows a need the host has not granted. |
| `deny` | stays | The host's own refusals: the commands a worker may not run on this machine (`denyRules`, `settings.ts:316-329`). These guard the host's services and wrapper, which are this machine's facts. Plugin-supplied refusals may come later, additive only. |
| `preflight` | stays | Commands that must exit 0 before a run (`preflightOf`, `settings.ts:266-283`) are facts about this machine's health. |
| `publish` | stays | The publish run's text, model, effort and connectors (`publisherOf`, `settings.ts:305-314`) are this machine's announcements and permissions. |
| `brief` | split | The path to the machine's own notes stays (`settings.ts:50`, read per run by `notesFile`, `pool-prepare.ts:79`). How work is done, the rules every worker follows, moves to the plugin as a brief fragment (section 6). |
| `review` | split | The same, for review runs: the machine's review notes stay as a path (`settings.ts:52`, `pool-prepare.ts:84`), and the review method comes from the plugin. |
| `planner` | plugin | `run` names the plan skill, and `plan` is half its contract (`plannerOf`, `settings.ts:222-232`). The plugin declares the skill and the plan-file name. The host keeps only whether planning is on and the `state` a planned ticket moves to (`settings.ts:235-239`), which is a tracker fact. |
| `writer` | plugin, model and effort stay | `run` names the writer skill (`writerOf`, `settings.ts:286-294`). The plugin declares the skill, which removes the text matching in `doctor.ts:180-193`. Model and effort are machine tuning (`settings.ts:293`) and stay. |
| `prReview` | plugin, chosen by name | The host keeps the choice of skill name (`settings.ts:345-349`), and the gate matches that name (`hook.ts:385-388`). The plugin declares which skills it provides, so the choice can be checked. |

**More keys outside the ten.** `tickets.drafts` and `tickets.designTools` are machine facts, so they stay in `host.json` under rule 1. `designTools` says whether this machine gives workers a design tool, which decides whether step 7 of the brief has a worker do a design gate's check or decline it. Allowing the tool itself is `connectors`, which widens what a worker may call, so rule 3 keeps it out of a plugin's hands, and a plugin's declared connector need points at `tickets.connectors`, not at this key.

**A key outside the ten: `tickets.plan`.** It is not one of the ten, but it moves with `planner`. The plugin declares the plan-file name its planning skill writes (`plan-attachment.md:11`). The host keeps `plan` as the value its reader uses (`settings.ts:208-214`), and the check in section 6 compares the two. Its meaning does not change.

## 4. The options, compared against the failures

Each option names the enabled-but-not-loaded case, from section 2.1.

**(a) Stop: add no plugin surface, only more `host.json` keys.**
- Enabled-but-not-loaded: stays. It is found only at run start, and an unreadable record still proves nothing.
- Skill names and the plan-file pattern: stay unchecked. Each new key is one more string that nothing checks.
- Verdict: rejected. It widens the pair of places that disagree, which is the problem this record is for.

**(b) Go narrowly: named extension points, a contract declared in the plugin, and one reader shared by the page and the run start.**
- Enabled-but-not-loaded: removed from the page before a worker starts (section 6 rows). Run start keeps its refusal, using the same function, so the page and `clearRunDir` cannot disagree. An unreadable record shows as unknown, not as healthy.
- Skill names, plan-file pattern and declared needs: checked, by the same reader.
- Doctor's text matching of the writer (section 2.4): removed.
- Leaves: the correctness of the skills' own text. The `nbl-ui:` names (section 2.6) are removed only if the contract's test also scans the plugin's own references (follow-up F4).
- Adds: a contract to version, a field to maintain in the manifest, and a dependence on Claude Code's `metadata` field (section 6).
- Verdict: **chosen.**

**(c) Go broadly: most of the ten become plugin contributions, including `brief`, `deny`, `connectors` and `preflight`.**
- Enabled-but-not-loaded: moves with the plugin and is still present.
- Removes the most string drift.
- But `connectors` and `deny` are the widening and safety keys. A plugin would decide what a worker may call, which breaks rule 3, and the host's safety boundary would live in a file the host does not own.
- Verdict: rejected.

**(d) Keep the host keys, and add a verifier that reads the host keys and greps the plugin's skill files for their names.**
- Enabled-but-not-loaded: the verifier can read the install record, as today.
- Skill names: checked, but only by matching text.
- Leaves: there is no declared contract, so the verifier infers the plugin's shape from its files. That repeats the prose matching that `doctor.ts:170-193` already does, and it reaches into the plugin's internals, which the Backstage pattern rejects (section 5).
- Verdict: rejected as the route. Its check is kept as the contract's test, run against the plugin's own files (follow-up F4).

## 5. Four patterns, what is taken and what is left

Sources are the projects' own pages. The Home Assistant link in the ticket redirects, and the page was read at its redirect target. The statements below are paraphrases of what those pages say. They were read through a summarising fetch, so none is checked word for word, and none is quoted.

**VS Code** (`code.visualstudio.com/api/references/extension-manifest` and `/api/references/activation-events`).
- Takes: a manifest that declares what an extension contributes, which is readable without starting it. The VS Code manifest also requires `engines.vscode`, a version range that may not be a wildcard. The contract's agent-org range (section 6) takes that rule.
- Leaves: lazy activation. The VS Code page advises activating an extension only when a user needs it. A worker loads every enabled plugin at session start (`worker-files.ts:741`), so there is nothing to defer.

**Terraform** (`developer.hashicorp.com/terraform/plugin/terraform-plugin-protocol`).
- Takes: a version whose major marks incompatibility and whose minor is additive. The page states that minor versions are additive.
- Leaves: the out-of-process protocol. A skill is not a server, and nothing is negotiated at run time. The page does not say what a major bump breaks, so section 6 defines that for this contract rather than borrowing it.

**Backstage** (`backstage.io/docs/backend-system/architecture/index`).
- Takes: named extension points, which the page describes as registered and provided by plugins, and the rule that modules and plugins interact only through those registered points. The host reads what the contract names, and never a plugin's files. Plugins also do not call each other's code, so a skill calls another plugin's skill only through a declared need (section 6).
- Leaves: the dependency-injection graph and the plugin-and-module split. There is one plugin and no services to inject.

**Home Assistant** (`contributors.home-assistant.io/core/quality-scale/`, reached from the redirect of `developers.home-assistant.io/docs/core/integration-quality-scale/`).
- Takes: a visible health row per plugin, where the user looks. The page says the tier is shown on each integration's documentation page and in the device settings.
- Leaves: the graded tiers (Bronze, Silver, Gold, Platinum). The page makes them cumulative and has a reviewer check them. With one plugin, a grade is ceremony, and this repository has neither the check nor the reviewer.

## 6. Go: the contract a plugin declares

Section 7 decides go, so the contract is stated here in full.

**What it contributes.** Named extension points, each with the skill that implements it:

- `planner`: the planning skill, and `planFile`, the plan-file name it writes (`<issue-id>-0001-plan-<slug>.md`).
- `writer`: the ticket-writing skill.
- `prReview`: the pre-PR review skill.
- `brief`: a fragment file of how work is done, appended to each worker's brief.

**Where it lives.** The contract is the `metadata.agentOrg` object in the plugin's `.claude-plugin/plugin.json`. The Claude Code manifest reference says an unrecognized top-level key "is stripped and the plugin loads", and `claude plugin validate` warns about it. It also documents `metadata` as "A free-form object for your own data" that "Claude Code doesn't read", from v2.1.222. So the contract goes in `metadata`, not as a top-level key. agent-org reads the same object from the file at the install's `installPath` (`plugins.ts:15`), so the reader does not depend on how Claude Code loads the manifest. On a Claude Code older than v2.1.222 the contract's `metadata` may be stripped, and the reader still finds it in the file.

**Versions.**
- `contract`: `"<major>.<minor>"`. A major bump breaks: removing or renaming an extension point or its skill, changing what `planFile` means, or changing what an existing field means. A minor may add: an optional extension point, an optional field, or an optional `needs` entry. agent-org names the majors it reads in one constant, and a major it does not read is a mismatch row on the page (section 6).
- `agentOrg`: a range of agent-org versions the plugin works with, bounded as VS Code requires, for example `">=0.258.0 <1.0.0"`.

**What it needs.**
- Other plugins: the `dependencies` field, which the Claude Code manifest documents as "Plugins that must be enabled for this one to work", and which Claude Code enforces. agent-org only checks that the plugin appears in `tickets.plugins`.
- Connectors: `needs.connectors`, as `^mcp__` patterns, the same rule as `settings.ts:247-256`. A pattern the host does not allow is a page row.
- Commands on the path: `needs.commands`, checked with `command -v` on the page. This check is new.

**Worked example, for the a11ign plugin** (`plugins/a11ign/.claude-plugin/plugin.json`):

```json
{
  "name": "a11ign",
  "version": "0.1.0",
  "metadata": {
    "agentOrg": {
      "contract": "1.0",
      "agentOrg": ">=0.258.0 <1.0.0",
      "provides": {
        "planner": { "skill": "<the planning skill's name>", "planFile": "<issue-id>-0001-plan-<slug>.md" },
        "writer": { "skill": "a11ign:create-ticket" },
        "prReview": { "skill": "a11ign:clean-code-review" },
        "brief": { "file": "brief.md" }
      },
      "needs": {
        "connectors": ["^mcp__linear__(get|list|search|extract)_"],
        "commands": ["gh"]
      }
    }
  }
}
```

The planning skill's name is left as a placeholder on purpose. The plan-file naming is in `create-ticket/references/plan-attachment.md`, but the code this record reads does not name which skill `planner.run` runs. Follow-up F4 confirms it.

**How a mismatch shows, before a worker starts.** These mismatch rows go in A11-131's Plugins section, one per plugin in `tickets.plugins`. Each row states its fix in one sentence, as `unreachablePlugins` does (`plugins.ts:33-47`).

Existing rows, already in A11-131's scope and produced by `whyUnreachable`:
- *Not installed, or installed only for another folder.* Fix: `claude plugin install <plugin> --scope user`.
- *Files missing from Claude Code's plugin cache.* Fix: update the plugin with `/plugin`.

New rows:
- *Contract major not read by this agent-org.* Fix: update agent-org, or the plugin to a major agent-org reads.
- *This agent-org version is outside the plugin's `agentOrg` range.* Fix: update agent-org, or the plugin.
- *A declared connector need that `tickets.connectors` does not allow.* Fix: add the pattern to `tickets.connectors`.
- *A declared command that is not on the path.* Fix: install it.
- *A host key names a skill the plugin does not provide.* Fix: name a skill it provides, or remove the key.
- *A host key names a skill from a plugin that `tickets.plugins` does not enable.* Fix: add that plugin to `tickets.plugins`.
- *`tickets.plan` does not match the plan file the plugin's planner writes.* Fix: set `tickets.plan` to match it.
- *The install record cannot be read, so whether the plugin loads is unknown.* Fix: run Claude Code once, so it writes its install record.

The run start calls the same function, so the page and `clearRunDir` cannot disagree. A contract row that refuses a run refuses it before any work is made, as today. An unreadable record is still no reason to refuse a run (`plugins.ts:51-52`), so run start stays open on it, as the hook does for input it cannot read (`hook.ts:47`).

## 7. Go or no-go, and the follow-ups

**Go, narrowly.** This is option (b) of section 4. Its four properties, from the epic's grill, are all in it: a declared manifest of contributions, a versioned contract, named extension points instead of reaching into internals, and a visible health row per plugin. Each failure in section 2 is either removed by it or shown on the page. None of its steps widens what a worker may do.

**What would change this to no-go:**
- If A11-131's Plugins section can show the enabled-but-not-loaded case with today's check alone, and the plugin count stays at one with no second plugin planned, the cost of a manifest field and a reader buys little, so the record would stop at the page rows.
- If a machine is found on which Claude Code rejects the plugin because of `metadata`, the contract would have to live in the file read from `installPath` alone.

**Follow-ups.** Each is named with a title in `type(scope): description` form, the repository it lands in, its scope and what it is blocked by.

- **F1.** `feat(ticket-mode): read a plugin's declared contract and check it against the host keys`. Repository `agent-org`, in `src/ticket-mode/`. A pure reader of `metadata.agentOrg` from the install's `installPath`, and one check that returns the mismatch rows of section 6. `clearRunDir` calls the same check. Blocked by: none. With no contract present, the check returns no problem, as today.
- **F2.** `feat(ticket-mode): Plugins section rows for contract mismatches`. Repository `agent-org`, the Settings page. The mismatch rows of section 6, shown on the page. Blocked by: A11-131 (the Plugins section) and F1.
- **F3.** `refactor(ticket-mode): planner, writer and prReview name plugin extension points`. Repository `agent-org`. `plannerOf`, `writerOf` and `prReviewOf` keep reading their host keys. Their checks move to F1, and `writerCheck` in `doctor.ts` reads the contract instead of the text. Blocked by: F1, and F4, since the plugin must declare its contract before the host check can pass.
- **F4.** `feat(a11ign): declare the agent-org contract in plugin.json metadata`. Repository `plugin`. Adds `metadata.agentOrg` at contract 1.0 (section 6), and fixes the `nbl-ui:` references in `create-ticket/SKILL.md:102`, `workflow-visual-review/SKILL.md`, `tool-playwright-cli/SKILL.md` and `tool-screenshot/SKILL.md` to `a11ign:`. Adds a test that each skill the contract names exists in the plugin, and runs `claude plugin validate`. Blocked by: none. The metadata is inert until F1.
- **F5.** `feat(agent-org): agent-org doctor checks each enabled plugin`. Repository `agent-org`, `src/install/doctor.ts`. Uses F1's reader, and gives `doctor` the plugin check it lacks (section 2.5). Blocked by: F1.
- **F6.** `docs(agent-org): link the README key table to the schema`. Repository `agent-org`. The README key table is a third description of the keys, after the readers and the schema from A11-131, so it links to the schema. Blocked by: A11-131's schema child.

**Filing.** A worker cannot file these. Its connector allow list covers Linear reads and comments, and no create tool. The pull request lists them under "Filing", with the request to run for each.

## 8. Addendum (A11-144): the tracker and the code host are built in

> **Superseded by A11-157 (2026-10-21).** The chairman's decisions there replace the one this section records: every external concern, the tracker and the code host included, is an
> **agent-org plugin**, a code module behind a versioned contract that is installed, enabled, disabled, uninstalled and configured (`agent-org plugin`, A11-158). The question A11-143's
> Decision 1 answered ("a plugin, as the conventions plugin is, or a provider built in?") confused two things: a *Claude plugin* (what `tickets.plugins` lists and what this record is
> about) and an *agent-org plugin* (code the tool runs). The tracker and the code host are agent-org plugins; the conventions plugin stays a Claude plugin, and the "go, narrowly" of
> section 7 for it stands. The text below is kept as the record of what A11-144 decided at the time.
>
> **Rule 3 (a plugin may narrow, never widen) still holds for a Claude plugin, and says nothing against an agent-org plugin's `tooling` (A11-159).** An agent-org plugin is trusted code like core
> (Decision 4 of A11-157), and its manifest's `tooling` (its MCP servers, its read-only connector patterns, the tools a new-ticket run files with) declares what its own workers need. It does not
> widen a connector allow-list by itself: `tickets.providers.tracker.connectors` is still the host file's key, onboard adds the plugin's read-only patterns to it, and the PreToolUse hook still
> refuses every filing tool to a build worker.
>
> **A11-161 finished the move: no concern is built into core.** The publisher (`slack`, in `plugins/slack`) and the reviewer (`atomic`, in `plugins/atomic-reviewer`, whose name stays `atomic` through its manifest's
> `agentOrg.name`) are bundled agent-org plugins like the rest. The `publish` row of the table below still stands for the KEY: `tickets.providers.publish` (and its old `tickets.publish`) is the host file's, and
> `settings.ts` still validates it, but the settings it holds (`run`, `model`, `effort`, `connectors`) are the Slack plugin's, declared in its manifest and drawn from it by the Settings page. The built-in rows and
> the pin that kept core on them (`CORE_RUNS`, until A11-161) are gone: `none` is the absence of an enabled plugin.

The open question of A11-144 was whether the tracker and the code host are plugins, as the conventions plugin is, or built-in providers picked by name. They are built in. A11-143 Decision 1 settles it: the tracker and the code host are code that agent-org runs (API calls and auth), so each is a provider picked by name under `tickets.providers` (`tracker: linear`, `codeHost: github`), and a later tracker such as Jira is a code change behind the same provider interface. The "go, narrowly" of section 7 stands for the conventions plugin alone, which says how tickets are written and reviewed. Section 6's contract is not extended to the providers, and neither needs a `metadata.agentOrg` entry.
