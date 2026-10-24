#!/usr/bin/env bash
# Install agent-org, or update an install in place:
#
#   curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash -s -- --version v0.3.0
#
# It keeps a bare mirror of the repository in $AGENT_ORG_HOME/tool/repo.git (default ~/.agent-org/tool/repo.git), builds the newest release tag (or --version)
# into its own folder, $AGENT_ORG_HOME/tool/versions/<tag>, with the release's dependencies, points $AGENT_ORG_HOME/tool/current at it, and writes an
# `agent-org` launcher into ~/.local/bin that runs through `current`. Each release is a folder of its own, so a run that started on one keeps calling that
# folder while a newer one is built beside it (A11-169). It changes nothing else: no sudo, no system package, no shell rc file. Running it again fetches the
# tags and builds the newest into a new folder. An earlier install's checkout, $AGENT_ORG_HOME/agent-org, is left as it is.
#
# It checks what it needs (git, tar, Node, a way to run pnpm) before it writes anything, lists every problem at once with the command that fixes it, and prints
# a short report for a person: a header, one line per step, the outcome on its own line, then the next commands. --verbose adds where the mirror, the version
# folder and `current` are (A11-185).
#
# Written for bash 3.2, the one a Mac has: no associative arrays, and no empty array expanded under `set -u`.
set -euo pipefail

MIN_NODE_MAJOR=24
# The pnpm the release's dependencies are installed with, run by version, never the pnpm on PATH. The first of these that exists runs it, and `src/install/pnpm.ts`
# holds the same value and the same order: the corepack beside node, then a corepack on PATH, then `npm exec`, which every npm has (A11-185). A test holds the
# version, release.yml and CI to one value.
PNPM_VERSION=10.34.5
REPO_URL="${AGENT_ORG_REPO:-https://github.com/a11ign/agent-org.git}"
AGENT_ORG_HOME="${AGENT_ORG_HOME:-$HOME/.agent-org}"
BIN_DIR="${AGENT_ORG_BIN_DIR:-$HOME/.local/bin}"
TOOL="$AGENT_ORG_HOME/tool"
MIRROR="$TOOL/repo.git"
VERSIONS="$TOOL/versions"
CURRENT="$TOOL/current"
LEGACY_CHECKOUT="$AGENT_ORG_HOME/agent-org"
RELEASE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# The report. Everything it prints goes to stdout, in one of two forms chosen once: marks and colour on a terminal, plain `ok` / `FAILED` otherwise.
VERBOSE=0
HEADER_SHOWN=0
STEPS_SHOWN=0
STEP_FAILED=""   # the label of the step now running, shown with a failure mark if the script ends inside it
DETAILS=""       # the --verbose lines under that step, printed with its line
PROBLEM_COUNT=0
PROBLEM_LINES="" # every problem, written out for a person, one after another
FIRST_PROBLEM=""
NOTES=""         # what a person should read between the steps and the outcome
CHANGED="Nothing was changed."
TEMPORARY=""     # the launcher being written, removed if the script ends before it is moved into place
INSTALLED_TAG=""
LAUNCHER=""
RUNNER_VIA=""    # how the pinned pnpm runs: "corepack beside node", "corepack on PATH" or "npm exec"
RUNNER_NOTE=""   # the dependency line's note: empty for the usual corepack beside node

if [ -t 1 ]; then
  TTY=1
  MARK_OK="✓"; MARK_FAILED="✗"
  GREEN=""; RED=""; BOLD=""; RESET=""
  if [ -z "${NO_COLOR:-}" ]; then
    GREEN=$'\033[32m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
    MARK_OK="${GREEN}✓${RESET}"; MARK_FAILED="${RED}✗${RESET}"
  fi
else
  TTY=0
  MARK_OK="ok"; MARK_FAILED="FAILED"
  GREEN=""; RED=""; BOLD=""; RESET=""
fi

has() { command -v "$1" >/dev/null 2>&1; }

# A path under the home folder, as a person writes it.
tilde() {
  if [ -n "${HOME:-}" ]; then
    case "$1" in
      "$HOME") printf '~'; return ;;
      "$HOME"/*) printf '~/%s' "${1#"$HOME"/}"; return ;;
    esac
  fi
  printf '%s' "$1"
}

show_header() {
  if [ "$HEADER_SHOWN" -eq 0 ]; then
    HEADER_SHOWN=1
    printf '%s\n\n' "${BOLD}Installing agent-org${RESET}"
  fi
}

# --verbose lines, printed under the step's line when it ends.
detail() {
  if [ "$VERBOSE" -eq 1 ]; then DETAILS="$DETAILS      $*"$'\n'; fi
}

step_begin() { STEP_FAILED="$1"; DETAILS=""; }

# The step ended well: its line, then its --verbose lines. $2 is a note in brackets after the label.
step_done() {
  local note=""
  if [ -n "${2:-}" ]; then note="  ($2)"; fi
  show_header
  printf '  %s %s%s\n' "$MARK_OK" "$1" "$note"
  printf '%s' "$DETAILS"
  STEPS_SHOWN=1; STEP_FAILED=""; DETAILS=""
}

# A step that shows only with --verbose: a clean preflight is not news.
step_done_quietly() {
  if [ "$VERBOSE" -eq 1 ]; then step_done "$1"; else STEP_FAILED=""; DETAILS=""; fi
}

# One problem, written for a person: what is wrong, then how to fix it. $2 leads in to the commands, which follow it, one per line.
problem() {
  PROBLEM_COUNT=$((PROBLEM_COUNT + 1))
  if [ -z "$FIRST_PROBLEM" ]; then FIRST_PROBLEM="$1"; fi
  if [ "$#" -ge 3 ]; then
    PROBLEM_LINES="$PROBLEM_LINES  $1. $2:"$'\n'
    shift 2
    local command
    for command in "$@"; do PROBLEM_LINES="$PROBLEM_LINES    $command"$'\n'; done
  else
    PROBLEM_LINES="$PROBLEM_LINES  $1."$'\n'
  fi
}

fail() { problem "$@"; exit 1; }

# Runs on every exit, so every ending says whether agent-org is installed, including a step that stopped the script under `set -e`.
on_exit() {
  local status=$?
  if [ -n "$TEMPORARY" ]; then rm -f "$TEMPORARY" || true; fi
  show_header
  if [ "$status" -eq 0 ]; then report_success; else report_failure; fi
}

report_success() {
  printf '\n'
  if [ -n "$NOTES" ]; then printf '%s\n' "$NOTES"; fi
  if [ "$TTY" -eq 1 ]; then
    printf '%s\n' "${BOLD}${GREEN}agent-org $INSTALLED_TAG is installed.${RESET}"
  else
    printf 'agent-org install OK: %s installed, command at %s\n' "$INSTALLED_TAG" "$(tilde "$LAUNCHER")"
  fi
  printf '\nNext:\n'
  printf '  %-22s%s\n' "agent-org onboard" "set up this machine"
  printf '  %-22s%s\n' "agent-org doctor" "check everything works"
}

report_failure() {
  local reason
  if [ "$PROBLEM_COUNT" -eq 0 ]; then problem "a step failed; the message above says why"; fi
  if [ "$PROBLEM_COUNT" -eq 1 ]; then
    reason="$FIRST_PROBLEM."
  else
    reason="$PROBLEM_COUNT things agent-org needs are missing (listed above)."
  fi
  if [ -n "$STEP_FAILED" ]; then
    printf '  %s %s\n' "$MARK_FAILED" "$STEP_FAILED"
    STEPS_SHOWN=1
  fi
  if [ "$STEPS_SHOWN" -eq 1 ]; then printf '\n'; fi
  if [ "$TTY" -eq 1 ]; then printf '%s\n\n' "${BOLD}${RED}agent-org was not installed.${RESET}"; fi
  printf '%s\n  %s\n' "$PROBLEM_LINES" "$CHANGED"
  if [ "$TTY" -eq 0 ]; then printf '\nagent-org install FAILED: %s %s\n' "$reason" "$CHANGED"; fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version vX.Y.Z] [--verbose]

Installs the newest agent-org release, or the one --version names, into its own folder under $AGENT_ORG_HOME/tool/versions
(default ~/.agent-org/tool/versions), points $AGENT_ORG_HOME/tool/current at it, and writes the `agent-org` launcher into ~/.local/bin.
It checks git, tar, Node and a way to run pnpm first, and changes nothing when one is missing.
--verbose also says where the mirror, the version folder and `current` are.
EOF
}

# Point $CURRENT at versions/$1 with one rename, so a service starting at any moment finds a whole tool. `ln -sfn` would unlink first.
swap_current() {
  node -e '
    const fs = require("node:fs");
    const [target, link] = process.argv.slice(1);
    const next = `${link}.${process.pid}.new`;
    fs.rmSync(next, { force: true });
    fs.symlinkSync(target, next, "dir");
    fs.renameSync(next, link);
  ' "versions/$1" "$CURRENT"
}

# How the node on PATH got there: homebrew, nvm, fnm or other (plain nodejs.org, a distro package). With no node, from what else is on this machine.
node_origin() {
  local node_path="" prefix=""
  node_path="$(command -v node 2>/dev/null || true)"
  case "$node_path" in
    */.nvm/*) echo nvm; return ;;
    */fnm/*|*/.fnm/*|*/fnm_multishells/*) echo fnm; return ;;
    */Cellar/*) echo homebrew; return ;;
  esac
  if has brew; then
    prefix="$(brew --prefix 2>/dev/null || true)"
    if [ -z "$node_path" ] || { [ -n "$prefix" ] && [ "${node_path%/*}" = "$prefix/bin" ]; }; then echo homebrew; return; fi
  fi
  if [ -n "${FNM_DIR:-}${FNM_MULTISHELL_PATH:-}" ]; then echo fnm; return; fi
  if [ -n "${NVM_DIR:-}" ]; then echo nvm; return; fi
  echo other
}

# The node problem, with the command that fixes it for how node was installed here. $1 is what is wrong; $2 is "missing" or "old".
node_problem() {
  local download="Download Node.js $MIN_NODE_MAJOR or newer from https://nodejs.org/en/download"
  case "$(node_origin)" in
    homebrew)
      if [ "$2" = old ]; then problem "$1" "To fix it, run" "brew upgrade node"; else problem "$1" "To fix it, run" "brew install node"; fi ;;
    nvm) problem "$1" "To fix it, run" "nvm install $MIN_NODE_MAJOR && nvm use $MIN_NODE_MAJOR" ;;
    fnm) problem "$1" "To fix it, run" "fnm install $MIN_NODE_MAJOR && fnm use $MIN_NODE_MAJOR" ;;
    *)
      if has brew; then
        problem "$1" "$download, or run" "brew install node"
      else
        problem "$1" "$download, or with a version manager, run" "fnm install $MIN_NODE_MAJOR && fnm use $MIN_NODE_MAJOR" "nvm install $MIN_NODE_MAJOR && nvm use $MIN_NODE_MAJOR"
      fi ;;
  esac
}

# git or tar is missing: the command that installs it on this system. $1 is the program, $2 what is wrong.
tool_problem() {
  if [ "$(uname -s 2>/dev/null || true)" = Darwin ]; then
    if [ "$1" != git ]; then problem "$2"
    elif has brew; then problem "$2" "To fix it, run one of" "xcode-select --install" "brew install git"
    else problem "$2" "To fix it, run" "xcode-select --install"; fi
  elif has apt-get; then problem "$2" "To fix it, run" "sudo apt-get install $1"
  elif has dnf; then problem "$2" "To fix it, run" "sudo dnf install $1"
  else problem "$2. Install $1 with your system's package manager"; fi
}

# The corepack beside node: $AGENT_ORG_COREPACK when set (a test), else the one in node's own folder.
corepack_beside_node() { printf '%s' "${AGENT_ORG_COREPACK:-$(dirname "$(command -v node)")/corepack}"; }

# The first of: the corepack beside node, a corepack on PATH, npm exec. Sets RUNNER_VIA, and RUNNER_NOTE for one that is not the usual. Returns 1 when there is none.
find_runner() {
  if [ -x "$(corepack_beside_node)" ]; then
    RUNNER_VIA="corepack beside node"; RUNNER_NOTE=""
  elif has corepack; then
    RUNNER_VIA="corepack on PATH"; RUNNER_NOTE="pnpm $PNPM_VERSION through corepack on PATH"
  elif has npm; then
    RUNNER_VIA="npm exec"; RUNNER_NOTE="pnpm $PNPM_VERSION through npm exec"
  else
    return 1
  fi
}

# Run the pinned pnpm with the arguments given, the way find_runner chose.
run_pnpm() {
  case "$RUNNER_VIA" in
    "corepack beside node") COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$(corepack_beside_node)" "pnpm@$PNPM_VERSION" "$@" ;;
    "corepack on PATH") COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack "pnpm@$PNPM_VERSION" "$@" ;;
    *) npm exec --yes "pnpm@$PNPM_VERSION" -- "$@" ;;
  esac
}

# The two commands that give a machine a runner, the one that fits first. Both are named whatever the platform: the ticket asks for both.
runner_problem() {
  local why="pnpm $PNPM_VERSION cannot run: there is no corepack beside node or on PATH, and no npm to run \`npm exec\` with"
  if [ "$(node_origin)" = homebrew ]; then
    problem "$why" "To fix it, run one of" "brew install corepack" "npm install -g corepack"
  else
    problem "$why" "To fix it, run one of" "npm install -g corepack" "brew install corepack"
  fi
}

# Everything the install needs, checked before anything is written, every problem listed.
preflight() {
  local node_version="" node_major=""
  if has git; then detail "$(git --version 2>/dev/null || echo "git found")"; else tool_problem git "git is not installed"; fi
  if has tar; then detail "tar found"; else tool_problem tar "tar is not installed, and the release is unpacked with it"; fi
  if ! has node; then
    node_problem "Node.js $MIN_NODE_MAJOR or newer is needed, and there is no \`node\` on PATH" missing
    return 0
  fi
  node_version="$(node --version 2>/dev/null || true)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  case "$node_major" in
    ''|*[!0-9]*) node_problem "Node.js $MIN_NODE_MAJOR or newer is needed, and \`node --version\` printed \"$node_version\"" old ;;
    *)
      if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
        node_problem "Node.js $MIN_NODE_MAJOR or newer is needed, and node is $node_version" old
      else
        detail "node $node_version"
      fi ;;
  esac
  if find_runner; then detail "pnpm $PNPM_VERSION runs through $RUNNER_VIA"; else runner_problem; fi
}

# Whether the release in $1 declares dependencies. Sets the answer in HAS_DEPENDENCIES: 0 none, 10 some.
HAS_DEPENDENCIES=0
read_dependencies() {
  HAS_DEPENDENCIES=0
  (cd "$1" && node -e 'process.exit(Object.keys(require("./package.json").dependencies ?? {}).length > 0 ? 10 : 0)') || HAS_DEPENDENCIES=$?
}

# Everything runs from main, called on the last line, so a download cut short by the network runs nothing.
main() {
  local version="" tag launcher folder partial earlier="" clause
  trap on_exit EXIT
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) [ "$#" -ge 2 ] || fail "--version needs a tag, such as v0.3.0"; version="$2"; shift 2 ;;
      --version=*) version="${1#--version=}"; shift ;;
      --verbose) VERBOSE=1; shift ;;
      -h|--help) trap - EXIT; usage; exit 0 ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
  done
  show_header
  if [ -n "$version" ] && ! printf '%s\n' "$version" | grep -Eq "$RELEASE_TAG"; then
    fail "--version $version is not a release tag such as v0.3.0"
  fi

  # The launcher holds these paths in single quotes, and the PATH line it prints holds BIN_DIR in double quotes.
  case "$AGENT_ORG_HOME$BIN_DIR" in
    *"'"*|*'"'*|*'$'*|*'`'*|*\\*|*$'\n'*) fail "AGENT_ORG_HOME and AGENT_ORG_BIN_DIR must not hold a quote, \$, a backquote, a backslash or a line break" ;;
  esac
  case "$AGENT_ORG_HOME" in /*) ;; *) fail "AGENT_ORG_HOME must be an absolute path, and it is $AGENT_ORG_HOME" ;; esac
  case "$BIN_DIR" in /*) ;; *) fail "AGENT_ORG_BIN_DIR must be an absolute path, and it is $BIN_DIR" ;; esac

  step_begin "Check what agent-org needs"
  preflight
  if [ "$PROBLEM_COUNT" -gt 0 ]; then exit 1; fi
  step_done_quietly "Checked what agent-org needs"

  step_begin "Download agent-org"
  if [ -L "$CURRENT" ]; then earlier="$(readlink "$CURRENT")"; earlier="${earlier#versions/}"; fi
  if [ -n "$earlier" ]; then clause="Your earlier install, $earlier, still works."; else clause="Nothing is installed yet."; fi
  if [ ! -d "$AGENT_ORG_HOME" ]; then
    (umask 077 && mkdir -p "$AGENT_ORG_HOME")
  fi
  mkdir -p "$TOOL" "$VERSIONS"
  CHANGED="$clause"
  if [ -f "$MIRROR/HEAD" ]; then
    git --git-dir "$MIRROR" fetch --quiet --force --tags origin
    detail "updated $(tilde "$MIRROR")"
  elif [ -e "$MIRROR" ]; then
    fail "$(tilde "$MIRROR") exists and is not a git repository" "To fix it, move it away, then run this again. Run" "mv \"$MIRROR\" \"$MIRROR.old\""
  else
    git clone --bare --quiet -- "$REPO_URL" "$MIRROR"
    detail "cloned $REPO_URL into $(tilde "$MIRROR")"
  fi
  CHANGED="Its download was kept in $(tilde "$TOOL"), so the next run is faster. $clause"

  if [ -n "$version" ]; then
    git --git-dir "$MIRROR" rev-parse --quiet --verify "refs/tags/$version" >/dev/null || fail "there is no release $version"
    tag="$version"
  else
    # Numeric order, field by field: v0.10.0 is newer than v0.9.0, which a plain text sort gets backwards.
    tag="$(git --git-dir "$MIRROR" tag --list 'v*' | grep -E "$RELEASE_TAG" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
    [ -n "$tag" ] || fail "$REPO_URL has no release tag yet"
    tag="v$tag"
  fi

  folder="$VERSIONS/$tag"
  partial="$folder.partial"
  if [ -f "$folder/src/bin.ts" ]; then
    detail "$tag was built already, in $(tilde "$folder")"
    step_done "Downloaded agent-org $tag"
    read_dependencies "$folder"
    if [ "$HAS_DEPENDENCIES" -eq 10 ]; then step_done "Installed its dependencies"; fi
  else
    # Built beside, renamed into place when whole: a failed or killed install leaves no folder that looks built, and `current` where it was.
    rm -rf "$partial" "$folder"
    mkdir -p "$partial"
    if ! git --git-dir "$MIRROR" archive --format=tar "refs/tags/$tag" | tar -xf - -C "$partial"; then
      rm -rf "$partial"
      fail "could not unpack $tag from $(tilde "$MIRROR")"
    fi
    [ -f "$partial/src/bin.ts" ] || { rm -rf "$partial"; fail "$tag holds no src/bin.ts, so it is not a release of agent-org"; }
    detail "built into $(tilde "$folder")"
    step_done "Downloaded agent-org $tag"

    # The release's runtime dependencies, when its package.json declares any.
    read_dependencies "$partial"
    case "$HAS_DEPENDENCIES" in
      0) ;;
      10)
        step_begin "Install its dependencies"
        if ! (cd "$partial" && run_pnpm install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace --silent); then
          rm -rf "$partial"
          fail "installing the dependencies failed, so current stays where it was. Fix what pnpm printed above, then run this again"
        fi
        step_done "Installed its dependencies" "$RUNNER_NOTE"
        ;;
      *) rm -rf "$partial"; fail "could not read $partial/package.json (node exited $HAS_DEPENDENCIES)" ;;
    esac
    mv "$partial" "$folder"
  fi

  step_begin "Add the agent-org command"
  swap_current "$tag"
  detail "$(tilde "$CURRENT") names versions/$tag"
  CHANGED="agent-org $tag is in $(tilde "$TOOL"), but the agent-org command was not added."

  mkdir -p "$BIN_DIR"
  launcher="$BIN_DIR/agent-org"
  TEMPORARY="$(mktemp "$BIN_DIR/.agent-org.XXXXXX")"
  cat >"$TEMPORARY" <<EOF
#!/bin/sh
# The agent-org command, written by agent-org's install.sh. Running install.sh again rewrites it.
if [ -z "\${AGENT_ORG_HOME:-}" ]; then AGENT_ORG_HOME='$AGENT_ORG_HOME'; fi
export AGENT_ORG_HOME
if [ -z "\${AGENT_ORG_HOST:-}" ] && [ -f "\$AGENT_ORG_HOME/host.json" ]; then
  AGENT_ORG_HOST="\$AGENT_ORG_HOME/host.json"
  export AGENT_ORG_HOST
fi
exec node '$CURRENT/src/bin.ts' "\$@"
EOF
  chmod 755 "$TEMPORARY"
  mv -f "$TEMPORARY" "$launcher"
  TEMPORARY=""
  LAUNCHER="$launcher"
  INSTALLED_TAG="$tag"
  step_done "Added the agent-org command" "$(tilde "$launcher")"

  if [ -d "$LEGACY_CHECKOUT/.git" ]; then
    NOTES="$NOTES""An earlier install's checkout at $(tilde "$LEGACY_CHECKOUT") is left as it is. agent-org update moves its services onto this install."$'\n'
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      NOTES="$NOTES""$(tilde "$BIN_DIR") is not on your PATH. Add this line to your shell's rc file (~/.zshrc or ~/.bashrc), then open a new terminal:"$'\n'
      # shellcheck disable=SC2016 # $PATH is printed for the person to paste, not expanded here.
      NOTES="$NOTES$(printf '  export PATH="%s:$PATH"' "$BIN_DIR")"$'\n'
      ;;
  esac
}

main "$@"
