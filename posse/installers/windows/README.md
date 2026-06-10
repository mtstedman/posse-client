# Posse Windows Installer

PowerShell port of the Linux installer. Same flags, same behavior.

ATLAS is built into Posse — there is no separate ATLAS checkout, build, or
server process. ATLAS runtime configuration lives in `~\.posse\account.db`
(managed through `posse admin`), not environment variables.

## What It Does

- Verifies required tools (`git`, `node` >= 24, `npm`) and warns about soft gaps
  (missing provider credentials, unset global git identity).
- Clones a missing `posse` checkout into the configured install directory.
- Installs host CLI dependencies used by Posse helper tools when they are
  missing: ripgrep (`rg`), Tesseract OCR (`tesseract`), ImageMagick (`magick`),
  and FFmpeg (`ffmpeg`).
- Installs posse npm dependencies with optional packages explicitly included
  (skipped when `node_modules` is fresh).
- Installs Posse Python helper dependencies from `requirements.txt` when
  Python 3.9+ is available.
- Installs all Posse-managed SCIP indexer environments
  (`typescript,python,php,go,rust`) and reports any missing host toolchains.
- Writes PATH wiring to `%USERPROFILE%\.config\posse\atlas.env.ps1` as a
  PowerShell snippet.
- Installs `posse.cmd` and `posse.ps1` shims in
  `%USERPROFILE%\.local\bin` and adds that directory to the user `PATH`.
- Seeds missing rows in `~\.posse\account.db` (ATLAS mode/phases plus
  `atlas_scip_mode=on` and all SCIP languages) so the admin TUI and in-process
  callers pick it up. Existing user values are preserved -- never overwritten.
- Optionally (`-ConfigureKeys`) prompts for provider API keys (hidden via
  `Read-Host -AsSecureString`), writes them to
  `%USERPROFILE%\.config\posse\providers.env.ps1` with an NTFS ACL locked to
  the current user, and offers to launch `claude` / `codex login` for the
  CLI-based providers.
- Optionally adds `. "atlas.env.ps1"` to the user PowerShell profile (`$PROFILE`),
  plus `providers.env.ps1` when it exists.
- Validates the install by running `node orchestrator.js status`.
- Optionally runs `node orchestrator.js atlas-smoke ...`.
- Prints a summary table of each step's outcome and any warnings.

## Prereqs

- PowerShell 5.1 (ships with Windows 10/11) or PowerShell 7+
- Node.js 24+ (install via [nvm-windows](https://github.com/coreybutler/nvm-windows) or the Node.js installer)
- Git
- winget is recommended so the installer can fetch host tools automatically
  (`BurntSushi.ripgrep.MSVC`, `UB-Mannheim.TesseractOCR`, `ImageMagick.Q16`,
  `Gyan.FFmpeg`).
- Python 3.9+ is recommended for file/image helper tools.

## Run

```powershell
cd <posse-dir>\installers\windows
powershell -ExecutionPolicy Bypass -File .\install-posse-atlas.ps1 `
  -PosseDir <posse-dir> `
  -RepoPath C:\repos\your-target-repo `
  -RepoId your-target-repo
```

If you omit `-RepoPath`, install still completes and the smoke test is skipped.

> **Execution policy.** If PowerShell blocks the script, either set
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or invoke with
> `-ExecutionPolicy Bypass` as shown above.

## Flags

| Flag | Purpose |
|------|---------|
| `-InstallRoot <path>` | Base directory for installs (default: `$env:USERPROFILE\claude-tools`) |
| `-PosseDir <path>` | Posse checkout directory (default: `<InstallRoot>\posse`) |
| `-PosseRepoUrl <url>` | Posse Git URL used when `-PosseDir` is missing (default: `https://github.com/mtstedman/posse.git`) |
| `-RepoId <id>` | ATLAS repo id for smoke test / defaults |
| `-RepoPath <path>` | ATLAS repo path for smoke test / defaults |
| `-SmokeQuery <q>` | Query used for atlas-smoke (default: `auth`) |
| `-SmokeProvider <p>` | Provider for atlas-smoke (default: `openai`) |
| `-NoSmoke` | Skip the smoke test |
| `-NoPersistEnv` | Don't wire atlas.env.ps1 into `$PROFILE` |
| `-SkipSettings` | Don't seed `~\.posse\account.db` |
| `-SkipHostTools` | Don't install/check host CLI tools (`rg`, `tesseract`, `magick`, `ffmpeg`) |
| `-ConfigureKeys` | Prompt for `POSSE_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `CODEX_API_KEY` (hidden input via SecureString). Persists to `%USERPROFILE%\.config\posse\providers.env.ps1` with an NTFS ACL locked to the current user. Keys already set in your env are skipped. Offers to run `claude` / `codex login`. |
| `-Force` | Re-run `npm install` even when `node_modules` looks fresh |
| `-DryRun` | Print what would happen; make no changes |

## Re-running

The installer is idempotent:

- `npm install --include=optional` is skipped when
  `node_modules/.package-lock.json` is newer than `package.json`. Pass
  `-Force` to override.
- Missing host CLI tools are installed with `winget`. If a tool installs but
  is not visible in the current shell yet, open a new terminal so PATH changes
  can take effect.
- Python helper deps are installed from `requirements.txt` with
  `python -m pip install --user -r requirements.txt`.
- SCIP dependencies are installed for all managed languages. PHP, Go, and Rust
  need their host toolchains available; if any are missing, the installer keeps
  going and prints the follow-up `posse atlas-v2 scip install --all` command.
- `atlas.env.ps1` is rewritten each run.
- `providers.env.ps1` is **only** touched when `-ConfigureKeys` is passed,
  and only the specific keys you enter are added or updated -- any other
  lines (manually added exports, comments) are preserved.
- Account settings are merged, never overwritten -- existing user values are
  always preserved.

## Provider API keys

With `-ConfigureKeys`, the installer prompts (hidden via
`Read-Host -AsSecureString`) for:

| Var | Purpose |
|-----|---------|
| `POSSE_KEY` | Posse remote prompt/tool catalog API key |
| `OPENAI_API_KEY` | OpenAI provider |
| `XAI_API_KEY` | Grok (xAI) provider |
| `CODEX_API_KEY` | Codex API-key auth (optional -- the `codex` CLI can also use `~\.codex\auth.json` from `codex login`) |

- Any var already set in your environment is detected and skipped.
- Empty input skips the prompt.
- Values are stored **plaintext** in
  `%USERPROFILE%\.config\posse\providers.env.ps1`. The installer applies an
  NTFS ACL granting only the current Windows user FullControl -- inheritance
  is disabled. This is the strongest protection available without integrating
  Windows Credential Manager / DPAPI.
- Claude and Codex CLI logins can't be fully scripted -- after the key
  prompts, the installer offers to launch `claude` and/or `codex login`
  interactively.

If you prefer to manage keys yourself, omit `-ConfigureKeys` and set them
with `setx OPENAI_API_KEY ...`, 1Password CLI, or however you already manage
secrets. The installer only detects and warns in that mode.

## Troubleshooting

The summary footer marks each step `done`, `skipped`, `failed`, `partial`, `ok`,
or `dry-run`. Any warning is also printed with the specific gap (missing
provider key, unset git identity, SCIP host toolchain, etc.).

If `posse validate` shows `failed`, run it manually to see the error:

```powershell
cd <posse-dir>
posse status
```

## Parity with the Linux script

Functional parity:

- Same `--force` / `--dry-run` / `--skip-settings` / `--no-smoke` /
  `--no-persist-env` flags (PowerShell style `-Force` / `-DryRun` / etc.).
- Same pre-flight, idempotency, validation, settings seeding, and summary.

Differences by platform:

- Env file is `atlas.env.ps1` (PowerShell `$env:` syntax) vs `atlas.env` (bash
  `export` syntax).
- Auto-source wires `$PROFILE` (typically
  `...\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`) instead of
  `~/.bashrc` / `~/.zshrc`.
- `where` / `Get-Command` replaces `command -v`.
