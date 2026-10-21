#!/usr/bin/env bash
# Agorax — one-liner installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jingr1/agorax/main/install.sh | bash
#
# What it does:
#   1. Verifies Node 22+, git, curl, pnpm, tmux (Swarm worker sessions)
#   2. Installs hermes-agent via Nous's official upstream installer
#   3. Clones Agorax
#   4. Sets up .env, enables the Hermes API server, generates matching
#      API_SERVER_KEY / HERMES_API_TOKEN if missing, installs deps,
#      and links bundled skills
#
# Re-runnable. Will skip anything already installed.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jingr1/agorax.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/agorax}"
GATEWAY_PORT="${GATEWAY_PORT:-8642}"
NOUS_INSTALLER_URL="${NOUS_INSTALLER_URL:-https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh}"

# ─── helpers ──────────────────────────────────────────────────────────────

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

need() { command -v "$1" &>/dev/null || { red "Missing: $1"; red "$2"; exit 1; }; }

banner() {
  cat <<'EOF'

   ╭──────────────────────────────────────────╮
   │  Agorax —  installer                     │
   ╰──────────────────────────────────────────╯

EOF
}

# ensure_path: prepend a dir to PATH for this shell if it's not already there
ensure_path() {
  local candidate="$1"
  [[ -d "$candidate" ]] || return 0
  case ":$PATH:" in
    *":$candidate:"*) ;;
    *) export PATH="$candidate:$PATH" ;;
  esac
}

pnpm_cmd() {
  if command -v pnpm &>/dev/null; then
    pnpm "$@"
    return
  fi
  if command -v corepack &>/dev/null && corepack pnpm --version &>/dev/null; then
    corepack pnpm "$@"
    return
  fi
  red "pnpm is not available in this shell."
  red "Try opening a new shell, or install pnpm manually: https://pnpm.io/installation"
  exit 1
}

ensure_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp

  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"

  if [[ -f "$file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { found = 0 }
      index($0, key "=") == 1 {
        print key "=" value
        found = 1
        next
      }
      { print }
      END {
        if (!found) {
          if (NR > 0) print ""
          print key "=" value
        }
      }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi

  mv "$tmp" "$file"
}

# Read KEY=value from a dotenv file (first match). Empty if missing.
read_env_key() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  # strip optional surrounding quotes; do not print elsewhere
  awk -F= -v key="$key" '
    index($0, key "=") == 1 {
      v = substr($0, length(key) + 2)
      gsub(/\r$/, "", v)
      if (v ~ /^".*"$/) { v = substr(v, 2, length(v) - 2) }
      else if (v ~ /^'\''.*'\''$/) { v = substr(v, 2, length(v) - 2) }
      print v
      exit
    }
  ' "$file"
}

gen_api_key() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 24
    return
  fi
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# ─── preflight ────────────────────────────────────────────────────────────

banner
cyan "→ Checking prerequisites…"

need node "Install Node 22+: https://nodejs.org/"
node_major=$(node -v | sed -E 's/v([0-9]+).*/\1/')
if [[ "$node_major" -lt 22 ]]; then
  red "Node $node_major detected; need 22+."
  exit 1
fi
green "  Node $(node -v) ✓"

need git "Install git: https://git-scm.com/"
green "  git $(git --version | awk '{print $3}') ✓"

need curl "Install curl (usually: apt install curl / brew install curl)"
green "  curl ✓"

# Swarm workers run as persistent `hermes chat --tui` panes inside tmux.
# Installer stays sudo-free — tell the operator how to install the package.
need tmux "Install tmux (apt install tmux / brew install tmux / dnf install tmux). Required for Swarm dispatch."
green "  tmux $(tmux -V 2>/dev/null | awk '{print $2}') ✓"

# Do NOT run `corepack enable` here: with system Node it tries to symlink
# into /usr/bin and fails with EACCES for non-root. Installer must stay
# sudo-free. Prefer a real `pnpm` on PATH via a user-writable npm prefix;
# fall back to `corepack pnpm` (see pnpm_cmd).
# Pin matches package.json#packageManager (pnpm 12 + allowBuilds).
PNPM_PIN=12.11.2
if ! command -v pnpm &>/dev/null; then
  yellow "  pnpm not found — installing pnpm@${PNPM_PIN} (user-local, no sudo)…"
  if command -v corepack &>/dev/null; then
    corepack prepare "pnpm@${PNPM_PIN}" --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm &>/dev/null; then
    node_bindir="$(dirname "$(command -v node)")"
    if [[ -w "$node_bindir" ]]; then
      npm install -g "pnpm@${PNPM_PIN}"
    else
      mkdir -p "$HOME/.local/bin"
      npm install -g --prefix "$HOME/.local" "pnpm@${PNPM_PIN}"
      ensure_path "$HOME/.local/bin"
    fi
  fi
  if ! command -v pnpm &>/dev/null && ! (command -v corepack &>/dev/null && corepack pnpm --version &>/dev/null); then
    red "Could not install pnpm without sudo."
    red "Install manually: npm install -g pnpm@${PNPM_PIN}"
    exit 1
  fi
fi
_pnpm_ver="$(pnpm_cmd --version 2>/dev/null || echo unknown)"
_pnpm_maj="${_pnpm_ver%%.*}"
if [[ "$_pnpm_maj" != "12" ]]; then
  yellow "  pnpm ${_pnpm_ver} on PATH — Agorax expects 12.x (${PNPM_PIN})."
  yellow "  Upgrade manually: npm install -g pnpm@${PNPM_PIN} && hash -r"
fi
green "  pnpm ${_pnpm_ver} ✓"

# ─── install hermes-agent (delegate to Nous upstream installer) ──────────
# hermes-agent is NOT on PyPI. It installs from source via Nous's own
# script, which handles PEP 668, uv, Python toolchain, Termux, etc. We
# only need to ensure `hermes` ends up on PATH before continuing.

cyan "→ Installing hermes-agent (via Nous upstream installer)…"
# Pick up hermes if it was installed in a prior run but not on PATH yet
ensure_path "$HOME/.hermes/bin"
ensure_path "$HOME/.local/bin"

if command -v hermes &>/dev/null; then
  green "  hermes-agent already installed ✓ ($(command -v hermes))"
else
  yellow "  Delegating to: $NOUS_INSTALLER_URL"
  if ! curl -fsSL "$NOUS_INSTALLER_URL" | bash; then
    red "  Nous installer failed. See its output above for details."
    red "  You can retry manually:"
    red "    curl -fsSL $NOUS_INSTALLER_URL | bash"
    exit 1
  fi
  # Nous typically installs `hermes` to ~/.hermes/bin or ~/.local/bin
  ensure_path "$HOME/.hermes/bin"
  ensure_path "$HOME/.local/bin"
  if ! command -v hermes &>/dev/null; then
    red "  hermes-agent installed, but 'hermes' is not on PATH in this shell."
    yellow "  Open a new shell (or: source ~/.bashrc / ~/.zshrc) and re-run:"
    yellow "    curl -fsSL https://raw.githubusercontent.com/jingr1/agorax/main/install.sh | bash"
    exit 1
  fi
  green "  hermes-agent installed ✓ ($(command -v hermes))"
fi

# ─── clone workspace ──────────────────────────────────────────────────────

cyan "→ Cloning Agorax…"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  yellow "  $INSTALL_DIR exists; pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  red "Path exists but is not a git repo: $INSTALL_DIR"
  red "Move/remove it or set INSTALL_DIR=..."
  exit 1
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
green "  Agorax ready at $INSTALL_DIR ✓"

# ─── env + install ────────────────────────────────────────────────────────

cyan "→ Configuring .env…"
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
ensure_env_key "$INSTALL_DIR/.env" "HERMES_API_URL" "http://127.0.0.1:${GATEWAY_PORT}"
green "  .env ready ✓"

cyan "→ Seeding agents.yaml from template…"
if [[ ! -f "$INSTALL_DIR/agents.yaml" ]]; then
  if [[ -f "$INSTALL_DIR/agents.yaml.example" ]]; then
    cp "$INSTALL_DIR/agents.yaml.example" "$INSTALL_DIR/agents.yaml"
    green "  agents.yaml created from agents.yaml.example ✓"
  else
    yellow "  agents.yaml.example missing — skip"
  fi
else
  green "  agents.yaml already present ✓"
fi

cyan "→ Enabling Hermes API server…"
HERMES_ENV_PATH="$(hermes config env-path 2>/dev/null || true)"
if [[ -z "$HERMES_ENV_PATH" ]]; then
  HERMES_ENV_PATH="$HOME/.hermes/.env"
fi
ensure_env_key "$HERMES_ENV_PATH" "API_SERVER_ENABLED" "true"

# Gateway HTTP API + Agorax must share the same secret. Without
# API_SERVER_KEY the pool/UI refuse to treat :8642 as connected
# ("No compatible backend detected").
API_KEY="$(read_env_key "$HERMES_ENV_PATH" "API_SERVER_KEY")"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$(gen_api_key)"
  ensure_env_key "$HERMES_ENV_PATH" "API_SERVER_KEY" "$API_KEY"
  green "  generated API_SERVER_KEY ✓"
else
  green "  API_SERVER_KEY already set ✓"
fi
ensure_env_key "$INSTALL_DIR/.env" "HERMES_API_TOKEN" "$API_KEY"
green "  HERMES_API_TOKEN synced to workspace .env ✓"
green "  Hermes env updated: $HERMES_ENV_PATH ✓"

# Guard against a common foot-gun: users editing ~/.hermes/.env by hand and
# writing env var names without underscores (APISERVERENABLED vs
# API_SERVER_ENABLED). The gateway reads exact names — typos are silently
# ignored, which produces a "gateway starts but API server never binds"
# failure that's hard to diagnose from the UI.
if [[ -f "$HERMES_ENV_PATH" ]]; then
  SUSPICIOUS=$(grep -E "^(API[A-Z]+|HERMES[A-Z]+)=" "$HERMES_ENV_PATH" 2>/dev/null \
    | grep -vE "^(API_|HERMES_)" || true)
  if [[ -n "$SUSPICIOUS" ]]; then
    yellow ""
    yellow "⚠  Found env var names missing underscores in $HERMES_ENV_PATH:"
    echo "$SUSPICIOUS" | sed 's/^/      /'
    yellow "   The gateway reads names with underscores (API_SERVER_ENABLED,"
    yellow "   not APISERVERENABLED). These lines will be silently ignored."
    yellow "   Fix them and run: hermes gateway run --replace"
    yellow ""
  fi
fi

cyan "→ Installing npm deps (pnpm install)…"
pnpm_cmd install --silent
green "  deps installed ✓"

# ─── seed Hermes skills (Conductor needs workspace-dispatch) ─────────────

cyan "→ Linking bundled skills into ~/.hermes/skills…"
HERMES_SKILLS_DIR="$HOME/.hermes/skills"
mkdir -p "$HERMES_SKILLS_DIR"
if [[ -d "$INSTALL_DIR/skills" ]]; then
  for skill_path in "$INSTALL_DIR/skills"/*/; do
    skill_name=$(basename "$skill_path")
    target="$HERMES_SKILLS_DIR/$skill_name"
    if [[ -e "$target" || -L "$target" ]]; then
      continue
    fi
    ln -sf "$skill_path" "$target" 2>/dev/null && \
      green "  linked $skill_name ✓" || true
  done
fi

# ─── Local agents.yaml from template ────────────────────────────────────

cyan "→ Seeding agents.yaml from agents.yaml.example…"
if [[ ! -f "$INSTALL_DIR/agents.yaml" ]]; then
  if [[ -f "$INSTALL_DIR/agents.yaml.example" ]]; then
    cp "$INSTALL_DIR/agents.yaml.example" "$INSTALL_DIR/agents.yaml"
    green "  agents.yaml created ✓"
  else
    yellow "  agents.yaml.example missing — skip"
  fi
else
  green "  agents.yaml already present ✓"
fi

# ─── Swarm seed Hermes profiles (ensureProfile: true) ───────────────────
# Clone-from default when missing, then sync SOUL/skills/wrappers.
# Agent chat also ensures per-id as a fallback if install was skipped.

cyan "→ Ensuring Swarm seed Hermes profiles…"
if [[ -f "$HOME/.hermes/config.yaml" ]]; then
  if node "$INSTALL_DIR/scripts/ensure-swarm-profiles.mjs"; then
    green "  Swarm seed profiles ready ✓"
  else
    yellow "  ensure-swarm-profiles failed — open an agent chat later to retry per profile"
  fi
else
  yellow "  ~/.hermes/config.yaml missing — skip profile ensure (configure Hermes default first)"
fi

# ─── macOS LaunchAgent (plist) ───────────────────────────────────────────
# Best-effort convenience for local macOS installs. This keeps the source of
# truth in-repo and makes sure launchd runs server-entry.js (the thin HTTP
# wrapper), not dist/server/server.js directly.

if [[ "$(uname -s)" == "Darwin" ]]; then
  cyan "→ Installing macOS LaunchAgent (com.hermes.workspace)…"

  PLIST_TEMPLATE="$INSTALL_DIR/macos/com.hermes.workspace.plist.template"
  PLIST_DEST="$HOME/Library/LaunchAgents/com.hermes.workspace.plist"
  mkdir -p "$HOME/Library/LaunchAgents"

  NODE_BIN="$(command -v node)"
  HERMES_PORT="${PORT:-6734}"
  HERMES_API_GATEWAY="http://127.0.0.1:${GATEWAY_PORT}"
  TOKEN=""

  TOKEN="$(read_env_key "$HERMES_ENV_PATH" "API_SERVER_KEY")"
  if [[ -z "$TOKEN" ]]; then
    TOKEN="$(read_env_key "$INSTALL_DIR/.env" "HERMES_API_TOKEN")"
  fi
  if [[ -z "$TOKEN" ]]; then
    TOKEN="$(read_env_key "$INSTALL_DIR/.env" "CLAUDE_API_TOKEN")"
  fi

  sed \
    -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
    -e "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" \
    -e "s|{{PORT}}|${HERMES_PORT}|g" \
    -e "s|{{HERMES_API_URL}}|${HERMES_API_GATEWAY}|g" \
    -e "s|{{HERMES_API_TOKEN}}|${TOKEN}|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"

  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  if launchctl load -w "$PLIST_DEST" 2>/dev/null; then
    green "  LaunchAgent loaded ✓ (com.hermes.workspace)"
  else
    yellow "  Could not load LaunchAgent now — it will still be available for next login."
  fi
  green "  Plist installed: $PLIST_DEST ✓"
fi

# ─── done ─────────────────────────────────────────────────────────────────

bold ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
green "  Install complete!"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat <<EOF

Next steps:

  Recommended (one command — gateway + managed-agent + UI):
       cd $INSTALL_DIR && pnpm dev

  Or split terminals:
       hermes gateway run                  # :8642 (optional on localhost — pool can lazy-start)
       cd $INSTALL_DIR && pnpm dev:ui         # :6734 UI

  Open http://localhost:6734

If the gateway was already running before this install,
restart it so API_SERVER_ENABLED / API_SERVER_KEY take effect:
       hermes gateway run --replace

EOF

cyan "Happy building. 🚀"
