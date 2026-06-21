# Posse Linux Installer

Installs npm dependencies, seeds posse's account settings, and wires the
`posse` command into your shell.

ATLAS is built into Posse — there is no separate ATLAS checkout, build, or
server process. ATLAS runtime configuration lives in `~/.posse/account.db`
(managed through `posse admin`), not environment variables.

## What It Does

- Verifies required tools (`git`, `node` ≥ 24, `npm`) and warns about soft gaps
  (missing provider credentials, unset global git identity).
- Uses the Posse checkout containing the installer when available; cloning is
  only a fallback for standalone use.
- Installs host CLI dependencies used by Posse helper tools when they are
  missing: ripgrep (`rg`), Tesseract OCR (`tesseract`), ImageMagick (`magick`),
  FFmpeg (`ffmpeg`), Python, PHP, and Composer.
- Installs posse npm dependencies with optional packages explicitly included
  (skipped when `node_modules` is fresh).
- Installs Posse Python helper dependencies from `requirements.txt` when
  Python 3.9+ is available.
- Installs the default Posse-managed SCIP/lint language environments
  (`typescript,python,php`) and reports any missing host toolchains.
- Writes PATH wiring to `~/.config/posse/atlas.env`.
- Installs a `posse` command shim in `~/.local/bin` and ensures the generated
  env file adds that directory to `PATH`.
- Seeds missing rows in `~/.posse/account.db` (ATLAS mode/phases plus
  `atlas_scip_mode=on` and default enabled languages) so the admin TUI and in-process
  callers pick it up. Existing user values are preserved — never overwritten.
- Runs `posse admin init --non-interactive` to detect `claude` and `codex` CLI
  paths when possible.
- Optionally (`--configure-keys`) prompts for provider API keys with hidden
  input, writes them to `~/.config/posse/providers.env` (chmod 600), and
  offers to launch `claude` / `codex login` for the CLI-based providers.
- Optionally appends `source ~/.config/posse/atlas.env` to `~/.bashrc` and
  `~/.zshrc` (plus `providers.env` when it exists).
- Validates the install by running `node orchestrator.js status`.
- Optionally runs `node orchestrator.js atlas-smoke ...`.
- Prints a summary table of each step's outcome and any warnings.

## Prereqs

- Node.js 24+ on Linux
- Git
- `sudo` plus one supported package manager is recommended for automatic host
  tool installs: `apt-get`, `dnf`, `yum`, `pacman`, or `zypper`.
- Python 3.9+ is recommended for file/image helper tools.

## Run

```bash
chmod +x install-posse-atlas.sh
./install-posse-atlas.sh \
  --repo-path /opt/repos/your-target-repo \
  --repo-id your-target-repo
```

If you omit `--repo-path`, install still completes and the smoke test is skipped.

## Flags

| Flag | Purpose |
|------|---------|
| `--install-root <path>` | Base directory for installs (default: `~/claude-tools`) |
| `--posse-dir <path>` | Posse checkout directory (default: installer checkout when available, else `<install-root>/posse`) |
| `--posse-repo-url <url>` | Fallback Git URL used only when no checkout is detected and `--posse-dir` is missing |
| `--repo-id <id>` | ATLAS repo id for smoke test / defaults |
| `--repo-path <path>` | ATLAS repo path for smoke test / defaults |
| `--smoke-query <q>` | Query used for atlas-smoke (default: `auth`) |
| `--smoke-provider <p>` | Provider for atlas-smoke (default: `openai`) |
| `--no-smoke` | Skip the smoke test |
| `--no-persist-env` | Don't append the env sourcing line to rc files |
| `--skip-settings` | Don't seed `~/.posse/account.db` |
| `--skip-host-tools` | Don't install/check host CLI tools (`rg`, `tesseract`, `magick`, `ffmpeg`, Python, PHP/Composer) |
| `--configure-keys` | Prompt for `POSSE_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `CODEX_API_KEY` (hidden input). Persists to `~/.config/posse/providers.env` with `chmod 600`. Keys already set in your env are skipped. Offers to run `claude` / `codex login` interactively. |
| `--force` | Re-run `npm install` even when `node_modules` looks fresh |
| `--dry-run` | Print what would happen; make no changes |
| `--help` | Show help |

## Re-running

The installer is idempotent:

- `npm install --include=optional` is skipped when
  `node_modules/.package-lock.json` is newer than `package.json`. Pass
  `--force` to override.
- Missing host CLI tools are installed through the detected distro package
  manager. Package mappings are `ripgrep`, `tesseract-ocr`/`tesseract`,
  `imagemagick`/`ImageMagick`, `ffmpeg`, Python, PHP, and Composer.
- Python helper deps are installed from `requirements.txt` with
  `python -m pip install --user -r requirements.txt`.
- SCIP dependencies are installed for the default enabled languages
  (`typescript,python,php`). Optional Go, Rust, and C/C++ SCIP support can be
  enabled in admin or installed with `posse atlas-v2 scip install --all`; if a
  default language host toolchain is missing, the installer keeps going and
  prints a follow-up `posse atlas-v2 scip install ...` command.
- `atlas.env` is rewritten each run.
- `providers.env` is **only** touched when `--configure-keys` is passed, and
  only the specific keys you enter are added or updated — any other lines in
  the file (including keys you added manually) are preserved.
- Account settings are merged, never overwritten — existing user values are
  always preserved.

## Provider API keys

With `--configure-keys`, the installer will prompt (hidden input) for:

| Var | Purpose |
|-----|---------|
| `POSSE_KEY` | Posse remote prompt/tool catalog API key |
| `OPENAI_API_KEY` | OpenAI provider |
| `XAI_API_KEY` | Grok (xAI) provider |
| `CODEX_API_KEY` | Codex API-key auth (optional — the `codex` CLI can also use `~/.codex/auth.json` from `codex login`) |

- Any var already set in your environment is detected and skipped.
- Empty input (just press Enter) skips the prompt.
- Values are stored **plaintext** in `~/.config/posse/providers.env` with
  `chmod 600`. They are sourced by your shell rc files alongside `atlas.env`.
- Claude and Codex CLI logins can't be fully scripted — after the key
  prompts, the installer offers to launch `claude` and/or `codex login`
  interactively so you can complete their OAuth flows.

If you prefer to manage keys yourself, omit `--configure-keys` and set the
env vars however you like (login shell, 1Password CLI, systemd drop-in, etc.).
The installer only detects and warns in that mode.

## Troubleshooting

The summary footer marks each step `done`, `skipped`, `failed`, `partial`, `ok`,
or `dry-run`. Any warning is also printed with the specific gap (missing
provider key, unset git identity, SCIP host toolchain, etc.).

If `posse validate` shows `failed`, run manually to see the error:

```bash
cd <posse-dir>
posse status
```

## Package As Tarball

From the `posse` directory:

```bash
bash scripts/package-linux-installer.sh
```

This emits a versioned tarball in `posse/dist/`.
