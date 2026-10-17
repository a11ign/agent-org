#!/usr/bin/env bash
# Install agent-org, or update an install in place:
#
#   curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/a11ign/agent-org/main/install.sh | bash -s -- --version v0.3.0
#
# It clones the newest release tag (or --version) into $AGENT_ORG_HOME/agent-org (default ~/.agent-org/agent-org), installs the
# release's dependencies, and writes an `agent-org` launcher into ~/.local/bin. It changes nothing else: no sudo, no system
# package, no shell rc file. Running it again fetches the tags and moves the same checkout.
set -euo pipefail

MIN_NODE_MAJOR=24
REPO_URL="${AGENT_ORG_REPO:-https://github.com/a11ign/agent-org.git}"
AGENT_ORG_HOME="${AGENT_ORG_HOME:-$HOME/.agent-org}"
BIN_DIR="${AGENT_ORG_BIN_DIR:-$HOME/.local/bin}"
CHECKOUT="$AGENT_ORG_HOME/agent-org"
RELEASE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

say() { printf 'agent-org install: %s\n' "$*"; }
fail() { printf 'agent-org install: %s\n' "$*" >&2; exit 1; }

# Put the checkout back where it was before this run, when it was anywhere.
restore() {
  if [ -n "$1" ]; then
    git -C "$CHECKOUT" -c advice.detachedHead=false checkout --quiet --detach "$1" || true
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version vX.Y.Z]

Installs the newest agent-org release, or the one --version names, into $AGENT_ORG_HOME/agent-org
(default ~/.agent-org/agent-org), and the `agent-org` launcher into ~/.local/bin.
EOF
}

# Everything runs from main, called on the last line, so a download cut short by the network runs nothing.
main() {
  local version="" tag node_version node_major launcher temporary pnpm_cmd previous has_dependencies
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) [ "$#" -ge 2 ] || fail "--version needs a tag, such as v0.3.0"; version="$2"; shift 2 ;;
      --version=*) version="${1#--version=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown argument: $1 (see --help)" ;;
    esac
  done
  if [ -n "$version" ] && ! printf '%s\n' "$version" | grep -Eq "$RELEASE_TAG"; then
    fail "--version $version is not a release tag such as v0.3.0"
  fi

  # The launcher holds these paths in single quotes, and the PATH line it prints holds BIN_DIR in double quotes.
  case "$AGENT_ORG_HOME$BIN_DIR" in
    *"'"*|*'"'*|*'$'*|*'`'*|*\\*|*$'\n'*) fail "AGENT_ORG_HOME and AGENT_ORG_BIN_DIR must not hold a quote, \$, a backquote, a backslash or a line break" ;;
  esac
  case "$AGENT_ORG_HOME" in /*) ;; *) fail "AGENT_ORG_HOME must be an absolute path, and it is $AGENT_ORG_HOME" ;; esac
  case "$BIN_DIR" in /*) ;; *) fail "AGENT_ORG_BIN_DIR must be an absolute path, and it is $BIN_DIR" ;; esac

  command -v git >/dev/null 2>&1 || fail "git is not installed. Install it (on macOS: xcode-select --install), then run this again."

  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js $MIN_NODE_MAJOR or newer is needed, and there is no \`node\` on PATH. Install it from https://nodejs.org, or with a version manager (fnm install $MIN_NODE_MAJOR, or nvm install $MIN_NODE_MAJOR), then run this again."
  fi
  node_version="$(node --version 2>/dev/null || true)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  case "$node_major" in ''|*[!0-9]*) fail "could not read the Node.js version (\`node --version\` printed \"$node_version\")" ;; esac
  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js $MIN_NODE_MAJOR or newer is needed, and \`node\` is $node_version. Install a newer one from https://nodejs.org, or with a version manager (fnm install $MIN_NODE_MAJOR, or nvm install $MIN_NODE_MAJOR), then run this again."
  fi

  if [ ! -d "$AGENT_ORG_HOME" ]; then
    (umask 077 && mkdir -p "$AGENT_ORG_HOME")
  fi
  if [ -d "$CHECKOUT/.git" ]; then
    if [ -n "$(git -C "$CHECKOUT" status --porcelain --untracked-files=no)" ]; then
      fail "$CHECKOUT has changes to tracked files, so it was not moved. Discard them (git -C $CHECKOUT checkout -- .), then run this again."
    fi
    say "updating $CHECKOUT"
    git -C "$CHECKOUT" fetch --quiet --force --tags origin
  elif [ -e "$CHECKOUT" ]; then
    fail "$CHECKOUT exists and is not a git checkout. Move it away, then run this again."
  else
    say "cloning $REPO_URL into $CHECKOUT"
    git clone --quiet --no-checkout -- "$REPO_URL" "$CHECKOUT"
  fi

  if [ -n "$version" ]; then
    git -C "$CHECKOUT" rev-parse --quiet --verify "refs/tags/$version" >/dev/null || fail "there is no release $version"
    tag="$version"
  else
    # Numeric order, field by field: v0.10.0 is newer than v0.9.0, which a plain text sort gets backwards.
    tag="$(git -C "$CHECKOUT" tag --list 'v*' | grep -E "$RELEASE_TAG" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"
    [ -n "$tag" ] || fail "$REPO_URL has no release tag yet"
    tag="v$tag"
  fi
  # A checkout that was at a release before this run goes back to it when the dependency install fails, so the launcher keeps running that release.
  previous="$(git -C "$CHECKOUT" rev-parse --quiet --verify HEAD 2>/dev/null || true)"
  git -C "$CHECKOUT" -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$tag"

  # The release's runtime dependencies, when its package.json declares any. pnpm is the tool's package manager; Node 24 ships corepack, which runs it.
  has_dependencies=0
  (cd "$CHECKOUT" && node -e 'process.exit(Object.keys(require("./package.json").dependencies ?? {}).length > 0 ? 10 : 0)') || has_dependencies=$?
  case "$has_dependencies" in
    0) ;;
    10)
      say "installing the release's dependencies"
      if command -v pnpm >/dev/null 2>&1; then
        pnpm_cmd=(pnpm)
      elif command -v corepack >/dev/null 2>&1; then
        pnpm_cmd=(corepack pnpm)
      else
        restore "$previous"
        fail "the release needs its dependencies installed, and neither pnpm nor corepack is on PATH. Install pnpm (https://pnpm.io/installation), then run this again."
      fi
      if ! (cd "$CHECKOUT" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${pnpm_cmd[@]}" install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace --silent); then
        restore "$previous"
        fail "installing the dependencies failed. Fix what pnpm printed above, then run this again."
      fi
      ;;
    *) restore "$previous"; fail "could not read $CHECKOUT/package.json (node exited $has_dependencies)" ;;
  esac
  say "agent-org $tag is at $CHECKOUT"

  mkdir -p "$BIN_DIR"
  launcher="$BIN_DIR/agent-org"
  temporary="$(mktemp "$BIN_DIR/.agent-org.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  cat >"$temporary" <<EOF
#!/bin/sh
# The agent-org command, written by agent-org's install.sh. Running install.sh again rewrites it.
if [ -z "\${AGENT_ORG_HOME:-}" ]; then AGENT_ORG_HOME='$AGENT_ORG_HOME'; fi
export AGENT_ORG_HOME
if [ -z "\${AGENT_ORG_HOST:-}" ] && [ -f "\$AGENT_ORG_HOME/host.json" ]; then
  AGENT_ORG_HOST="\$AGENT_ORG_HOME/host.json"
  export AGENT_ORG_HOST
fi
exec node '$CHECKOUT/src/bin.ts' "\$@"
EOF
  chmod 755 "$temporary"
  mv -f "$temporary" "$launcher"
  trap - EXIT
  say "wrote $launcher"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "$BIN_DIR is not on your PATH. Add this line to your shell's rc file (~/.zshrc or ~/.bashrc), then open a new terminal:"
      # shellcheck disable=SC2016 # $PATH is printed for the person to paste, not expanded here.
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
      ;;
  esac
  say "next: agent-org onboard, then agent-org doctor"
}

main "$@"
