#!/usr/bin/env bash
# RPG Web - Battle Studio: macOS / Linux install wizard.
#   curl -fsSL https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.sh | bash
# Options: --dir <folder>  --version <vX.Y.Z>  --update  --uninstall  --yes
set -euo pipefail

REPO="gkaragoz/rpg-web-strategy"
DIR="${HOME}/RPGWebStrategy"
VERSION=""
MODE="install"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --update) MODE="update"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) echo "Usage: install.sh [--dir folder] [--version vX.Y.Z] [--update] [--uninstall] [--yes]"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m>\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

# With curl | bash, stdin is a pipe: read the answers from the terminal.
ask() { # ask "Question" "default" -> answer
  local q="$1" def="$2" ans=""
  if [ "$YES" = 1 ]; then echo "$def"; return; fi
  if [ -r /dev/tty ]; then
    printf '  %s [%s]: ' "$q" "$def" > /dev/tty
    read -r ans < /dev/tty || ans=""
  fi
  echo "${ans:-$def}"
}
confirm() { # confirm "Question" -> 0 for yes
  local a
  a="$(ask "$1 (y/n)" "y")"
  case "$a" in y|Y|yes|e|E|evet) return 0 ;; *) return 1 ;; esac
}

bold ""
bold "  RPG Web - Battle Studio install wizard"
bold ""

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux) PLATFORM="Linux" ;;
  *) die "Unsupported system: $OS (use install.ps1 on Windows)" ;;
esac
info "System: $PLATFORM"

if [ "$MODE" = "uninstall" ]; then
  [ -d "$DIR" ] || die "Installation not found: $DIR"
  if confirm "Delete $DIR?"; then
    rm -rf "$DIR"
    rm -f "$HOME/Desktop/RPG Web.command" "$HOME/.local/share/applications/rpg-web.desktop" "$HOME/.local/bin/rpg-web"
    ok "Removed."
  else
    info "Cancelled."
  fi
  exit 0
fi

# --- Node.js ---
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${major:-0}" -ge 18 ]; then
    need_node=0
    ok "Node.js $(node -v) found"
  fi
fi
if [ "$need_node" = 1 ]; then
  warn "Node.js 18+ is required (for the local server)."
  if [ "$PLATFORM" = "macOS" ] && command -v brew >/dev/null 2>&1; then
    if confirm "Install Node.js with Homebrew?"; then brew install node; else die "Cannot continue without Node.js: https://nodejs.org"; fi
  elif command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    if confirm "Install Node.js with apt?"; then apt-get update -y && apt-get install -y nodejs npm; else die "Node.js is required."; fi
  else
    die "Please install Node.js 18+ (https://nodejs.org or nvm) and run the wizard again."
  fi
  command -v node >/dev/null 2>&1 || die "Node.js could not be installed."
fi
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v unzip >/dev/null 2>&1 || die "unzip is required."

# --- Install directory ---
if [ "$MODE" = "install" ]; then
  DIR="$(ask "Install folder" "$DIR")"
fi
info "Folder: $DIR"

# --- Version ---
if [ -z "$VERSION" ]; then
  info "Looking up the latest version..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
  [ -n "$VERSION" ] || die "Latest version not found (check your internet connection)."
fi
ok "Version: $VERSION"
if [ -f "$DIR/VERSION" ] && [ "$MODE" = "update" ] && [ "$(cat "$DIR/VERSION")" = "$VERSION" ]; then
  ok "Already up to date."
  exit 0
fi

# --- Download and extract ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ASSET="rpg-web-strategy-${VERSION}.zip"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
info "Downloading: $ASSET"
curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || die "Download failed: $URL"
rm -rf "$DIR/app"
mkdir -p "$DIR/app"
unzip -q -o "$TMP/$ASSET" -d "$DIR/app"
[ -f "$DIR/app/index.html" ] || die "Package does not have the expected contents."
if [ -f "$DIR/app/server.mjs" ]; then mv -f "$DIR/app/server.mjs" "$DIR/server.mjs"; fi
if [ -f "$DIR/app/lan.mjs" ]; then mv -f "$DIR/app/lan.mjs" "$DIR/lan.mjs"; fi
echo "$VERSION" > "$DIR/VERSION"
ok "Files extracted"

# --- Launcher ---
printf '#!/usr/bin/env bash\ncd "$(dirname "$0")"\nexec node server.mjs app --open\n' > "$DIR/play.sh"
chmod +x "$DIR/play.sh"
printf '#!/usr/bin/env bash\ncd "$(dirname "$0")"\nexec node server.mjs app --open --lan\n' > "$DIR/play-lan.sh"
chmod +x "$DIR/play-lan.sh"
rm -f "$DIR/oyna.sh" "$DIR/oyna-lan.sh"  # launchers from older versions
ok "Launcher: $DIR/play.sh (for the LAN lobby: $DIR/play-lan.sh)"

if [ "$PLATFORM" = "macOS" ]; then
  if [ -d "$HOME/Desktop" ]; then
    printf '#!/usr/bin/env bash\nexec "%s/play.sh"\n' "$DIR" > "$HOME/Desktop/RPG Web.command"
    chmod +x "$HOME/Desktop/RPG Web.command"
    ok "Desktop shortcut: RPG Web.command"
  fi
else
  mkdir -p "$HOME/.local/share/applications" "$HOME/.local/bin"
  printf '[Desktop Entry]\nType=Application\nName=RPG Web\nComment=Battle Studio\nExec=%s/play.sh\nTerminal=true\nCategories=Game;\n' "$DIR" > "$HOME/.local/share/applications/rpg-web.desktop"
  ln -sf "$DIR/play.sh" "$HOME/.local/bin/rpg-web"
  ok "Added application menu entry and 'rpg-web' command"
fi

bold ""
bold "  Installation complete!"
info "To start: $DIR/play.sh"
info "To update: bash install.sh --update    To uninstall: bash install.sh --uninstall"
if confirm "Start the game now?"; then
  exec "$DIR/play.sh"
fi
