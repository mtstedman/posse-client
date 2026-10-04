#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Posse + ATLAS Linux installer
#
# Bootstraps a host from scratch: system packages (build toolchain + helper
# CLIs), Node.js 24+ (via nvm when missing), the Posse checkout, npm deps,
# SCIP language environments (delegated to `posse doctor`, the
# same engine boot uses), authenticated native binaries, account settings, and
# shell wiring.
#
# Design rules:
#   - Never dies mid-run without a summary: every step is fenced, failures are
#     recorded and reported, and dependent steps are marked "blocked".
#   - Idempotent: re-running is safe; fresh steps are skipped. Pass --force to
#     reinstall npm deps, --dry-run to preview.
#   - All command output is captured to a log file; failures print the tail.
# -----------------------------------------------------------------------------

set -u -o pipefail
# NOTE: deliberately no `set -e` — the step engine owns error handling so a
# failing step degrades gracefully instead of killing the run mid-way.

if [[ -z "${HOME:-}" ]]; then
  printf '%s\n' '[install-posse-atlas] ERROR: HOME is not set; run from a normal user login shell.' >&2
  exit 2
fi
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  printf '%s\n' '[install-posse-atlas] ERROR: Bash 4.4 or newer is required.' >&2
  exit 2
fi
if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
  printf '%s\n' '[install-posse-atlas] ERROR: Do not run this installer with sudo; run it as your normal user and let it request sudo for system packages.' >&2
  exit 2
fi

INSTALLER_NAME="install-posse-atlas"

# --- defaults ----------------------------------------------------------------
POSSE_MODE="preferred"
POSSE_PHASES="research,planning,assessment,dev"
POSSE_LIVE_FUNNEL="true"
POSSE_SCIP_MODE="on"
POSSE_SCIP_LANGUAGES="typescript,python"
POSSE_SCIP_LANGUAGES_SUPPLIED="false"
SMOKE_QUERY="auth"
SMOKE_PROVIDER="openai"
RUN_SMOKE="true"
PERSIST_ENV="true"
SEED_SETTINGS="true"
INSTALL_HOST_TOOLS="true"
WITH_MEDIA_TOOLS="false"
INSTALL_NODE="true"
FORCE_REINSTALL="false"
DRY_RUN="false"
CONFIGURE_KEYS="false"
NON_INTERACTIVE="false"
SETUP_ONLY="false"
PLAIN="false"
INSTALL_ROOT="${HOME}/claude-tools"
POSSE_DIR=""
POSSE_REPO_URL="https://github.com/mtstedman/posse-client.git"
REPO_ID=""
REPO_PATH=""
NODE_MIN_MAJOR="24"
# Posse's native binaries and its SQLite driver (better-sqlite3 prebuilds) are
# built against glibc 2.34; an older userspace cannot load them at all.
GLIBC_MIN_MAJOR="2"
GLIBC_MIN_MINOR="34"
GLIBC_SUPPORTED_SYSTEMS="RHEL/Alma/Rocky 9+, Amazon Linux 2023, Ubuntu 22.04+, Debian 12+"
NVM_VERSION="v0.40.8"
# SHA-256 of nvm's install.sh at that tag. Tags can move; the hash cannot.
NVM_INSTALL_SHA256="48a0eee9a60e07422dce0eb5774754c83889570ca1ee2566c516acbe8af03a9e"
COMMAND_TIMEOUT_SECONDS="1800"
DOCTOR_TIMEOUT_SECONDS="7500"
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd -P)"
fi

usage() {
  cat <<'USAGE'
Usage:
  install-posse-atlas.sh [options]

Options:
  --install-root <path>   Base directory for installs (default: ~/claude-tools)
  --posse-dir <path>      Posse checkout/workspace directory (default: installer checkout, else <install-root>/posse-client)
  --posse-repo-url <url>  Fallback Git URL when no checkout is detected and --posse-dir is missing
  --repo-id <id>          ATLAS repo id for smoke tests
  --repo-path <path>      ATLAS repo path for smoke tests
  --smoke-query <query>   Query used for atlas-smoke (default: auth)
  --smoke-provider <name> Provider for atlas-smoke (default: openai)
  --scip-languages <csv>  Initial SCIP languages to install/index. Values:
                          typescript, python, php, go, rust, clang, or all.
                          If omitted in an interactive shell, a multi-select
                          prompt is shown. Default: typescript,python.
                          PHP is opt-in because it needs PHP + Composer.
  --no-smoke              Skip smoke test
  --no-persist-env        Do not append env sourcing to shell rc files
  --skip-settings         Do not seed ~/.posse/account.db
  --skip-host-tools       Do not install system packages (build toolchain,
                          helper CLIs gh and rg, media tools when requested,
                          and the selected languages' toolchains).
                          Missing tools are still reported.
  --with-media-tools      Also install the media tools Posse's OCR and
                          image/video conversion use: tesseract, ImageMagick,
                          ffmpeg (off by default)
  --no-install-node       Do not auto-install Node via nvm when Node 24+ is missing
  --non-interactive       Never prompt (use environment variables for keys)
  --setup-only            Install core files; defer account/runtime setup to first run
  --configure-keys        Interactively prompt for provider API keys (stored in
                          ~/.config/posse/.env, chmod 600)
  --force                 Re-run npm install even if node_modules looks fresh
  --command-timeout <sec> Maximum ordinary command runtime (default: 1800)
  --doctor-timeout <sec>  Maximum doctor runtime, including Jina (default: 7500)
  --dry-run               Print what would happen; do not execute
  --plain                 Disable colors and spinners (also honors NO_COLOR)
  --help                  Show help

Notes:
  - Uses the Posse checkout containing this installer when available; cloning
    is only a fallback. ATLAS is built into Posse (no separate checkout).
  - Installs the C/C++ build toolchain needed by Posse's native npm modules
    (node-pty and friends) and auto-installs Node 24 via nvm when missing.
  - On RHEL 9+ and its rebuilds (AlmaLinux, Rocky, CentOS Stream), enables
    EPEL + CRB and the GitHub CLI repository only when a missing helper needs
    them. RPM Fusion is never added; helpers no enabled repository offers are
    reported with the command to get them.
  - SCIP language environments are installed through `posse doctor`, the
    same self-repair engine Posse uses at boot. Posse itself needs no Python;
    pip and venv come only when Python indexing is selected.
  - Re-runs are safe: unchanged steps are skipped. All output is captured to a
    log file whose path is printed in the summary.
USAGE
}

# --- argument parsing ----------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="${2:?missing value for --install-root}"; shift 2 ;;
    --posse-dir) POSSE_DIR="${2:?missing value for --posse-dir}"; shift 2 ;;
    --posse-repo-url) POSSE_REPO_URL="${2:?missing value for --posse-repo-url}"; shift 2 ;;
    --repo-id) REPO_ID="${2:?missing value for --repo-id}"; shift 2 ;;
    --repo-path) REPO_PATH="${2:?missing value for --repo-path}"; shift 2 ;;
    --smoke-query) SMOKE_QUERY="${2:?missing value for --smoke-query}"; shift 2 ;;
    --smoke-provider) SMOKE_PROVIDER="${2:?missing value for --smoke-provider}"; shift 2 ;;
    --scip-languages|--scip-langs) POSSE_SCIP_LANGUAGES="${2:?missing value for --scip-languages}"; POSSE_SCIP_LANGUAGES_SUPPLIED="true"; shift 2 ;;
    --scip-languages=*|--scip-langs=*) POSSE_SCIP_LANGUAGES="${1#*=}"; POSSE_SCIP_LANGUAGES_SUPPLIED="true"; shift ;;
    --no-smoke) RUN_SMOKE="false"; shift ;;
    --no-persist-env) PERSIST_ENV="false"; shift ;;
    --skip-settings) SEED_SETTINGS="false"; shift ;;
    --skip-host-tools) INSTALL_HOST_TOOLS="false"; shift ;;
    --with-media-tools) WITH_MEDIA_TOOLS="true"; shift ;;
    --no-install-node) INSTALL_NODE="false"; shift ;;
    --configure-keys) CONFIGURE_KEYS="true"; shift ;;
    --non-interactive) NON_INTERACTIVE="true"; shift ;;
    --setup-only) SETUP_ONLY="true"; shift ;;
    --force) FORCE_REINSTALL="true"; shift ;;
    --command-timeout) COMMAND_TIMEOUT_SECONDS="${2:?missing value for --command-timeout}"; shift 2 ;;
    --command-timeout=*) COMMAND_TIMEOUT_SECONDS="${1#*=}"; shift ;;
    --doctor-timeout) DOCTOR_TIMEOUT_SECONDS="${2:?missing value for --doctor-timeout}"; shift 2 ;;
    --doctor-timeout=*) DOCTOR_TIMEOUT_SECONDS="${1#*=}"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --plain|--no-color) PLAIN="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "[${INSTALLER_NAME}] ERROR: Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

normalize_timeout_seconds() {
  local variable_name="$1" timeout_value="$2" timeout_number
  if [[ ! "$timeout_value" =~ ^[0-9]{1,5}$ ]]; then
    echo "[${INSTALLER_NAME}] ERROR: command timeouts must be whole seconds between 60 and 86400" >&2
    exit 2
  fi
  timeout_number=$((10#$timeout_value))
  if ((timeout_number < 60 || timeout_number > 86400)); then
    echo "[${INSTALLER_NAME}] ERROR: command timeouts must be whole seconds between 60 and 86400" >&2
    exit 2
  fi
  printf -v "$variable_name" '%d' "$timeout_number"
}
normalize_timeout_seconds COMMAND_TIMEOUT_SECONDS "$COMMAND_TIMEOUT_SECONDS"
normalize_timeout_seconds DOCTOR_TIMEOUT_SECONDS "$DOCTOR_TIMEOUT_SECONDS"

# =============================================================================
# UI layer: colors, splash, spinner, step engine
# =============================================================================

UI_TTY=0
UI_COLOR=0
UI_TRUECOLOR=0
UI_256=0
UI_UTF8=0
# Safe defaults so the INT/EXIT traps can render a summary even if the run is
# interrupted before init_ui.
R=""; BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; MAGENTA=""; CYAN=""; ORANGE=""
GLYPH_OK="+"; GLYPH_FAIL="x"; GLYPH_WARN="!"; GLYPH_DOT="-"
SPINNER_FRAMES=("-")

init_ui() {
  [[ -t 1 ]] && UI_TTY=1
  if [[ "$PLAIN" != "true" && -z "${NO_COLOR:-}" && $UI_TTY -eq 1 && "${TERM:-dumb}" != "dumb" ]]; then
    UI_COLOR=1
    case "${COLORTERM:-}" in *truecolor*|*24bit*) UI_TRUECOLOR=1 ;; esac
    case "${TERM:-}" in *256color*|*direct*) UI_256=1 ;; esac
  fi
  local charmap="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  if command -v locale >/dev/null 2>&1; then
    charmap="$(locale charmap 2>/dev/null || true) ${charmap}"
  fi
  case "$charmap" in *UTF-8*|*utf-8*|*UTF8*|*utf8*) UI_UTF8=1 ;; esac

  if [[ $UI_COLOR -eq 1 ]]; then
    R=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
    RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    MAGENTA=$'\033[35m'; CYAN=$'\033[36m'
    if [[ $UI_TRUECOLOR -eq 1 ]]; then ORANGE=$'\033[38;2;255;153;51m'
    elif [[ $UI_256 -eq 1 ]]; then ORANGE=$'\033[38;5;208m'
    else ORANGE="$YELLOW"; fi
  else
    R=""; BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; MAGENTA=""; CYAN=""; ORANGE=""
  fi

  if [[ $UI_UTF8 -eq 1 ]]; then
    GLYPH_OK="✓"; GLYPH_FAIL="✗"; GLYPH_WARN="!"; GLYPH_DOT="·"
    SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  else
    GLYPH_OK="+"; GLYPH_FAIL="x"; GLYPH_WARN="!"; GLYPH_DOT="-"
    SPINNER_FRAMES=("-" "\\" "|" "/")
  fi
}

# Per-column orange→magenta truecolor gradient over the block logotype; falls
# back to per-line 256-color stops, then to a single color, then to ASCII art.
print_splash() {
  echo
  if [[ $UI_UTF8 -eq 1 ]]; then
    local lines=(
      "██████╗  ██████╗ ███████╗███████╗███████╗"
      "██╔══██╗██╔═══██╗██╔════╝██╔════╝██╔════╝"
      "██████╔╝██║   ██║███████╗███████╗█████╗  "
      "██╔═══╝ ██║   ██║╚════██║╚════██║██╔══╝  "
      "██║     ╚██████╔╝███████║███████║███████╗"
      "╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝"
    )
    if [[ $UI_TRUECOLOR -eq 1 ]]; then
      local line ch i n out r g b
      for line in "${lines[@]}"; do
        n=${#line}; out="  "
        for ((i = 0; i < n; i++)); do
          ch="${line:i:1}"
          if [[ "$ch" == " " ]]; then out+=" "; continue; fi
          r=255
          g=$((153 - (153 * i) / (n - 1)))
          b=$(((153 * i) / (n - 1)))
          out+=$'\033[38;2;'"${r};${g};${b}m${ch}"
        done
        printf "%s%s\n" "$out" "$R"
      done
    elif [[ $UI_256 -eq 1 ]]; then
      local stops=(214 208 203 198 197 161) i=0 line
      for line in "${lines[@]}"; do
        printf "  \033[38;5;%sm%s%s\n" "${stops[i]}" "$line" "$R"
        i=$((i + 1))
      done
    else
      local line
      for line in "${lines[@]}"; do printf "  %s%s%s\n" "$MAGENTA" "$line" "$R"; done
    fi
  else
    cat <<'ASCII'
   ____   ___  ____  ____  _____
  |  _ \ / _ \/ ___|/ ___|| ____|
  | |_) | | | \___ \\___ \|  _|
  |  __/| |_| |___) |___) | |___
  |_|    \___/|____/|____/|_____|
ASCII
  fi
  printf "  %s%sPosse + ATLAS%s %s— multi-provider dev orchestrator · Linux installer%s\n" "$BOLD" "$ORANGE" "$R" "$DIM" "$R"
  printf "  %s%s%s\n\n" "$DIM" "$(printf '%.0s─' {1..58})" "$R"
}

fmt_duration() {
  local secs=$1
  if ((secs >= 60)); then printf "%dm %02ds" $((secs / 60)) $((secs % 60)); else printf "%ds" "$secs"; fi
}

# --- log file ----------------------------------------------------------------
LOG_DIR="${HOME}/.posse/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="$(mktemp -d)"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"
# The log captures raw child output (doctor, native pulls, npm); keep it
# private to the installing user regardless of umask.
if : >"$LOG_FILE" 2>/dev/null; then chmod 600 "$LOG_FILE" 2>/dev/null || true; else LOG_FILE="/dev/null"; fi

log_only() { printf '%s\n' "$*" >>"$LOG_FILE"; }

info() { printf "    %s%s%s %s\n" "$DIM" "$GLYPH_DOT" "$R" "$*"; log_only "[info] $*"; }

WARNINGS=()
warn() {
  printf "    %s%s%s %s\n" "$YELLOW" "$GLYPH_WARN" "$R" "$*"
  WARNINGS+=("$*")
  log_only "[warn] $*"
}

SCIP_LANGUAGE_VALUES=(typescript python php go rust clang)
SCIP_LANGUAGE_LABELS=("TypeScript / JavaScript" "Python" "PHP" "Go" "Rust" "C / C++ (clang)")
SCIP_LANGUAGE_STEP_STATUS="ok"
SCIP_LANGUAGE_STEP_NOTE=""
# True when the user picked languages (--scip-languages or the prompt); that
# choice then replaces the saved account setting.
SCIP_LANGUAGES_CHOSEN="false"

scip_allowed_languages_text() {
  local joined="${SCIP_LANGUAGE_VALUES[*]}"
  printf '%s, all' "${joined// /, }"
}

scip_language_selected() {
  case ",${POSSE_SCIP_LANGUAGES}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

scip_language_alias() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  case "$value" in
    all) printf '%s\n' "all" ;;
    typescript|javascript|node|nodejs|ts|js) printf '%s\n' "typescript" ;;
    python|py) printf '%s\n' "python" ;;
    php) printf '%s\n' "php" ;;
    go|golang) printf '%s\n' "go" ;;
    rust|rs) printf '%s\n' "rust" ;;
    clang|c|c++|cpp|cxx|cc) printf '%s\n' "clang" ;;
    *) return 1 ;;
  esac
}

normalize_scip_languages() {
  local raw="${1:-}" token canonical selected="" invalid=()
  raw="${raw//,/ }"
  if [[ -z "${raw//[[:space:]]/}" ]]; then
    printf '%s\n' "no SCIP languages selected"
    return 1
  fi
  for token in $raw; do
    if ! canonical="$(scip_language_alias "$token")"; then
      invalid+=("$token")
      continue
    fi
    if [[ "$canonical" == "all" ]]; then
      selected="${SCIP_LANGUAGE_VALUES[*]}"
      break
    fi
    case " $selected " in
      *" $canonical "*) ;;
      *) selected="${selected:+$selected }$canonical" ;;
    esac
  done
  if [[ ${#invalid[@]} -gt 0 ]]; then
    printf 'invalid SCIP language(s): %s; allowed: %s\n' "${invalid[*]}" "$(scip_allowed_languages_text)"
    return 1
  fi
  if [[ -z "$selected" ]]; then
    printf '%s\n' "no SCIP languages selected"
    return 1
  fi
  printf '%s\n' "${selected// /,}"
}

prompt_scip_languages_if_needed() {
  local normalized answer raw token idx selection invalid_numbers

  if [[ "$POSSE_SCIP_LANGUAGES_SUPPLIED" == "true" ]]; then
    if ! normalized="$(normalize_scip_languages "$POSSE_SCIP_LANGUAGES")"; then
      SCIP_LANGUAGE_STEP_STATUS="failed"
      SCIP_LANGUAGE_STEP_NOTE="$normalized"
      return 1
    fi
    POSSE_SCIP_LANGUAGES="$normalized"
    SCIP_LANGUAGE_STEP_NOTE="selected ${POSSE_SCIP_LANGUAGES} (--scip-languages)"
    SCIP_LANGUAGES_CHOSEN="true"
    info "using --scip-languages: ${POSSE_SCIP_LANGUAGES}"
    return 0
  fi

  if ! normalized="$(normalize_scip_languages "$POSSE_SCIP_LANGUAGES")"; then
    SCIP_LANGUAGE_STEP_STATUS="failed"
    SCIP_LANGUAGE_STEP_NOTE="$normalized"
    return 1
  fi
  POSSE_SCIP_LANGUAGES="$normalized"

  if [[ "$SEED_SETTINGS" != "true" ]]; then
    SCIP_LANGUAGE_STEP_STATUS="skipped"
    SCIP_LANGUAGE_STEP_NOTE="--skip-settings; account language setting unchanged"
    info "initial SCIP language prompt skipped (--skip-settings)"
    return 0
  fi

  if [[ "$NON_INTERACTIVE" == "true" || "$DRY_RUN" == "true" || "$SETUP_ONLY" == "true" ]] || ! ( : </dev/tty ) 2>/dev/null; then
    SCIP_LANGUAGE_STEP_NOTE="selected ${POSSE_SCIP_LANGUAGES} (default; no interactive terminal)"
    info "no interactive terminal for SCIP language selection; using default: ${POSSE_SCIP_LANGUAGES}"
    return 0
  fi

  while true; do
    printf "\n  %sInitial SCIP language environments%s\n" "$BOLD" "$R" >/dev/tty
    printf "    Select one or more languages for first-run indexing. Press Enter for defaults [%s].\n" "$POSSE_SCIP_LANGUAGES" >/dev/tty
    printf "    Use numbers, names, comma-separated values, or 'all'.\n" >/dev/tty
    local i value mark
    for ((i = 0; i < ${#SCIP_LANGUAGE_VALUES[@]}; i++)); do
      value="${SCIP_LANGUAGE_VALUES[i]}"
      mark=" "
      case ",${POSSE_SCIP_LANGUAGES}," in *",$value,"*) mark="*" ;; esac
      printf "      %d) [%s] %s (%s)\n" "$((i + 1))" "$mark" "${SCIP_LANGUAGE_LABELS[i]}" "$value" >/dev/tty
    done
    if ! read -r -p "      Languages (numbers/names, comma-separated, or all): " answer </dev/tty; then
      SCIP_LANGUAGE_STEP_NOTE="selected ${POSSE_SCIP_LANGUAGES} (default; prompt unavailable)"
      info "SCIP language prompt unavailable; using default: ${POSSE_SCIP_LANGUAGES}"
      return 0
    fi
    if [[ -z "${answer//[[:space:]]/}" ]]; then
      SCIP_LANGUAGE_STEP_NOTE="selected ${POSSE_SCIP_LANGUAGES} (default)"
      info "initial SCIP languages: ${POSSE_SCIP_LANGUAGES}"
      return 0
    fi

    selection=""
    invalid_numbers=()
    raw="${answer//,/ }"
    for token in $raw; do
      if [[ "$token" =~ ^[0-9]+$ ]]; then
        idx=$((10#$token - 1))
        if ((idx >= 0 && idx < ${#SCIP_LANGUAGE_VALUES[@]})); then
          selection="${selection:+$selection }${SCIP_LANGUAGE_VALUES[idx]}"
        else
          invalid_numbers+=("$token")
        fi
      else
        selection="${selection:+$selection }$token"
      fi
    done
    if [[ ${#invalid_numbers[@]} -gt 0 ]]; then
      printf "    %s%s%s invalid option number(s): %s\n" "$YELLOW" "$GLYPH_WARN" "$R" "${invalid_numbers[*]}" >/dev/tty
      continue
    fi
    if normalized="$(normalize_scip_languages "$selection")"; then
      POSSE_SCIP_LANGUAGES="$normalized"
      SCIP_LANGUAGE_STEP_NOTE="selected ${POSSE_SCIP_LANGUAGES} (interactive)"
      SCIP_LANGUAGES_CHOSEN="true"
      info "initial SCIP languages: ${POSSE_SCIP_LANGUAGES}"
      return 0
    fi
    printf "    %s%s%s %s\n" "$YELLOW" "$GLYPH_WARN" "$R" "$normalized" >/dev/tty
  done
}

step_scip_languages() {
  step_begin languages
  info "choose initial SCIP language environments before runtime doctor runs"
  if prompt_scip_languages_if_needed; then
    step_end "$SCIP_LANGUAGE_STEP_STATUS" "$SCIP_LANGUAGE_STEP_NOTE"
    return 0
  fi
  CRITICAL_FAILED="true"
  step_end failed "$SCIP_LANGUAGE_STEP_NOTE"
  return 1
}

shell_quote() { printf "%q" "$1"; }

format_command() {
  local parts=() arg
  for arg in "$@"; do parts+=("$(shell_quote "$arg")"); done
  printf "%s" "${parts[*]}"
}

# --- step engine ---------------------------------------------------------------
# Steps are declared up-front so numbering and the summary are stable no matter
# where the run stops. Each step records ok/skipped/partial/failed/blocked.
# Order: the native download starts in the background right after npm (it
# needs Node, the checkout, its packages, and the Posse key, so keys are asked
# for first), and the remaining host tools install while it runs. The core
# system tools Node and the checkout need install at the start of the node step.
STEP_KEYS=(languages preflight node checkout keys npm packages composer automation shell seed admin native doctor validate smoke)
declare -A STEP_TITLES=(
  [languages]="SCIP language selection"
  [preflight]="Preflight checks"
  [packages]="System packages"
  [node]="Node.js runtime"
  [checkout]="Posse checkout"
  [composer]="Composer (SCIP PHP)"
  [npm]="npm dependencies"
  [automation]="Automation owner startup"
  [shell]="Shell wiring"
  [seed]="Account settings"
  [doctor]="Runtime doctor (SCIP + Jina)"
  [admin]="Provider CLI detection"
  [keys]="Provider API keys"
  [native]="Native binaries"
  [validate]="Validation"
  [smoke]="ATLAS smoke test"
)
declare -A STEP_STATUS STEP_NOTE
for k in "${STEP_KEYS[@]}"; do STEP_STATUS[$k]="pending"; STEP_NOTE[$k]=""; done
STEP_TOTAL=${#STEP_KEYS[@]}
STEP_INDEX=0
CURRENT_STEP=""
# Seconds each step took, for the log's closing "steps:" line.
declare -A STEP_STARTED=() STEP_SECONDS=()
CRITICAL_FAILED="false"
INSTALL_FAILED="false"

step_begin() {
  local key="$1"
  CURRENT_STEP="$key"
  STEP_STARTED[$key]=$SECONDS
  STEP_INDEX=$((STEP_INDEX + 1))
  printf "\n%s[%2d/%d]%s %s%s%s\n" "$DIM" "$STEP_INDEX" "$STEP_TOTAL" "$R" "$BOLD" "${STEP_TITLES[$key]}" "$R"
  log_only ""
  log_only "===== [${STEP_INDEX}/${STEP_TOTAL}] ${STEP_TITLES[$key]} ====="
}

step_end() {
  local status="$1" note="${2:-}"
  STEP_STATUS[$CURRENT_STEP]="$status"
  STEP_NOTE[$CURRENT_STEP]="$note"
  [[ "$status" == "failed" ]] && INSTALL_FAILED="true"
  local took=""
  if [[ -n "${STEP_STARTED[$CURRENT_STEP]:-}" ]]; then
    STEP_SECONDS[$CURRENT_STEP]=$((SECONDS - STEP_STARTED[$CURRENT_STEP]))
    took=" [${STEP_SECONDS[$CURRENT_STEP]}s]"
  fi
  log_only "----- ${CURRENT_STEP}: ${status}${note:+ (${note})}${took}"
  case "$status" in
    ok|done) printf "    %s%s%s %s\n" "$GREEN" "$GLYPH_OK" "$R" "${note:-done}" ;;
    skipped|dry-run) printf "    %s%s %s%s\n" "$DIM" "$GLYPH_DOT" "${note:-$status}" "$R" ;;
    partial) printf "    %s%s%s %s\n" "$YELLOW" "$GLYPH_WARN" "$R" "${note:-completed with warnings}" ;;
    failed) printf "    %s%s%s %s\n" "$RED" "$GLYPH_FAIL" "$R" "${note:-failed}" ;;
    blocked) printf "    %s%s %s%s\n" "$DIM" "$GLYPH_FAIL" "${note:-blocked by an earlier failure}" "$R" ;;
  esac
}

step_fail_critical() {
  CRITICAL_FAILED="true"
  step_end "failed" "$1"
}

block_pending_steps() {
  local note="${1:-blocked by an earlier failure}" key
  for key in "${STEP_KEYS[@]}"; do
    if [[ "${STEP_STATUS[$key]}" == "pending" ]]; then
      STEP_STATUS[$key]="blocked"
      STEP_NOTE[$key]="$note"
    fi
  done
}

# Runs `"$@"` with output captured to the log. On a TTY, shows a spinner with
# elapsed time; on failure prints the last lines of output. Backgrounded, so
# `"$@"` runs in a subshell: it must not mutate parent state.
CMD_PID=""
run_logged() {
  local desc="$1"; shift
  log_only ""
  log_only ">>> ${desc}"
  log_only ">>> \$ $(format_command "$@")"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf "    %s%s (dry-run) would run:%s %s\n" "$DIM" "$GLYPH_DOT" "$R" "$desc"
    return 0
  fi

  local chunk rc started elapsed
  local timeout_seconds="${RUN_LOGGED_TIMEOUT_SECONDS:-$COMMAND_TIMEOUT_SECONDS}"
  local timed_out="false"
  chunk="$(mktemp)"
  started=$SECONDS

  ("$@") >"$chunk" 2>&1 </dev/null &
  CMD_PID=$!

  local i=0 nframes=${#SPINNER_FRAMES[@]} plain_shown="false"
  while kill -0 "$CMD_PID" 2>/dev/null; do
    elapsed=$((SECONDS - started))
    if ((elapsed >= timeout_seconds)); then
      timed_out="true"
      kill_process_tree "$CMD_PID" TERM
      sleep 1
      kill_process_tree "$CMD_PID" KILL
      break
    fi
    if [[ $UI_COLOR -eq 1 ]]; then
      printf "\r\033[2K    %s%s%s %s %s(%s)%s" "$CYAN" "${SPINNER_FRAMES[i]}" "$R" "$desc" "$DIM" "$(fmt_duration $elapsed)" "$R"
      i=$(((i + 1) % nframes))
    elif [[ "$plain_shown" != "true" ]]; then
      printf "    %s%s%s %s\n" "$DIM" "$GLYPH_DOT" "$R" "$desc"
      plain_shown="true"
    fi
    sleep 0.12
  done
  [[ $UI_COLOR -eq 1 ]] && printf "\r\033[2K"

  if [[ "$timed_out" == "true" ]]; then
    # SIGKILL normally leaves a reapable zombie immediately. Avoid an
    # unbounded wait if a kernel-level I/O stall leaves the process alive.
    local settle_deadline=$((SECONDS + 5)) process_state=""
    while ((SECONDS < settle_deadline)); do
      process_state="$(ps -o stat= -p "$CMD_PID" 2>/dev/null | tr -d '[:space:]')"
      [[ -z "$process_state" || "$process_state" == Z* ]] && break
      sleep 0.1
    done
    process_state="$(ps -o stat= -p "$CMD_PID" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$process_state" || "$process_state" == Z* ]]; then
      wait "$CMD_PID" 2>/dev/null || true
    fi
    rc=124
  else
    wait "$CMD_PID"
    rc=$?
  fi
  CMD_PID=""
  elapsed=$((SECONDS - started))
  cat "$chunk" >>"$LOG_FILE"
  if [[ "$timed_out" == "true" ]]; then
    printf 'timed out after %ss\n' "$timeout_seconds" >>"$chunk"
    printf 'timed out after %ss\n' "$timeout_seconds" >>"$LOG_FILE"
  fi
  log_only "<<< exit ${rc} after ${elapsed}s"

  if [[ $rc -eq 0 ]]; then
    printf "    %s%s%s %s %s(%s)%s\n" "$GREEN" "$GLYPH_OK" "$R" "$desc" "$DIM" "$(fmt_duration $elapsed)" "$R"
  else
    printf "    %s%s%s %s %s(exit %d after %s)%s\n" "$RED" "$GLYPH_FAIL" "$R" "$desc" "$DIM" "$rc" "$(fmt_duration $elapsed)" "$R"
    if [[ -s "$chunk" ]]; then
      printf "    %s┆ last output:%s\n" "$DIM" "$R"
      tail -n 10 "$chunk" | sed 's/^/      /'
      printf "    %s┆ full log: %s%s\n" "$DIM" "$LOG_FILE" "$R"
    fi
  fi
  rm -f "$chunk"
  return $rc
}

run_logged_in_dir() {
  local dir="$1" desc="$2"; shift 2
  run_logged "$desc" run_in_dir_helper "$dir" "$@"
}
run_logged_in_dir_timeout() {
  local timeout_seconds="$1" dir="$2" desc="$3"; shift 3
  RUN_LOGGED_TIMEOUT_SECONDS="$timeout_seconds" run_logged "$desc" run_in_dir_helper "$dir" "$@"
}
run_in_dir_helper() { local dir="$1"; shift; cd "$dir" && "$@"; }

# --- summary + traps -----------------------------------------------------------
format_step_timings() {
  local key out="steps:"
  for key in "${STEP_KEYS[@]}"; do
    [[ -n "${STEP_SECONDS[$key]:-}" ]] && out+=" ${key}=${STEP_SECONDS[$key]}s"
  done
  printf '%s total=%ss' "$out" "$SECONDS"
}

SUMMARY_PRINTED="false"
print_summary() {
  [[ "$SUMMARY_PRINTED" == "true" ]] && return 0
  SUMMARY_PRINTED="true"
  local key status note color glyph
  echo
  printf "  %s%s%s\n" "$DIM" "$(printf '%.0s─' {1..58})" "$R"
  printf "  %sInstall summary%s\n" "$BOLD" "$R"
  for key in "${STEP_KEYS[@]}"; do
    status="${STEP_STATUS[$key]}"
    note="${STEP_NOTE[$key]}"
    case "$status" in
      ok|done) color="$GREEN"; glyph="$GLYPH_OK" ;;
      partial) color="$YELLOW"; glyph="$GLYPH_WARN" ;;
      failed) color="$RED"; glyph="$GLYPH_FAIL" ;;
      blocked) color="$DIM"; glyph="$GLYPH_FAIL" ;;
      *) color="$DIM"; glyph="$GLYPH_DOT" ;;
    esac
    printf "    %s%s%s %-31s %s%s%s%s\n" "$color" "$glyph" "$R" "${STEP_TITLES[$key]}" "$color" "$status" "$R" "${note:+ ${DIM}— ${note}${R}}"
  done
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    printf "\n  %sWarnings (%d):%s\n" "$YELLOW" "${#WARNINGS[@]}" "$R"
    local w
    for w in "${WARNINGS[@]}"; do printf "    %s%s%s %s\n" "$YELLOW" "$GLYPH_WARN" "$R" "$w"; done
  fi
  local timings
  timings="$(format_step_timings)"
  log_only "$timings"
  printf "\n  %s%s%s" "$DIM" "$timings" "$R"
  printf "\n  %sLog:%s %s\n" "$DIM" "$R" "$LOG_FILE"
  echo
  if [[ "$INSTALL_FAILED" == "true" ]]; then
    printf "  %s%sInstall did not complete.%s Fix the failed step above and re-run — completed steps are skipped on re-runs.\n\n" "$RED" "$BOLD" "$R"
  elif [[ "$SETUP_ONLY" == "true" ]]; then
    printf '  Core installation complete; runtime readiness has NOT been checked.\n'
    printf '  At container runtime, supply POSSE_KEY and re-run this installer without --setup-only.\n\n'
  elif [[ "$DRY_RUN" == "true" ]]; then
    printf '  Preview complete; no runtime readiness checks were performed.\n\n'
  else
    printf "  %sNext steps:%s\n" "$BOLD" "$R"
    printf "    1. Open a new shell (or: source %s)\n" "${ENV_FILE:-$HOME/.config/posse/atlas.env}"
    printf "    2. cd <your project> && posse add     %s# describe a task%s\n" "$DIM" "$R"
    printf "    3. posse go                           %s# plan + run%s\n\n" "$DIM" "$R"
  fi
}

on_interrupt() {
  [[ -n "$CMD_PID" ]] && kill_process_tree "$CMD_PID" TERM
  printf "\n\n  %sInterrupted.%s\n" "$RED" "$R"
  [[ -n "$CURRENT_STEP" && "${STEP_STATUS[$CURRENT_STEP]}" == "pending" ]] && STEP_STATUS[$CURRENT_STEP]="failed" && STEP_NOTE[$CURRENT_STEP]="interrupted"
  CRITICAL_FAILED="true"
  INSTALL_FAILED="true"
  block_pending_steps "interrupted"
  print_summary
  exit 130
}

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && "$INSTALL_FAILED" != "true" ]]; then
    INSTALL_FAILED="true"
    if [[ -n "$CURRENT_STEP" && "${STEP_STATUS[$CURRENT_STEP]}" == "pending" ]]; then
      STEP_STATUS[$CURRENT_STEP]="failed"
      STEP_NOTE[$CURRENT_STEP]="installer exited unexpectedly (${rc})"
    fi
    block_pending_steps "installer exited unexpectedly (${rc})"
  fi
  print_summary
}

trap on_interrupt INT TERM
trap on_exit EXIT

# =============================================================================
# helpers
# =============================================================================

kill_process_tree() {
  local pid="$1" signal_name="${2:-TERM}" child
  while read -r child; do
    [[ -n "$child" ]] && kill_process_tree "$child" "$signal_name"
  done < <(ps -eo pid=,ppid= 2>/dev/null | awk -v parent="$pid" '$2 == parent { print $1 }')
  kill "-${signal_name}" "$pid" 2>/dev/null || true
}

node_major() { node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0; }

directory_writable() {
  local probe
  probe="$(mktemp "$1/.posse-write-XXXXXX" 2>/dev/null)" || return 1
  rm -f -- "$probe"
}

resolve_full_path() {
  # readlink -f is universal on Linux (GNU coreutils / busybox).
  readlink -f -- "$1" 2>/dev/null || printf "%s" "$1"
}

# HTTPS only, including across redirects: a downgraded hop must fail, not fetch.
fetch_to() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 300 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only --timeout=30 --tries=3 -O "$dest" "$url"
  else return 127; fi
}

fetch_stdout() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 300 "$url"
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only --timeout=30 --tries=3 -O- "$url"
  else return 127; fi
}

# verify_sha256 <file> <expected-hex>; prints the mismatch for the log.
verify_sha256() {
  local file="$1" expected="$2" actual=""
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum -- "$file" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 -- "$file" | cut -d' ' -f1)"
  else echo "no sha256sum/shasum available to verify ${file}"; return 1; fi
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    echo "checksum mismatch for ${file}: expected ${expected:0:16}…, got ${actual:0:16}…"
    return 1
  fi
}

find_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

detect_installer_posse_dir() {
  local candidate
  [[ -n "$SCRIPT_DIR" ]] || return 1
  candidate="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd -P)" || return 1
  [[ -f "$candidate/orchestrator.js" ]] && printf "%s\n" "$candidate"
}

resolve_posse_root_from_checkout() {
  local checkout_dir="$1"
  [[ -n "$checkout_dir" ]] || return 1
  if [[ -f "$checkout_dir/orchestrator.js" ]]; then
    resolve_full_path "$checkout_dir"
    return 0
  fi
  if [[ -f "$checkout_dir/posse/orchestrator.js" ]]; then
    resolve_full_path "$checkout_dir/posse"
    return 0
  fi
  return 1
}

# --- privilege handling --------------------------------------------------------
# Resolved once, interactively, BEFORE any spinner runs (sudo prompts and
# spinners don't mix — the password prompt would be swallowed into the log).
SUDO_STATE="unchecked" # root | ok | none
ensure_root_access() {
  [[ "$SUDO_STATE" != "unchecked" ]] && return 0
  if [[ "$(id -u)" -eq 0 ]]; then
    SUDO_STATE="root"
  elif command -v sudo >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      SUDO_STATE="ok"
    elif [[ "$NON_INTERACTIVE" != "true" && "$DRY_RUN" != "true" ]] && ( : </dev/tty ) 2>/dev/null; then
      printf "    %s%s%s sudo is needed to install system packages (you may be prompted)\n" "$DIM" "$GLYPH_DOT" "$R"
      if sudo -v; then SUDO_STATE="ok"; else SUDO_STATE="none"; fi
    else
      SUDO_STATE="none"
    fi
  else
    SUDO_STATE="none"
  fi
}

as_root() {
  case "$SUDO_STATE" in
    root) "$@" ;;
    ok) sudo -n "$@" ;;
    *) return 127 ;;
  esac
}

# --- package manager abstraction -------------------------------------------------
PKG_MGR="none"
detect_pkg_manager() {
  local mgr
  for mgr in apt-get dnf yum pacman zypper; do
    if command -v "$mgr" >/dev/null 2>&1; then PKG_MGR="$mgr"; return 0; fi
  done
}

# Refresh the package index once, in the parent shell, before any spinnered
# installs (pkg_install runs in run_logged subshells, so state set there —
# like an "already updated" flag — would not stick).
PKG_INDEX_REFRESHED="false"
pkg_refresh_index() {
  [[ "$PKG_INDEX_REFRESHED" == "true" ]] && return 0
  PKG_INDEX_REFRESHED="true"
  case "$PKG_MGR" in
    apt-get) run_logged "refresh package index (apt-get update)" as_root env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 update -qq || true ;;
    pacman) run_logged "refresh package index (pacman -Sy)" as_root pacman -Sy --noconfirm || true ;;
  esac
}

pkg_install() {
  # Installs one or more packages; returns non-zero if the manager fails.
  case "$PKG_MGR" in
    apt-get) as_root env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=120 install -y -qq --no-install-recommends "$@" ;;
    dnf) as_root dnf install -y -q "$@" ;;
    yum) as_root yum install -y -q "$@" ;;
    pacman) as_root pacman -S --needed --noconfirm "$@" ;;
    zypper) as_root zypper --non-interactive --quiet install "$@" ;;
    *) return 127 ;;
  esac
}

# Package names per manager. Toolchain packages are what a native npm module
# without a matching prebuild (node-pty) needs to compile; node-gyp needs
# python3 for that. better-sqlite3 ships prebuilt binaries and never compiles.
# pip and venv are only for Python projects, so they come only when Python
# indexing is selected.
core_packages() {
  local package
  for package in "$@"; do
    case "$PKG_MGR:$package" in
      apt-get:xz) printf '%s\n' xz-utils ;;
      dnf:procps|yum:procps) printf '%s\n' procps-ng ;;
      *) printf '%s\n' "$package" ;;
    esac
  done
}

# Python joins the toolchain only when Python is a chosen language: Posse
# itself needs none, and its npm install compiles nothing (see step_npm).
toolchain_packages() {
  local python_extras=""
  case "$PKG_MGR" in
    apt-get)
      scip_language_selected python && python_extras=" python3 python3-pip python3-venv"
      echo "build-essential pkg-config unzip${python_extras}" ;;
    dnf|yum)
      scip_language_selected python && python_extras=" python3 python3-pip"
      echo "gcc gcc-c++ make pkgconf-pkg-config unzip${python_extras}" ;;
    pacman)
      scip_language_selected python && python_extras=" python python-pip"
      echo "base-devel unzip${python_extras}" ;;
    zypper)
      scip_language_selected python && python_extras=" python3 python3-pip"
      echo "gcc gcc-c++ make pkg-config unzip${python_extras}" ;;
  esac
}

# name|check-kind|packages(comma-separated candidates, tried in order)
host_tools_table() {
  base_tools_table
  [[ "$WITH_MEDIA_TOOLS" == "true" ]] && media_tools_table
  return 0
}

# Media tools are opt-in (--with-media-tools) and listed last: they are the
# largest packages, and Posse runs without them (OCR is unavailable and image
# conversion falls back to sharp).
media_tools_table() {
  case "$PKG_MGR" in
    apt-get) printf '%s\n' "tesseract|tesseract|tesseract-ocr" "imagemagick|magick_or_convert|imagemagick" "ffmpeg|ffmpeg|ffmpeg" ;;
    # Fedora and EPEL ship ffmpeg as ffmpeg-free; plain ffmpeg is RPM Fusion's.
    dnf|yum) printf '%s\n' "tesseract|tesseract|tesseract" "imagemagick|magick_or_convert|ImageMagick" "ffmpeg|ffmpeg|ffmpeg-free,ffmpeg" ;;
    pacman) printf '%s\n' "tesseract|tesseract|tesseract" "imagemagick|magick_or_convert|imagemagick" "ffmpeg|ffmpeg|ffmpeg" ;;
    zypper) printf '%s\n' "tesseract|tesseract|tesseract-ocr" "imagemagick|magick_or_convert|ImageMagick" "ffmpeg|ffmpeg|ffmpeg" ;;
  esac
}

base_tools_table() {
  case "$PKG_MGR" in
    apt-get)
      cat <<'EOT'
ripgrep|rg|ripgrep
github-cli|gh|gh
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php-cli,php
composer|composer|composer
EOT
      fi
      if scip_language_selected go; then cat <<'EOT'
go|go|golang-go
EOT
      fi
      ;;
    dnf|yum)
      # Fedora and EPEL ship ffmpeg as ffmpeg-free; plain ffmpeg is RPM Fusion's.
      cat <<'EOT'
ripgrep|rg|ripgrep
github-cli|gh|gh
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php-cli,php
composer|composer|composer,php-composer
EOT
      fi
      if scip_language_selected go; then cat <<'EOT'
go|go|golang
EOT
      fi
      ;;
    pacman)
      cat <<'EOT'
ripgrep|rg|ripgrep
github-cli|gh|github-cli
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php
composer|composer|composer
EOT
      fi
      if scip_language_selected go; then cat <<'EOT'
go|go|go
EOT
      fi
      ;;
    zypper)
      cat <<'EOT'
ripgrep|rg|ripgrep
github-cli|gh|gh
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php8-cli,php-cli,php8,php7
composer|composer|php-composer,composer
EOT
      fi
      if scip_language_selected go; then cat <<'EOT'
go|go|go
EOT
      fi
      ;;
  esac
}

tool_available() {
  case "$1" in
    magick_or_convert) command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1 ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

# Whether the enabled repositories offer a package (or it is installed), so a
# name a repository lacks is skipped instead of failing loudly. Only dnf/yum
# answer this cheaply; other managers just attempt the install.
pkg_available() {
  [[ "$DRY_RUN" == "true" ]] && return 0
  case "$PKG_MGR" in
    dnf|yum) as_root "$PKG_MGR" -q list "$1" >>"$LOG_FILE" 2>&1 ;;
    *) return 0 ;;
  esac
}

# --- RPM-family extra repositories ---------------------------------------------
# RHEL 9+ and its rebuilds (AlmaLinux, Rocky, CentOS Stream) keep ripgrep,
# ImageMagick, ffmpeg-free and composer in EPEL, whose packages may need CRB;
# gh comes from the GitHub CLI's own repository. Amazon Linux 2023 has no EPEL.
# Repositories are enabled only when a missing helper needs one, and a failure
# only leaves that optional helper uninstalled. RPM Fusion is never added.
OS_RELEASE_FILE="/etc/os-release"
YUM_REPOS_DIR="/etc/yum.repos.d"
GH_CLI_REPO_URL="https://cli.github.com/packages/rpm/gh-cli.repo"
OS_ID=""
OS_ID_LIKE=""
OS_VERSION_MAJOR=""
RPM_REPO_FAMILY=""

read_os_release() {
  OS_ID=""; OS_ID_LIKE=""; OS_VERSION_MAJOR=""
  [[ -r "$OS_RELEASE_FILE" ]] || return 1
  local key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    value="${value%$'\r'}"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    case "$key" in
      ID) OS_ID="${value,,}" ;;
      ID_LIKE) OS_ID_LIKE="${value,,}" ;;
      VERSION_ID) OS_VERSION_MAJOR="${value%%.*}" ;;
    esac
  done <"$OS_RELEASE_FILE"
  return 0
}

# Sets RPM_REPO_FAMILY: "el" for RHEL and its rebuilds 9+, "amzn" for Amazon
# Linux 2023+, empty elsewhere (Fedora's own repositories carry every helper).
detect_rpm_repo_family() {
  RPM_REPO_FAMILY=""
  read_os_release || return 0
  [[ "$OS_VERSION_MAJOR" =~ ^[0-9]+$ ]] || return 0
  case "$OS_ID" in
    amzn) ((OS_VERSION_MAJOR >= 2023)) && RPM_REPO_FAMILY="amzn"; return 0 ;;
    fedora) return 0 ;;
  esac
  case " $OS_ID $OS_ID_LIKE " in
    *" rhel "*|*" centos "*) ((OS_VERSION_MAJOR >= 9)) && RPM_REPO_FAMILY="el" ;;
  esac
  return 0
}

# EL 9's default php module stream (8.0) is older than scip-php supports (8.1
# for the legacy track, 8.3 for current upstream). True when PHP indexing is
# selected on an EL host and php is missing or older than 8.3, so the newest
# AppStream php stream gets enabled before php installs or upgrades.
el_php_too_old() {
  scip_language_selected php || return 1
  [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]] || return 1
  detect_rpm_repo_family
  [[ "$RPM_REPO_FAMILY" == "el" ]] || return 1
  command -v php >/dev/null 2>&1 || return 0
  ! php -r 'exit(version_compare(PHP_VERSION, "8.3.0", ">=") ? 0 : 1);' >/dev/null 2>&1
}

# rpm_repo_plan <missing helper names...>: the repository actions those helpers
# need on this host (after detect_rpm_repo_family), one per line, in order.
rpm_repo_plan() {
  local name need_epel="false" need_gh="false" need_php_stream="false"
  for name in "$@"; do
    case "$name" in
      ripgrep|imagemagick|ffmpeg|composer) need_epel="true" ;;
      github-cli) need_gh="true" ;;
      php) need_php_stream="true" ;;
    esac
  done
  if [[ "$RPM_REPO_FAMILY" == "el" && "$need_php_stream" == "true" ]]; then
    printf '%s\n' php-stream
  fi
  if [[ "$RPM_REPO_FAMILY" == "el" && "$need_epel" == "true" ]]; then
    printf '%s\n' crb epel
  fi
  if [[ -n "$RPM_REPO_FAMILY" && "$need_gh" == "true" && ! -f "$YUM_REPOS_DIR/gh-cli.repo" ]]; then
    printf '%s\n' gh-cli
  fi
  return 0
}

# RHEL proper manages CRB through subscription-manager; the rebuilds ship it
# disabled behind dnf config-manager.
rpm_enable_crb() {
  if [[ "$OS_ID" == "rhel" ]]; then
    command -v subscription-manager >/dev/null 2>&1 || return 1
    as_root subscription-manager repos --enable "codeready-builder-for-rhel-${OS_VERSION_MAJOR}-$(uname -m)-rpms"
    return
  fi
  pkg_install dnf-plugins-core || return 1
  as_root "$PKG_MGR" config-manager --set-enabled crb
}

# RHEL proper has no epel-release package; the rebuilds carry it in extras.
rpm_enable_epel() {
  if [[ "$OS_ID" == "rhel" ]]; then
    pkg_install "https://dl.fedoraproject.org/pub/epel/epel-release-latest-${OS_VERSION_MAJOR}.noarch.rpm"
  else
    pkg_install epel-release
  fi
}

# Enable the newest php module stream AppStream offers (8.3 on EL 9.4+); an
# already installed php moves to it with `module switch-to`.
rpm_enable_php_stream() {
  local stream
  stream="$(LC_ALL=C as_root "$PKG_MGR" -q module list php 2>/dev/null \
    | awk '$1 == "php" && $2 ~ /^[0-9]+\.[0-9]+$/ {print $2}' | sort -V | tail -n 1)"
  [[ -n "$stream" ]] || return 1
  if command -v php >/dev/null 2>&1; then
    as_root "$PKG_MGR" -y -q module switch-to "php:$stream"
  else
    as_root "$PKG_MGR" -y -q module reset php && as_root "$PKG_MGR" -y -q module enable "php:$stream"
  fi
}

rpm_add_gh_cli_repo() {
  pkg_install dnf-plugins-core || return 1
  as_root "$PKG_MGR" config-manager --add-repo "$GH_CLI_REPO_URL"
}

epel_enable_command() {
  if [[ "$OS_ID" == "rhel" ]]; then
    printf '%s' "sudo subscription-manager repos --enable codeready-builder-for-rhel-${OS_VERSION_MAJOR}-\$(uname -m)-rpms && sudo dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-${OS_VERSION_MAJOR}.noarch.rpm"
  else
    printf '%s' "sudo dnf install dnf-plugins-core && sudo dnf config-manager --set-enabled crb && sudo dnf install epel-release"
  fi
}

# Enables what the missing helpers need, in the parent shell before they
# install. Every failure is a warning: the helpers are optional.
prepare_rpm_repos() {
  [[ "$PKG_MGR" == "dnf" || "$PKG_MGR" == "yum" ]] || return 0
  detect_rpm_repo_family
  local action changed="false"
  while read -r action; do
    case "$action" in
      crb)
        if run_logged "enable the CRB repository (EPEL dependencies)" rpm_enable_crb; then changed="true"
        else warn "could not enable the CRB repository; some EPEL packages may not install"; fi ;;
      epel)
        if run_logged "enable EPEL (ripgrep, ImageMagick, ffmpeg-free)" rpm_enable_epel; then changed="true"
        else warn "could not enable EPEL; to add it yourself: $(epel_enable_command)"; fi ;;
      php-stream)
        if run_logged "enable the newest PHP module stream (scip-php needs PHP 8.1+, current upstream 8.3+)" rpm_enable_php_stream; then changed="true"
        else warn "could not enable a newer PHP module stream; PHP indexing needs PHP 8.1+ (sudo dnf module switch-to php:8.3)"; fi ;;
      gh-cli)
        if run_logged "add the GitHub CLI package repository" rpm_add_gh_cli_repo; then changed="true"
        else warn "could not add the GitHub CLI repository (${GH_CLI_REPO_URL}); gh installs only if another enabled repository has it"; fi ;;
    esac
  done < <(rpm_repo_plan "$@")
  if [[ "$changed" == "true" ]]; then
    run_logged "refresh package metadata" as_root "$PKG_MGR" -q makecache || true
  fi
  return 0
}

# Why a helper's package is missing from this host's enabled repositories, and
# how to add it, for the summary warnings.
helper_unavailable_hint() {
  local name="$1" packages="$2"
  case "${RPM_REPO_FAMILY}:${name}" in
    el:ffmpeg)
      printf '%s' "EPEL's ffmpeg-free is not installable here; the full build is in RPM Fusion (third-party, not added automatically): sudo dnf install --nogpgcheck https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-${OS_VERSION_MAJOR}.noarch.rpm && sudo dnf install ffmpeg" ;;
    el:ripgrep|el:imagemagick|el:composer)
      printf '%s' "it comes from EPEL; enable it and re-run: $(epel_enable_command)" ;;
    el:github-cli|amzn:github-cli)
      printf '%s' "add the GitHub CLI repository and re-run: sudo dnf install dnf-plugins-core && sudo dnf config-manager --add-repo ${GH_CLI_REPO_URL}" ;;
    amzn:ripgrep)
      printf '%s' "Amazon Linux has neither a ripgrep package nor EPEL; install a release binary from https://github.com/BurntSushi/ripgrep/releases" ;;
    amzn:ffmpeg)
      printf '%s' "Amazon Linux has no ffmpeg package and RPM Fusion does not support it; install a static build from https://ffmpeg.org/download.html if you want the ffmpeg image fallback" ;;
    amzn:tesseract)
      printf '%s' "Amazon Linux 2023 does not package tesseract, so OCR stays off unless you build it from https://github.com/tesseract-ocr/tesseract" ;;
    *)
      printf '%s' "no enabled repository offers ${packages//,/ or }" ;;
  esac
}

# Installs each missing helper (name|check|candidates) from the first candidate
# an enabled repository offers. Sets HELPER_FAILED (an install ran but the tool
# is still missing) and HELPER_UNAVAILABLE (no repository offers a candidate).
HELPER_FAILED=()
HELPER_UNAVAILABLE=()
install_missing_helpers() {
  HELPER_FAILED=()
  HELPER_UNAVAILABLE=()
  local entry name check pkgs pkg installed offered
  local -a candidates
  for entry in "$@"; do
    IFS='|' read -r name check pkgs <<<"$entry"
    installed="false"
    offered="false"
    IFS=',' read -ra candidates <<<"$pkgs"
    for pkg in "${candidates[@]}"; do
      pkg_available "$pkg" || continue
      offered="true"
      if run_logged "install ${name} (${pkg})" pkg_install "$pkg"; then
        installed="true"
        break
      fi
    done
    [[ "$DRY_RUN" == "true" ]] && continue
    if [[ "$offered" != "true" ]]; then
      HELPER_UNAVAILABLE+=("$name")
      warn "optional ${name} not installed: $(helper_unavailable_hint "$name" "$pkgs")"
    elif [[ "$installed" != "true" ]] || ! tool_available "$check"; then
      HELPER_FAILED+=("$name")
    fi
  done
  return 0
}

# rustup puts cargo in ~/.cargo/bin, which non-login shells may not have on
# PATH; adopt it before deciding Rust is missing.
rust_toolchain_present() {
  if [[ -x "$HOME/.cargo/bin/cargo" && ":$PATH:" != *":$HOME/.cargo/bin:"* ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1
}

# Rust indexing needs cargo/rustc plus rust-analyzer, which distro packages
# often lack. rustup installs per user (no root) and is verified against its
# published SHA-256 before it runs.
install_rust_toolchain() {
  local triple
  case "$(uname -m)" in
    x86_64|amd64) triple="x86_64-unknown-linux-gnu" ;;
    aarch64|arm64) triple="aarch64-unknown-linux-gnu" ;;
    *) warn "rustup has no build for $(uname -m); install Rust manually to index Rust"; return 1 ;;
  esac
  local url="https://static.rust-lang.org/rustup/dist/${triple}/rustup-init"
  if [[ "$DRY_RUN" == "true" ]]; then
    run_logged "install Rust + rust-analyzer via rustup (${triple})" true
    return 0
  fi
  local work expected
  work="$(mktemp -d)" || return 1
  if ! run_logged "download rustup-init (${triple})" fetch_to "$url" "$work/rustup-init" \
    || ! run_logged "download rustup-init checksum" fetch_to "${url}.sha256" "$work/rustup-init.sha256"; then
    rm -rf "$work"
    warn "could not download rustup-init; install Rust manually to index Rust"
    return 1
  fi
  expected="$(cut -d' ' -f1 <"$work/rustup-init.sha256")"
  if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || ! run_logged "verify rustup-init checksum" verify_sha256 "$work/rustup-init" "$expected"; then
    rm -rf "$work"
    warn "rustup-init did not match its published SHA-256; refusing to run it"
    return 1
  fi
  chmod 700 "$work/rustup-init"
  if ! run_logged "install Rust + rust-analyzer (rustup)" "$work/rustup-init" -y --profile minimal --component rust-analyzer; then
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work"
  export PATH="$HOME/.cargo/bin:$PATH"
  rust_toolchain_present
}

# scip-go needs Go 1.21+, which some distros lag behind (Debian 12 ships
# 1.19). The official go.dev archive installs per user (no root), checked
# against its published SHA-256, and goes first on PATH.
GO_RUNTIME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/posse/runtimes/go"

go_version_ok() {
  local version
  version="$(go version 2>/dev/null)" || return 1
  [[ "$version" =~ go([0-9]+)\.([0-9]+) ]] || return 1
  ((BASH_REMATCH[1] > 1 || BASH_REMATCH[2] >= 21))
}

install_portable_go() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) warn "go.dev has no Linux build for $(uname -m); install Go 1.21+ manually to index Go"; return 1 ;;
  esac
  if [[ "$DRY_RUN" == "true" ]]; then
    run_logged "install Go from go.dev (linux-${arch})" true
    return 0
  fi
  local work version file expected
  work="$(mktemp -d)" || return 1
  if ! run_logged "look up the current Go release" fetch_to "https://go.dev/VERSION?m=text" "$work/VERSION"; then
    rm -rf "$work"
    return 1
  fi
  version="$(head -n 1 "$work/VERSION" | tr -d '\r')"
  if [[ ! "$version" =~ ^go[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    rm -rf "$work"
    warn "go.dev returned an unexpected Go version; install Go 1.21+ manually to index Go"
    return 1
  fi
  file="${version}.linux-${arch}.tar.gz"
  if ! run_logged "download Go ${version#go}" fetch_to "https://dl.google.com/go/${file}" "$work/$file" \
    || ! run_logged "download Go checksum" fetch_to "https://dl.google.com/go/${file}.sha256" "$work/$file.sha256"; then
    rm -rf "$work"
    return 1
  fi
  expected="$(tr -d ' \r\n' <"$work/$file.sha256")"
  if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || ! run_logged "verify Go checksum" verify_sha256 "$work/$file" "$expected"; then
    rm -rf "$work"
    warn "the Go archive did not match its published SHA-256; refusing to install it"
    return 1
  fi
  mkdir -p "$work/unpacked" "$(dirname "$GO_RUNTIME_DIR")" || { rm -rf "$work"; return 1; }
  if ! run_logged "unpack Go ${version#go}" tar -xzf "$work/$file" -C "$work/unpacked" \
    || [[ ! -x "$work/unpacked/go/bin/go" ]]; then
    rm -rf "$work"
    return 1
  fi
  rm -rf "${GO_RUNTIME_DIR}.old"
  [[ -e "$GO_RUNTIME_DIR" ]] && mv "$GO_RUNTIME_DIR" "${GO_RUNTIME_DIR}.old"
  if ! mv "$work/unpacked/go" "$GO_RUNTIME_DIR"; then
    [[ -e "${GO_RUNTIME_DIR}.old" ]] && mv "${GO_RUNTIME_DIR}.old" "$GO_RUNTIME_DIR"
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work" "${GO_RUNTIME_DIR}.old"
  export PATH="$GO_RUNTIME_DIR/bin:$PATH"
  go_version_ok
}

# Use a Go 1.21+ already here (a previous go.dev install included), else
# install one. Returns non-zero only when Go is selected and none could be set up.
ensure_modern_go() {
  scip_language_selected go || return 0
  if [[ -x "$GO_RUNTIME_DIR/bin/go" && ":$PATH:" != *":$GO_RUNTIME_DIR/bin:"* ]]; then
    export PATH="$GO_RUNTIME_DIR/bin:$PATH"
  fi
  go_version_ok && return 0
  if command -v go >/dev/null 2>&1; then
    info "$(go version 2>/dev/null | awk '{print $3}' | sed 's/^go/Go /') is older than 1.21; installing Go from go.dev"
  fi
  install_portable_go && return 0
  warn "could not set up Go 1.21+, so scip-go may fail to install; install Go from https://go.dev/dl and re-run"
  return 1
}

# =============================================================================
# steps
# =============================================================================

# Core system packages this host lacks: git, curl (or wget), CA roots, tar,
# xz, and ps.
missing_core_packages() {
  command -v git >/dev/null 2>&1 || echo git
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || echo curl
  [[ -s /etc/ssl/certs/ca-certificates.crt || -s /etc/pki/tls/certs/ca-bundle.crt ]] || echo ca-certificates
  command -v tar >/dev/null 2>&1 || echo tar
  command -v xz >/dev/null 2>&1 || echo xz
  command -v ps >/dev/null 2>&1 || echo procps
}

# Node's install downloads and unpacks, and the checkout clones, before the
# packages step runs; install just the core packages they need, in one
# transaction. step_packages finds them present and adds the rest after npm.
ensure_core_packages() {
  local missing_core=() name pkg pkgs=()
  while IFS= read -r name; do missing_core+=("$name"); done < <(missing_core_packages)
  [[ ${#missing_core[@]} -eq 0 ]] && return 0
  if [[ "$INSTALL_HOST_TOOLS" != "true" ]]; then
    warn "missing (not installed due to --skip-host-tools): ${missing_core[*]}"
    return 0
  fi
  detect_pkg_manager
  if [[ "$PKG_MGR" == "none" ]]; then
    warn "no supported package manager found; install ${missing_core[*]} manually"
    return 0
  fi
  ensure_root_access
  if [[ "$SUDO_STATE" == "none" && "$DRY_RUN" != "true" ]]; then
    warn "cannot install ${missing_core[*]}: not root and sudo unavailable/declined"
    return 0
  fi
  pkg_refresh_index
  while IFS= read -r pkg; do pkgs+=("$pkg"); done < <(core_packages "${missing_core[@]}")
  run_logged "install core system packages (${missing_core[*]})" pkg_install "${pkgs[@]}" \
    || warn "could not install ${missing_core[*]}; the packages step tries again"
}

step_packages() {
  step_begin packages
  detect_pkg_manager
  [[ "$WITH_MEDIA_TOOLS" == "true" ]] || info "media tools (tesseract, ImageMagick, ffmpeg) not requested; --with-media-tools adds them"

  # What's missing? Core + toolchain checked by representative commands.
  local missing_core=() missing_toolchain="false" missing_tools=() missing_rust="false" core_name
  while IFS= read -r core_name; do missing_core+=("$core_name"); done < <(missing_core_packages)
  { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; } && command -v make >/dev/null 2>&1 && command -v pkg-config >/dev/null 2>&1 || missing_toolchain="true"
  if scip_language_selected python; then find_python >/dev/null 2>&1 || missing_toolchain="true"; fi
  # Debian/Ubuntu split venv out of python3; Python projects' managed venvs need it.
  if [[ "$PKG_MGR" == "apt-get" ]] && scip_language_selected python && find_python >/dev/null 2>&1; then
    "$(find_python)" -c 'import venv, ensurepip' >/dev/null 2>&1 || missing_toolchain="true"
  fi

  local line name check pkgs
  while IFS='|' read -r name check pkgs; do
    [[ -z "$name" ]] && continue
    if ! tool_available "$check" || { [[ "$name" == php ]] && el_php_too_old; }; then
      missing_tools+=("${name}|${check}|${pkgs}")
    fi
  done < <(host_tools_table)

  # Rust's toolchain comes from rustup, not the package manager.
  if scip_language_selected rust && ! rust_toolchain_present; then missing_rust="true"; fi
  local missing_system="false"
  if [[ ${#missing_core[@]} -gt 0 || "$missing_toolchain" == "true" || ${#missing_tools[@]} -gt 0 ]]; then
    missing_system="true"
  fi

  if [[ "$missing_system" == "false" && "$missing_rust" == "false" ]]; then
    if ! ensure_modern_go; then
      step_end partial "Go 1.21+ could not be installed"
      return 0
    fi
    step_end ok "git, curl, build toolchain, and helper CLIs all present"
    return 0
  fi

  if [[ "$INSTALL_HOST_TOOLS" != "true" ]]; then
    local names=()
    [[ ${#missing_core[@]} -gt 0 ]] && names+=("${missing_core[@]}")
    [[ "$missing_toolchain" == "true" ]] && names+=("build-toolchain")
    local t; for t in "${missing_tools[@]}"; do names+=("${t%%|*}"); done
    [[ "$missing_rust" == "true" ]] && names+=("rust-toolchain")
    warn "missing (not installed due to --skip-host-tools): ${names[*]}"
    step_end skipped "--skip-host-tools; missing: ${names[*]}"
    return 0
  fi

  local failures=() unavailable=() system_gap=""
  if [[ "$missing_system" == "true" ]]; then
    if [[ "$PKG_MGR" == "none" ]]; then
      warn "no supported package manager found (apt/dnf/yum/pacman/zypper); install missing packages manually"
      system_gap="no package manager; some tools missing"
    else
      ensure_root_access
      if [[ "$SUDO_STATE" == "none" && "$DRY_RUN" != "true" ]]; then
        warn "cannot install system packages: not root and sudo unavailable/declined"
        system_gap="no root access; packages not installed"
      else
        pkg_refresh_index
        # EPEL, CRB and the GitHub CLI repository must be enabled before the
        # transaction below, or RHEL-family hosts can't resolve those helpers.
        if [[ ${#missing_tools[@]} -gt 0 ]]; then
          local helper_names=() entry
          for entry in "${missing_tools[@]}"; do helper_names+=("${entry%%|*}"); done
          prepare_rpm_repos "${helper_names[@]}"
        fi

        # Everything missing goes in one transaction: one resolver run and one
        # round of package triggers. One name this repository lacks fails the
        # whole transaction (dnf/pacman/zypper refuse it; EPEL-less RHEL lacks
        # several helpers), so then fall back to core and toolchain in one shot
        # each and every helper through its candidate names.
        local all_pkgs=() toolchain_list=() pending_tools=() entry pkg
        if [[ ${#missing_core[@]} -gt 0 ]]; then
          while IFS= read -r pkg; do all_pkgs+=("$pkg"); done < <(core_packages "${missing_core[@]}")
        fi
        if [[ "$missing_toolchain" == "true" ]]; then
          read -ra toolchain_list <<<"$(toolchain_packages)"
          all_pkgs+=("${toolchain_list[@]}")
        fi
        for entry in "${missing_tools[@]}"; do
          IFS='|' read -r name check pkgs <<<"$entry"
          all_pkgs+=("${pkgs%%,*}")
        done
        if run_logged "install ${#all_pkgs[@]} system packages in one transaction" pkg_install "${all_pkgs[@]}"; then
          # A package can install without providing the command; retry those.
          if [[ "$DRY_RUN" != "true" ]]; then
            for entry in "${missing_tools[@]}"; do
              IFS='|' read -r name check pkgs <<<"$entry"
              tool_available "$check" || pending_tools+=("$entry")
            done
          fi
        else
          info "one-transaction install failed; installing in groups instead"
          if [[ ${#missing_core[@]} -gt 0 ]]; then
            # shellcheck disable=SC2046,SC2086
            run_logged "install core packages (${missing_core[*]})" pkg_install $(core_packages "${missing_core[@]}") || failures+=("core")
          fi
          if [[ "$missing_toolchain" == "true" ]]; then
            run_logged "install build toolchain ($(toolchain_packages | cut -c1-48)…)" pkg_install "${toolchain_list[@]}" || failures+=("toolchain")
          fi
          pending_tools=("${missing_tools[@]}")
        fi

        if [[ ${#pending_tools[@]} -gt 0 ]]; then
          install_missing_helpers "${pending_tools[@]}"
          [[ ${#HELPER_FAILED[@]} -gt 0 ]] && failures+=("${HELPER_FAILED[@]}")
          [[ ${#HELPER_UNAVAILABLE[@]} -gt 0 ]] && unavailable+=("${HELPER_UNAVAILABLE[@]}")
        fi
      fi
    fi
  fi

  # rustup installs per user, so it runs even without root access.
  if [[ "$missing_rust" == "true" ]] && ! install_rust_toolchain; then
    failures+=("rust")
  fi
  ensure_modern_go || failures+=("go")

  if [[ -n "$system_gap" ]]; then
    if [[ ${#failures[@]} -gt 0 ]]; then
      step_end partial "${system_gap}; could not install: ${failures[*]}"
    else
      step_end partial "$system_gap"
    fi
  elif [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would install missing system packages"
  elif [[ ${#failures[@]} -eq 0 && ${#unavailable[@]} -eq 0 ]]; then
    step_end ok "system packages installed"
  else
    local note="installed"
    if [[ ${#failures[@]} -gt 0 ]]; then
      # Composer failure here is fine — the composer step has a phar fallback.
      warn "could not install: ${failures[*]} (Posse degrades gracefully; related helpers are disabled until installed)"
      note="installed with gaps: ${failures[*]}"
    fi
    if [[ ${#unavailable[@]} -gt 0 ]]; then
      note+="; optional, not in this host's repositories: ${unavailable[*]} (see warnings)"
    fi
    step_end partial "$note"
  fi
}

step_node() {
  step_begin node
  # Slim images can have curl but lack CA roots, tar/xz, or git.
  ensure_core_packages
  local major
  if command -v node >/dev/null 2>&1; then
    major="$(node_major)"
    if [[ "$major" -ge "$NODE_MIN_MAJOR" ]] && npm --version >/dev/null 2>&1; then
      NODE_BIN="$(command -v node)"
      step_end ok "node $(node -v) at ${NODE_BIN}"
      return 0
    fi
    if [[ "$major" -ge "$NODE_MIN_MAJOR" ]]; then
      info "found node $(node -v) at $(command -v node), but npm does not run"
    else
      info "found node $(node -v), but ${NODE_MIN_MAJOR}+ is required"
    fi
  else
    info "node is not installed"
  fi

  if [[ "$INSTALL_NODE" != "true" ]]; then
    step_fail_critical "Node ${NODE_MIN_MAJOR}+ required (--no-install-node was passed). Install it and re-run."
    return 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would install Node ${NODE_MIN_MAJOR} via nvm ${NVM_VERSION}"
    return 0
  fi

  # Do not let nvm mutate profiles (or choke on npm prefix settings). The shim
  # and atlas.env below expose the selected runtime even in non-login shells.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -n "${NPM_CONFIG_PREFIX:-}${npm_config_prefix:-}" ]]; then
    warn "ignoring npm prefix override while selecting the installer Node runtime"
    unset NPM_CONFIG_PREFIX npm_config_prefix
  fi
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    local nvm_installer
    nvm_installer="$(mktemp)"
    if ! run_logged "download nvm ${NVM_VERSION}" fetch_to "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" "$nvm_installer"; then
      rm -f "$nvm_installer"
      step_fail_critical "could not download nvm; install Node ${NODE_MIN_MAJOR}+ manually and re-run"
      return 1
    fi
    if ! run_logged "verify nvm installer checksum" verify_sha256 "$nvm_installer" "$NVM_INSTALL_SHA256"; then
      rm -f "$nvm_installer"
      step_fail_critical "nvm installer did not match its pinned SHA-256; refusing to run it. Install Node ${NODE_MIN_MAJOR}+ manually or update this installer"
      return 1
    fi
    if ! run_logged "install nvm into ${NVM_DIR}" env PROFILE=/dev/null bash "$nvm_installer"; then
      rm -f "$nvm_installer"
      step_fail_critical "nvm install failed; see log"
      return 1
    fi
    rm -f "$nvm_installer"
  fi

  if ! run_logged "install Node ${NODE_MIN_MAJOR} (nvm install ${NODE_MIN_MAJOR})" bash -c "export NVM_DIR=$(shell_quote "$NVM_DIR"); set +u; . \"\$NVM_DIR/nvm.sh\"; nvm install -b ${NODE_MIN_MAJOR} && nvm alias default ${NODE_MIN_MAJOR}"; then
    step_fail_critical "Node ${NODE_MIN_MAJOR} install via nvm failed; see log"
    return 1
  fi

  # Adopt the freshly installed node in THIS shell.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use --silent --delete-prefix "$NODE_MIN_MAJOR" >/dev/null 2>&1
  set -u

  if command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]] && npm --version >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    step_end ok "node $(node -v) installed via nvm at ${NODE_BIN}"
  else
    step_fail_critical "node still not usable after nvm install; open a new shell and re-run, or install Node ${NODE_MIN_MAJOR}+ manually"
    return 1
  fi
}

step_checkout() {
  step_begin checkout
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi

  if [[ -z "$POSSE_DIR" ]]; then
    local detected
    detected="$(detect_installer_posse_dir || true)"
    if [[ -n "$detected" ]] && { [[ "$DRY_RUN" == "true" ]] || directory_writable "$detected"; }; then
      POSSE_DIR="$detected"
      info "using the Posse checkout containing this installer"
    else
      POSSE_DIR="${INSTALL_ROOT}/posse-client"
    fi
  fi
  POSSE_DIR="$(resolve_full_path "$POSSE_DIR")"

  if [[ -e "$POSSE_DIR" ]]; then
    local resolved_root
    resolved_root="$(resolve_posse_root_from_checkout "$POSSE_DIR" || true)"
    if [[ -n "$resolved_root" ]]; then
      POSSE_DIR="$resolved_root"
      if [[ "$DRY_RUN" != "true" ]] && ! directory_writable "$POSSE_DIR"; then
        step_fail_critical "checkout is not writable: ${POSSE_DIR}; use a user-owned --posse-dir (read-only container mounts cannot hold npm/runtime state)"
        return 1
      fi
      step_end ok "existing writable checkout: ${POSSE_DIR}"
    else
      step_fail_critical "${POSSE_DIR} exists but has no orchestrator.js at its root or under posse/"
      return 1
    fi
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    step_fail_critical "git is required to clone Posse but is not installed"
    return 1
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would shallow-clone ${POSSE_REPO_URL} into ${POSSE_DIR} and auto-detect the Posse root"
    return 0
  fi
  local clone_dir cloned_root nested="false"
  mkdir -p "$(dirname "$POSSE_DIR")" || { step_fail_critical "cannot create checkout parent"; return 1; }
  clone_dir="$(mktemp -d "${POSSE_DIR}.installing-XXXXXX")" || { step_fail_critical "cannot stage checkout"; return 1; }
  if run_logged "clone ${POSSE_REPO_URL}" env GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$POSSE_REPO_URL" "$clone_dir"; then
    cloned_root="$(resolve_posse_root_from_checkout "$clone_dir" || true)"
    if [[ -n "$cloned_root" ]]; then
      [[ "$cloned_root" == "$clone_dir/posse" ]] && nested="true"
      if [[ ! -e "$POSSE_DIR" ]] && mv -T "$clone_dir" "$POSSE_DIR"; then
        [[ "$nested" == "true" ]] && POSSE_DIR="$POSSE_DIR/posse"
        step_end ok "cloned into ${POSSE_DIR}"
        return 0
      fi
    fi
  fi
  rm -rf -- "$clone_dir"
  step_fail_critical "checkout failed; destination preserved and temporary clone removed; see log"
  return 1
}

do_install_composer_phar() {
  # Runs in a run_logged subshell: stdout/err go to the log.
  local bin_dir="$POSSE_DIR/scip/bin"
  local phar="$bin_dir/composer.phar"
  local setup expected actual
  mkdir -p "$bin_dir" || return 1
  setup="$(mktemp)" || return 1
  expected="$(fetch_stdout "https://composer.github.io/installer.sig")" || { rm -f "$setup"; return 1; }
  expected="$(printf "%s" "$expected" | tr -d '[:space:]')"
  fetch_to "https://getcomposer.org/installer" "$setup" || { rm -f "$setup"; return 1; }
  actual="$(php -r 'echo hash_file("sha384", $argv[1]);' -- "$setup")" || { rm -f "$setup"; return 1; }
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    echo "composer installer signature mismatch (expected ${expected:0:16}…, got ${actual:0:16}…)"
    rm -f "$setup"
    return 1
  fi
  php "$setup" --install-dir="$bin_dir" --filename=composer.phar --quiet
  local rc=$?
  rm -f "$setup"
  [[ $rc -eq 0 && -f "$phar" ]]
}

# Which scip-php environment `posse doctor` installs for the PHP on PATH:
# PHP 8.3+ gets current upstream scip-php (scip/php), PHP 8.1/8.2 (Debian 12,
# Ubuntu 22.04) the pinned v0.0.2 track (scip/php-legacy). Mirrors
# selectPhpScipTrack in lib/domains/environments/functions/php-scip-tracks.js.
scip_php_track_note() {
  local version
  version="$(php -r 'echo PHP_VERSION;' 2>/dev/null)" || return 1
  [[ -n "$version" ]] || return 1
  if php -r 'exit(version_compare(PHP_VERSION, "8.3.0", ">=") ? 0 : 1);' >/dev/null 2>&1; then
    printf 'scip-php track: modern, current upstream (PHP %s)' "$version"
  elif php -r 'exit(version_compare(PHP_VERSION, "8.1.0", ">=") ? 0 : 1);' >/dev/null 2>&1; then
    printf 'scip-php track: legacy v0.0.2 (PHP %s < 8.3)' "$version"
  else
    printf 'scip-php unsupported: PHP %s is older than 8.1' "$version"
  fi
}

step_composer() {
  step_begin composer
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if ! scip_language_selected php; then
    step_end skipped "PHP SCIP not selected"
    return 0
  fi
  local track_note=""
  if command -v php >/dev/null 2>&1; then
    track_note="$(scip_php_track_note)" || track_note=""
    if [[ "$track_note" == "scip-php unsupported"* ]]; then
      warn "${track_note}; SCIP PHP indexing stays disabled until PHP 8.1+ is installed"
    elif [[ -n "$track_note" ]]; then
      info "$track_note"
    fi
  fi
  local suffix="${track_note:+; $track_note}"
  if command -v composer >/dev/null 2>&1; then
    step_end ok "composer on PATH${suffix}"
    return 0
  fi
  if [[ -f "$POSSE_DIR/scip/bin/composer.phar" ]]; then
    step_end ok "composer.phar already present in scip/bin${suffix}"
    return 0
  fi
  if ! command -v php >/dev/null 2>&1; then
    warn "PHP is not installed, so Composer was skipped — SCIP PHP indexing stays disabled until both exist"
    step_end skipped "php not available"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would download signature-verified composer.phar into scip/bin${suffix}"
    return 0
  fi
  if run_logged "download verified composer.phar" do_install_composer_phar; then
    step_end ok "composer.phar installed into scip/bin${suffix}"
  else
    warn "Composer could not be installed (package + phar both failed); SCIP PHP dependency installs will be skipped"
    step_end partial "composer unavailable"
  fi
}

deps_fresh() {
  local dir="$1"
  [[ -d "$dir/node_modules" ]] || return 1
  [[ -f "$dir/node_modules/.package-lock.json" ]] || return 1
  [[ "$dir/package.json" -nt "$dir/node_modules/.package-lock.json" ]] && return 1
  # Timestamps alone cannot detect copied Linux/Windows modules or a changed
  # Node ABI. Exercise SQLite before deciding a previous install is usable.
  (cd "$dir" && "$NODE_BIN" --input-type=commonjs -e 'const D = require("better-sqlite3"); const db = new D(":memory:"); db.close();') >/dev/null 2>&1
}

step_npm() {
  step_begin npm
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi

  if [[ "$FORCE_REINSTALL" != "true" ]] && deps_fresh "$POSSE_DIR"; then
    step_end skipped "node_modules is fresh (pass --force to reinstall)"
    return 0
  fi
  local npm_args=()
  npm_install_command "$POSSE_DIR"
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run npm ${npm_args[*]} in ${POSSE_DIR}"
    return 0
  fi

  if run_logged_in_dir "$POSSE_DIR" "npm ${npm_args[0]}" npm "${npm_args[@]}"; then
    finish_node_install
    return $?
  fi

  info "retrying once (transient network/registry failures are common)"
  if run_logged_in_dir "$POSSE_DIR" "npm ${npm_args[0]} (retry)" npm "${npm_args[@]}"; then
    finish_node_install
    return $?
  fi

  step_fail_critical "npm ${npm_args[0]} failed twice — the log usually names the missing system dependency (see above)"
  return 1
}

# Sets npm_args for the checkout. Its lockfile pins every version: `npm ci`
# installs exactly that into a fresh tree; an existing tree is updated in place
# (ci deletes node_modules first, under a running Posse). Neither writes the
# lockfile, so `posse update` never finds it modified. Older checkouts without
# a lockfile keep a plain npm install.
npm_install_command() {
  # Scripts are off: npm installing from a lockfile misses better-sqlite3's
  # "gypfile": false and compiles it from source (needing Python and a C++
  # toolchain, which install later); its bundled prebuilt addon needs no
  # build. finish_node_install runs the install scripts of the packages that
  # really have them.
  local dir="$1" common=(--include=dev --include=optional --ignore-scripts --no-fund --no-audit)
  if [[ ! -f "$dir/package-lock.json" ]]; then
    npm_args=(install "${common[@]}")
  elif [[ ! -d "$dir/node_modules" ]]; then
    npm_args=(ci "${common[@]}")
  else
    npm_args=(install --no-save --prefer-offline "${common[@]}")
  fi
}

finish_node_install() {
  if run_logged_in_dir "$POSSE_DIR" "verify and repair Node native addons" \
    env POSSE_MAINTENANCE_ADOPT_NODE=1 POSSE_MAINTENANCE_INSTALL_SCRIPTS=1 "$NODE_BIN" lib/domains/cli/functions/maintenance-node-repair.js; then
    step_end ok "npm dependencies and SQLite runtime verified"
    return 0
  fi
  step_fail_critical "Node dependencies remain unusable after repair; check the build toolchain and log"
  return 1
}

step_automation() {
  step_begin automation
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would install the per-user Posse automation service"
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    step_end skipped "no active systemd user manager; automation still starts on first use"
    return 0
  fi
  if run_logged_in_dir "$POSSE_DIR" "install supervised automation owner" \
    "$NODE_BIN" orchestrator.js automation service install; then
    step_end ok "automation owner enabled for login/reboot startup"
    return 0
  fi
  warn "could not enable the automation owner; run 'posse automation service install' after installation"
  step_end partial "automation starts on first use but scheduled work needs the user service"
}

step_shell_wiring() {
  step_begin shell
  ENV_DIR="${HOME}/.config/posse"
  ENV_FILE="${ENV_DIR}/atlas.env"
  local bin_dir="${HOME}/.local/bin"
  local shim="${bin_dir}/posse"

  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would write ${ENV_FILE}, install ${shim}, and wire shell rc files"
    return 0
  fi

  if ! mkdir -p "$ENV_DIR"; then
    step_fail_critical "could not create ${ENV_DIR}"
    return 1
  fi
  if ! {
    echo "# Posse PATH wiring -- generated by ${INSTALLER_NAME}.sh"
    echo "# ATLAS runtime configuration lives in ~/.posse/account.db (posse admin),"
    echo "# not environment variables."
    printf 'export POSSE_BIN_DIR=%s\n' "$(shell_quote "$bin_dir")"
    printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$(dirname "$NODE_BIN")")"
    if [[ -d "$HOME/.cargo/bin" ]]; then
      printf 'export PATH="$PATH":%s\n' "$(shell_quote "$HOME/.cargo/bin")"
    fi
    # Ahead of any older distro Go.
    if [[ -x "$GO_RUNTIME_DIR/bin/go" ]]; then
      printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$GO_RUNTIME_DIR/bin")"
    fi
    # shellcheck disable=SC2016
    echo 'case ":$PATH:" in *":$POSSE_BIN_DIR:"*) ;; *) export PATH="$POSSE_BIN_DIR:$PATH";; esac'
  } >"$ENV_FILE"; then
    step_fail_critical "could not write ${ENV_FILE}"
    return 1
  fi

  if ! mkdir -p "$bin_dir"; then
    step_fail_critical "could not create ${bin_dir}"
    return 1
  fi
  if ! {
    printf '#!/usr/bin/env bash\n'
    printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$(dirname "$NODE_BIN")")"
    printf 'exec %s %s "$@"\n' "$(shell_quote "$NODE_BIN")" "$(shell_quote "$POSSE_DIR/orchestrator.js")"
  } >"$shim"
  then
    step_fail_critical "could not write ${shim}"
    return 1
  fi
  if ! chmod 755 "$shim"; then
    step_fail_critical "could not make ${shim} executable"
    return 1
  fi

  if [[ "$PERSIST_ENV" == "true" ]]; then
    if ! append_source_if_missing "${HOME}/.bashrc" "$ENV_FILE"; then
      warn "could not update ${HOME}/.bashrc; use ${shim} or source ${ENV_FILE}"
    fi
    if [[ -f "${HOME}/.zshrc" ]] && ! append_source_if_missing "${HOME}/.zshrc" "$ENV_FILE"; then
      warn "could not update ${HOME}/.zshrc; use ${shim} or source ${ENV_FILE}"
    fi
  fi

  local note="env file + posse shim installed"
  if ! command -v posse >/dev/null 2>&1; then
    note+=" (open a new shell to pick up PATH)"
  fi
  step_end ok "$note"
}

append_source_if_missing() {
  local rc_file="$1" env_file="$2" line
  line="source $(shell_quote "$env_file")"
  [[ -f "$rc_file" ]] || touch "$rc_file" || return 1
  if ! grep -F "$line" "$rc_file" >/dev/null 2>&1; then
    printf "\n# Posse ATLAS integration\n%s\n" "$line" >>"$rc_file" || return 1
    info "updated ${rc_file}"
  fi
}

SEED_JS='
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const settingsPath = process.env.POSSE_ACCOUNT_DB_PATH
  ? path.resolve(process.env.POSSE_ACCOUNT_DB_PATH)
  : path.join(os.homedir(), ".posse", "account.db");
const seed = {
  atlas_phases: process.env.POSSE_SEED_PHASES,
  atlas_live_funnel: process.env.POSSE_SEED_FUNNEL,
  atlas_scip_mode: process.env.POSSE_SEED_SCIP_MODE,
  atlas_scip_languages: process.env.POSSE_SEED_SCIP_LANGUAGES,
};
// Keys named in POSSE_SEED_REPLACE (a language choice the user just made)
// overwrite a saved value; every other key only fills a missing one.
const replace = new Set(String(process.env.POSSE_SEED_REPLACE || "").split(",").map((key) => key.trim()).filter(Boolean));
let added = 0, kept = 0, skipped = 0, replaced = 0;
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const db = new Database(settingsPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS account_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '"'"''"'"',
    updated_at TEXT NOT NULL DEFAULT (strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"'))
  );
`);
const get = db.prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`);
const upsert = db.prepare(`
  INSERT INTO account_settings (setting_key, setting_value, updated_at)
  VALUES (?, ?, strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"'))
  ON CONFLICT(setting_key) DO UPDATE
    SET setting_value = excluded.setting_value,
        updated_at = strftime('"'"'%Y-%m-%dT%H:%M:%fZ'"'"','"'"'now'"'"')
`);
const tx = db.transaction((entries) => {
  for (const [k, v] of entries) {
    if (v == null || String(v).trim() === "") { skipped++; continue; }
    const current = get.get(k);
    if (!current || current.setting_value == null || String(current.setting_value).trim() === "") {
      upsert.run(k, String(v));
      added++;
    } else if (replace.has(k) && String(current.setting_value) !== String(v)) {
      upsert.run(k, String(v));
      replaced++;
    } else {
      kept++;
    }
  }
});
tx(Object.entries(seed));
db.close();
console.log(`[seed-settings] wrote ${settingsPath} -- added ${added}, replaced ${replaced}, kept ${kept} existing, skipped ${skipped} empty`);
'

step_seed_settings() {
  step_begin seed
  if [[ "$SEED_SETTINGS" != "true" ]]; then step_end skipped "--skip-settings"; return 0; fi
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would seed missing ATLAS keys into ~/.posse/account.db (merge-only)"
    return 0
  fi
  # The seed file must live inside the Posse tree: Node resolves require()
  # from the script's own directory, and better-sqlite3 lives in
  # $POSSE_DIR/node_modules. The .cjs extension keeps it CommonJS despite the
  # repo's "type": "module"; .posse/ is gitignored so a crash can't leave
  # untracked litter.
  local seed_file="$POSSE_DIR/.posse/install-seed.tmp.cjs"
  if ! mkdir -p "$POSSE_DIR/.posse" || ! printf "%s" "$SEED_JS" >"$seed_file"; then
    step_end failed "could not write settings seed file"
    return 1
  fi
  export POSSE_SEED_MODE="$POSSE_MODE" POSSE_SEED_PHASES="$POSSE_PHASES" \
    POSSE_SEED_FUNNEL="$POSSE_LIVE_FUNNEL" POSSE_SEED_SCIP_MODE="$POSSE_SCIP_MODE" \
    POSSE_SEED_SCIP_LANGUAGES="$POSSE_SCIP_LANGUAGES"
  if [[ "$SCIP_LANGUAGES_CHOSEN" == "true" ]]; then export POSSE_SEED_REPLACE="atlas_scip_languages"; else export POSSE_SEED_REPLACE=""; fi
  if run_logged_in_dir "$POSSE_DIR" "seed ~/.posse/account.db (missing values filled; a language choice replaces the saved one)" "$NODE_BIN" "$seed_file"; then
    step_end ok "account settings seeded"
  else
    warn "settings seed failed; run 'posse admin' to configure ATLAS settings manually"
    step_end failed "seed script failed; see log"
  fi
  rm -f "$seed_file"
  unset POSSE_SEED_MODE POSSE_SEED_PHASES POSSE_SEED_FUNNEL POSSE_SEED_SCIP_MODE POSSE_SEED_SCIP_LANGUAGES POSSE_SEED_REPLACE
}

step_doctor() {
  step_begin doctor
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run 'posse doctor' (SCIP + current native binaries + Jina)"
    return 0
  fi
  info "delegating to Posse's own dependency engine (SCIP indexer environments)"
  local rc=0
  run_logged_in_dir_timeout "$DOCTOR_TIMEOUT_SECONDS" "$POSSE_DIR" "posse doctor (first run builds SCIP envs and deploys Jina)" \
    "$NODE_BIN" orchestrator.js doctor --adopt-node-install || rc=$?
  if [[ $rc -eq 0 ]]; then
    step_end ok "runtime dependencies, binaries, and Jina ready"
    return 0
  fi
  if [[ $rc -eq 124 ]]; then
    warn "posse doctor did not finish in time — run 'posse doctor' to complete it (log has details)"
    step_end failed "posse doctor timed out after $((DOCTOR_TIMEOUT_SECONDS / 60)) min"
    return 0
  fi

  # Most first-run failures are downloads, so try once more. The retry reports
  # as JSON, which says exactly what is still missing.
  info "retrying posse doctor once"
  local report labels=() label others=0
  report="$(mktemp)"
  rc=0
  run_logged_in_dir_timeout "$DOCTOR_TIMEOUT_SECONDS" "$POSSE_DIR" "posse doctor (retry)" \
    stdout_to_file "$report" "$NODE_BIN" orchestrator.js doctor --adopt-node-install --json || rc=$?
  cat "$report" >>"$LOG_FILE"
  if [[ $rc -eq 0 ]]; then
    rm -f "$report"
    step_end ok "runtime dependencies, binaries, and Jina ready (second attempt)"
    return 0
  fi
  mapfile -t labels < <(doctor_failed_labels "$report" 2>/dev/null)
  rm -f "$report"
  for label in "${labels[@]}"; do [[ "$label" == "model "* ]] || others=$((others + 1)); done
  # Without the search model Posse still runs, with lexical search only; only
  # doctor (or posse update) downloads it later, so say so.
  if [[ $rc -ne 124 && ${#labels[@]} -gt 0 && $others -eq 0 ]]; then
    warn "the code search model did not download; semantic search stays off until 'posse doctor' completes it"
    step_end partial "search model not downloaded; run 'posse doctor' later to add semantic search"
    return 0
  fi
  local what="see log"
  if [[ ${#labels[@]} -gt 0 ]]; then
    what="$(printf '%s, ' "${labels[@]:0:4}")"
    what="${what%, }"
  fi
  warn "posse doctor reported unresolved dependencies — run 'posse doctor' after fixing the tools it names (log has details)"
  step_end failed "still unresolved after a retry: ${what}"
}

# run_logged captures a command's output into the log; this keeps stdout
# (a JSON report) apart in a file of its own.
stdout_to_file() { local file="$1"; shift; "$@" >"$file"; }

# Prints the labels `posse doctor --json` reports as failed ("model jina",
# "scip python", ...), one per line; fails when the file holds no report.
doctor_failed_labels() {
  "$NODE_BIN" -e '
const text = require("fs").readFileSync(process.argv[1], "utf8");
const match = /^\{\r?\n\s*"ok":[\s\S]*?^\}/m.exec(text);
if (!match) process.exit(2);
let report;
try { report = JSON.parse(match[0]); } catch { process.exit(2); }
const failed = report.doctor && Array.isArray(report.doctor.failed) ? report.doctor.failed : [];
for (const entry of failed) console.log(String(entry.label || entry.language || "dependency"));
' "$1"
}

step_admin_init() {
  step_begin admin
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run posse admin init --non-interactive --provider-clis-only"
    return 0
  fi
  if run_logged_in_dir "$POSSE_DIR" "detect provider CLIs (admin init)" "$NODE_BIN" orchestrator.js admin init --non-interactive --provider-clis-only; then
    step_end ok "provider CLI detection complete"
  else
    warn "posse admin init failed — run 'posse admin init' manually to see provider CLI detection details"
    step_end failed "admin init failed; see log"
  fi
}

step_validate() {
  step_begin validate
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run posse status"
    return 0
  fi
  # The step engine's timeout kills the whole process tree; coreutils
  # `timeout` would signal only the direct node child.
  if run_logged_in_dir_timeout 300 "$POSSE_DIR" "boot posse (posse status)" "$NODE_BIN" orchestrator.js status; then
    step_end ok "posse boots cleanly"
  else
    warn "posse failed to boot — run 'posse status' in ${POSSE_DIR} to see the error"
    step_end failed "status returned non-zero; see log"
  fi
}

# --- provider keys (interactive; no spinner) ------------------------------------
CONFIGURED_KEYS=()
PROVIDER_KEY_NAMES=(POSSE_KEY ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY CODEX_API_KEY)
# Keys the parent shell/container already carried, snapshotted before the
# saved .env is imported: those are never prompted for, even with
# --configure-keys (parity with the Windows installer).
declare -A PARENT_ENV_KEYS=()

snapshot_parent_env_keys() {
  local name
  for name in "${PROVIDER_KEY_NAMES[@]}"; do
    [[ -n "${!name:-}" ]] && PARENT_ENV_KEYS[$name]=1
  done
  return 0
}

# Explicit reconfiguration can replace stored values; Enter keeps them.
configure_keys_interactively() {
  local name previous
  for name in "${PROVIDER_KEY_NAMES[@]}"; do
    if [[ -n "${PARENT_ENV_KEYS[$name]:-}" ]]; then
      info "$name already set in this shell — keeping it (unset it to be prompted)"
      continue
    fi
    previous="${!name:-}"
    unset "$name"
    if ! prompt_for_key "$name (Enter keeps an existing key)" "$name"; then
      [[ -z "$previous" ]] || export "$name=$previous"
    fi
  done
}

# Pasted keys often carry a trailing newline/CR or surrounding spaces; strip
# them. Interior whitespace is never part of a key, so refuse it instead of
# saving a value that fails later as "invalid posse_key".
normalize_key_input() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == *[[:space:]]* ]]; then
    return 1
  fi
  printf '%s' "$value"
}

prompt_for_key() {
  local label="$1" var_name="$2"
  local existing="${!var_name:-}"
  if [[ -n "$existing" ]]; then
    info "$var_name already set — skipping"
    return 1
  fi
  local input=""
  read -r -s -p "      Enter $label (press Enter to skip): " input </dev/tty
  echo >/dev/tty
  if ! input="$(normalize_key_input "$input")"; then
    warn "$label contained interior whitespace and was not saved; re-run with --configure-keys to try again"
    return 1
  fi
  if [[ -z "$input" ]]; then
    info "skipped $label"
    return 1
  fi
  export "$var_name"="$input"
  CONFIGURED_KEYS+=("$var_name")
  return 0
}

load_saved_keys() {
  local entry name
  local reader="$POSSE_DIR/installers/installer-env.mjs"
  # Validate separately so a process-substitution failure cannot look successful.
  "$NODE_BIN" "$reader" read-json >/dev/null || return 1
  while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    [[ -n "${!name:-}" ]] || export "${entry?}"
  done < <("$NODE_BIN" "$reader" read-null)
}

step_keys() {
  step_begin keys
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would load private .env and prompt for a missing Posse key when interactive"
    return 0
  fi
  # An existing checkout is reused as-is, so a newer installer can meet an
  # older tree that lacks the credential bridge. Name the real cause.
  if [[ ! -f "$POSSE_DIR/installers/installer-env.mjs" ]]; then
    step_fail_critical "checkout ${POSSE_DIR} predates this installer (installers/installer-env.mjs is missing); update it with 'git pull' or 'posse update', then re-run"
    return 1
  fi
  snapshot_parent_env_keys
  if ! load_saved_keys; then
    step_fail_critical "cannot read ~/.config/posse/.env; check permissions"
    return 1
  fi
  local interactive="false"
  if [[ "$NON_INTERACTIVE" != "true" ]] && ( : </dev/tty ) 2>/dev/null; then interactive="true"; fi
  if [[ "$interactive" == "true" && ( "$CONFIGURE_KEYS" == "true" || -z "${POSSE_KEY:-}" ) ]]; then
    info "Posse key input is hidden; saved in ~/.config/posse/.env (chmod 600)"
    if [[ "$CONFIGURE_KEYS" == "true" ]]; then
      configure_keys_interactively
    else
      prompt_for_key "Posse key (POSSE_KEY)" POSSE_KEY || true
    fi
  elif [[ "$CONFIGURE_KEYS" == "true" ]]; then
    info "no interactive input; supply keys through the container/process environment"
  fi
  if [[ ${#CONFIGURED_KEYS[@]} -gt 0 ]]; then
    if ! "$NODE_BIN" "$POSSE_DIR/installers/installer-env.mjs" save "${CONFIGURED_KEYS[@]}"; then
      step_fail_critical "could not securely save ~/.config/posse/.env; key is only available in this process"
      return 1
    fi
    step_end ok "saved private ~/.config/posse/.env; future Posse launches load it automatically"
  elif [[ -n "${POSSE_KEY:-}" ]]; then
    step_end ok "Posse key available (environment values are not copied to disk)"
  else
    step_fail_critical "POSSE_KEY is required; re-run interactively to enter it, inject it into the environment, or use --setup-only for an image build"
    return 1
  fi
}

# The native binaries are setup's largest downloads and need only Node, the
# checkout's npm packages, and the Posse key. start_native_download runs them in
# the background as soon as npm finishes, while host tools and the rest of setup
# install; step_native_binaries collects the result before doctor, which uses
# them, and downloads in the foreground if the background run failed.
NATIVE_PID=""
NATIVE_OUT=""
NATIVE_STARTED=0
NATIVE_RC=""

start_native_download() {
  [[ "$CRITICAL_FAILED" == "true" || "$DRY_RUN" == "true" || "$SETUP_ONLY" == "true" || -n "$NATIVE_PID" ]] && return 0
  [[ -n "${POSSE_KEY:-}" ]] || return 0
  NATIVE_OUT="${LOG_DIR}/native-download-$(date +%Y%m%d-%H%M%S).log"
  (cd "$POSSE_DIR" && exec "$NODE_BIN" scripts/pull-native-artifacts.mjs) >"$NATIVE_OUT" 2>&1 </dev/null &
  NATIVE_PID=$!
  NATIVE_STARTED=$SECONDS
  log_only ">>> native binaries downloading in the background (pid ${NATIVE_PID})"
  info "native tools are downloading in the background while setup continues"
}

# collect_native_download [abandon] — waits for the background download within
# the command timeout and sets NATIVE_RC: its exit code, 124 on timeout, 130
# when abandoned (setup ended early), empty when none was started. Never call
# it in a subshell: only this shell can wait for its own job.
collect_native_download() {
  NATIVE_RC=""
  [[ -n "$NATIVE_PID" ]] || return 0
  local pid="$NATIVE_PID" rc=""
  NATIVE_PID=""
  if [[ "${1:-}" == "abandon" ]]; then
    kill_process_tree "$pid" TERM
    rc=130
  else
    while kill -0 "$pid" 2>/dev/null; do
      if (( SECONDS - NATIVE_STARTED >= COMMAND_TIMEOUT_SECONDS )); then
        kill_process_tree "$pid" TERM
        sleep 2
        kill_process_tree "$pid" KILL
        rc=124
        break
      fi
      sleep 1
    done
  fi
  if [[ -z "$rc" ]]; then
    rc=0
    wait "$pid" || rc=$?
  else
    wait "$pid" 2>/dev/null || true
  fi
  if [[ -f "$NATIVE_OUT" ]]; then
    sed 's/^/[native] /' "$NATIVE_OUT" >>"$LOG_FILE"
    rm -f "$NATIVE_OUT"
  fi
  log_only "[native] background download exited ${rc} after $((SECONDS - NATIVE_STARTED))s"
  NATIVE_RC="$rc"
}

step_native_binaries() {
  step_begin native
  if [[ "$CRITICAL_FAILED" == "true" ]]; then
    collect_native_download abandon
    step_end blocked
    return 1
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would download current native binaries for this platform (in the background, from right after npm)"
    return 0
  fi

  local background=""
  if [[ -n "$NATIVE_PID" ]]; then
    kill -0 "$NATIVE_PID" 2>/dev/null && info "waiting for the background native download to finish"
    collect_native_download
    background="$NATIVE_RC"
    if [[ "$background" == "0" ]]; then
      step_end ok "native binaries downloaded while setup ran"
      return 0
    fi
    info "the background native download did not finish; downloading in the foreground"
  fi

  if [[ -z "${POSSE_KEY:-}" ]]; then
    warn "native binaries need POSSE_KEY; set it or re-run with --configure-keys, then run 'npm run pull:native'"
    step_end partial "POSSE_KEY unavailable; boot readiness will retry the download"
    return 0
  fi

  # Binaries already current are only checked again, so one retry is cheap;
  # a timeout is not retried, and a failed background run counts as the first
  # attempt.
  local rc=0
  run_logged_in_dir "$POSSE_DIR" "download current native binaries" \
    "$NODE_BIN" scripts/pull-native-artifacts.mjs || rc=$?
  if [[ $rc -ne 0 && $rc -ne 124 && -z "$background" ]]; then
    info "retrying once (transient network failures are common)"
    rc=0
    run_logged_in_dir "$POSSE_DIR" "download current native binaries (retry)" \
      "$NODE_BIN" scripts/pull-native-artifacts.mjs || rc=$?
  fi
  if [[ $rc -eq 0 ]]; then
    step_end ok "native binaries downloaded or already current"
  else
    warn "native binary download failed; boot readiness will retry, or run 'npm run pull:native' in ${POSSE_DIR}"
    step_end partial "native binaries unavailable; see log"
  fi
}

step_smoke() {
  step_begin smoke
  if [[ "$RUN_SMOKE" != "true" ]]; then step_end skipped "--no-smoke"; return 0; fi
  if [[ -z "$REPO_PATH" ]]; then
    step_end skipped "no --repo-path provided"
    return 0
  fi
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run atlas-smoke on ${REPO_PATH}"
    return 0
  fi
  if run_logged_in_dir "$POSSE_DIR" "atlas-smoke ${REPO_ID:-$(basename "$REPO_PATH")} (query: ${SMOKE_QUERY})" \
    "$NODE_BIN" ./orchestrator.js atlas-smoke "$REPO_PATH" "$SMOKE_QUERY" "$SMOKE_PROVIDER"; then
    step_end ok "smoke test passed"
  else
    warn "atlas-smoke failed — run it manually: posse atlas-smoke $(format_command "$REPO_PATH" "$SMOKE_QUERY" "$SMOKE_PROVIDER")"
    step_end failed "smoke test failed; see log"
  fi
}

# --- soft preflight checks (warnings only) ---------------------------------------
check_provider_credentials() {
  local have=0 candidates=() saved_env="${HOME}/.config/posse/.env"
  command -v claude >/dev/null 2>&1 && { candidates+=("claude-cli"); have=1; }
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && { candidates+=("ANTHROPIC_API_KEY"); have=1; }
  [[ -n "${OPENAI_API_KEY:-}" ]] && { candidates+=("OPENAI_API_KEY"); have=1; }
  [[ -n "${XAI_API_KEY:-}" ]] && { candidates+=("XAI_API_KEY"); have=1; }
  { [[ -n "${CODEX_API_KEY:-}" || -f "${HOME}/.codex/auth.json" ]]; } && { candidates+=("codex"); have=1; }
  # Saved keys are loaded later by the keys step (it needs Node and the
  # checkout); preflight runs before that, so do not warn about their absence.
  if [[ -s "$saved_env" ]]; then
    info "saved credentials found in ${saved_env}; they load in the keys step"
    return 0
  fi
  if [[ "$have" -eq 0 ]]; then
    if [[ "$CONFIGURE_KEYS" == "true" ]]; then
      info "no provider credentials detected yet — the keys step below will prompt for them"
    else
      warn "no provider credentials detected (claude CLI / ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY / codex). Re-run with --configure-keys, or set one before dispatching jobs."
    fi
  else
    info "provider credentials detected: ${candidates[*]}"
  fi
  if [[ -z "${POSSE_KEY:-}" && "$CONFIGURE_KEYS" != "true" ]]; then
    warn "POSSE_KEY is not set — Posse remote prompt/tool catalog requests need it (--configure-keys can capture it)"
  fi
}

check_git_config() {
  command -v git >/dev/null 2>&1 || return 0
  git config --global user.name >/dev/null 2>&1 \
    || warn 'git user.name is not set globally (git config --global user.name "Your Name")'
  git config --global user.email >/dev/null 2>&1 \
    || warn 'git user.email is not set globally (git config --global user.email "you@example.com")'
}

linux_distribution_id() {
  local key value
  [[ -r /etc/os-release ]] || return 0
  while IFS='=' read -r key value; do
    if [[ "$key" == "ID" ]]; then
      value="${value#\"}"
      value="${value%\"}"
      printf '%s' "${value,,}"
      return 0
    fi
  done </etc/os-release
}

# The running glibc version (for example 2.36), or nothing when it is unknown.
glibc_version() {
  local text
  text="$(getconf GNU_LIBC_VERSION 2>/dev/null)" || text=""
  if [[ "$text" =~ ^glibc[[:space:]]+([0-9]+\.[0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  # `ldd (GNU libc) 2.34` / `ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35`
  text="$(ldd --version 2>/dev/null)" || text=""
  text="${text%%$'\n'*}"
  if [[ "$text" =~ (GLIBC|GNU[[:space:]]libc).*[[:space:]]([0-9]+\.[0-9]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  fi
}

glibc_version_ok() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+) ]] || return 1
  local major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]}))
  ((major > GLIBC_MIN_MAJOR || (major == GLIBC_MIN_MAJOR && minor >= GLIBC_MIN_MINOR)))
}

step_preflight() {
  step_begin preflight
  if [[ "$(linux_distribution_id)" == "alpine" ]]; then
    step_fail_critical "Alpine Linux is not supported (its musl userspace is incompatible with the installer's Node/nvm path); use Debian, Ubuntu, Fedora, RHEL, Arch, or openSUSE"
    return 1
  fi
  local glibc
  glibc="$(glibc_version)"
  if [[ -z "$glibc" ]]; then
    warn "could not determine the glibc version; Posse's native binaries and SQLite need glibc ${GLIBC_MIN_MAJOR}.${GLIBC_MIN_MINOR}+ (${GLIBC_SUPPORTED_SYSTEMS})"
  elif ! glibc_version_ok "$glibc"; then
    step_fail_critical "glibc ${glibc} is too old: Posse's native binaries and its SQLite driver need glibc ${GLIBC_MIN_MAJOR}.${GLIBC_MIN_MINOR}+. Supported: ${GLIBC_SUPPORTED_SYSTEMS}"
    return 1
  fi
  if [[ -n "$REPO_PATH" ]]; then
    REPO_PATH="$(resolve_full_path "$REPO_PATH")"
    if [[ ! -d "$REPO_PATH" ]]; then
      CRITICAL_FAILED="true"
      step_end failed "repo path does not exist: ${REPO_PATH}"
      return 1
    fi
    [[ -z "$REPO_ID" ]] && REPO_ID="$(basename "$REPO_PATH")"
    info "smoke repo: ${REPO_PATH}"
  else
    info "no --repo-path provided; smoke test will be skipped"
  fi
  local notes=()
  if [[ "$DRY_RUN" != "true" ]]; then
    # Disk: node_modules, indexers, toolchains, and the search model need about
    # 3 GB (more with Rust); under 1 GB the install cannot finish.
    local free_kb free_gb
    free_kb="$(free_disk_kb "$HOME")"
    if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
      free_gb="$(awk -v kb="$free_kb" 'BEGIN { printf "%.1f", kb / 1048576 }')"
      if ((free_kb < 1048576)); then
        step_fail_critical "only ${free_gb} GB free for ${HOME}; Posse needs about 3 GB. Free some space, then re-run."
        return 1
      fi
      if ((free_kb < 3145728)); then
        warn "only ${free_gb} GB free for ${HOME}; a full install needs about 3 GB"
        notes+=("low disk space (${free_gb} GB free)")
      fi
    fi

    # Network: a blocked host is a warning, not a stop, because proxies can
    # make a probe fail where the real download works.
    local hosts=(github.com registry.npmjs.org api.yourposseai.com) unreachable=()
    if [[ "$INSTALL_NODE" == "true" ]] && { ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt "$NODE_MIN_MAJOR" ]]; }; then
      hosts+=(raw.githubusercontent.com)
    fi
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
      mapfile -t unreachable < <(unreachable_hosts "${hosts[@]}")
      if [[ ${#unreachable[@]} -gt 0 ]]; then
        warn "cannot reach ${unreachable[*]}; steps that download from there will fail"
        notes+=("cannot reach ${unreachable[*]}")
      fi
    else
      info "no curl or wget yet; network check skipped (the packages step installs curl)"
    fi
    local proxy="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
    [[ -n "$proxy" ]] && info "downloads go through the proxy $(redact_url_credentials "$proxy")"
  fi
  check_git_config
  [[ "$SETUP_ONLY" == "true" ]] || check_provider_credentials
  if [[ ${#notes[@]} -gt 0 ]]; then
    local joined
    joined="$(printf '%s; ' "${notes[@]}")"
    step_end partial "${joined%; }"
  else
    step_end ok "preflight complete"
  fi
  return 0
}

# Free kilobytes on the filesystem holding $1.
free_disk_kb() { df -Pk -- "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

# Hosts the installer downloads from that this machine cannot reach, one
# "host (why)" per line. Any HTTP answer counts as reachable.
unreachable_hosts() {
  local host rc
  for host in "$@"; do
    rc=0
    if command -v curl >/dev/null 2>&1; then
      curl -sS -o /dev/null --proto '=https' --connect-timeout 6 --max-time 10 -I "https://${host}/" 2>/dev/null || rc=$?
      case "$rc" in
        0) ;;
        5|6) printf '%s (name lookup failed)\n' "$host" ;;
        7) printf '%s (connection refused or blocked)\n' "$host" ;;
        28) printf '%s (timed out)\n' "$host" ;;
        35|51|58|60) printf '%s (TLS failed; a proxy may be inspecting traffic)\n' "$host" ;;
        *) printf '%s (curl exit %s)\n' "$host" "$rc" ;;
      esac
    else
      # wget exits 8 for an HTTP error answer, which still means reachable.
      wget -q --spider --https-only --timeout=8 --tries=1 "https://${host}/" >/dev/null 2>&1 || rc=$?
      [[ $rc -eq 0 || $rc -eq 8 ]] || printf '%s (wget exit %s)\n' "$host" "$rc"
    fi
  done
}

# A proxy URL can carry a password; never print it.
redact_url_credentials() { printf '%s' "$1" | sed -E 's#//[^/@]*@#//***@#'; }

run_installer_step() {
  local key="$1" critical="$2" fn="$3" rc
  if [[ "$SETUP_ONLY" == "true" ]]; then
    case "$key" in
      seed|admin|keys|native|doctor|validate|smoke)
        step_begin "$key"
        step_end skipped "--setup-only; complete setup at runtime"
        return 0 ;;
    esac
  fi
  "$fn"
  rc=$?
  if [[ $rc -ne 0 && "${STEP_STATUS[$key]}" == "pending" ]]; then
    CURRENT_STEP="$key"
    [[ "$critical" == "true" ]] && CRITICAL_FAILED="true"
    step_end failed "step returned ${rc} without a result"
  fi
  return 0
}

# =============================================================================
# main
# =============================================================================

# The whole run lives in main(), called on the final line. Piped from curl,
# bash executes nothing here until the complete file has arrived, so a
# truncated download cannot run half an install.
main() {
  NODE_BIN=""
  ENV_DIR="${HOME}/.config/posse"
  ENV_FILE="${ENV_DIR}/atlas.env"

  init_ui
  print_splash

  log_only "${INSTALLER_NAME} started $(date -Iseconds 2>/dev/null || date)"
  log_only "argv: $0 dry_run=${DRY_RUN} force=${FORCE_REINSTALL} host_tools=${INSTALL_HOST_TOOLS} install_node=${INSTALL_NODE}"

  if [[ "$DRY_RUN" == "true" ]]; then
    printf "  %s%sDRY RUN%s %s— no changes will be made%s\n" "$BOLD" "$YELLOW" "$R" "$DIM" "$R"
  fi
  printf "  %sLog: %s%s\n" "$DIM" "$LOG_FILE" "$R"

  if ! step_scip_languages; then
    block_pending_steps "language selection failed"
    print_summary
    exit 1
  fi

  if ! step_preflight; then
    block_pending_steps "preflight failed"
    print_summary
    exit 1
  fi

  run_installer_step node true step_node
  run_installer_step checkout true step_checkout
  run_installer_step keys false step_keys
  run_installer_step npm true step_npm
  start_native_download
  run_installer_step packages false step_packages
  run_installer_step composer false step_composer
  run_installer_step automation false step_automation
  run_installer_step shell true step_shell_wiring
  run_installer_step seed false step_seed_settings
  run_installer_step admin false step_admin_init
  run_installer_step native false step_native_binaries
  run_installer_step doctor false step_doctor
  run_installer_step validate false step_validate
  run_installer_step smoke false step_smoke

  # Setup that ended early must not leave a download running behind it.
  collect_native_download abandon
  print_summary
  if [[ "$INSTALL_FAILED" == "true" ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
