# Posse Linux Installer

Bootstraps a Linux host from scratch and leaves `posse` runnable: system
packages, Node.js 24+, npm dependencies, Python/SCIP runtimes, native
binaries, account settings, and shell wiring.

ATLAS is built into Posse — there is no separate ATLAS checkout, build, or
server process. ATLAS runtime configuration lives in `~/.posse/account.db`
(managed through `posse admin`), not environment variables.

## Design

- **Never dies mid-run.** Every step is fenced: failures are recorded, the
  installer keeps going where it can, steps that depend on a failed step are
  marked `blocked`, and the summary always prints — even on Ctrl-C.
- **Idempotent.** Re-running is safe; fresh steps are skipped. `--force`
  reinstalls npm deps, `--dry-run` previews everything.
- **Self-sufficient.** Installs its own prerequisites instead of failing on
  them: the C/C++ build toolchain that Posse's native npm modules (node-pty
  and friends) compile with, `python3-venv`/`pip`, and Node 24 via `nvm` when
  the host has no usable Node.
- **Observable.** A splash, numbered steps (`[ 3/15]`), a spinner with elapsed
  time on TTYs, and full command output captured to
  `~/.posse/logs/install-<timestamp>.log` (failures print the output tail
  inline).

## What It Does (steps)

1. **SCIP language selection** — validates `--scip-languages` or offers the
   interactive default selection before runtime repair begins.
2. **Preflight checks** — validates the optional smoke-test repo and reports
   provider credential / Git identity gaps.
3. **System packages** — detects `apt`/`dnf`/`yum`/`pacman`/`zypper`
   and installs what's missing: core (`git`, `curl`), build toolchain
   (`build-essential`/`gcc`+`make`, `pkg-config`, `python3`, `python3-pip`,
   `python3-venv`, `unzip`), and helper CLIs (ripgrep, Tesseract OCR,
   ImageMagick, and FFmpeg). PHP and Composer are installed only when `php` is
   explicitly selected for SCIP. Helper CLIs install per-package, so one missing
   package name can't sink the rest. Uses `sudo` (prompted once, up front)
   unless running as root.
4. **Node.js runtime** — accepts an existing Node ≥ 24; otherwise installs
   nvm (pinned version) and `nvm install 24`, then adopts it for the rest of
   the run. `--no-install-node` opts out.
5. **Posse checkout** — uses the checkout containing this installer when
   available; cloning is only a fallback for standalone use.
6. **Composer (SCIP PHP, opt-in)** — skipped unless `php` was explicitly
   selected; then uses a global `composer` when present or otherwise
   downloads a signature-verified `composer.phar` into Posse's `scip/bin`
   (skipped when PHP is absent).
7. **npm dependencies** — `npm install --include=optional` (skipped when
   `node_modules` is fresh; one automatic retry for transient registry
   failures).
8. **Shell wiring** — writes `~/.config/posse/atlas.env`, installs the
   `posse` shim in `~/.local/bin`, and (unless `--no-persist-env`) sources the
   env file from `~/.bashrc` / `~/.zshrc`.
9. **Account settings** — seeds missing ATLAS keys into `~/.posse/account.db`
   (merge-only; existing values are never overwritten).
10. **Runtime doctor** — runs `posse doctor`, Posse's own dependency engine,
   which builds the managed Python venv from `requirements.txt` and installs
   the SCIP language environments. This replaces the old `pip install --user`
   step (which broke on PEP 668 distros like Ubuntu 23.04+/Debian 12+) — the
   venv route works everywhere and matches what Posse does at boot.
11. **Provider CLI detection** — `posse admin init --non-interactive`.
12. **Provider API keys** — only with `--configure-keys`: hidden prompts for
    `POSSE_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `CODEX_API_KEY`, written
    to `~/.config/posse/providers.env` (chmod 600), plus optional `claude` /
    `codex login` launches.
13. **Native binaries** — downloads the current authenticated `posse-atlas`,
    `posse-git`, `posse-remote`, and `posse-vector` artifacts for the host
    platform. Existing verified versions are reused. Without `POSSE_KEY`, the
    step reports a warning and boot readiness retries later.
14. **Validation** — boots Posse (`node orchestrator.js status`).
15. **ATLAS smoke test** — only with `--repo-path`.

## Prereqs

Almost none — that's the point. Bash 4.4+, a supported package manager, and
`sudo` (or a direct root login) let the installer fetch everything else. Do
not invoke the installer itself through `sudo`; it requests elevation only for
system packages. Without root access it still completes whatever doesn't need
packages and reports the gaps.

Alpine Linux is explicitly unsupported. Its musl userspace is incompatible
with the installer's nvm/Node binary path, and stock Alpine does not include
Bash. The preflight rejects Alpine when the script is launched from a Bash
environment; use a supported glibc-based distribution instead.

## Run

```bash
chmod +x install-posse-atlas.sh
./install-posse-atlas.sh
```

With a smoke test against a repo:

```bash
./install-posse-atlas.sh --repo-path /opt/repos/your-target-repo
```

## Flags

| Flag | Purpose |
|------|---------|
| `--install-root <path>` | Base directory for installs (default: `~/claude-tools`) |
| `--posse-dir <path>` | Posse checkout directory (default: installer checkout, else `<install-root>/posse`) |
| `--posse-repo-url <url>` | Fallback Git URL when no checkout is detected |
| `--repo-id <id>` | ATLAS repo id for the smoke test |
| `--repo-path <path>` | ATLAS repo path for the smoke test |
| `--smoke-query <q>` | Query used for atlas-smoke (default: `auth`) |
| `--smoke-provider <p>` | Provider for atlas-smoke (default: `openai`) |
| `--scip-languages <csv>` | Initial SCIP languages to install/index: `typescript`, `python`, `php`, `go`, `rust`, `clang`, or `all`. Default: `typescript,python`; PHP is opt-in. |
| `--no-smoke` | Skip the smoke test |
| `--no-persist-env` | Don't append env sourcing to shell rc files |
| `--skip-settings` | Don't seed `~/.posse/account.db` |
| `--skip-host-tools` | Don't install system packages (missing ones are still reported) |
| `--no-install-node` | Don't auto-install Node via nvm when Node 24+ is missing |
| `--configure-keys` | Prompt for provider API keys (hidden input, chmod 600 file) |
| `--force` | Re-run `npm install` even if `node_modules` looks fresh |
| `--dry-run` | Print what would happen; do not execute |
| `--plain` | Disable colors and spinners (also honors `NO_COLOR`; spinners auto-disable when not a TTY) |
| `--help` | Show help |

## Re-running and troubleshooting

- The summary marks each step `ok`, `skipped`, `partial`, `failed`, `blocked`,
  or `dry-run`, with warnings listed underneath and the log path at the end.
- Every command's output lands in `~/.posse/logs/install-<timestamp>.log`; a
  failing step prints its last lines inline.
- `npm install` failures almost always name a missing system library in the
  log — the toolchain step exists to prevent the common ones (node-pty needs
  `make`/`g++`/`python3`).
- If the doctor step is `partial`, run `posse doctor` after installing the
  host tools it names; it repairs incrementally.
- Re-running the installer after a failure is always safe: completed steps
  skip themselves.
- `atlas.env` is rewritten each run. `providers.env` is **only** touched when
  `--configure-keys` is passed, and only the keys you enter are updated — any
  other lines are preserved. Account settings are merged, never overwritten.

## Provider API keys

With `--configure-keys`, the installer prompts (hidden input) for:

| Var | Purpose |
|-----|---------|
| `POSSE_KEY` | Posse remote prompt/tool catalog and native artifact API key |
| `OPENAI_API_KEY` | OpenAI provider |
| `XAI_API_KEY` | Grok (xAI) provider |
| `CODEX_API_KEY` | Codex API-key auth (optional — the `codex` CLI can also use `~/.codex/auth.json` from `codex login`) |

- Any var already set in your environment is detected and skipped; empty
  input skips the prompt.
- Values are stored **plaintext** in `~/.config/posse/providers.env` with
  `chmod 600`, sourced by your shell rc files alongside `atlas.env`.
- Claude and Codex CLI logins can't be fully scripted — after the key
  prompts, the installer offers to launch `claude` and/or `codex login`.

If you prefer to manage keys yourself, omit `--configure-keys` and set the
env vars however you like (login shell, 1Password CLI, systemd drop-in, etc.).
The installer only detects and warns in that mode.

## Package As Tarball

From the `posse` directory:

```bash
bash scripts/package-linux-installer.sh
```

This emits a versioned tarball in `posse/dist/`.
