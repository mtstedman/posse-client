#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Posse + ATLAS Linux installer
#
# Bootstraps a host from scratch: system packages (build toolchain + helper
# CLIs), Node.js 24+ (via nvm when missing), the Posse checkout, npm deps,
# Python venv + SCIP language environments (delegated to `posse doctor`, the
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
INSTALL_NODE="true"
FORCE_REINSTALL="false"
DRY_RUN="false"
CONFIGURE_KEYS="false"
PLAIN="false"
INSTALL_ROOT="${HOME}/claude-tools"
POSSE_DIR=""
POSSE_REPO_URL="https://github.com/mtstedman/posse-client.git"
REPO_ID=""
REPO_PATH=""
NODE_MIN_MAJOR="24"
NVM_VERSION="v0.40.3"
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
  --skip-host-tools       Do not install system packages (build toolchain and
                          helper CLIs: rg, tesseract, ImageMagick, ffmpeg,
                          Python, and PHP only when PHP SCIP is selected).
                          Missing tools are still reported.
  --no-install-node       Do not auto-install Node via nvm when Node 24+ is missing
  --configure-keys        Interactively prompt for provider API keys (stored in
                          ~/.config/posse/providers.env, chmod 600)
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
  - Python helper deps and SCIP language environments are installed through
    `posse doctor` — the same self-repair engine Posse uses at boot — so the
    installer never fights Posse over how Python environments are managed.
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
    --no-install-node) INSTALL_NODE="false"; shift ;;
    --configure-keys) CONFIGURE_KEYS="true"; shift ;;
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
: >"$LOG_FILE" 2>/dev/null || LOG_FILE="/dev/null"

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

  if ! ( : </dev/tty ) 2>/dev/null; then
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
        idx=$((token - 1))
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
STEP_KEYS=(languages preflight packages node checkout composer npm shell seed admin keys native doctor validate smoke)
declare -A STEP_TITLES=(
  [languages]="SCIP language selection"
  [preflight]="Preflight checks"
  [packages]="System packages"
  [node]="Node.js runtime"
  [checkout]="Posse checkout"
  [composer]="Composer (SCIP PHP)"
  [npm]="npm dependencies"
  [shell]="Shell wiring"
  [seed]="Account settings"
  [doctor]="Runtime doctor (Python + SCIP + Jina)"
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
CRITICAL_FAILED="false"
INSTALL_FAILED="false"

step_begin() {
  local key="$1"
  CURRENT_STEP="$key"
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
  log_only "----- ${CURRENT_STEP}: ${status}${note:+ (${note})}"
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
  printf "\n  %sLog:%s %s\n" "$DIM" "$R" "$LOG_FILE"
  echo
  if [[ "$INSTALL_FAILED" == "true" ]]; then
    printf "  %s%sInstall did not complete.%s Fix the failed step above and re-run — completed steps are skipped on re-runs.\n\n" "$RED" "$BOLD" "$R"
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

resolve_full_path() {
  # readlink -f is universal on Linux (GNU coreutils / busybox).
  readlink -f -- "$1" 2>/dev/null || printf "%s" "$1"
}

fetch_to() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=3 -O "$dest" "$url"
  else return 127; fi
}

fetch_stdout() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 --connect-timeout 15 --max-time 300 "$url"
  elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=3 -O- "$url"
  else return 127; fi
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
    elif [[ $UI_TTY -eq 1 && "$DRY_RUN" != "true" ]]; then
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
    ok) sudo "$@" ;;
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
    apt-get) run_logged "refresh package index (apt-get update)" as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || true ;;
    pacman) run_logged "refresh package index (pacman -Sy)" as_root pacman -Sy --noconfirm || true ;;
  esac
}

pkg_install() {
  # Installs one or more packages; returns non-zero if the manager fails.
  case "$PKG_MGR" in
    apt-get) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) as_root dnf install -y -q "$@" ;;
    yum) as_root yum install -y -q "$@" ;;
    pacman) as_root pacman -S --needed --noconfirm "$@" ;;
    zypper) as_root zypper --non-interactive --quiet install "$@" ;;
    *) return 127 ;;
  esac
}

# Package names per manager. Toolchain packages are what native npm modules
# (node-pty, tree-sitter, better-sqlite3 fallback builds) need to compile, plus
# python3-venv/pip which Posse's managed Python runtimes require.
core_packages() {
  echo "git curl ca-certificates"
}
toolchain_packages() {
  case "$PKG_MGR" in
    apt-get) echo "build-essential pkg-config python3 python3-pip python3-venv unzip" ;;
    dnf|yum) echo "gcc gcc-c++ make pkgconf-pkg-config python3 python3-pip unzip" ;;
    pacman) echo "base-devel python python-pip unzip" ;;
    zypper) echo "gcc gcc-c++ make pkg-config python3 python3-pip unzip" ;;
  esac
}

# name|check-kind|packages(comma-separated candidates, tried in order)
host_tools_table() {
  case "$PKG_MGR" in
    apt-get)
      cat <<'EOT'
ripgrep|rg|ripgrep
tesseract|tesseract|tesseract-ocr
imagemagick|magick_or_convert|imagemagick
ffmpeg|ffmpeg|ffmpeg
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php-cli,php
composer|composer|composer
EOT
      fi
      ;;
    dnf|yum)
      cat <<'EOT'
ripgrep|rg|ripgrep
tesseract|tesseract|tesseract
imagemagick|magick_or_convert|ImageMagick
ffmpeg|ffmpeg|ffmpeg
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php-cli,php
composer|composer|composer,php-composer
EOT
      fi
      ;;
    pacman)
      cat <<'EOT'
ripgrep|rg|ripgrep
tesseract|tesseract|tesseract
imagemagick|magick_or_convert|imagemagick
ffmpeg|ffmpeg|ffmpeg
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php
composer|composer|composer
EOT
      fi
      ;;
    zypper)
      cat <<'EOT'
ripgrep|rg|ripgrep
tesseract|tesseract|tesseract-ocr
imagemagick|magick_or_convert|ImageMagick
ffmpeg|ffmpeg|ffmpeg
EOT
      if scip_language_selected php; then cat <<'EOT'
php|php|php8-cli,php-cli,php8,php7
composer|composer|php-composer,composer
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

# =============================================================================
# steps
# =============================================================================

step_packages() {
  step_begin packages
  detect_pkg_manager

  # What's missing? Core + toolchain checked by representative commands.
  local missing_core=() missing_toolchain="false" missing_tools=()
  command -v git >/dev/null 2>&1 || missing_core+=("git")
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || missing_core+=("curl")
  { command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; } && command -v make >/dev/null 2>&1 || missing_toolchain="true"
  find_python >/dev/null 2>&1 || missing_toolchain="true"
  # Debian/Ubuntu split venv out of python3 — Posse's managed venvs need it.
  if [[ "$PKG_MGR" == "apt-get" ]] && find_python >/dev/null 2>&1; then
    "$(find_python)" -m venv --help >/dev/null 2>&1 || missing_toolchain="true"
  fi

  local line name check pkgs
  while IFS='|' read -r name check pkgs; do
    [[ -z "$name" ]] && continue
    tool_available "$check" || missing_tools+=("${name}|${check}|${pkgs}")
  done < <(host_tools_table)

  if [[ ${#missing_core[@]} -eq 0 && "$missing_toolchain" == "false" && ${#missing_tools[@]} -eq 0 ]]; then
    step_end ok "git, curl, build toolchain, and helper CLIs all present"
    return 0
  fi

  if [[ "$INSTALL_HOST_TOOLS" != "true" ]]; then
    local names=()
    [[ ${#missing_core[@]} -gt 0 ]] && names+=("${missing_core[@]}")
    [[ "$missing_toolchain" == "true" ]] && names+=("build-toolchain")
    local t; for t in "${missing_tools[@]}"; do names+=("${t%%|*}"); done
    warn "missing (not installed due to --skip-host-tools): ${names[*]}"
    step_end skipped "--skip-host-tools; missing: ${names[*]}"
    return 0
  fi

  if [[ "$PKG_MGR" == "none" ]]; then
    warn "no supported package manager found (apt/dnf/yum/pacman/zypper); install missing packages manually"
    step_end partial "no package manager; some tools missing"
    return 0
  fi

  ensure_root_access
  if [[ "$SUDO_STATE" == "none" && "$DRY_RUN" != "true" ]]; then
    warn "cannot install system packages: not root and sudo unavailable/declined"
    step_end partial "no root access; packages not installed"
    return 0
  fi

  pkg_refresh_index
  local failures=()

  # Core (git/curl) and toolchain go in one shot each — these are standard
  # package names that exist everywhere; helper CLIs install per-package so a
  # missing name in one repo can't sink the rest.
  if [[ ${#missing_core[@]} -gt 0 ]]; then
    # shellcheck disable=SC2086
    run_logged "install core packages (${missing_core[*]})" pkg_install $(core_packages) || failures+=("core")
  fi
  if [[ "$missing_toolchain" == "true" ]]; then
    # shellcheck disable=SC2086
    run_logged "install build toolchain ($(toolchain_packages | cut -c1-48)…)" pkg_install $(toolchain_packages) || failures+=("toolchain")
  fi

  local entry pkg installed
  for entry in "${missing_tools[@]}"; do
    IFS='|' read -r name check pkgs <<<"$entry"
    installed="false"
    IFS=',' read -ra candidates <<<"$pkgs"
    for pkg in "${candidates[@]}"; do
      if run_logged "install ${name} (${pkg})" pkg_install "$pkg"; then
        installed="true"
        break
      fi
    done
    if [[ "$DRY_RUN" == "true" ]]; then continue; fi
    if [[ "$installed" != "true" ]] || ! tool_available "$check"; then
      failures+=("$name")
    fi
  done

  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would install missing system packages"
  elif [[ ${#failures[@]} -eq 0 ]]; then
    step_end ok "system packages installed"
  else
    # Composer failure here is fine — the composer step has a phar fallback.
    warn "could not install: ${failures[*]} (Posse degrades gracefully; related helpers are disabled until installed)"
    step_end partial "installed with gaps: ${failures[*]}"
  fi
}

step_node() {
  step_begin node
  local major
  if command -v node >/dev/null 2>&1; then
    major="$(node_major)"
    if [[ "$major" -ge "$NODE_MIN_MAJOR" ]]; then
      NODE_BIN="$(command -v node)"
      step_end ok "node $(node -v) at ${NODE_BIN}"
      return 0
    fi
    info "found node $(node -v), but ${NODE_MIN_MAJOR}+ is required"
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

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    local nvm_installer
    nvm_installer="$(mktemp)"
    if ! run_logged "download nvm ${NVM_VERSION}" fetch_to "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" "$nvm_installer"; then
      rm -f "$nvm_installer"
      step_fail_critical "could not download nvm; install Node ${NODE_MIN_MAJOR}+ manually and re-run"
      return 1
    fi
    if ! run_logged "install nvm into ${NVM_DIR}" bash "$nvm_installer"; then
      rm -f "$nvm_installer"
      step_fail_critical "nvm install failed; see log"
      return 1
    fi
    rm -f "$nvm_installer"
  fi

  if ! run_logged "install Node ${NODE_MIN_MAJOR} (nvm install ${NODE_MIN_MAJOR})" bash -c "export NVM_DIR=$(shell_quote "$NVM_DIR"); set +u; . \"\$NVM_DIR/nvm.sh\"; nvm install ${NODE_MIN_MAJOR} && nvm alias default ${NODE_MIN_MAJOR}"; then
    step_fail_critical "Node ${NODE_MIN_MAJOR} install via nvm failed; see log"
    return 1
  fi

  # Adopt the freshly installed node in THIS shell.
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use --silent "$NODE_MIN_MAJOR" >/dev/null 2>&1
  set -u

  if command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]]; then
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
    if [[ -n "$detected" ]]; then
      POSSE_DIR="$detected"
      info "using the Posse checkout containing this installer"
    else
      POSSE_DIR="${INSTALL_ROOT}/posse-client"
    fi
  fi
  POSSE_DIR="$(resolve_full_path "$POSSE_DIR")"

  if [[ -d "$POSSE_DIR" ]]; then
    local resolved_root
    resolved_root="$(resolve_posse_root_from_checkout "$POSSE_DIR" || true)"
    if [[ -n "$resolved_root" ]]; then
      POSSE_DIR="$resolved_root"
      step_end ok "existing checkout: ${POSSE_DIR}"
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
  mkdir -p "$(dirname "$POSSE_DIR")"
  if run_logged "clone ${POSSE_REPO_URL}" git clone --depth 1 "$POSSE_REPO_URL" "$POSSE_DIR"; then
    local cloned_root
    cloned_root="$(resolve_posse_root_from_checkout "$POSSE_DIR" || true)"
    if [[ -n "$cloned_root" ]]; then
      POSSE_DIR="$cloned_root"
      step_end ok "cloned into ${POSSE_DIR}"
    else
      step_fail_critical "clone succeeded but orchestrator.js is missing at the checkout root and under posse/"
      return 1
    fi
  else
    step_fail_critical "git clone failed; see log"
    return 1
  fi
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

step_composer() {
  step_begin composer
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if ! scip_language_selected php; then
    step_end skipped "PHP SCIP not selected"
    return 0
  fi
  if command -v composer >/dev/null 2>&1; then
    step_end ok "composer on PATH"
    return 0
  fi
  if [[ -f "$POSSE_DIR/scip/bin/composer.phar" ]]; then
    step_end ok "composer.phar already present in scip/bin"
    return 0
  fi
  if ! command -v php >/dev/null 2>&1; then
    warn "PHP is not installed, so Composer was skipped — SCIP PHP indexing stays disabled until both exist"
    step_end skipped "php not available"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would download signature-verified composer.phar into scip/bin"
    return 0
  fi
  if run_logged "download verified composer.phar" do_install_composer_phar; then
    step_end ok "composer.phar installed into scip/bin"
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
  return 0
}

step_npm() {
  step_begin npm
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi

  if [[ "$FORCE_REINSTALL" != "true" ]] && deps_fresh "$POSSE_DIR"; then
    step_end skipped "node_modules is fresh (pass --force to reinstall)"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run npm install --include=optional in ${POSSE_DIR}"
    return 0
  fi

  if run_logged_in_dir "$POSSE_DIR" "npm install (includes native module builds)" \
    npm install --include=optional --no-fund --no-audit; then
    step_end ok "npm dependencies installed"
    return 0
  fi

  info "retrying once (transient network/registry failures are common)"
  if run_logged_in_dir "$POSSE_DIR" "npm install (retry)" \
    npm install --include=optional --no-fund --no-audit; then
    step_end ok "npm dependencies installed on retry"
    return 0
  fi

  step_fail_critical "npm install failed twice — the log usually names the missing system dependency (see above)"
  return 1
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
  if ! cat >"$shim" <<EOF
#!/usr/bin/env bash
exec "$(printf "%s" "$NODE_BIN")" "$(printf "%s" "$POSSE_DIR")/orchestrator.js" "\$@"
EOF
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
      step_fail_critical "could not update ${HOME}/.bashrc"
      return 1
    fi
    if [[ -f "${HOME}/.zshrc" ]] && ! append_source_if_missing "${HOME}/.zshrc" "$ENV_FILE"; then
      step_fail_critical "could not update ${HOME}/.zshrc"
      return 1
    fi
  fi

  local note="env file + posse shim installed"
  if ! command -v posse >/dev/null 2>&1; then
    note+=" (open a new shell to pick up PATH)"
  fi
  step_end ok "$note"
}

append_source_if_missing() {
  local rc_file="$1" env_file="$2"
  local line="source $(shell_quote "$env_file")"
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
  atlas_mode: process.env.POSSE_SEED_MODE,
  atlas_phases: process.env.POSSE_SEED_PHASES,
  atlas_live_funnel: process.env.POSSE_SEED_FUNNEL,
  atlas_scip_mode: process.env.POSSE_SEED_SCIP_MODE,
  atlas_scip_languages: process.env.POSSE_SEED_SCIP_LANGUAGES,
};
let added = 0, kept = 0, skipped = 0;
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
    } else {
      kept++;
    }
  }
});
tx(Object.entries(seed));
db.close();
console.log(`[seed-settings] wrote ${settingsPath} -- added ${added}, kept ${kept} existing, skipped ${skipped} empty`);
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
  if run_logged_in_dir "$POSSE_DIR" "seed ~/.posse/account.db (merge-only, existing values kept)" "$NODE_BIN" "$seed_file"; then
    step_end ok "account settings seeded"
  else
    warn "settings seed failed; run 'posse admin' to configure ATLAS settings manually"
    step_end failed "seed script failed; see log"
  fi
  rm -f "$seed_file"
  unset POSSE_SEED_MODE POSSE_SEED_PHASES POSSE_SEED_FUNNEL POSSE_SEED_SCIP_MODE POSSE_SEED_SCIP_LANGUAGES
}

step_doctor() {
  step_begin doctor
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would run 'posse doctor' (Python + SCIP + current native binaries + Jina)"
    return 0
  fi
  info "delegating to Posse's own dependency engine (managed Python venv, SCIP indexer environments)"
  if run_logged_in_dir_timeout "$DOCTOR_TIMEOUT_SECONDS" "$POSSE_DIR" "posse doctor (first run builds Python/SCIP envs and deploys Jina)" \
    "$NODE_BIN" orchestrator.js doctor; then
    step_end ok "runtime dependencies, binaries, and Jina ready"
  else
    warn "posse doctor reported unresolved dependencies — run 'posse doctor' after fixing the tools it names (log has details)"
    step_end failed "runtime dependencies, native binaries, or Jina unresolved"
  fi
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
    step_end dry-run "would run node orchestrator.js status"
    return 0
  fi
  local -a cmd=("$NODE_BIN" orchestrator.js status)
  command -v timeout >/dev/null 2>&1 && cmd=(timeout 300 "${cmd[@]}")
  if run_logged_in_dir "$POSSE_DIR" "boot posse (orchestrator.js status)" "${cmd[@]}"; then
    step_end ok "posse boots cleanly"
  else
    warn "posse failed to boot — run 'posse status' in ${POSSE_DIR} to see the error"
    step_end failed "status returned non-zero; see log"
  fi
}

# --- provider keys (interactive; no spinner) ------------------------------------
CONFIGURED_KEYS=()

prompt_for_key() {
  local label="$1" var_name="$2"
  local existing="${!var_name:-}"
  if [[ -n "$existing" ]]; then
    info "$var_name already set (length ${#existing}) — skipping"
    return 1
  fi
  local input=""
  read -r -s -p "      Enter $label (press Enter to skip): " input </dev/tty
  echo >/dev/tty
  if [[ -z "$input" ]]; then
    info "skipped $label"
    return 1
  fi
  export "$var_name"="$input"
  CONFIGURED_KEYS+=("$var_name")
  return 0
}

step_keys() {
  step_begin keys
  local providers_file="${ENV_DIR:-$HOME/.config/posse}/providers.env"
  if [[ "$CONFIGURE_KEYS" != "true" ]]; then
    step_end skipped "pass --configure-keys to set provider API keys interactively"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would prompt for POSSE_KEY / OPENAI_API_KEY / XAI_API_KEY / CODEX_API_KEY"
    return 0
  fi
  if [[ $UI_TTY -ne 1 ]]; then
    warn "--configure-keys needs an interactive terminal; skipped"
    step_end skipped "no TTY"
    return 0
  fi

  if [[ -f "$providers_file" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$providers_file"; set +a
  fi

  info "input is hidden; press Enter to skip any key"
  prompt_for_key "Posse remote key" "POSSE_KEY" || true
  prompt_for_key "OpenAI API key" "OPENAI_API_KEY" || true
  prompt_for_key "xAI (Grok) key" "XAI_API_KEY" || true
  prompt_for_key "Codex API key (optional — skip if you prefer 'codex login')" "CODEX_API_KEY" || true

  local ans
  if command -v claude >/dev/null 2>&1; then
    read -r -p "      Run 'claude' now to log in to Claude? [y/N]: " ans </dev/tty
    [[ "$ans" =~ ^[Yy]$ ]] && { claude || warn "claude login command did not exit cleanly"; }
  fi
  if command -v codex >/dev/null 2>&1 && [[ -z "${CODEX_API_KEY:-}" ]]; then
    read -r -p "      Run 'codex login' now? [y/N]: " ans </dev/tty
    [[ "$ans" =~ ^[Yy]$ ]] && { codex login || warn "codex login command did not exit cleanly"; }
  fi

  if [[ ${#CONFIGURED_KEYS[@]} -eq 0 ]]; then
    step_end ok "no new keys captured"
    return 0
  fi

  mkdir -p "$(dirname "$providers_file")"
  local tmp_file k
  tmp_file="$(mktemp)"
  if [[ -f "$providers_file" ]]; then
    local filter_expr=""
    for k in "${CONFIGURED_KEYS[@]}"; do filter_expr+="/^export ${k}=/d;"; done
    sed "$filter_expr" "$providers_file" >"$tmp_file"
  else
    : >"$tmp_file"
  fi
  for k in "${CONFIGURED_KEYS[@]}"; do
    printf 'export %s=%q\n' "$k" "${!k}" >>"$tmp_file"
  done
  mv "$tmp_file" "$providers_file"
  chmod 600 "$providers_file"

  if [[ "$PERSIST_ENV" == "true" ]]; then
    append_source_if_missing "${HOME}/.bashrc" "$providers_file"
    [[ -f "${HOME}/.zshrc" ]] && append_source_if_missing "${HOME}/.zshrc" "$providers_file"
  fi
  step_end ok "wrote ${#CONFIGURED_KEYS[@]} key(s) to ${providers_file} (chmod 600)"
}

step_native_binaries() {
  step_begin native
  if [[ "$CRITICAL_FAILED" == "true" ]]; then step_end blocked; return 1; fi
  if [[ "$DRY_RUN" == "true" ]]; then
    step_end dry-run "would download current native binaries for this platform"
    return 0
  fi

  local providers_file="${ENV_DIR:-$HOME/.config/posse}/providers.env"
  if [[ -z "${POSSE_KEY:-}" && -f "$providers_file" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$providers_file"; set +a
  fi
  if [[ -z "${POSSE_KEY:-}" ]]; then
    warn "native binaries need POSSE_KEY; set it or re-run with --configure-keys, then run 'npm run pull:native'"
    step_end partial "POSSE_KEY unavailable; boot readiness will retry the download"
    return 0
  fi

  if run_logged_in_dir "$POSSE_DIR" "download current native binaries" \
    "$NODE_BIN" scripts/pull-native-artifacts.mjs; then
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
    warn "atlas-smoke failed — run it manually: node orchestrator.js atlas-smoke $(format_command "$REPO_PATH" "$SMOKE_QUERY" "$SMOKE_PROVIDER")"
    step_end failed "smoke test failed; see log"
  fi
}

# --- soft preflight checks (warnings only) ---------------------------------------
check_provider_credentials() {
  local have=0 candidates=()
  command -v claude >/dev/null 2>&1 && { candidates+=("claude-cli"); have=1; }
  [[ -n "${OPENAI_API_KEY:-}" ]] && { candidates+=("OPENAI_API_KEY"); have=1; }
  [[ -n "${XAI_API_KEY:-}" ]] && { candidates+=("XAI_API_KEY"); have=1; }
  { [[ -n "${CODEX_API_KEY:-}" || -f "${HOME}/.codex/auth.json" ]]; } && { candidates+=("codex"); have=1; }
  if [[ "$have" -eq 0 ]]; then
    if [[ "$CONFIGURE_KEYS" == "true" ]]; then
      info "no provider credentials detected yet — the keys step below will prompt for them"
    else
      warn "no provider credentials detected (claude CLI / OPENAI_API_KEY / XAI_API_KEY / codex). Re-run with --configure-keys, or set one before dispatching jobs."
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

step_preflight() {
  step_begin preflight
  if [[ "$(linux_distribution_id)" == "alpine" ]]; then
    step_fail_critical "Alpine Linux is not supported (its musl userspace is incompatible with the installer's Node/nvm path); use Debian, Ubuntu, Fedora, RHEL, Arch, or openSUSE"
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
  check_git_config
  check_provider_credentials
  step_end ok "preflight complete"
  return 0
}

run_installer_step() {
  local key="$1" critical="$2" fn="$3" rc
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

run_installer_step packages false step_packages
run_installer_step node true step_node
run_installer_step checkout true step_checkout
run_installer_step composer false step_composer
run_installer_step npm true step_npm
run_installer_step shell true step_shell_wiring
run_installer_step seed false step_seed_settings
run_installer_step admin false step_admin_init
run_installer_step keys false step_keys
run_installer_step native false step_native_binaries
run_installer_step doctor false step_doctor
run_installer_step validate false step_validate
run_installer_step smoke false step_smoke

print_summary
if [[ "$INSTALL_FAILED" == "true" ]]; then
  exit 1
fi
exit 0
