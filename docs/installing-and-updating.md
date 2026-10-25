# Installing and updating: the `agent-org` command

The `agent-org` a person types must be the installed tool. On 2026-10-25 it was not: `agent-org` in the shell was an alias in `~/.zshrc` to an old checkout (v0.276.0) while the installed tool was v0.304.1. `agent-org update`, typed by hand, ran that stale code, moved `current` to v0.306.0 without the board's UI build, and the board showed "The UI build is missing". Nothing warned that the command was not the installed tool (A11-285). This page says what the command is, who writes it, and what checks it.

## What the command is

The installed tool is `<agent-org home>/tool/current` (`~/.agent-org/tool/current`, or under `$AGENT_ORG_HOME`), a link to the newest folder under `tool/versions/`. An update moves the link; every service runs through it.

The `agent-org` command is a **shim**: a small script that runs `<agent-org home>/tool/current/src/bin.ts`. It names `current` and never a version folder, so an update changes what it runs and the shim is never rewritten.

| Who | Where it writes the shim |
|---|---|
| `install.sh` | `~/.local/bin/agent-org` (`$AGENT_ORG_BIN_DIR`), at the end of every install and update. |
| `agent-org onboard` | `binDir` (the host file's, else `~/.local/bin`), when there is none, on a host that declares no project. |
| `agent-org host:install` | `binDir`, on an org host (one that declares a `primary` project): the shipped `host/agent-org`, rendered to run `current` when the machine has one, else host.json's `tool`. |

`install.sh`, `onboard` and `host:install` write the same shim. A test holds `install.sh`'s text and `src/install/launcher.ts` to the same bytes.

## What doctor checks

`agent-org doctor` has an `agent-org command` row, straight after `launcher`. It asks the person's login shell what `agent-org` is (`$SHELL -lic 'type agent-org'`: an alias, a function or a file on `PATH`), follows it to the copy of the tool it runs, and compares that with the installed tool.

- **ok**: it reaches the installed tool through `current`: the shim, or an alias or function naming `~/.agent-org/tool/current/src/bin.ts`.
- **ok (development)**: it runs the checkout host.json names as `devTool` (an absolute path), and that checkout is at least as new as the installed tool.
- **fail**: it runs anything else. The row says what it is (an alias, a function or a file), where it is defined (`~/.zshrc:42`), which copy it runs and that copy's version against the installed one, and the exact fix. A path that names a version folder directly (`tool/versions/v0.306.0`) fails even while `current` names that folder, because the next update leaves it behind.
- **ok** (nothing to compare): this machine has no installed tool yet (no `current`), as on an install that has not migrated. There is nothing for the command to be compared with.
- **warn** (passes): the shell could not be asked (it timed out, or answered with nothing the check understands), or it finds no `agent-org` on `PATH`. The row says how to look: `type agent-org`.

To read a fail, take the file and line it names, and run the fix it prints:

```
node ~/.agent-org/tool/current/src/bin.ts command:check --fix
```

It is run through `current` on purpose: the `agent-org` you type may be the thing that is wrong.

### How a copy's age is told

Two release folders are ordered by their tags. Anything else, a checkout of `main` for one, is ordered by git: the installed release's source commit (the first parent of its tag commit in the mirror `tool/repo.git`) must be in the copy's history. `main`'s `package.json` says `0.2.0` and lags every tag, so a version number cannot place a checkout. A copy that does not hold the commit cannot be told, and it counts as older; the fix is `git -C <copy> fetch origin --tags`.

### Developing from a checkout

Name the checkout in the host file, as an absolute path:

```json
{ "devTool": "/home/me/src/agent-org" }
```

Doctor then passes an `agent-org` that runs that checkout while it is at least as new as the installed tool, and fails it as soon as it is older.

## The check at the end of every install

`install.sh` and `onboard` end by running the same check: `agent-org command:check --fix --ask`, from the release just installed. If the shell's `agent-org` is an alias, a function or a file on `PATH` that is not the installed tool, they say so, show the file and line, and offer to fix it:

- An **alias** or a **one-line function** is commented out under the marker `# agent-org (A11-285): replaced by the installed command <binDir>/agent-org on <date>; was:`. A **multi-line function** is commented out up to the first line that is `}` alone.
- A **file on `PATH`** is renamed to `<file>.before-agent-org-<stamp>`, and the shim is written in its place.
- Before either, the whole start-up file is kept as `<file>.before-agent-org-<stamp>`, byte for byte. Nothing is deleted.
- Only a definition that stands alone is edited: an alias alone on its line, or a function whose closing `}` it can find. An alias that shares its line with another command, or runs past it, is left as it is, and the fix says so. After an edit the person's shell is asked to accept the file (`<shell> -n`); a file it refuses (the definition was the only statement of an `if`, say) is put back exactly as it was, and its backup removed.
- A start-up file that is a link is edited where it lives, when that is inside the home folder. A file outside the home folder (`/usr/local/bin/agent-org`, a system `zshenv`, a link into one) is never edited; the fix names the command for the person to run.
- On an org host (the host file declares a `primary` project), the launcher in `binDir` belongs to `agent-org host:install`: `onboard` writes none, `command:check --fix` does not rewrite it, and a stale one fails the row with `host:install` as the fix. An alias or function is fixed there as anywhere.

At a terminal, `install.sh` asks `Replace it with the installed command? A backup is kept. [Y/n]` on `/dev/tty` (it cannot ask on stdin when run as `curl ... | bash`), and onboard asks through its own prompt. With nobody to ask, both replace without asking, and say so.

**The install does not report success while the shell's `agent-org` would run another copy.** If the fix is declined, or cannot be made, `install.sh` ends with its failure line, and onboard ends with `agent-org is not fully set up` and a ✗ line, in both cases with the fix to run. A release older than this change has no check, and `install.sh --version` of one skips it.

`agent-org update` does not edit start-up files: it also runs from the auto-update timer, where nobody is there to see a start-up file change. It refuses from an older copy instead (below), and doctor reports the row.

## Commands that refuse to run from the wrong copy

`update`, `host:install` and `start` change the install or the services, so they refuse to run from a copy of the tool that is not the installed one and is older than it (or whose age cannot be told). Exit status 2, and the message says which copy ran and how to run the right one:

```
agent-org update: refused: this ran ~/old/agent-org (v0.276.0), which is not the installed tool and is older than it (v0.304.1). Run `~/.local/bin/agent-org update`, or `node ~/.agent-org/tool/current/src/bin.ts update`; `agent-org doctor` shows what your `agent-org` runs. `--allow-older-copy` runs it from this copy anyway.
```

`--allow-older-copy`, anywhere in the arguments, runs the command from that copy anyway, for development. The bin removes it, so the command never sees it. The installed tool, a newer copy, and a machine with no `current` yet (an install that has not migrated) run as they always did. Every other command starts without any comparison.

A copy older than this change has no guard; the doctor row and the end-of-install check cover that case.
