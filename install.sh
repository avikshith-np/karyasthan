#!/usr/bin/env bash
#
# Karyasthan one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/avikshith-np/karyasthan/main/install.sh | bash
#
# Forked it? Override with KARYASTHAN_REPO=<git-url> bash install.sh
#
set -euo pipefail

REPO_URL="${KARYASTHAN_REPO:-https://github.com/avikshith-np/karyasthan.git}"
TARGET_DIR="${KARYASTHAN_DIR:-karyasthan}"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

bold "Karyasthan installer"
echo

# --- OS-aware hint for a missing package -----------------------------------
pkg_hint() {
  if   command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $1"
  elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf install -y $1"
  elif command -v brew    >/dev/null 2>&1; then echo "brew install $1"
  else echo "install: $1"; fi
}

# --- Prerequisites ---------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git not found. Install it: $(pkg_hint git)"
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 20: https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm not found (comes with Node.js)."

NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 required (found $(node -v)). Upgrade: https://nodejs.org"
ok "node $(node -v)"

# better-sqlite3 builds a native addon — needs a C/C++ toolchain + python3 + make.
MISSING_BUILD=""
command -v cc  >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || MISSING_BUILD="a C/C++ compiler"
command -v make    >/dev/null 2>&1 || MISSING_BUILD="${MISSING_BUILD:+$MISSING_BUILD, }make"
command -v python3 >/dev/null 2>&1 || MISSING_BUILD="${MISSING_BUILD:+$MISSING_BUILD, }python3"
if [ -n "$MISSING_BUILD" ]; then
  warn "Missing build tools for the native SQLite addon: $MISSING_BUILD"
  if command -v apt-get >/dev/null 2>&1; then info "Install: sudo apt-get install -y build-essential python3"
  elif command -v dnf  >/dev/null 2>&1; then info "Install: sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3"
  elif command -v brew >/dev/null 2>&1; then info "Install: xcode-select --install"
  fi
  die "Install the build tools above, then re-run this installer."
fi
ok "build toolchain present"
echo

# --- Get the code ----------------------------------------------------------
# If we're already inside the repo (piped from within a checkout), use it.
CLONED=0
if [ -f package.json ] && grep -q '"name": *"karyasthan"' package.json 2>/dev/null; then
  ok "running inside an existing karyasthan checkout — skipping clone"
else
  if [ -e "$TARGET_DIR" ]; then
    die "./$TARGET_DIR already exists. Remove it or set KARYASTHAN_DIR=<dir> and re-run."
  fi
  case "$REPO_URL" in
    *"<your-github-username>"*)
      die "REPO_URL still has the placeholder. Edit install.sh or run: KARYASTHAN_REPO=<git-url> bash install.sh" ;;
  esac
  info "Cloning $REPO_URL ..."
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
  cd "$TARGET_DIR"
  CLONED=1
  ok "cloned into ./$TARGET_DIR"
fi
echo

# --- Install deps (builds better-sqlite3) ----------------------------------
info "Installing dependencies (this compiles the native SQLite addon)…"
npm install
ok "dependencies installed"
echo

# --- Interactive setup -----------------------------------------------------
# Under `curl | bash`, this script IS stdin — so the wizard must read the
# user's answers from the controlling terminal (/dev/tty), not our stdin.
bold "Launching setup wizard…"
if { true < /dev/tty; } 2>/dev/null; then
  npm run setup < /dev/tty
elif [ "${KARYASTHAN_NONINTERACTIVE:-}" = "1" ]; then
  npm run setup
else
  warn "No interactive terminal detected — skipping guided setup."
  if [ "$CLONED" = "1" ]; then
    info "Finish setup in a terminal:  cd \"$TARGET_DIR\" && npm run setup"
  else
    info "Finish setup in a terminal:  npm run setup"
  fi
fi

echo
bold "Done."
if [ "$CLONED" = "1" ]; then
  info "Start the bot with:  cd \"$TARGET_DIR\" && npm start"
  info "Re-run setup later:  cd \"$TARGET_DIR\" && npm run setup"
else
  info "Start the bot with:  npm start"
  info "Re-run setup later:  npm run setup"
fi
