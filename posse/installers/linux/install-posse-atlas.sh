#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Posse + ATLAS Linux installer
#
# Idempotent: re-running without changes is a no-op. Pass --force to reinstall
# npm deps. Pass --dry-run to preview actions without executing them.
# -----------------------------------------------------------------------------

POSSE_MODE="preferred"
POSSE_PHASES="research,planning,assessment,dev"
POSSE_LIVE_FUNNEL="true"
POSSE_SCIP_MODE="on"
POSSE_SCIP_LANGUAGES="typescript,python,php"
SMOKE_QUERY="auth"
SMOKE_PROVIDER="openai"
RUN_SMOKE="true"
PERSIST_ENV="true"
SEED_SETTINGS="true"
INSTALL_HOST_TOOLS="true"
FORCE_REINSTALL="false"
DRY_RUN="false"
CONFIGURE_KEYS="false"
INSTALL_ROOT="${HOME}/claude-tools"
POSSE_DIR=""
POSSE_REPO_URL="https://github.com/mtstedman/posse.git"
REPO_ID=""
REPO_PATH=""
NODE_MIN_MAJOR="24"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# Step results — populated as the installer runs, printed in the final summary.
STEP_POSSE_CLONE="pending"
STEP_HOST_TOOLS="pending"
STEP_POSSE_NPM="pending"
STEP_POSSE_PYTHON="pending"
STEP_POSSE_SCIP="pending"
STEP_ENV_FILE="pending"
STEP_POSSE_ALIAS="pending"
STEP_SEED_SETTINGS="pending"
STEP_ADMIN_INIT="pending"
STEP_POSSE_VALIDATE="pending"
STEP_SMOKE="pending"
STEP_KEYS="skipped"
CONFIGURED_KEYS=()
WARNINGS=()

usage() {
  cat <<'USAGE'
Usage:
  install-posse-atlas.sh [options]

Options:
  --install-root <path>   Base directory for installs (default: ~/claude-tools)
  --posse-dir <path>      Posse checkout directory (default: installer checkout, else <install-root>/posse)
  --posse-repo-url <url>  Fallback Git URL when no checkout is detected and --posse-dir is missing
  --repo-id <id>          ATLAS repo id for smoke tests
  --repo-path <path>      ATLAS repo path for smoke tests
  --smoke-query <query>   Query used for atlas-smoke (default: auth)
  --smoke-provider <name> Provider for atlas-smoke (default: openai)
  --no-smoke              Skip smoke test
  --no-persist-env        Do not append env sourcing to shell rc files
  --skip-settings         Do not seed ~/.posse/account.db
  --skip-host-tools       Do not install/check host CLI tools used by Posse
                          helpers (rg, tesseract, ImageMagick, ffmpeg,
                          Python, PHP/Composer)
  --configure-keys        Interactively prompt for provider API keys (stored in
                          ~/.config/posse/providers.env, chmod 600). Skipped
                          keys already set in your environment or providers.env.
  --force                 Re-run npm install / build even if node_modules looks fresh
  --dry-run               Print what would happen; do not execute
  --help                  Show help

Notes:
  - Uses the Posse checkout containing this installer when available; cloning
    is only a fallback.
  - ATLAS is built into Posse (no separate ATLAS checkout or build step).
  - It installs host CLI tools, posse npm deps including optional packages,
    Python helper deps, default SCIP/lint language environments
    (typescript/python/php), writes
    ~/.config/posse/atlas.env (PATH wiring), seeds ~/.posse/account.db,
    validates the install, and optionally runs posse atlas-smoke.
  - Re-runs are safe: unchanged steps are skipped.
USAGE
}

fail() {
  echo "[install-posse-atlas] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[install-posse-atlas] $*"
}

warn() {
  echo "[install-posse-atlas] WARN: $*" >&2
  WARNINGS+=("$*")
}

shell_quote() {
  printf "%q" "$1"
}

format_command() {
  local parts=()
  local arg
  for arg in "$@"; do
    parts+=("$(shell_quote "$arg")")
  done
  printf "%s" "${parts[*]}"
}

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) $(format_command "$@")"
    return 0
  fi
  "$@"
}

run_in_dir() {
  local dir="$1"
  shift
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) (cd $(shell_quote "$dir") && $(format_command "$@"))"
    return 0
  fi
  (cd "$dir" && "$@")
}

write_export() {
  local name="$1"
  local value="$2"
  printf 'export %s=%s\n' "$name" "$(shell_quote "$value")"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1 (install it and re-run)"
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 127
  fi
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])"
}

set_step() {
  local step_var="$1" value="$2"
  printf -v "$step_var" "%s" "$value"
}

resolve_full_path() {
  local input_path="$1"
  node -e 'const path = require("path"); process.stdout.write(path.resolve(process.argv[1]));' "$input_path"
}

detect_installer_posse_dir() {
  local candidate
  candidate="$(cd "$SCRIPT_DIR/../.." && pwd -P)" || return 1
  if [[ -f "$candidate/orchestrator.js" ]]; then
    printf "%s\n" "$candidate"
  fi
}

ensure_git_checkout() {
  local dir="$1"
  local repo_url="$2"
  local step_var="$3"
  local label="$4"
  local sentinel_path="$5"
  local sentinel_label="$6"

  if [[ -d "$dir" ]]; then
    set_step "$step_var" "skipped"
  else
    log "$label directory missing -- cloning ${repo_url} into ${dir}"
    run mkdir -p "$(dirname "$dir")"
    run git clone "$repo_url" "$dir"
    if [[ "${DRY_RUN}" == "true" ]]; then
      set_step "$step_var" "dry-run"
    else
      set_step "$step_var" "done"
    fi
  fi

  if [[ ! -f "$sentinel_path" ]]; then
    if [[ "${DRY_RUN}" == "true" && ! -d "$dir" ]]; then
      return
    fi
    fail "${sentinel_label} not found in: ${dir} (is this the ${label} repo root?)"
  fi
}

install_host_tool_deps() {
  if [[ "${INSTALL_HOST_TOOLS}" != "true" ]]; then
    STEP_HOST_TOOLS="skipped"
    return
  fi

  local missing=()
  command -v rg >/dev/null 2>&1 || missing+=("ripgrep")
  command -v tesseract >/dev/null 2>&1 || missing+=("tesseract")
  command -v magick >/dev/null 2>&1 || missing+=("ImageMagick")
  command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg")
  find_python >/dev/null 2>&1 || missing+=("python3")
  command -v php >/dev/null 2>&1 || missing+=("php-cli")
  command -v composer >/dev/null 2>&1 || missing+=("composer")

  if [[ ${#missing[@]} -eq 0 ]]; then
    log "Host CLI dependencies found: rg, tesseract, magick, ffmpeg, python, php, composer"
    STEP_HOST_TOOLS="ok"
    return
  fi

  local packages=()
  local manager=""
  if command -v apt-get >/dev/null 2>&1; then
    manager="apt-get"
    packages=(ripgrep tesseract-ocr imagemagick ffmpeg python3 python3-pip php-cli composer)
  elif command -v dnf >/dev/null 2>&1; then
    manager="dnf"
    packages=(ripgrep tesseract ImageMagick ffmpeg python3 python3-pip php-cli composer)
  elif command -v yum >/dev/null 2>&1; then
    manager="yum"
    packages=(ripgrep tesseract ImageMagick ffmpeg python3 python3-pip php-cli composer)
  elif command -v pacman >/dev/null 2>&1; then
    manager="pacman"
    packages=(ripgrep tesseract imagemagick ffmpeg python python-pip php composer)
  elif command -v zypper >/dev/null 2>&1; then
    manager="zypper"
    packages=(ripgrep tesseract-ocr ImageMagick ffmpeg python3 python3-pip php8 composer)
  fi

  if [[ -z "$manager" ]]; then
    STEP_HOST_TOOLS="missing"
    warn "cannot auto-install missing host CLI dependencies (${missing[*]}): supported package manager not found"
    return
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would install host CLI dependencies via ${manager}: ${packages[*]}"
    STEP_HOST_TOOLS="dry-run"
    return
  fi

  if [[ "$(id -u)" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    STEP_HOST_TOOLS="missing"
    warn "cannot auto-install missing host CLI dependencies (${missing[*]}): sudo not found and current user is not root"
    return
  fi

  log "Installing host CLI dependencies via ${manager}: ${packages[*]}"
  local ok="false"
  case "$manager" in
    apt-get)
      as_root apt-get update || warn "apt-get update failed; trying package install anyway"
      if as_root apt-get install -y "${packages[@]}"; then ok="true"; fi
      ;;
    dnf)
      if as_root dnf install -y "${packages[@]}"; then ok="true"; fi
      ;;
    yum)
      if as_root yum install -y "${packages[@]}"; then ok="true"; fi
      ;;
    pacman)
      if as_root pacman -S --needed --noconfirm "${packages[@]}"; then ok="true"; fi
      ;;
    zypper)
      if as_root zypper --non-interactive install "${packages[@]}"; then ok="true"; fi
      ;;
  esac

  if [[ "$ok" != "true" ]]; then
    STEP_HOST_TOOLS="failed"
    warn "host CLI dependency install failed via ${manager}. Missing before install: ${missing[*]}"
    return
  fi

  local still_missing=()
  command -v rg >/dev/null 2>&1 || still_missing+=("rg")
  command -v tesseract >/dev/null 2>&1 || still_missing+=("tesseract")
  command -v magick >/dev/null 2>&1 || still_missing+=("magick")
  command -v ffmpeg >/dev/null 2>&1 || still_missing+=("ffmpeg")
  find_python >/dev/null 2>&1 || still_missing+=("python3")
  command -v php >/dev/null 2>&1 || still_missing+=("php")
  command -v composer >/dev/null 2>&1 || still_missing+=("composer")

  if [[ ${#still_missing[@]} -gt 0 ]]; then
    STEP_HOST_TOOLS="partial"
    warn "host CLI packages installed, but these commands are still not visible on PATH: ${still_missing[*]}"
  else
    STEP_HOST_TOOLS="done"
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

install_python_deps() {
  local requirements="${POSSE_DIR}/requirements.txt"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would install posse Python dependencies from ${requirements}"
    STEP_POSSE_PYTHON="dry-run"
    return
  fi
  if [[ ! -f "$requirements" ]]; then
    STEP_POSSE_PYTHON="skipped"
    warn "requirements.txt not found in ${POSSE_DIR}; Python helper dependencies were not installed."
    return
  fi
  local python_bin
  if ! python_bin="$(find_python)"; then
    STEP_POSSE_PYTHON="skipped"
    warn "Python 3.9+ not found; Python helper tools (file/image parsing and conversion) may be unavailable."
    return
  fi
  log "Installing posse Python dependencies"
  run "$python_bin" -m pip install --user -r "$requirements"
  STEP_POSSE_PYTHON="done"
}

install_scip_deps() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would install Posse-managed SCIP dependencies for ${POSSE_SCIP_LANGUAGES}"
    STEP_POSSE_SCIP="dry-run"
    return
  fi

  log "Installing Posse-managed SCIP dependencies for ${POSSE_SCIP_LANGUAGES}"
  if (
    export POSSE_INSTALL_SCIP_LANGUAGES="$POSSE_SCIP_LANGUAGES"
    export POSSE_INSTALL_SCIP_FORCE="$FORCE_REINSTALL"
    cd "$POSSE_DIR"
    node --input-type=module - <<'NODESCIP'
import { installScipLanguageDependenciesSync } from "./lib/domains/atlas/functions/v2/scip/dependencies.js";

const result = installScipLanguageDependenciesSync({
  languages: process.env.POSSE_INSTALL_SCIP_LANGUAGES || "typescript,python,php",
  force: process.env.POSSE_INSTALL_SCIP_FORCE === "true",
  onProgress: (message) => console.log(`[scip-deps] ${message}`),
});

for (const row of result.results || []) {
  const marker = row.ok ? "ok" : "warn";
  console.log(`[scip-deps] ${marker} ${row.language}: ${row.status} - ${row.message}`);
}

if (!result.ok) process.exitCode = 2;
NODESCIP
  ); then
    STEP_POSSE_SCIP="done"
  else
    STEP_POSSE_SCIP="partial"
    local retry_languages="${POSSE_SCIP_LANGUAGES//,/ }"
    warn "some SCIP language dependencies could not be installed automatically. Install the missing host toolchains and run: posse atlas-v2 scip install ${retry_languages}"
  fi
}

# True if node_modules is fresh -- i.e. package.json is not newer than
# node_modules/.package-lock.json. Avoids re-running npm install on every invoke.
deps_fresh() {
  local dir="$1"
  [[ -d "$dir/node_modules" ]] || return 1
  [[ -f "$dir/node_modules/.package-lock.json" ]] || return 1
  [[ "$dir/package.json" -nt "$dir/node_modules/.package-lock.json" ]] && return 1
  return 0
}

append_source_if_missing() {
  local rc_file="$1"
  local env_file="$2"
  local line="source $(shell_quote "$env_file")"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would ensure '${line}' in ${rc_file}"
    return
  fi
  [[ -f "$rc_file" ]] || touch "$rc_file"
  grep -F "$line" "$rc_file" >/dev/null 2>&1 || {
    printf "\n# Posse ATLAS integration\n%s\n" "$line" >>"$rc_file"
    log "Updated ${rc_file} to source ${env_file}"
  }
}

ensure_posse_alias() {
  local node_bin="$1"
  local bin_dir="${HOME}/.local/bin"
  local shim="${bin_dir}/posse"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would create posse alias shim at ${shim}"
    STEP_POSSE_ALIAS="dry-run"
    return
  fi

  mkdir -p "$bin_dir"
  cat >"$shim" <<EOF
#!/usr/bin/env bash
exec "$(printf "%s" "$node_bin")" "$(printf "%s" "$POSSE_DIR")/orchestrator.js" "\$@"
EOF
  chmod 755 "$shim"
  STEP_POSSE_ALIAS="done"
  log "Installed posse alias: ${shim}"

  if ! command -v posse >/dev/null 2>&1; then
    warn "posse alias was written to ${bin_dir}, but that directory is not currently on PATH. Add it to PATH or open a new shell after sourcing ${ENV_FILE:-$HOME/.config/posse/atlas.env}."
  fi
}

# Seed ATLAS keys into ~/.posse/account.db without overwriting existing
# user-set values.
seed_account_settings() {
  local node_bin="$1"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would seed missing ATLAS keys into ~/.posse/account.db"
    STEP_SEED_SETTINGS="dry-run"
    return
  fi
  (
    export POSSE_SEED_MODE="$POSSE_MODE"
    export POSSE_SEED_PHASES="$POSSE_PHASES"
    export POSSE_SEED_FUNNEL="$POSSE_LIVE_FUNNEL"
    export POSSE_SEED_SCIP_MODE="$POSSE_SCIP_MODE"
    export POSSE_SEED_SCIP_LANGUAGES="$POSSE_SCIP_LANGUAGES"
    cd "$POSSE_DIR"
    "$node_bin" - <<'NODESEED'
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
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
const get = db.prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`);
const upsert = db.prepare(`
  INSERT INTO account_settings (setting_key, setting_value, updated_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(setting_key) DO UPDATE
    SET setting_value = excluded.setting_value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
NODESEED
  )
  STEP_SEED_SETTINGS="done"
}

validate_posse() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    STEP_POSSE_VALIDATE="dry-run"
    return
  fi
  if ( cd "$POSSE_DIR" && node orchestrator.js status >/dev/null 2>&1 ); then
    STEP_POSSE_VALIDATE="ok"
  else
    STEP_POSSE_VALIDATE="failed"
    warn "posse failed to boot (node orchestrator.js status returned non-zero). Run it manually to see the error."
  fi
}

admin_init() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would run posse admin init --non-interactive"
    STEP_ADMIN_INIT="dry-run"
    return
  fi
  if ( cd "$POSSE_DIR" && "$NODE_BIN" orchestrator.js admin init --non-interactive ); then
    STEP_ADMIN_INIT="done"
  else
    STEP_ADMIN_INIT="failed"
    warn "posse admin init failed. Run it manually to see provider CLI detection details."
  fi
}

check_provider_credentials() {
  local have=0
  local candidates=()
  if command -v claude >/dev/null 2>&1; then
    candidates+=("claude-cli")
    have=1
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    candidates+=("OPENAI_API_KEY")
    have=1
  fi
  if [[ -n "${XAI_API_KEY:-}" ]]; then
    candidates+=("XAI_API_KEY")
    have=1
  fi
  if [[ -n "${CODEX_API_KEY:-}" || -f "${HOME}/.codex/auth.json" ]]; then
    candidates+=("codex")
    have=1
  fi
  if [[ "$have" -eq 0 ]]; then
    warn "no provider credentials detected (claude CLI / OPENAI_API_KEY / XAI_API_KEY / CODEX_API_KEY / ~/.codex/auth.json). Posse will not be able to dispatch jobs until one is configured."
  else
    log "Detected provider credentials: ${candidates[*]}"
  fi
  if [[ -n "${POSSE_KEY:-}" ]]; then
    log "Detected Posse remote key: POSSE_KEY"
  else
    warn "POSSE_KEY is not set. Posse remote prompt/tool catalog requests will require this key."
  fi
}

check_git_config() {
  if ! git config --global user.name >/dev/null 2>&1; then
    warn "git user.name is not set globally (git config --global user.name \"Your Name\"). Posse auto-commits will fall back to repo-local config."
  fi
  if ! git config --global user.email >/dev/null 2>&1; then
    warn "git user.email is not set globally (git config --global user.email \"you@example.com\")."
  fi
}

# Prompt (hidden) for a provider API key and stash it for later persistence.
# Skips if the env var is already set, or if we already sourced a value from a
# prior providers.env. Returns 0 if a value was captured, 1 otherwise.
prompt_for_key() {
  local label="$1" var_name="$2"
  local existing="${!var_name:-}"
  if [[ -n "$existing" ]]; then
    log "$var_name already set (length ${#existing}) -- skipping"
    return 1
  fi
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would prompt for $label ($var_name)"
    return 1
  fi
  local input=""
  # -r: no backslash escapes; -s: hidden; prompt goes to stderr via -p + redirect.
  read -r -s -p "  Enter $label (press Enter to skip): " input </dev/tty
  echo >/dev/tty
  if [[ -z "$input" ]]; then
    log "Skipped $label"
    return 1
  fi
  # Export so the rest of this run can see it (validation, smoke test).
  export "$var_name"="$input"
  CONFIGURED_KEYS+=("$var_name")
  return 0
}

configure_keys() {
  local providers_file="$1"

  # Load any previously-captured keys from providers.env so we don't re-prompt.
  if [[ -f "$providers_file" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$providers_file"; set +a
  fi

  log "Configuring provider API keys. Input is hidden. Press Enter to skip."
  prompt_for_key "Posse remote key" "POSSE_KEY" || true
  prompt_for_key "OpenAI API key"   "OPENAI_API_KEY" || true
  prompt_for_key "xAI (Grok) key"   "XAI_API_KEY"    || true
  prompt_for_key "Codex API key (optional -- skip if you prefer 'codex login')" "CODEX_API_KEY" || true

  # Offer interactive CLI logins. Skip offers in dry-run.
  if [[ "${DRY_RUN}" != "true" ]]; then
    if command -v claude >/dev/null 2>&1; then
      read -r -p "  Run 'claude' now to log in to Claude? [y/N]: " ans </dev/tty
      if [[ "$ans" =~ ^[Yy]$ ]]; then
        claude || warn "claude login command did not exit cleanly"
      fi
    fi
    if command -v codex >/dev/null 2>&1 && [[ -z "${CODEX_API_KEY:-}" ]]; then
      read -r -p "  Run 'codex login' now? [y/N]: " ans </dev/tty
      if [[ "$ans" =~ ^[Yy]$ ]]; then
        codex login || warn "codex login command did not exit cleanly"
      fi
    fi
  fi

  # Persist captured keys to providers.env. Existing file contents are merged
  # by rewriting only lines whose var we (re)captured, keeping any other
  # user-added exports untouched.
  if [[ ${#CONFIGURED_KEYS[@]} -gt 0 ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      log "(dry-run) would write ${#CONFIGURED_KEYS[@]} key(s) to $providers_file"
      STEP_KEYS="dry-run"
      return
    fi
    mkdir -p "$(dirname "$providers_file")"
    local tmp_file
    tmp_file="$(mktemp)"
    if [[ -f "$providers_file" ]]; then
      # Strip any old lines for the vars we're about to rewrite.
      local filter_expr=""
      for k in "${CONFIGURED_KEYS[@]}"; do
        filter_expr+="/^export ${k}=/d;"
      done
      sed "$filter_expr" "$providers_file" >"$tmp_file"
    else
      : >"$tmp_file"
    fi
    for k in "${CONFIGURED_KEYS[@]}"; do
      # Use printf %q to safely escape any shell-special chars in the value.
      printf 'export %s=%q\n' "$k" "${!k}" >>"$tmp_file"
    done
    mv "$tmp_file" "$providers_file"
    chmod 600 "$providers_file"
    log "Wrote ${#CONFIGURED_KEYS[@]} key(s) to $providers_file (chmod 600)"
    STEP_KEYS="${CONFIGURED_KEYS[*]}"
  else
    STEP_KEYS="none captured"
  fi
}

print_summary() {
  echo
  echo "================ Install Summary ================"
  printf "  posse clone           : %s\n" "$STEP_POSSE_CLONE"
  printf "  host tool deps        : %s\n" "$STEP_HOST_TOOLS"
  printf "  posse npm install     : %s\n" "$STEP_POSSE_NPM"
  printf "  posse python deps     : %s\n" "$STEP_POSSE_PYTHON"
  printf "  posse SCIP deps       : %s\n" "$STEP_POSSE_SCIP"
  printf "  env file              : %s\n" "$STEP_ENV_FILE"
  printf "  posse alias           : %s\n" "$STEP_POSSE_ALIAS"
  printf "  account settings seed : %s\n" "$STEP_SEED_SETTINGS"
  printf "  admin init            : %s\n" "$STEP_ADMIN_INIT"
  printf "  posse validate        : %s\n" "$STEP_POSSE_VALIDATE"
  printf "  provider keys         : %s\n" "$STEP_KEYS"
  printf "  smoke test            : %s\n" "$STEP_SMOKE"
  echo "================================================="
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo
    echo "Warnings:"
    for w in "${WARNINGS[@]}"; do
      printf "  - %s\n" "$w"
    done
  fi
  echo
  echo "Next steps:"
  echo "  1. source ${ENV_FILE:-$HOME/.config/posse/atlas.env}"
  echo "  2. cd ${POSSE_DIR}"
  echo "  3. posse add                    # describe a task"
  echo "  4. posse go                     # plan + run"
  echo
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) INSTALL_ROOT="$2"; shift 2 ;;
    --posse-dir) POSSE_DIR="$2"; shift 2 ;;
    --posse-repo-url) POSSE_REPO_URL="$2"; shift 2 ;;
    --repo-id) REPO_ID="$2"; shift 2 ;;
    --repo-path) REPO_PATH="$2"; shift 2 ;;
    --smoke-query) SMOKE_QUERY="$2"; shift 2 ;;
    --smoke-provider) SMOKE_PROVIDER="$2"; shift 2 ;;
    --no-smoke) RUN_SMOKE="false"; shift ;;
    --no-persist-env) PERSIST_ENV="false"; shift ;;
    --skip-settings) SEED_SETTINGS="false"; shift ;;
    --skip-host-tools) INSTALL_HOST_TOOLS="false"; shift ;;
    --configure-keys) CONFIGURE_KEYS="true"; shift ;;
    --force) FORCE_REINSTALL="true"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

require_cmd git
require_cmd node
require_cmd npm

NODE_MAJOR="$(node_major)"
if [[ "${NODE_MAJOR}" -lt "${NODE_MIN_MAJOR}" ]]; then
  fail "Node ${NODE_MIN_MAJOR}+ required. Found $(node -v). Install via nvm: nvm install ${NODE_MIN_MAJOR} && nvm use ${NODE_MIN_MAJOR}"
fi

if [[ -z "${POSSE_DIR}" ]]; then
  DETECTED_POSSE_DIR="$(detect_installer_posse_dir || true)"
  if [[ -n "$DETECTED_POSSE_DIR" ]]; then
    POSSE_DIR="$DETECTED_POSSE_DIR"
    log "Using Posse checkout containing this installer: $POSSE_DIR"
  else
    POSSE_DIR="${INSTALL_ROOT}/posse"
  fi
fi
POSSE_DIR="$(resolve_full_path "$POSSE_DIR")"

ensure_git_checkout "$POSSE_DIR" "$POSSE_REPO_URL" "STEP_POSSE_CLONE" "posse" "$POSSE_DIR/orchestrator.js" "orchestrator.js"

if [[ -n "${REPO_PATH}" && ! -d "${REPO_PATH}" ]]; then
  fail "repo path does not exist: ${REPO_PATH}"
fi
if [[ -n "${REPO_PATH}" && -z "${REPO_ID}" ]]; then
  REPO_ID="$(basename "$REPO_PATH")"
fi

check_git_config
check_provider_credentials

if [[ "${DRY_RUN}" == "true" ]]; then
  log "DRY RUN MODE — no changes will be made"
fi

# -----------------------------------------------------------------------------
# Install host CLI deps used by Posse helper tools
# -----------------------------------------------------------------------------

install_host_tool_deps

# -----------------------------------------------------------------------------
# Install npm deps (idempotent)
# -----------------------------------------------------------------------------

if [[ "${FORCE_REINSTALL}" != "true" ]] && deps_fresh "$POSSE_DIR"; then
  log "Posse deps are fresh — skipping npm install (pass --force to reinstall)"
  STEP_POSSE_NPM="skipped"
else
  log "Installing posse npm dependencies"
  run_in_dir "$POSSE_DIR" npm install --include=optional
  STEP_POSSE_NPM=$([[ "${DRY_RUN}" == "true" ]] && echo "dry-run" || echo "done")
fi

install_python_deps
install_scip_deps

# -----------------------------------------------------------------------------
# Write env file
# -----------------------------------------------------------------------------

ENV_DIR="${HOME}/.config/posse"
ENV_FILE="${ENV_DIR}/atlas.env"
NODE_BIN="$(command -v node)"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "(dry-run) would write ${ENV_FILE}"
  STEP_ENV_FILE="dry-run"
else
  mkdir -p "$ENV_DIR"
  {
    echo "# Posse PATH wiring -- generated by install-posse-atlas.sh"
    echo "# ATLAS runtime configuration lives in ~/.posse/account.db (posse admin),"
    echo "# not environment variables."
    write_export POSSE_BIN_DIR "${HOME}/.local/bin"
    echo 'case ":$PATH:" in *":$POSSE_BIN_DIR:"*) ;; *) export PATH="$POSSE_BIN_DIR:$PATH";; esac'
  } >"$ENV_FILE"
  log "Wrote environment file: ${ENV_FILE}"
  STEP_ENV_FILE="done"
fi

ensure_posse_alias "$NODE_BIN"

PROVIDERS_FILE="${ENV_DIR}/providers.env"

if [[ "${CONFIGURE_KEYS}" == "true" ]]; then
  configure_keys "$PROVIDERS_FILE"
fi

if [[ "${PERSIST_ENV}" == "true" ]]; then
  append_source_if_missing "${HOME}/.bashrc" "${ENV_FILE}"
  if [[ -f "${HOME}/.zshrc" ]]; then
    append_source_if_missing "${HOME}/.zshrc" "${ENV_FILE}"
  fi
  # Wire providers.env into the profile too, but only if the file actually
  # exists (no point sourcing a nonexistent file on a fresh system).
  if [[ -f "$PROVIDERS_FILE" ]]; then
    append_source_if_missing "${HOME}/.bashrc" "${PROVIDERS_FILE}"
    if [[ -f "${HOME}/.zshrc" ]]; then
      append_source_if_missing "${HOME}/.zshrc" "${PROVIDERS_FILE}"
    fi
  fi
fi

# -----------------------------------------------------------------------------
# Seed account settings (merge-only — never overwrite existing)
# -----------------------------------------------------------------------------

if [[ "${SEED_SETTINGS}" == "true" ]]; then
  seed_account_settings "$NODE_BIN"
else
  STEP_SEED_SETTINGS="skipped"
fi

admin_init
# -----------------------------------------------------------------------------
# Post-install validation
# -----------------------------------------------------------------------------

validate_posse

# -----------------------------------------------------------------------------
# Optional smoke test
# -----------------------------------------------------------------------------

if [[ "${RUN_SMOKE}" == "true" ]]; then
  if [[ -z "${REPO_PATH}" ]]; then
    log "Skipping smoke test (no --repo-path provided)"
    STEP_SMOKE="skipped"
  elif [[ "${DRY_RUN}" == "true" ]]; then
    log "(dry-run) would run atlas-smoke on ${REPO_PATH}"
    STEP_SMOKE="dry-run"
  else
    log "Running ATLAS smoke test"
    if (
      set -a
      # shellcheck disable=SC1090
      source "$ENV_FILE"
      set +a
      cd "$POSSE_DIR"
      node ./orchestrator.js atlas-smoke "$REPO_PATH" "$SMOKE_QUERY" "$SMOKE_PROVIDER"
    ); then
      STEP_SMOKE="ok"
    else
      STEP_SMOKE="failed"
      warn "atlas-smoke failed. Run it manually to see the error: node orchestrator.js atlas-smoke $REPO_PATH $SMOKE_QUERY $SMOKE_PROVIDER"
    fi
  fi
else
  STEP_SMOKE="skipped"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

print_summary
log "Install complete."
