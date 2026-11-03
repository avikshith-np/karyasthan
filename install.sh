#!/usr/bin/env bash
#
# Karyasthan one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/avikshith-np/karyasthan/main/install.sh | bash
#
# Safe to run again: it carries on from whatever a failed run left.
#
#   KARYASTHAN_DIR=<dir>     where to install (default ./karyasthan)
#   KARYASTHAN_REPO=<url>    install a fork
#   KARYASTHAN_REF=<branch>  install a branch or tag
#   KARYASTHAN_NONINTERACTIVE=1  no prompts; settings come from the environment
#   KARYASTHAN_ALLOW_ROOT=1  run as root without asking (containers)
#
# Exit codes: 0 done, 1 failed, 2 no terminal to finish setup on, 3 needs something from you.

# Everything is inside main(), called on the last line, so a download that was cut
# off fails to parse and runs nothing.
main() {
  set -uo pipefail

  local REPO_URL="${KARYASTHAN_REPO:-https://github.com/avikshith-np/karyasthan.git}"
  local TARGET_DIR="${KARYASTHAN_DIR:-karyasthan}"
  local REF="${KARYASTHAN_REF:-}"

  bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
  info()  { printf '  %s\n' "$1"; }
  ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
  warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
  fail()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

  pkg_hint() {
    if   command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y $1"
    elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf install -y $1"
    elif command -v brew    >/dev/null 2>&1; then echo "brew install $1"
    elif command -v apk     >/dev/null 2>&1; then echo "sudo apk add $1"
    else echo "install: $1"; fi
  }

  toolchain_hint() {
    if   command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y build-essential python3"
    elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3"
    elif command -v apk     >/dev/null 2>&1; then echo "sudo apk add build-base python3"
    elif command -v brew    >/dev/null 2>&1; then echo "xcode-select --install"
    else echo "install a C/C++ compiler, make and python3"; fi
  }

  has_tty() { { true < /dev/tty; } 2>/dev/null; }

  # curl | bash doesn't load the shell setup that version managers live in.
  load_node() {
    command -v node >/dev/null 2>&1 && return 0
    local nvm="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [ -s "$nvm" ]; then
      # shellcheck disable=SC1090
      . "$nvm" >/dev/null 2>&1 && nvm use --silent default >/dev/null 2>&1
    fi
    command -v node >/dev/null 2>&1 && { NODE_FROM="nvm"; return 0; }
    if command -v fnm >/dev/null 2>&1 || [ -x "$HOME/.local/share/fnm/fnm" ]; then
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env 2>/dev/null)" 2>/dev/null
    fi
    command -v node >/dev/null 2>&1 && { NODE_FROM="fnm"; return 0; }
    if [ -x "$HOME/.volta/bin/node" ]; then
      export PATH="$HOME/.volta/bin:$PATH"
      NODE_FROM="volta"
    fi
  }

  bold "Karyasthan installer"
  echo
  info "Checking this machine"

  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      fail "Windows isn't supported directly. Install WSL, then run this inside it: https://aka.ms/wsl"
      return 3 ;;
  esac

  if [ "$(id -u 2>/dev/null)" = "0" ] && [ "${KARYASTHAN_ALLOW_ROOT:-}" != "1" ]; then
    warn "You're running as root, so every file would belong to root. A normal user is safer."
    if [ "${KARYASTHAN_NONINTERACTIVE:-}" = "1" ] || ! has_tty; then
      info "In a container, set KARYASTHAN_ALLOW_ROOT=1 to go ahead."
      return 3
    fi
    printf '  Carry on as root? (y/N) '
    local answer=""
    read -r answer < /dev/tty || answer=""
    case "$answer" in y|Y|yes) ;; *) return 3 ;; esac
  fi

  # Everything missing is listed at once.
  local NODE_FROM=""
  load_node
  local missing=0
  command -v git >/dev/null 2>&1 || { fail "git is missing: $(pkg_hint git)"; missing=1; }
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is missing. Install Node 22: https://nodejs.org"
    missing=1
  else
    local major
    major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
    if [ "$major" -lt 20 ]; then
      fail "Node $(node -v) is too old. Install Node 22: nvm install 22, or https://nodejs.org"
      missing=1
    else
      ok "Node $(node -v)${NODE_FROM:+ (from $NODE_FROM, loaded for this run)}"
      if [ "$major" = "21" ] || [ "$major" -ge 26 ]; then
        warn "SQLite has no ready-made build for Node $major, so it has to compile. Node 22 avoids that."
      fi
    fi
  fi
  command -v npm >/dev/null 2>&1 || { fail "npm is missing (it comes with Node.js)."; missing=1; }

  local free_kb mem_kb
  free_kb="$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -n "$free_kb" ] && [ "$free_kb" -lt 1048576 ]; then
    fail "Under 1 GB of disk free here. Free some space, or set KARYASTHAN_DIR to another disk."
    missing=1
  fi
  [ "$missing" = "0" ] || return 3
  ok "git and npm"
  if [ -r /proc/meminfo ]; then
    mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
    if [ -n "$mem_kb" ] && [ "$mem_kb" -lt 1048576 ]; then
      warn "Under 1 GB of memory. If the install gets killed, add a swap file and run this again."
    fi
  fi
  echo

  # ── The code ────────────────────────────────────────────────────────────────
  is_ours() { [ -f "$1/package.json" ] && grep -q '"name": *"karyasthan"' "$1/package.json" 2>/dev/null; }

  info "Getting the code"
  local CD_HINT=""
  if is_ours "."; then
    ok "Already inside a checkout"
  elif is_ours "$TARGET_DIR"; then
    ok "Found your earlier attempt in ./$TARGET_DIR"
    cd "$TARGET_DIR" || return 1
    CD_HINT="cd \"$TARGET_DIR\" && "
  elif [ -e "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    fail "./$TARGET_DIR exists and isn't this project. Nothing was changed."
    info "Pick another folder: KARYASTHAN_DIR=<dir> bash install.sh"
    return 3
  else
    local partial="$TARGET_DIR.partial.$$"
    if ! git clone --quiet --depth 1 ${REF:+--branch "$REF"} "$REPO_URL" "$partial"; then
      rm -rf "$partial"
      fail "Couldn't download $REPO_URL. Check the connection, then run this again."
      return 1
    fi
    [ -d "$TARGET_DIR" ] && rmdir "$TARGET_DIR"
    mv "$partial" "$TARGET_DIR" || return 1
    cd "$TARGET_DIR" || return 1
    CD_HINT="cd \"$TARGET_DIR\" && "
    ok "Cloned into ./$TARGET_DIR"
  fi
  echo

  # ── Packages ────────────────────────────────────────────────────────────────
  # An install that's already working is left alone: npm ci empties node_modules,
  # which would pull it out from under a running bot.
  if node -e "require('better-sqlite3')(':memory:').close()" >/dev/null 2>&1 && [ -d node_modules/@whiskeysockets/baileys ]; then
    ok "Packages already installed"
  else
    mkdir -p logs
    local LOG="logs/install.log"
    info "Installing packages (about a minute; log: $LOG)"
    if ! npm ci --no-audit --no-fund > "$LOG" 2>&1; then
      local code=$?
      if [ "$code" = "137" ] || grep -qE 'Killed|ENOMEM|out of memory' "$LOG"; then
        fail "Ran out of memory. Add a swap file, then run this again."
      elif grep -qE 'ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network' "$LOG"; then
        fail "Couldn't reach the npm registry. Check the connection or proxy, then run this again."
      elif grep -qE 'EACCES|EPERM' "$LOG"; then
        fail "No permission to write here. Don't use sudo; fix the folder's owner, then run this again."
      elif grep -qE 'node-gyp|gyp ERR|prebuild-install|not found: (make|python)|No such file.*(cc|g\+\+)' "$LOG"; then
        fail "SQLite's download failed and it couldn't be compiled here."
        info "Fix it with: $(toolchain_hint)"
        info "Then run this again. It carries on from here."
      else
        fail "npm failed. The last lines of $LOG:"
        tail -n 12 "$LOG" | sed 's/^/    /' >&2
      fi
      return 1
    fi
    ok "Packages installed, SQLite loads"
  fi
  echo

  # ── Setup ───────────────────────────────────────────────────────────────────
  # Under `curl | bash` this script IS stdin, so the wizard must read the terminal.
  if [ "${KARYASTHAN_NONINTERACTIVE:-}" = "1" ]; then
    npm run --silent setup < /dev/null || return $?
  elif has_tty; then
    npm run --silent setup < /dev/tty || return $?
  else
    warn "No terminal here, so setup wasn't run."
    info "Finish in a terminal: ${CD_HINT}npm run setup"
    return 2
  fi
  return 0
}

main "$@"
