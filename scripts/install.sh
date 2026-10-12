#!/usr/bin/env bash
# RPG Web - Savas Studyosu: macOS / Linux kurulum sihirbazi.
#   curl -fsSL https://github.com/gkaragoz/rpg-web-strategy/releases/latest/download/install.sh | bash
# Secenekler: --dir <klasor>  --version <vX.Y.Z>  --update  --uninstall  --yes
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
    -h|--help) echo "Kullanim: install.sh [--dir klasor] [--version vX.Y.Z] [--update] [--uninstall] [--yes]"; exit 0 ;;
    *) echo "Bilinmeyen secenek: $1"; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  \033[36m>\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

# curl | bash durumunda stdin boru olur: sorulari terminalden oku.
ask() { # ask "Soru" "varsayilan" -> cevap
  local q="$1" def="$2" ans=""
  if [ "$YES" = 1 ]; then echo "$def"; return; fi
  if [ -r /dev/tty ]; then
    printf '  %s [%s]: ' "$q" "$def" > /dev/tty
    read -r ans < /dev/tty || ans=""
  fi
  echo "${ans:-$def}"
}
confirm() { # confirm "Soru" -> 0 evet
  local a
  a="$(ask "$1 (e/h)" "e")"
  case "$a" in e|E|evet|y|Y|yes) return 0 ;; *) return 1 ;; esac
}

bold ""
bold "  RPG Web — Savaş Stüdyosu kurulum sihirbazı"
bold ""

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux) PLATFORM="Linux" ;;
  *) die "Desteklenmeyen sistem: $OS (Windows icin install.ps1 kullanin)" ;;
esac
info "Sistem: $PLATFORM"

if [ "$MODE" = "uninstall" ]; then
  [ -d "$DIR" ] || die "Kurulum bulunamadi: $DIR"
  if confirm "$DIR silinsin mi?"; then
    rm -rf "$DIR"
    rm -f "$HOME/Desktop/RPG Web.command" "$HOME/.local/share/applications/rpg-web.desktop" "$HOME/.local/bin/rpg-web"
    ok "Kaldirildi."
  else
    info "Iptal edildi."
  fi
  exit 0
fi

# --- Node.js ---
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${major:-0}" -ge 18 ]; then
    need_node=0
    ok "Node.js $(node -v) bulundu"
  fi
fi
if [ "$need_node" = 1 ]; then
  warn "Node.js 18+ gerekli (yerel sunucu icin)."
  if [ "$PLATFORM" = "macOS" ] && command -v brew >/dev/null 2>&1; then
    if confirm "Homebrew ile Node.js kurulsun mu?"; then brew install node; else die "Node.js olmadan devam edilemez: https://nodejs.org"; fi
  elif command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then
    if confirm "apt ile Node.js kurulsun mu?"; then apt-get update -y && apt-get install -y nodejs npm; else die "Node.js gerekli."; fi
  else
    die "Lutfen Node.js 18+ kurun (https://nodejs.org veya nvm) ve sihirbazi tekrar calistirin."
  fi
  command -v node >/dev/null 2>&1 || die "Node.js kurulamadi."
fi
command -v curl >/dev/null 2>&1 || die "curl gerekli."
command -v unzip >/dev/null 2>&1 || die "unzip gerekli."

# --- Kurulum dizini ---
if [ "$MODE" = "install" ]; then
  DIR="$(ask "Kurulum klasoru" "$DIR")"
fi
info "Klasor: $DIR"

# --- Surum ---
if [ -z "$VERSION" ]; then
  info "Son surum araniyor..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
  [ -n "$VERSION" ] || die "Son surum bulunamadi (internet baglantisini kontrol edin)."
fi
ok "Surum: $VERSION"
if [ -f "$DIR/VERSION" ] && [ "$MODE" = "update" ] && [ "$(cat "$DIR/VERSION")" = "$VERSION" ]; then
  ok "Zaten guncel."
  exit 0
fi

# --- Indir ve ac ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ASSET="rpg-web-strategy-${VERSION}.zip"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
info "Indiriliyor: $ASSET"
curl -fL --progress-bar -o "$TMP/$ASSET" "$URL" || die "Indirme basarisiz: $URL"
rm -rf "$DIR/app"
mkdir -p "$DIR/app"
unzip -q -o "$TMP/$ASSET" -d "$DIR/app"
[ -f "$DIR/app/index.html" ] || die "Paket beklenen icerikte degil."
if [ -f "$DIR/app/server.mjs" ]; then mv -f "$DIR/app/server.mjs" "$DIR/server.mjs"; fi
echo "$VERSION" > "$DIR/VERSION"
ok "Dosyalar acildi"

# --- Baslatici ---
printf '#!/usr/bin/env bash\ncd "$(dirname "$0")"\nexec node server.mjs app --open\n' > "$DIR/oyna.sh"
chmod +x "$DIR/oyna.sh"
ok "Baslatici: $DIR/oyna.sh"

if [ "$PLATFORM" = "macOS" ]; then
  if [ -d "$HOME/Desktop" ]; then
    printf '#!/usr/bin/env bash\nexec "%s/oyna.sh"\n' "$DIR" > "$HOME/Desktop/RPG Web.command"
    chmod +x "$HOME/Desktop/RPG Web.command"
    ok "Masaustu kisayolu: RPG Web.command"
  fi
else
  mkdir -p "$HOME/.local/share/applications" "$HOME/.local/bin"
  printf '[Desktop Entry]\nType=Application\nName=RPG Web\nComment=Savas Studyosu\nExec=%s/oyna.sh\nTerminal=true\nCategories=Game;\n' "$DIR" > "$HOME/.local/share/applications/rpg-web.desktop"
  ln -sf "$DIR/oyna.sh" "$HOME/.local/bin/rpg-web"
  ok "Uygulama menusu girdisi ve 'rpg-web' komutu eklendi"
fi

bold ""
bold "  Kurulum tamam!"
info "Baslatmak icin: $DIR/oyna.sh"
info "Guncellemek icin: bash install.sh --update    Kaldirmak icin: bash install.sh --uninstall"
if confirm "Oyun simdi baslatilsin mi?"; then
  exec "$DIR/oyna.sh"
fi
