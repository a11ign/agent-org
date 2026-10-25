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
# A release that ships a UI build (its package.json says `agentOrg.shipsUiBuild`, A11-191) is given it too: CI builds the board UI into each release and attaches
# `agent-org-ui-<tag>.tar.gz` and its `.sha256` to the GitHub Release, and this downloads both, checks the one against the other, and unpacks the build into
# the version folder as `ui-build/` before `current` moves. A release without the marker installs as it always did, with no download. The releases are fetched
# from https://github.com/<owner>/<repo>/releases/download (the repository AGENT_ORG_REPO names), or from AGENT_ORG_RELEASES_URL when that is set.
#
# It ends by checking that the `agent-org` the person's shell runs is the one it just installed (A11-285): an alias, a function or a file on PATH that runs another copy is shown with its
# file and line and, after asking on the terminal (or without asking, when there is none), replaced by the installed command, keeping a backup of the file. It does not report success while
# the person's `agent-org` would run another copy.
#
# It checks what it needs (git, tar, gzip, curl, Node, a way to run pnpm) before it writes anything, lists every problem at once with the command that fixes it, and prints
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
# The herdr that `agent-org onboard` installs when the machine has none (A11-223): the version the agents host runs, the same on every machine of this release. `src/install/herdr-install.ts`
# holds the same value, and a test holds the two to one. herdr is not needed to install agent-org, so install.sh only says onboard installs it.
HERDR_VERSION=0.9.3
REPO_URL="${AGENT_ORG_REPO:-https://github.com/a11ign/agent-org.git}"
# Where a release's assets are downloaded from, when it is not the repository's GitHub releases (a test, a mirror).
RELEASES_OVERRIDE="${AGENT_ORG_RELEASES_URL:-}"
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
FAILED_HEADLINE="agent-org was not installed."  # the failure's headline on a terminal; the command check changes it, since by then agent-org is installed
LAUNCHER=""
RUNNER_VIA=""    # how the pinned pnpm runs: "corepack beside node", "corepack on PATH" or "npm exec"
RUNNER_NOTE=""   # the dependency line's note: empty for the usual corepack beside node
HERDR_MISSING=0  # herdr is not on PATH: said in the notes, and installed by onboard

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
  local rest
  if [ -n "${HOME:-}" ]; then
    case "$1" in
      "$HOME") printf '~'; return ;;
      "$HOME"/*) rest=${1#"$HOME"/}; printf '~/%s' "$rest"; return ;;
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
  if [ "$TTY" -eq 1 ]; then printf '%s\n\n' "${BOLD}${RED}${FAILED_HEADLINE}${RESET}"; fi
  printf '%s\n  %s\n' "$PROBLEM_LINES" "$CHANGED"
  if [ "$TTY" -eq 0 ]; then printf '\nagent-org install FAILED: %s %s\n' "$reason" "$CHANGED"; fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version vX.Y.Z] [--verbose]

Installs the newest agent-org release, or the one --version names, into its own folder under $AGENT_ORG_HOME/tool/versions
(default ~/.agent-org/tool/versions), points $AGENT_ORG_HOME/tool/current at it, and writes the `agent-org` launcher into ~/.local/bin.
It checks git, tar, gzip, curl, Node and a way to run pnpm first, and changes nothing when one is missing.
A release that ships a UI build also has it downloaded from its GitHub Release (or from $AGENT_ORG_RELEASES_URL), checked against its checksum, and unpacked into the version folder.
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

# git, tar, gzip or curl is missing: the command that installs it on this system. $1 is the program, $2 what is wrong.
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
  if has gzip; then detail "gzip found"; else tool_problem gzip "gzip is not installed, and a release's UI build is unpacked with it"; fi
  if has curl; then detail "curl found"; else tool_problem curl "curl is not installed, and a release's UI build is downloaded with it"; fi
  # herdr runs every worker's terminal. Onboard installs it, so a machine without it is not a problem here, only a note.
  if has herdr; then detail "$(herdr --version 2>/dev/null || echo "herdr found")"; else HERDR_MISSING=1; fi
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
  if [ -n "${AGENT_ORG_COREPACK:-}" ] && [ ! -x "$AGENT_ORG_COREPACK" ]; then
    # Named on purpose, so a mistyped path is said and not quietly replaced by a download.
    problem "AGENT_ORG_COREPACK names $AGENT_ORG_COREPACK, which is not an executable file" "To fix it, run" "unset AGENT_ORG_COREPACK"
  elif find_runner; then
    detail "pnpm $PNPM_VERSION runs through $RUNNER_VIA"
  else
    runner_problem
  fi
}

# Whether the release in $1 declares dependencies. Sets the answer in HAS_DEPENDENCIES: 0 none, 10 some.
HAS_DEPENDENCIES=0
read_dependencies() {
  HAS_DEPENDENCIES=0
  (cd "$1" && node -e 'process.exit(Object.keys(require("./package.json").dependencies ?? {}).length > 0 ? 10 : 0)') || HAS_DEPENDENCIES=$?
}


# The release being installed, set by resolve_release.
VERSION=""       # what --version named, if anything
TAG=""
FOLDER=""
PARTIAL=""
EARLIER_CLAUSE="" # what is still true of the machine if the install stops: the earlier install, or that there is none

parse_arguments() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) [ "$#" -ge 2 ] || fail "--version needs a tag, such as v0.3.0"; VERSION="$2"; shift 2 ;;
      --version=*) VERSION="${1#--version=}"; shift ;;
      --verbose) VERBOSE=1; shift ;;
      -h|--help) trap - EXIT; usage; exit 0 ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
  done
  if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq "$RELEASE_TAG"; then
    fail "--version $VERSION is not a release tag such as v0.3.0"
  fi
}

check_paths() {
  # The launcher holds these paths in single quotes, and the PATH line it prints holds BIN_DIR in double quotes.
  case "$AGENT_ORG_HOME$BIN_DIR" in
    *"'"*|*'"'*|*'$'*|*'`'*|*\\*|*$'\n'*) fail "AGENT_ORG_HOME and AGENT_ORG_BIN_DIR must not hold a quote, \$, a backquote, a backslash or a line break" ;;
  esac
  case "$AGENT_ORG_HOME" in /*) ;; *) fail "AGENT_ORG_HOME must be an absolute path, and it is $AGENT_ORG_HOME" ;; esac
  case "$BIN_DIR" in /*) ;; *) fail "AGENT_ORG_BIN_DIR must be an absolute path, and it is $BIN_DIR" ;; esac
}

preflight_step() {
  step_begin "Check what agent-org needs"
  preflight
  if [ "$PROBLEM_COUNT" -gt 0 ]; then exit 1; fi
  step_done_quietly "Checked what agent-org needs"
}

# The bare mirror, cloned or brought up to date. This is the first thing written, so what a failure leaves behind is said from here on.
fetch_mirror() {
  local earlier=""
  if [ -L "$CURRENT" ]; then earlier="$(readlink "$CURRENT")"; earlier="${earlier#versions/}"; fi
  if [ -n "$earlier" ]; then EARLIER_CLAUSE="Your earlier install, $earlier, still works."; else EARLIER_CLAUSE="Nothing is installed yet."; fi
  if [ ! -d "$AGENT_ORG_HOME" ]; then
    (umask 077 && mkdir -p "$AGENT_ORG_HOME")
  fi
  mkdir -p "$TOOL" "$VERSIONS"
  CHANGED="$EARLIER_CLAUSE"
  if [ -f "$MIRROR/HEAD" ]; then
    git --git-dir "$MIRROR" fetch --quiet --force --tags origin
    detail "updated $(tilde "$MIRROR")"
  elif [ -e "$MIRROR" ]; then
    fail "$(tilde "$MIRROR") exists and is not a git repository" "To fix it, move it away, then run this again. Run" "mv \"$MIRROR\" \"$MIRROR.old\""
  else
    git clone --bare --quiet -- "$REPO_URL" "$MIRROR"
    detail "cloned $REPO_URL into $(tilde "$MIRROR")"
  fi
  CHANGED="Its download was kept in $(tilde "$TOOL"), so the next run is faster. $EARLIER_CLAUSE"
}

# Sets TAG, FOLDER and PARTIAL: --version's release, or the newest one.
resolve_release() {
  if [ -n "$VERSION" ]; then
    git --git-dir "$MIRROR" rev-parse --quiet --verify "refs/tags/$VERSION" >/dev/null || fail "there is no release $VERSION"
    TAG="$VERSION"
  else
    # Numeric order, field by field: v0.10.0 is newer than v0.9.0, which a plain text sort gets backwards.
    TAG="$(git --git-dir "$MIRROR" tag --list 'v*' | grep -E "$RELEASE_TAG" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
    [ -n "$TAG" ] || fail "$REPO_URL has no release tag yet"
    TAG="v$TAG"
  fi
  FOLDER="$VERSIONS/$TAG"
  PARTIAL="$FOLDER.partial"
}

# The release unpacked beside its final folder, so a failed or killed install leaves no folder that looks built.
unpack_release() {
  rm -rf "$PARTIAL" "$FOLDER"
  mkdir -p "$PARTIAL"
  if ! git --git-dir "$MIRROR" archive --format=tar "refs/tags/$TAG" | tar -xf - -C "$PARTIAL"; then
    rm -rf "$PARTIAL"
    fail "could not unpack $TAG from $(tilde "$MIRROR")"
  fi
  [ -f "$PARTIAL/src/bin.ts" ] || { rm -rf "$PARTIAL"; fail "$TAG holds no src/bin.ts, so it is not a release of agent-org"; }
  detail "built into $(tilde "$FOLDER")"
}

# The release's runtime dependencies, when its package.json declares any.
install_dependencies() {
  read_dependencies "$PARTIAL"
  case "$HAS_DEPENDENCIES" in
    0) ;;
    10)
      step_begin "Install its dependencies"
      if ! (cd "$PARTIAL" && run_pnpm install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace --silent); then
        rm -rf "$PARTIAL"
        fail "installing the dependencies failed, so current stays where it was. Fix what pnpm printed above, then run this again"
      fi
      step_done "Installed its dependencies" "$RUNNER_NOTE"
      ;;
    *) rm -rf "$PARTIAL"; fail "could not read $PARTIAL/package.json (node exited $HAS_DEPENDENCIES)" ;;
  esac
}

# Whether the release in $1 declares a UI build: `agentOrg.shipsUiBuild` in its package.json. Node exits 10 for yes.
declares_ui_build() {
  local status=0
  (cd "$1" && node -e 'process.exit(require("./package.json").agentOrg?.shipsUiBuild === true ? 10 : 0)') || status=$?
  [ "$status" -eq 10 ]
}

# Where releases are downloaded from: AGENT_ORG_RELEASES_URL, else the GitHub releases of the repository (https://github.com/<owner>/<repo>[.git], git@github.com:<owner>/<repo>.git
# or ssh://git@github.com/<owner>/<repo>.git). Returns 1 for any other repository. src/install/ui-asset.ts holds the same rule.
releases_url() {
  local rest
  if [ -n "$RELEASES_OVERRIDE" ]; then
    rest="$RELEASES_OVERRIDE"
    while [ "${rest%/}" != "$rest" ]; do rest="${rest%/}"; done
    printf '%s' "$rest"
    return 0
  fi
  case "$REPO_URL" in
    https://github.com/*) rest="${REPO_URL#https://github.com/}" ;;
    git@github.com:*) rest="${REPO_URL#git@github.com:}" ;;
    ssh://git@github.com/*) rest="${REPO_URL#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
  rest="${rest%/}"
  rest="${rest%.git}"
  case "$rest" in
    */*/*|*/|/*|"") return 1 ;;
    */*) ;;
    *) return 1 ;;
  esac
  printf 'https://github.com/%s/releases/download' "$rest"
}

# GET $1 into $2, following redirects (GitHub serves an asset from a CDN) and retrying what curl calls transient. Sets UI_STATUS to the HTTP status.
# Returns 1 with UI_CURL_ERROR set when there was no status at all.
UI_STATUS=""
UI_CURL_ERROR=""
get_asset() {
  UI_STATUS=""
  UI_CURL_ERROR=""
  if UI_STATUS="$(curl -sSL --retry 3 -o "$2" -w '%{http_code}' "$1" 2>"$2.error")"; then
    rm -f "$2.error"
  else
    UI_STATUS=""
    UI_CURL_ERROR="$(tail -n 1 "$2.error" 2>/dev/null || true)"
    return 1
  fi
}

# Whether the tarball $1 is the file the checksum file $2 names: its first word is the tarball's SHA-256. Prints the digest when it is. A file with no digest is a mismatch.
verify_checksum() {
  node -e '
    const fs = require("node:fs");
    const { createHash } = require("node:crypto");
    const [file, sidecar] = process.argv.slice(1);
    const want = (fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0] ?? "").toLowerCase();
    const got = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(want) || want !== got) process.exit(1);
    process.stdout.write(got);
  ' "$1" "$2"
}

# Why the UI build could not be had (UI_PROBLEM), and what to do about it (UI_ADVICE). Set by fetch_ui_build when it returns 1.
UI_PROBLEM=""
UI_ADVICE=""

# Records why, and removes what was made. It does not return 1 itself: it is called under `set -e`'s exemptions (fetch_ui_build runs as an `if` condition) and its callers return.
ui_failed() {
  UI_PROBLEM="$1"
  UI_ADVICE="${2:-Run this again in a few minutes}"
  rm -rf "$FOLDER.ui.partial" "$UI_INTO/ui-build.partial"
}

# Gives the folder $1 (the release being built, or a built one that has none) the UI build of $TAG: the checksum and the tarball are downloaded into $FOLDER.ui.partial, the tarball
# is checked against the checksum, unpacked into $1/ui-build.partial, and that is renamed to $1/ui-build, so the folder only ever gains a whole ui-build. Returns 1 with
# UI_PROBLEM set, having removed what it made, when it cannot.
UI_INTO=""
fetch_ui_build() {
  local releases staging="$FOLDER.ui.partial" asset="agent-org-ui-$TAG.tar.gz" file url digest
  UI_INTO="$1"
  rm -rf "$staging" "$1/ui-build.partial"
  if ! releases="$(releases_url)"; then
    ui_failed "the UI build of $TAG cannot be fetched: $REPO_URL is not a GitHub URL" "Set AGENT_ORG_RELEASES_URL to where its releases are downloaded from, then run this again"
    return 1
  fi
  if ! mkdir -p "$staging"; then ui_failed "the UI build of $TAG cannot be downloaded: $staging cannot be made"; return 1; fi
  for file in "$asset.sha256" "$asset"; do
    url="$releases/$TAG/$file"
    detail "downloading $url"
    if ! get_asset "$url" "$staging/$file"; then
      ui_failed "the UI build of $TAG could not be downloaded from $url (${UI_CURL_ERROR:-curl failed})"
      return 1
    fi
    case "$UI_STATUS" in
      200) ;;
      404) ui_failed "$TAG has not attached its UI build yet (CI attaches it a few minutes after the release)"; return 1 ;;
      *) ui_failed "the UI build of $TAG could not be downloaded from $url (HTTP $UI_STATUS)"; return 1 ;;
    esac
  done
  if ! digest="$(verify_checksum "$staging/$asset" "$staging/$asset.sha256")"; then
    ui_failed "the UI build of $TAG did not match its checksum"
    return 1
  fi
  detail "checksum $digest verified"
  if ! mkdir -p "$1/ui-build.partial"; then ui_failed "the UI build of $TAG cannot be unpacked: $1/ui-build.partial cannot be made"; return 1; fi
  if ! tar -xzf "$staging/$asset" -C "$1/ui-build.partial" || [ ! -f "$1/ui-build.partial/index.html" ]; then
    ui_failed "the UI build of $TAG could not be unpacked, or holds no index.html"
    return 1
  fi
  # fetch_ui_build runs as an `if` condition, where `set -e` does not apply: each step that must not fail says so, or a failed rename would read as a build that was installed.
  if ! rm -rf "$1/ui-build" || ! mv "$1/ui-build.partial" "$1/ui-build"; then ui_failed "the UI build of $TAG could not be moved into $1/ui-build"; return 1; fi
  rm -rf "$staging"
}

# The step that gives the folder $1 its UI build. $2 says what a build that cannot be had means: "fail" stops the install, with current where it was, and "warn" is for a folder that
# is current already, where stopping would change nothing, so it is said under the steps instead.
ui_build_step() {
  step_begin "Download its UI build"
  if fetch_ui_build "$1"; then
    step_done "Downloaded its UI build"
  elif [ "$2" = warn ]; then
    STEP_FAILED=""
    DETAILS=""
    NOTES="$NOTES""agent-org $TAG is current, but its UI build could not be fetched: $UI_PROBLEM. / shows the missing-build page until agent-org update fetches it."$'\n'
  else
    if [ "$1" = "$PARTIAL" ]; then rm -rf "$PARTIAL"; fi
    fail "$UI_PROBLEM, so current stays where it was. $UI_ADVICE"
  fi
}

# Whether $CURRENT already names this release.
is_current() { [ "$(readlink "$CURRENT" 2>/dev/null || true)" = "versions/$TAG" ]; }

# The release, built whole in its own folder (or found there already), with its dependencies and, when it ships one, its UI build.
download_step() {
  step_begin "Download agent-org"
  fetch_mirror
  resolve_release
  if [ -f "$FOLDER/src/bin.ts" ]; then
    detail "$TAG was built already, in $(tilde "$FOLDER")"
    step_done "Downloaded agent-org $TAG"
    read_dependencies "$FOLDER"
    if [ "$HAS_DEPENDENCIES" -eq 10 ]; then step_done "Installed its dependencies"; fi
    if [ ! -f "$FOLDER/ui-build/index.html" ] && declares_ui_build "$FOLDER"; then
      if is_current; then ui_build_step "$FOLDER" warn; else ui_build_step "$FOLDER" fail; fi
    fi
  else
    unpack_release
    step_done "Downloaded agent-org $TAG"
    install_dependencies
    if declares_ui_build "$PARTIAL"; then ui_build_step "$PARTIAL" fail; fi
    mv "$PARTIAL" "$FOLDER"
  fi
}

# The launcher, written beside its place and moved into it, so a person never finds half of it.
write_launcher() {
  mkdir -p "$BIN_DIR"
  LAUNCHER="$BIN_DIR/agent-org"
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
  mv -f "$TEMPORARY" "$LAUNCHER"
  TEMPORARY=""
}

add_command_step() {
  step_begin "Add the agent-org command"
  swap_current "$TAG"
  detail "$(tilde "$CURRENT") names versions/$TAG"
  CHANGED="agent-org $TAG is in $(tilde "$TOOL"), but the agent-org command was not added."
  write_launcher
  INSTALLED_TAG="$TAG"
  step_done "Added the agent-org command" "$(tilde "$LAUNCHER")"
}

# The agent-org the person's shell runs must be the one just installed (A11-285). The release's own `command:check --fix --ask` reads what the login shell runs for `agent-org`, and when that is an
# alias, a function or a file that runs another copy, shows its file and line, asks on the terminal (with none, it replaces without asking) and replaces it with the installed command, keeping a
# backup of the file. A check that is still not ok ends the script as a failure: the install does not report success while the person's `agent-org` would run another copy. A release that
# has no such command (an older --version) is not checked.
check_command_step() {
  step_begin "Check the agent-org command"
  if [ ! -f "$CURRENT/src/install/shell-command-cli.ts" ]; then
    detail "$TAG has no command check, so the agent-org your shell runs is not compared with it"
    step_done_quietly "Skipped the agent-org command check ($TAG has none)"
    return 0
  fi
  local output="" status=0 line="" problem_line="" fix_line="" refused_line=""
  output="$(AGENT_ORG_HOME="$AGENT_ORG_HOME" AGENT_ORG_BIN_DIR="$BIN_DIR" node "$CURRENT/src/bin.ts" command:check --fix --ask)" || status=$?
  while IFS= read -r line; do
    detail "${line#  }"
    case "$line" in
      "  fixed: "*) NOTES="$NOTES""agent-org: ${line#  fixed: }"$'\n' ;;
      "  no terminal to ask on"*) NOTES="$NOTES""agent-org: ${line#  }"$'\n' ;;
      "✗ "*) problem_line="${line#✗ }" ;;
      "    fix: "*) fix_line="${line#    fix: }" ;;
      "  refused: "*) refused_line="${line#  refused: }" ;;
    esac
  done <<<"$output"
  if [ "$status" -ne 0 ]; then
    CHANGED="agent-org $TAG is installed in $(tilde "$TOOL") and its command is in $(tilde "$LAUNCHER"), but the agent-org your shell runs is another copy."
    FAILED_HEADLINE="agent-org $TAG is installed, but your shell runs another agent-org."
    if [ -z "$problem_line" ]; then
      fail "The check of the agent-org your shell runs could not run (it exited $status)" "To see why, run" "node '$CURRENT/src/bin.ts' command:check"
    fi
    if [ -n "$refused_line" ]; then problem_line="${problem_line%.}. It was not replaced: $refused_line"; fi
    fail "${problem_line%.}" "To fix it, do this" "${fix_line:-run node '$CURRENT/src/bin.ts' command:check --fix}"
  fi
  step_done "Checked the agent-org command"
}

# What a person should read between the steps and the outcome.
collect_notes() {
  if [ -d "$LEGACY_CHECKOUT/.git" ]; then
    NOTES="$NOTES""An earlier install's checkout at $(tilde "$LEGACY_CHECKOUT") is left as it is. agent-org update moves its services onto this install."$'\n'
  fi
  if [ "$HERDR_MISSING" -eq 1 ]; then
    NOTES="$NOTES""herdr is not installed. agent-org onboard installs herdr $HERDR_VERSION, which runs every worker's terminal."$'\n'
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

# Everything runs from main, called on the last line, so a download cut short by the network runs nothing.
main() {
  trap on_exit EXIT
  parse_arguments "$@"
  show_header
  check_paths
  preflight_step
  download_step
  add_command_step
  check_command_step
  collect_notes
}

main "$@"
